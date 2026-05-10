import axios from 'axios'
import type { ConnectorAdapter, OperationDef } from '../connector-adapter'

interface SlackConfig { defaultChannel?: string }
interface SlackCredentials { botToken?: string; webhookUrl?: string }

export class SlackAdapter implements ConnectorAdapter {
  constructor(private config: SlackConfig, private creds: SlackCredentials) {}

  private get api() {
    return axios.create({
      baseURL: 'https://slack.com/api',
      headers: { Authorization: `Bearer ${this.creds.botToken}`, 'Content-Type': 'application/json' },
    })
  }

  async testConnection() {
    try {
      if (this.creds.botToken) {
        const r = await this.api.post('/auth.test')
        return r.data.ok ? { ok: true } : { ok: false, error: r.data.error }
      }
      if (this.creds.webhookUrl) {
        await axios.post(this.creds.webhookUrl, { text: '✅ WorkGraph Slack connector online.' })
        return { ok: true }
      }
      return { ok: false, error: 'No token or webhook URL' }
    } catch (e: any) { return { ok: false, error: e?.message } }
  }

  async invoke(operation: string, params: Record<string, unknown>) {
    switch (operation) {
      case 'postMessage': return this.postMessage(params)
      case 'postWebhook': return this.postWebhook(params)
      default: throw new Error(`Unknown Slack operation: ${operation}`)
    }
  }

  private async postMessage(p: Record<string, unknown>) {
    const r = await this.api.post('/chat.postMessage', {
      channel: (p.channel as string) ?? this.config.defaultChannel,
      text: p.text,
      blocks: p.blocks,
    })
    if (!r.data.ok) throw new Error(`Slack error: ${r.data.error}`)
    return r.data
  }

  private async postWebhook(p: Record<string, unknown>) {
    const url = (p.webhookUrl as string) ?? this.creds.webhookUrl
    if (!url) throw new Error('No Slack webhook URL configured')
    const r = await axios.post(url, { text: p.text, blocks: p.blocks })
    return r.data
  }

  listOperations(): OperationDef[] {
    return [
      { id: 'postMessage', label: 'Post Message', params: [{ key: 'text', label: 'Message', type: 'text', required: true }, { key: 'channel', label: 'Channel override', type: 'string' }] },
      { id: 'postWebhook', label: 'Post via Webhook', params: [{ key: 'text', label: 'Message', type: 'text', required: true }, { key: 'webhookUrl', label: 'Webhook URL override', type: 'string' }] },
    ]
  }
}
