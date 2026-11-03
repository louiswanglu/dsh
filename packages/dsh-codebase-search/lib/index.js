/**
 * @dsh-codebase-search — structural code search over the session workspace.
 *
 * `grep` finds literal text; this finds *definitions*. It indexes the workspace
 * into symbol-sized chunks (one per function, struct, class, method, or
 * top-level unit) and ranks them with SQLite FTS5, so a query like
 * "parse order book snapshot" reaches `fn parse_snapshot(...)` even when the
 * words never appear together on one line.
 *
 * Design constraints:
 *
 * - No external service, no model call, no network. The index is a local
 *   SQLite FTS5 database over `node:sqlite`, which ships with Node.
 * - The index is derived and disposable: deleting it costs a rebuild, never
 *   correctness. It is never the source of truth for the workspace.
 * - Staleness is bounded by file mtime+size, refreshed on a TTL rather than on
 *   every query, so a burst of searches costs one scan.
 * - Results always carry `file:line` anchors the model can `read` immediately.
 *
 * @module dsh-codebase-search
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'codebase-search'

/** Bump when the on-disk index layout changes; an older index is dropped and rebuilt. */
export const SCHEMA_VERSION = 2

/** Services required before the tools can run. */
export const inject = ['tools']

/** Plugin configuration. */
export const Config = z.object({
  indexDir: z.string().default(''),
  refreshMs: z.number().default(30000),
  maxFiles: z.number().default(20000),
  maxFileBytes: z.number().default(1024 * 1024),
  maxResults: z.number().default(25),
  maxSnippetChars: z.number().default(1200),
  timeoutMs: z.number().default(60000),
  exclude: z.array(String).default([
    '.git', 'node_modules', 'target', 'dist', 'build', 'out', '.next',
    'vendor', '.venv', 'venv', '__pycache__', '.pytest_cache', 'coverage',
    '.cache', '.pnpm-store', 'Pods', 'DerivedData',
  ]),
})

/**
 * Language table: the extensions indexed, their language id, and the patterns
 * that start a new top-level chunk. When no pattern matches, the file still
 * contributes a fixed-window chunk, so an unfamiliar language is searchable
 * rather than invisible.
 */
const LANGUAGES = {
  rust: {
    extensions: ['.rs'],
    defs: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:extern\s+"[^"]*"\s+)?(?:fn|struct|enum|trait|impl|mod|type|union|macro_rules!)\b[^\n]*/,
  },
  typescript: {
    extensions: ['.ts', '.tsx', '.mts', '.cts'],
    defs: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|enum|namespace|const|let|var)\b[^\n]*/,
  },
  javascript: {
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    defs: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\b[^\n]*/,
  },
  python: {
    extensions: ['.py', '.pyi'],
    defs: /^\s*(?:async\s+)?(?:def|class)\b[^\n]*/,
  },
  go: {
    extensions: ['.go'],
    defs: /^\s*(?:func|type|const|var)\b[^\n]*/,
  },
  c: {
    extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'],
    defs: /^\s*(?:[A-Za-z_][\w\s*&:<>,]*[\s*&])([A-Za-z_]\w*)\s*\([^;]*$/,
  },
  java: {
    extensions: ['.java'],
    defs: /^\s*(?:public|protected|private|static|final|abstract|\s)*\b(class|interface|enum|record|void|[A-Za-z_]\w*)\s+\w+/,
  },
}

/** Extensions that never carry source worth indexing. */
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico',
  '.pdf', '.zip', '.gz', '.tar', '.tgz', '.bz2', '.xz', '.7z',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.mov', '.mp3',
  '.wav', '.lock', '.map', '.min.js', '.min.css', '.so', '.dylib', '.a',
  '.o', '.class', '.jar', '.exe', '.dll', '.wasm', '.bin', '.db', '.sqlite',
])

/** How many files one directory walk may visit before it stops. */
const WALK_LIMIT = 200000

/**
 * Split one source file into symbol-sized chunks.
 *
 * A chunk starts at a definition line (or at the top of the file) and ends
 * where the next definition starts. When the language is unknown, or a file
 * has no recognized definitions, the whole file becomes one chunk (up to a
 * byte cap) so its content is still discoverable.
 *
 * @param {string} text - the decoded file text.
 * @param {string} languageId - the language key, or `''` when unknown.
 * @param {number} maxChars - per-chunk character cap.
 * @returns {Array<{ symbol: string, startLine: number, endLine: number, body: string }>}
 */
export function chunkSource(text, languageId, maxChars = 8000) {
  const language = LANGUAGES[languageId]
  const lines = text.split('\n')
  const chunks = []
  let current = null
  const flush = (endLine) => {
    if (current === null) return
    const body = current.lines.join('\n')
    if (body.trim().length > 0) {
      chunks.push({
        symbol: current.symbol,
        startLine: current.startLine,
        endLine,
        body: body.length > maxChars ? body.slice(0, maxChars) : body,
      })
    }
    current = null
  }

  if (language === undefined) {
    return wholeFileChunk(lines, maxChars)
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trimStart().startsWith('//')) {
      // A comment line never opens a chunk, but it stays attached to the
      // preceding one so doc comments travel with their symbol.
      if (current !== null) current.lines.push(line)
      continue
    }
    // A Rust test module opens a chunk even though `#[cfg(test)]` is not a
    // definition. Without this the module body would be appended to the
    // production chunk above it and demote that symbol to test code.
    if (languageId === 'rust' && /^\s*#\[cfg\(test\)\]/.test(line)) {
      flush(i)
      current = { symbol: 'tests', startLine: i + 1, lines: [line] }
      continue
    }
    if (line.trimStart().startsWith('#')) {
      // Any other attribute stays with the symbol it decorates.
      if (current !== null) current.lines.push(line)
      continue
    }
    if (language.defs.test(line)) {
      flush(i)
      current = { symbol: symbolOf(line), startLine: i + 1, lines: [line] }
      continue
    }
    if (current !== null) current.lines.push(line)
  }
  flush(lines.length)

  // A file whose definitions were never found still deserves one searchable
  // chunk rather than silence.
  if (chunks.length === 0) return wholeFileChunk(lines, maxChars)
  return chunks
}

/**
 * Build one chunk covering a whole file, capped at `maxChars`.
 * @param {string[]} lines - the file split into lines.
 * @param {number} maxChars - character cap.
 * @returns {Array<{ symbol: string, startLine: number, endLine: number, body: string }>}
 */
function wholeFileChunk(lines, maxChars) {
  const body = lines.join('\n')
  if (body.trim().length === 0) return []
  return [{
    symbol: '',
    startLine: 1,
    endLine: lines.length,
    body: body.length > maxChars ? body.slice(0, maxChars) : body,
  }]
}

/**
 * Split an identifier into its constituent words.
 *
 * FTS5's unicode tokenizer keeps `placeOrder` as one token, so a search for
 * "place order" would never match it. Every identifier is therefore indexed a
 * second time with its parts separated: `placeOrder` -> `place order`,
 * `HTTPServer` -> `HTTP Server`, `parse_snapshot` -> `parse snapshot`.
 *
 * @param {string} identifier - a symbol name.
 * @returns {string} the space-separated parts, lowercased.
 */
export function expandIdentifier(identifier) {
  if (typeof identifier !== 'string' || identifier.length === 0) return ''
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_$.]+/g, ' ')
    .toLowerCase()
    .trim()
}

/**
 * Expand identifiers inside a code body so camelCase and snake_case both match.
 * Only token-shaped runs are touched; punctuation and whitespace are preserved.
 * @param {string} body - the chunk body.
 * @returns {string} the body with identifier parts separated.
 */
export function expandBodyTokens(body) {
  return body.replace(/[A-Za-z_$][\w$]*/g, (token) => {
    const expanded = expandIdentifier(token)
    return expanded === token.toLowerCase() ? token : `${token} ${expanded}`
  })
}

/**
 * Decide whether a file is test code. Tests are excellent matches for a domain
 * term but poor answers to "where is this implemented", so the ranker demotes
 * them rather than removing them.
 * @param {string} relativePath - workspace-relative path.
 * @param {string} text - the file text.
 * @returns {boolean}
 */
export function looksLikeTest(relativePath, text = '') {
  const normalized = relativePath.split(sep).join('/')
  if (/(^|\/)(tests?|__tests__|spec)\//.test(normalized)) return true
  if (/(_test|_spec|\.test|\.spec)\.[A-Za-z0-9]+$/.test(normalized)) return true
  if (normalized.endsWith('/tests.rs') || normalized.endsWith('/test.rs')) return true
  return false
}

/**
 * Find the line span of a Rust `#[cfg(test)]` module, if the file has one.
 *
 * Unit tests live in the same file as their implementation under
 * `#[cfg(test)] mod tests { … }`, so demoting must use a span rather than "from
 * this line to the end of the file" — otherwise the production code above the
 * module is demoted too.
 *
 * @param {string} text - the whole file.
 * @returns {{ start: number, end: number } | null} one-based inclusive line span, or null.
 */
export function findTestModuleSpan(text) {
  const lines = text.split('\n')
  const startIndex = lines.findIndex((line) => /#\[cfg\(test\)\]/.test(line))
  if (startIndex < 0) return null
  // The module body opens at the next `mod ... {` and closes at the first line
  // that returns to column 0 after the opening brace.
  let depth = 0
  let opened = false
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i]
    const opens = (line.match(/{/g) ?? []).length
    const closes = (line.match(/}/g) ?? []).length
    if (opens > 0) opened = true
    depth += opens - closes
    if (opened && depth <= 0) return { start: startIndex + 1, end: i + 1 }
  }
  return { start: startIndex + 1, end: lines.length }
}

/**
 * Decide whether one chunk is test code.
 *
 * Rust puts unit tests in the same file as the implementation under a
 * `#[cfg(test)] mod tests { … }` block, so a file-level verdict would demote
 * the production code too. A chunk is test code when its own body carries a
 * test attribute, or when it sits at or below the file's first `#[cfg(test)]`
 * module boundary.
 *
 * @param {{ symbol: string, startLine: number, body: string }} chunk - the chunk.
 * @param {string} language - the language key.
 * @returns {boolean}
 */
export function chunkIsTest(chunk, language) {
  if (/(?:#\[test\]|#\[tokio::test\]|#\[cfg\(test\)\]|#\[should_panic)/.test(chunk.body)) return true
  if (language === 'rust' && chunk.symbol !== '' && /^test_|_test$|^should_/i.test(chunk.symbol)) return true
  if ((language === 'typescript' || language === 'javascript') && /^(describe|it|test)\b/.test(chunk.symbol)) return true
  if (language === 'python' && /^(test_|Test)/.test(chunk.symbol)) return true
  return false
}

/**
 * Extract a displayable symbol name from a definition line.
 * @param {string} line - one source line that matched a language definition pattern.
 * @returns {string} the symbol name, or the trimmed line when none is found.
 */
export function symbolOf(line) {
  const trimmed = line.trim()
  const patterns = [
    /\b(?:fn|struct|enum|trait|impl|mod|type|union|macro_rules!)\s+([A-Za-z_]\w*)/,
    /\b(?:function|class|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
    /\b(?:def|class)\s+([A-Za-z_]\w*)/,
    /\b(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed)
    if (match !== null) return match[1]
  }
  return trimmed.slice(0, 120)
}

/**
 * Decide the language id for a path from its extension.
 * @param {string} filePath - the file path.
 * @returns {string} the language key, or `''` when the extension is unknown.
 */
export function languageOf(filePath) {
  const extension = extname(filePath).toLowerCase()
  for (const [languageId, spec] of Object.entries(LANGUAGES)) {
    if (spec.extensions.includes(extension)) return languageId
  }
  return ''
}

/**
 * Test whether a path should be skipped entirely (binary, vendored, generated).
 * @param {string} filePath - path relative to the workspace root.
 * @param {ReadonlySet<string>} excluded - directory names to skip.
 * @returns {boolean}
 */
export function shouldSkip(filePath, excluded) {
  const parts = filePath.split(sep)
  for (const part of parts.slice(0, -1)) {
    if (excluded.has(part)) return true
  }
  const extension = extname(filePath).toLowerCase()
  if (SKIP_EXTENSIONS.has(extension)) return true
  if (filePath.endsWith('.min.js') || filePath.endsWith('.min.css')) return true
  return false
}

/**
 * Walk the workspace and return candidate source files.
 * @param {string} root - absolute workspace root.
 * @param {ReadonlySet<string>} excluded - directory names to skip.
 * @param {number} maxFiles - cap on returned files.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string[]>} workspace-relative paths.
 */
export async function walkWorkspace(root, excluded, maxFiles, signal) {
  const found = []
  const queue = ['']
  let visited = 0
  while (queue.length > 0) {
    if (signal.aborted) break
    const relativeDir = queue.shift()
    const absoluteDir = relativeDir === '' ? root : join(root, relativeDir)
    let entries
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visited += 1
      if (visited > WALK_LIMIT) return found
      if (found.length >= maxFiles) return found
      // `.git` and friends are skipped by name at every depth; hidden files are
      // indexed because a `.env.example` or `.dagger` file can still be relevant.
      if (entry.isSymbolicLink()) continue
      const childRelative = relativeDir === '' ? entry.name : join(relativeDir, entry.name)
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) continue
        queue.push(childRelative)
        continue
      }
      if (!entry.isFile()) continue
      if (shouldSkip(childRelative, excluded)) continue
      // Only known source extensions are indexed. Prose and config would each
      // become one anonymous whole-file chunk and pollute every query.
      if (languageOf(childRelative) === '') continue
      found.push(childRelative)
    }
  }
  return found
}

/**
 * Hash the path plus its stat identity, so an unchanged file re-indexes as a
 * no-op and a touched file re-parses.
 * @param {string} relativePath - workspace-relative path.
 * @param {{ size: number, mtimeMs: number }} info - the file stat.
 * @returns {string} a stable fingerprint.
 */
export function fingerprintOf(relativePath, info) {
  return createHash('sha1').update(`${relativePath}\0${info.size}\0${Math.floor(info.mtimeMs)}`).digest('hex')
}

/**
 * Escape a user query for SQLite FTS5. Bare words are AND-ed; a quoted phrase
 * stays a phrase. Operators are neutralized so a malformed query degrades to
 * "no results" rather than a thrown syntax error.
 * @param {string} query - the raw model query.
 * @returns {string} an FTS5 match expression, or `''` when nothing usable remains.
 */
export function ftsQuery(query) {
  const cleaned = query
    .replace(/["'()*:^]/g, ' ')
    .replace(/\b(AND|OR|NOT|NEAR)\b/g, ' ')
    .trim()
  if (cleaned.length === 0) return ''
  const terms = cleaned.split(/\s+/).filter((term) => term.length > 1)
  if (terms.length === 0) return ''
  // OR, not AND. A model asking "order book snapshot" wants `parse_snapshot`,
  // which contains "snapshot" but never the word "book". Requiring every term
  // returns nothing; letting terms compete lets bm25 rank the best partial
  // match first. Multi-term relevancy still works because a chunk matching more
  // terms scores better.
  return terms.map((term) => `"${term}"`).join(' OR ')
}

/**
 * Render one search result as a compact, readable block.
 * @param {object} row - a result row.
 * @param {number} maxSnippetChars - snippet cap.
 * @returns {string}
 */
export function renderResult(row, maxSnippetChars) {
  const symbol = row.symbol === '' ? '(file)' : row.symbol
  const snippet = row.body.length > maxSnippetChars ? `${row.body.slice(0, maxSnippetChars)}…` : row.body
  return `${row.file}:${row.start_line}-${row.end_line}  ${symbol}\n${indent(snippet)}`
}

/**
 * Indent a body so it reads as a quoted excerpt.
 * @param {string} text - the body.
 * @returns {string}
 */
function indent(text) {
  return text.split('\n').slice(0, 40).map((line) => `    ${line}`).join('\n')
}

/**
 * The index: one SQLite FTS5 table of symbol chunks, plus a file table that
 * remembers what has been indexed so a refresh only touches changed files.
 */
export class CodebaseIndex {
  /**
   * @param {string} databasePath - absolute path to the SQLite file.
   * @param {object} options - resolved configuration.
   */
  constructor(databasePath, options) {
    this.path = databasePath
    this.options = options
    this.db = null
    this.lastRefresh = 0
    this.opening = null
  }

  /** Open the database and create the schema on first use. */
  async open() {
    if (this.db !== null) return this.db
    if (this.opening !== null) return this.opening
    this.opening = (async () => {
      const { DatabaseSync } = await import('node:sqlite')
      // The index path may point at `<workspace>/.dsh/...`, which does not exist
      // in a repository that never used DSH before.
      await mkdir(dirname(this.path), { recursive: true })
      const db = new DatabaseSync(this.path)
      // A schema change (for example adding `search_text`) must invalidate an
      // existing index rather than failing at query time: the store is derived
      // and disposable, so the cheapest correct migration is a rebuild.
      const version = db.prepare('PRAGMA user_version').get().user_version
      if (version !== SCHEMA_VERSION) {
        db.exec('DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS files;')
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
        this.lastRefresh = 0
      }
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS files (
          path TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          indexed_at INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
          path UNINDEXED,
          symbol,
          body,
          search_text,
          start_line UNINDEXED,
          end_line UNINDEXED,
          language UNINDEXED,
          is_test UNINDEXED,
          tokenize = 'porter unicode61'
        );
      `)
      this.db = db
      return db
    })()
    try {
      return await this.opening
    } finally {
      this.opening = null
    }
  }

  /**
   * Bring the index up to date with the workspace, touching only files whose
   * fingerprint changed. Runs at most once per `refreshMs`.
   * @param {string} root - absolute workspace root.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<{ added: number, removed: number, skipped: boolean }>}
   */
  async refresh(root, signal) {
    const now = Date.now()
    if (now - this.lastRefresh < this.options.refreshMs) return { added: 0, removed: 0, skipped: true }
    const db = await this.open()
    const excluded = new Set(this.options.exclude)
    const files = await walkWorkspace(root, excluded, this.options.maxFiles, signal)

    const known = new Map()
    for (const row of db.prepare('SELECT path, fingerprint FROM files').all()) known.set(row.path, row.fingerprint)

    let added = 0
    let removed = 0
    const seen = new Set()
    const insertFile = db.prepare('INSERT OR REPLACE INTO files(path, fingerprint, indexed_at) VALUES(?,?,?)')
    const insertChunk = db.prepare(
      'INSERT INTO chunks(path, symbol, body, search_text, start_line, end_line, language, is_test) VALUES(?,?,?,?,?,?,?,?)',
    )
    const deleteChunks = db.prepare('DELETE FROM chunks WHERE path = ?')
    const deleteFile = db.prepare('DELETE FROM files WHERE path = ?')

    db.exec('BEGIN')
    try {
      for (const relativePath of files) {
        if (signal.aborted) break
        seen.add(relativePath)
        const absolute = join(root, relativePath)
        let info
        try {
          info = await stat(absolute)
        } catch {
          continue
        }
        if (!info.isFile() || info.size > this.options.maxFileBytes) continue
        const fingerprint = fingerprintOf(relativePath, info)
        if (known.get(relativePath) === fingerprint) continue

        let text
        try {
          text = await readFile(absolute, 'utf8')
        } catch {
          continue
        }
        // A NUL byte in the first 8 KiB is the cheap binary heuristic.
        if (text.slice(0, 8192).includes('\u0000')) continue

        const language = languageOf(relativePath)
        deleteChunks.run(relativePath)
        // Test-ness is decided per chunk, not per file: a Rust file's
        // `#[cfg(test)] mod tests` block must demote only its own chunks while
        // the production code above it keeps its rank.
        const fileIsTest = looksLikeTest(relativePath, '')
        // A Rust test module opens at `#[cfg(test)]` and closes at the first
        // line that dedents back to column 0 (`}`). Only chunks starting inside
        // that span are test code; the production code above it keeps its rank.
        const testSpan = language === 'rust' ? findTestModuleSpan(text) : null
        for (const chunk of chunkSource(text, language, this.options.maxChars ?? 8000)) {
          const inTestModule = testSpan !== null && chunk.startLine >= testSpan.start && chunk.startLine <= testSpan.end
          const isTest = fileIsTest || inTestModule || chunkIsTest(chunk, language) ? 1 : 0
          insertChunk.run(
            relativePath,
            chunk.symbol,
            chunk.body,
            expandIdentifier(chunk.symbol) + '\n' + expandBodyTokens(chunk.body),
            chunk.startLine,
            chunk.endLine,
            language,
            isTest,
          )
        }
        insertFile.run(relativePath, fingerprint, now)
        added += 1
      }
      for (const knownPath of known.keys()) {
        if (seen.has(knownPath)) continue
        deleteChunks.run(knownPath)
        deleteFile.run(knownPath)
        removed += 1
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }

    this.lastRefresh = now
    return { added, removed, skipped: false }
  }

  /**
   * Search indexed chunks.
   * @param {string} query - the model query.
   * @param {number} limit - result cap.
   * @returns {Array<Record<string, unknown>>} ranked rows.
   */
  async search(query, limit) {
    const db = await this.open()
    const match = ftsQuery(query)
    if (match === '') return []
    // Tests are legitimate matches, but a model asking "how does X work" wants
    // the implementation first. Demote, never drop: `is_test` shifts rank and
    // is exposed so the caller can see why a row sorted where it did.
    return db.prepare(`
      SELECT path AS file, symbol, body, start_line, end_line, language,
             is_test,
             bm25(chunks, 1.0, 4.0, 2.0) + (is_test * 3.0) AS score
      FROM chunks
      WHERE chunks MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(match, limit)
  }

  /** Count what the index currently holds, for diagnostics. */
  async stats() {
    const db = await this.open()
    const files = db.prepare('SELECT COUNT(*) AS n FROM files').get().n
    const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n
    return { files, chunks }
  }

  /** Close the database, releasing the WAL handles. */
  async close() {
    if (this.db !== null) {
      this.db.close()
      this.db = null
    }
  }
}

/**
 * Mount the plugin: one `codebase_search` tool, one lazily-opened index.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, any>} config - resolved configuration.
 */
export function apply(ctx, config) {
  const resolved = { ...config, maxChars: 8000 }
  const excluded = new Set(resolved.exclude)
  /** One index per workspace root, so two sessions in different repos do not collide. */
  const indexes = new Map()

  const indexPathFor = (root) => {
    if (typeof resolved.indexDir === 'string' && resolved.indexDir.length > 0) {
      return join(resolved.indexDir, `${createHash('sha1').update(root).digest('hex').slice(0, 16)}.sqlite`)
    }
    return join(root, '.dsh', 'codebase-index.sqlite')
  }

  const indexFor = (root) => {
    let index = indexes.get(root)
    if (index === undefined) {
      index = new CodebaseIndex(indexPathFor(root), resolved)
      indexes.set(root, index)
    }
    return index
  }

  ctx.on('dispose', () => {
    for (const index of indexes.values()) void index.close()
    indexes.clear()
  })

  ctx.tools.register(defineTool({
    name: 'codebase_search',
    description:
      'Search the codebase by meaning or structure, not just literal text. Indexes every source file into symbol-sized chunks (functions, structs, classes, methods) and ranks them with full-text search, so a query like "parse order book snapshot" finds the function that does it even when those words never share a line. Returns file:line anchors you can read directly. Prefer this over grep when you know what the code does but not what it is called.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'What to find, in natural words: an action ("reconnect websocket"), an identifier fragment, or a domain term. Multiple words are AND-ed.',
      },
      path: {
        type: 'string',
        description: 'Directory to scope the search to. Defaults to the whole session workspace; relative paths resolve against it.',
      },
      limit: {
        type: 'integer',
        description: `Maximum results to return. Defaults to and caps at ${resolved.maxResults}.`,
      },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          root: { type: 'string', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string', required: true },
                start_line: { type: 'integer', required: true },
                end_line: { type: 'integer', required: true },
                symbol: { type: 'string', required: true },
                language: { type: 'string', required: true },
                is_test: { type: 'boolean', required: true },
                snippet: { type: 'string', required: true },
              },
            },
          },
          indexed: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              files: { type: 'integer', required: true },
              chunks: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.results.length === 0) {
          return [{
            type: 'text',
            text: `No indexed symbols matched "${value.query}". The index covers ${value.indexed.files} files / ${value.indexed.chunks} chunks; try fewer words, or fall back to grep for literal text.`,
          }]
        }
        const blocks = value.results.map((row) =>
          renderResult(
            {
              file: row.file,
              symbol: row.symbol,
              body: row.snippet,
              start_line: row.start_line,
              end_line: row.end_line,
            },
            resolved.maxSnippetChars,
          ),
        )
        return [{ type: 'text', text: blocks.join('\n\n') }]
      },
    },
    async execute(args, exec) {
      const root = exec.agent?.session?.header?.cwd
      if (typeof root !== 'string') throw new Error('codebase_search requires a session workspace directory')
      const index = indexFor(root)
      await index.refresh(root, exec.signal)
      const limit = Math.min(args.limit ?? resolved.maxResults, resolved.maxResults)
      let rows = await index.search(args.query, limit)
      if (typeof args.path === 'string' && args.path.length > 0) {
        const prefix = relative(root, join(root, args.path)).split(sep).join('/')
        rows = rows.filter((row) => row.file.split(sep).join('/').startsWith(prefix))
      }
      const indexed = await index.stats()
      return {
        query: args.query,
        root,
        indexed,
        results: rows.map((row) => ({
          file: row.file,
          start_line: row.start_line,
          end_line: row.end_line,
          symbol: row.symbol,
          language: row.language ?? '',
          is_test: row.is_test === 1,
          snippet: row.body,
        })),
      }
    },
  }))
}
