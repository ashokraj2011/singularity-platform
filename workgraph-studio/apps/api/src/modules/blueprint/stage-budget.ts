/**
 * Per-stage budget evaluation for the workbench loop.
 *
 * Set at workbench launch (USD estimated-cost or total tokens), enforced per
 * stage. v1 is SOFT only (WARN_ONLY): the caller emits a warning/exceeded event
 * and keeps running — it never blocks the stage. Pure + dependency-free so it
 * unit-tests without the DB or the (huge) blueprint router.
 */

export type StageBudgetUnit = 'USD' | 'TOKENS'

export interface StageBudgetConfig {
  unit: StageBudgetUnit
  amount: number
  /** Emit a 'warn' once cumulative spend reaches this % of `amount`. */
  warnAtPercent: number
}

export interface StageBudgetSpend {
  /** Cumulative total tokens spent in the stage. */
  tokens: number
  /** Cumulative estimated USD spent in the stage; null when unpriced. */
  usd: number | null
}

export type StageBudgetLevel = 'ok' | 'warn' | 'exceeded'

export interface StageBudgetEvaluation {
  level: StageBudgetLevel
  unit: StageBudgetUnit
  amount: number
  /** Spend in the configured unit. */
  spent: number
  /** spent / amount * 100, rounded to 1 decimal. */
  percent: number
  warnAtPercent: number
  /** false when unit is USD but cost is unknown — we don't warn on unpriced. */
  priced: boolean
}

/** Read a stage budget out of loose session/loop-state metadata. Returns null
 *  when no usable budget is configured. */
export function readStageBudget(value: unknown): StageBudgetConfig | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const unit = v.unit === 'USD' || v.unit === 'TOKENS' ? v.unit : null
  const amount = typeof v.amount === 'number' && v.amount > 0 ? v.amount : null
  if (!unit || !amount) return null
  const warnRaw = typeof v.warnAtPercent === 'number' ? v.warnAtPercent : 80
  const warnAtPercent = Math.min(100, Math.max(1, Math.round(warnRaw)))
  return { unit, amount, warnAtPercent }
}

export function evaluateStageBudget(cfg: StageBudgetConfig, spend: StageBudgetSpend): StageBudgetEvaluation {
  const priced = cfg.unit === 'TOKENS' ? true : spend.usd !== null
  const spent = cfg.unit === 'TOKENS' ? spend.tokens : (spend.usd ?? 0)
  const amount = cfg.amount > 0 ? cfg.amount : 0
  const percent = amount > 0 ? Math.round((spent / amount) * 1000) / 10 : 0

  let level: StageBudgetLevel = 'ok'
  if (priced && amount > 0) {
    if (spent >= amount) level = 'exceeded'
    else if (percent >= cfg.warnAtPercent) level = 'warn'
  }
  return { level, unit: cfg.unit, amount, spent, percent, warnAtPercent: cfg.warnAtPercent, priced }
}
