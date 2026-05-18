import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'dist', '__pycache__', '.venv', '.workspace'])

export interface SourceFile {
  absPath: string
  relPath: string
  content: string
}

export function* walkRepo(root: string, extensions: Set<string>): Generator<SourceFile> {
  function* recurse(dir: string): Generator<SourceFile> {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const e of entries) {
      if (SKIP_DIRS.has(e)) continue
      const abs = join(dir, e)
      let st
      try { st = statSync(abs) } catch { continue }
      if (st.isDirectory()) {
        yield* recurse(abs)
      } else if (st.isFile()) {
        const dot = e.lastIndexOf('.')
        if (dot >= 0 && extensions.has(e.slice(dot))) {
          try {
            yield { absPath: abs, relPath: relative(root, abs), content: readFileSync(abs, 'utf8') }
          } catch {
            // unreadable file; skip
          }
        }
      }
    }
  }
  yield* recurse(root)
}
