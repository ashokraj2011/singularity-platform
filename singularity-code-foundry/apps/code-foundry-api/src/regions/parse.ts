/**
 * M42.2 — Region parser used by the Patch Guard.
 *
 * Re-reads generated source files and locates every region marker so
 * the guard can mechanically check that each diff hunk falls inside a
 * declared region (and that the region's type permits the change).
 *
 * Returns line-based ranges (1-indexed, inclusive) — matches what a
 * unified diff parser produces, so the guard's comparison is direct.
 */

export interface RegionRange {
  marker: 'protected' | 'editable'
  regionId: string
  // 1-indexed inclusive line numbers of the OPEN and CLOSE marker lines.
  openLine: number
  closeLine: number
  // Lines fully inside the fence, exclusive of the markers themselves.
  innerStart: number
  innerEnd: number
}

const OPEN_RE = /^\s*(?:\/\/|#)\s*<(?<marker>generated:protected|llm-editable)\s+region="(?<id>[^"]+)">\s*$/
const CLOSE_RE = /^\s*(?:\/\/|#)\s*<\/(?<marker>generated:protected|llm-editable)>\s*$/

export function parseRegions(source: string): RegionRange[] {
  const lines = source.split(/\r?\n/)
  const out: RegionRange[] = []
  const open: Array<{ marker: 'protected' | 'editable'; regionId: string; line: number }> = []

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1
    const openMatch = OPEN_RE.exec(lines[i])
    if (openMatch?.groups) {
      const m = openMatch.groups.marker === 'generated:protected' ? 'protected' : 'editable'
      open.push({ marker: m, regionId: openMatch.groups.id, line: lineNo })
      continue
    }
    const closeMatch = CLOSE_RE.exec(lines[i])
    if (closeMatch?.groups) {
      const top = open.pop()
      if (!top) {
        throw new Error(`Region close at line ${lineNo} has no matching open.`)
      }
      const closeKind = closeMatch.groups.marker === 'generated:protected' ? 'protected' : 'editable'
      if (closeKind !== top.marker) {
        throw new Error(`Region open ${top.marker} at line ${top.line} closed by ${closeKind} at line ${lineNo}.`)
      }
      out.push({
        marker: top.marker,
        regionId: top.regionId,
        openLine: top.line,
        closeLine: lineNo,
        innerStart: top.line + 1,
        innerEnd: lineNo - 1,
      })
    }
  }
  if (open.length > 0) {
    const stray = open[open.length - 1]
    throw new Error(`Region open '${stray.regionId}' at line ${stray.line} never closed.`)
  }
  return out
}

/**
 * Find the region (if any) that covers a given line number. Returns
 * the innermost matching range so nested regions resolve correctly.
 * (Nested regions aren't emitted today but the parser supports them.)
 */
export function regionAtLine(regions: RegionRange[], line: number): RegionRange | undefined {
  let best: RegionRange | undefined
  for (const r of regions) {
    if (line >= r.openLine && line <= r.closeLine) {
      if (!best || r.openLine > best.openLine) best = r
    }
  }
  return best
}
