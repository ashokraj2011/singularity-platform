// ─────────────────────────────────────────────────────────────────────────────
// TIMER executor — deterministic, offline-capable. Computes a stable fire time on
// first activation (persisted into context so it survives park/resume), then:
//   fireAt <= now  → COMPLETED
//   fireAt >  now  → BLOCKED (parked); a later resume() re-checks the clock.
//
// Config (mirrors the server TimerExecutor):
//   { until: ISO-8601 }   fire at an absolute instant
//   { durationMs: number} fire N ms after first activation
//   { duration: "30s" | "5m" | "2h" }
// ─────────────────────────────────────────────────────────────────────────────

import type { ExecContext, ExecOutcome, NodeExecutor } from '../types.js'

function parseDuration(d: string): number | undefined {
  const m = /^(\d+)\s*(s|m|h)$/.exec(d.trim())
  if (!m) return undefined
  const n = Number(m[1])
  return m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000
}

function computeFireAt(cfg: Record<string, unknown>, now: Date): Date | undefined {
  const std = (cfg.standard && typeof cfg.standard === 'object' ? cfg.standard : cfg) as Record<string, unknown>
  const until = std.until ?? cfg.until
  const durationMs = std.durationMs ?? cfg.durationMs
  const duration = std.duration ?? cfg.duration
  if (typeof until === 'string') {
    const p = new Date(until)
    return Number.isNaN(p.valueOf()) ? undefined : p
  }
  if (typeof durationMs === 'number' || (typeof durationMs === 'string' && durationMs.trim() !== '')) {
    const n = Number(durationMs)
    if (!Number.isNaN(n) && n >= 0) return new Date(now.valueOf() + n)
  }
  if (typeof duration === 'string') {
    const ms = parseDuration(duration)
    if (ms !== undefined) return new Date(now.valueOf() + ms)
  }
  return undefined
}

export const timerExecutor: NodeExecutor = {
  handles: ['TIMER'],
  async execute(ctx: ExecContext): Promise<ExecOutcome> {
    const now = ctx.adapters.clock.now()
    const timers = (ctx.context._timers as Record<string, string>) ?? {}
    ctx.context._timers = timers

    let fireAtIso = timers[ctx.node.id]
    if (!fireAtIso) {
      const fireAt = computeFireAt((ctx.node.config ?? {}) as Record<string, unknown>, now)
      if (!fireAt) return { kind: 'FAILED', reason: 'TIMER node has no valid until/duration' }
      fireAtIso = fireAt.toISOString()
      timers[ctx.node.id] = fireAtIso
    }

    if (new Date(fireAtIso).valueOf() <= now.valueOf()) {
      delete timers[ctx.node.id]
      return { kind: 'COMPLETED', output: { firedAt: now.toISOString() } }
    }
    ctx.log('TimerPending', `fires at ${fireAtIso}`)
    return { kind: 'BLOCKED', reason: `timer fires at ${fireAtIso}` }
  },
}
