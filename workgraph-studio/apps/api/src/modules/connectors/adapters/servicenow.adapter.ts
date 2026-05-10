import axios from 'axios'
import type { ConnectorAdapter, OperationDef } from '../connector-adapter'

interface ServiceNowConfig { instanceUrl: string; defaultAssignmentGroup?: string }
interface ServiceNowCredentials { username: string; password: string }

export class ServiceNowAdapter implements ConnectorAdapter {
  constructor(private config: ServiceNowConfig, private creds: ServiceNowCredentials) {}

  private get client() {
    return axios.create({
      baseURL: `${this.config.instanceUrl.replace(/\/$/, '')}/api/now`,
      auth: { username: this.creds.username, password: this.creds.password },
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    })
  }

  async testConnection() {
    try { await this.client.get('/table/sys_user?sysparm_limit=1'); return { ok: true } }
    catch (e: any) { return { ok: false, error: e?.message } }
  }

  async invoke(operation: string, params: Record<string, unknown>) {
    switch (operation) {
      case 'createIncident': return this.createIncident(params)
      case 'updateIncident': return this.updateIncident(params)
      case 'createCR':       return this.createCR(params)
      case 'closeCR':        return this.closeCR(params)
      case 'lookupCI':       return this.lookupCI(params)
      case 'getRecord':      return this.getRecord(params)
      default: throw new Error(`Unknown ServiceNow operation: ${operation}`)
    }
  }

  private async createIncident(p: Record<string, unknown>) {
    const r = await this.client.post('/table/incident', {
      short_description: p.shortDescription,
      description: p.description,
      urgency: p.urgency ?? '3',
      impact: p.impact ?? '3',
      assignment_group: (p.assignmentGroup as string) ?? this.config.defaultAssignmentGroup,
      category: p.category,
    })
    return r.data.result
  }

  private async updateIncident(p: Record<string, unknown>) {
    const r = await this.client.patch(`/table/incident/${p.sysId}`, p.fields ?? {})
    return r.data.result
  }

  private async createCR(p: Record<string, unknown>) {
    const r = await this.client.post('/table/change_request', {
      short_description: p.shortDescription,
      description: p.description,
      type: p.type ?? 'normal',
      risk: p.risk ?? '3',
      assignment_group: (p.assignmentGroup as string) ?? this.config.defaultAssignmentGroup,
    })
    return r.data.result
  }

  private async closeCR(p: Record<string, unknown>) {
    const r = await this.client.patch(`/table/change_request/${p.sysId}`, {
      state: '3',
      close_code: p.closeCode ?? 'successful',
      close_notes: p.closeNotes ?? 'Completed via WorkGraph',
    })
    return r.data.result
  }

  private async lookupCI(p: Record<string, unknown>) {
    const r = await this.client.get(`/table/cmdb_ci?sysparm_query=name=${encodeURIComponent(p.name as string)}&sysparm_limit=5`)
    return r.data.result
  }

  private async getRecord(p: Record<string, unknown>) {
    const r = await this.client.get(`/table/${p.table}/${p.sysId}`)
    return r.data.result
  }

  listOperations(): OperationDef[] {
    return [
      { id: 'createIncident', label: 'Create Incident', params: [{ key: 'shortDescription', label: 'Short Description', type: 'string', required: true }, { key: 'description', label: 'Description', type: 'text' }, { key: 'urgency', label: 'Urgency (1-3)', type: 'string' }, { key: 'impact', label: 'Impact (1-3)', type: 'string' }] },
      { id: 'updateIncident', label: 'Update Incident', params: [{ key: 'sysId', label: 'Sys ID', type: 'string', required: true }, { key: 'fields', label: 'Fields (JSON)', type: 'json', required: true }] },
      { id: 'createCR', label: 'Create Change Request', params: [{ key: 'shortDescription', label: 'Short Description', type: 'string', required: true }, { key: 'type', label: 'Type (normal/standard/emergency)', type: 'string' }] },
      { id: 'closeCR', label: 'Close Change Request', params: [{ key: 'sysId', label: 'Sys ID', type: 'string', required: true }, { key: 'closeCode', label: 'Close Code', type: 'string' }, { key: 'closeNotes', label: 'Close Notes', type: 'text' }] },
      { id: 'lookupCI', label: 'Lookup CI', params: [{ key: 'name', label: 'CI Name', type: 'string', required: true }] },
    ]
  }
}
