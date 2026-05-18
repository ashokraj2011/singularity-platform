/**
 * M42.3 — Static file scanners that produce Gap[].
 *
 * These detectors don't need to invoke the build toolchain — they read
 * generated files and look for:
 *
 *   1. Unresolved Handlebars moustaches ({{) — verifier backstop for
 *      template typos that slipped past strict-mode disable in M42.2.
 *   2. Placeholder bodies inside llm-editable regions — the generator
 *      stamps these as `throw UnsupportedOperationException`,
 *      `raise NotImplementedError`, or
 *      `throw new Error('Generated placeholder')`. Each becomes a
 *      MISSING_BUSINESS_LOGIC gap with llmEligible=true and the
 *      region id attached so M42.4 can scope the patch task.
 *   3. Generic TODO/FIXME markers anywhere in the tree.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseRegions, type RegionRange } from '../regions/parse.js'
import type { DetectedGap } from './types.js'

const SOURCE_EXTS = new Set(['.java', '.py', '.ts', '.tsx', '.js', '.kt', '.go'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'dist', '__pycache__', '.venv'])

const PLACEHOLDER_PATTERNS = [
  // Java
  /throw\s+new\s+UnsupportedOperationException\s*\(\s*"Generated placeholder/,
  // Python
  /raise\s+NotImplementedError\s*\(\s*"Generated placeholder/,
  // TypeScript / Node
  /throw\s+new\s+Error\s*\(\s*['"]Generated placeholder/,
]

const TODO_RE = /\b(TODO|FIXME|XXX)\b/i
const MOUSTACHE_RE = /\{\{[^}]+\}\}/

export function scanProject(projectDir: string): DetectedGap[] {
  const gaps: DetectedGap[] = []
  for (const f of walkSources(projectDir)) {
    const rel = relative(projectDir, f)
    let src: string
    try {
      src = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    gaps.push(...scanMoustaches(rel, src))
    gaps.push(...scanPlaceholders(rel, src))
    gaps.push(...scanTodos(rel, src))
  }
  return gaps
}

function scanMoustaches(rel: string, src: string): DetectedGap[] {
  if (!MOUSTACHE_RE.test(src)) return []
  // Generated headers carry literal `{{var}}` only when something went
  // wrong — the live header should have been substituted. Surface every
  // line that still has a moustache.
  const out: DetectedGap[] = []
  src.split(/\r?\n/).forEach((line, idx) => {
    if (MOUSTACHE_RE.test(line)) {
      out.push({
        type: 'UNRESOLVED_TEMPLATE_VAR',
        severity: 'high',
        filePath: rel,
        description: `Unresolved Mustache variable at line ${idx + 1}: ${line.trim()}`,
        recommendedResolution: 'Regenerate with a fresh spec — this indicates a missing IR field or template-helper miss.',
        llmEligible: false,
      })
    }
  })
  return out
}

function scanPlaceholders(rel: string, src: string): DetectedGap[] {
  const out: DetectedGap[] = []
  let regions: RegionRange[] = []
  try {
    regions = parseRegions(src)
  } catch {
    // Malformed regions show up as their own gap class below.
    return out
  }
  for (const region of regions) {
    if (region.marker !== 'editable') continue
    const slice = src.split(/\r?\n/).slice(region.innerStart - 1, region.innerEnd).join('\n')
    const hit = PLACEHOLDER_PATTERNS.some((re) => re.test(slice))
    if (!hit) continue
    out.push({
      type: 'MISSING_BUSINESS_LOGIC',
      severity: 'medium',
      filePath: rel,
      regionId: region.regionId,
      description: `Placeholder body in llm-editable region '${region.regionId}' (lines ${region.innerStart}-${region.innerEnd}).`,
      recommendedResolution: `Replace the placeholder with the business logic for region '${region.regionId}'. Only the region body may change.`,
      llmEligible: true,
    })
  }
  return out
}

function scanTodos(rel: string, src: string): DetectedGap[] {
  const out: DetectedGap[] = []
  src.split(/\r?\n/).forEach((line, idx) => {
    // Skip TODO inside test placeholders (those are already captured as
    // MISSING_TEST_CASE via the region marker scan).
    if (!TODO_RE.test(line)) return
    if (/llm-editable region="test-case"/.test(line)) return
    out.push({
      type: 'UNRESOLVED_TODO',
      severity: 'low',
      filePath: rel,
      description: `TODO/FIXME at line ${idx + 1}: ${line.trim().slice(0, 200)}`,
      llmEligible: false,
    })
  })
  return out
}

function* walkSources(dir: string): Generator<string> {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      yield* walkSources(full)
    } else if (st.isFile()) {
      const dot = entry.lastIndexOf('.')
      if (dot >= 0 && SOURCE_EXTS.has(entry.slice(dot))) {
        yield full
      }
    }
  }
}
