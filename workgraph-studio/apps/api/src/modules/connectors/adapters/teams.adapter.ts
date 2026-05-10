import axios from 'axios'
import type { ConnectorAdapter, OperationDef } from '../connector-adapter'

interface TeamsConfig {
  // Simple webhook mode (no Graph API auth needed)
  defaultWebhookUrl?: string
  // Graph API mode
  tenantId?: string
  defaultTeamId?: string
  defaultChannelId?: string
}
interface TeamsCredentials {
  // For Graph API
  clientId?: string
  clientSecret?: string
  // For simple incoming webhook
  webhookUrl?: string
}

export class TeamsAdapter implements ConnectorAdapter {
  private tokenCache: { token: string; expiresAt: number } | null = null

  constructor(private config: TeamsConfig, private creds: TeamsCredentials) {}

  private async getGraphToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.token
    }
    const res = await axios.post(
      `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: this.creds.clientId!,
        client_secret: this.creds.clientSecret!,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    )
    this.tokenCache = { token: res.data.access_token, expiresAt: Date.now() + res.data.expires_in * 1000 }
    return this.tokenCache.token
  }

  async testConnection() {
    try {
      const webhookUrl = this.creds.webhookUrl ?? this.config.defaultWebhookUrl
      if (webhookUrl) {
        // Sending a test ping to webhook
        await axios.post(webhookUrl, { type: 'message', text: '✅ WorkGraph connector connected.' })
        return { ok: true }
      }
      if (this.creds.clientId) {
        await this.getGraphToken()
        return { ok: true }
      }
      return { ok: false, error: 'No webhook URL or Graph credentials configured' }
    } catch (e: any) {
      return { ok: false, error: e?.message }
    }
  }

  async invoke(operation: string, params: Record<string, unknown>) {
    switch (operation) {
      case 'postWebhook': return this.postWebhook(params)
      case 'postAdaptiveCard': return this.postAdaptiveCard(params)
      case 'postChannelMessage': return this.postChannelMessage(params)
      default: throw new Error(`Unknown Teams operation: ${operation}`)
    }
  }

  private async postWebhook(p: Record<string, unknown>) {
    const url = (p.webhookUrl as string) ?? this.creds.webhookUrl ?? this.config.defaultWebhookUrl
    if (!url) throw new Error('No Teams webhook URL configured')
    const res = await axios.post(url, { type: 'message', text: p.text ?? p.message ?? '' })
    return res.data
  }

  private async postAdaptiveCard(p: Record<string, unknown>) {
    const url = (p.webhookUrl as string) ?? this.creds.webhookUrl ?? this.config.defaultWebhookUrl
    if (!url) throw new Error('No Teams webhook URL configured')
    const res = await axios.post(url, {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: p.card,
      }],
    })
    return res.data
  }

  private async postChannelMessage(p: Record<string, unknown>) {
    const token = await this.getGraphToken()
    const teamId = (p.teamId as string) ?? this.config.defaultTeamId
    const channelId = (p.channelId as string) ?? this.config.defaultChannelId
    const res = await axios.post(
      `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${channelId}/messages`,
      { body: { contentType: 'html', content: p.html ?? `<p>${p.text ?? ''}</p>` } },
      { headers: { Authorization: `Bearer ${token}` } },
    )
    return res.data
  }

  listOperations(): OperationDef[] {
    return [
      { id: 'postWebhook', label: 'Post Message (Webhook)', params: [{ key: 'text', label: 'Message', type: 'text', required: true }, { key: 'webhookUrl', label: 'Override Webhook URL', type: 'string' }] },
      { id: 'postAdaptiveCard', label: 'Post Adaptive Card', params: [{ key: 'card', label: 'Adaptive Card JSON', type: 'json', required: true }, { key: 'webhookUrl', label: 'Override Webhook URL', type: 'string' }] },
      { id: 'postChannelMessage', label: 'Post Channel Message (Graph API)', params: [{ key: 'text', label: 'Message', type: 'text', required: true }, { key: 'teamId', label: 'Team ID override', type: 'string' }, { key: 'channelId', label: 'Channel ID override', type: 'string' }] },
    ]
  }
}
