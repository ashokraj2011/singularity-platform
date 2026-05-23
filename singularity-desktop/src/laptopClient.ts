export type TokenProvider = () => Promise<string> | string

export interface LaptopSdkOptions {
  apiBaseUrl: string
  tokenProvider: TokenProvider
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

type QueueItem = {
  id: string
  method: string
  path: string
  body: unknown
  createdAt: string
}

class LocalRetryQueue {
  private readonly key = 'singularityDesktop.retryQueue'

  private read(): QueueItem[] {
    try {
      return JSON.parse(localStorage.getItem(this.key) ?? '[]') as QueueItem[]
    } catch {
      return []
    }
  }

  private write(items: QueueItem[]) {
    localStorage.setItem(this.key, JSON.stringify(items.slice(-500)))
  }

  enqueue(item: Omit<QueueItem, 'id' | 'createdAt'>): void {
    const items = this.read()
    items.push({
      ...item,
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: new Date().toISOString(),
    })
    this.write(items)
  }

  async flush(send: (item: QueueItem) => Promise<void>): Promise<{ sent: number; remaining: number }> {
    const items = this.read()
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
    this.write(remaining)
    return { sent, remaining: remaining.length }
  }
}

export class SingularityLaptopSdk {
  private readonly apiBaseUrl: string
  private readonly queue = new LocalRetryQueue()

  constructor(private readonly options: LaptopSdkOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '')
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
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
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

  async answer(questionId: string, answer: string): Promise<unknown> {
    return this.request('POST', `/api/questions/${encodeURIComponent(questionId)}/answer`, { answer })
  }

  async sendDurably(method: string, path: string, body: unknown): Promise<void> {
    try {
      await this.request(method, path, body)
    } catch {
      this.queue.enqueue({ method, path, body })
    }
  }

  async flushQueue(): Promise<{ sent: number; remaining: number }> {
    return this.queue.flush(item => this.request(item.method, item.path, item.body))
  }

  startHeartbeat(invocationId: string, intervalMs = 30_000): () => void {
    const timer = window.setInterval(() => {
      void this.heartbeat(invocationId, { sentAt: new Date().toISOString() })
    }, intervalMs)
    return () => window.clearInterval(timer)
  }
}

export async function detectCopilotCli(): Promise<{ available: boolean; command?: string; version?: string; warning?: string }> {
  return {
    available: false,
    command: 'copilot',
    warning: 'Copilot CLI detection requires the Electron main process.',
  }
}
