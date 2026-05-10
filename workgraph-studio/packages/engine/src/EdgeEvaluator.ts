// ─────────────────────────────────────────────────────────────────────────────
// EdgeEvaluator — pure, no Prisma, safe for browser + server. Lifted from the
// API runtime; behavior identical.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  EngineEdge,
  Branch,
  BranchCondition,
  ConditionOp,
} from './types'

interface LegacyCondition {
  field: string
  op: ConditionOp
  value: unknown
}

// ─── Path resolver ────────────────────────────────────────────────────────────

function walk(root: Record<string, unknown> | undefined, path: string): unknown {
  if (!root) return undefined
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, root)
}

export function resolvePath(ctx: Record<string, unknown>, path: string): unknown {
  if (path.startsWith('globals.')) {
    const sub = path.slice('globals.'.length)
    const globals = (ctx._globals ?? {}) as Record<string, unknown>
    return coerce(walk(globals, sub))
  }

  if (path.startsWith('vars.')) {
    const sub = path.slice('vars.'.length)
    const vars   = (ctx._vars   ?? {}) as Record<string, unknown>
    const params = (ctx._params ?? {}) as Record<string, unknown>
    const fromVars = walk(vars, sub)
    if (fromVars !== undefined) return coerce(fromVars)
    const fromParams = walk(params, sub)
    if (fromParams !== undefined) return coerce(fromParams)
    const defs = (Array.isArray(ctx._paramDefs) ? ctx._paramDefs : []) as Array<{ key: string; defaultValue?: unknown }>
    const def = defs.find(d => d.key === sub)
    return def?.defaultValue !== undefined ? coerce(def.defaultValue) : undefined
  }

  if (path.startsWith('params.')) {
    const key = path.slice('params.'.length)
    const params = (ctx._params ?? {}) as Record<string, unknown>
    const vars   = (ctx._vars   ?? {}) as Record<string, unknown>
    if (params[key] !== undefined) return coerce(params[key])
    if (vars[key]   !== undefined) return coerce(vars[key])
    const defs = (Array.isArray(ctx._paramDefs) ? ctx._paramDefs : []) as Array<{ key: string; defaultValue?: string }>
    const def = defs.find(d => d.key === key)
    return def?.defaultValue !== undefined ? coerce(def.defaultValue) : undefined
  }

  let resolvedPath = path
  if (path.startsWith('context.')) resolvedPath = path.slice('context.'.length)
  if (path.startsWith('output.'))  resolvedPath = path.slice('output.'.length)

  return walk(ctx, resolvedPath)
}

function coerce(v: unknown): unknown {
  if (typeof v !== 'string') return v
  if (v === 'true')  return true
  if (v === 'false') return false
  if (v === 'null')  return null
  const n = Number(v)
  if (!isNaN(n) && v.trim() !== '') return n
  return v
}

function evalCondition(cond: BranchCondition, ctx: Record<string, unknown>): boolean {
  const actual   = resolvePath(ctx, cond.left)
  const expected = coerce(cond.right)

  switch (cond.op) {
    case '==':         return actual === expected
    case '!=':         return actual !== expected
    case '>':          return typeof actual === 'number' && typeof expected === 'number' && actual > expected
    case '>=':         return typeof actual === 'number' && typeof expected === 'number' && actual >= expected
    case '<':          return typeof actual === 'number' && typeof expected === 'number' && actual < expected
    case '<=':         return typeof actual === 'number' && typeof expected === 'number' && actual <= expected
    case 'contains':     return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected)
    case 'not_contains': return typeof actual === 'string' && typeof expected === 'string' && !actual.includes(expected)
    case 'starts_with':  return typeof actual === 'string' && typeof expected === 'string' && actual.startsWith(expected)
    case 'ends_with':    return typeof actual === 'string' && typeof expected === 'string' && actual.endsWith(expected)
    case 'in': {
      const list = typeof cond.right === 'string'
        ? cond.right.split(',').map(s => coerce(s.trim()))
        : []
      return list.includes(actual)
    }
    case 'not_in': {
      const list = typeof cond.right === 'string'
        ? cond.right.split(',').map(s => coerce(s.trim()))
        : []
      return !list.includes(actual)
    }
    case 'exists':     return actual !== undefined && actual !== null
    case 'not_exists': return actual === undefined || actual === null
    default:           return false
  }
}

function evalBranch(branch: Branch, ctx: Record<string, unknown>): boolean {
  if (!branch.conditions || branch.conditions.length === 0) return false
  const logic = branch.logic ?? 'AND'
  if (logic === 'OR') return branch.conditions.some(c => evalCondition(c, ctx))
  return branch.conditions.every(c => evalCondition(c, ctx))
}

export function evaluateEdge(edge: EngineEdge, context: Record<string, unknown>): boolean {
  if (edge.edgeType === 'SEQUENTIAL' || edge.edgeType === 'PARALLEL_SPLIT') return true

  if (edge.edgeType === 'CONDITIONAL') {
    if (!edge.condition) return false
    const raw = edge.condition as Record<string, unknown>

    if (Array.isArray(raw.conditions)) {
      return evalBranch(raw as unknown as Branch, context)
    }

    if (typeof raw.field === 'string') {
      const legacy = raw as unknown as LegacyCondition
      return evalCondition({ left: legacy.field, op: legacy.op as ConditionOp, right: String(legacy.value) }, context)
    }

    return false
  }

  if (edge.edgeType === 'ERROR_BOUNDARY') return false
  return true
}
