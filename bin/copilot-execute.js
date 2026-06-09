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
//   node bin/copilot-execute.js --task "Add a hasAnyOf operator" --workspace /path/to/repo
//     [--model <m>] [--copilot-bin <path>] [--timeout-sec 900] [--json]
//
// Prints a JSON receipt to stdout (or a human summary without --json):
//   { success, task, baseSha, headSha, summary, filesChanged[], stat{files,insertions,deletions}, diff, durationMs }
//
// NOTE: the CLI makes the edits itself (governance is via this captured receipt +
// the workspace being a scoped clone), NOT via the platform's per-tool apply_patch
// path. Pair with scoped session tokens + audit upload in the next slice.
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

// ── CLI ─────────────────────────────────────────────────────────────────────
async function main() {
  const receipt = await executeTask({
    task: arg('task'),
    workspace: arg('workspace', process.cwd()),
    model: arg('model'),
    copilotBin: arg('copilot-bin', process.env.COPILOT_BIN || 'copilot'),
    timeoutMs: Number(arg('timeout-sec', 900)) * 1000,
  })
  if (has('json')) {
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n')
  } else {
    const { stat, filesChanged, durationMs } = receipt
    console.log(`\n✔ Copilot CLI executed in ${(durationMs / 1000).toFixed(1)}s`)
    console.log(`  files changed: ${filesChanged.length}  (+${stat.insertions} / -${stat.deletions})`)
    filesChanged.forEach((f) => console.log(`    ${f.status.padEnd(2)} ${f.path}`))
    console.log(`\n  summary:\n${receipt.summary.split('\n').map((l) => '    ' + l).join('\n')}`)
    console.log(`\n  (run with --json for the full receipt incl. the diff)`)
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('copilot-execute error:', e.message); process.exitCode = 1 })
}
module.exports = { parsePorcelain, parseDiffStat, executeTask }
