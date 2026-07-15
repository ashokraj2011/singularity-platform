/**
 * Reconciliation runner — a standalone, out-of-process executor for the dynamic reconciliation
 * layer (spec §15, "Layer 2"). It consumes the workgraph-api reconciliation-job queue built in the
 * dynamic-layer PR and runs an implementer's declared tests OFF the request path:
 *
 *   loop: GET  /api/reconciliation-jobs                 → pending jobs
 *         POST /api/reconciliation-jobs/:id/claim       → { …job, claimToken }   (409 = lost)
 *         checkout headCommit → run testPlan            → TestResult[]
 *         POST /api/reconciliation-jobs/:id/complete    { claimToken, tests }
 *         POST /api/reconciliation-jobs/:id/fail        { claimToken, error }     (on checkout error)
 *
 * Claim is an atomic single-winner and complete/fail are gated by the returned claimToken (same
 * fencing as PendingExecution), so multiple runners can poll the same queue safely.
 *
 *   WORKGRAPH_API_URL             base URL of workgraph-api (e.g. http://localhost:8080)
 *   RECONCILIATION_RUNNER_TOKEN   bearer token authorized to poll/claim/complete
 *   RUNNER_TENANT_ID              X-Tenant-Id (required under strict tenant isolation)
 *   RECON_GIT_BASE_URL            prefix for "org/repo" repositories (default https://github.com/)
 *   RECON_DEFAULT_TEST_COMMAND    command for obligations with none (e.g. "npm test")
 *   RECON_WORK_DIR                parent dir for checkouts (default os.tmpdir())
 *   RECON_POLL_INTERVAL_MS        (default 5000)   RECON_HTTP_TIMEOUT_MS (default 30000)
 *   RECON_COMMAND_TIMEOUT_MS      per-command kill timeout (default 600000)
 */
import { execFile as execFileCb } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  runReconciliationJob,
  type RunnerJob,
  type RunnerExec,
  type TestResult,
  type CommandOutcome,
  type CheckoutHandle,
} from './runner.core'

const execFileP = promisify(execFileCb)

export interface RunnerConfig {
  apiBase: string
  authToken: string
  tenantId?: string
  gitBaseUrl: string
  gitAllowedHosts: string[]
  defaultCommand?: string
  workDir: string
  pollIntervalMs: number
  httpTimeoutMs: number
  commandTimeoutMs: number
}

function log(msg: string, extra?: Record<string, unknown>): void {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : ''
  console.log(`[reconciliation-runner] ${msg}${suffix}`)
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.floor(n), min), max)
}

export function loadRunnerConfig(): RunnerConfig {
  const apiBase = (process.env.WORKGRAPH_API_URL ?? '').replace(/\/$/, '')
  if (!apiBase) throw new Error('WORKGRAPH_API_URL is required to run the reconciliation runner')
  const authToken = process.env.RECONCILIATION_RUNNER_TOKEN ?? ''
  if (!authToken) throw new Error('RECONCILIATION_RUNNER_TOKEN is required to run the reconciliation runner')
  return {
    apiBase,
    authToken,
    tenantId: process.env.RUNNER_TENANT_ID?.trim() || undefined,
    gitBaseUrl: (process.env.RECON_GIT_BASE_URL ?? 'https://github.com/').replace(/\/?$/, '/'),
    gitAllowedHosts: (process.env.RECON_GIT_ALLOWED_HOSTS ?? 'github.com,gitlab.com,bitbucket.org').split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
    defaultCommand: process.env.RECON_DEFAULT_TEST_COMMAND?.trim() || undefined,
    workDir: process.env.RECON_WORK_DIR?.trim() || tmpdir(),
    pollIntervalMs: intEnv('RECON_POLL_INTERVAL_MS', 5_000, 500, 60_000),
    httpTimeoutMs: intEnv('RECON_HTTP_TIMEOUT_MS', 30_000, 1_000, 600_000),
    commandTimeoutMs: intEnv('RECON_COMMAND_TIMEOUT_MS', 600_000, 1_000, 3_600_000),
  }
}

function headers(cfg: RunnerConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${cfg.authToken}`,
    ...(cfg.tenantId ? { 'x-tenant-id': cfg.tenantId } : {}),
  }
}

async function httpJson(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal })
    const text = await resp.text()
    let body: unknown
    if (text.trim()) { try { body = JSON.parse(text) } catch { body = text } }
    return { status: resp.status, body }
  } finally {
    clearTimeout(timer)
  }
}

// ── Job API client ────────────────────────────────────────────────────────────
async function pollJobs(cfg: RunnerConfig): Promise<RunnerJob[]> {
  const { status, body } = await httpJson(`${cfg.apiBase}/api/reconciliation-jobs`, { method: 'GET', headers: headers(cfg) }, cfg.httpTimeoutMs)
  if (status !== 200) throw new Error(`poll failed (HTTP ${status})`)
  const items = (body as { items?: RunnerJob[] } | undefined)?.items
  return Array.isArray(items) ? items : []
}

async function claimJob(cfg: RunnerConfig, id: string): Promise<RunnerJob | null> {
  const { status, body } = await httpJson(`${cfg.apiBase}/api/reconciliation-jobs/${encodeURIComponent(id)}/claim`, { method: 'POST', headers: headers(cfg) }, cfg.httpTimeoutMs)
  if (status === 409) return null // another runner won the claim
  if (status !== 200) throw new Error(`claim failed (HTTP ${status})`)
  const job = body as RunnerJob | undefined
  return job?.claimToken ? job : null
}

async function completeJob(cfg: RunnerConfig, id: string, claimToken: string, tests: TestResult[]): Promise<void> {
  const { status } = await httpJson(`${cfg.apiBase}/api/reconciliation-jobs/${encodeURIComponent(id)}/complete`, { method: 'POST', headers: headers(cfg), body: JSON.stringify({ claimToken, tests }) }, cfg.httpTimeoutMs)
  if (status !== 200 && status !== 409) throw new Error(`complete failed (HTTP ${status})`)
}

async function failJob(cfg: RunnerConfig, id: string, claimToken: string, error: string): Promise<void> {
  const { status } = await httpJson(`${cfg.apiBase}/api/reconciliation-jobs/${encodeURIComponent(id)}/fail`, { method: 'POST', headers: headers(cfg), body: JSON.stringify({ claimToken, error }) }, cfg.httpTimeoutMs)
  if (status !== 200 && status !== 409) throw new Error(`fail failed (HTTP ${status})`)
}

// ── Real side-effecting deps (git + shell) ──────────────────────────────────────
function repoUrl(cfg: RunnerConfig, repository: string): string {
  const value = /^(https?:\/\/|ssh:\/\/)/.test(repository)
    ? repository
    : `${cfg.gitBaseUrl}${repository.replace(/\.git$/, '')}.git`
  if (!/^https:\/\//.test(value)) throw new Error('Only HTTPS Git repositories are allowed for isolated reconciliation runners')
  const parsed = new URL(value)
  if (!cfg.gitAllowedHosts.includes(parsed.hostname.toLowerCase())) throw new Error(`Git host ${parsed.hostname} is not in RECON_GIT_ALLOWED_HOSTS`)
  return parsed.toString()
}

function safeCommand(command: string): { executable: string; args: string[] } {
  const source = command.trim()
  if (!source || /[;&|<>$()`\n\r]/.test(source)) throw new Error('Runner commands must be executable plus argument array; shell operators are forbidden')
  const tokens: string[] = []
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) tokens.push(match[1] ?? match[2] ?? match[3])
  if (!tokens.length || tokens.join(' ') !== source.replace(/\s+/g, ' ').trim()) throw new Error('Runner command contains unsupported quoting or whitespace')
  const executable = tokens.shift()!
  const allowed = (process.env.RECON_ALLOWED_COMMANDS ?? 'npm,pnpm,yarn,node,python,python3,pytest,go,cargo,mvn,gradle,make').split(',').map(value => value.trim())
  if (!allowed.includes(executable)) throw new Error(`Runner executable ${executable} is not allowed`)
  return { executable, args: tokens }
}

function isolatedEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: tmpdir(),
    CI: '1',
    NODE_ENV: 'test',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
}

export function realRunnerExec(cfg: RunnerConfig): RunnerExec {
  return {
    defaultCommand: cfg.defaultCommand,
    async checkout(job: RunnerJob): Promise<CheckoutHandle> {
      const dir = await mkdtemp(join(cfg.workDir, 'recon-'))
      const url = repoUrl(cfg, job.repository)
      // Full clone (not shallow) so an arbitrary head commit is reachable, then hard-checkout it.
      await execFileP('git', ['clone', '--no-tags', url, dir], { timeout: cfg.commandTimeoutMs, maxBuffer: 32 * 1024 * 1024, env: isolatedEnv() })
      await execFileP('git', ['-C', dir, 'checkout', '--quiet', job.headCommitSha], { timeout: cfg.commandTimeoutMs, maxBuffer: 32 * 1024 * 1024, env: isolatedEnv() })
      return { cwd: dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
    },
    async runCommand(command: string, cwd: string): Promise<CommandOutcome> {
      try {
        const parsed = safeCommand(command)
        const { stdout, stderr } = await execFileP(parsed.executable, parsed.args, { cwd, timeout: cfg.commandTimeoutMs, maxBuffer: 32 * 1024 * 1024, shell: false, env: isolatedEnv() })
        return { code: 0, output: `${stdout}${stderr}` }
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string; message?: string }
        const output = `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message || 'command failed'
        return { code: typeof e.code === 'number' ? e.code : 1, output }
      }
    },
  }
}

// ── Poll loop ───────────────────────────────────────────────────────────────────
async function processOne(cfg: RunnerConfig, exec: RunnerExec, jobId: string): Promise<void> {
  const job = await claimJob(cfg, jobId)
  if (!job || !job.claimToken) return // lost the claim (409) — skip
  const claimToken = job.claimToken
  try {
    const tests = await runReconciliationJob(job, exec)
    await completeJob(cfg, job.id, claimToken, tests)
    log('completed', { id: job.id, run: job.reconciliationRunId, tests: tests.length })
  } catch (err) {
    // Could not check out / run the plan at all → fail the job so the run doesn't hang RUNNING.
    const message = err instanceof Error ? err.message : String(err)
    await failJob(cfg, job.id, claimToken, message).catch((e) => log('fail error', { id: job.id, error: (e as Error).message }))
    log('failed', { id: job.id, error: message })
  }
}

export async function runPollLoop(cfg: RunnerConfig = loadRunnerConfig(), opts: { signal?: AbortSignal; exec?: RunnerExec } = {}): Promise<void> {
  const exec = opts.exec ?? realRunnerExec(cfg)
  log('starting', { api: cfg.apiBase, interval: cfg.pollIntervalMs, defaultCommand: cfg.defaultCommand ?? '(none)' })
  while (!opts.signal?.aborted) {
    try {
      const jobs = await pollJobs(cfg)
      for (const job of jobs) {
        if (opts.signal?.aborted) break
        await processOne(cfg, exec, job.id).catch((e) => log('process error', { id: job.id, error: (e as Error).message }))
      }
    } catch (err) {
      log('poll cycle error', { error: err instanceof Error ? err.message : String(err) })
    }
    await new Promise((resolve) => setTimeout(resolve, cfg.pollIntervalMs))
  }
  log('stopped')
}

if (require.main === module) {
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())
  process.on('SIGTERM', () => controller.abort())
  runPollLoop(loadRunnerConfig(), { signal: controller.signal }).catch((err) => {
    console.error(`[reconciliation-runner] fatal: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
