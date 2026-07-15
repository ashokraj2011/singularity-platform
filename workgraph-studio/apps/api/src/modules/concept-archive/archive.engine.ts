import type { ArchiveAxes } from './archive.schemas'

export type ArchiveCardCandidate = {
  id?: string
  authorType: 'HUMAN' | 'AGENT'
  pinned?: boolean
  compositeScore: number
}

export type ArchiveCellCandidate = {
  killed?: boolean
  elite?: ArchiveCardCandidate | null
}

export type InsertionDecision =
  | { kind: 'PLACE_ELITE'; reason: string }
  | { kind: 'KEEP_ELITE'; reason: string }
  | { kind: 'PROPOSE_SWAP'; reason: string }
  | { kind: 'CELL_KILLED'; reason: string }

/** Stable, human-readable key. Axis order is part of the archive contract. */
export function cellKeyOf(axes: ArchiveAxes, coords: Record<string, string>): string {
  return axes.map(axis => {
    const value = coords[axis.key]
    if (!value || !axis.bins.includes(value)) throw new Error(`Invalid coordinate for axis ${axis.key}`)
    return `${axis.key}=${value}`
  }).join('|')
}

/** Fitness is intentionally transparent: weighted values are compressed to 0..1. */
export function compositeScoreOf(fitness: Record<string, number>, weights: Record<string, number> = {}): number {
  const entries = Object.entries(fitness).filter(([, value]) => Number.isFinite(value))
  if (entries.length === 0) return 0
  const weighted = entries.reduce((sum, [key, value]) => sum + value * (weights[key] ?? 1), 0)
  const denominator = entries.reduce((sum, [key]) => sum + Math.abs(weights[key] ?? 1), 0) || 1
  return (Math.tanh(weighted / denominator) + 1) / 2
}

/**
 * Only agent-v-agent replacement is automatic. Human and pinned cards retain
 * sovereignty and produce a proposal for an explicit human swap decision.
 */
export function considerInsertion(
  cell: ArchiveCellCandidate,
  candidate: ArchiveCardCandidate,
  options: { margin?: number; humanOverride?: boolean } = {},
): InsertionDecision {
  if (cell.killed) return { kind: 'CELL_KILLED', reason: 'The cell is frozen as killed.' }
  if (!cell.elite) return { kind: 'PLACE_ELITE', reason: 'The cell has no current elite.' }
  if (cell.elite.pinned) return { kind: 'KEEP_ELITE', reason: 'Pinned cards cannot be displaced automatically.' }
  if (options.humanOverride) return { kind: 'PLACE_ELITE', reason: 'A human explicitly approved the replacement.' }
  if (candidate.authorType === 'AGENT' && cell.elite.authorType === 'AGENT') {
    const margin = options.margin ?? 0.05
    return candidate.compositeScore > cell.elite.compositeScore + margin
      ? { kind: 'PLACE_ELITE', reason: 'Agent candidate exceeds the configured replacement margin.' }
      : { kind: 'KEEP_ELITE', reason: 'Agent candidate does not exceed the replacement margin.' }
  }
  return { kind: 'PROPOSE_SWAP', reason: 'Human-authored or mixed-authority replacement requires human review.' }
}

export function coverageOf(axes: ArchiveAxes, cells: Array<{ cellKey: string; killed?: boolean; eliteCardId?: string | null }>) {
  const keys: string[] = []
  const walk = (index: number, parts: string[]) => {
    if (index === axes.length) {
      keys.push(parts.join('|'))
      return
    }
    const axis = axes[index]
    for (const bin of axis.bins) walk(index + 1, [...parts, `${axis.key}=${bin}`])
  }
  walk(0, [])
  const byKey = new Map(cells.map(cell => [cell.cellKey, cell]))
  const occupied = keys.filter(key => Boolean(byKey.get(key)?.eliteCardId)).length
  const killed = keys.filter(key => Boolean(byKey.get(key)?.killed)).length
  return {
    totalCells: keys.length,
    occupiedCells: occupied,
    killedCells: killed,
    emptyCells: keys.length - occupied - killed,
    coverage: keys.length ? occupied / keys.length : 0,
    emptyKeys: keys.filter(key => !byKey.get(key)?.eliteCardId && !byKey.get(key)?.killed),
  }
}

export function dedupCheck(candidateText: string, existingTexts: string[], threshold = 0.92) {
  const tokens = (value: string) => new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  const candidate = tokens(candidateText)
  let best = { similarity: 0, index: -1 }
  existingTexts.forEach((text, index) => {
    const other = tokens(text)
    const intersection = [...candidate].filter(token => other.has(token)).length
    const union = new Set([...candidate, ...other]).size || 1
    const similarity = intersection / union
    if (similarity > best.similarity) best = { similarity, index }
  })
  return { duplicate: best.similarity >= threshold, ...best }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i]
    leftNorm += left[i] * left[i]
    rightNorm += right[i] * right[i]
  }
  return leftNorm && rightNorm ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : 0
}

export function dedupCheckWithEmbeddings(
  candidateText: string,
  candidateEmbedding: number[] | undefined,
  existing: Array<{ text: string; embedding?: number[] | null }>,
  options: { cosineThreshold?: number; lexicalThreshold?: number } = {},
) {
  const cosineThreshold = options.cosineThreshold ?? 0.92
  const lexicalThreshold = options.lexicalThreshold ?? 0.5
  let best = { similarity: 0, index: -1, method: 'lexical' as 'lexical' | 'embedding' }
  existing.forEach((item, index) => {
    if (candidateEmbedding && item.embedding?.length === candidateEmbedding.length) {
      const similarity = cosineSimilarity(candidateEmbedding, item.embedding)
      if (similarity > best.similarity) best = { similarity, index, method: 'embedding' }
    }
  })
  if (best.index >= 0 && best.similarity >= cosineThreshold) return { duplicate: true, ...best }
  const lexical = dedupCheck(candidateText, existing.map(item => item.text), lexicalThreshold)
  if (lexical.duplicate && lexical.similarity >= best.similarity) return { duplicate: true, similarity: lexical.similarity, index: lexical.index, method: 'lexical' as const }
  return { duplicate: false, ...best, lexicalThreshold }
}

export type PathfinderCard = {
  id: string
  title: string
  summary: string
  status: string
  cellKey?: string | null
  compositeScore: number
  parentCardIds?: string[]
}

/** Bounded, deterministic archive search. A later embedding provider can feed
 * vectors into deduplication without changing Pathfinder's response contract. */
export function pathfinderRank(query: string, cards: PathfinderCard[], options: { maxResults?: number; maxExpansions?: number } = {}) {
  const maxResults = Math.min(options.maxResults ?? 10, 50)
  const maxExpansions = Math.min(options.maxExpansions ?? 200, 1000)
  const terms = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 1))
  const ranked = cards.slice(0, maxExpansions).map(card => {
    const text = `${card.title} ${card.summary} ${card.cellKey ?? ''}`.toLowerCase()
    const matches = [...terms].filter(term => text.includes(term)).length
    const lexical = terms.size ? matches / terms.size : 0
    const score = lexical * 0.8 + Math.max(0, Math.min(1, card.compositeScore)) * 0.2
    return { card, score, matchedTerms: [...terms].filter(term => text.includes(term)) }
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.card.compositeScore - a.card.compositeScore)
  return { query, expansions: Math.min(cards.length, maxExpansions), results: ranked.slice(0, maxResults) }
}
