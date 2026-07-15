/**
 * Discovery compatibility bridge (ADR 0006 Slice 2).
 *
 * Keeps the two legacy "unknowns" mechanisms working while routing their data
 * into the unified model, backward-compatibly:
 *   - work-item clarifications  → mirrored as Questions on the work item's session
 *   - workbench stage questions → seeded as configured Questions on the stage's session
 *
 * Every mirror op is idempotent (keyed by sourceType+sourceId) so repeated
 * legacy writes never duplicate. Callers invoke these best-effort: a bridge
 * failure must never break the legacy path.
 */
import { computeSessionStatus } from './discovery.service'
import type {
  DiscoveryScopeType,
  DiscoverySessionRecord,
  DiscoveryStore,
} from './discovery.types'

const SRC_CLARIFICATION = 'work_item_clarification'
const SRC_STAGE_QUESTION = 'workbench_stage_question'

export interface MirrorClarificationInput {
  workItemId: string
  clarificationId: string
  question: string
  tenantId?: string
  blocking?: boolean
}

export interface AnswerClarificationInput {
  clarificationId: string
  answer: string
  answeredById?: string
}

export interface SeedStageQuestion {
  questionId: string
  text: string
  required?: boolean
  options?: unknown
  ordinal?: number
}

export interface SeedStageInput {
  stageId: string
  tenantId?: string
  questions: SeedStageQuestion[]
}

export function createDiscoveryBridge(store: DiscoveryStore) {
  async function getOrCreateSession(
    scopeType: DiscoveryScopeType,
    scopeId: string,
    tenantId?: string,
    createdById?: string,
  ): Promise<DiscoverySessionRecord> {
    const existing = await store.findSessionByScope(scopeType, scopeId, tenantId)
    if (existing) return existing
    return store.createSession({ scopeType, scopeId, tenantId, createdById })
  }

  async function refreshStatus(sessionId: string): Promise<void> {
    const s = await store.getSession(sessionId)
    if (!s) return
    const next = computeSessionStatus(s.status, s.questions)
    if (next !== s.status) await store.updateSessionStatus(sessionId, next)
  }

  return {
    getOrCreateSession,

    async mirrorClarificationRequested(input: MirrorClarificationInput) {
      const text = input.question?.trim()
      if (!text) return null
      const dup = await store.findQuestionBySource(SRC_CLARIFICATION, input.clarificationId)
      if (dup) return dup
      const session = await getOrCreateSession('WORK_ITEM', input.workItemId, input.tenantId)
      const q = await store.addQuestion({
        sessionId: session.id,
        tenantId: input.tenantId,
        text,
        kind: 'clarification',
        source: 'human',
        blocking: input.blocking ?? true,
        sourceType: SRC_CLARIFICATION,
        sourceId: input.clarificationId,
      })
      await refreshStatus(session.id)
      return q
    },

    async mirrorClarificationAnswered(input: AnswerClarificationInput) {
      const text = input.answer?.trim()
      if (!text) return null
      const q = await store.findQuestionBySource(SRC_CLARIFICATION, input.clarificationId)
      if (!q || q.status !== 'OPEN') return q ?? null
      const updated = await store.answerQuestion(q.id, text, input.answeredById)
      await refreshStatus(q.sessionId)
      return updated
    },

    /**
     * Seed a stage's configured questions as Questions (source='configured').
     * `required` maps to the unified blocking gate. Idempotent per questionId.
     */
    async seedStageQuestions(input: SeedStageInput) {
      const session = await getOrCreateSession('WORKFLOW_STAGE', input.stageId, input.tenantId)
      const seeded = []
      let ordinal = 0
      for (const cfg of input.questions) {
        const key = `${input.stageId}:${cfg.questionId}`
        const dup = await store.findQuestionBySource(SRC_STAGE_QUESTION, key)
        if (dup) {
          ordinal++
          continue
        }
        const q = await store.addQuestion({
          sessionId: session.id,
          tenantId: input.tenantId,
          text: cfg.text,
          kind: 'freeform',
          source: 'configured',
          blocking: cfg.required ?? false,
          options: cfg.options,
          ordinal: cfg.ordinal ?? ordinal++,
          sourceType: SRC_STAGE_QUESTION,
          sourceId: key,
        })
        seeded.push(q)
      }
      await refreshStatus(session.id)
      return { sessionId: session.id, seeded }
    },
  }
}

export type DiscoveryBridge = ReturnType<typeof createDiscoveryBridge>
