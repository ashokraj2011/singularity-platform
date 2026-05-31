/**
 * M42.6 — Code Foundry API client.
 *
 * Single thin fetch wrapper. All endpoints live under /api/codegen/*
 * which Vite proxies to the code-foundry-api during dev. In a real
 * deployment the SPA is served by the same host as the API, so the
 * same relative paths work without any proxy.
 *
 * Auth model (M100 P0, 2026-05-31): the SERVICE token is no longer read
 * from a build-time env var (that baked it into the browser bundle). The
 * same-origin `/api` proxy injects the service token server-side from the
 * FOUNDRY_TOKEN env (see vite.config.ts). The only token the client sets is
 * an OPERATOR-pasted one from localStorage('foundry.token') — that's the
 * user's own credential, not a shared secret. Localhost requests skip auth
 * entirely thanks to the API side's bearer middleware logic.
 */
export interface RunSummary {
  id: string
  specId: string
  specName?: string
  specVersion?: string
  specKind?: string
  mode: 'GREENFIELD' | 'BROWNFIELD'
  status: string
  templateVersion: string
  generatorVersion: string
  outputPath: string | null
  startedAt: string
  completedAt: string | null
  brownfieldPlanId: string | null
}

export interface RunDetail extends RunSummary {
  spec?: { specName: string; version: string; kind: string; specHash: string; irHash: string | null }
  receipt?: { id: string; receiptHash: string; createdAt: string } | null
  changePlan?: { id: string; status: string; planHash: string; repoModelId: string } | null
  counts: { artifacts: number; gaps: number; openGaps: number; llmTasks: number; openLlmTasks: number }
}

export interface ArtifactRow {
  id: string
  path: string
  contentHash: string
  fileType: string
  protected: boolean
  createdAt: string
}

export interface GapRow {
  id: string
  gapType: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  filePath: string | null
  className: string | null
  methodName: string | null
  regionId: string | null
  description: string
  recommendedResolution: string | null
  llmEligible: boolean
  resolved: boolean
  createdAt: string
}

export interface LlmTaskRow {
  id: string
  runId: string
  gapId: string | null
  taskType: string
  status: 'PENDING' | 'DISPATCHED' | 'GUARD_PASSED' | 'GUARD_REJECTED' | 'CANCELLED' | 'FAILED'
  targetFile: string
  targetClass: string | null
  targetMethod: string | null
  regionId: string
  allowedChanges: unknown
  forbiddenChanges: unknown
  metadata: Record<string, unknown> | null
  createdAt: string
  dispatchedAt: string | null
  completedAt: string | null
}

export interface RepoModelSummary {
  id: string
  repoPath: string
  language: string
  framework: string
  modelHash: string
  scannedAt: string
}

export interface ChangePlanSummary {
  id: string
  repoModelId: string
  planHash: string
  enhancementSpecHash: string
  status: 'PROPOSED' | 'PARTIALLY_APPLIED' | 'APPLIED' | 'FAILED' | 'REJECTED'
  createdAt: string
  appliedAt: string | null
}

class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message)
  }
}

function getToken(): string | null {
  // M100 P0 — the SERVICE token is NOT read from a build-time env var anymore
  // (that baked it into the browser bundle). The same-origin `/api` proxy
  // injects it server-side from FOUNDRY_TOKEN (see vite.config.ts). The only
  // token the client supplies is an OPERATOR-pasted one from localStorage —
  // the user's own credential, not a shared secret.
  try {
    const v = localStorage.getItem('foundry.token')
    if (v) return v
  } catch { /* ignore SSR / private mode */ }
  return null
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (!headers.has('content-type') && init?.body && typeof init.body === 'string') {
    headers.set('content-type', 'application/json')
  }
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(path, { ...init, headers })
  let body: unknown
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) body = await res.json()
  else body = await res.text()
  if (!res.ok) {
    const msg = typeof body === 'object' && body && 'message' in body
      ? String((body as { message: unknown }).message)
      : `${res.status} ${res.statusText}`
    throw new ApiError(res.status, msg, body)
  }
  return body as T
}

export const api = {
  health: () => request<{ status: string; service: string }>(`/health`),

  listRuns: (params: { take?: number; skip?: number; mode?: string; status?: string } = {}) => {
    const q = new URLSearchParams()
    if (params.take !== undefined) q.set('take', String(params.take))
    if (params.skip !== undefined) q.set('skip', String(params.skip))
    if (params.mode) q.set('mode', params.mode)
    if (params.status) q.set('status', params.status)
    return request<{ total: number; take: number; skip: number; items: RunSummary[] }>(
      `/api/codegen/runs?${q.toString()}`,
    )
  },

  getRun: (runId: string) =>
    request<RunDetail>(`/api/codegen/runs/${runId}`),

  listArtifacts: (runId: string) =>
    request<{ runId: string; outputPath: string | null; items: ArtifactRow[] }>(
      `/api/codegen/runs/${runId}/artifacts`,
    ),

  fileContent: (runId: string, path: string) =>
    request<{ path: string; bytes: number; content: string; modifiedAt: string }>(
      `/api/codegen/runs/${runId}/file?path=${encodeURIComponent(path)}`,
    ),

  listGaps: (runId: string) =>
    request<{ runId: string; items: GapRow[] }>(`/api/codegen/runs/${runId}/gaps`),

  listLlmTasks: (runId: string) =>
    request<{ runId: string; items: LlmTaskRow[] }>(`/api/codegen/runs/${runId}/llm-tasks`),

  receipt: (runId: string) =>
    request<{ id: string; receiptJson: Record<string, unknown>; receiptHash: string; createdAt: string }>(
      `/api/codegen/runs/${runId}/receipt`,
    ),

  dispatchTask: (taskId: string) =>
    request<{ taskId: string; status: string; diff?: string; error?: string }>(
      `/api/codegen/llm-tasks/${taskId}/dispatch`,
      { method: 'POST', body: '{}' },
    ),

  applyPatch: (taskId: string, diff: string) =>
    request<{
      taskId: string
      status: 'GUARD_PASSED' | 'GUARD_REJECTED'
      stage?: string
      reason?: string
      appliedFiles?: Array<{ path: string; beforeHash: string; afterHash: string }>
    }>(`/api/codegen/llm-tasks/${taskId}/apply-patch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diff }),
    }),

  listRepos: () =>
    request<{ items: RepoModelSummary[] }>(`/api/codegen/repos`),

  listChangePlans: (repoModelId?: string) => {
    const q = repoModelId ? `?repoModelId=${encodeURIComponent(repoModelId)}` : ''
    return request<{ items: ChangePlanSummary[] }>(`/api/codegen/change-plans${q}`)
  },
}

export { ApiError }
