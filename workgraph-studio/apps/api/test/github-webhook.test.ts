import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  verifyGithubSignature,
  parsePullRequestEvent,
  matchWorkCode,
  buildPrManifest,
  type ParsedPullRequest,
} from '../src/modules/submissions/github-webhook'

const sign = (body: Buffer, secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

describe('verifyGithubSignature', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'world' }))
  const secret = 'shhh-super-secret'

  it('accepts a correctly-signed body', () => {
    expect(verifyGithubSignature(body, sign(body, secret), secret)).toBe(true)
  })
  it('rejects a wrong secret, a tampered body, and a missing signature', () => {
    expect(verifyGithubSignature(body, sign(body, 'other'), secret)).toBe(false)
    expect(verifyGithubSignature(Buffer.from('tampered'), sign(body, secret), secret)).toBe(false)
    expect(verifyGithubSignature(body, undefined, secret)).toBe(false)
    expect(verifyGithubSignature(body, sign(body, secret), '')).toBe(false)
  })
})

describe('parsePullRequestEvent', () => {
  it('parses a pull_request payload', () => {
    const parsed = parsePullRequestEvent({
      action: 'synchronize',
      repository: { full_name: 'org/repo' },
      pull_request: { number: 7, head: { sha: 'head123', ref: 'wi/ABC-1' }, base: { sha: 'base456', ref: 'main' }, title: 'Fix ABC-1', body: 'closes ABC-1' },
    })
    expect(parsed).toMatchObject({ action: 'synchronize', repository: 'org/repo', number: 7, headSha: 'head123', baseRef: 'main', headRef: 'wi/ABC-1' })
  })
  it('returns null for a non-pull_request payload', () => {
    expect(parsePullRequestEvent({ zen: 'ping', repository: { full_name: 'org/repo' } })).toBeNull()
    expect(parsePullRequestEvent(null)).toBeNull()
  })
})

describe('matchWorkCode', () => {
  it('returns the single work code present in the PR text (case-insensitive)', () => {
    expect(matchWorkCode('Fix ABC-1 in the parser', ['ABC-1', 'ABC-2'])).toBe('ABC-1')
    expect(matchWorkCode('wi/abc-1 branch', ['ABC-1'])).toBe('ABC-1')
  })
  it('returns null when zero or multiple candidates match (ambiguous)', () => {
    expect(matchWorkCode('unrelated title', ['ABC-1', 'ABC-2'])).toBeNull()
    expect(matchWorkCode('touches ABC-1 and ABC-2', ['ABC-1', 'ABC-2'])).toBeNull()
  })
})

describe('buildPrManifest', () => {
  const pr: ParsedPullRequest = { action: 'opened', repository: 'org/repo', number: 42, headSha: 'deadbeef', baseSha: 'base', baseRef: 'main', headRef: 'wi/ABC-1', title: 't', body: 'b' }
  it('keys the manifest to the head commit + PR, with empty claims and the webhook source', () => {
    const m = buildPrManifest(pr, { repository: 'org/repo', baseCommitSha: 'base', specificationHash: 'sha256:abc', workCode: 'ABC-1' })
    expect(m).toMatchObject({ repository: 'org/repo', baseCommit: 'base', headCommit: 'deadbeef', pullRequestNumber: 42, specificationHash: 'sha256:abc', source: 'GITHUB_WEBHOOK', workItemCode: 'ABC-1' })
    expect(m.claims).toEqual([])
    expect(m.deviations).toEqual([])
  })
})
