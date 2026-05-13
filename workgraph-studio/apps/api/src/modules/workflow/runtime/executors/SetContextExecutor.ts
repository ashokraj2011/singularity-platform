import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'

// KVPair from the UI stores path in `key` field
type Assignment = { path?: string; key?: string; value: string }

function setNestedPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') {
      cur[parts[i]] = {}
    }
    cur = cur[parts[i]] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

/**
 * Map a user-facing variable path to its physical context path.
 *   vars.tier    → _vars.tier
 *   params.tier  → _params.tier (back-compat)
 *   globals.X    → _globals.X
 *   anything else (incl. context.X / output.X) → strip the prefix and write to context root.
 */
function physicalPath(path: string): string {
  if (path.startsWith('vars.'))    return `_vars.${path.slice('vars.'.length)}`
  if (path.startsWith('params.'))  return `_params.${path.slice('params.'.length)}`
  if (path.startsWith('globals.')) return `_globals.${path.slice('globals.'.length)}`
  if (path.startsWith('context.')) return path.slice('context.'.length)
  if (path.startsWith('output.'))  return path.slice('output.'.length)
  return path
}

function walk(root: Record<string, unknown> | undefined, path: string): unknown {
  if (!root) return undefined
  return path.split('.').reduce<unknown>((cur, key) => {
    if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[key]
    return undefined
  }, root)
}

function resolveValue(raw: string, ctx: Record<string, unknown>): unknown {
  // Support {{vars.X}} / {{globals.X}} / {{params.X}} / {{context.path}} interpolation
  const match = raw.match(/^\{\{(.+?)\}\}$/)
  if (match) {
    const ref = match[1].trim()
    if (ref.startsWith('globals.')) return walk(ctx._globals as Record<string, unknown>, ref.slice('globals.'.length))
    if (ref.startsWith('vars.'))    return walk(ctx._vars    as Record<string, unknown>, ref.slice('vars.'.length))
    if (ref.startsWith('params.'))  return walk(ctx._params  as Record<string, unknown>, ref.slice('params.'.length))
    const stripped = ref.startsWith('context.') ? ref.slice('context.'.length)
                   : ref.startsWith('output.')  ? ref.slice('output.'.length)
                   : ref
    return walk(ctx, stripped)
  }
  // Try JSON parse for booleans/numbers/objects; fall back to string
  try { return JSON.parse(raw) } catch { return raw }
}

// SET_CONTEXT merges assignments into the workflow instance context, then
// the runtime auto-advances this node (caller calls advance() immediately after).
export async function activateSetContext(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const assignments: Assignment[] = Array.isArray(cfg.assignments) ? cfg.assignments as Assignment[] : []
  if (assignments.length === 0) return

  const ctx = { ...((instance.context ?? {}) as Record<string, unknown>) }
  for (const entry of assignments) {
    const path = entry.path || entry.key || ''
    if (!path) continue
    setNestedPath(ctx, physicalPath(path), resolveValue(entry.value, ctx))
  }

  await prisma.workflowInstance.update({
    where: { id: instance.id },
    data: { context: ctx as unknown as Prisma.InputJsonValue },
  })
}
