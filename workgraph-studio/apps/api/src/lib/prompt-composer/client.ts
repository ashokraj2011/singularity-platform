/**
 * Prompt Composer HTTP client — M5 wire.
 *
 * Legacy Prompt Composer HTTP client.
 *
 * Workgraph AGENT_TASK now calls context-fabric /execute directly. Context
 * Fabric invokes prompt-composer in preview mode, then dispatches through MCP.
 * This client is kept for older code paths and direct preview tooling.
 *
 * POST /api/v1/compose-and-respond on prompt-composer:
 *   1. Assembles the layered prompt from PromptProfile + capability context +
 *      knowledge artifacts + distilled memory + tool grants + workflow vars +
 *      artifacts + EXECUTION_OVERRIDE layers.
 *   2. For non-preview calls, delegates to context-fabric /execute and returns
 *      the unified response.
 *
 * Returns correlation IDs that Workgraph mirrors onto AgentRun columns and
 * keeps in AgentRunOutput.structuredPayload for full replay detail:
 *   - promptAssemblyId  → composer.PromptAssembly
 *   - modelCallId       → context-fabric.ModelCall
 *   - contextPackageId  → context-fabric.ContextPackage
 */

import { config } from '../../config'
import { getIamServiceToken } from '../iam/service-token'
import { isJsonObject, readUpstreamJsonBody, upstreamSnippet, type UpstreamJsonBody } from '../upstream-json'

export interface ComposeArtifact {
  consumableId?: string
  consumableType?: string
  role?: 'INPUT' | 'CONTEXT' | 'REFERENCE'
  label: string
  mediaType?: string
  content?: string
  minioRef?: string
  excerpt?: string
}

export interface ComposeRequest {
  agentTemplateId: string
  agentBindingId?: string
  capabilityId?: string
  task: string
  workflowContext: {
    instanceId: string
    nodeId: string
    phaseId?: string
    vars?: Record<string, unknown>
    globals?: Record<string, unknown>
    priorOutputs?: Record<string, unknown>
  }
  artifacts?: ComposeArtifact[]
  overrides?: {
    additionalLayers?: { layerType?: string; content: string }[]
    systemPromptAppend?: string
    extraContext?: string
  }
  modelOverrides?: {
    provider?: string
    model?: string
    temperature?: number
    maxOutputTokens?: number
  }
  contextPolicy?: {
    optimizationMode?: string
    maxContextTokens?: number
    compareWithRaw?: boolean
  }
  toolDiscovery?: {
    enabled?: boolean
    riskMax?: 'low' | 'medium' | 'high' | 'critical'
    limit?: number
  }
  previewOnly?: boolean
}

export interface ComposeResponse {
  promptAssemblyId: string
  promptHash: string
  estimatedInputTokens: number | null
  layersUsed: { layerType: string; priority: number; layerHash: string; inclusionReason: string }[]
  warnings: string[]
  // Present unless previewOnly:
  modelCallId?: string
  contextPackageId?: string
  response?: string
  optimization?: {
    mode: string
    raw_input_tokens: number
    optimized_input_tokens: number
    tokens_saved: number
    percent_saved: number
    estimated_cost_saved: number
  }
  modelUsage?: {
    provider: string
    model: string
    input_tokens: number
    output_tokens: number
    estimated_cost: number
    latency_ms: number
  }
  // Present only when previewOnly:
  assembled?: { systemPrompt: string; message: string }
}

export class PromptComposerError extends Error {
  constructor(message: string, public status: number, public detail?: unknown) {
    super(message)
    this.name = 'PromptComposerError'
  }
}

type PromptComposerBody = UpstreamJsonBody

type PromptComposerEnvelope<T> = {
  success: boolean
  data?: T
  error?: unknown
}

async function readPromptComposerBody(res: Response): Promise<PromptComposerBody> {
  return readUpstreamJsonBody(res)
}

function promptComposerDetail(body: PromptComposerBody): unknown {
  if (isJsonObject(body.data)) return body.data.error ?? body.data.detail ?? body.data
  if (body.parseError) return { body: upstreamSnippet(body.raw, 500), parseError: body.parseError }
  return body.data
}

function promptComposerMessage(path: string, status: number, body: PromptComposerBody, max = 500): string {
  const text = body.raw.trim() || (typeof body.data === 'string' ? body.data : '')
  return `prompt-composer ${path} returned ${status}: ${upstreamSnippet(text, max) || 'empty response body'}`
}

async function readPromptComposerEnvelope<T>(
  res: Response,
  path: string,
): Promise<PromptComposerEnvelope<T>> {
  const body = await readPromptComposerBody(res)
  if (!res.ok) {
    throw new PromptComposerError(
      promptComposerMessage(path, res.status, body),
      res.status,
      promptComposerDetail(body),
    )
  }
  if (body.parseError) {
    throw new PromptComposerError(
      `prompt-composer ${path} returned invalid JSON (${body.parseError}): ${upstreamSnippet(body.raw, 500) || 'empty response body'}`,
      502,
      promptComposerDetail(body),
    )
  }
  if (!isJsonObject(body.data)) {
    throw new PromptComposerError(
      `prompt-composer ${path} returned an invalid envelope`,
      502,
      body.data,
    )
  }
  return {
    success: body.data.success === true,
    data: body.data.data as T | undefined,
    error: body.data.error,
  }
}

// M36.1 — Stage-prompt resolution. Callers stop hardcoding prompt strings
// in TS source and instead pass {stageKey, agentRole?, vars} here. Composer
// reads StagePromptBinding → PromptProfile, renders the taskTemplate
// (Mustache `{{var}}` substitution), and returns the ready-to-use task body
// plus a system-prompt fragment to splice into the /compose-and-respond call.
export interface ResolveStageRequest {
  stageKey: string
  agentRole?: string
  // M71 — optional phase narrowing. When set, prompt-composer prefers a
  // (stageKey, agentRole, phase) binding; falls back to the stage-level row
  // when no phase-specific override exists.
  phase?: 'PLAN' | 'EXPLORE' | 'ACT' | 'VERIFY' | 'REPAIR' | 'SELF_REVIEW' | 'FINALIZE'
  promptProfileKey?: string
  vars?: Record<string, unknown>
}

export interface ResolveStageResponse {
  task: string
  systemPromptAppend: string
  // M36.6 — rendered extraContext (empty string if the bound profile has no
  // extraContextTemplate). Workbench loop runner uses this so the
  // per-execution policy block is also DB-owned.
  extraContext: string
  promptProfileId: string
  bindingId: string
  stageKey: string
  agentRole: string | null
  // M71 — which phase the matched binding targets, or null when a stage-
  // level (fallback) binding matched. Lets the caller log whether they got
  // a phase-specific prompt or the stage default.
  phase: string | null
}

// M36.4 — SystemPrompt in-process cache. Workgraph-api lives outside the
// agent-and-tools workspace so it can't import @agentandtools/shared; mirrors
// that helper inline. Same shape, same TTL default.
interface SysPromptCacheEntry {
  fetchedAt: number
  content: string
  version: number
}
const sysPromptCache = new Map<string, SysPromptCacheEntry>()
const sysPromptInflight = new Map<string, Promise<{ content: string; version: number }>>()
const SYSTEM_PROMPT_CACHE_DEFAULT_TTL_SEC = 300
const SYSTEM_PROMPT_CACHE_MAX_TTL_SEC = 24 * 60 * 60

export function systemPromptCacheTtlMs(
  raw = process.env.SYSTEM_PROMPT_CACHE_TTL_SEC,
): number {
  const fallback = SYSTEM_PROMPT_CACHE_DEFAULT_TTL_SEC * 1000
  if (raw === undefined || raw.trim() === '') return fallback

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback

  return Math.min(SYSTEM_PROMPT_CACHE_MAX_TTL_SEC, Math.trunc(parsed)) * 1000
}

export async function promptComposerAuthHeaders(
  baseHeaders: Record<string, string> = {},
): Promise<Record<string, string>> {
  const token = await getIamServiceToken()
  return token
    ? { ...baseHeaders, authorization: `Bearer ${token}` }
    : baseHeaders
}

async function getSystemPromptCached(key: string, vars?: Record<string, unknown>): Promise<{ content: string; version: number }> {
  const ttlMs = systemPromptCacheTtlMs()
  const cacheKey = vars ? `${key}::${JSON.stringify(vars, Object.keys(vars).sort())}` : key
  const hit = sysPromptCache.get(cacheKey)
  if (hit && Date.now() - hit.fetchedAt < ttlMs) return { content: hit.content, version: hit.version }

  const existing = sysPromptInflight.get(cacheKey)
  if (existing) return existing

  const promise = (async () => {
    const url = vars
      ? `${config.PROMPT_COMPOSER_URL}/api/v1/system-prompts/${encodeURIComponent(key)}/render`
      : `${config.PROMPT_COMPOSER_URL}/api/v1/system-prompts/${encodeURIComponent(key)}`
    try {
      const res = await fetch(url, {
        method: vars ? 'POST' : 'GET',
        headers: await promptComposerAuthHeaders({ 'content-type': 'application/json' }),
        body: vars ? JSON.stringify({ vars }) : undefined,
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        try {
          await readPromptComposerEnvelope<{ content: string; version: number }>(res, `/system-prompts/${key}`)
        } catch (err) {
          if (hit) return { content: hit.content, version: hit.version }
          throw err
        }
      }
      let json: PromptComposerEnvelope<{ content: string; version: number }>
      try {
        json = await readPromptComposerEnvelope<{ content: string; version: number }>(res, `/system-prompts/${key}`)
      } catch (err) {
        if (hit) return { content: hit.content, version: hit.version }
        throw err
      }
      const data = isJsonObject(json.data) ? json.data : null
      const content = typeof data?.content === 'string' ? data.content : ''
      const version = typeof data?.version === 'number' ? data.version : 0
      if (!json.success || !content) {
        if (hit) return { content: hit.content, version: hit.version }
        throw new PromptComposerError(`SystemPrompt fetch ${key} returned an unusable envelope`, 502, json.error ?? json.data)
      }
      sysPromptCache.set(cacheKey, { fetchedAt: Date.now(), content, version })
      return { content, version }
    } finally {
      sysPromptInflight.delete(cacheKey)
    }
  })()
  sysPromptInflight.set(cacheKey, promise)
  return promise
}

export const promptComposerClient = {
  async composeAndRespond(input: ComposeRequest): Promise<ComposeResponse> {
    const url = `${config.PROMPT_COMPOSER_URL}/api/v1/compose-and-respond`
    const res = await fetch(url, {
      method: 'POST',
      headers: await promptComposerAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(240_000),
    })
    const json = await readPromptComposerEnvelope<ComposeResponse>(res, '/compose-and-respond')
    if (!json.success) {
      throw new PromptComposerError('prompt-composer returned success=false', 502, json.error)
    }
    if (!json.data) throw new PromptComposerError('prompt-composer returned success=true without data', 502, json)
    return json.data
  },

  // M36.4 — Fetch a single-shot SystemPrompt by key. Used by event-horizon
  // and any other path that needs ONE named prompt (not a layered profile).
  // In-process cached for 5 minutes (configurable via SYSTEM_PROMPT_CACHE_TTL_SEC).
  async getSystemPrompt(key: string, vars?: Record<string, unknown>): Promise<{ content: string; version: number }> {
    return getSystemPromptCached(key, vars)
  },

  // M36.1 — Resolve a (stageKey, agentRole) tuple to a rendered task + system
  // prompt. Replaces inline architectTask/developerTask/qaTask/stageSystemPrompt
  // /loopStageTask/loopStageSystemPrompt in workgraph-api source. Edit the
  // prompts via prompt-composer's seed.ts (or live via a future admin UI);
  // workgraph-api carries no prompt text after M36.2.
  async resolveStage(input: ResolveStageRequest): Promise<ResolveStageResponse> {
    const url = `${config.PROMPT_COMPOSER_URL}/api/v1/stage-prompts/resolve`
    const res = await fetch(url, {
      method: 'POST',
      headers: await promptComposerAuthHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000),
    })
    const json = await readPromptComposerEnvelope<ResolveStageResponse>(res, '/stage-prompts/resolve')
    if (!json.success) {
      throw new PromptComposerError('prompt-composer stage resolve returned success=false', 502, json.error)
    }
    if (!json.data) throw new PromptComposerError('prompt-composer stage resolve returned success=true without data', 502, json)
    return json.data
  },
}
