export type ScheduleRow = {
  rowKey: string
  estimatedHours: number
  dependencies: Array<{ rowKey: string }>
  capacityCalendarId?: string
  valueScore?: number
}

export type ScheduleCapacityCalendar = {
  id: string
  weeklyHours: Record<string, number>
  holidays: string[]
  wipLimit?: number | null
  allocations?: Array<{ startAt: Date; endAt: Date; estimatedHours: number }>
}

export type ScheduledRow = {
  rowKey: string
  projectedStartAt: Date
  projectedFinishAt: Date
  criticalPath: boolean
  durationHours: number
  capacityCalendarId?: string
  capacityConstrained: boolean
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

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function dayStart(date: Date): Date {
  const result = new Date(date)
  result.setUTCHours(9, 0, 0, 0)
  return result
}

function capacityForDay(calendar: ScheduleCapacityCalendar, date: Date): number {
  const dateKey = date.toISOString().slice(0, 10)
  if (calendar.holidays.includes(dateKey)) return 0
  const configured = Number(calendar.weeklyHours[DAY_NAMES[date.getUTCDay()]])
  if (!Number.isFinite(configured) || configured <= 0) return 0
  const start = dayStart(date).getTime()
  const end = start + 24 * 3_600_000
  const committed = (calendar.allocations ?? [])
    .filter(allocation => allocation.startAt.getTime() < end && allocation.endAt.getTime() >= start)
    .reduce((sum, allocation) => sum + Math.max(0, allocation.estimatedHours), 0)
  return Math.max(0, configured - committed)
}

function addCapacityHours(start: Date, hours: number, calendar: ScheduleCapacityCalendar): Date {
  const result = dayStart(start)
  if (start.getTime() > result.getTime()) result.setTime(start.getTime())
  let remaining = Math.max(0.25, hours)
  let guard = 0
  while (remaining > 0 && guard < 3_660) {
    guard += 1
    const elapsedHours = Math.max(0, (result.getTime() - dayStart(result).getTime()) / 3_600_000)
    const available = Math.max(0, capacityForDay(calendar, result) - elapsedHours)
    if (available <= 0) {
      result.setUTCDate(result.getUTCDate() + 1)
      result.setUTCHours(9, 0, 0, 0)
      continue
    }
    const consumed = Math.min(remaining, available)
    result.setTime(result.getTime() + consumed * 3_600_000)
    remaining -= consumed
    if (remaining > 0) {
      result.setUTCDate(result.getUTCDate() + 1)
      result.setUTCHours(9, 0, 0, 0)
    }
  }
  if (remaining > 0) throw new Error(`Capacity calendar ${calendar.id} has no schedulable time in the planning horizon`)
  return result
}

/** Deterministic finish-to-start scheduler used by both plan preview and validation. */
export function scheduleGenerationPlan(
  rows: ScheduleRow[],
  options: { startAt?: Date; hoursPerDay?: number; capacityCalendars?: ScheduleCapacityCalendar[] } = {},
): ScheduledRow[] {
  const startAt = new Date(options.startAt ?? new Date())
  const hoursPerDay = Math.max(1, Math.min(24, options.hoursPerDay ?? 8))
  const orderedRows = rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => (right.row.valueScore ?? 0) - (left.row.valueScore ?? 0) || left.index - right.index)
    .map(entry => entry.row)
  const byKey = new Map(orderedRows.map(row => [row.rowKey, row]))
  if (byKey.size !== rows.length) throw new Error('Generation plan row keys must be unique')
  const visiting = new Set<string>()
  const scheduled = new Map<string, ScheduledRow & { score: number; parent?: string }>()
  const calendars = new Map((options.capacityCalendars ?? []).map(calendar => [calendar.id, calendar]))
  const capacityCursor = new Map<string, Date>()

  const visit = (key: string): ScheduledRow & { score: number; parent?: string } => {
    const existing = scheduled.get(key)
    if (existing) return existing
    if (visiting.has(key)) throw new Error(`Dependency cycle includes ${key}`)
    const row = byKey.get(key)
    if (!row) throw new Error(`Unknown generation plan dependency ${key}`)
    visiting.add(key)
    const parents = row.dependencies.map(dependency => visit(dependency.rowKey))
    const latest = parents.sort((left, right) => right.projectedFinishAt.getTime() - left.projectedFinishAt.getTime())[0]
    let projectedStartAt = latest ? new Date(latest.projectedFinishAt) : new Date(startAt)
    const durationHours = Math.max(0.25, Number(row.estimatedHours) || 0.25)
    const calendar = row.capacityCalendarId ? calendars.get(row.capacityCalendarId) : undefined
    const cursor = row.capacityCalendarId ? capacityCursor.get(row.capacityCalendarId) : undefined
    if (cursor && cursor > projectedStartAt) projectedStartAt = new Date(cursor)
    const projectedFinishAt = calendar
      ? addCapacityHours(projectedStartAt, durationHours, calendar)
      : addWorkingHours(projectedStartAt, durationHours, hoursPerDay)
    if (row.capacityCalendarId) capacityCursor.set(row.capacityCalendarId, projectedFinishAt)
    const result = {
      rowKey: key,
      projectedStartAt,
      projectedFinishAt,
      durationHours,
      criticalPath: false,
      score: (latest?.score ?? 0) + durationHours,
      parent: latest?.rowKey,
      capacityCalendarId: row.capacityCalendarId,
      capacityConstrained: Boolean(calendar),
    }
    visiting.delete(key)
    scheduled.set(key, result)
    return result
  }

  for (const row of orderedRows) visit(row.rowKey)
  const terminal = [...scheduled.values()].sort((left, right) => right.score - left.score)[0]
  let cursor: (ScheduledRow & { score: number; parent?: string }) | undefined = terminal
  while (cursor) {
    cursor.criticalPath = true
    cursor = cursor.parent ? scheduled.get(cursor.parent) : undefined
  }
  return orderedRows.map(row => {
    const value = scheduled.get(row.rowKey)!
    return {
      rowKey: value.rowKey,
      projectedStartAt: value.projectedStartAt,
      projectedFinishAt: value.projectedFinishAt,
      criticalPath: value.criticalPath,
      durationHours: value.durationHours,
      capacityCalendarId: value.capacityCalendarId,
      capacityConstrained: value.capacityConstrained,
    }
  })
}
