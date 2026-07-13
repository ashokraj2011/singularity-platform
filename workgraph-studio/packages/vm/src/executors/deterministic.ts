// ─────────────────────────────────────────────────────────────────────────────
// Deterministic executors — run fully offline with no external services. Faithful
// to the server-side node semantics (SET_CONTEXT interpolation, structural
// pass-through). Routing for gateways is handled by @workgraph/engine's
// GraphTraverser; these executors only mutate context / complete the node.
// ─────────────────────────────────────────────────────────────────────────────

import type { ExecContext, ExecOutcome, NodeExecutor } from '../types.js'

function walk(root: Record<string, unknown> | undefined, path: string): unknown {
  if (!root) return undefined
  return path.split('.').reduce<unknown>((cur, key) => {
    if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[key]
    return undefined
  }, root)
}

function setNestedPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
    cur = cur[parts[i]] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

function physicalPath(path: string): string {
  if (path.startsWith('vars.')) return `_vars.${path.slice('vars.'.length)}`
  if (path.startsWith('params.')) return `_params.${path.slice('params.'.length)}`
  if (path.startsWith('globals.')) return `_globals.${path.slice('globals.'.length)}`
  if (path.startsWith('context.')) return path.slice('context.'.length)
  if (path.startsWith('output.')) return path.slice('output.'.length)
  return path
}

function resolveServerRef(path: string, now: Date): unknown {
  switch (path) {
    case 'now':
    case 'iso':
      return now.toISOString()
    case 'epochMs':
      return now.valueOf()
    case 'epochSeconds':
      return Math.floor(now.valueOf() / 1000)
    case 'date':
      return now.toISOString().slice(0, 10)
    case 'time':
      return now.toISOString().slice(11, 19)
    default:
      return undefined
  }
}

function resolveValue(raw: string, ctx: Record<string, unknown>, now: Date): unknown {
  const match = raw.match(/^\{\{(.+?)\}\}$/)
  if (match) {
    const ref = match[1].trim()
    if (ref.startsWith('server.')) return resolveServerRef(ref.slice('server.'.length), now)
    if (ref.startsWith('globals.')) return walk(ctx._globals as Record<string, unknown>, ref.slice('globals.'.length))
    if (ref.startsWith('vars.')) return walk(ctx._vars as Record<string, unknown>, ref.slice('vars.'.length))
    if (ref.startsWith('params.')) return walk(ctx._params as Record<string, unknown>, ref.slice('params.'.length))
    const stripped = ref.startsWith('context.')
      ? ref.slice('context.'.length)
      : ref.startsWith('output.')
        ? ref.slice('output.'.length)
        : ref
    return walk(ctx, stripped)
  }
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

type Assignment = { path?: string; key?: string; value: string }

export const setContextExecutor: NodeExecutor = {
  handles: ['SET_CONTEXT'],
  async execute(ctx: ExecContext): Promise<ExecOutcome> {
    const cfg = (ctx.node.config ?? {}) as Record<string, unknown>
    const assignments = Array.isArray(cfg.assignments) ? (cfg.assignments as Assignment[]) : []
    const applied: Record<string, unknown> = {}
    const now = ctx.adapters.clock.now()
    for (const a of assignments) {
      const userPath = (a.path ?? a.key ?? '').trim()
      if (!userPath) continue
      const value = resolveValue(String(a.value ?? ''), ctx.context, now)
      setNestedPath(ctx.context, physicalPath(userPath), value)
      applied[userPath] = value
    }
    ctx.log('SetContextApplied', `set ${Object.keys(applied).length} value(s)`, applied)
    return { kind: 'COMPLETED', output: applied }
  },
}

/**
 * Structural / routing nodes that carry no side effect of their own — the
 * GraphTraverser decides which edges fire. The executor just marks the node
 * complete so traversal can proceed.
 */
export const structuralExecutor: NodeExecutor = {
  handles: [
    'START',
    'END',
    'DECISION_GATE',
    'INCLUSIVE_GATEWAY',
    'PARALLEL_FORK',
    'PARALLEL_JOIN',
    'EVENT_GATEWAY',
    'NOOP',
    'SET_CONTEXT_NOOP',
  ],
  async execute(): Promise<ExecOutcome> {
    return { kind: 'COMPLETED' }
  },
}
