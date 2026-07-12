import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import {
  activateGovernancePolicy,
  createGovernancePolicy,
  evaluateGovernancePolicy,
  getGovernancePolicy,
  governanceCoverage,
  listGovernancePolicies,
  updateGovernancePolicy,
} from './governance-policy.service'

export const governancePolicyRouter: Router = Router()

const ruleSchema = z.object({ key: z.string().min(1).max(160), label: z.string().max(240).optional(), evidencePath: z.string().max(240).optional(), required: z.boolean().optional(), severity: z.string().max(40).optional() })
const policySchema = z.object({ name: z.string().min(1).max(200), description: z.string().max(2000).optional(), capabilityId: z.string().optional(), workflowId: z.string().optional(), workItemTypeKey: z.string().optional(), mode: z.enum(['ADVISORY', 'REQUIRED', 'BLOCKING']), rules: z.array(ruleSchema).min(1) })

governancePolicyRouter.get('/', async (_req, res, next) => {
  try { res.json(await listGovernancePolicies()) } catch (err) { next(err) }
})
governancePolicyRouter.get('/coverage', async (_req, res, next) => {
  try { res.json(await governanceCoverage()) } catch (err) { next(err) }
})
governancePolicyRouter.post('/', validate(policySchema), async (req, res, next) => {
  try { res.status(201).json(await createGovernancePolicy({ ...req.body, actorId: req.user!.userId })) } catch (err) { next(err) }
})
governancePolicyRouter.get('/:id', async (req, res, next) => {
  try { res.json(await getGovernancePolicy(req.params.id)) } catch (err) { next(err) }
})
governancePolicyRouter.patch('/:id', validate(policySchema.partial().extend({ rules: z.array(ruleSchema).min(1).optional() })), async (req, res, next) => {
  try { res.json(await updateGovernancePolicy(req.params.id, { ...req.body, actorId: req.user!.userId })) } catch (err) { next(err) }
})
governancePolicyRouter.post('/:id/activate', async (req, res, next) => {
  try { res.json(await activateGovernancePolicy(req.params.id, req.user!.userId)) } catch (err) { next(err) }
})
governancePolicyRouter.post('/:id/preview', validate(z.object({ evidence: z.record(z.unknown()).default({}), instanceId: z.string().uuid().optional(), nodeId: z.string().uuid().optional(), workItemId: z.string().uuid().optional() })), async (req, res, next) => {
  try { res.json(await evaluateGovernancePolicy({ policyId: req.params.id, evidence: req.body.evidence, actorId: req.user!.userId, instanceId: req.body.instanceId, nodeId: req.body.nodeId, workItemId: req.body.workItemId })) } catch (err) { next(err) }
})
