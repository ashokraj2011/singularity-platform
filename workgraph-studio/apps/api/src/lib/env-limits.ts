export type IntLimitOptions = {
  defaultValue: number
  minValue?: number
  maxValue: number
}

export type ByteLimitOptions = {
  defaultBytes: number
  minBytes?: number
  maxBytes: number
}

export function boundedIntLimit(
  raw: string | undefined,
  options: IntLimitOptions,
): number {
  const minValue = Math.max(1, Math.trunc(options.minValue ?? 1))
  const defaultValue = Math.trunc(options.defaultValue)
  const maxValue = Math.trunc(options.maxValue)

  if (!Number.isFinite(defaultValue) || defaultValue < minValue) {
    throw new Error('boundedIntLimit defaultValue must be finite and >= minValue')
  }
  if (!Number.isFinite(maxValue) || maxValue < defaultValue) {
    throw new Error('boundedIntLimit maxValue must be finite and >= defaultValue')
  }

  if (raw === undefined || raw.trim() === '') return defaultValue

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return defaultValue

  const value = Math.trunc(parsed)
  if (value < minValue) return defaultValue

  return Math.min(value, maxValue)
}

export function boundedByteLimit(
  raw: string | undefined,
  options: ByteLimitOptions,
): number {
  return boundedIntLimit(raw, {
    defaultValue: options.defaultBytes,
    minValue: options.minBytes,
    maxValue: options.maxBytes,
  })
}
