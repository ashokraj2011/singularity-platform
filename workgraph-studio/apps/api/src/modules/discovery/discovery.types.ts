/**
 * Unified Discovery & Elicitation — shared types + injectable ports (ADR 0006).
 *
 * The service is written against these ports so unit tests can drive the full
 * elicit loop with in-memory fakes — no live DB, Context Fabric, or MCP needed.
 */

export type DiscoveryScopeType = 'WORKFLOW_STAGE' | 'WORK_ITEM' | 'RUN'
export type DiscoverySessionStatus = 'OPEN' | 'RESOLVING' | 'BLOCKED' | 'RESOLVED' | 'ABANDONED'
export type DiscoveryQuestionKind = 'single_select' | 'multi_select' | 'freeform' | 'clarification'
export type DiscoveryQuestionSource = 'configured' | 'llm' | 'copilot' | 'human' | 'agent'
export type DiscoveryQuestionStatus = 'OPEN' | 'ANSWERED' | 'DISMISSED'
export type DiscoveryAssumptionStatus = 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'VALIDATED' | 'INVALIDATED'

export interface DiscoveryQuestionRecord {
  id: string
  sessionId: string
  tenantId?: string | null
  text: string
  kind: DiscoveryQuestionKind
  source: DiscoveryQuestionSource
  blocking: boolean
  status: DiscoveryQuestionStatus
  options?: unknown
  answer?: string | null
  answeredById?: string | null
  answeredAt?: Date | null
  proposedAnswer?: string | null
  confidence?: number | null
  ordinal: number
  createdAt: Date
  updatedAt: Date
}

export interface DiscoveryAssumptionRecord {
  id: string
  sessionId: string
  tenantId?: string | null
  text: string
  confidence: number
  status: DiscoveryAssumptionStatus
  validatedById?: string | null
  validatedAt?: Date | null
  evidenceRef?: unknown
  createdAt: Date
  updatedAt: Date
}

export interface DiscoverySessionRecord {
  id: string
  tenantId?: string | null
  scopeType: DiscoveryScopeType
  scopeId: string
  status: DiscoverySessionStatus
  touchPoint?: string | null
  budget?: DiscoveryBudget | null
  createdById?: string | null
  createdAt: Date
  updatedAt: Date
}

export interface DiscoverySessionWithChildren extends DiscoverySessionRecord {
  questions: DiscoveryQuestionRecord[]
  assumptions: DiscoveryAssumptionRecord[]
}

/**
 * Running budget accounting for the elicit loop. `max*` are hard caps; the
 * spent counters accumulate across iterations and the loop refuses to run a
 * model/tool call once a cap is reached.
 */
export interface DiscoveryBudget {
  maxTurns: number
  maxToolCalls: number
  maxInputTokens: number
  maxOutputTokens: number
  turns: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
}

export const DEFAULT_BUDGET: DiscoveryBudget = {
  maxTurns: 8,
  maxToolCalls: 16,
  maxInputTokens: 400_000,
  maxOutputTokens: 120_000,
  turns: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
}

// ── Ports ──────────────────────────────────────────────────────────────────

export interface CreateSessionInput {
  scopeType: DiscoveryScopeType
  scopeId: string
  touchPoint?: string
  createdById?: string
  tenantId?: string
  budget?: Partial<DiscoveryBudget>
}

export interface UpsertQuestionInput {
  sessionId: string
  tenantId?: string
  text: string
  kind?: DiscoveryQuestionKind
  source?: DiscoveryQuestionSource
  blocking?: boolean
  options?: unknown
  proposedAnswer?: string | null
  confidence?: number | null
  ordinal?: number
}

export interface UpsertAssumptionInput {
  sessionId: string
  tenantId?: string
  text: string
  confidence?: number
  evidenceRef?: unknown
}

/** Storage port — persistence for sessions, questions, assumptions. */
export interface DiscoveryStore {
  createSession(input: CreateSessionInput): Promise<DiscoverySessionRecord>
  getSession(id: string): Promise<DiscoverySessionWithChildren | null>
  updateSessionStatus(id: string, status: DiscoverySessionStatus): Promise<void>
  updateSessionBudget(id: string, budget: DiscoveryBudget): Promise<void>

  addQuestion(input: UpsertQuestionInput): Promise<DiscoveryQuestionRecord>
  /** Idempotency helper: a question whose trimmed text already exists on the session. */
  findQuestionByText(sessionId: string, text: string): Promise<DiscoveryQuestionRecord | null>
  getQuestion(id: string): Promise<DiscoveryQuestionRecord | null>
  answerQuestion(id: string, answer: string, answeredById?: string): Promise<DiscoveryQuestionRecord>
  dismissQuestion(id: string): Promise<DiscoveryQuestionRecord>

  addAssumption(input: UpsertAssumptionInput): Promise<DiscoveryAssumptionRecord>
  getAssumption(id: string): Promise<DiscoveryAssumptionRecord | null>
  setAssumptionStatus(
    id: string,
    status: DiscoveryAssumptionStatus,
    opts?: { validatedById?: string; evidenceRef?: unknown },
  ): Promise<DiscoveryAssumptionRecord>
}

export interface ModelTurnRequest {
  systemPrompt: string
  task: string
  modelAlias?: string | null
  outputTokenBudget?: number
  traceId?: string
  /** run_context.executor='copilot' when the routed alias targets Copilot. */
  executor?: string
}

export interface ModelTurnResult {
  status: string
  text: string
  inputTokens: number
  outputTokens: number
  correlationId?: string
}

/** Governed model access — backed by Context Fabric's governed single-turn. */
export interface ModelCaller {
  governedTurn(req: ModelTurnRequest): Promise<ModelTurnResult>
}

export interface ToolRunRequest {
  toolName: string
  args: Record<string, unknown>
  traceId?: string
}

export interface ToolRunResult {
  ok: boolean
  data?: unknown
  error?: string
}

/** Read-only research tools — backed by MCP `/mcp/tool-run`. */
export interface ToolCaller {
  run(req: ToolRunRequest): Promise<ToolRunResult>
}

/** Resolves the model alias for a touch point (server-side llm-routing). */
export type RoutingResolver = (
  touchPoint: string,
  opts: { userId?: string | null; capabilityId?: string | null },
) => Promise<string | null>

export interface DiscoveryDeps {
  store: DiscoveryStore
  model: ModelCaller
  tool: ToolCaller
  resolveRouting: RoutingResolver
  /** Aliases that should run through Copilot rather than the raw gateway. */
  copilotAliasPattern?: RegExp
  now?: () => Date
}

export interface ElicitInput {
  sessionId: string
  userId?: string
  capabilityId?: string
  /** Free-form steer for this iteration (e.g. "focus on data-model unknowns"). */
  hint?: string
  /** Extra scope context the caller already has (stage brief, work-item body…). */
  context?: string
  /** Optional read-only research tool to run before eliciting. */
  research?: { toolName: string; args: Record<string, unknown> }
  budget?: Partial<DiscoveryBudget>
  traceId?: string
}

export interface ElicitResult {
  session: DiscoverySessionWithChildren
  addedQuestions: DiscoveryQuestionRecord[]
  addedAssumptions: DiscoveryAssumptionRecord[]
  budget: DiscoveryBudget
  /** Non-fatal notes (budget hit, tool failure, unparseable model output…). */
  notes: string[]
}
