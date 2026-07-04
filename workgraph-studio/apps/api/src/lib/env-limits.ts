export type ByteLimitOptions = {
  defaultBytes: number
  minBytes?: number
  maxBytes: number
}

export function boundedByteLimit(
  raw: string | undefined,
  options: ByteLimitOptions,
): number {
  const minBytes = Math.max(1, Math.trunc(options.minBytes ?? 1))
  const defaultBytes = Math.trunc(options.defaultBytes)
  const maxBytes = Math.trunc(options.maxBytes)

  if (!Number.isFinite(defaultBytes) || defaultBytes < minBytes) {
    throw new Error('boundedByteLimit defaultBytes must be finite and >= minBytes')
  }
  if (!Number.isFinite(maxBytes) || maxBytes < defaultBytes) {
    throw new Error('boundedByteLimit maxBytes must be finite and >= defaultBytes')
  }

  if (raw === undefined || raw.trim() === '') return defaultBytes

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return defaultBytes

  const bytes = Math.trunc(parsed)
  if (bytes < minBytes) return defaultBytes

  return Math.min(bytes, maxBytes)
}
