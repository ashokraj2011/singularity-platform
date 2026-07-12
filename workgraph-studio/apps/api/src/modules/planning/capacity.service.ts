import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction, currentTenantIdForDb } from '../../lib/tenant-db-context'
import { NotFoundError, ValidationError } from '../../lib/errors'

type JsonRecord = Record<string, unknown>
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue }

export async function listCapacityCalendars() {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.capacityCalendar.findMany({ where: { tenantId }, orderBy: { ownerId: 'asc' } }), tenantId)
}

export async function upsertCapacityCalendar(input: { ownerType: string; ownerId: string; timezone?: string; weeklyHours?: JsonRecord; holidays?: string[]; wipLimit?: number | null; actorId: string }) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.capacityCalendar.upsert({
    where: { tenantId_ownerType_ownerId: { tenantId, ownerType: input.ownerType, ownerId: input.ownerId } },
    create: { tenantId, ownerType: input.ownerType, ownerId: input.ownerId, timezone: input.timezone ?? 'UTC', weeklyHours: json(input.weeklyHours ?? { mon: 8, tue: 8, wed: 8, thu: 8, fri: 8 }), holidays: json(input.holidays ?? []), wipLimit: input.wipLimit, createdById: input.actorId },
    update: { timezone: input.timezone, weeklyHours: input.weeklyHours ? json(input.weeklyHours) : undefined, holidays: input.holidays ? json(input.holidays) : undefined, wipLimit: input.wipLimit },
  }), tenantId)
}

export async function listAllocations(calendarId?: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.capacityAllocation.findMany({ where: { tenantId, ...(calendarId ? { calendarId } : {}) }, orderBy: { startAt: 'asc' }, take: 1000 }), tenantId)
}

export async function createAllocation(input: { calendarId: string; workItemId?: string; programStepId?: string; capabilityId?: string; skillKey?: string; startAt: Date; endAt: Date; estimatedHours: number; actorId: string }) {
  if (input.endAt <= input.startAt) throw new ValidationError('Allocation end must be after its start')
  if (!Number.isFinite(input.estimatedHours) || input.estimatedHours <= 0) throw new ValidationError('estimatedHours must be greater than zero')
  const tenantId = currentTenantIdForDb() ?? 'default'
  const calendar = await withTenantDbTransaction(prisma, tx => tx.capacityCalendar.findFirst({ where: { id: input.calendarId, tenantId } }), tenantId)
  if (!calendar) throw new NotFoundError('CapacityCalendar', input.calendarId)
  return withTenantDbTransaction(prisma, tx => tx.capacityAllocation.create({ data: { tenantId, calendarId: input.calendarId, workItemId: input.workItemId, programStepId: input.programStepId, capabilityId: input.capabilityId, skillKey: input.skillKey, startAt: input.startAt, endAt: input.endAt, estimatedHours: input.estimatedHours, createdById: input.actorId } }), tenantId)
}

function hoursForDay(calendar: { weeklyHours: Prisma.JsonValue; holidays: Prisma.JsonValue }, date: Date): number {
  const holidayList = Array.isArray(calendar.holidays) ? calendar.holidays.map(String) : []
  const dayKey = date.toISOString().slice(0, 10)
  if (holidayList.includes(dayKey)) return 0
  const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const hours = calendar.weeklyHours && typeof calendar.weeklyHours === 'object' && !Array.isArray(calendar.weeklyHours) ? (calendar.weeklyHours as JsonRecord)[names[date.getUTCDay()]] : undefined
  return typeof hours === 'number' ? Math.max(0, hours) : 0
}

export function calculateCapacityMetrics(totalEffort: number, totalAvailable: number, conflictCount: number) {
  const utilization = totalAvailable > 0 ? Math.min(1, totalEffort / totalAvailable) : 1
  return {
    utilization,
    predictedCompletionDays: totalAvailable > 0 ? Math.ceil(totalEffort / totalAvailable) : null,
    criticalPathRisk: conflictCount > 0 ? 'HIGH' : utilization > 0.8 ? 'MEDIUM' : 'LOW',
  }
}

export async function forecastCapacity(input: { workItems: Array<{ id?: string; title?: string; effortHours: number; skillKey?: string; capabilityId?: string; dueAt?: string }>; calendarIds?: string[]; scenario?: JsonRecord; actorId: string; plannerSessionId?: string }) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const calendars = await withTenantDbTransaction(prisma, tx => tx.capacityCalendar.findMany({ where: { tenantId, ...(input.calendarIds?.length ? { id: { in: input.calendarIds } } : {}) } }), tenantId)
  if (calendars.length === 0) throw new ValidationError('At least one capacity calendar is required')
  const allocations = await withTenantDbTransaction(prisma, tx => tx.capacityAllocation.findMany({ where: { tenantId, calendarId: { in: calendars.map(calendar => calendar.id) }, status: { in: ['PLANNED', 'COMMITTED', 'IN_PROGRESS'] } } }), tenantId)
  const byCalendar = calendars.map(calendar => ({ calendar, allocated: allocations.filter(allocation => allocation.calendarId === calendar.id).reduce((sum, allocation) => sum + allocation.estimatedHours, 0), available: hoursForDay(calendar, new Date()) }))
  const totalAvailable = byCalendar.reduce((sum, row) => sum + row.available, 0)
  const totalEffort = input.workItems.reduce((sum, workItem) => sum + Math.max(0, Number(workItem.effortHours) || 0), 0)
  const conflicts = input.workItems.filter(workItem => workItem.dueAt && totalAvailable < Number(workItem.effortHours)).map(workItem => ({ workItemId: workItem.id, title: workItem.title, reason: 'insufficient available capacity before due date' }))
  const metrics = calculateCapacityMetrics(totalEffort, totalAvailable, conflicts.length)
  const result = { totalEffortHours: totalEffort, totalAvailableHours: totalAvailable, ...metrics, conflicts, calendars: byCalendar.map(row => ({ id: row.calendar.id, ownerType: row.calendar.ownerType, ownerId: row.calendar.ownerId, allocatedHours: row.allocated, availableHours: row.available, wipLimit: row.calendar.wipLimit })) }
  const forecast = await withTenantDbTransaction(prisma, tx => tx.planningForecast.create({ data: { tenantId, plannerSessionId: input.plannerSessionId, scenario: json({ ...(input.scenario ?? {}), workItems: input.workItems }), status: 'COMPLETED', result: json(result), createdById: input.actorId } }), tenantId)
  return { forecast, result }
}
