export type TokenProvider = () => Promise<string> | string

export interface LaptopSdkOptions {
  apiBaseUrl: string
  tokenProvider: TokenProvider
  queueDir?: string
}

export interface StartInvocationInput {
  client?: string
  mode?: 'direct-copilot' | 'server-runtime'
  capabilityId?: string
  agentTemplateId?: string
  repoUrl?: string
  branch?: string
  baseCommitSha?: string
  task?: string
  agentSpec?: Record<string, unknown>
  data?: Record<string, unknown>
}

export interface LaptopInvocationStart {
  invocation: { id: string; workItemId: string; status: string; client: string; mode: string }
  agentRun: { id: string }
  mcp: { url: string; token: string; tokenJti: string; expiresAt: string; scopes: string[] }
  prompt: { assemblyId: string | null; content: string; warnings: string[] }
}

export interface CopilotProcess {
  child: unknown
  wait(): Promise<number>
}

type QueueItem = {
  id: string
  method: string
  path: string
  body: unknown
  createdAt: string
}

export class LocalRetryQueue {
  private memory: QueueItem[] = []

  constructor(private readonly filePath = defaultQueueFilePath()) {}

  private async read(): Promise<QueueItem[]> {
    if (!this.filePath) return this.memory
    try {
      const { readFile } = await import('node:fs/promises')
      return JSON.parse(await readFile(this.filePath, 'utf8')) as QueueItem[]
    } catch {
      return []
    }
  }

  private async write(items: QueueItem[]): Promise<void> {
    if (!this.filePath) {
      this.memory = items.slice(-500)
      return
    }
    const { dirname } = await import('node:path')
    const { mkdir, rename, writeFile } = await import('node:fs/promises')
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(items.slice(-500), null, 2), 'utf8')
    await rename(tmp, this.filePath)
  }

  async enqueue(item: Omit<QueueItem, 'id' | 'createdAt'>): Promise<void> {
    const items = await this.read()
    items.push({ ...item, id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, createdAt: new Date().toISOString() })
    await this.write(items)
  }

  async flush(send: (item: QueueItem) => Promise<void>): Promise<{ sent: number; remaining: number }> {
    const items = await this.read()
    const remaining: QueueItem[] = []
    let sent = 0
    for (const item of items) {
      try {
        await send(item)
        sent += 1
      } catch {
        remaining.push(item)
      }
    }
    if (remaining.length === 0 && this.filePath) {
      const { rm } = await import('node:fs/promises')
      await rm(this.filePath, { force: true })
    }
    else await this.write(remaining)
    return { sent, remaining: remaining.length }
  }
}

function defaultQueueFilePath(): string | undefined {
  const home = typeof process !== 'undefined' ? process.env.HOME || process.env.USERPROFILE : undefined
  return home ? `${home}/.singularity/laptop-sdk/retry-queue.json` : undefined
}

export class SingularityLaptopSdk {
  private readonly apiBaseUrl: string
  private readonly queue: LocalRetryQueue

  constructor(private readonly options: LaptopSdkOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '')
    this.queue = new LocalRetryQueue(options.queueDir ? `${options.queueDir.replace(/\/+$/, '')}/retry-queue.json` : undefined)
  }

  private async token(): Promise<string> {
    return await this.options.tokenProvider()
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`)
    }
    return await res.json() as T
  }

  async startInvocation(workItemId: string, input: StartInvocationInput = {}): Promise<LaptopInvocationStart> {
    return this.request<LaptopInvocationStart>('POST', `/api/work-items/${encodeURIComponent(workItemId)}/laptop-invocations`, input)
  }

  async heartbeat(invocationId: string, data: Record<string, unknown> = {}): Promise<void> {
    await this.sendDurably('POST', `/api/laptop-invocations/${encodeURIComponent(invocationId)}/heartbeat`, { data })
  }

  async complete(invocationId: string, status: 'COMPLETED' | 'FAILED' | 'CANCELLED', payload: Record<string, unknown> = {}): Promise<void> {
    await this.sendDurably('POST', `/api/laptop-invocations/${encodeURIComponent(invocationId)}/complete`, { status, payload })
  }

  async ask(invocationId: string, question: string, context: Record<string, unknown> = {}) {
    return this.request('POST', `/api/laptop-invocations/${encodeURIComponent(invocationId)}/questions`, { question, context })
  }

  async answer(questionId: string, answer: string) {
    return this.request('POST', `/api/questions/${encodeURIComponent(questionId)}/answer`, { answer })
  }

  async sendDurably(method: string, path: string, body: unknown): Promise<void> {
    try {
      await this.request(method, path, body)
    } catch {
      await this.queue.enqueue({ method, path, body })
    }
  }

  async flushQueue() {
    return this.queue.flush(item => this.request(item.method, item.path, item.body))
  }

  async spawnCopilot(args: string[] = [], cwd = typeof process !== 'undefined' ? process.cwd() : '.', env: Record<string, string> = {}): Promise<CopilotProcess> {
    const { spawn } = await import('node:child_process')
    const child = spawn('copilot', args, {
      cwd,
      env: { ...(typeof process !== 'undefined' ? process.env : {}), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return {
      child,
      wait: () => new Promise(resolve => child.on('close', code => resolve(code ?? 0))),
    }
  }

  startHeartbeat(invocationId: string, intervalMs = 30_000): () => void {
    const timer = setInterval(() => {
      void this.heartbeat(invocationId, { sentAt: new Date().toISOString() })
    }, intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }
}

export async function detectCopilotCli(): Promise<{ available: boolean; version?: string; warning?: string }> {
  if (typeof process === 'undefined') return { available: false, warning: 'Copilot CLI detection requires the desktop main process or CLI.' }
  const { spawn } = await import('node:child_process')
  return new Promise(resolve => {
    const child = spawn('copilot', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', chunk => { out += String(chunk) })
    child.stderr.on('data', chunk => { out += String(chunk) })
    child.on('error', () => resolve({ available: false, warning: 'copilot CLI not found on PATH' }))
    child.on('close', code => {
      if (code !== 0) return resolve({ available: false, warning: out.trim() || 'copilot --version failed' })
      const version = out.trim().match(/\d+\.\d+\.\d+/)?.[0] ?? out.trim()
      const warning = version && !/^1\.0\./.test(version)
        ? 'Copilot CLI version is outside the pinned 1.0.x compatibility range; session log format may differ.'
        : undefined
      resolve({ available: true, version, warning })
    })
  })
}
