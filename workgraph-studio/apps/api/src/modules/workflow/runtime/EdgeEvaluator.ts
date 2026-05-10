import type { WorkflowEdge } from '@prisma/client'

// ─── Condition types ─────────────────────────────────────────────────────────
//
// New format (multi-condition branch):
//   { label?, logic: 'AND'|'OR', conditions: [{ id?, left, op, right }] }
//
// Legacy format (single condition):
//   { field: "output.score", op: ">", value: 0.8 }
//
// Left-side path prefixes:
//   globals.X   → context._globals.X  (team-scoped read-only global)
//   vars.X      → context._vars.X     (template-scoped variable; falls back to _params)
//   params.X    → context._params.X   (legacy: workflow runtime parameter; same as vars.X)
//   context.X   → context.X           (raw context path)
//   output.X    → context.X           (alias; outputs are merged into context)
//   X           → context.X           (no prefix = context)
//
// No eval() — safe field-path + operator comparison only.

type ConditionOp =
  | '==' | '!=' | '>' | '>=' | '<' | '<='
  | 'contains' | 'not_contains'
  | 'in' | 'not_in'
  | 'exists' | 'not_exists'
  | 'starts_with' | 'ends_with'

export interface BranchCondition {
  id?: string
  left: string        // e.g. "params.tier", "context.score", "output.status"
  op: ConditionOp
  right: string       // always stored as string; coerced at eval time
}

export interface Branch {
  label?: string
  logic?: 'AND' | 'OR'          // default AND
  conditions: BranchCondition[]
}

// Legacy single-condition format
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

function resolvePath(ctx: Record<string, unknown>, path: string): unknown {
  // ── globals.X — team-scoped read-only constants
  if (path.startsWith('globals.')) {
    const sub = path.slice('globals.'.length)
    const globals = (ctx._globals ?? {}) as Record<string, unknown>
    return coerce(walk(globals, sub))
  }

  // ── vars.X — template-scoped variables (with fallback chain)
  if (path.startsWith('vars.')) {
    const sub = path.slice('vars.'.length)
    const vars   = (ctx._vars   ?? {}) as Record<string, unknown>
    const params = (ctx._params ?? {}) as Record<string, unknown>
    const fromVars   = walk(vars,   sub)
    if (fromVars   !== undefined) return coerce(fromVars)
    // Fall back to legacy _params (back-compat)
    const fromParams = walk(params, sub)
    if (fromParams !== undefined) return coerce(fromParams)
    // Then template variable defaults if registered
    const defs = (Array.isArray(ctx._paramDefs) ? ctx._paramDefs : []) as Array<{ key: string; defaultValue?: unknown }>
    const def = defs.find(d => d.key === sub)
    return def?.defaultValue !== undefined ? coerce(def.defaultValue) : undefined
  }

  // ── params.X — back-compat alias of vars
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

  // ── context.X / output.X / bare X
  let resolvedPath = path
  if (path.startsWith('context.')) resolvedPath = path.slice('context.'.length)
  if (path.startsWith('output.'))  resolvedPath = path.slice('output.'.length)

  return walk(ctx, resolvedPath)
}

// ─── Type coercion ────────────────────────────────────────────────────────────

function coerce(v: unknown): unknown {
  if (typeof v !== 'string') return v
  if (v === 'true')  return true
  if (v === 'false') return false
  if (v === 'null')  return null
  const n = Number(v)
  if (!isNaN(n) && v.trim() !== '') return n
  return v
}

// ─── Single-condition evaluator ───────────────────────────────────────────────

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
      // right side can be comma-separated list
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

// ─── Branch evaluator ─────────────────────────────────────────────────────────

function evalBranch(branch: Branch, ctx: Record<string, unknown>): boolean {
  if (!branch.conditions || branch.conditions.length === 0) return false
  const logic = branch.logic ?? 'AND'
  if (logic === 'OR') {
    return branch.conditions.some(c => evalCondition(c, ctx))
  }
  return branch.conditions.every(c => evalCondition(c, ctx))
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function evaluateEdge(edge: WorkflowEdge, context: Record<string, unknown>): boolean {
  if (edge.edgeType === 'SEQUENTIAL' || edge.edgeType === 'PARALLEL_SPLIT') {
    return true
  }

  if (edge.edgeType === 'CONDITIONAL') {
    if (!edge.condition) return false
    const raw = edge.condition as unknown as Record<string, unknown>

    // New multi-condition branch format
    if (Array.isArray(raw.conditions)) {
      return evalBranch(raw as unknown as Branch, context)
    }

    // Legacy single-condition format: { field, op, value }
    if (typeof raw.field === 'string') {
      const legacy = raw as unknown as LegacyCondition
      return evalCondition({ left: legacy.field, op: legacy.op as ConditionOp, right: String(legacy.value) }, context)
    }

    return false
  }

  // ERROR_BOUNDARY is followed only via failNode(), never on normal advance
  if (edge.edgeType === 'ERROR_BOUNDARY') return false

  // PARALLEL_JOIN handled by GraphTraverser
  return true
}
