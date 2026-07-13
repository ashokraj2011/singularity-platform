import { traceIdFromParts } from '@workgraph/shared-types'
import { contextFabricClient } from '../../lib/context-fabric/client'
import {
  semanticSystemPrompt,
  buildSemanticTask,
  parseSemanticJudgments,
  applySemanticJudgments,
  type SemanticVerdict,
  type SemanticRequirement,
  type SemanticClaim,
  type SemanticOverlayResult,
} from './reconciliation.semantic'

/** The single model call the semantic pass needs — injectable so runSemanticPass is unit-testable. */
export interface SemanticLlm {
  complete(input: { system: string; task: string; traceId: string; actorId: string; workItemId: string }): Promise<string>
}

export const defaultSemanticLlm: SemanticLlm = {
  async complete({ system, task, traceId, actorId, workItemId }) {
    const res = await contextFabricClient.executeGovernedTurn({
      trace_id: traceId,
      run_context: {
        work_item_id: workItemId,
        capability_id: process.env.SPEC_GEN_CAPABILITY_ID ?? 'spec-author',
        user_id: actorId,
        surface: 'semantic-reconciliation',
      },
      system_prompt: system,
      task,
      model_overrides: { temperature: 0, maxOutputTokens: 3000 },
      limits: { outputTokenBudget: 3000, timeoutSec: 150 },
    })
    return res.finalResponse ?? ''
  },
}

export interface SemanticPassContext {
  workItemId: string
  actorId: string
  requirements: SemanticRequirement[]
  claims: SemanticClaim[]
  verdicts: SemanticVerdict[]
}

/**
 * Run the LLM semantic judge and overlay it on the deterministic verdicts. BEST-EFFORT: any
 * failure (LLM error, unparseable response, empty judgments) returns null so the caller keeps the
 * deterministic result — a semantic pass must never fail the whole reconciliation.
 */
export async function runSemanticPass(ctx: SemanticPassContext, llm: SemanticLlm = defaultSemanticLlm): Promise<SemanticOverlayResult | null> {
  if (ctx.verdicts.length === 0 || ctx.requirements.length === 0) return null
  try {
    const text = await llm.complete({
      system: semanticSystemPrompt(),
      task: buildSemanticTask(ctx.requirements, ctx.claims),
      traceId: traceIdFromParts(['semantic-recon', ctx.workItemId], ':'),
      actorId: ctx.actorId,
      workItemId: ctx.workItemId,
    })
    const judgments = parseSemanticJudgments(text)
    if (judgments.length === 0) return null
    return applySemanticJudgments(ctx.verdicts, judgments)
  } catch {
    return null
  }
}
