/**
 * Claim event handler (workgraph side) — the M-CR3 cross-service tail. Called
 * from the /api/events/incoming fan-out hook (next to fanOutToWorkItemTriggers)
 * AFTER signature verification, so everything arriving here is authenticated.
 *
 * On claim.decay.threshold_crossed / claim.falsified: find every workflow template
 * whose metadata.claimRefs references the claim, append an idempotent review flag
 * to metadata.claimReview, and write an EventLog row so Run Insights and the
 * template UI can surface "a belief this template rests on has weakened."
 *
 * Deliberately conservative: flags only. No template deactivation, no run
 * blocking — humans decide, the same stance as the registry's no-auto-demotion.
 *
 * NB: the workflow-template table is the `Workflow` model (@@map("workflow_templates")),
 * so the accessor is prisma.workflow. Templates are not RLS-scoped, so this runs
 * outside a tenant context and flags across tenants — a falsified claim should
 * re-flag every template that rests on it, wherever it lives.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logEvent } from '../../lib/audit'
import {
  isClaimReviewEvent, referencesClaim, applyReviewFlag, reviewFlagFrom,
  type ClaimEventEnvelopeLike,
} from './claim-events-core'

export async function handleIncomingClaimEvent(
  eventName: string,
  outboxId: string,
  envelope: ClaimEventEnvelopeLike,
): Promise<{ flaggedTemplateIds: string[] }> {
  if (!isClaimReviewEvent(eventName)) return { flaggedTemplateIds: [] }
  const flag = reviewFlagFrom(eventName, outboxId, envelope, new Date().toISOString())
  if (!flag) return { flaggedTemplateIds: [] }

  // v1 scan: templates carrying any claimRefs are expected to be few; a JSONB
  // containment index (`metadata @> '{"claimRefs":[...]}'`) is the upgrade path
  // if this table grows hot. Filter in JS via the tolerant pure core.
  const candidates = await prisma.workflow.findMany({
    where: { metadata: { not: Prisma.DbNull } },
    select: { id: true, metadata: true },
  })

  const flaggedTemplateIds: string[] = []
  for (const template of candidates) {
    if (!referencesClaim(template.metadata, flag.claimId)) continue
    const next = applyReviewFlag(template.metadata, flag)
    if (!next) continue // redelivery — already flagged
    await prisma.workflow.update({ where: { id: template.id }, data: { metadata: next as object } })
    flaggedTemplateIds.push(template.id)
    await logEvent('WorkflowTemplateClaimReviewFlagged', 'WorkflowTemplate', template.id, undefined, {
      claimId: flag.claimId,
      eventName,
      outboxId,
      posteriorProb: flag.posteriorProb,
      threshold: flag.threshold,
    })
  }
  return { flaggedTemplateIds }
}
