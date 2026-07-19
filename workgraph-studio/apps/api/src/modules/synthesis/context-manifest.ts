/**
 * Synthesis Studio — context manifest pure core (R1A 1.3). A manifest is the immutable
 * "what the agent will read" record built before every material turn: the frozen resolved
 * snapshots of a thread's context references, a token/cost estimate, pinned-vs-following
 * counts, and a canonical hash. PURE (no DB/clock/HTTP) so it unit-tests directly.
 */
import { hashPayload } from '../../lib/snapshot'

export interface ResolvedRefSnapshot {
  entityType: string
  entityId: string
  referenceMode: 'FOLLOW_LATEST' | 'PINNED'
  exists: boolean
  label?: string
  versionId?: string | null
  contentHash?: string | null
  classification?: string | null
  /** has versionId + contentHash → can be pinned reliably (federated entities often can't) */
  pinnable: boolean
  error?: string
}

// Rough heuristic: ~4 chars/token over the label, plus a base cost per included ref.
// It is an ESTIMATE shown to the operator, not a billing figure — kept deliberately simple.
export const BASE_TOKENS_PER_REF = 20
export function estimateTokensFor(item: ResolvedRefSnapshot): number {
  return BASE_TOKENS_PER_REF + Math.ceil((item.label ?? '').length / 4)
}

export interface ManifestSummary {
  tokenEstimate: number
  pinnedCount: number
  followingCount: number
  unresolvedCount: number
  /** PINNED requested but the entity carries no versionId+contentHash → the manifest flags it */
  cannotPinCount: number
  classificationSummary: Record<string, number>
}

export function summarizeManifest(items: ResolvedRefSnapshot[]): ManifestSummary {
  const classificationSummary: Record<string, number> = {}
  let tokenEstimate = 0
  let pinnedCount = 0
  let followingCount = 0
  let unresolvedCount = 0
  let cannotPinCount = 0
  for (const it of items) {
    tokenEstimate += estimateTokensFor(it)
    if (it.referenceMode === 'PINNED') {
      pinnedCount++
      if (!it.pinnable) cannotPinCount++
    } else {
      followingCount++
    }
    if (!it.exists) unresolvedCount++
    const cls = it.classification ?? 'unclassified'
    classificationSummary[cls] = (classificationSummary[cls] ?? 0) + 1
  }
  return { tokenEstimate, pinnedCount, followingCount, unresolvedCount, cannotPinCount, classificationSummary }
}

/**
 * The immutable per-run hash — canonical over the resolved items, order-independent
 * (sorted by entity) so re-resolving the same refs in any order yields the same hash.
 */
export function hashManifest(items: ResolvedRefSnapshot[]): string {
  const sorted = [...items].sort((a, b) =>
    a.entityType.localeCompare(b.entityType) ||
    a.entityId.localeCompare(b.entityId) ||
    a.referenceMode.localeCompare(b.referenceMode),
  )
  return hashPayload(sorted)
}
