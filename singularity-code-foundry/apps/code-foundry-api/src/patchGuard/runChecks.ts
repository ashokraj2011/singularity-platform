/**
 * M42.4 — Patch Guard pipeline (Patent Chain A enforcer).
 *
 * Sequential checks. Short-circuits on first rejection so the audit
 * record points at the exact reason. Order matters:
 *
 *   1. Diff parses cleanly
 *   2. Touches only the task's target file
 *   3. Every hunk falls inside a single editable region whose id
 *      matches the task, and whose ontology permits the edit
 *   4. No region marker is added or removed
 *   5. No secret-shaped strings introduced
 *   6. Patch applies cleanly (context lines match the on-disk file)
 *
 * A future M42.4.1 adds:
 *   7. Apply to a temp tree + re-run the verifier (mvn/pytest/npm)
 *      and accept only on green.
 *
 * The temp-tree re-verify is gated behind the toolchain — M42.3
 * already showed mvn/pytest/npm are SKIPPED in the dev container,
 * so M42.4 lands without it; the verifier sidecar in M42.6 picks
 * up that responsibility.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseUnifiedDiff, type ParsedDiff } from './parseDiff.js'
import { checkRegions } from './regionCheck.js'
import { scanHunkForSecrets } from './secretScan.js'
import { previewApply, type AppliedFile } from './apply.js'
import { sha256 } from '../spec/hash.js'

export type GuardOutcome =
  | { passed: true; reason: 'accepted'; appliedFiles: AppliedFile[]; responseHash: string; parsed: ParsedDiff }
  | { passed: false; reason: string; stage: GuardStage; details?: Record<string, unknown> }

export type GuardStage =
  | 'parse'
  | 'allowed_file'
  | 'region'
  | 'region_marker_mutation'
  | 'secret_scan'
  | 'apply'

export interface GuardInput {
  projectDir: string
  diff: string
  targetFile: string
  regionId: string
}

export function runGuard(input: GuardInput): GuardOutcome {
  // 1. Parse.
  let parsed: ParsedDiff
  try {
    parsed = parseUnifiedDiff(input.diff)
  } catch (err) {
    return { passed: false, reason: `Diff parse failed: ${(err as Error).message}`, stage: 'parse' }
  }
  if (parsed.deltas.length === 0) {
    return { passed: false, reason: 'Diff contains no deltas.', stage: 'parse' }
  }

  // 2 + 3 + 4. File scope + region scope + ontology + no marker
  // mutation (the region checker handles 2-4 in one pass).
  const regionResult = checkRegions({
    projectDir: input.projectDir,
    parsed,
    expectedRegionId: input.regionId,
    expectedFile: input.targetFile,
  })
  if (!regionResult.passed) {
    const stage: GuardStage = regionResult.reason?.includes('region marker') ? 'region_marker_mutation'
                            : regionResult.reason?.includes('file') ? 'allowed_file'
                            : 'region'
    return { passed: false, reason: regionResult.reason!, stage, details: { perDelta: regionResult.perDelta } }
  }

  // 5. Secret scan.
  for (const delta of parsed.deltas) {
    const hits = scanHunkForSecrets(delta.raw)
    if (hits.length > 0) {
      return {
        passed: false,
        reason: `Patch introduces ${hits.length} secret-shaped value(s): ${hits.map(h => h.patternId).join(', ')}`,
        stage: 'secret_scan',
        details: { hits },
      }
    }
  }

  // 6. Apply preview.
  const applied = previewApply(input.projectDir, input.diff)
  if (applied.rejected.length > 0) {
    return {
      passed: false,
      reason: `Patch could not be applied cleanly: ${applied.rejected.join('; ')}`,
      stage: 'apply',
    }
  }

  return {
    passed: true,
    reason: 'accepted',
    appliedFiles: applied.files,
    responseHash: sha256(input.diff),
    parsed,
  }
}

/**
 * Commit the previewed files to disk. Called by the orchestrator AFTER
 * runGuard returns passed=true. Kept separate so a future sidecar
 * verifier can interpose between guard.pass and disk.commit.
 */
export function commitApplied(projectDir: string, files: AppliedFile[]): void {
  for (const f of files) {
    writeFileSync(join(projectDir, f.filePath), f.after, 'utf8')
  }
}
