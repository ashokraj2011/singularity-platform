/**
 * Studio Board — Moments service (PR-2). Runs the deterministic detectors over a
 * branch's event stream, then asks the Chronicler (a governed single-turn, so
 * every narration carries a provenance trail) to explain WHY — under the citation
 * rule. A narration that fails the rule (or an unavailable Chronicler) degrades to
 * a deterministic placeholder so the detected moment still shows on the timeline.
 * Humans rename/reject; VISIBLE moments auto-confirm after 72h (computed at read).
 */
import { randomUUID } from 'crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb } from '../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../lib/audit'
import { NotFoundError } from '../../lib/errors'
import { contextFabricClient } from '../../lib/context-fabric/client'
import {
  detectMoments, parseNarrative, extractJson, effectiveMomentStatus, asRecordOf,
  type DetectorEvent, type DetectedMoment, type MomentNarrative,
} from './board-moments'

// Injectable so the detect→narrate flow is unit-testable with a fake (mirrors room-copilot).
export interface ChroniclerLlm {
  narrate(input: { system: string; task: string; traceId: string; boardId: string; actorId: string }): Promise<string>
}
export const defaultChroniclerLlm: ChroniclerLlm = {
  async narrate({ system, task, traceId, boardId, actorId }) {
    const res = await contextFabricClient.executeGovernedTurn({
      trace_id: traceId,
      run_context: {
        board_id: boardId,
        capability_id: process.env.CHRONICLER_CAPABILITY_ID ?? 'studio-chronicler',
        user_id: actorId,
        surface: 'studio-board',
      },
      system_prompt: system,
      task,
      model_overrides: { temperature: 0.4, maxOutputTokens: 1500 },
      limits: { outputTokenBudget: 1500, timeoutSec: 120 },
    })
    return res.finalResponse ?? ''
  },
}

type EventRow = { id: string; eventSeq: bigint; eventType: string; objectIds: Prisma.JsonValue; payload: Prisma.JsonValue; actorId: string | null; createdAt: Date }
type MomentRow = {
  id: string; boardId: string; branchId: string; kind: string; detectorKey: string
  eventSeqStart: bigint; eventSeqEnd: bigint; title: string; narrative: string
  causalChain: Prisma.JsonValue; confidence: number; status: string; editedById: string | null; createdAt: Date
}

function shapeMoment(m: MomentRow, nowMs = Date.now()) {
  return {
    id: m.id, boardId: m.boardId, branchId: m.branchId, kind: m.kind, detectorKey: m.detectorKey,
    eventSeqStart: Number(m.eventSeqStart), eventSeqEnd: Number(m.eventSeqEnd),
    title: m.title, narrative: m.narrative, causalChain: m.causalChain, confidence: m.confidence,
    status: effectiveMomentStatus(m.status, m.createdAt.getTime(), nowMs), rawStatus: m.status,
    editedById: m.editedById, createdAt: m.createdAt,
  }
}

async function loadBranch(boardId: string, branchName: string) {
  const board = await prisma.board.findUnique({ where: { id: boardId }, select: { id: true } })
  if (!board) throw new NotFoundError('Board', boardId)
  const branch = await prisma.boardBranch.findFirst({ where: { boardId, name: branchName } })
  if (!branch) throw new NotFoundError('BoardBranch', `${boardId}/${branchName}`)
  return branch
}

// ── Detect + narrate ──────────────────────────────────────────────────────────
export async function detectAndNarrate(
  boardId: string, branchName: string, actorId: string,
  llm: ChroniclerLlm = defaultChroniclerLlm,
  cfg: { burstMinCount?: number; stallFactor?: number } = {},
) {
  const branch = await loadBranch(boardId, branchName)
  // Only inspect events past the last moment we already recorded, so re-running is safe.
  const lastMoment = await prisma.boardMoment.findFirst({ where: { branchId: branch.id }, orderBy: { eventSeqEnd: 'desc' } })
  const sinceSeq = lastMoment ? Number(lastMoment.eventSeqEnd) : 0
  const rows = (await prisma.boardEvent.findMany({
    where: { branchId: branch.id, eventSeq: { gt: BigInt(sinceSeq) } }, orderBy: { eventSeq: 'asc' }, take: 5000,
  })) as EventRow[]

  const detEvents: DetectorEvent[] = rows.map((r) => ({
    id: r.id, eventSeq: Number(r.eventSeq), eventType: r.eventType,
    objectIds: Array.isArray(r.objectIds) ? (r.objectIds as string[]) : [],
    payload: asRecordOf(r.payload), actorId: r.actorId, createdAt: r.createdAt.getTime(),
  }))
  const detected = detectMoments(detEvents, cfg)

  const tenantId = currentTenantIdForDb() ?? undefined
  const created: ReturnType<typeof shapeMoment>[] = []
  for (const d of detected) {
    const windowRows = rows.filter((r) => Number(r.eventSeq) >= d.eventSeqStart && Number(r.eventSeq) <= d.eventSeqEnd)
    const narration = await narrateOne(d, windowRows, actorId, boardId, llm, lastMoment?.narrative ?? undefined)
    const moment = (await prisma.boardMoment.create({
      data: {
        boardId, branchId: branch.id, kind: d.kind, detectorKey: d.detectorKey,
        eventSeqStart: BigInt(d.eventSeqStart), eventSeqEnd: BigInt(d.eventSeqEnd),
        title: narration.title, narrative: narration.narrative,
        causalChain: narration.causalChain as unknown as Prisma.InputJsonValue, confidence: narration.confidence,
        status: 'VISIBLE', tenantId,
      },
    })) as MomentRow
    await logEvent('BoardMomentMarked', 'BoardMoment', moment.id, actorId, { boardId, kind: d.kind, detectorKey: d.detectorKey })
    await publishOutbox('BoardMoment', moment.id, 'BoardMomentMarked', { boardId, branch: branchName, kind: d.kind })
    created.push(shapeMoment(moment))
  }
  return { detected: detected.length, created }
}

async function narrateOne(
  d: DetectedMoment, windowRows: EventRow[], actorId: string, boardId: string,
  llm: ChroniclerLlm, prev: string | undefined,
): Promise<MomentNarrative> {
  try {
    const traceId = `studio-chronicler-${boardId}-${randomUUID()}`
    const text = await llm.narrate({ system: chroniclerSystemPrompt(), task: buildNarrateTask(d, windowRows, prev), traceId, boardId, actorId })
    return parseNarrative(extractJson(text))
  } catch {
    return fallbackNarrative(d, windowRows)
  }
}

// Keep the deterministically-detected moment even when Chronicler is unavailable
// or its narrative fails the citation rule — a confidence-0 placeholder that still
// cites the window's events, so the timeline shows THAT something happened.
function fallbackNarrative(d: DetectedMoment, windowRows: EventRow[]): MomentNarrative {
  const refs = windowRows.slice(0, 5).map((r) => r.id)
  const title = fallbackTitle(d)
  return {
    title,
    narrative: `${title}. Detected deterministically by the ${d.detectorKey} detector; narration pending.`,
    causalChain: [{ assertion: title, eventRefs: refs.length ? refs : [`seq:${d.eventSeqStart}`], claimRefs: [] }],
    confidence: 0,
  }
}
function fallbackTitle(d: DetectedMoment): string {
  switch (d.detectorKey) {
    case 'KILL': return 'An option was killed'
    case 'BURST': return `Idea burst (${Number(d.signal.count ?? 0)} new)`
    case 'STALL': return 'The room went quiet'
    case 'CONSENSUS_FLIP': return 'Consensus flipped'
    case 'PHASE': return 'Phase boundary'
    case 'INGESTION': return 'A source was added'
    default: return 'A moment'
  }
}

function chroniclerSystemPrompt(): string {
  return [
    'You are the Chronicler, a studio-board historian. You do NOT decide what happened — a deterministic',
    'detector already found that a moment occurred. Your only job is to explain WHY the board reached this',
    'state, causally (not descriptively), citing evidence.',
    'Return STRICT JSON: { "title": string(<=80), "narrative": string(<=1200), "causalChain": [{ "assertion":',
    'string(<=240), "eventRefs": string[] (>=1 of the event ids given, REQUIRED), "claimRefs": string[] }],',
    '"confidence": number 0..1 }.',
    'HARD RULE: every causalChain assertion MUST cite at least one eventRef from the events provided. An',
    'assertion with no citation is invalid. Prefer "Smita killed the vendor region (ev: 4812), two minutes',
    "after the licence-cost challenge (ev: 4788)\" over vague summaries. Output JSON only.",
  ].join(' ')
}

function buildNarrateTask(d: DetectedMoment, windowRows: EventRow[], prev: string | undefined): string {
  const lines = windowRows.map((r) => {
    const p = asRecordOf(r.payload)
    const summary = Object.keys(p).length ? ` ${JSON.stringify(p).slice(0, 160)}` : ''
    return `- [${r.id}] seq ${Number(r.eventSeq)} ${r.eventType} by ${r.actorId ?? 'system'}${summary}`
  }).join('\n')
  return [
    `A ${d.detectorKey} detector fired a ${d.kind} moment over events ${d.eventSeqStart}..${d.eventSeqEnd}.`,
    `Signal: ${JSON.stringify(d.signal)}`,
    prev ? `Previous moment (for continuity): ${prev}` : '',
    'Events in the window (cite these ids in eventRefs):',
    lines || '(no events)',
    'Explain WHY the board reached this state. Every causalChain assertion MUST cite >=1 of the event ids above.',
  ].filter(Boolean).join('\n')
}

// ── Read / human control ──────────────────────────────────────────────────────
export async function listMoments(boardId: string, branchName: string) {
  const branch = await loadBranch(boardId, branchName)
  const moments = (await prisma.boardMoment.findMany({ where: { branchId: branch.id }, orderBy: { eventSeqStart: 'asc' } })) as MomentRow[]
  const now = Date.now()
  return { items: moments.map((m) => shapeMoment(m, now)) }
}

async function loadMoment(boardId: string, momentId: string): Promise<MomentRow> {
  const m = (await prisma.boardMoment.findFirst({ where: { id: momentId, boardId } })) as MomentRow | null
  if (!m) throw new NotFoundError('BoardMoment', momentId)
  return m
}

export async function editMoment(boardId: string, momentId: string, input: { title?: string; narrative?: string }, userId: string) {
  await loadMoment(boardId, momentId)
  const updated = (await prisma.boardMoment.update({
    where: { id: momentId },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.narrative !== undefined ? { narrative: input.narrative } : {}),
      status: 'EDITED', editedById: userId,
    },
  })) as MomentRow
  await logEvent('BoardMomentEdited', 'BoardMoment', momentId, userId, { boardId })
  return shapeMoment(updated)
}

export async function rejectMoment(boardId: string, momentId: string, userId: string) {
  await loadMoment(boardId, momentId)
  const updated = (await prisma.boardMoment.update({
    where: { id: momentId }, data: { status: 'REJECTED', editedById: userId },
  })) as MomentRow
  await logEvent('BoardMomentRejected', 'BoardMoment', momentId, userId, { boardId })
  return shapeMoment(updated)
}
