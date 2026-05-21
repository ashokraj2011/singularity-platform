/**
 * M43 Slice 4 — verify normalizeLaptopCompletionEvidence emits the same
 * correlation shape the workgraph-side gates expect.
 *
 * Uses node:test (built-in, no dependency) since this package doesn't ship
 * a test framework. Run with:
 *   pnpm --filter @singularity/laptop-sdk exec tsx --test test/*.test.ts
 * or after building:
 *   pnpm --filter @singularity/laptop-sdk build && node --test dist/test/*.test.js
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { normalizeLaptopCompletionEvidence } from '../src/index.js'

function gitInit(root: string) {
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root })
}

describe('normalizeLaptopCompletionEvidence', () => {
  let workdir: string

  before(() => {
    workdir = mkdtempSync(join(tmpdir(), 'laptop-sdk-'))
    gitInit(workdir)
    writeFileSync(join(workdir, 'committed.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', '.'], { cwd: workdir })
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: workdir })
  })

  after(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('returns gap=false when no code changed (read-only run)', async () => {
    const ev = await normalizeLaptopCompletionEvidence({ workdir })
    assert.equal(ev.codeChangeIds.length, 0)
    assert.equal(ev.verificationCoverage.codeChanged, false)
    assert.equal(ev.verificationCoverage.gap, false)
    assert.equal(ev.agentReasoningMode, 'direct-copilot')
  })

  it('detects modified + untracked files', async () => {
    writeFileSync(join(workdir, 'committed.ts'), 'export const a = 2\n')   // modified
    writeFileSync(join(workdir, 'newfile.ts'), 'export const b = 3\n')      // untracked
    const ev = await normalizeLaptopCompletionEvidence({ workdir })
    assert.deepEqual([...ev.codeChangeIds].sort(), ['committed.ts', 'newfile.ts'])
    assert.equal(ev.verificationCoverage.codeChanged, true)
  })

  it('flags gap=true when code changed but no receipts', async () => {
    const ev = await normalizeLaptopCompletionEvidence({ workdir })
    assert.equal(ev.verificationCoverage.gap, true)
    assert.equal(ev.verificationCoverage.receiptsPresent, false)
  })

  it('clears gap when a passing receipt is supplied', async () => {
    const ev = await normalizeLaptopCompletionEvidence({
      workdir,
      verificationReceipts: [{ command: 'pnpm', passed: true, exit_code: 0 }],
    })
    assert.equal(ev.verificationCoverage.gap, false)
    assert.equal(ev.verificationCoverage.hasPassingReceipt, true)
  })

  it('clears gap when verification_unavailable receipt is supplied', async () => {
    const ev = await normalizeLaptopCompletionEvidence({
      workdir,
      verificationReceipts: [{ command: 'verification_unavailable', reason: 'no test runner detected' }],
    })
    assert.equal(ev.verificationCoverage.gap, false)
    assert.equal(ev.verificationCoverage.hasUnavailableReceipt, true)
  })

  it('populates codeChangeCoverage when requiredPaths are supplied', async () => {
    const ev = await normalizeLaptopCompletionEvidence({
      workdir,
      requiredPaths: ['committed.ts', 'missing-service.ts'],
    })
    assert.ok(ev.codeChangeCoverage)
    assert.deepEqual(ev.codeChangeCoverage!.required, ['committed.ts', 'missing-service.ts'])
    assert.deepEqual(ev.codeChangeCoverage!.covered, ['committed.ts'])
    assert.deepEqual(ev.codeChangeCoverage!.missing, ['missing-service.ts'])
    assert.equal(ev.codeChangeCoverage!.hasRequiredCodeGap, true)
  })

  it('omits codeChangeCoverage when no requiredPaths supplied', async () => {
    const ev = await normalizeLaptopCompletionEvidence({ workdir })
    // No required paths → no gate, no field
    assert.equal(ev.codeChangeCoverage, undefined)
  })
})
