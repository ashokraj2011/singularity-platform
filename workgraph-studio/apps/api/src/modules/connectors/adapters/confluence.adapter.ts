import axios from 'axios'
import type { ConnectorAdapter, OperationDef } from '../connector-adapter'

interface ConfluenceConfig { baseUrl: string; defaultSpaceKey?: string }
interface ConfluenceCredentials { email: string; apiToken: string }

export class ConfluenceAdapter implements ConnectorAdapter {
  constructor(private config: ConfluenceConfig, private creds: ConfluenceCredentials) {}

  private get client() {
    return axios.create({
      baseURL: `${this.config.baseUrl.replace(/\/$/, '')}/wiki/rest/api`,
      auth: { username: this.creds.email, password: this.creds.apiToken },
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async testConnection() {
    try { await this.client.get('/space?limit=1'); return { ok: true } }
    catch (e: any) { return { ok: false, error: e?.message } }
  }

  async invoke(operation: string, params: Record<string, unknown>) {
    switch (operation) {
      case 'createPage':  return this.createPage(params)
      case 'updatePage':  return this.updatePage(params)
      case 'addComment':  return this.addComment(params)
      case 'getPage':     return this.getPage(params)
      case 'searchPages': return this.searchPages(params)
      default: throw new Error(`Unknown Confluence operation: ${operation}`)
    }
  }

  private async createPage(p: Record<string, unknown>) {
    const r = await this.client.post('/content', {
      type: 'page',
      title: p.title,
      space: { key: (p.spaceKey as string) ?? this.config.defaultSpaceKey },
      ancestors: p.parentId ? [{ id: p.parentId }] : undefined,
      body: { storage: { value: p.body ?? '', representation: 'storage' } },
    })
    return r.data
  }

  private async updatePage(p: Record<string, unknown>) {
    const current = await this.client.get(`/content/${p.pageId}`)
    const r = await this.client.put(`/content/${p.pageId}`, {
      type: 'page', title: p.title ?? current.data.title,
      version: { number: current.data.version.number + 1 },
      body: { storage: { value: p.body ?? '', representation: 'storage' } },
    })
    return r.data
  }

  private async addComment(p: Record<string, unknown>) {
    const r = await this.client.post('/content', {
      type: 'comment', container: { id: p.pageId, type: 'page' },
      body: { storage: { value: p.body ?? '', representation: 'storage' } },
    })
    return r.data
  }

  private async getPage(p: Record<string, unknown>) {
    const r = await this.client.get(`/content/${p.pageId}?expand=body.storage,version`)
    return r.data
  }

  private async searchPages(p: Record<string, unknown>) {
    const r = await this.client.get('/content/search', { params: { cql: p.cql, limit: p.limit ?? 25 } })
    return r.data
  }

  listOperations(): OperationDef[] {
    return [
      { id: 'createPage', label: 'Create Page', params: [{ key: 'title', label: 'Title', type: 'string', required: true }, { key: 'body', label: 'Body (Storage format HTML)', type: 'text', required: true }, { key: 'spaceKey', label: 'Space Key', type: 'string' }, { key: 'parentId', label: 'Parent Page ID', type: 'string' }] },
      { id: 'updatePage', label: 'Update Page', params: [{ key: 'pageId', label: 'Page ID', type: 'string', required: true }, { key: 'body', label: 'Body', type: 'text', required: true }, { key: 'title', label: 'New Title', type: 'string' }] },
      { id: 'addComment', label: 'Add Comment', params: [{ key: 'pageId', label: 'Page ID', type: 'string', required: true }, { key: 'body', label: 'Comment body', type: 'text', required: true }] },
      { id: 'searchPages', label: 'Search Pages (CQL)', params: [{ key: 'cql', label: 'CQL Query', type: 'string', required: true }] },
    ]
  }
}
