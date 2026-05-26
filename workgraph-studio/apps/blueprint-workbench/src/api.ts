export type SourceType = 'github' | 'localdir'
export type Stage = string
export type SessionStatus = 'DRAFT' | 'SNAPSHOTTED' | 'RUNNING' | 'COMPLETED' | 'APPROVED' | 'FAILED'
export type StageStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
export type GateMode = 'manual' | 'auto'
export type SnapshotMode = 'summary' | 'relevant_excerpts' | 'full_debug'
export type GovernanceMode = 'fail_open' | 'fail_closed' | 'degraded' | 'human_approval_required'
export type LoopVerdict = 'PASS' | 'NEEDS_REWORK' | 'BLOCKED' | 'ACCEPTED_WITH_RISK'

// M60 Slice 2 — line-anchored operator annotations on send-back. Mirror
// of `sendBackAnnotationSchema` in workgraph-api's blueprint.router.ts.
export type SendBackAnnotation = {
  file: string
  startLine: number
  endLine?: number
  comment: string
  severity?: 'must-fix' | 'suggestion' | 'question'
}
export type LoopAttemptStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'PAUSED'
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
  sourceType?: SourceType
  sourceUri?: string
  repoUrl?: string
  defaultBranch?: string
  repositories?: Array<{
    id?: string
    repoName?: string
    repoUrl?: string
    repositoryType?: string
    defaultBranch?: string
    status?: string
  }>
  metadata?: Record<string, unknown>
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
    // M56 — Per-phase token + cost rollup from mcp-server's
    // computePhaseTokens. Keys are phase names (PLAN_DRAFT / EXPLORE / …)
    // plus 'unknown' for legacy / flat-loop calls. Values are
    // { input, output, cost, calls } sums.
    phaseTokens?: Record<string, { input: number; output: number; cost: number; calls: number }>
    [key: string]: unknown
  }
  // M56 — Added estimatedCost alongside the existing total, so the
  // workbench can show $ figures next to the token count.
  tokensUsed?: { input?: number; output?: number; total?: number; estimatedCost?: number }
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

// ── M45 — Loop trace (Workbench Loop tab) ───────────────────────────────
export type LoopTracePromptMessage = {
  role: string
  content_preview: string
  tool_call_id?: string
  tool_name?: string
}
export type LoopTraceToolInvocation = {
  id: string
  name: string
  args: Record<string, unknown> | unknown
  output: unknown
  success: boolean
  error?: string | null
  error_code?: string | null
  latencyMs: number
  timestamp: string
}
export type LoopTraceStep = {
  llmCallId: string
  stepIndex: number | null
  phase: string | null
  model: { provider: string; model: string; alias: string | null }
  tokens: { input: number; output: number }
  finishReason: 'stop' | 'tool_call' | 'length' | 'error'
  latencyMs: number
  timestamp: string
  promptPreview: LoopTracePromptMessage[]
  responseText: string | null
  responseToolCalls: Array<{ name: string; args_preview: string }>
  toolInvocations: LoopTraceToolInvocation[]
  error?: string | null
}
export type LoopTracePhaseBlock = {
  phase: string
  startStepIndex: number | null
  endStepIndex: number | null
  llmCallCount: number
  toolInvocationCount: number
  startedAt: string
  endedAt: string
}
export type LoopTraceResponse = {
  traceId: string
  phases: LoopTracePhaseBlock[]
  steps: LoopTraceStep[]
  summary: {
    totalSteps: number
    totalLlmCalls: number
    totalToolInvocations: number
    totalCodeChanges: number
    changedPaths: string[]
    firstStepAt?: string | null
    latestStepAt?: string | null
    finishReason?: string | null
  }
}

export type LoopQuestion = {
  id: string
  question: string
  type?: 'single_select' | 'multi_select' | 'freeform' | 'clarification'
  required?: boolean
  options?: Array<{ label: string; impact?: string; recommended?: boolean }>
  freeform?: boolean
  source?: 'configured' | 'llm_open_question'
  stageKey?: string
  attemptId?: string
}

export type DecisionAnswer = {
  questionId: string
  questionText?: string
  normalizedQuestion?: string
  answerType: 'option' | 'multi_option' | 'freeform'
  selectedOptionLabel?: string
  selectedOptionLabels?: string[]
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
  // M82 S1 — operator may overwrite this artifact from the workbench.
  // Mirror of the backend field; the Edit button on each artifact card
  // keys off this. Defaults to false (read-only) when unset.
  editable?: boolean
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
  // M82 S2 — when true, the approval card surfaces a "Mark done"
  // button that bypasses the required-question gate. Mirror of the
  // backend field. Defaults to undefined (treated as false).
  allowMarkDone?: boolean
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
  stageModelAliases?: Record<string, string>
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
  generatedQuestionIds?: string[]
  gateRecommendation?: GateRecommendation
  correlation?: BlueprintStageRun['correlation']
  tokensUsed?: BlueprintStageRun['tokensUsed']
  metrics?: Record<string, unknown>
  pendingApproval?: Record<string, unknown> | null
  verificationReceipts?: Array<Record<string, unknown>>
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

// M41.2 — Stage Chat. One thread per stage, persisted in session.metadata
// and surfaced to the next agent attempt via the {{operatorChat}} Mustache
// var rendered by prompt-composer's loopDefaultTask template.
export type StageChatMessage = {
  id: string
  role: 'operator' | 'system' | 'agent'
  content: string
  createdAt: string
  authorId?: string
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
  browserRunId?: string
  workflowNodeId?: string
  phaseId?: string
  gateMode?: GateMode
  currentStageKey?: string | null
  loopDefinition?: LoopDefinition
  stageAttempts?: StageAttempt[]
  reviewEvents?: ReviewEvent[]
  decisionAnswers?: DecisionAnswer[]
  // M41.2 — Operator-to-agent conversation threads keyed by stage.
  stageChats?: Record<string, StageChatMessage[]>
  finalPack?: FinalPack
  executionConfig?: WorkbenchExecutionConfig
  snapshots: BlueprintSnapshot[]
  stageRuns: BlueprintStageRun[]
  artifacts: BlueprintArtifact[]
  metadata?: {
    browserRunId?: string
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
  browserRunId?: string
  workflowNodeId?: string
  phaseId?: string
  loopDefinition?: LoopDefinition
  gateMode?: GateMode
  intakeDefaults?: {
    goal?: string
    sourceType?: SourceType
    sourceUri?: string
    sourceRef?: string
    sourceProvenance?: string
  }
  intakeOverrides?: {
    goalEdited?: boolean
    sourceEdited?: boolean
    originalGoal?: string
    editedGoal?: string
    originalSourceType?: SourceType
    editedSourceType?: SourceType
    originalSourceUri?: string
    editedSourceUri?: string
    originalSourceRef?: string
    editedSourceRef?: string
    sourceProvenance?: string
  }
} & WorkbenchExecutionConfig & {
  maxLoopsPerStage?: number
  maxTotalSendBacks?: number
}

type PersistedAuth = { state?: { token?: string | null } }

export const BLUEPRINT_AUTH_INVALID_EVENT = 'blueprintWorkbench.auth.invalid'
const PSEUDO_IAM_LOGIN_URL = import.meta.env.VITE_PSEUDO_IAM_LOGIN_URL
  ?? `${window.location.protocol}//${window.location.hostname}:8100/api/v1/auth/local/login`
const PSEUDO_LOGIN_EMAIL = import.meta.env.VITE_PSEUDO_LOGIN_EMAIL ?? 'admin@singularity.local'
const PSEUDO_LOGIN_PASSWORD = import.meta.env.VITE_PSEUDO_LOGIN_PASSWORD ?? 'Admin1234!'

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

function notifyInvalidAuth() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(BLUEPRINT_AUTH_INVALID_EVENT))
}

export async function pseudoLogin() {
  const res = await fetch(PSEUDO_IAM_LOGIN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: PSEUDO_LOGIN_EMAIL, password: PSEUDO_LOGIN_PASSWORD }),
  })
  if (!res.ok) throw new Error(`Workbench login failed against ${PSEUDO_IAM_LOGIN_URL} (${res.status})`)
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
      clearToken()
      notifyInvalidAuth()
    }
    // M78 Slice 2 — Try to surface the API's structured error body
    // (code/message/details). If the response is JSON-shaped, attach
    // the parsed fields to a richer Error subclass so React Query's
    // mutation.error gives downstream UI access to error.details for
    // the inherited-failure cards. Falls back to the plain string
    // path when the body isn't JSON (legacy endpoints).
    let parsed: unknown = null
    try { parsed = text ? JSON.parse(text) : null } catch { /* not JSON */ }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      const message = typeof obj.message === 'string' && obj.message
        ? obj.message
        : `Request failed with ${res.status}`
      throw new ApiError(message, {
        code: typeof obj.code === 'string' ? obj.code : undefined,
        statusCode: res.status,
        details: (obj.details && typeof obj.details === 'object' && !Array.isArray(obj.details))
          ? obj.details as Record<string, unknown>
          : undefined,
      })
    }
    throw new Error(text || `Request failed with ${res.status}`)
  }
  return await res.json() as T
}

/**
 * M78 — Error subclass that preserves the API's structured `details`
 * payload. React Query's mutation.error surfaces this verbatim, so
 * downstream components can branch on `details.kind === 'verification_
 * failure_analysis'` and render inherited-failure cards instead of
 * a flat message string.
 */
export class ApiError extends Error {
  readonly code?: string
  readonly statusCode: number
  readonly details?: Record<string, unknown>
  constructor(message: string, opts: { code?: string; statusCode: number; details?: Record<string, unknown> }) {
    super(message)
    this.name = 'ApiError'
    this.code = opts.code
    this.statusCode = opts.statusCode
    this.details = opts.details
  }
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
  resetStageAttempts: (id: string, stageKey: string) =>
    request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/stages/${encodeURIComponent(stageKey)}/reset-attempts`, { method: 'POST' }),
  snapshot: (id: string) => request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/snapshot`, { method: 'POST' }),
  run: (id: string) => request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/run`, { method: 'POST' }),
  runStage: (id: string, stageKey: string) => request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/stages/${encodeURIComponent(stageKey)}/run`, { method: 'POST' }),
  // M78 Slice 3 — One-click remediation WI creation from an inherited
  // failure card. Returns { id, workCode, title, capabilityId } so the
  // toast can link out. Body matches the workgraph-api Zod schema:
  // failure (test, file, exception, exceptionLine, hint) + optional
  // originAttemptId for back-linking.
  createInheritedFailureRemediation: (
    sessionId: string,
    stageKey: string,
    body: {
      failure: { test: string; file: string; exception?: string; exceptionLine?: number; hint?: string }
      originAttemptId?: string
      titleOverride?: string
      targetCapabilityId?: string
    },
  ) => request<{ id: string; workCode: string; title: string; capabilityId: string }>(
    `/blueprint/sessions/${encodeURIComponent(sessionId)}/stages/${encodeURIComponent(stageKey)}/inherited-failure/remediate`,
    { method: 'POST', body: JSON.stringify(body) },
  ),
  stageApproval: (id: string, stageKey: string, body: { decision: 'approved' | 'rejected'; reason?: string; argsOverride?: Record<string, unknown> }) =>
    request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/stages/${encodeURIComponent(stageKey)}/approval`, { method: 'POST', body: JSON.stringify(body) }),
  // M82 S2 — `MARK_DONE` is a wire-only verdict variant. The backend
  // persists it as PASS but skips the missing-required-questions gate
  // when the stage opts in via allowMarkDone. LoopVerdict union stays
  // clean so downstream UI logic doesn't have to know about it.
  verdict: (
    id: string,
    stageKey: string,
    body: { verdict: LoopVerdict | 'MARK_DONE'; feedback?: string; confidence?: number; acceptRisk?: boolean; answers?: DecisionAnswer[] },
  ) =>
    request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/stages/${encodeURIComponent(stageKey)}/verdict`, { method: 'POST', body: JSON.stringify(body) }),
  // M82 S1 — operator overwrites an artifact body. Backend refuses
  // unless the artifact's kind is declared with editable=true in the
  // workflow node's loopDefinition.expectedArtifacts. Returns the
  // full session (consistent with verdict / send-back / approve) so
  // the workbench cache invalidates uniformly.
  editArtifact: (sessionId: string, artifactId: string, body: { content: string; reason?: string }) =>
    request<BlueprintSession>(
      `/blueprint/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),
  // M83 S1 — worktree file browser. Proxies to mcp-server's
  // /mcp/worktree/<workItemCode>/{tree,file} endpoint. The backend
  // resolves the workItemCode from the session's workflow context, so
  // the client doesn't need to know it.
  worktreeTree: (sessionId: string, path: string = '', showHidden = false) => {
    const params = new URLSearchParams()
    if (path) params.set('path', path)
    if (showHidden) params.set('showHidden', 'true')
    const qs = params.toString()
    return request<{
      workItemCode: string
      workItemRoot: string
      path: string
      truncated: boolean
      entries: Array<{ name: string; type: 'dir' | 'file' | 'other' }>
    }>(`/blueprint/sessions/${encodeURIComponent(sessionId)}/worktree/tree${qs ? `?${qs}` : ''}`)
  },
  worktreeFile: (sessionId: string, path: string) =>
    request<{
      workItemCode: string
      path: string
      sizeBytes: number
      modifiedAt: string
      encoding: 'utf-8' | 'base64'
      content: string
      blobSha: string | null
    }>(`/blueprint/sessions/${encodeURIComponent(sessionId)}/worktree/file?path=${encodeURIComponent(path)}`),
  // M83 S2 — write a file edit to wi/<code> as a commit attributed to
  // the operator. expectedSha is the file's last-known blob sha
  // (returned from worktreeFile); when set, server refuses with 409
  // STALE_EDIT if the branch tip moved (agent landed a parallel commit).
  worktreeWriteFile: (
    sessionId: string,
    path: string,
    body: { content: string; message?: string; expectedSha?: string },
  ) =>
    request<{
      workItemCode: string
      path: string
      edited: boolean
      reason?: string
      commitSha?: string
      headSha?: string
      branch?: string
      blobSha?: string
      linesAdded?: number
      linesRemoved?: number
      author?: { name: string; email: string }
      message?: string
    }>(
      `/blueprint/sessions/${encodeURIComponent(sessionId)}/worktree/file?path=${encodeURIComponent(path)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  sendBack: (id: string, stageKey: string, body: { targetStageKey: string; reason: string; requiredChanges?: string; blockingQuestions?: string[]; annotations?: SendBackAnnotation[] }) =>
    request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/stages/${encodeURIComponent(stageKey)}/send-back`, { method: 'POST', body: JSON.stringify(body) }),
  finalize: (id: string) => request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/finalize`, { method: 'POST' }),
  approve: (id: string) => request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  saveDecisionAnswers: (id: string, answers: DecisionAnswer[]) => request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/decision-answers`, { method: 'POST', body: JSON.stringify({ answers }) }),
  // M41.2 — Stage Chat.
  listStageMessages: (id: string, stageKey: string) =>
    request<{ items: StageChatMessage[] }>(`/blueprint/sessions/${encodeURIComponent(id)}/stages/${encodeURIComponent(stageKey)}/messages`),
  postStageMessage: (id: string, stageKey: string, body: { content: string; role?: 'operator' | 'system' }) =>
    request<{ message: StageChatMessage; thread: StageChatMessage[] }>(
      `/blueprint/sessions/${encodeURIComponent(id)}/stages/${encodeURIComponent(stageKey)}/messages`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  codeChanges: (id: string, stageKey?: string) => request<BlueprintCodeChangesResponse>(
    `/blueprint/sessions/${encodeURIComponent(id)}/code-changes${stageKey ? `?stageKey=${encodeURIComponent(stageKey)}` : ''}`,
  ),
  // M45 — Loop trace timeline for the Workbench Loop tab. Polls while the
  // stage is RUNNING; React Query handles refetchInterval at the call site.
  loopTrace: (id: string, stageKey: string) => request<LoopTraceResponse>(
    `/blueprint/sessions/${encodeURIComponent(id)}/stages/${encodeURIComponent(stageKey)}/loop-trace`,
  ),
  capabilities: async () => unwrap<LookupCapability>(await request('/lookup/capabilities?size=200')),
  agents: async (capabilityId: string) => unwrap<LookupAgent>(await request(`/lookup/agent-templates?size=200&capability_id=${encodeURIComponent(capabilityId)}`)),
  workflowInstances: async () => unwrap<WorkflowInstanceListItem>(await request('/workflow-instances?size=20')),
  workflowInstance: (id: string) => request<WorkflowInstanceDetail>(`/workflow-instances/${encodeURIComponent(id)}`),
  // M42.7 — list registered model aliases the LLM gateway will accept.
  // Used by the per-stage model picker in the Neo cockpit so operators can
  // pin a stronger model (e.g. Sonnet for DEVELOP) without leaving the UI.
  listModelAliases: () => request<LlmModelCatalog>('/llm/models'),
}

export type LlmModelCatalogEntry = {
  id: string
  label?: string
  provider?: string
  model?: string
  description?: string
  costTier?: 'low' | 'medium' | 'high' | string
  default?: boolean
  ready?: boolean
  warnings?: string[]
}

export type LlmModelCatalog = {
  default_model_alias?: string
  models: LlmModelCatalogEntry[]
}
