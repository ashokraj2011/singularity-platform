/**
 * Closing the developer loop: check an off-platform Copilot run against the spec it was
 * supposed to implement, automatically, the moment its results are posted back.
 *
 * A developer exports a run, leaves the platform, implements on their laptop, pushes, and posts
 * the results back. Until now that post-back recorded a receipt and some artifacts and stopped.
 * Nothing measured the change against the specification, and nothing would until a human
 * remembered to open the Work Item and start a reconciliation by hand.
 *
 * This module registers what came back as an ImplementationSubmission and reconciles it.
 * Registration goes through `registerSubmission` rather than writing rows directly, because the
 * spec-hash and repository checks in `submission.validator` are precisely what makes the verdict
 * mean anything: they prove the code that came back was built against the specification the
 * platform handed out. The export carries the binding's `resolvedContentHash` so that check can
 * succeed.
 *
 * FAILS SAFE, ALWAYS. Every path that cannot produce a real verdict returns NOT_VERIFIED with a
 * reason a person can act on. In particular:
 *
 *   - A results post carries no per-requirement claims, and there is no honest way to synthesise
 *     them from a git push. So the reconciliation assesses no claims and returns NOT_VERIFIED
 *     rather than a green PASS. What it DOES check for real is the handoff's path/test policy
 *     against the reported diff — a forbidden path or a missing test suite comes back FAILED.
 *   - An empty diff is the case this is most careful about: `requireChangeManifest` makes the
 *     engine treat "no files changed" as unproven, so a run that produced nothing cannot report
 *     a clean result.
 *
 * NEVER THROWS. The post-back has already written a receipt and the artifacts by the time this
 * runs; a reconciliation failure must not fail the import and lose them.
 */
import { registerSubmissionSchema, type RegisterSubmissionInput } from '../../submissions/submission.schemas'
import { registerSubmission } from '../../submissions/submissions.service'
import { startReconciliation } from '../../reconciliations/reconciliations.service'
import { loadCopilotExportSpecification, type CopilotExportHandoffRef, type CopilotExportSpecification } from './copilot-export-spec'
import { reportedChangedFiles, type CopilotResultsPayload } from './copilot-results-verify'

export type CopilotReconciliationOutcome = {
  /** RECONCILED ⇒ a reconciliation run exists. Everything else ⇒ no verdict, and `reason` says why. */
  status: 'RECONCILED' | 'NOT_VERIFIED' | 'NOT_APPLICABLE' | 'ALREADY_REGISTERED'
  reason?: string
  workItemId?: string
  submissionId?: string
  submissionStatus?: string
  reconciliationRunId?: string
  reconciliationStatus?: string
  /** Identity checks the submission failed, verbatim, so the developer can see what to fix. */
  failedChecks?: { id: string; message: string }[]
  /** Assumptions this path had to make, disclosed rather than buried. */
  notes?: string[]
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * Two spellings of the same repository ("https://github.com/org/repo.git" vs "org/repo") are the
 * same repository. Reduce both to owner/name so a formatting difference cannot masquerade as the
 * developer having pushed to the wrong place — while a genuinely different repo still differs.
 */
export function repositoryIdentity(repository: string): string {
  const cleaned = repository
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^git@/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  // owner/name is the identity; anything before it is a host.
  return cleaned.split(/[/:]/).filter(Boolean).slice(-2).join('/')
}

export type CopilotSubmissionPlan =
  | { ok: true; manifest: RegisterSubmissionInput; notes: string[] }
  | { ok: false; reason: string }

/**
 * Build the submission manifest a results payload implies. PURE — payload + resolved context in,
 * manifest out — so the rules about what a post-back may and may not assert are testable without
 * a database.
 */
export function planCopilotSubmission(input: {
  payload: CopilotResultsPayload
  specification: Pick<CopilotExportSpecification, 'contentHash'>
  handoff: Pick<CopilotExportHandoffRef, 'repository' | 'baseCommitSha'>
  /** The repository the workflow run itself names, if it names one. */
  runRepository?: string
}): CopilotSubmissionPlan {
  const notes: string[] = []
  const git = (input.payload.git ?? {}) as Record<string, unknown>

  if (!input.specification.contentHash) {
    return { ok: false, reason: 'The specification bound to this Work Item has no content hash, so a submission cannot prove which specification it was built against.' }
  }

  const headCommit = str(git.commitSha) ?? str(git.commit_sha) ?? str(git.head) ?? str(git.headCommit)
  if (!headCommit) {
    return { ok: false, reason: 'The results reported no commit sha, so there is no specific change to check. Push a branch and re-post the results.' }
  }
  if (headCommit.length < 7) {
    return { ok: false, reason: `The results reported an unusable commit sha (${headCommit}); a full or abbreviated sha of at least 7 characters is required.` }
  }

  // The base is a warning-level check, so an unreported base must not block the whole loop —
  // but assuming the handoff base silently would fake a check the developer never passed.
  const reportedBase = str(git.baseCommit) ?? str(git.base_commit) ?? str(git.baseSha) ?? str(git.baseCommitSha)
  let baseCommit = reportedBase
  if (!baseCommit) {
    if (!input.handoff.baseCommitSha || input.handoff.baseCommitSha.trim().length < 7) {
      return { ok: false, reason: 'The results reported no base commit and the handoff does not record one, so the change cannot be located against a known starting point.' }
    }
    baseCommit = input.handoff.baseCommitSha.trim()
    notes.push('The results reported no base commit, so the handoff base was assumed. The "built from the handoff base" check was not actually exercised.')
  }

  // Prefer the handoff's spelling when both name the same repository; otherwise pass the run's
  // own value through so the validator can reject it, and say so, rather than papering over it.
  let repository = input.handoff.repository
  const runRepository = str(input.runRepository)
  if (runRepository && repositoryIdentity(runRepository) !== repositoryIdentity(input.handoff.repository)) {
    repository = runRepository
    notes.push(`The workflow run names repository "${runRepository}" but the handoff targets "${input.handoff.repository}".`)
  }

  const changedFiles = reportedChangedFiles(input.payload)

  // claims stays empty ON PURPOSE. A git push says which files moved; it does not say which
  // requirements were satisfied, and inventing a claim here would manufacture the very evidence
  // reconciliation exists to check. The engine reads this as unassessed, not as refuted.
  const parsed = registerSubmissionSchema.safeParse({
    source: 'API',
    specificationHash: input.specification.contentHash,
    repository,
    baseCommit,
    headCommit,
    claims: [],
    deviations: [],
    changedFiles,
    notes: 'Registered automatically from an exported Copilot workflow results post-back. No per-requirement claims accompany a git push, so the requirement verdicts are unassessed; the reported diff is still checked against the handoff policy.',
  })
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`).join('; ')
    return { ok: false, reason: `The results do not describe a registrable submission (${detail}).` }
  }

  return { ok: true, manifest: parsed.data, notes }
}

/**
 * Register the results as a submission and reconcile them. Resolves the spec + handoff, plans the
 * manifest, registers it, and starts a reconciliation. Returns an outcome describing what happened
 * — including, on every unhappy path, why no verdict was produced.
 */
export async function reconcileCopilotResults(args: {
  payload: CopilotResultsPayload
  workCode: string
  runRepository?: string
  actorId: string
  tenantId?: string
}): Promise<CopilotReconciliationOutcome> {
  try {
    if (!args.workCode) {
      return { status: 'NOT_APPLICABLE', reason: 'This run is not linked to a Work Item, so there is no specification to check the results against.' }
    }

    const { specification, handoffRef, warnings } = await loadCopilotExportSpecification(args.workCode, {
      repository: args.runRepository || undefined,
      tenantId: args.tenantId,
    })
    if (!specification) {
      return { status: 'NOT_APPLICABLE', reason: warnings.join(' ') || `No specification is bound to ${args.workCode}, so the results could not be checked against one.` }
    }
    if (!handoffRef) {
      return { status: 'NOT_VERIFIED', reason: `No developer handoff exists for ${args.workCode}, so there is nothing to register a submission against.` }
    }
    if (handoffRef.path === 'legacy' && !handoffRef.targetPublished) {
      return { status: 'NOT_VERIFIED', reason: 'The developer handoff for this Work Item is not published, so a submission cannot be registered against it.', workItemId: handoffRef.workItemId }
    }

    const plan = planCopilotSubmission({
      payload: args.payload,
      specification,
      handoff: handoffRef,
      runRepository: args.runRepository,
    })
    if (!plan.ok) {
      return { status: 'NOT_VERIFIED', reason: plan.reason, workItemId: handoffRef.workItemId }
    }

    // A handoff that declares no requirement subset means "every requirement is in scope" to the
    // reconciliation engine, but `submission.validator` builds its in-scope set from that same
    // empty list — so any claim at all would be dangling and the submission would be REJECTED.
    // This path submits no claims, so it does not trip that; the note keeps it visible if the
    // shape of this manifest ever changes.
    const notes = [...plan.notes]
    if (!specification.scopeDeclared) {
      notes.push('This handoff declares no requirement subset, so every requirement in the specification is in scope.')
    }

    const scopedContext = handoffRef.developmentScopeId && handoffRef.handoffGenerationId
      ? { developmentScopeId: handoffRef.developmentScopeId, handoffGenerationId: handoffRef.handoffGenerationId }
      : undefined

    const registered = await registerSubmission(handoffRef.workItemId, plan.manifest, args.actorId, scopedContext)

    if (registered.alreadyRegistered) {
      return {
        status: 'ALREADY_REGISTERED',
        reason: 'This commit was already registered for this Work Item; the existing reconciliation stands rather than being duplicated.',
        workItemId: handoffRef.workItemId,
        submissionId: registered.submission.id,
        submissionStatus: String(registered.submission.status),
        notes,
      }
    }

    // A submission that fails an identity check is recorded as REJECTED and cannot be reconciled.
    // Report the failed checks verbatim: "rejected" alone is the kind of message that sends a
    // developer to read the source.
    if (!registered.validation.passed) {
      return {
        status: 'NOT_VERIFIED',
        reason: 'The results do not correspond to the specification this Work Item handed out, so they were recorded but not reconciled.',
        workItemId: handoffRef.workItemId,
        submissionId: registered.submission.id,
        submissionStatus: String(registered.submission.status),
        failedChecks: registered.validation.checks
          .filter((c) => !c.passed && c.severity === 'error')
          .map((c) => ({ id: c.id, message: c.message })),
        notes,
      }
    }

    const result = await startReconciliation(
      handoffRef.workItemId,
      registered.submission.id,
      args.actorId,
      'DETERMINISTIC',
      // The automated path, unlike a person filing by hand, asserts nothing. An empty diff here
      // means the run proved nothing and must not report clean.
      { requireChangeManifest: true },
    )

    return {
      status: 'RECONCILED',
      workItemId: handoffRef.workItemId,
      submissionId: registered.submission.id,
      submissionStatus: String(registered.submission.status),
      reconciliationRunId: result.run.id,
      reconciliationStatus: String(result.run.status),
      notes,
    }
  } catch (err) {
    // The receipt and artifacts are already written. Losing them because a reconciliation could
    // not run would be a worse outcome than reporting that it could not run.
    return {
      status: 'NOT_VERIFIED',
      reason: `The results could not be reconciled against the specification (${err instanceof Error ? err.message : 'unknown error'}).`,
    }
  }
}
