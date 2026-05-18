/**
 * M42.4 — Unified-diff parser. Thin wrapper around the `parse-diff`
 * npm package so the Patch Guard can iterate over hunks with
 * file-and-line-range deltas.
 *
 * Tracks the actual added/removed line numbers (not just the chunk
 * header's range) so the region check can verify each MODIFIED line —
 * not the unchanged context lines — falls inside the expected region.
 */
import parseDiff from 'parse-diff'

export interface DiffDelta {
  filePath: string
  // Full new-side line range of the chunk header (informational only —
  // includes context lines that were not actually modified).
  startLine: number
  endLine: number
  // 1-indexed new-side line numbers this hunk adds.
  addedLineNumbers: number[]
  // 1-indexed old-side line numbers this hunk removes.
  removedOldLineNumbers: number[]
  added: number
  removed: number
  raw: string
}

export interface ParsedDiff {
  deltas: DiffDelta[]
  /** Unique target file paths (relative to project root). */
  files: string[]
}

interface ChangeLn {
  type: 'normal' | 'add' | 'del'
  content: string
  ln?: number   // new-side line number for `add` / `normal`
  ln1?: number  // old-side line number for `del`
  ln2?: number  // (parse-diff sometimes uses ln2 for new-side on `del` hunks)
}

export function parseUnifiedDiff(source: string): ParsedDiff {
  const parsed = parseDiff(source)
  const deltas: DiffDelta[] = []
  const files = new Set<string>()
  for (const file of parsed) {
    const rawTarget = file.to ?? file.from ?? ''
    const target = stripPrefix(rawTarget)
    if (!target) continue
    files.add(target)
    for (const chunk of file.chunks) {
      const startLine = chunk.newStart ?? 0
      const endLine = startLine + (chunk.newLines ?? 0) - 1
      let added = 0
      let removed = 0
      const addedLineNumbers: number[] = []
      const removedOldLineNumbers: number[] = []
      for (const change of chunk.changes as unknown as ChangeLn[]) {
        if (change.type === 'add') {
          added += 1
          if (typeof change.ln === 'number') addedLineNumbers.push(change.ln)
        } else if (change.type === 'del') {
          removed += 1
          // parse-diff names the old-side line number `ln` on a `del`
          // change and `ln1` is undefined; fall through both possibilities
          // for safety against minor lib version drift.
          const old = change.ln ?? change.ln1
          if (typeof old === 'number') removedOldLineNumbers.push(old)
        }
      }
      deltas.push({
        filePath: target,
        startLine,
        endLine: endLine < startLine ? startLine : endLine,
        addedLineNumbers,
        removedOldLineNumbers,
        added,
        removed,
        raw: chunk.content + '\n' + chunk.changes.map(c => c.content).join('\n'),
      })
    }
  }
  return { deltas, files: [...files] }
}

function stripPrefix(path: string): string {
  if (path === '/dev/null') return ''
  if (path.startsWith('a/')) return path.slice(2)
  if (path.startsWith('b/')) return path.slice(2)
  return path
}
