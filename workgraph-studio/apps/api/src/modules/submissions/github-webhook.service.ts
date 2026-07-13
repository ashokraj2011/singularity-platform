import { prisma } from '../../lib/prisma'
import { registerSubmission } from './submissions.service'
import { ConflictError, NotFoundError } from '../../lib/errors'
import {
  parsePullRequestEvent,
  matchWorkCode,
  buildPrManifest,
  HANDLED_PR_ACTIONS,
} from './github-webhook'
import type { RegisterSubmissionInput } from './submission.schemas'

// The webhook has no authenticated user; events are attributed to a system actor (actorId is a
// plain nullable string on the Work Item timeline, not a user FK).
const WEBHOOK_ACTOR = 'github-webhook'

export interface WebhookOutcome {
  status: 'registered' | 'already-registered' | 'rejected' | 'skipped' | 'ignored'
  detail?: string
  workItemId?: string
  submissionId?: string
}

/**
 * Turn a GitHub pull_request event into an implementation submission. Correlates the PR to a Work
 * Item by its PUBLISHED developer handoff for the same repository (unambiguously: a single handoff
 * for the repo, or the one whose work code appears in the PR). Registration reuses the same
 * registerSubmission path as the API, so immutability-per-head-SHA and the identity checks apply.
 */
export async function handleGithubPullRequest(payload: unknown): Promise<WebhookOutcome> {
  const pr = parsePullRequestEvent(payload)
  if (!pr) return { status: 'ignored', detail: 'not a pull_request payload' }
  if (!HANDLED_PR_ACTIONS.includes(pr.action)) return { status: 'ignored', detail: `action '${pr.action}' not handled` }
  if (!pr.headSha) return { status: 'ignored', detail: 'no head commit sha' }

  const targets = await prisma.developmentTarget.findMany({
    where: { status: 'PUBLISHED', repository: { equals: pr.repository, mode: 'insensitive' } },
    include: { workItem: { select: { id: true, workCode: true } } },
  })
  if (targets.length === 0) return { status: 'skipped', detail: `no published developer handoff for ${pr.repository}` }

  let target: (typeof targets)[number] | null = null
  if (targets.length === 1) {
    target = targets[0]
  } else {
    const code = matchWorkCode(`${pr.title}\n${pr.body}\n${pr.headRef}`, targets.map((t) => t.workItem?.workCode ?? ''))
    target = code ? targets.find((t) => t.workItem?.workCode === code) ?? null : null
    if (!target) return { status: 'skipped', detail: `multiple handoffs target ${pr.repository}; include the work code in the PR title to disambiguate` }
  }

  const spec = await prisma.specificationVersion.findUnique({
    where: { id: target.specificationVersionId },
    select: { contentHash: true },
  })
  const manifest = buildPrManifest(pr, {
    repository: target.repository,
    baseCommitSha: target.baseCommitSha,
    specificationHash: spec?.contentHash ?? '',
    workCode: target.workItem?.workCode,
  })

  try {
    const result = await registerSubmission(target.workItemId, manifest as unknown as RegisterSubmissionInput, WEBHOOK_ACTOR)
    return {
      status: result.alreadyRegistered ? 'already-registered' : result.submission.status === 'REJECTED' ? 'rejected' : 'registered',
      workItemId: target.workItemId,
      submissionId: result.submission.id,
    }
  } catch (err) {
    // A not-yet-published handoff races with the correlation query, or the spec vanished — report
    // it as skipped rather than 500 so GitHub doesn't retry-storm the delivery.
    if (err instanceof ConflictError || err instanceof NotFoundError) {
      return { status: 'skipped', detail: err.message }
    }
    throw err
  }
}
