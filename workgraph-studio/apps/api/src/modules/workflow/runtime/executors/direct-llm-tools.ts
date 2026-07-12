import Ajv from 'ajv'
import type { WorkflowInstance, WorkflowNode } from '@prisma/client'

/**
 * Self-contained tools for the DIRECT workgraph→LLM agentic loop.
 *
 * This is the CF/MCP *bypass* path: unlike the governed loop (which dispatches
 * MCP tools through the governance oracle at `/mcp/tool-run`), these tools run
 * IN-PROCESS inside workgraph-api with no MCP, no context-fabric, and no network.
 * Because there is no governance oracle in front of them, safety is a property of
 * the tools themselves — every tool here MUST be read-only / pure:
 *
 *   - no filesystem writes, no shell, no process spawn;
 *   - no arbitrary network egress;
 *   - no mutation of the workflow instance or database.
 *
 * A tool that cannot honour that contract does not belong on the direct path —
 * route that work to a governed AGENT_TASK instead. The registry below is the
 * allowlist: the model can only ever call a tool that is registered here AND
 * enabled for the node.
 */

const ajv = new Ajv({ allErrors: true, strict: false })

const MAX_TOOL_RESULT_CHARS = 6_000

export type DirectLlmToolContext = {
  instance: WorkflowInstance
  node: WorkflowNode
  // The node's output contract, so `validate_output` can check a candidate answer.
  requiredOutputIncludes: string[]
  outputJsonSchema?: Record<string, unknown>
}

export type DirectLlmToolResult = { ok: boolean; content: string }

export type DirectLlmTool = {
  name: string
  description: string
  // JSON Schema for the tool input (Anthropic `input_schema` / OpenAI `function.parameters`).
  inputSchema: Record<string, unknown>
  run: (input: Record<string, unknown>, ctx: DirectLlmToolContext) => DirectLlmToolResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clip(text: string): string {
  return text.length <= MAX_TOOL_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (truncated ${text.length - MAX_TOOL_RESULT_CHARS} more chars)`
}

function contextObject(instance: WorkflowInstance): Record<string, unknown> {
  return isRecord(instance.context) ? instance.context : {}
}

// Resolve a dotted path (e.g. "vars.story", "globals.capability", "outputs.plan.title")
// against a plain object graph. Read-only: walks objects + array indices only.
function resolvePath(root: Record<string, unknown>, path: string): { found: boolean; value: unknown } {
  if (!path.trim()) return { found: true, value: root }
  let cursor: unknown = root
  for (const rawKey of path.split('.')) {
    const key = rawKey.trim()
    if (!key) continue
    if (isRecord(cursor) && key in cursor) {
      cursor = cursor[key]
    } else if (Array.isArray(cursor) && /^\d+$/.test(key) && Number(key) < cursor.length) {
      cursor = cursor[Number(key)]
    } else {
      return { found: false, value: undefined }
    }
  }
  return { found: true, value: cursor }
}

function stringifyValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * Validate a candidate answer against an output contract (required substrings + JSON
 * schema). Shared by the `validate_output` tool and the loop's final check so both
 * agree on what "valid" means. `validationMode: 'off'` skips validation entirely.
 */
export function validateAgainstContract(
  content: string,
  opts: { requiredOutputIncludes: string[]; outputJsonSchema?: Record<string, unknown>; validationMode: 'off' | 'soft' | 'hard' },
): { passed: boolean; errors: string[] } {
  if (opts.validationMode === 'off') return { passed: true, errors: [] }
  const errors: string[] = []
  const lower = content.toLowerCase()
  for (const required of opts.requiredOutputIncludes) {
    if (required && !lower.includes(required.toLowerCase())) errors.push(`missing required output text: ${required}`)
  }
  if (opts.outputJsonSchema) {
    let parsed: unknown
    try {
      parsed = JSON.parse(content.trim())
    } catch {
      parsed = undefined
    }
    if (!isRecord(parsed)) {
      errors.push('output is not parseable JSON for the configured schema')
    } else if (!ajv.validate(opts.outputJsonSchema, parsed)) {
      errors.push(...(ajv.errors ?? []).map(err => `${err.instancePath || '/'} ${err.message ?? 'schema validation failed'}`))
    }
  }
  return { passed: errors.length === 0, errors }
}

// ── read_context ──────────────────────────────────────────────────────────
// Read a value from the workflow instance context (vars / globals / prior node
// outputs) by dotted path. Pure, read-only, in-process — no side effects.
const readContextTool: DirectLlmTool = {
  name: 'read_context',
  description:
    'Read a value from the workflow instance context by dotted path (e.g. "vars.story", "globals.capability"). ' +
    'Returns the JSON value at that path, or a not-found note. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Dotted path into the instance context, e.g. "vars.story".' },
    },
    required: ['path'],
  },
  run(input, ctx) {
    const path = typeof input.path === 'string' ? input.path : ''
    if (!path) return { ok: false, content: 'read_context requires a "path" string.' }
    const { found, value } = resolvePath(contextObject(ctx.instance), path)
    if (!found) return { ok: false, content: `No value found at context path "${path}".` }
    return { ok: true, content: clip(`Value at "${path}":\n${stringifyValue(value)}`) }
  },
}

// ── list_context_keys ─────────────────────────────────────────────────────
// Enumerate the readable context paths so the model knows what read_context can fetch.
const listContextKeysTool: DirectLlmTool = {
  name: 'list_context_keys',
  description:
    'List the top-level keys available in the workflow instance context (and inside vars / globals), ' +
    'so you know what read_context can fetch. Read-only.',
  inputSchema: { type: 'object', properties: {} },
  run(_input, ctx) {
    const context = contextObject(ctx.instance)
    const lines: string[] = [`context.*: ${Object.keys(context).join(', ') || '(none)'}`]
    for (const bucket of ['vars', 'globals', '_vars', '_globals']) {
      const sub = context[bucket]
      if (isRecord(sub)) lines.push(`${bucket}.*: ${Object.keys(sub).join(', ') || '(none)'}`)
    }
    return { ok: true, content: clip(lines.join('\n')) }
  },
}

// ── validate_output ───────────────────────────────────────────────────────
// Check a candidate final answer against the node's configured output contract
// (required substrings + JSON schema), so the model can self-correct BEFORE it
// finalizes. Pure — mirrors the harness's validateHarnessOutput.
const validateOutputTool: DirectLlmTool = {
  name: 'validate_output',
  description:
    "Validate a candidate final answer against this node's output contract (required text + JSON schema). " +
    'Returns whether it passes and, if not, the specific problems to fix. Use this before giving your final answer.',
  inputSchema: {
    type: 'object',
    properties: {
      candidate: { type: 'string', description: 'The candidate final answer to validate.' },
    },
    required: ['candidate'],
  },
  run(input, ctx) {
    const candidate = typeof input.candidate === 'string' ? input.candidate : ''
    const { passed, errors } = validateAgainstContract(candidate, {
      requiredOutputIncludes: ctx.requiredOutputIncludes,
      outputJsonSchema: ctx.outputJsonSchema,
      // The model explicitly asked to validate, so always check against the contract.
      validationMode: 'soft',
    })
    return passed
      ? { ok: true, content: 'VALID: the candidate satisfies the output contract.' }
      : { ok: true, content: `INVALID. Fix these problems, then answer:\n${errors.map(e => `- ${e}`).join('\n')}` }
  },
}

// The complete allowlist. Adding an entry here is the ONLY way to expose a tool to
// the direct loop, and every entry must uphold the read-only/pure contract above.
export const DIRECT_LLM_TOOL_REGISTRY: Record<string, DirectLlmTool> = {
  [readContextTool.name]: readContextTool,
  [listContextKeysTool.name]: listContextKeysTool,
  [validateOutputTool.name]: validateOutputTool,
}

export const DEFAULT_DIRECT_LLM_TOOLS = Object.keys(DIRECT_LLM_TOOL_REGISTRY)

/**
 * Resolve the enabled tools for a node from a requested name list. Unknown names are
 * dropped (never dispatched) — the registry is the hard allowlist. An empty/undefined
 * request enables the full safe default set.
 */
export function resolveDirectLlmTools(requested?: string[] | null): { tools: DirectLlmTool[]; unknown: string[] } {
  const names = Array.isArray(requested) && requested.length
    ? requested.map(n => String(n).trim()).filter(Boolean)
    : DEFAULT_DIRECT_LLM_TOOLS
  const tools: DirectLlmTool[] = []
  const unknown: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const tool = DIRECT_LLM_TOOL_REGISTRY[name]
    if (!tool) { unknown.push(name); continue }
    if (seen.has(name)) continue
    seen.add(name)
    tools.push(tool)
  }
  return { tools, unknown }
}

/** Dispatch a single tool call by name. A name not in the allowlist yields an error
 * result the model can recover from — it is never executed. */
export function dispatchDirectLlmTool(
  name: string,
  input: Record<string, unknown>,
  enabled: DirectLlmTool[],
  ctx: DirectLlmToolContext,
): DirectLlmToolResult {
  const tool = enabled.find(t => t.name === name)
  if (!tool) {
    return { ok: false, content: `Tool "${name}" is not allowed on the direct path. Allowed tools: ${enabled.map(t => t.name).join(', ') || '(none)'}.` }
  }
  try {
    return tool.run(isRecord(input) ? input : {}, ctx)
  } catch (err) {
    return { ok: false, content: `Tool "${name}" failed: ${(err as Error).message}` }
  }
}
