import crypto from 'node:crypto'

const PREFIX = 'enc:v1'

function productionLike(): boolean {
  const value = String(process.env.APP_ENV ?? process.env.SINGULARITY_ENV ?? process.env.NODE_ENV ?? '').toLowerCase()
  return value === 'production' || value === 'staging'
}

function key(): Buffer {
  const dedicated = process.env.WORKGRAPH_EVENT_SECRET_KEY?.trim()
  if ((!dedicated || /^(dev-|changeme|demo-)/i.test(dedicated)) && productionLike()) {
    throw new Error('WORKGRAPH_EVENT_SECRET_KEY is required to protect event-subscription HMAC secrets in production/staging')
  }
  const material = dedicated || process.env.JWT_SECRET?.trim()
  if (!material || material.length < 16) {
    throw new Error('WORKGRAPH_EVENT_SECRET_KEY (or development JWT_SECRET fallback) must be at least 16 characters')
  }
  return crypto.createHash('sha256').update(material).digest()
}

export function sealSubscriptionSecret(value: string | null | undefined): string | null {
  const plaintext = value?.trim()
  if (!plaintext) return null
  if (plaintext.startsWith(`${PREFIX}:`)) return plaintext
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [PREFIX, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':')
}

export function openSubscriptionSecret(value: string | null | undefined): string | null {
  if (!value) return null
  if (!value.startsWith(`${PREFIX}:`)) return value
  const parts = value.split(':')
  if (parts.length !== 5) throw new Error('event-subscription secret ciphertext is malformed')
  const iv = Buffer.from(parts[2], 'base64url')
  const tag = Buffer.from(parts[3], 'base64url')
  const ciphertext = Buffer.from(parts[4], 'base64url')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export function publicSubscription<T extends { secret?: string | null }>(subscription: T): Omit<T, 'secret'> & { secretConfigured: boolean } {
  const { secret, ...safe } = subscription
  return { ...safe, secretConfigured: Boolean(secret) }
}
