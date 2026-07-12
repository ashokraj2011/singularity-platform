import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { createAllocation, forecastCapacity, listAllocations, listCapacityCalendars, upsertCapacityCalendar } from './capacity.service'

export const capacityRouter: Router = Router()

const calendarSchema = z.object({ ownerType: z.enum(['USER', 'TEAM', 'CAPABILITY']), ownerId: z.string().min(1), timezone: z.string().max(80).optional(), weeklyHours: z.record(z.number().min(0)).optional(), holidays: z.array(z.string()).optional(), wipLimit: z.number().int().positive().nullable().optional() })
capacityRouter.get('/calendars', async (_req, res, next) => { try { res.json(await listCapacityCalendars()) } catch (err) { next(err) } })
capacityRouter.put('/calendars', validate(calendarSchema), async (req, res, next) => { try { res.json(await upsertCapacityCalendar({ ...req.body, actorId: req.user!.userId })) } catch (err) { next(err) } })

const allocationSchema = z.object({ calendarId: z.string().uuid(), workItemId: z.string().optional(), programStepId: z.string().optional(), capabilityId: z.string().optional(), skillKey: z.string().optional(), startAt: z.string().datetime(), endAt: z.string().datetime(), estimatedHours: z.number().positive() })
capacityRouter.get('/allocations', async (req, res, next) => { try { res.json(await listAllocations(typeof req.query.calendarId === 'string' ? req.query.calendarId : undefined)) } catch (err) { next(err) } })
capacityRouter.post('/allocations', validate(allocationSchema), async (req, res, next) => { try { res.status(201).json(await createAllocation({ ...req.body, startAt: new Date(req.body.startAt), endAt: new Date(req.body.endAt), actorId: req.user!.userId })) } catch (err) { next(err) } })

const forecastSchema = z.object({ workItems: z.array(z.object({ id: z.string().optional(), title: z.string().optional(), effortHours: z.number().nonnegative(), skillKey: z.string().optional(), capabilityId: z.string().optional(), dueAt: z.string().datetime().optional() })).min(1), calendarIds: z.array(z.string().uuid()).optional(), scenario: z.record(z.unknown()).optional(), plannerSessionId: z.string().uuid().optional() })
capacityRouter.post('/forecast', validate(forecastSchema), async (req, res, next) => { try { res.status(201).json(await forecastCapacity({ ...req.body, actorId: req.user!.userId })) } catch (err) { next(err) } })
