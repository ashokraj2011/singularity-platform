#!/usr/bin/env node
'use strict'
// copilot-execute — "Copilot CLI as executor" (platform-handbook §13.4, slice 1).
//
// Hands a task to the official GitHub Copilot CLI INSIDE a git workspace, lets it
// do the agentic work (read/edit files, run commands), then captures the result
// as a structured CODE-CHANGE RECEIPT (the diff + changed files + a summary) that
// the platform can audit. This is the executor model for governed code stages
// when the CLI is the only Copilot access (no copilot-api / function-calling):
// instead of the cloud loop driving tool-calls, the laptop delegates the whole
// stage to the CLI and we capture evidence.
//
//   Standalone (slice 1):
//     node bin/copilot-execute.js --task "Add a hasAnyOf operator" --workspace /path/to/repo
//       [--model <m>] [--copilot-bin <path>] [--timeout-sec 900] [--json]
//
//   Governed, attached to a WorkItem (slice 2):
//     node bin/copilot-execute.js --work-item <uuid> --workspace /path/to/repo \
//       --platform http://localhost:8080/api --token <iam-jwt>  [--task <override>]
//     → POSTs /work-items/<id>/laptop-invocations (mints a SCOPED session token +
//       returns the platform-assembled stage prompt), runs the CLI on that prompt,
//       then POSTs /laptop-invocations/<id>/complete with the receipt as the
//       code-change evidence. (--token via $SINGULARITY_TOKEN, platform via
//       $SINGULARITY_API.)
//
// Prints a JSON receipt to stdout (--json) or a human summary:
//   { success, task, baseSha, headSha, summary, filesChanged[], stat, diff, durationMs,
//     workItemId?, invocationId?, sessionTokenJti? }
//
// NOTE: the CLI makes the edits itself (governance is via this captured receipt +
// the scoped workspace + the WorkItem invocation), NOT via the platform's per-tool
// apply_patch path. Next slices: heartbeats/questions + a Develop-stage mode.
const { spawn } = require('node:child_process')
const fs = require('node:fs')

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def
}
const has = (name) => process.argv.includes(`--${name}`)

// ── pure parsers (unit-tested) ────────────────────────────────────────────────
function parsePorcelain(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter(Boolean)
    .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }))
}

function parseDiffStat(stdout) {
  // last line of `git diff --stat`: " 3 files changed, 42 insertions(+), 5 deletions(-)"
  const last = String(stdout || '').trim().split('\n').pop() || ''
  const num = (re) => { const m = last.match(re); return m ? parseInt(m[1], 10) : 0 }
  return {
    files: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?\(\+\)/),
    deletions: num(/(\d+) deletions?\(-\)/),
  }
}

// ── runners ───────────────────────────────────────────────────────────────────
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    let out = '', err = ''
    let timer = null
    if (opts.timeoutMs) timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} reject(new Error(`${cmd} timed out`)) }, opts.timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e) })
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, out, err }) })
  })
}
const git = (cwd, args) => run('git', args, { cwd }).then((r) => r.out)

async function executeTask({ task, workspace, model, copilotBin = 'copilot', timeoutMs = 900_000 }) {
  if (!task) throw new Error('--task is required')
  if (!fs.existsSync(workspace)) throw new Error(`workspace not found: ${workspace}`)
  // must be a git repo so we can capture the change as evidence
  const inside = (await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workspace }).catch(() => ({ out: '' }))).out.trim()
  if (inside !== 'true') throw new Error(`${workspace} is not a git work tree (needed to capture the code-change receipt)`)

  const baseSha = (await git(workspace, ['rev-parse', 'HEAD']).catch(() => '')).trim()
  const startedAt = Date.now()

  const cliArgs = ['-p', task, '--allow-all']
  if (model) cliArgs.push('--model', model)
  const res = await run(copilotBin, cliArgs, { cwd: workspace, timeoutMs })
  if (res.code !== 0 && !res.out.trim()) {
    throw new Error(`copilot CLI exited ${res.code}: ${(res.err || '').slice(0, 500)}`)
  }

  const headSha = (await git(workspace, ['rev-parse', 'HEAD']).catch(() => baseSha)).trim()
  const porcelain = await git(workspace, ['status', '--porcelain']).catch(() => '')
  const diff = await git(workspace, ['diff']).catch(() => '')
  const stat = parseDiffStat(await git(workspace, ['diff', '--stat']).catch(() => ''))
  const filesChanged = parsePorcelain(porcelain)

  return {
    success: true,
    task,
    baseSha,
    headSha,
    summary: res.out.trim(),
    filesChanged,
    stat,
    diff,
    durationMs: Date.now() - startedAt,
  }
}

// ── §13.4 slice 2 — attach to a WorkItem + scoped session token ───────────────
async function platformFetch(base, path, token, init = {}) {
  const url = base.replace(/\/$/, '') + path
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers || {}) },
  })
  const text = await res.text()
  let body
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → ${res.status}: ${String(body.message || body.error || text || '').slice(0, 300)}`)
  return body
}

// Build the audit payload the platform's /complete endpoint stores. Pure — tested.
function receiptPayload(receipt) {
  return {
    summary: receipt.summary,
    filesChanged: receipt.filesChanged,
    stat: receipt.stat,
    baseSha: receipt.baseSha,
    headSha: receipt.headSha,
    durationMs: receipt.durationMs,
    executor: 'copilot-cli',
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function runStandalone() {
  const receipt = await executeTask({
    task: arg('task'),
    workspace: arg('workspace', process.cwd()),
    model: arg('model'),
    copilotBin: arg('copilot-bin', process.env.COPILOT_BIN || 'copilot'),
    timeoutMs: Number(arg('timeout-sec', 900)) * 1000,
  })
  printReceipt(receipt)
}

async function runForWorkItem(workItemId) {
  const platform = arg('platform', process.env.SINGULARITY_API || 'http://localhost:8080/api')
  const token = arg('token', process.env.SINGULARITY_TOKEN)
  if (!token) throw new Error('--token (or $SINGULARITY_TOKEN) is required to attach to a work-item')

  // 1. Attach → scoped MCP session token + the platform-assembled stage prompt.
  console.error(`▸ attaching to work-item ${workItemId} @ ${platform} …`)
  const started = await platformFetch(platform, `/work-items/${encodeURIComponent(workItemId)}/laptop-invocations`, token, {
    method: 'POST',
    body: JSON.stringify({ client: 'copilot-execute', mode: 'direct-copilot', task: arg('task'), repoUrl: arg('repo-url'), capabilityId: arg('capability') }),
  })
  const invocationId = started.invocation && started.invocation.id
  if (!invocationId) throw new Error(`start returned no invocation id: ${JSON.stringify(started).slice(0, 200)}`)
  const sessionJti = started.mcp && started.mcp.tokenJti
  console.error(`  invocation ${invocationId} · scoped token ${sessionJti || '—'} · scopes [${(started.mcp && started.mcp.scopes || []).join(', ')}]`)

  // 2. Prefer the platform-composed governed prompt; fall back to --task.
  const taskToRun = arg('task') || (started.prompt && started.prompt.content)
  if (!taskToRun) throw new Error('no --task given and the platform did not assemble a prompt for this work-item')
  if (!arg('task')) console.error(`  using platform-assembled prompt (assembly ${started.prompt && started.prompt.assemblyId})`)

  // 3. Run the Copilot CLI executor in the workspace.
  let receipt
  try {
    receipt = await executeTask({
      task: taskToRun,
      workspace: arg('workspace', process.cwd()),
      model: arg('model'),
      copilotBin: arg('copilot-bin', process.env.COPILOT_BIN || 'copilot'),
      timeoutMs: Number(arg('timeout-sec', 900)) * 1000,
    })
  } catch (e) {
    await platformFetch(platform, `/laptop-invocations/${encodeURIComponent(invocationId)}/complete`, token, {
      method: 'POST', body: JSON.stringify({ status: 'FAILED', payload: { error: e.message, executor: 'copilot-cli' } }),
    }).catch(() => {})
    throw e
  }

  // 4. Stamp + complete the invocation with the receipt.
  receipt.workItemId = workItemId
  receipt.invocationId = invocationId
  receipt.sessionTokenJti = sessionJti
  await platformFetch(platform, `/laptop-invocations/${encodeURIComponent(invocationId)}/complete`, token, {
    method: 'POST', body: JSON.stringify({ status: 'COMPLETED', payload: receiptPayload(receipt) }),
  })
  console.error(`✔ invocation ${invocationId} completed — receipt uploaded to work-item ${workItemId}`)
  printReceipt(receipt)
}

function printReceipt(receipt) {
  if (has('json')) { process.stdout.write(JSON.stringify(receipt, null, 2) + '\n'); return }
  const { stat, filesChanged, durationMs } = receipt
  console.log(`\n✔ Copilot CLI executed in ${(durationMs / 1000).toFixed(1)}s`)
  console.log(`  files changed: ${filesChanged.length}  (+${stat.insertions} / -${stat.deletions})`)
  filesChanged.forEach((f) => console.log(`    ${f.status.padEnd(2)} ${f.path}`))
  console.log(`\n  summary:\n${String(receipt.summary).split('\n').map((l) => '    ' + l).join('\n')}`)
  console.log(`\n  (run with --json for the full receipt incl. the diff)`)
}

async function main() {
  const workItemId = arg('work-item')
  if (workItemId) await runForWorkItem(workItemId)
  else await runStandalone()
}

if (require.main === module) {
  main().catch((e) => { console.error('copilot-execute error:', e.message); process.exitCode = 1 })
}
module.exports = { parsePorcelain, parseDiffStat, executeTask, receiptPayload }
