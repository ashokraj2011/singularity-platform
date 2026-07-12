import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { checkRuntimeAction, createRuntimePolicy, enrollRuntimeDevice, listRuntimeDevices, listRuntimePolicies, recordRuntimeConsent, revokeRuntimeDevice, updateRuntimePolicy } from './runtime-policy.service'

export const runtimePolicyRouter: Router = Router()

const policySchema = z.object({ name: z.string().min(1).max(160), minVersion: z.string().optional(), allowedPaths: z.array(z.string()).optional(), consentMode: z.enum(['PER_ACTION', 'SESSION', 'ALWAYS_ALLOW']).optional(), autoUpdate: z.boolean().optional(), killSwitch: z.boolean().optional() })
runtimePolicyRouter.get('/policies', async (_req, res, next) => { try { res.json(await listRuntimePolicies()) } catch (err) { next(err) } })
runtimePolicyRouter.post('/policies', validate(policySchema), async (req, res, next) => { try { res.status(201).json(await createRuntimePolicy({ ...req.body, actorId: req.user!.userId })) } catch (err) { next(err) } })
runtimePolicyRouter.patch('/policies/:id', validate(policySchema.partial().omit({ name: true })), async (req, res, next) => { try { res.json(await updateRuntimePolicy(req.params.id, req.body)) } catch (err) { next(err) } })

const deviceSchema = z.object({ runtimeId: z.string().min(1).max(200), deviceName: z.string().min(1).max(200), platform: z.string().min(1).max(80), version: z.string().optional(), policyId: z.string().uuid().optional(), workspaceProfiles: z.array(z.unknown()).optional() })
runtimePolicyRouter.get('/devices', async (req, res, next) => { try { res.json(await listRuntimeDevices(req.user!.userId)) } catch (err) { next(err) } })
runtimePolicyRouter.post('/devices/enroll', validate(deviceSchema), async (req, res, next) => { try { res.status(201).json(await enrollRuntimeDevice({ ...req.body, userId: req.user!.userId })) } catch (err) { next(err) } })
runtimePolicyRouter.post('/devices/:runtimeId/revoke', async (req, res, next) => { try { res.json(await revokeRuntimeDevice(req.params.runtimeId, req.user!.userId)) } catch (err) { next(err) } })

const consentSchema = z.object({ runtimeId: z.string().min(1), action: z.string().min(1), scope: z.string().min(1), decision: z.enum(['ALLOW', 'DENY']), reason: z.string().max(500).optional(), expiresAt: z.string().datetime().optional() })
runtimePolicyRouter.post('/consent', validate(consentSchema), async (req, res, next) => { try { res.status(201).json(await recordRuntimeConsent({ ...req.body, expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : undefined, userId: req.user!.userId })) } catch (err) { next(err) } })
runtimePolicyRouter.post('/check', validate(z.object({ runtimeId: z.string().min(1), action: z.string().min(1), scope: z.string().min(1) })), async (req, res, next) => { try { res.json(await checkRuntimeAction({ ...req.body, userId: req.user!.userId })) } catch (err) { next(err) } })
