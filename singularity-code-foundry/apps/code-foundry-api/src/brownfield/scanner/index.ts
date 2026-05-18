/**
 * M42.5 — Scanner dispatcher.
 *
 * Routes to the right per-stack scanner. Caller can either pass the
 * (language, framework) pair explicitly or let `detectStack()`
 * heuristically pick from the contents of the repo root.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanSpringBoot } from './springboot.js'
import { scanFastApi } from './fastapi.js'
import { scanExpress } from './express.js'
import type { Framework, Language, RepoModel } from '../types.js'

export function scanRepo(repoPath: string, opts?: { framework?: Framework; language?: Language }): RepoModel {
  const fw = opts?.framework ?? detectStack(repoPath)
  switch (fw) {
    case 'spring-boot': return scanSpringBoot(repoPath)
    case 'fastapi':     return scanFastApi(repoPath)
    case 'express':     return scanExpress(repoPath)
    default:
      throw new Error(`Cannot determine framework for repo at '${repoPath}'. Pass --framework spring-boot|fastapi|express.`)
  }
}

export function detectStack(repoPath: string): Framework | undefined {
  // Hints: pom.xml + src/main/java → spring-boot.
  if (existsSync(join(repoPath, 'pom.xml'))) {
    return 'spring-boot'
  }
  // pyproject.toml + a fastapi dep → fastapi.
  const py = join(repoPath, 'pyproject.toml')
  if (existsSync(py)) {
    try {
      const txt = readFileSync(py, 'utf8')
      if (/fastapi/i.test(txt)) return 'fastapi'
    } catch { /* fall through */ }
    return 'fastapi'
  }
  // package.json + express dep → express.
  const pkg = join(repoPath, 'package.json')
  if (existsSync(pkg)) {
    try {
      const txt = readFileSync(pkg, 'utf8')
      if (/"express"\s*:/.test(txt)) return 'express'
    } catch { /* fall through */ }
  }
  // Last-resort sniff: a src/main/java tree without pom.xml.
  try {
    if (existsSync(join(repoPath, 'src', 'main', 'java'))) return 'spring-boot'
    const entries = readdirSync(repoPath)
    if (entries.some(e => e.endsWith('.py'))) return 'fastapi'
    if (entries.some(e => e === 'tsconfig.json')) return 'express'
  } catch { /* ignore */ }
  return undefined
}

export { scanSpringBoot, scanFastApi, scanExpress }
