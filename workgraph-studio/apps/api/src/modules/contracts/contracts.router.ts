/**
 * M40 — ImmutableContract surface in workgraph-api.
 *
 * Two responsibilities:
 *   1. Proxy contract lookup to prompt-composer for the UI / admin tools
 *   2. Expose a replay endpoint: rerun an execution with a contract's
 *      frozen prompts + tool versions + model resolution
 *
 *   POST /api/contracts/:contractId/replay
 *     Body: { workflowInstanceId?, agentTemplateId, originalInput, capabilityId?, originalRunId? }
 *     Returns: { replayRunId, response, diff }
 *
 *   GET  /api/contracts/:contractId        — proxy to composer
 *   GET  /api/contracts?agentTemplateId=X  — proxy to composer
 *
 * Replay flow:
 *   1. Fetch contract bundle from composer
 *   2. Build a frozen prompt directly from the immutable bundle snapshots
 *   3. Call context-fabric's governed single-turn endpoint with that prompt
 *      verbatim, with no live prompt re-assembly
 *   3. Return the response + an audit event tagged contract.replayed
 *
 * If originalRunId is supplied, replay returns a deterministic text diff
 * summary against the stored Workgraph AgentRun output.
 */
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { traceIdFromParts } from '@workgraph/shared-types'
import { config } from '../../config'
import { contextFabricClient } from '../../lib/context-fabric/client'
import { promptComposerAuthHeaders } from '../../lib/prompt-composer/client'
import { prisma } from '../../lib/prisma'
import { assertAgentRunTenant } from '../../lib/tenant-isolation'
import { isJsonObject, readUpstreamJsonBody, upstreamSnippet } from '../../lib/upstream-json'

export const contractsRouter: Router = Router()

const COMPOSER_URL = config.PROMPT_COMPOSER_URL.replace(/\/$/, '')

type ComposerEnvelope<T = unknown> = {
  success?: boolean
  data?: T
  error?: unknown
  parseError?: string
  raw?: string
}

async function readComposerEnvelope<T = unknown>(response: globalThis.Response, source: string): Promise<ComposerEnvelope<T>> {
  const body = await readUpstreamJsonBody(response)
  if (!body.raw.trim()) return {}
  if (body.parseError) {
    return {
      parseError: body.parseError,
      raw: upstreamSnippet(body.raw, 500),
    }
  }
  if (isJsonObject(body.data)) return body.data as ComposerEnvelope<T>
  return {
    parseError: `${source} returned a non-object JSON body`,
    raw: upstreamSnippet(body.raw, 500),
  }
}

contractsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agentTemplateId = typeof req.query.agentTemplateId === 'string' ? req.query.agentTemplateId : ''
    if (!agentTemplateId) {
      return res.status(400).json({ error: 'agentTemplateId query param required' })
    }
    const r = await fetch(`${COMPOSER_URL}/api/v1/contracts?agentTemplateId=${encodeURIComponent(agentTemplateId)}`, {
      headers: await promptComposerAuthHeaders(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      return res.status(r.status).json({ error: 'composer contracts fetch failed', detail: text.slice(0, 300) })
    }
    const json = await readComposerEnvelope(r, 'composer contracts fetch')
    if (json.parseError) {
      return res.status(502).json({ error: 'composer contracts invalid response', detail: json.parseError, raw: json.raw })
    }
    res.json(json.data ?? [])
  } catch (err) {
    next(err)
  }
})

contractsRouter.get('/:contractId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await fetch(`${COMPOSER_URL}/api/v1/contracts/${encodeURIComponent(req.params.contractId)}`, {
      headers: await promptComposerAuthHeaders(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      return res.status(r.status).json({ error: 'composer contract fetch failed', detail: text.slice(0, 300) })
    }
    const json = await readComposerEnvelope(r, 'composer contract fetch')
    if (json.parseError) {
      return res.status(502).json({ error: 'composer contract invalid response', detail: json.parseError, raw: json.raw })
    }
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
  originalRunId: z.string().uuid().optional(),
})

interface ContractBundle {
  id?: string
  bundleHash?: string
  modelResolution?: {
    alias?: string | null
    provider?: string | null
    model?: string | null
    version?: string | null
  } | null
  promptLayerVersions?: unknown
  systemPromptVersions?: unknown
  stageBindingVersions?: unknown
  toolPins?: unknown
}

interface FrozenPromptLayer {
  layerType?: string
  priority?: number
  layerHash?: string
  version?: number
  contentSnapshot?: string
}

interface FrozenSystemPrompt {
  key?: string
  version?: number
  content?: string
}

interface FrozenStageBinding {
  stageKey?: string
  agentRole?: string | null
  profileId?: string | null
  taskTemplate?: string | null
  extraContextTemplate?: string | null
}

interface FrozenToolPin {
  toolNamespace?: string
  toolName?: string
  version?: number
  riskLevel?: string | null
  requires_approval?: boolean | null
}

function objectArray<T extends object>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((item): item is T => item !== null && typeof item === 'object' && !Array.isArray(item)) : []
}

function numberedSection(title: string, content: string): string {
  const body = content.trim()
  return body ? `## ${title}\n${body}` : ''
}

function renderFrozenReplayPrompt(contract: ContractBundle): string {
  const model = contract.modelResolution ?? {}
  const promptLayers = objectArray<FrozenPromptLayer>(contract.promptLayerVersions)
    .slice()
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)
      || String(a.layerType ?? '').localeCompare(String(b.layerType ?? ''))
      || String(a.layerHash ?? '').localeCompare(String(b.layerHash ?? '')))
    .map((layer, index) => [
      `### Layer ${index + 1}: ${layer.layerType ?? 'unknown'}`,
      `priority=${layer.priority ?? 0}; version=${layer.version ?? 'unknown'}; hash=${layer.layerHash ?? 'unknown'}`,
      layer.contentSnapshot ?? '',
    ].join('\n').trim())
    .filter(Boolean)
    .join('\n\n')

  const systemPrompts = objectArray<FrozenSystemPrompt>(contract.systemPromptVersions)
    .slice()
    .sort((a, b) => String(a.key ?? '').localeCompare(String(b.key ?? '')) || (a.version ?? 0) - (b.version ?? 0))
    .map((prompt) => [
      `### System Prompt: ${prompt.key ?? 'unknown'}@${prompt.version ?? 'unknown'}`,
      prompt.content ?? '',
    ].join('\n').trim())
    .filter(Boolean)
    .join('\n\n')

  const stageBindings = objectArray<FrozenStageBinding>(contract.stageBindingVersions)
    .slice()
    .sort((a, b) => String(a.stageKey ?? '').localeCompare(String(b.stageKey ?? ''))
      || String(a.agentRole ?? '').localeCompare(String(b.agentRole ?? '')))
    .map((binding) => [
      `### Stage Binding: ${binding.stageKey ?? 'unknown'} / ${binding.agentRole ?? 'unknown'}`,
      `profileId=${binding.profileId ?? 'unknown'}`,
      binding.taskTemplate ? `taskTemplate:\n${binding.taskTemplate}` : '',
      binding.extraContextTemplate ? `extraContextTemplate:\n${binding.extraContextTemplate}` : '',
    ].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n')

  const toolPins = objectArray<FrozenToolPin>(contract.toolPins)
    .slice()
    .sort((a, b) => `${a.toolNamespace ?? ''}.${a.toolName ?? ''}`.localeCompare(`${b.toolNamespace ?? ''}.${b.toolName ?? ''}`))
    .map((pin) => [
      `- ${pin.toolNamespace ?? 'unknown'}.${pin.toolName ?? 'unknown'}@${pin.version ?? 'unknown'}`,
      `risk=${pin.riskLevel ?? 'unknown'}`,
      `requiresApproval=${pin.requires_approval === true}`,
    ].join('; '))
    .join('\n')

  return [
    'You are replaying an immutable Singularity execution contract.',
    'Use only the frozen contract material below as the replay authority. Do not infer live Prompt Composer rows, live prompt profile versions, or live tool versions.',
    '',
    numberedSection('Contract Identity', [
      `contractId=${contract.id ?? 'unknown'}`,
      `bundleHash=${contract.bundleHash ?? 'unknown'}`,
      `modelAlias=${model.alias ?? 'unknown'}`,
      `provider=${model.provider ?? 'unknown'}`,
      `model=${model.model ?? 'unknown'}`,
      `modelVersion=${model.version ?? 'unknown'}`,
    ].join('\n')),
    numberedSection('Frozen Prompt Layers', promptLayers),
    numberedSection('Frozen System Prompts', systemPrompts),
    numberedSection('Frozen Stage Bindings', stageBindings),
    numberedSection('Frozen Tool Pins', toolPins),
  ].filter(Boolean).join('\n\n')
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r\n|\r|\n/).length
}

function firstDifference(original: string, replay: string): { index: number; originalExcerpt: string; replayExcerpt: string } | null {
  const limit = Math.min(original.length, replay.length)
  let index = 0
  while (index < limit && original.charCodeAt(index) === replay.charCodeAt(index)) index += 1
  if (index === original.length && index === replay.length) return null
  const start = Math.max(0, index - 80)
  return {
    index,
    originalExcerpt: original.slice(start, Math.min(original.length, index + 160)),
    replayExcerpt: replay.slice(start, Math.min(replay.length, index + 160)),
  }
}

function buildReplayDiff(original: string | null, replay: string, meta: { originalRunId?: string; originalOutputId?: string | null }) {
  if (original == null) {
    return {
      baselineAvailable: false,
      reason: meta.originalRunId ? 'original run has no comparable LLM_RESPONSE output' : 'originalRunId not provided',
    }
  }
  return {
    baselineAvailable: true,
    originalRunId: meta.originalRunId,
    originalOutputId: meta.originalOutputId,
    exactMatch: original === replay,
    original: {
      sha256: sha256Text(original),
      chars: original.length,
      lines: lineCount(original),
    },
    replay: {
      sha256: sha256Text(replay),
      chars: replay.length,
      lines: lineCount(replay),
    },
    firstDifference: firstDifference(original, replay),
  }
}

async function loadOriginalRunResponse(req: Request, originalRunId?: string): Promise<{ rawContent: string | null; outputId: string | null }> {
  if (!originalRunId) return { rawContent: null, outputId: null }
  await assertAgentRunTenant(req, originalRunId)
  const output = await prisma.agentRunOutput.findFirst({
    where: { runId: originalRunId, outputType: 'LLM_RESPONSE' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, rawContent: true },
  })
  return { rawContent: output?.rawContent ?? null, outputId: output?.id ?? null }
}

contractsRouter.post('/:contractId/replay', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = replaySchema.parse(req.body)
    // 1. Fetch the contract bundle
    const cr = await fetch(`${COMPOSER_URL}/api/v1/contracts/${encodeURIComponent(req.params.contractId)}`, {
      headers: await promptComposerAuthHeaders(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!cr.ok) {
      return res.status(cr.status).json({ error: 'contract fetch failed' })
    }
    const contractEnvelope = await readComposerEnvelope<ContractBundle>(cr, 'composer contract replay fetch')
    if (contractEnvelope.parseError) {
      return res.status(502).json({ error: 'contract fetch invalid response', detail: contractEnvelope.parseError, raw: contractEnvelope.raw })
    }
    const contract = contractEnvelope.data
    if (!contract) {
      return res.status(404).json({ error: 'contract bundle empty' })
    }
    const now = Date.now()
    const traceId = traceIdFromParts(['contract-replay', req.params.contractId, now])
    const systemPrompt = renderFrozenReplayPrompt({ ...contract, id: req.params.contractId })
    const original = await loadOriginalRunResponse(req, body.originalRunId)

    // 2. Execute the frozen prompt verbatim. This route intentionally bypasses
    //    Prompt Composer re-assembly after bundle fetch; replay authority is the
    //    immutable contract JSON, not live prompt/profile rows.
    const result = await contextFabricClient.executeGovernedTurn({
      trace_id: traceId,
      idempotency_key: traceId,
      run_context: {
        workflow_instance_id: body.workflowInstanceId ?? `replay-${req.params.contractId}`,
        workflow_node_id: 'contract-replay',
        agent_run_id: traceIdFromParts(['replay', now]),
        agent_template_id: body.agentTemplateId,
        capability_id: body.capabilityId,
        trace_id: traceId,
        source_type: 'immutable-contract-replay',
        source_ref: req.params.contractId,
      },
      system_prompt: systemPrompt,
      task: body.originalInput,
      model_overrides: {
        modelAlias: contract.modelResolution?.alias ?? undefined,
        provider: contract.modelResolution?.provider ?? undefined,
        model: contract.modelResolution?.model ?? undefined,
      },
      governance_mode: config.DEFAULT_GOVERNANCE_MODE,
    })
    res.json({
      replayRunId: traceId,
      contractId: req.params.contractId,
      bundleHash: contract.bundleHash,
      response: result.finalResponse,
      status: result.status,
      diff: buildReplayDiff(original.rawContent, result.finalResponse ?? '', {
        originalRunId: body.originalRunId,
        originalOutputId: original.outputId,
      }),
    })
  } catch (err) {
    next(err)
  }
})
