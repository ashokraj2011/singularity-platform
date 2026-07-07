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
      case 'listBranches': return this.listBranches(params)
      case 'commitFiles': return this.commitFiles(params)
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

  // Read-only: list the repo's branches. Powers the launch "Branch to clone"
  // picker (and is a normal connector op). Owner/repo default to the connector's
  // configured repo when not passed.
  private async listBranches(p: Record<string, unknown>): Promise<{ branches: string[] }> {
    const { owner, repo } = this.repo(p)
    if (this.config.provider === 'github') {
      const r = await this.ghClient.get(`/repos/${owner}/${repo}/branches`, { params: { per_page: 100 } })
      return { branches: (r.data as Array<{ name: string }>).map(b => b.name) }
    }
    const r = await this.glClient.get(`/projects/${encodeURIComponent(`${owner}/${repo}`)}/repository/branches`, { params: { per_page: 100 } })
    return { branches: (r.data as Array<{ name: string }>).map(b => b.name) }
  }

  // Commit one or more files to a branch in a SINGLE commit via the GitHub Git
  // Data API — creating the branch from `base` when it doesn't exist yet. This is
  // how per-phase deliverables land on wi/<code> CLOUD-SIDE (no laptop runtime).
  // Branch names may contain '/' (e.g. wi/WRK-1); those are literal path segments
  // in the refs API, so the branch is NOT url-encoded here.
  private async commitFiles(p: Record<string, unknown>): Promise<{ committed: boolean; branch?: string; commitSha?: string; fileCount?: number; created?: boolean; reason?: string }> {
    if (this.config.provider !== 'github') {
      throw new Error('commitFiles is currently implemented for GitHub only.')
    }
    const { owner, repo } = this.repo(p)
    const branch = typeof p.branch === 'string' ? p.branch.trim() : ''
    const base = (typeof p.base === 'string' && p.base.trim()) || 'main'
    const message = (typeof p.message === 'string' && p.message.trim()) || 'Update deliverables'
    const files = Array.isArray(p.files)
      ? (p.files as Array<{ path?: unknown; content?: unknown }>)
          .map(f => ({ path: String(f.path ?? ''), content: String(f.content ?? '') }))
          .filter(f => f.path)
      : []
    if (!branch) throw new Error('commitFiles requires a branch.')
    if (files.length === 0) return { committed: false, reason: 'no files to commit' }

    const R = `/repos/${owner}/${repo}`
    const gh = this.ghClient

    // 1. Resolve the branch head; create it from base when missing.
    let parentSha: string
    let created = false
    try {
      const ref = await gh.get(`${R}/git/ref/heads/${branch}`)
      parentSha = (ref.data as { object: { sha: string } }).object.sha
    } catch {
      const baseRef = await gh.get(`${R}/git/ref/heads/${base}`)
      parentSha = (baseRef.data as { object: { sha: string } }).object.sha
      await gh.post(`${R}/git/refs`, { ref: `refs/heads/${branch}`, sha: parentSha })
      created = true
    }

    // 2. Base tree = parent commit's tree; layer the files on top (inline content
    //    → GitHub creates the blobs for us).
    const parentCommit = await gh.get(`${R}/git/commits/${parentSha}`)
    const baseTreeSha = (parentCommit.data as { tree: { sha: string } }).tree.sha
    const tree = files.map(f => ({ path: f.path, mode: '100644' as const, type: 'blob' as const, content: f.content }))
    const newTree = await gh.post(`${R}/git/trees`, { base_tree: baseTreeSha, tree })

    // 3. Create the commit and fast-forward the branch ref onto it.
    const commit = await gh.post(`${R}/git/commits`, {
      message,
      tree: (newTree.data as { sha: string }).sha,
      parents: [parentSha],
    })
    const commitSha = (commit.data as { sha: string }).sha
    await gh.patch(`${R}/git/refs/heads/${branch}`, { sha: commitSha, force: false })

    return { committed: true, branch, commitSha, fileCount: files.length, created }
  }

  listOperations(): OperationDef[] {
    return [
      { id: 'createIssue', label: 'Create Issue', params: [{ key: 'title', label: 'Title', type: 'string', required: true }, { key: 'body', label: 'Body', type: 'text' }] },
      { id: 'listBranches', label: 'List Branches', params: [{ key: 'owner', label: 'Owner', type: 'string' }, { key: 'repo', label: 'Repo', type: 'string' }] },
      { id: 'commitFiles', label: 'Commit Files', params: [{ key: 'branch', label: 'Branch', type: 'string', required: true }, { key: 'base', label: 'Base Branch', type: 'string' }, { key: 'message', label: 'Commit Message', type: 'string' }] },
      { id: 'openPR', label: 'Open Pull Request', params: [{ key: 'title', label: 'Title', type: 'string', required: true }, { key: 'head', label: 'Head Branch', type: 'string', required: true }, { key: 'base', label: 'Base Branch', type: 'string' }, { key: 'body', label: 'Description', type: 'text' }] },
      { id: 'mergePR', label: 'Merge Pull Request', params: [{ key: 'pullNumber', label: 'PR Number', type: 'number', required: true }] },
      { id: 'commentPR', label: 'Comment on PR', params: [{ key: 'pullNumber', label: 'PR Number', type: 'number', required: true }, { key: 'body', label: 'Comment', type: 'text', required: true }] },
      { id: 'createBranch', label: 'Create Branch', params: [{ key: 'branchName', label: 'Branch Name', type: 'string', required: true }, { key: 'fromBranch', label: 'From Branch', type: 'string' }] },
    ]
  }
}
