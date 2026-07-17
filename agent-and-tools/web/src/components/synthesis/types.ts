/**
 * Shared types for the Synthesis app. These mirror the workgraph API response
 * shapes (studio projects, discovery, rooms) so screens can be strongly typed.
 */

export type ProjectStatus = "ACTIVE" | "ARCHIVED" | "DRAFT" | string;

export type InitiativeAgingStatus = "CURRENT" | "REVIEW_DUE" | "STALE" | "OVERDUE";
export type ImpactAssessmentStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";

export interface SynCapabilityLink {
  id: string;
  capabilityId: string;
  capabilityName?: string | null;
  role: "PRIMARY" | "IMPACTED";
  impactArea?: string | null;
}

export interface SynImpactAssessment {
  id: string;
  capabilityId: string;
  capabilityName?: string | null;
  agentTemplateId?: string | null;
  agentTemplateName?: string | null;
  status: ImpactAssessmentStatus;
  summary?: string | null;
  recommendations?: string[];
  risks?: string[];
  dependencies?: string[];
  suggestedClaims?: Array<{ statement: string; rationale?: string; claimType?: string }>;
  traceId?: string | null;
  tokensUsed?: number;
  estimatedCostUsd?: number | null;
  error?: string | null;
  assessedAt?: string | null;
}

export interface SynProject {
  id: string;
  code: string;
  name: string;
  mission?: string | null;
  status: ProjectStatus;
  createdById?: string | null;
  archivedAt?: string | null;
  primaryCapabilityId?: string | null;
  primaryCapabilityName?: string | null;
  capabilityLinks?: SynCapabilityLink[];
  impactAssessments?: SynImpactAssessment[];
  tokenBudget: number;
  tokenUsed: number;
  tokenBudgetPercent?: number;
  costBudgetUsd?: number | null;
  costUsedUsd?: number;
  businessValue?: number | null;
  customerImpact?: number | null;
  strategicAlignment?: number | null;
  urgency?: number | null;
  deliveryRisk?: number | null;
  technicalRisk?: number | null;
  regulatoryRisk?: number | null;
  confidence?: number | null;
  effort?: number | null;
  valueScore?: number | null;
  riskScore?: number | null;
  priorityScore?: number | null;
  targetDate?: string | null;
  reviewCadenceDays?: number;
  lastReviewedAt?: string | null;
  sponsorId?: string | null;
  productOwnerId?: string | null;
  successMetrics?: string[];
  tags?: string[];
  ageDays?: number;
  inactiveDays?: number;
  agingStatus?: InitiativeAgingStatus;
  latestActivityAt?: string;
  impactAssessmentStatus?: "NONE" | "PENDING" | "RUNNING" | "COMPLETED" | "ATTENTION";
  claimCount?: number;
  createdAt: string;
  updatedAt: string;
  workItemCount: number;
}

export interface SynWorkItemCard {
  id: string;
  code?: string;
  title?: string;
  name?: string;
  status?: string;
  projectId?: string | null;
  updatedAt?: string;
  createdAt?: string;
}

export interface SynPortfolio {
  projects: SynProject[];
  standaloneWorkItems: SynWorkItemCard[];
}

/* ─── Discovery ─────────────────────────────────────────────────────────── */

export type DiscoveryQuestionStatus = "OPEN" | "ANSWERED" | "DISMISSED" | string;
export type DiscoveryAssumptionStatus =
  | "PROPOSED"
  | "VALIDATED"
  | "REJECTED"
  | "PENDING"
  | string;

export interface DiscoveryQuestion {
  id: string;
  sessionId: string;
  prompt: string;
  rationale?: string | null;
  status: DiscoveryQuestionStatus;
  blocking?: boolean;
  answer?: string | null;
  category?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface DiscoveryAssumption {
  id: string;
  sessionId: string;
  statement: string;
  rationale?: string | null;
  status: DiscoveryAssumptionStatus;
  confidence?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface DiscoverySession {
  id: string;
  scopeType?: string;
  scopeId?: string | null;
  status?: string;
  questions?: DiscoveryQuestion[];
  assumptions?: DiscoveryAssumption[];
  blocked?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/* ─── Rooms / claims ────────────────────────────────────────────────────── */

export type ClaimType = "MARKET" | "USER" | "OPERATIONAL" | "TECHNICAL" | string;

export interface SynRoom {
  id: string;
  title: string;
  projectId: string;
  state?: string;
  claimCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface SynClaim {
  id: string;
  roomId?: string | null;
  projectId: string;
  statement: string;
  riskiestAssumption?: string | null;
  claimType?: ClaimType;
  contextScope?: string | null;
  entityKind?: string | null;
  entityId?: string | null;
  status?: string;
  stewardId?: string;
  alpha?: number;
  beta?: number;
  /** Posterior mean probability the claim is true (0–1). */
  mean?: number;
  concentration?: number;
  /** Variance across estimators — where the team is most ignorant. */
  disagreement?: number;
  estimateCount?: number;
  provenance?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

export interface SynConvergence {
  bestGainPerHour: number;
  converged: boolean;
  openProbes: number;
  bar: number;
}

export interface SynProbe {
  id: string;
  claimId: string;
  roomId?: string | null;
  riskiestAssumption: string;
  falsification: string;
  tier?: string;
  status?: string;
  eig?: number;
  ownerId?: string | null;
  deadline?: string | null;
  createdAt?: string;
}

/* ─── Idea-board synthesis ──────────────────────────────────────────────── */

export type SynthesisInsightKind = "THEME" | "TENSION" | "OPPORTUNITY";

export interface SynthesisInsight {
  kind: SynthesisInsightKind;
  title: string;
  summary: string;
  sourceIds: string[];
  keywords: string[];
  confidence: number;
}

export interface BoardSynthesisResult {
  sourceCount: number;
  coveredSourceCount: number;
  coverage: number;
  themes: SynthesisInsight[];
  tensions: SynthesisInsight[];
  opportunities: SynthesisInsight[];
  warnings: string[];
}

/* ─── Specification package ─────────────────────────────────────────────── */

export type RequirementPriority = "MUST" | "SHOULD" | "MAY" | string;

export interface SpecRequirement {
  id: string;
  statement: string;
  priority: RequirementPriority;
  acceptanceCriteria: string[];
  rationale?: string;
}

export interface SpecDecision {
  id: string;
  title: string;
  status: string;
  context?: string;
  decision: string;
  consequences?: string;
}

export interface SpecAnalysis {
  problem: string;
  goals: { text: string; metric?: string }[];
  stakeholders: { name: string; role?: string; concern?: string }[];
  assumptions: string[];
  constraints: string[];
}

export interface SpecPackage {
  analysis: SpecAnalysis;
  requirements: SpecRequirement[];
  decisions: SpecDecision[];
}

export interface ProjectSpecView {
  projectId: string;
  revision: number;
  package: SpecPackage;
  updatedAt: string;
}

/* ─── Decisions, generation, and economics ─────────────────────────────── */

export interface SynDecisionOption {
  id: string;
  dossierId: string;
  title: string;
  summary: string;
  status: "ACTIVE" | "ACCEPTED" | "REJECTED" | string;
  claimRefs: string[];
  tradeoffs: string[];
  estimatedHours?: number | null;
  estimatedCostLow?: number | null;
  estimatedCostHigh?: number | null;
  estimatedTokens?: number | null;
  riskScore?: number | null;
}

export interface SynDecisionDossier {
  id: string;
  projectId: string;
  title: string;
  problem: string;
  status: "DRAFT" | "IN_REVIEW" | "ACCEPTED" | "REJECTED" | "CHANGES_REQUESTED" | string;
  claimRefs: string[];
  resolvesTensions: string[];
  acceptedOptionId?: string | null;
  approvalRequestId?: string | null;
  revision: number;
  options: SynDecisionOption[];
  createdAt: string;
  updatedAt: string;
}

export interface SynSpecificationVersion {
  id: string;
  specificationProjectId: string;
  version: number;
  status: string;
  contentHash?: string | null;
  createdAt: string;
}

export interface SynGenerationPlanRow {
  id: string;
  rowKey: string;
  title: string;
  state: string;
  workItemId?: string | null;
  error?: string | null;
  requirementIds: string[];
  decisionRefs: string[];
  claimRefs: string[];
  estimatedHours?: number | null;
  estimatedCostLow?: number | null;
  estimatedCostHigh?: number | null;
  estimatedTokens?: number | null;
  projectedStartAt?: string | null;
  projectedFinishAt?: string | null;
  criticalPath?: boolean;
  capacityCalendarId?: string | null;
  capacityAllocationId?: string | null;
  actualStartAt?: string | null;
  actualFinishAt?: string | null;
  actualHours?: number | null;
  actualCostUsd?: number | null;
}

export interface SynGenerationPlan {
  id: string;
  specificationProjectId: string;
  specificationVersionId?: string | null;
  status: string;
  totalRows: number;
  appliedRows: number;
  validation?: { valid?: boolean; errors?: string[]; warnings?: string[] };
  rows: SynGenerationPlanRow[];
  amendments?: Array<{ id: string; generation: number; status: string; reason: string; requestedStartAt?: string | null; createdAt: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface SynProjectEconomics {
  project: {
    id: string;
    tokenBudget: number;
    tokenUsed: number;
    costBudgetUsd?: number | null;
    costUsedUsd: number;
  };
  envelope?: {
    id: string;
    currency: string;
    budgetLow?: number | null;
    budgetHigh?: number | null;
    tokenLimit?: number | null;
    warningPercent: number;
    hardCapPercent: number;
    stageBudgets?: Record<string, { tokenLimit?: number | null; costLimitUsd?: number | null }>;
  } | null;
  rollup: {
    estimatedPlanCostHigh: number;
    ledgerTokens: number;
    ledgerCostUsd: number;
    tokenPercent?: number | null;
    costPercent?: number | null;
    actualCostUsd: number;
    actualHours: number;
    slippedRows: number;
  };
  budgetDecision: SynBudgetDecision;
  budgetEvents: Array<{ id: string; status: string; action: string; percentUsed: number; stage?: string | null; traceId?: string | null; createdAt: string }>;
  tenantEnvelope?: { id: string; tokenLimit?: number | null; costLimitUsd?: number | null; economyModelAlias?: string | null; warningPercent: number; hardCapPercent: number } | null;
  ledger: Array<{
    id: string;
    stage?: string | null;
    provider?: string | null;
    model?: string | null;
    totalTokens: number;
    estimatedCostUsd?: number | null;
    traceId?: string | null;
    createdAt: string;
  }>;
  plans: SynGenerationPlan[];
}

export interface SynTraceNode {
  id: string;
  type: string;
  label: string;
  status?: string | null;
  href?: string;
  detail?: string;
  data?: Record<string, unknown>;
}

export interface SynTraceability {
  project: { id: string; code: string; name: string; status: string };
  nodes: SynTraceNode[];
  edges: Array<{ from: string; to: string; kind: string }>;
  summary: {
    boards: number;
    concepts: number;
    rejectedOptions: number;
    claims: number;
    requirements: number;
    decisions: number;
    workItems: number;
    reconciliations: number;
    completeChains: number;
  };
}

export interface SynClaimDriftSignal {
  id: string;
  beforeMean: number;
  afterMean: number;
  delta: number;
  direction: "UP" | "DOWN" | "UNCHANGED";
  threshold: number;
  status: string;
  traceId?: string | null;
  createdAt: string;
  claim: { id: string; statement: string; status: string };
  reconciliationRun?: { id: string; status: string; workItemId: string } | null;
}

export interface SynChangeRequest {
  id: string;
  title: string;
  reason: string;
  status: "RECOMMENDED" | "OPEN" | "APPROVED" | "REJECTED" | "APPLIED";
  requestedById?: string | null;
  traceId?: string | null;
  createdAt: string;
  driftSignal?: SynClaimDriftSignal | null;
}

export interface SynProjectLearning {
  signals: SynClaimDriftSignal[];
  changeRequests: SynChangeRequest[];
  claims: Array<{ id: string; statement: string; mean: number; status: string }>;
  summary: { materialDrops: number; materialGains: number; openChangeRequests: number };
}

export interface SynPilotReadiness {
  projectId: string;
  ready: boolean;
  score: number;
  checks: Array<{ key: string; label: string; ok: boolean; fixRoute: string }>;
  metrics: {
    origin: { specGenerated: number; adHoc: number };
    verified: number;
    finalized: number;
    actualRows: number;
    specGeneratedToAdHocRatio?: number | null;
  };
  traceability: SynTraceability["summary"];
  learning: SynProjectLearning["summary"];
}

export interface SynBudgetDecision {
  effective: {
    status: "HEALTHY" | "WARNING" | "EXCEEDED" | "HARD_CAP";
    action: string;
    allowAgentTurns: boolean;
    humanActionsAllowed: boolean;
    raiseAvailable: boolean;
    recommendedModelAlias?: string | null;
  };
  project: { status: string; percentUsed: number; tokens: number; costUsd: number; tokenLimit?: number | null; costLimitUsd?: number | null };
  tenant: { status: string; percentUsed: number; tokens: number; costUsd: number; tokenLimit?: number | null; costLimitUsd?: number | null };
}
