import axios from 'axios'
import type { ConnectorAdapter, OperationDef } from '../connector-adapter'

interface HttpConfig {
  baseUrl: string
  defaultHeaders?: Record<string, string>
  timeoutMs?: number
}
interface HttpCredentials {
  bearerToken?: string
  basicUser?: string
  basicPass?: string
  apiKey?: string
  apiKeyHeader?: string
}

export class HttpAdapter implements ConnectorAdapter {
  constructor(private config: HttpConfig, private creds: HttpCredentials) {}

  private get client() {
    const headers: Record<string, string> = { ...this.config.defaultHeaders }
    if (this.creds.bearerToken) headers['Authorization'] = `Bearer ${this.creds.bearerToken}`
    if (this.creds.apiKey) headers[this.creds.apiKeyHeader ?? 'X-Api-Key'] = this.creds.apiKey
    return axios.create({
      baseURL: this.config.baseUrl,
      headers,
      timeout: this.config.timeoutMs ?? 30_000,
      auth: this.creds.basicUser ? { username: this.creds.basicUser, password: this.creds.basicPass ?? '' } : undefined,
    })
  }

  async testConnection() {
    try {
      await this.client.get('/')
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message }
    }
  }

  async invoke(operation: string, params: Record<string, unknown>) {
    const { method = 'POST', path = '/', body, queryParams } = params as any
    const res = await this.client.request({ method, url: path, data: body, params: queryParams })
    return res.data
  }

  listOperations(): OperationDef[] {
    return [
      {
        id: 'request', label: 'HTTP Request',
        params: [
          { key: 'method', label: 'Method', type: 'string', description: 'GET|POST|PUT|PATCH|DELETE' },
          { key: 'path', label: 'Path', type: 'string', required: true },
          { key: 'body', label: 'Body', type: 'json' },
          { key: 'queryParams', label: 'Query Params', type: 'json' },
        ],
      },
    ]
  }
}
