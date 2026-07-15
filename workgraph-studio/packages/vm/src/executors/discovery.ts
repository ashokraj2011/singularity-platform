// ─────────────────────────────────────────────────────────────────────────────
// DISCOVERY executor (ADR 0006 §6) — the portable "reduce the unknowns" node.
//
// Online: asks the discovery adapter to elicit questions/assumptions (the
// platform runs the governed CF/MCP loop), then gates — if any blocking
// question is still OPEN the node BLOCKS (parks) until answered; otherwise it
// COMPLETES, threading the questions/assumptions into the run context.
//
// Offline: elicitation is impossible, so unknowns cannot be reduced. If the node
// carries any blocking seed question it BLOCKS (fail-closed on unknowns); with
// no blocking questions it COMPLETES (nothing gates). This mirrors the
// service-bound degrade pattern (HUMAN_TASK / GOVERNANCE_GATE).
// ─────────────────────────────────────────────────────────────────────────────

import type {
  ExecContext,
  ExecOutcome,
  NodeExecutor,
  DiscoveryQuestionSpec,
} from '../types.js'
import { OfflineError } from '../types.js'

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/** Read configured seed questions from node config (tolerant of shapes). */
export function readSeedQuestions(cfg: Record<string, unknown>): DiscoveryQuestionSpec[] {
  const raw = Array.isArray(cfg.questions) ? cfg.questions : []
  const out: DiscoveryQuestionSpec[] = []
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const rec = q as Record<string, unknown>
    const text = asString(rec.text).trim()
    if (!text) continue
    // `required` (workbench semantics) or `blocking` both gate.
    const blocking = rec.blocking === true || rec.required === true
    out.push({
      id: typeof rec.id === 'string' ? rec.id : typeof rec.questionId === 'string' ? rec.questionId : undefined,
      text,
      blocking,
      status: rec.status === 'ANSWERED' || rec.status === 'DISMISSED' ? rec.status : 'OPEN',
      answer: typeof rec.answer === 'string' ? rec.answer : undefined,
    })
  }
  return out
}

/** The unified gate: any blocking + OPEN question parks the node. */
export function hasBlockingOpen(questions: DiscoveryQuestionSpec[]): boolean {
  return questions.some(q => q.blocking && (q.status ?? 'OPEN') === 'OPEN')
}

export const discoveryExecutor: NodeExecutor = {
  handles: ['DISCOVERY'],
  async execute(ctx: ExecContext): Promise<ExecOutcome> {
    const cfg = (ctx.node.config ?? {}) as Record<string, unknown>
    const seedQuestions = readSeedQuestions(cfg)
    const scopeId = asString(cfg.scopeId) || ctx.runId

    try {
      const result = await ctx.adapters.discovery.elicit({
        runId: ctx.runId,
        nodeId: ctx.node.id,
        scopeId,
        hint: asString(cfg.hint) || undefined,
        context: asString(cfg.context) || undefined,
        seedQuestions,
      })
      const questions = result.questions.length > 0 ? result.questions : seedQuestions
      await ctx.adapters.audit.emit({
        runId: ctx.runId,
        nodeId: ctx.node.id,
        kind: 'DiscoveryElicited',
        payload: { questions: questions.length, assumptions: result.assumptions.length },
      })
      if (hasBlockingOpen(questions)) {
        ctx.log('DiscoveryBlocked', 'blocking questions still open — parking node')
        return { kind: 'BLOCKED', reason: 'awaiting answers to blocking discovery questions' }
      }
      return {
        kind: 'COMPLETED',
        output: { questions, assumptions: result.assumptions, status: 'RESOLVED' },
      }
    } catch (err) {
      if (err instanceof OfflineError) {
        if (hasBlockingOpen(seedQuestions)) {
          ctx.log('DiscoveryDeferred', 'offline with blocking unknowns — parking node')
          return { kind: 'BLOCKED', reason: 'discovery offline with unresolved blocking questions' }
        }
        ctx.log('DiscoverySkipped', 'offline but no blocking unknowns — passing through')
        return {
          kind: 'COMPLETED',
          output: { questions: seedQuestions, assumptions: [], status: 'RESOLVED', degraded: 'offline' },
        }
      }
      throw err
    }
  },
}
