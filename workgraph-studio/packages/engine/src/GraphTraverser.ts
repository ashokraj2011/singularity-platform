// ─────────────────────────────────────────────────────────────────────────────
// GraphTraverser — pure strategy table that picks which outgoing edges should
// fire after a node completes. No DB. Caller hydrates target nodes.
// ─────────────────────────────────────────────────────────────────────────────

import type { EngineEdge, EngineNodeDef } from './types'
import { evaluateEdge } from './EdgeEvaluator'

interface EdgeWithMeta {
  edge: EngineEdge
  priority: number
  isDefault: boolean
}

function readEdgeMeta(edges: EngineEdge[]): EdgeWithMeta[] {
  return edges.map((edge, idx) => {
    const cond = (edge.condition ?? {}) as Record<string, unknown>
    return {
      edge,
      priority: typeof cond.priority === 'number' ? cond.priority : idx,
      isDefault: cond.isDefault === true,
    }
  })
}

function pickXor(edges: EdgeWithMeta[], context: Record<string, unknown>): EdgeWithMeta | null {
  const sorted = [...edges].sort((a, b) =>
    a.priority !== b.priority ? a.priority - b.priority : a.edge.id.localeCompare(b.edge.id),
  )
  for (const m of sorted) {
    if (m.isDefault) continue
    if (evaluateEdge(m.edge, context)) return m
  }
  return sorted.find(m => m.isDefault) ?? null
}

function pickInclusive(edges: EdgeWithMeta[], context: Record<string, unknown>): EdgeWithMeta[] {
  const matched = edges.filter(m => !m.isDefault && evaluateEdge(m.edge, context))
  if (matched.length > 0) return matched
  const def = edges.find(m => m.isDefault)
  return def ? [def] : []
}

function pickAllMatching(edges: EdgeWithMeta[], context: Record<string, unknown>): EdgeWithMeta[] {
  const matched = edges.filter(m => !m.isDefault && evaluateEdge(m.edge, context))
  if (matched.length > 0) return matched
  const def = edges.find(m => m.isDefault)
  return def ? [def] : []
}

export interface ResolveResult {
  chosenEdges: EngineEdge[]
  joinEdges: EngineEdge[]      // PARALLEL_JOIN edges that evaluated truthy — caller increments counter
  pathStall: boolean
}

/**
 * Returns which edges should fire from `completedNode`. Caller is responsible
 * for resolving the target nodes and incrementing PARALLEL_JOIN counters.
 */
export function resolveNextEdges(
  completedNode: EngineNodeDef,
  outgoing: EngineEdge[],
  context: Record<string, unknown>,
): ResolveResult {
  const joinEdges  = outgoing.filter(e => e.edgeType === 'PARALLEL_JOIN' && evaluateEdge(e, context))
  const otherEdges = outgoing.filter(e => e.edgeType !== 'PARALLEL_JOIN' && e.edgeType !== 'ERROR_BOUNDARY')

  const meta = readEdgeMeta(otherEdges)
  let chosen: EdgeWithMeta[] = []
  let pathStall = false

  if (completedNode.nodeType === 'DECISION_GATE') {
    const pick = pickXor(meta, context)
    if (pick) chosen = [pick]
    else if (meta.length > 0) pathStall = true
  } else if (completedNode.nodeType === 'INCLUSIVE_GATEWAY') {
    chosen = pickInclusive(meta, context)
    if (chosen.length === 0 && meta.length > 0) pathStall = true
  } else {
    chosen = pickAllMatching(meta, context)
  }

  return {
    chosenEdges: chosen.map(m => m.edge),
    joinEdges,
    pathStall,
  }
}

/**
 * Read-only XOR/INCLUSIVE preview — used by the DECISION_GATE modal in the
 * browser player to show "which branch will fire under the current context"
 * without mutating run state.
 */
export interface BranchPreview {
  edge: EngineEdge
  isDefault: boolean
  matched: boolean
  willFire: boolean
}

export function previewBranches(
  sourceNode: EngineNodeDef,
  outgoing: EngineEdge[],
  context: Record<string, unknown>,
): BranchPreview[] {
  const conditional = outgoing.filter(
    e => e.edgeType !== 'PARALLEL_JOIN' && e.edgeType !== 'ERROR_BOUNDARY',
  )
  const meta = readEdgeMeta(conditional)
  const result = resolveNextEdges(sourceNode, conditional, context)
  const firingIds = new Set(result.chosenEdges.map(e => e.id))

  return meta.map(m => ({
    edge: m.edge,
    isDefault: m.isDefault,
    matched: !m.isDefault && evaluateEdge(m.edge, context),
    willFire: firingIds.has(m.edge.id),
  }))
}
