import axios from 'axios'
import type { ConnectorAdapter, OperationDef } from '../connector-adapter'

interface JiraConfig { baseUrl: string; defaultProjectKey?: string }
interface JiraCredentials { email: string; apiToken: string }

export class JiraAdapter implements ConnectorAdapter {
  constructor(private config: JiraConfig, private creds: JiraCredentials) {}

  private get client() {
    return axios.create({
      baseURL: `${this.config.baseUrl.replace(/\/$/, '')}/rest/api/3`,
      auth: { username: this.creds.email, password: this.creds.apiToken },
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async testConnection() {
    try {
      await this.client.get('/myself')
      return { ok: true }
    } catch (e: any) { return { ok: false, error: e?.message } }
  }

  async invoke(operation: string, params: Record<string, unknown>) {
    switch (operation) {
      case 'createIssue':    return this.createIssue(params)
      case 'updateIssue':    return this.updateIssue(params)
      case 'transitionIssue': return this.transitionIssue(params)
      case 'addComment':     return this.addComment(params)
      case 'searchIssues':   return this.searchIssues(params)
      case 'getIssue':       return this.getIssue(params)
      default: throw new Error(`Unknown Jira operation: ${operation}`)
    }
  }

  private async createIssue(p: Record<string, unknown>) {
    const r = await this.client.post('/issue', {
      fields: {
        project: { key: (p.projectKey as string) ?? this.config.defaultProjectKey },
        issuetype: { name: p.issueType ?? 'Task' },
        summary: p.summary,
        description: p.description ? {
          type: 'doc', version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: p.description }] }],
        } : undefined,
        priority: p.priority ? { name: p.priority } : undefined,
        assignee: p.assigneeAccountId ? { accountId: p.assigneeAccountId } : undefined,
        labels: p.labels,
      },
    })
    return r.data
  }

  private async updateIssue(p: Record<string, unknown>) {
    const { issueKey, fields } = p as any
    await this.client.put(`/issue/${issueKey}`, { fields })
    return { updated: true, issueKey }
  }

  private async transitionIssue(p: Record<string, unknown>) {
    const { issueKey, transitionId } = p as any
    await this.client.post(`/issue/${issueKey}/transitions`, { transition: { id: transitionId } })
    return { transitioned: true, issueKey }
  }

  private async addComment(p: Record<string, unknown>) {
    const r = await this.client.post(`/issue/${p.issueKey}/comment`, {
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: p.text }] }] },
    })
    return r.data
  }

  private async searchIssues(p: Record<string, unknown>) {
    const r = await this.client.post('/issue/search', { jql: p.jql, maxResults: p.maxResults ?? 50 })
    return r.data
  }

  private async getIssue(p: Record<string, unknown>) {
    const r = await this.client.get(`/issue/${p.issueKey}`)
    return r.data
  }

  listOperations(): OperationDef[] {
    return [
      { id: 'createIssue', label: 'Create Issue', params: [{ key: 'summary', label: 'Summary', type: 'string', required: true }, { key: 'issueType', label: 'Issue Type', type: 'string' }, { key: 'description', label: 'Description', type: 'text' }, { key: 'projectKey', label: 'Project Key', type: 'string' }, { key: 'priority', label: 'Priority', type: 'string' }] },
      { id: 'updateIssue', label: 'Update Issue', params: [{ key: 'issueKey', label: 'Issue Key', type: 'string', required: true }, { key: 'fields', label: 'Fields (JSON)', type: 'json', required: true }] },
      { id: 'transitionIssue', label: 'Transition Issue', params: [{ key: 'issueKey', label: 'Issue Key', type: 'string', required: true }, { key: 'transitionId', label: 'Transition ID', type: 'string', required: true }] },
      { id: 'addComment', label: 'Add Comment', params: [{ key: 'issueKey', label: 'Issue Key', type: 'string', required: true }, { key: 'text', label: 'Comment', type: 'text', required: true }] },
      { id: 'searchIssues', label: 'Search Issues (JQL)', params: [{ key: 'jql', label: 'JQL Query', type: 'string', required: true }, { key: 'maxResults', label: 'Max Results', type: 'number' }] },
      { id: 'getIssue', label: 'Get Issue', params: [{ key: 'issueKey', label: 'Issue Key', type: 'string', required: true }] },
    ]
  }
}
