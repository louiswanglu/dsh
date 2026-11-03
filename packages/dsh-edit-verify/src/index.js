/**
 * @dsh-edit-verify — language-server feedback for freshly edited files.
 *
 * After a successful file-mutating tool call, run `lsp_diagnostics` on the
 * changed file and append the findings to the model-facing tool result. An
 * agent that just wrote a broken import should learn about it in the same
 * step, not after the user runs the build.
 *
 * Design constraints, all load-bearing:
 *
 * - Read-only side effect. The listener never edits, never formats, and never
 *   runs a build. It only asks a language server what it already knows.
 * - Failure is invisible. A missing `lsp_diagnostics` tool, an unrouted file
 *   extension, a crashed server, or a timeout all mean "say nothing"; a
 *   verification problem must never fail the edit the model actually made.
 * - Bounded fan-out. One diagnostics request per (execution, file), never a
 *   request per byte; tool results are capped so a broken generated file
 *   cannot flood the context.
 *
 * @module dsh-edit-verify
 */

import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'edit-verify'

/** Services required before the listener can run. */
export const inject = ['tools']

/**
 * Plugin configuration, declared as a schemastery schema so the loader can
 * validate and default it before `apply` runs.
 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  tools: z.array(String).default(['write', 'edit']),
  maxDiagnostics: z.number().default(20),
  timeoutMs: z.number().default(15000),
  severities: z.array(z.number()).default([1, 2]),
})

/** The nested tool name this plugin calls. */
const DIAGNOSTICS_TOOL = 'lsp_diagnostics'

/**
 * File-mutating tool calls, mapped to the argument that names the target file.
 * `str_replace_editor` only mutates for three of its subcommands, so its entry
 * carries the accepted command set.
 */
const MUTATING_CALLS = {
  write: { pathArg: 'file_path' },
  edit: { pathArg: 'file_path' },
  str_replace_editor: {
    pathArg: 'path',
    commands: ['create', 'str_replace', 'insert'],
    commandArg: 'command',
  },
}

/** LSP severity numbers kept by default: 1 (error) and 2 (warning). */
const SEVERITY_LABEL = { 1: 'error', 2: 'warning', 3: 'information', 4: 'hint' }

/**
 * Resolve the file a successful call mutated, or `undefined` when the call is
 * not a mutation this plugin verifies.
 * @param {string} toolName - the registered tool name.
 * @param {unknown} args - parsed tool arguments.
 * @returns {string | undefined} the file path as the model supplied it.
 */
export function mutatedFile(toolName, args) {
  const spec = MUTATING_CALLS[toolName]
  if (spec === undefined || args === null || typeof args !== 'object') return undefined
  if (spec.commands !== undefined) {
    const command = /** @type {Record<string, unknown>} */ (args)[spec.commandArg]
    if (typeof command !== 'string' || !spec.commands.includes(command)) return undefined
  }
  const value = /** @type {Record<string, unknown>} */ (args)[spec.pathArg]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * Render the diagnostics block appended to a tool result. Kept deliberately
 * terse: the model already knows what it edited, so only the file name,
 * position, severity, and message are repeated.
 * @param {string} filePath - the file the model named.
 * @param {ReadonlyArray<{ severity: number, range: { start: { line: number, character: number } }, message: string, source?: string }>} diagnostics
 * @param {number} maxDiagnostics - how many findings to render.
 * @returns {string} the appended text, or an empty string when nothing is worth showing.
 */
export function renderDiagnostics(filePath, diagnostics, maxDiagnostics) {
  if (diagnostics.length === 0) return ''
  const shown = diagnostics.slice(0, maxDiagnostics)
  const lines = shown.map((diagnostic) => {
    const severity = SEVERITY_LABEL[diagnostic.severity] ?? 'problem'
    const line = diagnostic.range.start.line + 1
    const column = diagnostic.range.start.character + 1
    const source = diagnostic.source === undefined ? '' : ` [${diagnostic.source}]`
    return `${line}:${column} ${severity}${source}: ${diagnostic.message}`
  })
  const omitted = diagnostics.length - shown.length
  const footer = omitted > 0 ? `\n… ${omitted} more diagnostic(s) not shown` : ''
  return `\n\n<lsp-diagnostics file="${filePath}">\n${lines.join('\n')}${footer}\n</lsp-diagnostics>`
}

/**
 * Extract the diagnostics array from a nested `lsp_diagnostics` result value.
 * @param {unknown} value - the nested call's canonical value.
 * @returns {ReadonlyArray<Record<string, unknown>> | undefined}
 */
export function diagnosticsFrom(value) {
  if (value === null || typeof value !== 'object') return undefined
  const record = /** @type {Record<string, unknown>} */ (value)
  if (record.kind !== 'diagnostics' || !Array.isArray(record.diagnostics)) return undefined
  return /** @type {ReadonlyArray<Record<string, unknown>>} */ (record.diagnostics)
}

/**
 * Register the post-execute verification listener.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, any>} config - resolved configuration.
 */
export function apply(ctx, config) {
  if (config.enabled === false) return
  const verifiedTools = new Set(config.tools)
  const severities = new Set(config.severities)

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    // Only a successful, content-preserving outcome is extended: replacing a
    // `value` would rewrite a tool's canonical output contract, and a failed
    // call already reports its own error.
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
    if (result.isError) return decision
    if (!verifiedTools.has(exec.name)) return decision

    const filePath = mutatedFile(exec.name, exec.arguments)
    if (filePath === undefined) return decision

    // A nested `str_replace_editor` create has no language-server route, and a
    // new file's empty diagnostics are not worth a round-trip; neither is a
    // path the model wrote outside the session workspace.
    const workspaceRoot = exec.agent?.session?.header?.cwd
    if (typeof workspaceRoot !== 'string') return decision

    let diagnostics
    try {
      diagnostics = await requestDiagnostics(ctx, exec, filePath, config.timeoutMs)
    } catch {
      // Verification is advisory: a server crash, a missing binary, an unrouted
      // extension, or a timeout must never surface as a tool failure.
      return decision
    }
    const relevant = (diagnostics ?? []).filter((diagnostic) => severities.has(diagnostic.severity))
    const text = renderDiagnostics(filePath, relevant, config.maxDiagnostics)
    if (text.length === 0) return decision

    const base = decision.content ?? result.content
    return { kind: 'accept', content: appendText(base, text) }
  })
}

/**
 * Append one text block to a content array without disturbing its order.
 * @param {ReadonlyArray<Record<string, unknown>>} content - the settled content.
 * @param {string} text - the diagnostics block.
 * @returns {Array<Record<string, unknown>>} the extended content.
 */
function appendText(content, text) {
  return [...content, { type: 'text', text }]
}

/**
 * Ask the language server for diagnostics on one file through the nested tool
 * pipeline, so the same routing, sandbox, and cancellation rules apply as for
 * a model-requested call. The nested dispatch runs as the same agent, which
 * keeps it inside the session's scope and workspace.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {any} exec - the outer execution.
 * @param {string} filePath - the changed file.
 * @param {number} timeoutMs - bound on the whole request.
 * @returns {Promise<ReadonlyArray<Record<string, unknown>> | undefined>}
 */
async function requestDiagnostics(ctx, exec, filePath, timeoutMs) {
  // The LSP surface is optional: a profile without `dsh-lsp-actions` registers
  // no such tool, and an unknown tool dispatch would fail. Look before calling.
  if (!ctx.tools.schemas(exec.agent).some((schema) => schema.name === DIAGNOSTICS_TOOL)) return undefined

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  exec.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const nested = await ctx.tools.execute({
      callId: `${exec.callId}:edit-verify`,
      rootCallId: exec.rootCallId,
      name: DIAGNOSTICS_TOOL,
      arguments: { file_path: filePath },
      agent: exec.agent,
      parent: exec.token,
      signal: controller.signal,
    })
    if (nested.isError) return undefined
    return diagnosticsFrom(nested.value)
  } finally {
    clearTimeout(timer)
    exec.signal?.removeEventListener('abort', onAbort)
  }
}
