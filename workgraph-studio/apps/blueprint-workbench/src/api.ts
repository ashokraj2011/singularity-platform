import { API_BASE, sharedAuthToken } from './base'

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

// M98 P2 — Lightweight session status (GET /blueprint/sessions/:id/status).
// A cheap polling shape with no snapshots / stageRuns / artifacts — just enough
// to notice a backend-driven stage transition while the operator watches. The
// session's `updatedAt` advances on every metadata write, so the workbench
// treats it as a single change signal and only refetches the full session when
// it moves.
export type BlueprintSessionStatusLite = {
  id: string
  status: SessionStatus
  currentStageKey: string | null
  updatedAt: string
  latestAttempt: {
    id: string
    stageKey: string
    attemptNumber: number
    status: LoopAttemptStatus
    verdict: LoopVerdict | null
  } | null
}

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
  // M83.r — thinking is the Anthropic extended-thinking token count
  // for this step (separate from output_tokens). 0 / undefined for
  // non-Anthropic providers or when thinking is off.
  tokens: { input: number; output: number; thinking?: number }
  finishReason: 'stop' | 'tool_call' | 'length' | 'error'
  latencyMs: number
  timestamp: string
  promptPreview: LoopTracePromptMessage[]
  responseText: string | null
  responseToolCalls: Array<{ name: string; args_preview: string }>
  toolInvocations: LoopTraceToolInvocation[]
  error?: string | null
  // M83.r — Anthropic extended thinking blocks. Empty for steps that
  // didn't use extended thinking. Each block: {thinking, signature?,
  // redacted?}. signature is opaque + not needed for display; redacted
  // means Anthropic encrypted the content for safety reasons.
  thinkingBlocks?: Array<{ thinking: string; signature?: string; redacted?: boolean }>
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
// M89.b — Governance events surfaced alongside the LLM steps. Used by
// LoopTrace to render inline phase boundaries, validator rejections,
// budget warnings, etc — the same signals the bin/stage-trace.py CLI
// shows in terminal form. stepIndex is the closest preceding LLM call,
// so the UI can interleave these events with StepCards.
export type LoopTraceGovEventKind =
  | 'phase_completed'
  | 'phase_output_invalid'
  | 'phase_budget_exceeded'
  | 'path_coverage_gap'
  | 'auto_verify_completed'

export type LoopTraceGovernanceEvent = {
  kind: LoopTraceGovEventKind
  phase: string | null
  timestamp: string
  stepIndex: number | null
  details: {
    reason?: string
    missingFields?: string[]
    budget?: number
    turnsInPhase?: number
    uncoveredCount?: number
  }
}

export type LoopTraceResponse = {
  traceId: string
  phases: LoopTracePhaseBlock[]
  steps: LoopTraceStep[]
  /** M89.b — see LoopTraceGovernanceEvent. Empty on older traces (pre-M89). */
  governanceEvents?: LoopTraceGovernanceEvent[]
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

export type StageContextPolicy = 'NONE' | 'STORY_ONLY' | 'REPO_READ_ONLY' | 'CODE_EDIT' | 'VERIFY_ONLY' | 'EVIDENCE_REVIEW'
export type StageToolPolicy = 'NONE' | 'READ_ONLY' | 'MUTATION' | 'VERIFICATION'

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
  // M83 task #172/#173 — per-stage gating signals for the Code
  // overlay. Mirror of the backend's normalizeLoopStage output.
  // toolPolicy='MUTATION' → Edit button visible (dev stages).
  // toolPolicy='MUTATION' || 'VERIFICATION' → Run tests + API
  //   caller panels visible (dev + qa + test-cert).
  // Tree + read-only file viewer always visible (read affordance
  // helps every reviewer).
  contextPolicy?: StageContextPolicy
  toolPolicy?: StageToolPolicy
  // Mirror of backend normalizeLoopStage: false on story-only stages
  // (toolPolicy=NONE + repoAccess=false ⇒ story / no-repo workspace).
  repoAccess?: boolean
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
  // M100 — per-stage, per-phase model alias overrides:
  //   { [stageKeyOrLabel]: { [PHASE]: modelAlias } }
  // The current governed phase's entry wins over the stage alias; unset
  // phases inherit the stage model. Mirrors the workgraph-api persistence.
  stagePhaseModelAliases?: Record<string, Record<string, string>>
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
  // M100 P2 — prefer the canonical portal session (shared localStorage under
  // the single origin), then fall back to the legacy 'workgraph-auth' store.
  const shared = sharedAuthToken()
  if (shared) return shared
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
  const headers = {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(init.headers ?? {}),
  }
  // 2026-05-26 — single-shot 5xx retry for read-only methods. nginx's
  // built-in proxy_next_upstream fires retries in milliseconds (no
  // delay-between-retries config exists), which doesn't help when
  // workgraph-api is mid-restart and connection refuses instantly.
  // The realistic mitigation lives here: detect 502/503/504, wait
  // ~1.5s, try once more. Disabled for mutating methods so an
  // accidental double-commit can't happen if the first request
  // actually completed before the connection broke.
  const method = (init.method ?? 'GET').toUpperCase()
  const canRetry = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
  let res = await fetch(`${API_BASE}${path}`, { ...init, headers })
  if (canRetry && (res.status === 502 || res.status === 503 || res.status === 504)) {
    await new Promise(resolve => setTimeout(resolve, 1500))
    res = await fetch(`${API_BASE}${path}`, { ...init, headers })
  }
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
  getSession: (id: string) => request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}`),
  // M98 P2 — cheap status poll backing the workbench live-status refresh.
  sessionStatus: (id: string) =>
    request<BlueprintSessionStatusLite>(`/blueprint/sessions/${encodeURIComponent(id)}/status`),
  createSession: (body: CreateSessionRequest) => request<BlueprintSession>('/blueprint/sessions', { method: 'POST', body: JSON.stringify(body) }),
  updateSettings: (id: string, body: WorkbenchExecutionConfig & { maxLoopsPerStage?: number; maxTotalSendBacks?: number }) =>
    request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/settings`, { method: 'PATCH', body: JSON.stringify(body) }),
  resetStageAttempts: (id: string, stageKey: string) =>
    request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/stages/${encodeURIComponent(stageKey)}/reset-attempts`, { method: 'POST' }),
  // M89.e — Surgical cancel of the in-flight attempt for a stage.
  // Unlike resetStageAttempts (which deletes everything), this only
  // marks the RUNNING/PAUSED attempt as FAILED so the stage can be
  // re-run without losing the prior attempt history.
  cancelInflightAttempt: (id: string, stageKey: string) =>
    request<BlueprintSession>(`/blueprint/sessions/${encodeURIComponent(id)}/stages/${encodeURIComponent(stageKey)}/cancel-attempt`, { method: 'POST' }),
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
  // M83 S4 v1 — operator-driven API caller. Proxies an HTTP request
  // to a target the operator brought up themselves (host, sibling
  // container, etc.). Backend refuses non-private targets. Container
  // lifecycle ("bring up the app") is a deferred S4 followup.
  workitemApiCall: (sessionId: string, body: { method: string; url: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) =>
    request<{
      ok: boolean
      status: number
      statusText?: string
      headers?: Record<string, string>
      body?: string
      byteLength?: number
      truncated?: boolean
      durationMs: number
      error?: string
    }>(`/blueprint/sessions/${encodeURIComponent(sessionId)}/api-call`, { method: 'POST', body: JSON.stringify(body) }),
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
  // M83.z2 — Manually bind a session to a WorkItem when the workflow
  // didn't bind one automatically. Accepts either workItemId (UUID)
  // or workItemCode (e.g. "WRK-984AD") — server enforces exactly one.
  // After this returns ok, the worktree endpoints resolve cleanly.
  bindWorkItem: (sessionId: string, body: { workItemId?: string; workItemCode?: string }) =>
    request<{
      ok: boolean
      sessionId: string
      workflowInstanceId: string
      workItem: { id: string; workCode: string; title: string }
      replacedPrevious: string | null
    }>(
      `/blueprint/sessions/${encodeURIComponent(sessionId)}/bind-workitem`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  // M83 S3.2 — Attach a human-origin verification receipt to the
  // latest stage attempt. Called by the Test Runner panel when a
  // manual run finishes so the approval gate sees the human evidence
  // alongside the agent's. The receipt is marked origin=human and
  // carries the operator's IAM identity in capturedBy.
  worktreeAttachVerification: (
    sessionId: string,
    body: {
      command: string
      passed: boolean
      exitCode: number | null
      durationMs: number
      toolName?: string
      output?: string
      notes?: string
    },
  ) =>
    request<{
      ok: boolean
      receipt: Record<string, unknown>
      attemptId: string
      stageKey: string
      totalReceipts: number
    }>(
      `/blueprint/sessions/${encodeURIComponent(sessionId)}/worktree/verification`,
      { method: 'POST', body: JSON.stringify(body) },
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
  //
  // M100 — normalize the response. mcp-server wraps payloads in a
  // { success, data, requestId } envelope and names the default alias
  // `defaultModelAlias` (camelCase); the workbench wants a flat
  // { default_model_alias, models }. We unwrap the envelope (tolerant of
  // either shape) and accept either casing so the catalog actually
  // populates the picker.
  listModelAliases: async (): Promise<LlmModelCatalog> => {
    const data = unwrapLlmEnvelope<{
      default_model_alias?: string
      defaultModelAlias?: string
      models?: LlmModelCatalogEntry[]
    }>(await request<unknown>('/llm/models'))
    return {
      default_model_alias: data.default_model_alias ?? data.defaultModelAlias,
      models: Array.isArray(data.models) ? data.models : [],
    }
  },
  // M100 — provider readiness for the live, provider-aware picker. Polled on
  // a short interval at the call site so a provider flip (e.g. via
  // bin/llm-use-copilot.sh) is reflected without a hard reload.
  listProviders: async (): Promise<LlmProviderList> => {
    const data = unwrapLlmEnvelope<LlmProviderList>(await request<unknown>('/llm/providers'))
    return {
      default_provider: data.default_provider,
      default_model: data.default_model,
      providers: Array.isArray(data.providers) ? data.providers : [],
    }
  },
}

// M100 — tolerate mcp-server's { success, data, requestId } envelope. Returns
// `.data` when the value looks like that envelope, else the value itself (so
// it keeps working if an upstream layer ever unwraps for us).
function unwrapLlmEnvelope<T>(raw: unknown): T {
  if (raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>) && 'success' in (raw as Record<string, unknown>)) {
    return (raw as { data: T }).data
  }
  return raw as T
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

// M100 — live provider readiness (GET /llm/providers).
export type LlmProvider = {
  name: string
  ready?: boolean
  default_model?: string
  allowed?: boolean
  enabled?: boolean
  warnings?: string[]
}

export type LlmProviderList = {
  default_provider?: string
  default_model?: string
  providers: LlmProvider[]
}
