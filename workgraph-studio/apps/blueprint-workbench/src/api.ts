export type SourceType = 'github' | 'localdir'
export type Stage = string
export type SessionStatus = 'DRAFT' | 'SNAPSHOTTED' | 'RUNNING' | 'COMPLETED' | 'APPROVED' | 'FAILED'
export type StageStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
export type GateMode = 'manual' | 'auto'
export type SnapshotMode = 'summary' | 'relevant_excerpts' | 'full_debug'
export type GovernanceMode = 'fail_open' | 'fail_closed' | 'degraded' | 'human_approval_required'
export type LoopVerdict = 'PASS' | 'NEEDS_REWORK' | 'BLOCKED' | 'ACCEPTED_WITH_RISK'
export type LoopAttemptStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'PASSED'
  | 'NEEDS_REWORK'
  | 'BLOCKED'
  | 'ACCEPTED_WITH_RISK'

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
  stageKey?: string
  attemptId?: string
  version?: number
  consumableId?: string
  consumableVersion?: number
  consumableStatus?: string
  kind: string
  title: string
  content?: string
  payload?: Record<string, unknown>
  createdAt: string
}

export type CodeChangeRecord = {
  id: string
  tool_name?: string
  paths_touched?: string[]
  diff?: string
  patch?: string
  commit_sha?: string
  language?: string
  lines_added?: number
  lines_removed?: number
  timestamp?: string
  stale?: boolean
}

export type BlueprintCodeChangesResponse = {
  sessionId: string
  cfCallIds: string[]
  items: CodeChangeRecord[]
  stale?: boolean
  errors?: string[]
}

export type LoopQuestion = {
  id: string
  question: string
  required?: boolean
  options?: Array<{ label: string; impact?: string; recommended?: boolean }>
  freeform?: boolean
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

export type LoopExpectedArtifact = {
  kind: string
  title: string
  description?: string
  required?: boolean
  format?: 'MARKDOWN' | 'TEXT' | 'JSON' | 'CODE'
}

export type LoopStage = {
  key: string
  label: string
  agentRole: Stage
  agentTemplateId?: string
  description?: string
  next?: string | null
  terminal?: boolean
  required?: boolean
  approvalRequired?: boolean
  expectedArtifacts?: LoopExpectedArtifact[]
  allowedSendBackTo?: string[]
  questions?: LoopQuestion[]
}

export type LoopDefinition = {
  version: number
  name: string
  stages: LoopStage[]
  maxLoopsPerStage: number
  maxTotalSendBacks: number
}

export type WorkbenchExecutionConfig = {
  snapshotMode?: SnapshotMode
  excerptBudgetChars?: number
  reuseUnchangedAttempt?: boolean
  modelAlias?: string
  governanceMode?: GovernanceMode
  maxContextTokens?: number
  maxOutputTokens?: number
  maxPromptChars?: number
  maxLayerChars?: number
}

export type GateRecommendation = {
  verdict: LoopVerdict
  confidence: number
  reason: string
  targetStageKey?: string
}

export type StageAttempt = {
  id: string
  stageKey: string
  stageLabel: string
  agentRole: Stage
  agentTemplateId: string
  attemptNumber: number
  status: LoopAttemptStatus
  startedAt: string
  completedAt?: string
  response?: string
  error?: string
  verdict?: LoopVerdict
  confidence?: number
  feedback?: string
  acceptedAt?: string
  acceptedById?: string
  artifactIds?: string[]
  gateRecommendation?: GateRecommendation
  correlation?: BlueprintStageRun['correlation']
  tokensUsed?: BlueprintStageRun['tokensUsed']
  metrics?: Record<string, unknown>
}

export type ReviewEvent = {
  id: string
  type: string
  stageKey?: string
  targetStageKey?: string
  attemptId?: string
  message: string
  actorId?: string
  payload?: Record<string, unknown>
  createdAt: string
}

export type FinalPack = {
  id: string
  status: string
  generatedAt: string
  generatedById?: string
  summary: string
  stages: Array<{
    stageKey: string
    label: string
    verdict: LoopVerdict
    attemptNumber: number
    artifactIds: string[]
  }>
  artifactKinds: string[]
  stageConsumables?: Array<Record<string, unknown>>
  consumableIds?: string[]
  finalPackArtifactId?: string
  finalPackConsumableId?: string
  finalPackConsumableVersion?: number
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
  workflowInstanceId?: string
  workflowNodeId?: string
  phaseId?: string
  gateMode?: GateMode
  currentStageKey?: string | null
  loopDefinition?: LoopDefinition
  stageAttempts?: StageAttempt[]
  reviewEvents?: ReviewEvent[]
  decisionAnswers?: DecisionAnswer[]
  finalPack?: FinalPack
  executionConfig?: WorkbenchExecutionConfig
  snapshots: BlueprintSnapshot[]
  stageRuns: BlueprintStageRun[]
  artifacts: BlueprintArtifact[]
  metadata?: {
    decisionAnswers?: DecisionAnswer[]
    decisionAnswersUpdatedAt?: string
    executionConfig?: WorkbenchExecutionConfig
    [key: string]: unknown
  }
}

export type WorkflowInstanceContext = {
  _globals?: Record<string, unknown>
  _vars?: Record<string, unknown>
  _params?: Record<string, unknown>
  [key: string]: unknown
}

export type WorkflowInstanceNode = {
  id: string
  nodeType: string
  config?: Record<string, unknown>
}

export type WorkflowInstanceDetail = {
  id: string
  context?: WorkflowInstanceContext
  nodes?: WorkflowInstanceNode[]
}

export type WorkflowInstanceListItem = {
  id: string
  name?: string
  status?: string
  createdAt?: string
}

export type CreateSessionRequest = {
  goal: string
  sourceType: SourceType
  sourceUri: string
  sourceRef?: string
  includeGlobs: string[]
  excludeGlobs: string[]
  capabilityId: string
  architectAgentTemplateId?: string
  developerAgentTemplateId?: string
  qaAgentTemplateId?: string
  workflowInstanceId?: string
  workflowNodeId?: string
  phaseId?: string
  loopDefinition?: LoopDefinition
  gateMode?: GateMode
} & WorkbenchExecutionConfig & {
  maxLoopsPerStage?: number
  maxTotalSendBacks?: number
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
    if (res.status === 401) {
      localStorage.removeItem('workgraph-auth')
    }
    throw new Error(text || `Request failed with ${res.status}`)
  }
  return await res.json() as T
}

function unwrap<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)) {
    return (data as { items: T[] }).items
  }
  if (data && typeof data === 'object' && Array.isArray((data as { content?: unknown }).content)) {
    return (data as { content: T[] }).content
  }
  return []
}

export const api = {
  listSessions: () => request<{ items: BlueprintSession[] }>('/blueprint/sessions'),
  createSession: (body: CreateSessionRequest) => request<BlueprintSession>('/blueprint/sessions', { method: 'POST', body: JSON.stringify(body) }),
  updateSettings: (id: string, body: WorkbenchExecutionConfig & { maxLoopsPerStage?: number; maxTotalSendBacks?: number }) =>
    request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/settings`, { method: 'PATCH', body: JSON.stringify(body) }),
  snapshot: (id: string) => request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/snapshot`, { method: 'POST' }),
  run: (id: string) => request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/run`, { method: 'POST' }),
  runStage: (id: string, stageKey: string) => request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/stages/${encodeURIComponent(stageKey)}/run`, { method: 'POST' }),
  verdict: (id: string, stageKey: string, body: { verdict: LoopVerdict; feedback?: string; confidence?: number; acceptRisk?: boolean; answers?: DecisionAnswer[] }) =>
    request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/stages/${encodeURIComponent(stageKey)}/verdict`, { method: 'POST', body: JSON.stringify(body) }),
  sendBack: (id: string, stageKey: string, body: { targetStageKey: string; reason: string; requiredChanges?: string; blockingQuestions?: string[] }) =>
    request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/stages/${encodeURIComponent(stageKey)}/send-back`, { method: 'POST', body: JSON.stringify(body) }),
  finalize: (id: string) => request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/finalize`, { method: 'POST' }),
  approve: (id: string) => request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  saveDecisionAnswers: (id: string, answers: DecisionAnswer[]) => request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/decision-answers`, { method: 'POST', body: JSON.stringify({ answers }) }),
  codeChanges: (id: string, stageKey?: string) => request<BlueprintCodeChangesResponse>(
    `/blueprint/sessions/${encodeURIComponent(id)}/code-changes${stageKey ? `?stageKey=${encodeURIComponent(stageKey)}` : ''}`,
  ),
  capabilities: async () => unwrap<LookupCapability>(await request('/lookup/capabilities?size=200')),
  agents: async (capabilityId: string) => unwrap<LookupAgent>(await request(`/lookup/agent-templates?size=200&capability_id=${encodeURIComponent(capabilityId)}`)),
  workflowInstances: async () => unwrap<WorkflowInstanceListItem>(await request('/workflow-instances?size=20')),
  workflowInstance: (id: string) => request<WorkflowInstanceDetail>(`/workflow-instances/${encodeURIComponent(id)}`),
}
