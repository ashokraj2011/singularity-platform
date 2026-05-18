/**
 * M42.5 — CLI commands for the brownfield surface.
 *
 *   singularity-codegen scan-repo         POST /api/codegen/repos/scan
 *   singularity-codegen plan-enhancement  POST /api/codegen/enhancements/plan
 *   singularity-codegen apply-change-plan POST /api/codegen/enhancements/apply
 *
 * Each command renders a short human summary on stdout and writes the
 * full response JSON to --out when supplied (or stdout if --out=-).
 */
import axios from 'axios'
import { readFileSync, writeFileSync } from 'node:fs'
import yaml from 'yaml'

const FEATURE_OFF = 'FEATURE_DISABLED'

interface CommonOpts {
  api: string
  actor?: string
}

export async function scanRepoCommand(opts: CommonOpts & { repo: string; framework?: string; out?: string }): Promise<void> {
  const url = `${opts.api.replace(/\/$/, '')}/api/codegen/repos/scan`
  const body: Record<string, unknown> = { repoPath: opts.repo }
  if (opts.framework) body.framework = opts.framework
  const res = await postJson(url, body, opts.actor)
  if (!handleFeatureOff(res, 'brownfield')) {
    bail(res, url, 'scan-repo')
  }
  const data = res.data as {
    repoModelId: string
    modelHash: string
    summary: Record<string, unknown>
  }
  process.stdout.write(`✓ Repo scanned: ${opts.repo}\n`)
  process.stdout.write(`    repoModelId: ${data.repoModelId}\n`)
  process.stdout.write(`    modelHash:   ${data.modelHash}\n`)
  process.stdout.write(`    summary:     ${JSON.stringify(data.summary)}\n`)
  if (opts.out) writeOut(opts.out, res.data)
}

export async function planEnhancementCommand(opts: CommonOpts & {
  spec: string
  repoModelId: string
  out?: string
}): Promise<void> {
  const enhancement = yaml.parse(readFileSync(opts.spec, 'utf8')) as unknown
  const url = `${opts.api.replace(/\/$/, '')}/api/codegen/enhancements/plan`
  const res = await postJson(url, { repoModelId: opts.repoModelId, enhancement }, opts.actor)
  if (!handleFeatureOff(res, 'brownfield')) {
    bail(res, url, 'plan-enhancement')
  }
  const data = res.data as {
    changePlanId: string
    planHash: string
    enhancementSpecHash: string
    repoModelHash: string
    impact: { knownPattern: boolean; affectedFiles: string[]; requiresHumanApproval: boolean }
    plan: { operations: Array<{ operation: string; targetFile: string; deterministic: boolean }> }
  }
  process.stdout.write(`✓ Change plan built\n`)
  process.stdout.write(`    changePlanId:        ${data.changePlanId}\n`)
  process.stdout.write(`    planHash:            ${data.planHash}\n`)
  process.stdout.write(`    enhancementSpecHash: ${data.enhancementSpecHash}\n`)
  process.stdout.write(`    repoModelHash:       ${data.repoModelHash}\n`)
  process.stdout.write(`    knownPattern:        ${data.impact.knownPattern}\n`)
  process.stdout.write(`    affected files:      ${data.impact.affectedFiles.length}\n`)
  process.stdout.write(`    operations:\n`)
  for (const op of data.plan.operations) {
    process.stdout.write(`      ${op.deterministic ? 'D' : 'L'}  ${op.operation.padEnd(28)}  ${op.targetFile}\n`)
  }
  if (opts.out) writeOut(opts.out, res.data)
}

export async function applyChangePlanCommand(opts: CommonOpts & {
  changePlanId: string
  apply?: boolean
  out?: string
}): Promise<void> {
  const url = `${opts.api.replace(/\/$/, '')}/api/codegen/enhancements/apply`
  const res = await postJson(url, { changePlanId: opts.changePlanId, apply: opts.apply ?? true }, opts.actor)
  if (!handleFeatureOff(res, 'brownfield')) {
    bail(res, url, 'apply-change-plan')
  }
  const data = res.data as {
    status: string
    planStatus: string
    reason?: string
    edits: Array<{ filePath: string; bytesWritten: number; beforeHash: string | null; afterHash: string }>
    llmTasks: Array<{ taskType: string; targetFile: string; regionId: string }>
    unresolvedOperations: unknown[]
    recipeNotes: string[]
  }
  process.stdout.write(`✓ Dispatch status: ${data.status} (plan: ${data.planStatus})\n`)
  if (data.reason) process.stdout.write(`  reason: ${data.reason}\n`)
  process.stdout.write(`    edits:        ${data.edits.length}\n`)
  for (const e of data.edits) {
    process.stdout.write(`      ${e.bytesWritten.toString().padStart(6)}b  ${e.filePath}\n`)
  }
  process.stdout.write(`    llmTasks:     ${data.llmTasks.length}\n`)
  for (const t of data.llmTasks) {
    process.stdout.write(`      ${t.taskType.padEnd(24)}  region=${t.regionId}  ${t.targetFile}\n`)
  }
  if (data.unresolvedOperations.length > 0) {
    process.stdout.write(`    unresolved:   ${data.unresolvedOperations.length}\n`)
  }
  if (data.recipeNotes.length > 0) {
    process.stdout.write(`    notes:\n`)
    for (const n of data.recipeNotes) process.stdout.write(`      - ${n}\n`)
  }
  if (opts.out) writeOut(opts.out, res.data)
}

async function postJson(url: string, body: unknown, actor?: string) {
  return axios.post(url, body, {
    headers: {
      'content-type': 'application/json',
      ...(actor ? { 'x-actor-id': actor } : {}),
    },
    timeout: 60_000,
    validateStatus: () => true,
  })
}

function handleFeatureOff(res: { status: number; data: unknown }, name: string): boolean {
  if (res.status === 503 && (res.data as { code?: string } | null)?.code === FEATURE_OFF) {
    const d = res.data as { flag: string; disabledAncestor: string; message: string }
    process.stderr.write(`✗ Feature disabled: ${d.flag} (${d.disabledAncestor})\n`)
    process.stderr.write(`  ${d.message}\n`)
    throw Object.assign(new Error(`${name} feature disabled`), { exitCode: 4 })
  }
  return true
}

function bail(res: { status: number; data: unknown }, url: string, name: string): void {
  if (res.status >= 400) {
    process.stderr.write(`✗ ${name}: ${res.status} ${url}\n`)
    process.stderr.write(`  ${JSON.stringify(res.data, null, 2)}\n`)
    throw Object.assign(new Error(`${name} failed`), { exitCode: 2 })
  }
}

function writeOut(target: string, data: unknown): void {
  const text = JSON.stringify(data, null, 2)
  if (target === '-') process.stdout.write(text + '\n')
  else writeFileSync(target, text + '\n', 'utf8')
}
