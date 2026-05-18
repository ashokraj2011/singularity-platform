import axios from 'axios'
import { readFileSync } from 'node:fs'

function checkFlagDisabled(res: { status: number; data?: unknown }): void {
  if (res.status === 503 && (res.data as { code?: string } | undefined)?.code === 'FEATURE_DISABLED') {
    const d = res.data as { flag?: string; message?: string }
    process.stderr.write(`✗ Feature disabled: ${d.flag}\n  ${d.message ?? ''}\n`)
    throw Object.assign(new Error('feature disabled'), { exitCode: 4 })
  }
}

export async function createLlmTasksCommand(opts: { runId: string; api: string }): Promise<void> {
  const url = `${opts.api.replace(/\/$/, '')}/api/codegen/runs/${encodeURIComponent(opts.runId)}/llm-tasks`
  const res = await axios.post(url, undefined, { timeout: 30_000, validateStatus: () => true })
  checkFlagDisabled(res)
  if (res.status >= 400) {
    process.stderr.write(`✗ ${res.status} ${url}\n${JSON.stringify(res.data, null, 2)}\n`)
    throw Object.assign(new Error('create-llm-tasks failed'), { exitCode: 2 })
  }
  const body = res.data as {
    runId: string; created: number
    tasks: Array<{ id: string; gapId: string | null; taskType: string; regionId: string }>
  }
  process.stdout.write(`✓ ${body.created} task${body.created === 1 ? '' : 's'} for run ${body.runId.slice(0, 8)}…\n`)
  for (const t of body.tasks) {
    process.stdout.write(`  ${t.id.slice(0, 8)}  ${t.taskType.padEnd(28)} region='${t.regionId}'  gap=${(t.gapId ?? '').slice(0, 8)}\n`)
  }
}

export async function applyPatchCommand(opts: { taskId: string; patch: string; api: string }): Promise<void> {
  const url = `${opts.api.replace(/\/$/, '')}/api/codegen/llm-tasks/${encodeURIComponent(opts.taskId)}/apply-patch`
  const diff = readFileSync(opts.patch, 'utf8')
  const res = await axios.post(url, diff, {
    headers: { 'content-type': 'text/plain' },
    timeout: 60_000,
    validateStatus: () => true,
  })
  checkFlagDisabled(res)
  if (res.status === 200) {
    const body = res.data as {
      taskId: string; status: string
      appliedFiles: Array<{ path: string; beforeHash: string; afterHash: string }>
      responseHash: string
    }
    process.stdout.write(`✓ ${body.taskId.slice(0, 8)} ${body.status}\n`)
    for (const f of body.appliedFiles) {
      process.stdout.write(`    ${f.path}\n`)
      process.stdout.write(`      before ${f.beforeHash.slice(0, 24)}…\n`)
      process.stdout.write(`      after  ${f.afterHash.slice(0, 24)}…\n`)
    }
    return
  }
  if (res.status === 400) {
    const body = res.data as { taskId?: string; status?: string; stage?: string; reason?: string; details?: unknown }
    process.stderr.write(`✗ Patch Guard rejected (stage=${body.stage}): ${body.reason}\n`)
    if (body.details) process.stderr.write(`  details: ${JSON.stringify(body.details).slice(0, 400)}\n`)
    throw Object.assign(new Error('patch rejected'), { exitCode: 5 })
  }
  process.stderr.write(`✗ ${res.status} ${url}\n${JSON.stringify(res.data, null, 2)}\n`)
  throw Object.assign(new Error('apply-patch failed'), { exitCode: 2 })
}

export async function dispatchTaskCommand(opts: { taskId: string; api: string }): Promise<void> {
  const url = `${opts.api.replace(/\/$/, '')}/api/codegen/llm-tasks/${encodeURIComponent(opts.taskId)}/dispatch`
  const res = await axios.post(url, undefined, { timeout: 90_000, validateStatus: () => true })
  checkFlagDisabled(res)
  if (res.status >= 400) {
    process.stderr.write(`✗ ${res.status} ${url}\n${JSON.stringify(res.data, null, 2)}\n`)
    throw Object.assign(new Error('dispatch failed'), { exitCode: 2 })
  }
  const body = res.data as { taskId: string; status: string; diff?: string; cfCallId?: string; error?: string }
  process.stdout.write(`${body.status === 'OK' ? '✓' : '✗'} dispatch ${body.taskId.slice(0, 8)} — ${body.status}\n`)
  if (body.cfCallId) process.stdout.write(`    cfCallId: ${body.cfCallId}\n`)
  if (body.error) process.stderr.write(`    error:    ${body.error}\n`)
  if (body.diff) {
    process.stdout.write(`    diff body (first 300 chars):\n      ${body.diff.slice(0, 300).replace(/\n/g, '\n      ')}\n`)
  }
}
