/**
 * Studio Board — Moments: the pure detect + narrate-contract core (PR-2).
 *
 * Two-stage by design: cheap DETERMINISTIC detectors decide that *something*
 * happened (never the LLM); the Chronicler governed turn only explains *why*,
 * under a hard citation rule. Everything here is pure (no I/O) so the
 * load-bearing quality mechanism — the detectors and the citation rule — is
 * unit-tested without the stack or a model.
 */
import { z } from 'zod'

// ── Detector input / output ───────────────────────────────────────────────────
export interface DetectorEvent {
  id?: string
  eventSeq: number
  eventType: string
  objectIds: string[]
  payload: Record<string, unknown>
  actorId?: string | null
  createdAt: number // epoch ms
}
export interface DetectedMoment {
  kind: string // DECISION | CONSENSUS_FLIP | BURST | STALL | PHASE | SOURCE_ADDED
  detectorKey: string // KILL | CONSENSUS_FLIP | BURST | STALL | PHASE | INGESTION
  eventSeqStart: number
  eventSeqEnd: number
  signal: Record<string, unknown> // detector-specific context handed to the narrator
}

export function asRecordOf(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

export const BURST_WINDOW_MS = 5 * 60 * 1000

/** A kill/archive is a decision moment — one per kill event. */
export function detectKills(events: DetectorEvent[]): DetectedMoment[] {
  return events
    .filter((e) => e.eventType === 'OBJECT_DELETED' || (e.eventType === 'OBJECT_EDITED' && e.payload.kind === 'kill'))
    .map((e) => ({ kind: 'DECISION', detectorKey: 'KILL', eventSeqStart: e.eventSeq, eventSeqEnd: e.eventSeq, signal: { objectIds: e.objectIds, actorId: e.actorId ?? null } }))
}

/** Idea burst: >= minCount OBJECT_CREATED within a sliding 5-min window. */
export function detectBursts(events: DetectorEvent[], minCount = 5): DetectedMoment[] {
  const creates = events.filter((e) => e.eventType === 'OBJECT_CREATED').sort((a, b) => a.eventSeq - b.eventSeq)
  const out: DetectedMoment[] = []
  let i = 0
  while (i < creates.length) {
    const start = creates[i]!
    let j = i
    while (j < creates.length && creates[j]!.createdAt - start.createdAt <= BURST_WINDOW_MS) j++
    const count = j - i
    if (count >= minCount) {
      out.push({ kind: 'BURST', detectorKey: 'BURST', eventSeqStart: start.eventSeq, eventSeqEnd: creates[j - 1]!.eventSeq, signal: { count } })
      i = j // skip past this burst so windows don't overlap into duplicates
    } else {
      i++
    }
  }
  return out
}

/** Stall: an inter-event gap greater than `factor`x the median gap. */
export function detectStalls(events: DetectorEvent[], factor = 3): DetectedMoment[] {
  const sorted = [...events].sort((a, b) => a.eventSeq - b.eventSeq)
  if (sorted.length < 3) return []
  const gaps: number[] = []
  for (let k = 1; k < sorted.length; k++) gaps.push(sorted[k]!.createdAt - sorted[k - 1]!.createdAt)
  const med = median(gaps)
  if (med <= 0) return []
  const out: DetectedMoment[] = []
  for (let k = 1; k < sorted.length; k++) {
    const gap = sorted[k]!.createdAt - sorted[k - 1]!.createdAt
    if (gap > factor * med) {
      out.push({ kind: 'STALL', detectorKey: 'STALL', eventSeqStart: sorted[k - 1]!.eventSeq, eventSeqEnd: sorted[k]!.eventSeq, signal: { gapMs: gap, medianMs: med } })
    }
  }
  return out
}

/** Consensus flip: the leading VOTE_CAST target changes after >= 3 total votes. */
export function detectConsensusFlips(events: DetectorEvent[]): DetectedMoment[] {
  const votes = events.filter((e) => e.eventType === 'VOTE_CAST').sort((a, b) => a.eventSeq - b.eventSeq)
  const tally = new Map<string, number>()
  let leader: string | null = null
  let total = 0
  const out: DetectedMoment[] = []
  for (const v of votes) {
    const target = typeof v.payload.target === 'string' ? v.payload.target : (v.objectIds[0] ?? null)
    if (!target) continue
    tally.set(target, (tally.get(target) ?? 0) + 1)
    total++
    const next = argmax(tally)
    if (total >= 3 && leader !== null && next !== leader) {
      out.push({ kind: 'CONSENSUS_FLIP', detectorKey: 'CONSENSUS_FLIP', eventSeqStart: v.eventSeq, eventSeqEnd: v.eventSeq, signal: { from: leader, to: next, totalVotes: total } })
    }
    leader = next
  }
  return out
}

/** Ritual phase boundaries. */
export function detectPhases(events: DetectorEvent[]): DetectedMoment[] {
  return events
    .filter((e) => e.eventType === 'RITUAL_PHASE_STARTED' || e.eventType === 'RITUAL_PHASE_ENDED')
    .map((e) => ({ kind: 'PHASE', detectorKey: 'PHASE', eventSeqStart: e.eventSeq, eventSeqEnd: e.eventSeq, signal: { phase: e.payload.phase ?? null, boundary: e.eventType } }))
}

/** An ingested artifact settled onto the board. */
export function detectIngestions(events: DetectorEvent[]): DetectedMoment[] {
  return events
    .filter((e) => e.eventType === 'INGESTION_COMPLETED')
    .map((e) => ({ kind: 'SOURCE_ADDED', detectorKey: 'INGESTION', eventSeqStart: e.eventSeq, eventSeqEnd: e.eventSeq, signal: { objectIds: e.objectIds, artifactId: e.payload.artifactId ?? null } }))
}

/** Run every deterministic detector over a window, sorted by start seq. */
export function detectMoments(events: DetectorEvent[], cfg: { burstMinCount?: number; stallFactor?: number } = {}): DetectedMoment[] {
  return [
    ...detectKills(events),
    ...detectBursts(events, cfg.burstMinCount ?? 5),
    ...detectStalls(events, cfg.stallFactor ?? 3),
    ...detectConsensusFlips(events),
    ...detectPhases(events),
    ...detectIngestions(events),
  ].sort((a, b) => a.eventSeqStart - b.eventSeqStart)
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}
function argmax(m: Map<string, number>): string | null {
  let best: string | null = null
  let bestN = -1
  for (const [k, n] of m) if (n > bestN) { bestN = n; best = k }
  return best
}

// ── Narration contract (Chronicler's governed-turn output) ────────────────────
// The citation rule IS the quality mechanism: every causalChain assertion must
// cite >= 1 BoardEvent id, so a narrative that can't ground itself is rejected at
// parse time rather than stored as vibes.
export const momentNarrativeSchema = z.object({
  title: z.string().trim().min(1).max(80),
  narrative: z.string().trim().min(1).max(1200),
  causalChain: z.array(z.object({
    assertion: z.string().trim().min(1).max(240),
    eventRefs: z.array(z.string()).min(1), // REQUIRED — the citation rule
    claimRefs: z.array(z.string()).default([]),
  })).min(1),
  confidence: z.number().min(0).max(1),
})
export type MomentNarrative = z.infer<typeof momentNarrativeSchema>

/** Pull the first JSON object out of a model reply (handles ```json fences). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced?.[1] ?? text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) throw new Error('No JSON object found in narration response')
  return JSON.parse(body.slice(start, end + 1))
}

/** Parse + enforce the citation rule. Throws on any uncited assertion. */
export function parseNarrative(raw: unknown): MomentNarrative {
  return momentNarrativeSchema.parse(raw)
}

// ── Moment status ─────────────────────────────────────────────────────────────
// A moment is a low-stakes proposal with auto-visibility: it appears immediately
// (VISIBLE, flagged agent-authored) and silently confirms after 72h without
// objection. Effective status is computed at read; EDITED/REJECTED are sticky.
export const MOMENT_AUTOCONFIRM_MS = 72 * 60 * 60 * 1000
export function effectiveMomentStatus(status: string, createdAtMs: number, nowMs: number): string {
  if (status === 'VISIBLE' && nowMs - createdAtMs >= MOMENT_AUTOCONFIRM_MS) return 'CONFIRMED'
  return status
}
