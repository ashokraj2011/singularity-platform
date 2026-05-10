import axios from 'axios'
import type { ConnectorAdapter, OperationDef } from '../connector-adapter'

interface GitConfig {
  provider: 'github' | 'gitlab'
  baseUrl?: string   // for self-hosted gitlab
  defaultOwner?: string
  defaultRepo?: string
}
interface GitCredentials { token: string }

export class GitAdapter implements ConnectorAdapter {
  constructor(private config: GitConfig, private creds: GitCredentials) {}

  private get ghClient() {
    return axios.create({
      baseURL: 'https://api.github.com',
      headers: { Authorization: `Bearer ${this.creds.token}`, Accept: 'application/vnd.github+json' },
    })
  }

  private get glClient() {
    return axios.create({
      baseURL: `${(this.config.baseUrl ?? 'https://gitlab.com').replace(/\/$/, '')}/api/v4`,
      headers: { 'PRIVATE-TOKEN': this.creds.token },
    })
  }

  async testConnection() {
    try {
      if (this.config.provider === 'github') await this.ghClient.get('/user')
      else await this.glClient.get('/user')
      return { ok: true }
    } catch (e: any) { return { ok: false, error: e?.message } }
  }

  async invoke(operation: string, params: Record<string, unknown>) {
    switch (operation) {
      case 'createIssue': return this.createIssue(params)
      case 'openPR':      return this.openPR(params)
      case 'mergePR':     return this.mergePR(params)
      case 'commentPR':   return this.commentPR(params)
      case 'createBranch': return this.createBranch(params)
      default: throw new Error(`Unknown Git operation: ${operation}`)
    }
  }

  private repo(p: Record<string, unknown>) {
    return { owner: (p.owner as string) ?? this.config.defaultOwner, repo: (p.repo as string) ?? this.config.defaultRepo }
  }

  private async createIssue(p: Record<string, unknown>) {
    const { owner, repo } = this.repo(p)
    if (this.config.provider === 'github') {
      const r = await this.ghClient.post(`/repos/${owner}/${repo}/issues`, { title: p.title, body: p.body, labels: p.labels, assignees: p.assignees })
      return r.data
    }
    const r = await this.glClient.post(`/projects/${encodeURIComponent(`${owner}/${repo}`)}/issues`, { title: p.title, description: p.body, labels: (p.labels as string[])?.join(',') })
    return r.data
  }

  private async openPR(p: Record<string, unknown>) {
    const { owner, repo } = this.repo(p)
    if (this.config.provider === 'github') {
      const r = await this.ghClient.post(`/repos/${owner}/${repo}/pulls`, { title: p.title, body: p.body, head: p.head, base: p.base ?? 'main' })
      return r.data
    }
    const r = await this.glClient.post(`/projects/${encodeURIComponent(`${owner}/${repo}`)}/merge_requests`, { title: p.title, description: p.body, source_branch: p.head, target_branch: p.base ?? 'main' })
    return r.data
  }

  private async mergePR(p: Record<string, unknown>) {
    const { owner, repo } = this.repo(p)
    if (this.config.provider === 'github') {
      const r = await this.ghClient.put(`/repos/${owner}/${repo}/pulls/${p.pullNumber}/merge`, { merge_method: p.mergeMethod ?? 'squash' })
      return r.data
    }
    const r = await this.glClient.put(`/projects/${encodeURIComponent(`${owner}/${repo}`)}/merge_requests/${p.pullNumber}/merge`)
    return r.data
  }

  private async commentPR(p: Record<string, unknown>) {
    const { owner, repo } = this.repo(p)
    if (this.config.provider === 'github') {
      const r = await this.ghClient.post(`/repos/${owner}/${repo}/issues/${p.pullNumber}/comments`, { body: p.body })
      return r.data
    }
    const r = await this.glClient.post(`/projects/${encodeURIComponent(`${owner}/${repo}`)}/merge_requests/${p.pullNumber}/notes`, { body: p.body })
    return r.data
  }

  private async createBranch(p: Record<string, unknown>) {
    const { owner, repo } = this.repo(p)
    if (this.config.provider === 'github') {
      const ref = await this.ghClient.get(`/repos/${owner}/${repo}/git/ref/heads/${p.fromBranch ?? 'main'}`)
      const r = await this.ghClient.post(`/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${p.branchName}`, sha: ref.data.object.sha })
      return r.data
    }
    const r = await this.glClient.post(`/projects/${encodeURIComponent(`${owner}/${repo}`)}/repository/branches`, { branch: p.branchName, ref: p.fromBranch ?? 'main' })
    return r.data
  }

  listOperations(): OperationDef[] {
    return [
      { id: 'createIssue', label: 'Create Issue', params: [{ key: 'title', label: 'Title', type: 'string', required: true }, { key: 'body', label: 'Body', type: 'text' }] },
      { id: 'openPR', label: 'Open Pull Request', params: [{ key: 'title', label: 'Title', type: 'string', required: true }, { key: 'head', label: 'Head Branch', type: 'string', required: true }, { key: 'base', label: 'Base Branch', type: 'string' }, { key: 'body', label: 'Description', type: 'text' }] },
      { id: 'mergePR', label: 'Merge Pull Request', params: [{ key: 'pullNumber', label: 'PR Number', type: 'number', required: true }] },
      { id: 'commentPR', label: 'Comment on PR', params: [{ key: 'pullNumber', label: 'PR Number', type: 'number', required: true }, { key: 'body', label: 'Comment', type: 'text', required: true }] },
      { id: 'createBranch', label: 'Create Branch', params: [{ key: 'branchName', label: 'Branch Name', type: 'string', required: true }, { key: 'fromBranch', label: 'From Branch', type: 'string' }] },
    ]
  }
}
