import axios from 'axios'
import type { ConnectorAdapter, OperationDef } from '../connector-adapter'

interface EmailConfig {
  provider: 'sendgrid' | 'mailgun' | 'ses_api' | 'smtp'
  fromAddress: string
  fromName?: string
  // SMTP only
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: boolean
}
interface EmailCredentials {
  apiKey?: string       // sendgrid / mailgun / SES
  smtpUser?: string
  smtpPass?: string
  mailgunDomain?: string
  sesRegion?: string
}

export class EmailAdapter implements ConnectorAdapter {
  constructor(private config: EmailConfig, private creds: EmailCredentials) {}

  async testConnection() {
    try {
      if (this.config.provider === 'sendgrid') {
        await axios.get('https://api.sendgrid.com/v3/user/profile', {
          headers: { Authorization: `Bearer ${this.creds.apiKey}` },
        })
      } else if (this.config.provider === 'mailgun') {
        const domain = this.creds.mailgunDomain ?? 'sandbox'
        await axios.get(`https://api.mailgun.net/v3/${domain}`, {
          auth: { username: 'api', password: this.creds.apiKey ?? '' },
        })
      }
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message }
    }
  }

  async invoke(operation: string, params: Record<string, unknown>) {
    if (operation === 'sendEmail') return this.sendEmail(params)
    throw new Error(`Unknown email operation: ${operation}`)
  }

  private async sendEmail(p: Record<string, unknown>) {
    const { to, cc, bcc, subject, text, html, attachments } = p as any
    const from = `${this.config.fromName ?? ''} <${this.config.fromAddress}>`.trim()

    if (this.config.provider === 'sendgrid') {
      const res = await axios.post('https://api.sendgrid.com/v3/mail/send', {
        from: { email: this.config.fromAddress, name: this.config.fromName },
        personalizations: [{ to: [].concat(to).map((t: string) => ({ email: t })), cc: cc ? [].concat(cc).map((e: string) => ({ email: e })) : undefined, bcc: bcc ? [].concat(bcc).map((e: string) => ({ email: e })) : undefined }],
        subject,
        content: [
          ...(text ? [{ type: 'text/plain', value: text }] : []),
          ...(html ? [{ type: 'text/html', value: html }] : []),
        ],
      }, { headers: { Authorization: `Bearer ${this.creds.apiKey}`, 'Content-Type': 'application/json' } })
      return { messageId: res.headers['x-message-id'] }
    }

    if (this.config.provider === 'mailgun') {
      const domain = this.creds.mailgunDomain!
      const form = new URLSearchParams()
      form.set('from', from)
      ;[].concat(to).forEach((t: string) => form.append('to', t))
      if (subject) form.set('subject', subject)
      if (text) form.set('text', text)
      if (html) form.set('html', html)
      const res = await axios.post(`https://api.mailgun.net/v3/${domain}/messages`, form, {
        auth: { username: 'api', password: this.creds.apiKey ?? '' },
      })
      return res.data
    }

    throw new Error(`SMTP not supported in serverless mode — use sendgrid or mailgun provider`)
  }

  listOperations(): OperationDef[] {
    return [{
      id: 'sendEmail', label: 'Send Email',
      params: [
        { key: 'to', label: 'To (email or array)', type: 'string', required: true },
        { key: 'subject', label: 'Subject', type: 'string', required: true },
        { key: 'text', label: 'Plain text body', type: 'text' },
        { key: 'html', label: 'HTML body', type: 'text' },
        { key: 'cc', label: 'CC', type: 'string' },
        { key: 'bcc', label: 'BCC', type: 'string' },
      ],
    }]
  }
}
