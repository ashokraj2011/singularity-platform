export type ScheduleRow = {
  rowKey: string
  estimatedHours: number
  dependencies: Array<{ rowKey: string }>
}

export type ScheduledRow = {
  rowKey: string
  projectedStartAt: Date
  projectedFinishAt: Date
  criticalPath: boolean
  durationHours: number
}

function addWorkingHours(start: Date, hours: number, hoursPerDay: number): Date {
  const result = new Date(start)
  let remaining = Math.max(0, hours)
  while (remaining > 0) {
    const day = result.getUTCDay()
    if (day === 0 || day === 6) {
      result.setUTCDate(result.getUTCDate() + (day === 6 ? 2 : 1))
      result.setUTCHours(9, 0, 0, 0)
      continue
    }
    const consumed = Math.min(remaining, hoursPerDay)
    result.setTime(result.getTime() + consumed * 3_600_000)
    remaining -= consumed
    if (remaining > 0) {
      result.setUTCDate(result.getUTCDate() + 1)
      result.setUTCHours(9, 0, 0, 0)
    }
  }
  return result
}

/** Deterministic finish-to-start scheduler. Capacity calendars can refine the daily hours later;
 * this core stays pure so plan validation and previews produce the same answer. */
export function scheduleGenerationPlan(
  rows: ScheduleRow[],
  options: { startAt?: Date; hoursPerDay?: number } = {},
): ScheduledRow[] {
  const startAt = new Date(options.startAt ?? new Date())
  const hoursPerDay = Math.max(1, Math.min(24, options.hoursPerDay ?? 8))
  const byKey = new Map(rows.map(row => [row.rowKey, row]))
  if (byKey.size !== rows.length) throw new Error('Generation plan row keys must be unique')
  const visiting = new Set<string>()
  const scheduled = new Map<string, ScheduledRow & { score: number; parent?: string }>()

  const visit = (key: string): ScheduledRow & { score: number; parent?: string } => {
    const existing = scheduled.get(key)
    if (existing) return existing
    if (visiting.has(key)) throw new Error(`Dependency cycle includes ${key}`)
    const row = byKey.get(key)
    if (!row) throw new Error(`Unknown generation plan dependency ${key}`)
    visiting.add(key)
    const parents = row.dependencies.map(dependency => visit(dependency.rowKey))
    const latest = parents.sort((left, right) => right.projectedFinishAt.getTime() - left.projectedFinishAt.getTime())[0]
    const projectedStartAt = latest ? new Date(latest.projectedFinishAt) : new Date(startAt)
    const durationHours = Math.max(0.25, Number(row.estimatedHours) || 0.25)
    const projectedFinishAt = addWorkingHours(projectedStartAt, durationHours, hoursPerDay)
    const result = {
      rowKey: key,
      projectedStartAt,
      projectedFinishAt,
      durationHours,
      criticalPath: false,
      score: (latest?.score ?? 0) + durationHours,
      parent: latest?.rowKey,
    }
    visiting.delete(key)
    scheduled.set(key, result)
    return result
  }

  for (const row of rows) visit(row.rowKey)
  const terminal = [...scheduled.values()].sort((left, right) => right.score - left.score)[0]
  let cursor: (ScheduledRow & { score: number; parent?: string }) | undefined = terminal
  while (cursor) {
    cursor.criticalPath = true
    cursor = cursor.parent ? scheduled.get(cursor.parent) : undefined
  }
  return rows.map(row => {
    const value = scheduled.get(row.rowKey)!
    return {
      rowKey: value.rowKey,
      projectedStartAt: value.projectedStartAt,
      projectedFinishAt: value.projectedFinishAt,
      criticalPath: value.criticalPath,
      durationHours: value.durationHours,
    }
  })
}
