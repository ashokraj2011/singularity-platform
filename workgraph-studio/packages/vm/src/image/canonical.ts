// ─────────────────────────────────────────────────────────────────────────────
// Canonical JSON — deterministic, stable serialization so an image always
// hashes to the same digest regardless of key insertion order. Required for
// reproducible, signable .wgvm images.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto'

/**
 * Serialize a value to canonical JSON: object keys sorted lexicographically at
 * every depth, no insignificant whitespace. Arrays keep their order.
 */
export function canonicalize(value: unknown): string {
  return serialize(value)
}

function serialize(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cannot canonicalize non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'undefined') return 'null'
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort()
    const body = keys.map(k => `${JSON.stringify(k)}:${serialize(obj[k])}`).join(',')
    return `{${body}}`
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`)
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Canonical digest of a value — sha256 over its canonical JSON form. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalize(value))
}
