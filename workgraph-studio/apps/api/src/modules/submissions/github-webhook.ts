import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * GitHub webhook intake — the pure pieces (spec §7 automation). Verifying the delivery signature,
 * parsing a pull_request event, correlating it to a Work Item by work code, and shaping the
 * submission manifest. No I/O here (the DB correlation + registration live in the service), so
 * signature + parsing + mapping are unit-testable without a running server.
 */

/** GitHub signs each delivery: X-Hub-Signature-256: sha256=<hmac>. Constant-time compare. */
export function verifyGithubSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !secret) return false
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export interface ParsedPullRequest {
  action: string
  repository: string
  number: number
  headSha: string
  baseSha: string
  baseRef: string
  headRef: string
  title: string
  body: string
}

// A PR that gains commits or opens/reopens is a fresh submission-worthy state; other actions
// (labeled, assigned, closed, …) are ignored.
export const HANDLED_PR_ACTIONS = ['opened', 'synchronize', 'reopened', 'ready_for_review']

export function parsePullRequestEvent(payload: unknown): ParsedPullRequest | null {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, any>
  const pr = p.pull_request
  const repo = p.repository?.full_name
  if (!pr || typeof pr !== 'object' || !repo || typeof pr.number !== 'number') return null
  return {
    action: String(p.action ?? ''),
    repository: String(repo),
    number: pr.number,
    headSha: String(pr.head?.sha ?? ''),
    baseSha: String(pr.base?.sha ?? ''),
    baseRef: String(pr.base?.ref ?? ''),
    headRef: String(pr.head?.ref ?? ''),
    title: String(pr.title ?? ''),
    body: String(pr.body ?? ''),
  }
}

/**
 * Pick the work code the PR refers to. Returns a code only when exactly one candidate appears in
 * the PR text — an ambiguous or absent match returns null so the caller can fall back (e.g. "the
 * repo has a single handoff") or skip rather than guess wrong.
 */
export function matchWorkCode(prText: string, workCodes: string[]): string | null {
  const text = prText.toLowerCase()
  const hits = [...new Set(workCodes.filter((c) => c && text.includes(c.toLowerCase())))]
  return hits.length === 1 ? hits[0] : null
}

export interface PrManifestContext {
  repository: string
  baseCommitSha: string
  specificationHash: string
  workCode?: string
}

/**
 * Shape the submission manifest from a PR. The webhook doesn't know per-requirement claims, so it
 * records an empty-claims submission keyed to the exact head commit — reconciliation then reflects
 * "no manifest yet", and a CI step / the API can enrich the claims later against the same head SHA.
 */
export function buildPrManifest(pr: ParsedPullRequest, ctx: PrManifestContext) {
  return {
    schemaVersion: '1.0',
    kind: 'singularity.implementation-submission' as const,
    ...(ctx.workCode ? { workItemCode: ctx.workCode } : {}),
    specificationHash: ctx.specificationHash,
    repository: ctx.repository,
    baseCommit: ctx.baseCommitSha,
    headCommit: pr.headSha,
    pullRequestNumber: pr.number,
    claims: [] as unknown[],
    deviations: [] as unknown[],
    source: 'GITHUB_WEBHOOK' as const,
  }
}
