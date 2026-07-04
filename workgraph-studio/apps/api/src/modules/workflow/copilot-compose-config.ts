const DEFAULT_COPILOT_COMPOSE_TIMEOUT_MS = 30_000
const MIN_COPILOT_COMPOSE_TIMEOUT_MS = 1_000
const MAX_COPILOT_COMPOSE_TIMEOUT_MS = 120_000

export function copilotComposeTimeoutMs(
  raw = process.env.COPILOT_COMPOSE_TIMEOUT_MS,
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_COPILOT_COMPOSE_TIMEOUT_MS

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_COPILOT_COMPOSE_TIMEOUT_MS

  const timeoutMs = Math.trunc(parsed)
  if (timeoutMs < MIN_COPILOT_COMPOSE_TIMEOUT_MS) return DEFAULT_COPILOT_COMPOSE_TIMEOUT_MS

  return Math.min(timeoutMs, MAX_COPILOT_COMPOSE_TIMEOUT_MS)
}
