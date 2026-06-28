/**
 * CUSTOM_EXPRESSION — a SAFE structured predicate over the run context (no
 * arbitrary code eval). A control is satisfied when the predicate holds. Pure +
 * unit-tested. (Richer logic can later route through the sandboxed RUN_PYTHON
 * path; this covers the common "context value meets a condition" case safely.)
 */

export interface Predicate {
  /** dot-path into the run context, e.g. "metrics.coverage". */
  path: string
  op?: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'truthy' | 'exists'
  value?: unknown
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj)
}

export function evaluatePredicate(context: Record<string, unknown>, p: Predicate): boolean {
  if (!p || typeof p.path !== 'string' || !p.path) return false
  const actual = getPath(context, p.path)
  switch (p.op ?? 'truthy') {
    case 'exists': return actual !== undefined && actual !== null
    case 'truthy': return Boolean(actual)
    case 'eq': return actual === p.value
    case 'ne': return actual !== p.value
    case 'gt': return typeof actual === 'number' && typeof p.value === 'number' && actual > p.value
    case 'gte': return typeof actual === 'number' && typeof p.value === 'number' && actual >= p.value
    case 'lt': return typeof actual === 'number' && typeof p.value === 'number' && actual < p.value
    case 'lte': return typeof actual === 'number' && typeof p.value === 'number' && actual <= p.value
    default: return false
  }
}
