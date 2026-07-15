import { createHash } from 'node:crypto'

const SENSITIVE_KEY = /(authorization|access[_-]?token|api[_-]?key|client[_-]?secret|cookie|credential|password|private[_-]?key|secret|token)/i
const DEFAULT_MAX_BYTES = 256 * 1024

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
}

function sanitize(value: unknown, depth: number): unknown {
  if (depth > 8) return '[REDACTED:MAX_DEPTH]'
  if (Array.isArray(value)) return value.slice(0, 500).map(item => sanitize(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED:SENSITIVE]' : sanitize(child, depth + 1)
  }
  return output
}

export function maxEventPayloadBytes(): number {
  const raw = Number(process.env.WORKFLOW_EVENT_PAYLOAD_MAX_BYTES ?? DEFAULT_MAX_BYTES)
  return Number.isFinite(raw) && raw > 1024 ? Math.min(Math.floor(raw), 10 * 1024 * 1024) : DEFAULT_MAX_BYTES
}

export function redactEventPayload(value: unknown): Record<string, unknown> {
  const safe = sanitize(value, 0)
  if (bytes(safe) <= maxEventPayloadBytes()) return (safe && typeof safe === 'object' && !Array.isArray(safe)) ? safe as Record<string, unknown> : { value: safe }
  const serialized = JSON.stringify(safe ?? null)
  return {
    _redacted: 'payload_too_large',
    originalBytes: Buffer.byteLength(serialized, 'utf8'),
    sha256: createHash('sha256').update(serialized).digest('hex'),
  }
}

export function assertEventPayloadSize(value: unknown): void {
  const size = bytes(value)
  if (size > maxEventPayloadBytes()) {
    const error = new Error(`event payload exceeds WORKFLOW_EVENT_PAYLOAD_MAX_BYTES (${maxEventPayloadBytes()} bytes)`)
    ;(error as Error & { statusCode?: number; code?: string }).statusCode = 413
    ;(error as Error & { statusCode?: number; code?: string }).code = 'EVENT_PAYLOAD_TOO_LARGE'
    throw error
  }
}
