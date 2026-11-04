/**
 * @dsh-turn-rewind — durable, per-turn snapshots of every file a turn touches,
 * plus a tool to put those files back.
 *
 * The value is the gap between "the model changed 12 files" and "I want the
 * state from before it started". Git cannot answer that: the working tree may
 * already hold unrelated uncommitted edits, and a `git checkout` would discard
 * them too.
 *
 * Design constraints:
 *
 * - Snapshot on intent, not on result. `fs/write-intent` and `fs/edit-intent`
 *   fire BEFORE the mutation, so the first capture of a path is genuinely its
 *   pre-turn content even when the same path is edited five times in a turn.
 * - Only the first capture per (session, turn, path) is kept. Later captures of
 *   the same path would overwrite the baseline with already-mutated content.
 * - Nothing is written back without an explicit tool call. Snapshots are inert
 *   until `rewind_turn` runs, and the tool reports exactly what it restored.
 * - The store is plain files under the Harness home, so it survives a Host
 *   restart — unlike the in-memory `workspace-changes` comparisons.
 *
 * @module dsh-turn-rewind
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'turn-rewind'

/** Services required. `session` is optional in the dependency list because the
 *  store only needs it to attribute snapshots; the mutation hooks work without. */
export const inject = ['tools', 'fs', 'subprocess']

/** Plugin configuration. */
export const Config = z.object({
  storeDir: z.string().default(''),
  maxFileBytes: z.number().default(2 * 1024 * 1024),
  maxFilesPerTurn: z.number().default(200),
  /** Days a session's snapshots are kept. 0 disables pruning. */
  retainDays: z.number().default(14),
  /** Maximum sessions kept, oldest pruned first. 0 disables the cap. */
  maxSessions: z.number().default(50),
  timeoutMs: z.number().default(60000),
})

/**
 * In-memory index of one session's snapshots.
 *
 * Layout on disk:
 *   `<store>/<sessionId>/<turn>/manifest.json`
 *   `<store>/<sessionId>/<turn>/<sha1-of-path>.blob`
 *
 * The manifest maps a display path to either `{ blob, size }` for content we
 * captured, or `{ absent: true }` for a path that did not exist before the
 * turn — rewinding that path means deleting it.
 */
export class TurnStore {
  /**
   * @param {string} root - absolute store directory.
   * @param {object} options - resolved configuration.
   */
  constructor(root, options) {
    this.root = root
    this.options = options
    /** @type {Map<string, { turn: number, files: Map<string, object> }>} */
    this.turns = new Map()
  }

  /**
   * Turn directory for one session and turn number.
   * @param {string} sessionId - the session id.
   * @param {number} turn - the turn number.
   * @returns {string} absolute directory path.
   */
  dirFor(sessionId, turn) {
    return join(this.root, sanitize(sessionId), String(turn))
  }

  /**
   * Record the pre-mutation state of one path, keeping only the first capture
   * per path per turn.
   * @param {string} sessionId - the session id.
   * @param {number} turn - the turn number.
   * @param {string} displayPath - the path as the filesystem reports it.
   * @param {string | undefined} content - the pre-turn text, or undefined when absent.
   * @returns {Promise<'captured' | 'already-captured' | 'skipped'>}
   */
  async record(sessionId, turn, displayPath, content) {
    const key = `${sessionId}\u0000${turn}`
    let entry = this.turns.get(key)
    if (entry === undefined) {
      entry = { turn, files: new Map() }
      this.turns.set(key, entry)
    }
    if (entry.files.has(displayPath)) return 'already-captured'
    if (entry.files.size >= this.options.maxFilesPerTurn) return 'skipped'

    const dir = this.dirFor(sessionId, turn)
    if (content === undefined) {
      entry.files.set(displayPath, { absent: true })
      await writeManifest(dir, entry.files)
      return 'captured'
    }
    if (Buffer.byteLength(content, 'utf8') > this.options.maxFileBytes) return 'skipped'
    await mkdir(dir, { recursive: true })
    const blob = blobName(displayPath)
    await writeFile(join(dir, blob), content, 'utf8')
    entry.files.set(displayPath, { blob, size: Buffer.byteLength(content, 'utf8') })
    await writeManifest(dir, entry.files)
    return 'captured'
  }

  /**
   * List the turns this session has snapshots for, newest last.
   * @param {string} sessionId - the session id.
   * @returns {Promise<number[]>} turn numbers.
   */
  async turnsFor(sessionId) {
    let entries
    try {
      entries = await readdir(join(this.root, sanitize(sessionId)), { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .sort((left, right) => left - right)
  }

  /**
   * Read one turn's manifest from disk, falling back to the in-memory map.
   * @param {string} sessionId - the session id.
   * @param {number} turn - the turn number.
   * @returns {Promise<Map<string, object> | undefined>}
   */
  async manifest(sessionId, turn) {
    const inMemory = this.turns.get(`${sessionId}\u0000${turn}`)
    if (inMemory !== undefined && inMemory.files.size > 0) return inMemory.files
    try {
      const raw = await readFile(join(this.dirFor(sessionId, turn), 'manifest.json'), 'utf8')
      const parsed = JSON.parse(raw)
      const files = new Map(Object.entries(parsed.files ?? {}))
      return files
    } catch {
      return undefined
    }
  }

  /**
   * Read one captured blob back.
   * @param {string} sessionId - the session id.
   * @param {number} turn - the turn number.
   * @param {{ blob: string }} record - the manifest record.
   * @returns {Promise<string>} the captured text.
   */
  async readBlob(sessionId, turn, record) {
    return readFile(join(this.dirFor(sessionId, turn), record.blob), 'utf8')
  }

  /** Drop one turn's snapshots. */
  async discard(sessionId, turn) {
    this.turns.delete(`${sessionId}\u0000${turn}`)
    await rm(this.dirFor(sessionId, turn), { recursive: true, force: true })
  }

  /**
   * Drop snapshots that fell out of the retention window.
   *
   * Snapshots exist to make a recent mistake recoverable; they are not history.
   * Without this the store grows for the life of the machine, one copy per
   * touched file per turn.
   *
   * @param {{ retainDays: number, maxSessions: number }} limits - retention policy.
   * @param {number} now - current epoch milliseconds, injectable for tests.
   * @returns {Promise<{ sessions: number, turns: number }>} what was removed.
   */
  async prune(limits, now = Date.now()) {
    const cutoff = limits.retainDays > 0 ? now - limits.retainDays * 86400000 : undefined
    let removedSessions = 0
    let removedTurns = 0

    let sessions
    try {
      sessions = await readdir(this.root, { withFileTypes: true })
    } catch {
      return { sessions: 0, turns: 0 }
    }
    const live = []
    for (const entry of sessions) {
      if (!entry.isDirectory()) continue
      const sessionDir = join(this.root, entry.name)
      let newest = 0
      let turns
      try {
        turns = await readdir(sessionDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const turn of turns) {
        if (!turn.isDirectory() || !/^\d+$/.test(turn.name)) continue
        const turnDir = join(sessionDir, turn.name)
        let stamp
        try {
          stamp = (await stat(join(turnDir, 'manifest.json'))).mtimeMs
        } catch {
          continue
        }
        newest = Math.max(newest, stamp)
        if (cutoff !== undefined && stamp < cutoff) {
          await rm(turnDir, { recursive: true, force: true })
          removedTurns += 1
        }
      }
      if (cutoff !== undefined) {
        // A session whose every turn expired leaves an empty directory behind.
        const left = await readdir(sessionDir).catch(() => [])
        if (left.length === 0) {
          await rm(sessionDir, { recursive: true, force: true })
          removedSessions += 1
          continue
        }
      }
      live.push({ name: entry.name, newest })
    }

    // Oldest-first session cap, independent of the age window.
    if (limits.maxSessions > 0 && live.length > limits.maxSessions) {
      live.sort((left, right) => left.newest - right.newest)
      for (const stale of live.slice(0, live.length - limits.maxSessions)) {
        await rm(join(this.root, stale.name), { recursive: true, force: true })
        removedSessions += 1
      }
    }
    return { sessions: removedSessions, turns: removedTurns }
  }
}

/**
 * A filesystem-safe component for a session id.
 * @param {string} value - the raw id.
 * @returns {string} a safe directory name.
 */
function sanitize(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 24)
}

/**
 * Stable blob file name for a path.
 * @param {string} displayPath - the path.
 * @returns {string} `<sha1>.blob`.
 */
function blobName(displayPath) {
  return `${createHash('sha1').update(displayPath).digest('hex')}.blob`
}

/**
 * Persist a manifest so a restarted Host can still rewind.
 * @param {string} dir - the turn directory.
 * @param {Map<string, object>} files - the captured records.
 */
async function writeManifest(dir, files) {
  await mkdir(dir, { recursive: true })
  const body = JSON.stringify({ files: Object.fromEntries(files) }, null, 2)
  await writeFile(join(dir, 'manifest.json'), body, 'utf8')
}

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, any>} config - resolved configuration.
 */
export function apply(ctx, config) {
  const storeRoot = config.storeDir !== '' ? config.storeDir : join(defaultHome(ctx), 'rewind')
  const store = new TurnStore(storeRoot, config)

  /** The turn currently open per session, so intent hooks know where to write. */
  const openTurns = new Map()

  // The baseline must be known before the first mutation. `agent/pre-step` is a
  // waterfall that runs before tools and carries the authoritative turn number,
  // so the first step of a turn opens it. Delegating with `next()` is mandatory:
  // a waterfall listener that returns nothing would replace the step decision.
  ctx.on('agent/pre-step', async (payload, next) => {
    const sessionId = payload?.agent?.id
    const turn = payload?.turn
    if (typeof sessionId === 'string' && typeof turn === 'number') {
      const key = `${sessionId}\u0000${turn}`
      if (openTurns.get(key) === undefined) openTurns.set(key, { sessionId, turn })
    }
    return next()
  })

  // Bind the pending mutation to its tool execution. The intent waterfalls
  // arrive with that same execution as their `actor`, which is how a capture
  // knows which turn it belongs to even under concurrent subagents.
  const pending = new WeakMap()
  ctx.on('tools/pre-execute', async (exec, next) => {
    // `openTurnFor` already returns the `{ sessionId, turn }` record; wrapping it
    // again would store `{ sessionId, turn: { sessionId, turn } }` and turn the
    // snapshot directory name into "[object Object]".
    const open = openTurnFor(openTurns, exec.agent?.id)
    if (open !== undefined) pending.set(exec, open)
    return next()
  })

  // Capture BEFORE a write lands, matching the provider's own ordering: the
  // listener says `prepend`, so the blob is the pre-mutation content.
  ctx.on('fs/write-intent', async (target, actor, next) => {
    const intent = await next()
    await capture(ctx, store, pending.get(actor), target)
    return intent
  }, { prepend: true })

  ctx.on('fs/edit-intent', async (target, actor, next) => {
    const decision = await next()
    await capture(ctx, store, pending.get(actor), target)
    return decision
  }, { prepend: true })

  // The turn's authoritative boundary: close it so a later turn cannot append
  // to a finished baseline, and drop the in-memory handle.
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const sessionId = agent?.id
    if (typeof sessionId !== 'string') return
    openTurns.delete(`${sessionId}\u0000${turn}`)
  })

  // Prune once at load, not per turn: the window is measured in days, so a
  // per-turn sweep would cost a directory walk for no benefit. A failure here
  // must not block startup — the store is advisory.
  void store
    .prune({ retainDays: config.retainDays, maxSessions: config.maxSessions })
    .then((removed) => {
      if (removed.turns > 0 || removed.sessions > 0) {
        ctx.logger?.info?.(
          `turn-rewind: pruned ${removed.turns} expired turn(s) across ${removed.sessions} session(s)`,
        )
      }
    })
    .catch((error) => {
      ctx.logger?.warn?.(`turn-rewind: prune failed: ${String(error)}`)
    })

  ctx.on('dispose', () => {
    openTurns.clear()
  })

  ctx.tools.register(defineTool({
    name: 'rewind_turn',
    description:
      'Restore files to the state they had before a given turn of this session. Snapshots are captured before each file mutation, so this undoes the agent\'s edits without touching unrelated working-tree changes. Call with no arguments to list the turns that have snapshots. Restoring is destructive to the current content of the listed files: the tool reports every path it wrote or deleted.',
    parameters: {
      turn: {
        type: 'integer',
        description: 'The turn number to restore. Omit to list the available turns.',
      },
      dry_run: {
        type: 'boolean',
        description: 'Report what would change without writing anything.',
      },
    },
    timeoutMs: config.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          turns: { type: 'array', required: true, items: { type: 'integer' } },
          restored: { type: 'array', required: true, items: { type: 'string' } },
          deleted: { type: 'array', required: true, items: { type: 'string' } },
          skipped: { type: 'array', required: true, items: { type: 'string' } },
          dry_run: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const lines = []
        if (value.action === 'list') {
          if (value.turns.length === 0) {
            lines.push('No turn snapshots recorded for this session yet. Snapshots start at the first turn that edits a file.')
          } else {
            lines.push(`Turns with snapshots: ${value.turns.join(', ')}`)
            lines.push('Call rewind_turn with a turn number to restore its files.')
          }
        } else {
          const verb = value.dry_run ? 'Would restore' : 'Restored'
          lines.push(`${verb} ${value.restored.length} file(s) from turn ${value.turns[0]}.`)
          if (value.restored.length > 0) lines.push(...value.restored.map((path) => `  ~ ${path}`))
          if (value.deleted.length > 0) {
            lines.push(`${value.dry_run ? 'Would delete' : 'Deleted'} ${value.deleted.length} file(s) created by that turn:`)
            lines.push(...value.deleted.map((path) => `  - ${path}`))
          }
          if (value.skipped.length > 0) {
            lines.push(`Skipped ${value.skipped.length} path(s) that could not be restored:`)
            lines.push(...value.skipped.map((path) => `  ! ${path}`))
          }
          if (value.restored.length === 0 && value.deleted.length === 0) lines.push('Nothing to change for that turn.')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.id
      if (typeof sessionId !== 'string') throw new Error('rewind_turn requires a session')
      const turns = await store.turnsFor(sessionId)

      if (args.turn === undefined) {
        return { action: 'list', turns, restored: [], deleted: [], skipped: [], dry_run: false }
      }
      const turn = args.turn
      if (!turns.includes(turn)) {
        throw new Error(
          `No snapshot for turn ${turn}. Available turns: ${turns.length === 0 ? '(none)' : turns.join(', ')}`,
        )
      }
      const files = await store.manifest(sessionId, turn)
      if (files === undefined) throw new Error(`Snapshot for turn ${turn} is unreadable`)

      const restored = []
      const deleted = []
      const skipped = []
      for (const [displayPath, record] of files) {
        if (exec.signal.aborted) break
        try {
          if (record.absent === true) {
            if (!args.dry_run) await removeFile(ctx, displayPath)
            deleted.push(displayPath)
            continue
          }
          const text = await store.readBlob(sessionId, turn, record)
          if (!args.dry_run) await writeBack(ctx, displayPath, text)
          restored.push(displayPath)
        } catch {
          skipped.push(displayPath)
        }
      }
      return { action: 'rewind', turns: [turn], restored, deleted, skipped, dry_run: args.dry_run === true }
    },
  }))
}

/**
 * The most recently opened turn for one session.
 * @param {Map<string, { sessionId: string, turn: number }>} openTurns - open turns.
 * @param {string | undefined} sessionId - the session.
 * @returns {{ sessionId: string, turn: number } | undefined}
 */
function openTurnFor(openTurns, sessionId) {
  if (typeof sessionId !== 'string') return undefined
  let best
  for (const entry of openTurns.values()) {
    if (entry.sessionId !== sessionId) continue
    if (best === undefined || entry.turn > best.turn) best = entry
  }
  return best
}

/**
 * Capture one target's current content into the open turn, if there is one.
 * Failures are swallowed: a snapshot problem must never block the write the
 * model is actually making.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {TurnStore} store - the snapshot store.
 * @param {{ sessionId: string, turn: number } | undefined} open - the turn this capture belongs to.
 * @param {any} target - the resolved filesystem target.
 */
async function capture(ctx, store, open, target) {
  const displayPath = target?.displayPath
  if (typeof displayPath !== 'string') return
  if (open === undefined) return
  try {
    const info = await ctx.fs.stat(target)
    if (info === undefined) {
      await store.record(open.sessionId, open.turn, displayPath, undefined)
      return
    }
    if (info.type !== 'file') return
    if (typeof info.size === 'number' && info.size > store.options.maxFileBytes) return
    const text = await ctx.fs.readText(target)
    await store.record(open.sessionId, open.turn, displayPath, text)
  } catch {
    // Advisory: an unreadable or oversized file simply does not get a snapshot.
  }
}

/**
 * Write captured content back through the filesystem seam.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} displayPath - the path to restore.
 * @param {string} text - the captured content.
 */
async function writeBack(ctx, displayPath, text) {
  const target = await ctx.fs.resolve(displayPath)
  await ctx.fs.writeText(target, text)
}

/**
 * Delete a file that did not exist before the rewind target turn.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} displayPath - the path to delete.
 */
async function removeFile(ctx, displayPath) {
  const target = await ctx.fs.resolve(displayPath)
  const info = await ctx.fs.stat(target)
  if (info === undefined) return
  // The filesystem seam exposes no delete, so route the removal through the
  // process seam. `argv` is never shell-interpreted and the path is passed after
  // `--`, so a filename containing spaces or dashes cannot become an option.
  const handle = ctx.subprocess.spawn({
    argv: ['rm', '-f', '--', ctx.fs.processPath(target)],
    cwd: dirname(ctx.fs.processPath(target)),
    stdio: { stdin: 'ignore', stdout: 'ignore', stderr: { maxBytes: 4096 } },
    graceMs: 2000,
  })
  await handle.done
}

/**
 * Resolve the Harness home for the default store location.
 * @param {any} ctx - plugin context.
 * @returns {string} absolute home directory.
 */
function defaultHome(ctx) {
  // `homePaths` is a cordis service: touching it without declaring it in `inject`
  // throws at load. Reading the environment first keeps the plugin usable in a
  // composition that mounts no home-paths row.
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  try {
    const injected = ctx.homePaths?.home
    if (typeof injected === 'string' && injected.length > 0) return injected
  } catch {
    // Service unavailable in this composition; fall through to the home default.
  }
  return join(process.env.HOME ?? process.cwd(), '.dsh')
}
