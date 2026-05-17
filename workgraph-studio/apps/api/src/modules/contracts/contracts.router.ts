/**
 * M40 — ImmutableContract surface in workgraph-api.
 *
 * Two responsibilities:
 *   1. Proxy contract lookup to prompt-composer for the UI / admin tools
 *   2. Expose a replay endpoint: rerun an execution with a contract's
 *      frozen prompts + tool versions + model resolution
 *
 *   POST /api/contracts/:contractId/replay
 *     Body: { workflowInstanceId?, agentTemplateId, originalInput, capabilityId? }
 *     Returns: { replayRunId, response, diff }
 *
 *   GET  /api/contracts/:contractId        — proxy to composer
 *   GET  /api/contracts?agentTemplateId=X  — proxy to composer
 *
 * Replay flow:
 *   1. Fetch contract bundle from composer
 *   2. Call context-fabric /execute with overrides set from the bundle's
 *      modelResolution (forced provider+model) + a replayContract flag so
 *      composer hydrates the prompt assembly from the bundle's frozen
 *      layer snapshots rather than live PromptLayer rows
 *   3. Return the response + an audit event tagged contract.replayed
 *
 * The "diff" is currently a placeholder; full side-by-side comparison
 * against an original execution is M40.2 follow-on UI work.
 */
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { config } from '../../config'
import { contextFabricClient } from '../../lib/context-fabric/client'

export const contractsRouter: Router = Router()

const COMPOSER_URL = config.PROMPT_COMPOSER_URL.replace(/\/$/, '')

contractsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agentTemplateId = typeof req.query.agentTemplateId === 'string' ? req.query.agentTemplateId : ''
    if (!agentTemplateId) {
      return res.status(400).json({ error: 'agentTemplateId query param required' })
    }
    const r = await fetch(`${COMPOSER_URL}/api/v1/contracts?agentTemplateId=${encodeURIComponent(agentTemplateId)}`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      return res.status(r.status).json({ error: 'composer contracts fetch failed', detail: text.slice(0, 300) })
    }
    const json = await r.json() as { success?: boolean; data?: unknown }
    res.json(json.data ?? [])
  } catch (err) {
    next(err)
  }
})

contractsRouter.get('/:contractId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await fetch(`${COMPOSER_URL}/api/v1/contracts/${encodeURIComponent(req.params.contractId)}`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      return res.status(r.status).json({ error: 'composer contract fetch failed', detail: text.slice(0, 300) })
    }
    const json = await r.json() as { success?: boolean; data?: unknown }
    res.json(json.data ?? null)
  } catch (err) {
    next(err)
  }
})

const replaySchema = z.object({
  agentTemplateId: z.string().uuid(),
  originalInput: z.string().min(1).max(20_000),
  // capabilityId is required for replay — every executable agent has one,
  // and context-fabric's ExecuteRunContext requires it.
  capabilityId: z.string().min(1),
  workflowInstanceId: z.string().optional(),
})

contractsRouter.post('/:contractId/replay', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = replaySchema.parse(req.body)
    // 1. Fetch the contract bundle
    const cr = await fetch(`${COMPOSER_URL}/api/v1/contracts/${encodeURIComponent(req.params.contractId)}`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!cr.ok) {
      return res.status(cr.status).json({ error: 'contract fetch failed' })
    }
    const contract = (await cr.json() as { success?: boolean; data?: { modelResolution?: { alias?: string; provider?: string; model?: string }; bundleHash?: string } }).data
    if (!contract) {
      return res.status(404).json({ error: 'contract bundle empty' })
    }
    const traceId = `contract-replay-${req.params.contractId}-${Date.now()}`
    // 2. Execute via context-fabric with replay overrides. The contract's
    //    modelResolution overrides any live alias resolution; the
    //    replayContractId is passed through composer so the prompt assembly
    //    hydrates from the bundle's frozen layer snapshots.
    const result = await contextFabricClient.execute({
      trace_id: traceId,
      idempotency_key: traceId,
      run_context: {
        workflow_instance_id: body.workflowInstanceId ?? `replay-${req.params.contractId}`,
        workflow_node_id: 'contract-replay',
        agent_run_id: `replay-${Date.now()}`,
        agent_template_id: body.agentTemplateId,
        capability_id: body.capabilityId,
        trace_id: traceId,
      },
      task: body.originalInput,
      model_overrides: {
        // Force the historical provider + model regardless of what the alias
        // resolves to today. version (if recorded) propagates as a hint.
        provider: contract.modelResolution?.provider,
        model: contract.modelResolution?.model,
      },
      overrides: {
        // M40 — composer reads this and hydrates the prompt assembly from
        // ImmutableContract.bundleHash's frozen layers instead of live rows.
        // Field name mirrored exactly so composer can pick it up by key.
        extraContext: `__replayContractId=${req.params.contractId}__`,
      },
      governance_mode: 'fail_open',
    })
    res.json({
      replayRunId: traceId,
      contractId: req.params.contractId,
      bundleHash: contract.bundleHash,
      response: result.finalResponse,
      status: result.status,
      // Future M40.2 — diff vs the original execution if originalRunId provided.
      diff: { note: 'side-by-side diff is M40.2 follow-on' },
    })
  } catch (err) {
    next(err)
  }
})
