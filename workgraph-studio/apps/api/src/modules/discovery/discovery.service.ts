/**
 * DiscoveryService — the unified "reduce the unknowns" capability (ADR 0006).
 *
 * One service consolidates the three legacy mechanisms (workbench stage
 * questions, work-item clarifications, LLM open-questions). It can *actively*
 * elicit: assemble scope context → run a governed model turn (Context Fabric /
 * Copilot) → optionally run a read-only MCP research tool → persist proposed
 * Questions + Assumptions → recompute the session's gate.
 *
 * All external effects go through injectable ports (see discovery.types.ts) so
 * the elicit loop is unit-testable with in-memory fakes.
 */
import { ValidationError } from '../../lib/errors'
import type {
  DiscoveryBudget,
  DiscoveryDeps,
  DiscoveryQuestionRecord,
  DiscoverySessionStatus,
  DiscoverySessionWithChildren,
  ElicitInput,
  ElicitResult,
} from './discovery.types'
import { DEFAULT_BUDGET } from './discovery.types'

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

/**
 * The unified gate. A session is BLOCKED while any *blocking* question is still
 * OPEN; otherwise it is RESOLVED once nothing is OPEN, and OPEN while
 * non-blocking questions remain. ABANDONED is terminal and never recomputed.
 */
export function computeSessionStatus(
  current: DiscoverySessionStatus,
  questions: Array<Pick<DiscoveryQuestionRecord, 'blocking' | 'status'>>,
): DiscoverySessionStatus {
  if (current === 'ABANDONED') return 'ABANDONED'
  const open = questions.filter(q => q.status === 'OPEN')
  if (open.some(q => q.blocking)) return 'BLOCKED'
  if (open.length > 0) return 'OPEN'
  return 'RESOLVED'
}

export function mergeBudget(base: DiscoveryBudget | null | undefined, override?: Partial<DiscoveryBudget>): DiscoveryBudget {
  return { ...DEFAULT_BUDGET, ...(base ?? {}), ...(override ?? {}) }
}

export function budgetExhausted(b: DiscoveryBudget): { turns: boolean; tokens: boolean; tools: boolean } {
  return {
    turns: b.turns >= b.maxTurns,
    tokens: b.inputTokens >= b.maxInputTokens || b.outputTokens >= b.maxOutputTokens,
    tools: b.toolCalls >= b.maxToolCalls,
  }
}

interface ParsedElicitation {
  questions: Array<{
    text: string
    kind?: DiscoveryQuestionRecord['kind']
    blocking?: boolean
    options?: unknown
    proposedAnswer?: string | null
    confidence?: number | null
  }>
  assumptions: Array<{ text: string; confidence?: number; evidenceRef?: unknown }>
}

/**
 * Tolerant parser for the model's JSON payload. Accepts a bare object, a
 * ```json fenced block, or an object embedded in prose. Returns empty lists
 * (never throws) so a malformed turn degrades gracefully into a note.
 */
export function parseElicitation(text: string): ParsedElicitation | null {
  const empty: ParsedElicitation = { questions: [], assumptions: [] }
  if (!text || !text.trim()) return null
  const candidates: string[] = []
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1])
  const brace = text.match(/\{[\s\S]*\}/)
  if (brace) candidates.push(brace[0])
  candidates.push(text)
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c.trim())
      if (obj && typeof obj === 'object') {
        const q = Array.isArray((obj as any).questions) ? (obj as any).questions : []
        const a = Array.isArray((obj as any).assumptions) ? (obj as any).assumptions : []
        return {
          questions: q
            .filter((x: any) => x && typeof x.text === 'string' && x.text.trim())
            .map((x: any) => ({
              text: String(x.text).trim(),
              kind: x.kind,
              blocking: Boolean(x.blocking),
              options: x.options,
              proposedAnswer: typeof x.proposedAnswer === 'string' ? x.proposedAnswer : null,
              confidence: typeof x.confidence === 'number' ? clamp01(x.confidence) : null,
            })),
          assumptions: a
            .filter((x: any) => x && typeof x.text === 'string' && x.text.trim())
            .map((x: any) => ({
              text: String(x.text).trim(),
              confidence: typeof x.confidence === 'number' ? clamp01(x.confidence) : undefined,
              evidenceRef: x.evidenceRef,
            })),
        }
      }
    } catch {
      /* try next candidate */
    }
  }
  return empty
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(1, n))
}

const ELICIT_SYSTEM_PROMPT = [
  'You are the Discovery assistant for an agentic SDLC platform.',
  'Your job is to reduce unknowns for the current work scope by surfacing the',
  'highest-value open QUESTIONS a human must answer, and the ASSUMPTIONS you can',
  'reasonably make in the meantime (each with a confidence 0..1).',
  '',
  'Rules:',
  '- Only ask questions whose answers materially change the plan or design.',
  '- Mark a question blocking:true ONLY when work truly cannot proceed without it.',
  '- Do not repeat questions already listed as known/open below.',
  '- Prefer proposing an assumption (with confidence) over asking, when safe.',
  '',
  'Respond with STRICT JSON only, no prose:',
  '{"questions":[{"text","kind":"clarification|single_select|multi_select|freeform",',
  '"blocking":false,"options":[{"label"}],"proposedAnswer":null,"confidence":null}],',
  '"assumptions":[{"text","confidence":0.0,"evidenceRef":null}]}',
].join('\n')

function buildTask(session: DiscoverySessionWithChildren, input: ElicitInput, research?: string): string {
  const openQs = session.questions.filter(q => q.status === 'OPEN').map(q => `- ${q.text}`).join('\n') || '(none)'
  const known = session.assumptions.map(a => `- (${a.status}) ${a.text}`).join('\n') || '(none)'
  return [
    `SCOPE: ${session.scopeType} ${session.scopeId}`,
    input.context ? `\nCONTEXT:\n${input.context}` : '',
    research ? `\nRESEARCH FINDINGS:\n${research}` : '',
    `\nALREADY-OPEN QUESTIONS:\n${openQs}`,
    `\nEXISTING ASSUMPTIONS:\n${known}`,
    input.hint ? `\nFOCUS: ${input.hint}` : '',
    '\nProduce the JSON now.',
  ].filter(Boolean).join('\n')
}

// ── Service factory ──────────────────────────────────────────────────────────

export function createDiscoveryService(deps: DiscoveryDeps) {
  const now = deps.now ?? (() => new Date())
  const copilotPattern = deps.copilotAliasPattern ?? /copilot/i

  async function refreshStatus(sessionId: string): Promise<DiscoverySessionWithChildren> {
    const s = await deps.store.getSession(sessionId)
    if (!s) throw new ValidationError(`Discovery session ${sessionId} not found`)
    const next = computeSessionStatus(s.status, s.questions)
    if (next !== s.status) {
      await deps.store.updateSessionStatus(sessionId, next)
      s.status = next
    }
    return s
  }

  return {
    computeSessionStatus,

    createSession: (input: Parameters<DiscoveryDeps['store']['createSession']>[0]) => deps.store.createSession(input),

    getSession: (id: string) => deps.store.getSession(id),

    async addQuestion(input: Parameters<DiscoveryDeps['store']['addQuestion']>[0]) {
      const text = input.text?.trim()
      if (!text) throw new ValidationError('Question text is required')
      const q = await deps.store.addQuestion({ ...input, text })
      await refreshStatus(input.sessionId)
      return q
    },

    async answerQuestion(id: string, answer: string, answeredById?: string) {
      const text = answer?.trim()
      if (!text) throw new ValidationError('Answer is required')
      const q = await deps.store.getQuestion(id)
      if (!q) throw new ValidationError(`Question ${id} not found`)
      const updated = await deps.store.answerQuestion(id, text, answeredById)
      await refreshStatus(q.sessionId)
      return updated
    },

    async dismissQuestion(id: string) {
      const q = await deps.store.getQuestion(id)
      if (!q) throw new ValidationError(`Question ${id} not found`)
      const updated = await deps.store.dismissQuestion(id)
      await refreshStatus(q.sessionId)
      return updated
    },

    addAssumption(input: Parameters<DiscoveryDeps['store']['addAssumption']>[0]) {
      const text = input.text?.trim()
      if (!text) throw new ValidationError('Assumption text is required')
      return deps.store.addAssumption({ ...input, text })
    },

    async validateAssumption(
      id: string,
      status: Parameters<DiscoveryDeps['store']['setAssumptionStatus']>[1],
      opts?: { validatedById?: string; evidenceRef?: unknown },
    ) {
      const a = await deps.store.getAssumption(id)
      if (!a) throw new ValidationError(`Assumption ${id} not found`)
      return deps.store.setAssumptionStatus(id, status, opts)
    },

    /**
     * Run ONE elicitation iteration. Idempotent on question text (dedupes
     * against existing questions), budget-capped, and never throws on a
     * degraded model/tool call — failures surface as `notes`.
     */
    async elicit(input: ElicitInput): Promise<ElicitResult> {
      const notes: string[] = []
      let session = await deps.store.getSession(input.sessionId)
      if (!session) throw new ValidationError(`Discovery session ${input.sessionId} not found`)

      const budget = mergeBudget(session.budget, input.budget)
      const caps = budgetExhausted(budget)
      if (caps.turns) {
        notes.push('Turn budget exhausted; skipped elicitation.')
        return { session, addedQuestions: [], addedAssumptions: [], budget, notes }
      }

      await deps.store.updateSessionStatus(session.id, 'RESOLVING')

      // Optional read-only research step (MCP tool-run) before eliciting.
      let researchText: string | undefined
      if (input.research && !caps.tools) {
        try {
          const r = await deps.tool.run({
            toolName: input.research.toolName,
            args: input.research.args,
            traceId: input.traceId,
          })
          budget.toolCalls += 1
          if (r.ok) researchText = typeof r.data === 'string' ? r.data : JSON.stringify(r.data)
          else notes.push(`Research tool failed: ${r.error ?? 'unknown error'}`)
        } catch (err) {
          notes.push(`Research tool threw: ${(err as Error).message}`)
        }
      } else if (input.research && caps.tools) {
        notes.push('Tool budget exhausted; skipped research.')
      }

      // Governed model turn (Copilot when the routed alias matches the pattern).
      const modelAlias = await deps.resolveRouting('DISCOVERY', {
        userId: input.userId,
        capabilityId: input.capabilityId,
      }).catch(() => null)
      const executor = modelAlias && copilotPattern.test(modelAlias) ? 'copilot' : undefined

      let parsed: ParsedElicitation | null = null
      try {
        const turn = await deps.model.governedTurn({
          systemPrompt: ELICIT_SYSTEM_PROMPT,
          task: buildTask(session, input, researchText),
          modelAlias,
          outputTokenBudget: Math.max(0, budget.maxOutputTokens - budget.outputTokens),
          traceId: input.traceId,
          executor,
        })
        budget.turns += 1
        budget.inputTokens += turn.inputTokens || 0
        budget.outputTokens += turn.outputTokens || 0
        if (turn.status !== 'COMPLETED') notes.push(`Model turn status: ${turn.status}`)
        parsed = parseElicitation(turn.text)
        if (parsed === null) notes.push('Model produced no output.')
      } catch (err) {
        notes.push(`Model turn failed: ${(err as Error).message}`)
      }

      // Persist new questions (deduped by text) + assumptions.
      const addedQuestions: DiscoveryQuestionRecord[] = []
      const addedAssumptions = []
      if (parsed) {
        let ordinal = session.questions.length
        for (const q of parsed.questions) {
          const existing = await deps.store.findQuestionByText(session.id, q.text)
          if (existing) continue
          const created = await deps.store.addQuestion({
            sessionId: session.id,
            tenantId: session.tenantId ?? undefined,
            text: q.text,
            kind: q.kind ?? 'clarification',
            source: executor === 'copilot' ? 'copilot' : 'llm',
            blocking: Boolean(q.blocking),
            options: q.options,
            proposedAnswer: q.proposedAnswer ?? null,
            confidence: q.confidence ?? null,
            ordinal: ordinal++,
          })
          addedQuestions.push(created)
        }
        for (const a of parsed.assumptions) {
          const created = await deps.store.addAssumption({
            sessionId: session.id,
            tenantId: session.tenantId ?? undefined,
            text: a.text,
            confidence: a.confidence ?? 0.5,
            evidenceRef: a.evidenceRef,
          })
          addedAssumptions.push(created)
        }
      }

      await deps.store.updateSessionBudget(session.id, budget)
      session = await refreshStatus(session.id)
      void now
      return { session, addedQuestions, addedAssumptions, budget, notes }
    },
  }
}

export type DiscoveryService = ReturnType<typeof createDiscoveryService>
