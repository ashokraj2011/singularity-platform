/**
 * M42.4 — Apply a unified diff to a file safely.
 *
 * Uses the `diff` npm package's `applyPatch` to compute the new file
 * contents. We never write to the live tree directly — the caller can
 * do that after the rest of the guard pipeline accepts.
 */
import { applyPatch } from 'diff'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256 } from '../spec/hash.js'

export interface AppliedFile {
  filePath: string
  before: string
  after: string
  beforeHash: string
  afterHash: string
}

/**
 * Apply a unified diff to the on-disk files. Returns the new file
 * contents WITHOUT writing them — the caller decides when to commit.
 */
export function previewApply(projectDir: string, diff: string): { files: AppliedFile[]; rejected: string[] } {
  // Group the unified diff by file. `diff`'s applyPatch needs one
  // single-file patch at a time, so we partition by `^--- ` headers.
  const patches = partitionByFile(diff)
  const files: AppliedFile[] = []
  const rejected: string[] = []
  for (const p of patches) {
    const filePath = p.targetPath
    if (!filePath) {
      rejected.push('missing target path')
      continue
    }
    const abs = join(projectDir, filePath)
    let before = ''
    try {
      before = readFileSync(abs, 'utf8')
    } catch {
      rejected.push(`${filePath}: file not found`)
      continue
    }
    const result = applyPatch(before, p.body)
    if (result === false) {
      rejected.push(`${filePath}: applyPatch failed (context mismatch)`)
      continue
    }
    files.push({
      filePath,
      before,
      after: result,
      beforeHash: sha256(before),
      afterHash: sha256(result),
    })
  }
  return { files, rejected }
}

interface FilePatch {
  targetPath: string
  body: string
}

function partitionByFile(diff: string): FilePatch[] {
  const out: FilePatch[] = []
  const lines = diff.split(/\r?\n/)
  let header: string | undefined
  let body: string[] = []
  for (const line of lines) {
    if (line.startsWith('--- ')) {
      if (header !== undefined) {
        out.push({ targetPath: extractTarget(header, body), body: body.join('\n') + '\n' })
      }
      header = line
      body = [line]
    } else if (line.startsWith('diff --git ')) {
      // skip git-style headers; the --- / +++ lines below carry the file paths.
      if (header !== undefined) {
        out.push({ targetPath: extractTarget(header, body), body: body.join('\n') + '\n' })
        header = undefined
        body = []
      }
    } else {
      body.push(line)
    }
  }
  if (header !== undefined) {
    out.push({ targetPath: extractTarget(header, body), body: body.join('\n') + '\n' })
  }
  return out
}

function extractTarget(_header: string, body: string[]): string {
  // Grab the +++ line which always immediately follows ---
  const plus = body.find(l => l.startsWith('+++ '))
  if (!plus) return ''
  let path = plus.slice(4).split(/\s+/)[0]
  if (path === '/dev/null') return ''
  if (path.startsWith('a/')) path = path.slice(2)
  if (path.startsWith('b/')) path = path.slice(2)
  return path
}
