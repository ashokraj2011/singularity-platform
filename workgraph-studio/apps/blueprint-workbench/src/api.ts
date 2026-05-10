export type SourceType = 'github' | 'localdir'
export type Stage = 'ARCHITECT' | 'DEVELOPER' | 'QA'
export type SessionStatus = 'DRAFT' | 'SNAPSHOTTED' | 'RUNNING' | 'COMPLETED' | 'APPROVED' | 'FAILED'
export type StageStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'

export type LookupCapability = {
  id: string
  capability_id?: string
  name: string
  capability_type?: string
  source?: string
}

export type LookupAgent = {
  id: string
  name: string
  description?: string
  model?: string
}

export type BlueprintSnapshot = {
  id: string
  status: string
  fileCount: number
  totalBytes: number
  rootHash?: string
  manifest: Array<{ path: string; size: number; language?: string }>
  summary: {
    languages?: Record<string, number>
    topLevel?: Record<string, number>
    sampledFiles?: Array<{ path: string; excerpt: string }>
    [key: string]: unknown
  }
  error?: string
  createdAt: string
}

export type BlueprintStageRun = {
  id: string
  stage: Stage
  status: StageStatus
  task: string
  response?: string
  error?: string
  correlation?: {
    cfCallId?: string
    traceId?: string
    promptAssemblyId?: string
    mcpInvocationId?: string
    codeChangeIds?: string[]
    [key: string]: unknown
  }
  tokensUsed?: { input?: number; output?: number; total?: number }
  startedAt?: string
  completedAt?: string
}

export type BlueprintArtifact = {
  id: string
  stage?: Stage
  kind: string
  title: string
  content?: string
  payload?: Record<string, unknown>
  createdAt: string
}

export type DecisionAnswer = {
  questionId: string
  answerType: 'option' | 'freeform'
  selectedOptionLabel?: string
  customAnswer?: string
  notes?: string
  updatedAt?: string
  updatedById?: string
}

export type BlueprintSession = {
  id: string
  goal: string
  sourceType: 'GITHUB' | 'LOCALDIR'
  sourceUri: string
  sourceRef?: string
  capabilityId: string
  architectAgentTemplateId: string
  developerAgentTemplateId: string
  qaAgentTemplateId: string
  status: SessionStatus
  approvedAt?: string
  snapshots: BlueprintSnapshot[]
  stageRuns: BlueprintStageRun[]
  artifacts: BlueprintArtifact[]
  metadata?: {
    decisionAnswers?: DecisionAnswer[]
    decisionAnswersUpdatedAt?: string
    [key: string]: unknown
  }
}

export type CreateSessionRequest = {
  goal: string
  sourceType: SourceType
  sourceUri: string
  sourceRef?: string
  includeGlobs: string[]
  excludeGlobs: string[]
  capabilityId: string
  architectAgentTemplateId: string
  developerAgentTemplateId: string
  qaAgentTemplateId: string
}

type PersistedAuth = { state?: { token?: string | null } }

export function getToken() {
  try {
    const raw = localStorage.getItem('workgraph-auth')
    if (!raw) return null
    return (JSON.parse(raw) as PersistedAuth).state?.token ?? null
  } catch {
    return null
  }
}

export function saveToken(token: string) {
  localStorage.setItem('workgraph-auth', JSON.stringify({ state: { token }, version: 0 }))
}

export function clearToken() {
  localStorage.removeItem('workgraph-auth')
}

export async function pseudoLogin() {
  const res = await fetch('http://localhost:8101/api/v1/auth/local/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@pseudo.local', password: 'pseudo' }),
  })
  if (!res.ok) throw new Error(`Pseudo-IAM login failed (${res.status})`)
  const body = await res.json() as { access_token: string }
  saveToken(body.access_token)
  return body.access_token
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken()
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `Request failed with ${res.status}`)
  }
  return await res.json() as T
}

function unwrap<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)) {
    return (data as { items: T[] }).items
  }
  return []
}

export const api = {
  listSessions: () => request<{ items: BlueprintSession[] }>('/blueprint/sessions'),
  createSession: (body: CreateSessionRequest) => request<BlueprintSession>('/blueprint/sessions', { method: 'POST', body: JSON.stringify(body) }),
  snapshot: (id: string) => request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/snapshot`, { method: 'POST' }),
	  run: (id: string) => request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/run`, { method: 'POST' }),
	  approve: (id: string) => request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
	  saveDecisionAnswers: (id: string, answers: DecisionAnswer[]) => request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/decision-answers`, { method: 'POST', body: JSON.stringify({ answers }) }),
	  capabilities: async () => unwrap<LookupCapability>(await request('/lookup/capabilities?size=200')),
  agents: async (capabilityId: string) => unwrap<LookupAgent>(await request(`/lookup/agent-templates?size=200&capability_id=${encodeURIComponent(capabilityId)}`)),
}
