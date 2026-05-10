import axios from 'axios'
import type { ConnectorAdapter, OperationDef } from '../connector-adapter'

interface DatadogConfig { site?: string }  // e.g. datadoghq.eu
interface DatadogCredentials { apiKey: string; appKey?: string }

export class DatadogAdapter implements ConnectorAdapter {
  constructor(private config: DatadogConfig, private creds: DatadogCredentials) {}

  private get client() {
    const site = this.config.site ?? 'datadoghq.com'
    return axios.create({
      baseURL: `https://api.${site}/api/v2`,
      headers: { 'DD-API-KEY': this.creds.apiKey, 'DD-APPLICATION-KEY': this.creds.appKey ?? '', 'Content-Type': 'application/json' },
    })
  }

  async testConnection() {
    try { await this.client.get('/validate'); return { ok: true } }
    catch (e: any) { return { ok: false, error: e?.message } }
  }

  async invoke(operation: string, params: Record<string, unknown>) {
    switch (operation) {
      case 'submitEvent':   return this.submitEvent(params)
      case 'submitMetric':  return this.submitMetric(params)
      case 'queryLogs':     return this.queryLogs(params)
      case 'createMonitor': return this.createMonitor(params)
      case 'muteMonitor':   return this.muteMonitor(params)
      default: throw new Error(`Unknown Datadog operation: ${operation}`)
    }
  }

  private async submitEvent(p: Record<string, unknown>) {
    const r = await this.client.post('/events', {
      data: {
        type: 'event',
        attributes: {
          title: p.title,
          text: p.text,
          priority: p.priority ?? 'normal',
          tags: p.tags ?? [],
          alert_type: p.alertType ?? 'info',
        },
      },
    })
    return r.data
  }

  private async submitMetric(p: Record<string, unknown>) {
    const r = await this.client.post('/series', {
      series: [{
        metric: p.metric,
        type: p.type ?? 0,
        points: [{ timestamp: Math.floor(Date.now() / 1000), value: p.value }],
        tags: p.tags ?? [],
      }],
    })
    return r.data
  }

  private async queryLogs(p: Record<string, unknown>) {
    const r = await this.client.post('/logs/events/search', {
      filter: { query: p.query, from: p.from ?? 'now-1h', to: p.to ?? 'now' },
      page: { limit: p.limit ?? 25 },
    })
    return r.data
  }

  private async createMonitor(p: Record<string, unknown>) {
    const site = this.config.site ?? 'datadoghq.com'
    const r = await axios.post(`https://api.${site}/api/v1/monitor`, {
      type: p.type ?? 'metric alert',
      query: p.query,
      name: p.name,
      message: p.message,
      tags: p.tags,
    }, { headers: { 'DD-API-KEY': this.creds.apiKey, 'DD-APPLICATION-KEY': this.creds.appKey ?? '' } })
    return r.data
  }

  private async muteMonitor(p: Record<string, unknown>) {
    const site = this.config.site ?? 'datadoghq.com'
    const r = await axios.post(`https://api.${site}/api/v1/monitor/${p.monitorId}/mute`, {}, {
      headers: { 'DD-API-KEY': this.creds.apiKey, 'DD-APPLICATION-KEY': this.creds.appKey ?? '' },
    })
    return r.data
  }

  listOperations(): OperationDef[] {
    return [
      { id: 'submitEvent', label: 'Submit Event', params: [{ key: 'title', label: 'Title', type: 'string', required: true }, { key: 'text', label: 'Text', type: 'text' }, { key: 'alertType', label: 'Alert Type (info/warning/error)', type: 'string' }, { key: 'tags', label: 'Tags (JSON array)', type: 'json' }] },
      { id: 'submitMetric', label: 'Submit Metric', params: [{ key: 'metric', label: 'Metric Name', type: 'string', required: true }, { key: 'value', label: 'Value', type: 'number', required: true }, { key: 'tags', label: 'Tags', type: 'json' }] },
      { id: 'queryLogs', label: 'Query Logs', params: [{ key: 'query', label: 'Log Query', type: 'string', required: true }, { key: 'from', label: 'From (e.g. now-1h)', type: 'string' }, { key: 'to', label: 'To', type: 'string' }] },
      { id: 'createMonitor', label: 'Create Monitor', params: [{ key: 'name', label: 'Name', type: 'string', required: true }, { key: 'query', label: 'Query', type: 'string', required: true }, { key: 'message', label: 'Alert Message', type: 'text' }] },
      { id: 'muteMonitor', label: 'Mute Monitor', params: [{ key: 'monitorId', label: 'Monitor ID', type: 'number', required: true }] },
    ]
  }
}
