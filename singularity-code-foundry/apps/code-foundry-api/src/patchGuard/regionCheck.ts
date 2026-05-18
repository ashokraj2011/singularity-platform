/**
 * M42.4 — Region/ontology enforcement (Patent Chain A core).
 *
 * Given a parsed diff + the on-disk source of each touched file,
 * verify that every hunk lands inside a declared region whose type
 * allows the proposed change class. Reject otherwise.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseRegions, regionAtLine, type RegionRange } from '../regions/parse.js'
import { regionSpec } from '../regions/ontology.js'
import type { DiffDelta, ParsedDiff } from './parseDiff.js'

export interface RegionCheckOutcome {
  passed: boolean
  reason?: string
  hitRegion?: RegionRange
  perDelta: Array<{ delta: DiffDelta; passed: boolean; reason?: string; region?: RegionRange }>
}

export interface RegionCheckInput {
  projectDir: string
  parsed: ParsedDiff
  /** The expected region the task was scoped to. */
  expectedRegionId: string
  /** The expected target file. */
  expectedFile: string
}

export function checkRegions(input: RegionCheckInput): RegionCheckOutcome {
  const perDelta: RegionCheckOutcome['perDelta'] = []
  let firstFailure: { reason: string; hitRegion?: RegionRange } | undefined

  // First: every touched file must equal the expected one.
  for (const f of input.parsed.files) {
    if (f !== input.expectedFile) {
      const reason = `Patch touches file '${f}' but the task is scoped to '${input.expectedFile}'.`
      return { passed: false, reason, perDelta }
    }
  }

  for (const delta of input.parsed.deltas) {
    const abs = join(input.projectDir, delta.filePath)
    if (!existsSync(abs)) {
      const reason = `Target file '${delta.filePath}' does not exist in the project tree.`
      perDelta.push({ delta, passed: false, reason })
      if (!firstFailure) firstFailure = { reason }
      continue
    }
    const src = readFileSync(abs, 'utf8')
    let regions: RegionRange[] = []
    try {
      regions = parseRegions(src)
    } catch (err) {
      const reason = `Failed to parse regions from '${delta.filePath}': ${(err as Error).message}`
      perDelta.push({ delta, passed: false, reason })
      if (!firstFailure) firstFailure = { reason }
      continue
    }

    // Every line that the patch actually ADDS or REMOVES must lie
    // inside an editable region with the expected regionId. Context
    // lines (whitespace-prefixed in the diff) are unchanged on disk
    // and can sit anywhere — including across protected boundaries —
    // so we skip them. The `del`/`add` numbers come from the diff
    // parser and are the precise positions we need to validate.
    const probeAdded = uniqLines(delta.addedLineNumbers)
    // Removed lines reference the on-disk file (which is also the
    // pre-patch state we parse). Same file content, so the same
    // region positions apply.
    const probeRemoved = uniqLines(delta.removedOldLineNumbers)
    const probe = uniqLines([...probeAdded, ...probeRemoved])
    let perDeltaPassed = true
    let perDeltaReason: string | undefined
    let firstRegion: RegionRange | undefined

    if (probe.length === 0) {
      // Pure-context hunk — nothing actually changes. Treat as a no-op
      // accept for this delta. (Patch Guard rejects empty diffs at the
      // top level so we never get an entirely-context patch.)
      perDelta.push({ delta, passed: true })
      continue
    }

    for (const line of probe) {
      const region = regionAtLine(regions, line)
      if (!region) {
        perDeltaPassed = false
        perDeltaReason = `Line ${line} in '${delta.filePath}' is outside every declared region.`
        break
      }
      if (!firstRegion) firstRegion = region
      if (region.marker !== 'editable') {
        perDeltaPassed = false
        perDeltaReason = `Line ${line} lands inside protected region '${region.regionId}' — patches are not allowed here.`
        break
      }
      if (region.regionId !== input.expectedRegionId) {
        perDeltaPassed = false
        perDeltaReason = `Line ${line} is inside region '${region.regionId}' but the task is scoped to '${input.expectedRegionId}'.`
        break
      }
      const spec = regionSpec(region.regionId)
      if (!spec.editable || spec.allowedChanges.length === 0) {
        perDeltaPassed = false
        perDeltaReason = `Region '${region.regionId}' allows no edit classes per the ontology.`
        break
      }
    }

    // Reject any diff hunk that ADDS or REMOVES a region open/close
    // marker — the LLM is not allowed to re-fence regions. Context
    // lines (whitespace-prefixed) are fine; only `+`/`-` lines count.
    for (const dline of delta.raw.split(/\r?\n/)) {
      const prefix = dline.charAt(0)
      if (prefix !== '+' && prefix !== '-') continue
      const body = dline.slice(1)
      if (/<\/?(?:generated:protected|llm-editable)/.test(body)) {
        perDeltaPassed = false
        perDeltaReason = `Patch ${prefix === '+' ? 'introduces' : 'removes'} a region marker. The Foundry owns region fences; LLM patches may only edit inside them.`
        break
      }
    }

    perDelta.push({ delta, passed: perDeltaPassed, reason: perDeltaReason, region: firstRegion })
    if (!perDeltaPassed && !firstFailure) firstFailure = { reason: perDeltaReason ?? 'region check failed', hitRegion: firstRegion }
  }

  if (firstFailure) {
    return { passed: false, ...firstFailure, perDelta }
  }
  return { passed: true, perDelta }
}

function uniqLines(arr: number[]): number[] {
  return Array.from(new Set(arr.filter((n) => n > 0)))
}
