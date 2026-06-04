import { Router } from 'express'
import { z } from 'zod'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { precheckTargetUrl, isBlockedAddress } from '../../lib/ssrf-guard'
import { BlueprintStage, BlueprintSessionStatus, BlueprintStageStatus, BlueprintSourceType, Prisma, type ConsumableStatus, type InstanceStatus } from '@prisma/client'
import { config } from '../../config'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { NotFoundError, ValidationError, ForbiddenError } from '../../lib/errors'
import { classifyFailures, type FailureClassification } from './inherited-failure-analyzer'
import { synthesizeLoopTrace } from './loop-trace-synthesizer'
import { createWorkItem } from '../work-items/work-items.service'
import { createReceipt, logEvent, publishOutbox } from '../../lib/audit'
import { contextFabricClient, ContextFabricError, type ExecuteResponse } from '../../lib/context-fabric/client'
import { fetchEvalFeedback } from '../../lib/audit-gov/client'
import {
  attemptStatusFor,
  blueprintStageStatusFor,
  classifyCodingStagePolicy,
  hasActualCodeChange,
  hasFailedVerificationReceipt,
  hasPassingVerificationReceipt,
  hasUnavailableVerificationReceipt,
  hasVerificationReceipt,
  isTerminalCodingResult,
  resumeCodingStage,
  runCodingStage,
  runCodingStageGoverned,
  stageRequiresVerification,
  type CodingRunResult,
} from '../coding-agent/orchestrator'
// M36.2 — stage prompts (architect/developer/qa task + system prompts and the
// loop-stage prompt) live in prompt-composer DB (StagePromptBinding rows).
// We resolve them at call time instead of hardcoding them in this file.
import { promptComposerClient } from '../../lib/prompt-composer/client'
import { recordWorkflowLlmUsage } from '../workflow/runtime/budget'

export const blueprintRouter: Router = Router()

const MAX_FILES = 250
const MAX_TOTAL_BYTES = 2_000_000
const MAX_EXCERPT_BYTES = 4_000
const MAX_EXCERPT_FILES = 8
const EXECUTE_MANIFEST_MAX_FILES = 120
const EXECUTE_EXCERPT_MAX_FILES = 8
const EXECUTE_EXCERPT_MAX_CHARS = 4_000
const EXECUTE_EXCERPT_BUDGET_CHARS = 8_000
const COMPOSER_ARTIFACT_CONTENT_MAX_CHARS = 8_000
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
const WORKBENCH_DEFAULT_MODEL_ALIAS = process.env.WORKBENCH_DEFAULT_MODEL_ALIAS?.trim() || undefined
// (2026-05-26) Bumped from 8 to 14 after design stage MAX_TURNS at
// turn 8 on workflowInstance 8d42bedf — Architect spent 2 turns in
// PLAN (repo_map) and 6 in EXPLORE (read_file, get_ast_slice, get_symbol,
// search_code) before exhausting budget without ever reaching
// SELF_REVIEW. The agent's last response was narrating more
// exploration intent rather than producing output. 14 covers:
//   PLAN  (2-3 turns to identify target files)
// + EXPLORE (6-8 turns of reading + analyzing)
// + SELF_REVIEW (2-3 turns to produce the design doc)
// + 1-2 turn margin for retries on validation_error.
// Developer stages keep their larger 28-turn budget — they have
// ACT + VERIFY phases on top of the read-only sequence.
const WORKBENCH_DEFAULT_MAX_STEPS = positiveIntEnv('WORKBENCH_MAX_STEPS', 14)
// Developer stage needs more steps than read-only stages because each real
// code change is the END of a sequence of: explore (4-6 steps), read target
// files (2-3 steps), make N edits (N steps), add tests (1-2 steps), run
// verification (1 step), finish (1 step). 16 was tight — Sonnet hit max_steps
// with the replace_text call already queued in step 15 (see trace from
// 2026-05-21 10:11). 28 gave ~50% headroom over the observed need.
//
// M88 (2026-05-27) — bumped 28 → 40 because the M86 per-phase budgets
// sum to PLAN(5) + EXPLORE(10) + ACT(8) + VERIFY(5) + REPAIR(8) +
// SELF_REVIEW(3) = 39, and a real repair cycle adds another ACT+VERIFY
// pass (~6 turns). Repro from develop attempt 19a55e93 (2026-05-27):
// the agent walked PLAN→EXPLORE→ACT→VERIFY→REPAIR cleanly but hit
// MAX_TURNS at exactly 28 the moment REPAIR completed, before the
// second ACT cycle could apply the fix. 40 gives one full repair
// round-trip plus a margin; per-phase budgets remain the actual stops.
const WORKBENCH_DEVELOPER_MAX_STEPS = positiveIntEnv('WORKBENCH_DEVELOPER_MAX_STEPS', 40)
// QA-review needs more steps than the read-only default because it runs
// PLAN + EXPLORE + VERIFY + SELF_REVIEW (4 phases) and the VERIFY phase
// burns 1-3 turns on long-running test commands (run_test / run_command
// at 30+ seconds each). Repro 2026-05-26 attempt bf0fc33d: 6 turns in
// PLAN (review_diff + repo_map + list_indexed_files + 3×read_file),
// 7 turns in EXPLORE (multiple tool retries on failed search_code +
// get_ast_slice + grep_lines), leaving only 1 turn for VERIFY — agent
// got the run_test back and ran out of budget before producing the
// VerificationReceipt. 22 covers the realistic worst case with margin.
// Security/DevOps reviews stay at the 14-turn default because they have
// 3 phases (PLAN/EXPLORE/SELF_REVIEW) and don't run verification tools.
const WORKBENCH_QA_MAX_STEPS = positiveIntEnv('WORKBENCH_QA_MAX_STEPS', 22)

// ── Phased Agent Reasoning Model (v4) ────────────────────────────────────
// When MCP_AGENT_PHASES_ENABLED is on at mcp-server AND we pass
// `agentReasoningMode: "phased"` here, mcp-server runs a 6-phase state
// machine (PLAN_DRAFT → EXPLORE → PLAN_CONFIRM → ACT → VERIFY → FINALIZE)
// with per-phase tool allowlists and a path-coverage gate. We default to
// `false` here — the flat ReAct loop stays the production default until the
// flag is flipped on at deployment. Override via WORKBENCH_AGENT_PHASES_ENABLED.
const WORKBENCH_AGENT_PHASES_ENABLED =
  (process.env.WORKBENCH_AGENT_PHASES_ENABLED ?? '').toLowerCase() === 'true'
// Per-phase budgets. Total = 23, with safety slack of 5 against the
// absolute max-steps cap. Operators can tune via env vars per phase.
const WORKBENCH_DEVELOPER_PHASE_BUDGETS = {
  PLAN_DRAFT:   positiveIntEnv('WORKBENCH_DEVELOPER_BUDGET_PLAN_DRAFT', 2),
  EXPLORE:      positiveIntEnv('WORKBENCH_DEVELOPER_BUDGET_EXPLORE', 6),
  PLAN_CONFIRM: positiveIntEnv('WORKBENCH_DEVELOPER_BUDGET_PLAN_CONFIRM', 2),
  ACT:          positiveIntEnv('WORKBENCH_DEVELOPER_BUDGET_ACT', 10),
  VERIFY:       positiveIntEnv('WORKBENCH_DEVELOPER_BUDGET_VERIFY', 2),
  FINALIZE:     positiveIntEnv('WORKBENCH_DEVELOPER_BUDGET_FINALIZE', 1),
}
const GOVERNANCE_MODES = ['fail_open', 'fail_closed', 'degraded', 'human_approval_required'] as const
type GovernanceMode = typeof GOVERNANCE_MODES[number]
const DEFAULT_WORKBENCH_EXECUTION_CONFIG = {
  snapshotMode: 'relevant_excerpts' as const,
  excerptBudgetChars: EXECUTE_EXCERPT_BUDGET_CHARS,
  reuseUnchangedAttempt: true,
  // 24K input budget: a single read_file of a 9K Java source ≈ 2.5K tokens,
  // and we want 4–6 such reads + tool descriptors + system prompt to survive
  // without forcing the sliding-window to compress useful history into
  // breadcrumbs. At 8K, file reads triggered compression after step 2–3 and
  // the agent forgot earlier successful list_directory results.
  maxContextTokens: 24_000,
  // 6000 output tokens: write_file content args for new JUnit/JavaScript test
  // files commonly need 2000-4000 output tokens. At 800 the model truncated
  // mid-write, leaving content="" in the tool_call, which created empty
  // files the agent then retried in a loop → agent_loop_repetition.
  maxOutputTokens: 6_000,
  maxPromptChars: 12_000,
  maxLayerChars: 1_000,
}

const DEFAULT_EXCLUDES = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.turbo', '.cache',
  'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv',
])

const optionalUuid = z.preprocess(
  value => value === '' || value === null ? undefined : value,
  z.string().uuid().optional(),
)

const stageModelAliasesSchema = z.preprocess(value => {
  if (value === null || value === undefined) return undefined
  if (!isRecord(value)) return value
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (key.trim() && trimmed) out[key.trim()] = trimmed
  }
  return out
}, z.record(z.string().trim().min(1).max(80)).optional())

// M100 — canonical governed phases. Mirrors the Phase enum in
// context-fabric (governed/phase_state.py) and the prompt-composer client
// union. Per-phase model overrides are whitelisted to these keys so a
// typo'd phase can't silently persist.
const GOVERNED_PHASES = ['PLAN', 'EXPLORE', 'ACT', 'VERIFY', 'REPAIR', 'SELF_REVIEW', 'FINALIZE'] as const

// M100 — per-stage, per-phase model alias overrides:
//   { [stageKeyOrLabel]: { [PHASE]: modelAlias } }
// Mirrors stageModelAliasesSchema's trim/drop-empty behavior, but nested
// and with the inner key whitelisted to GOVERNED_PHASES (upper-cased).
// Unknown phases and blank aliases are dropped; empty inner maps are pruned.
const stagePhaseModelAliasesSchema = z.preprocess(value => {
  if (value === null || value === undefined) return undefined
  if (!isRecord(value)) return value
  const out: Record<string, Record<string, string>> = {}
  for (const [stageKey, phaseMap] of Object.entries(value)) {
    if (!stageKey.trim() || !isRecord(phaseMap)) continue
    const inner: Record<string, string> = {}
    for (const [phase, raw] of Object.entries(phaseMap)) {
      if (typeof raw !== 'string') continue
      const trimmed = raw.trim()
      const phaseKey = phase.trim().toUpperCase()
      if (trimmed && (GOVERNED_PHASES as readonly string[]).includes(phaseKey)) inner[phaseKey] = trimmed
    }
    if (Object.keys(inner).length > 0) out[stageKey.trim()] = inner
  }
  return out
}, z.record(z.record(z.string().trim().min(1).max(80))).optional())

const executionSettingsSchema = z.object({
  maxLoopsPerStage: z.number().int().min(1).max(50).optional(),
  maxTotalSendBacks: z.number().int().min(0).max(200).optional(),
  snapshotMode: z.enum(['summary', 'relevant_excerpts', 'full_debug']).optional(),
  excerptBudgetChars: z.number().int().min(2_000).max(120_000).optional(),
  reuseUnchangedAttempt: z.boolean().optional(),
  governanceMode: z.enum(GOVERNANCE_MODES).optional(),
  modelAlias: z.preprocess(
    value => value === '' || value === null ? null : value,
    z.string().trim().min(1).max(80).nullable().optional(),
  ),
  stageModelAliases: stageModelAliasesSchema,
  stagePhaseModelAliases: stagePhaseModelAliasesSchema,
  maxContextTokens: z.number().int().min(1_000).max(200_000).optional(),
  maxOutputTokens: z.number().int().min(128).max(32_000).optional(),
  maxPromptChars: z.number().int().min(2_000).max(500_000).optional(),
  maxLayerChars: z.number().int().min(500).max(100_000).optional(),
})

const intakeDefaultsSchema = z.object({
  goal: z.string().optional(),
  sourceType: z.enum(['github', 'localdir']).optional(),
  sourceUri: z.string().optional(),
  sourceRef: z.string().optional(),
  sourceProvenance: z.string().optional(),
}).optional()

const intakeOverridesSchema = z.object({
  goalEdited: z.boolean().optional(),
  sourceEdited: z.boolean().optional(),
  originalGoal: z.string().optional(),
  editedGoal: z.string().optional(),
  originalSourceType: z.enum(['github', 'localdir']).optional(),
  editedSourceType: z.enum(['github', 'localdir']).optional(),
  originalSourceUri: z.string().optional(),
  editedSourceUri: z.string().optional(),
  originalSourceRef: z.string().optional(),
  editedSourceRef: z.string().optional(),
  sourceProvenance: z.string().optional(),
}).optional()

const createSessionSchema = z.object({
  goal: z.string().min(8),
  sourceType: z.enum(['github', 'localdir']),
  sourceUri: z.string().min(1),
  sourceRef: z.string().optional(),
  includeGlobs: z.array(z.string()).default([]),
  excludeGlobs: z.array(z.string()).default([]),
  capabilityId: z.string().min(1),
  architectAgentTemplateId: optionalUuid,
  developerAgentTemplateId: optionalUuid,
  qaAgentTemplateId: optionalUuid,
  workflowInstanceId: z.string().optional(),
  browserRunId: z.string().optional(),
  workflowNodeId: z.string().optional(),
  phaseId: z.string().optional(),
  loopDefinition: z.unknown().optional(),
  gateMode: z.enum(['manual', 'auto']).default('manual'),
  // Milestones (big-change mode): decompose the goal into an ordered milestone
  // series and run each as a chained sub-loop on the same branch.
  milestonesMode: z.boolean().optional(),
  intakeDefaults: intakeDefaultsSchema,
  intakeOverrides: intakeOverridesSchema,
}).merge(executionSettingsSchema).transform(input => ({
  ...input,
  snapshotMode: input.snapshotMode ?? DEFAULT_WORKBENCH_EXECUTION_CONFIG.snapshotMode,
  reuseUnchangedAttempt: input.reuseUnchangedAttempt ?? DEFAULT_WORKBENCH_EXECUTION_CONFIG.reuseUnchangedAttempt,
}))

const updateSessionSettingsSchema = executionSettingsSchema.refine(input => Object.keys(input).length > 0, {
  message: 'At least one setting is required',
})

const decisionAnswerSchema = z.object({
  questionId: z.string().min(1),
  questionText: z.string().optional(),
  normalizedQuestion: z.string().optional(),
  answerType: z.enum(['option', 'multi_option', 'freeform']),
  selectedOptionLabel: z.string().optional(),
  selectedOptionLabels: z.array(z.string()).max(20).optional(),
  customAnswer: z.string().optional(),
  notes: z.string().optional(),
}).refine(answer => {
  if (answer.answerType === 'option') return Boolean(answer.selectedOptionLabel?.trim())
  if (answer.answerType === 'multi_option') return Boolean(answer.selectedOptionLabels?.some(label => label.trim()))
  return Boolean(answer.customAnswer?.trim() || answer.notes?.trim())
}, { message: 'Decision answers need either an option or free-form text' })

const saveDecisionAnswersSchema = z.object({
  answers: z.array(decisionAnswerSchema).max(100),
})

// M41.2 — Stage Chat. Operator-to-agent messages threaded by stageKey.
// Lives in session.metadata.stageChats[stageKey][]. The next stage attempt
// reads the thread and surfaces it to the agent via the {{operatorChat}}
// Mustache var (rendered by prompt-composer's loopDefaultTask template).
const stageChatMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  role: z.enum(['operator', 'system']).optional(),
})

type StageChatMessage = {
  id: string
  role: 'operator' | 'system' | 'agent'
  content: string
  createdAt: string
  authorId?: string
}

function isStageChatMessage(value: unknown): value is StageChatMessage {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || typeof value.content !== 'string' || typeof value.createdAt !== 'string') return false
  return value.role === 'operator' || value.role === 'system' || value.role === 'agent'
}

function readStageChats(metadata: unknown): Record<string, StageChatMessage[]> {
  if (!isRecord(metadata) || !isRecord(metadata.stageChats)) return {}
  const out: Record<string, StageChatMessage[]> = {}
  for (const [k, v] of Object.entries(metadata.stageChats)) {
    if (Array.isArray(v)) out[k] = v.filter(isStageChatMessage)
  }
  return out
}

function readStageChatThread(metadata: unknown, stageKey: string): StageChatMessage[] {
  return readStageChats(metadata)[stageKey] ?? []
}

// M75 Slice 4 — read the operator-set laptop preference off the session.
// Returns `{}` when the flag isn't set so the caller can `...spread` it
// into runContext without polluting the object with `prefer_laptop:
// undefined` (which serialises differently across JSON libs and could
// trip the Python `is True` check on the other side).
//
// Only honors `true` or `false` — anything else (string "true", number 1,
// missing) is treated as unset. Strict typing is the right call here:
// dispatch.py reads this with `prefer_laptop is True`, so we don't want
// truthy-but-not-boolean values to silently flip routing.
function readPreferLaptopFlag(metadata: unknown): { prefer_laptop?: boolean } {
  if (!isRecord(metadata)) return {}
  const raw = metadata.preferLaptop
  if (raw === true || raw === false) return { prefer_laptop: raw }
  return {}
}

const stageActionParamsSchema = z.object({
  id: z.string().min(1),
  stageKey: z.string().min(1).max(80),
})

const verdictSchema = z.object({
  // M82 S2 (2026-05-26) — MARK_DONE is a verdict variant the workbench
  // sends from the streamlined "Mark done & advance" button. It's
  // treated as PASS by all downstream consumers (LoopVerdict union
  // stays PASS/NEEDS_REWORK/BLOCKED/ACCEPTED_WITH_RISK), but
  // saveStageVerdict skips the missingRequiredQuestions check when the
  // stage opts into allowMarkDone. Structural gates (accumulated code
  // change, verification receipts) still fire.
  verdict: z.enum(['PASS', 'NEEDS_REWORK', 'BLOCKED', 'ACCEPTED_WITH_RISK', 'MARK_DONE']),
  feedback: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  acceptRisk: z.boolean().optional(),
  answers: z.array(decisionAnswerSchema).max(100).optional(),
})

// M82 S1 (2026-05-26) — operator-edited artifact body. Refused unless
// the stage's loopDefinition lists this artifact kind with
// editable=true. See PATCH /sessions/:id/artifacts/:artifactId.
const editArtifactSchema = z.object({
  content: z.string().min(1).max(2_000_000),
  reason: z.string().max(500).optional(),
})

// M82 S1 — URL params for PATCH artifact.
const artifactActionParamsSchema = z.object({
  id: z.string().min(1),
  artifactId: z.string().min(1),
})

// M60 Slice 2 — line-anchored operator annotations on send-back.
// Optional sibling to `requiredChanges` (free text). When present, each
// entry pins reviewer feedback to a specific file + line span on the
// captured diff. They are persisted on the send-back review event and
// fed back into the next attempt's task via the
// `priorAttemptAnnotations` template var (see buildLoopStageVars).
//
// Exported for tests in apps/api/test/send-back-annotations.test.ts.
export const sendBackAnnotationSchema = z.object({
  file: z.string().min(1).max(500),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  comment: z.string().min(1).max(800),
  severity: z.enum(['must-fix', 'suggestion', 'question']).optional(),
})

const sendBackSchema = z.object({
  targetStageKey: z.string().min(1).max(80),
  reason: z.string().min(3),
  requiredChanges: z.string().optional(),
  blockingQuestions: z.array(z.string()).max(20).optional(),
  annotations: z.array(sendBackAnnotationSchema).max(50).optional(),
})

type SendBackAnnotation = z.infer<typeof sendBackAnnotationSchema>

const stageApprovalSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().max(1000).optional(),
  argsOverride: z.record(z.unknown()).optional(),
  args_override: z.record(z.unknown()).optional(),
})

type CreateSessionInput = z.infer<typeof createSessionSchema>
type UpdateSessionSettingsInput = z.infer<typeof updateSessionSettingsSchema>
type StageApprovalInput = z.infer<typeof stageApprovalSchema>
type DecisionAnswer = z.infer<typeof decisionAnswerSchema> & { updatedAt?: string; updatedById?: string }
type LoopAgentRole = string
type LoopVerdict = 'PASS' | 'NEEDS_REWORK' | 'BLOCKED' | 'ACCEPTED_WITH_RISK'
type LoopAttemptStatus = 'PENDING' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'PASSED' | 'NEEDS_REWORK' | 'BLOCKED' | 'ACCEPTED_WITH_RISK'
type StageContextPolicy = 'STORY_ONLY' | 'REPO_READ_ONLY' | 'CODE_EDIT' | 'VERIFY_ONLY' | 'EVIDENCE_REVIEW'
type StageToolPolicy = 'NONE' | 'READ_ONLY' | 'MUTATION' | 'VERIFICATION'

type LoopExpectedArtifact = {
  kind: string
  title: string
  description?: string
  required?: boolean
  format?: 'MARKDOWN' | 'TEXT' | 'JSON' | 'CODE'
  // M102 — optional link to a catalog ArtifactTemplate (id). When set, the
  // template's section skeleton is injected into the stage prompt so the
  // agent fills the catalog's structure (e.g. a Design Document's
  // Context/Architecture/Trade-offs), not just free-form text of the right kind.
  templateId?: string
  // M82 S1 (2026-05-26) — when true, the operator may overwrite the
  // artifact body from the workbench before approval. The PATCH
  // endpoint (/sessions/:id/artifacts/:id) refuses if no stage in the
  // loopDefinition lists this artifact kind with editable=true.
  // Defaults to false so existing artifact kinds stay read-only.
  editable?: boolean
}

type LoopQuestion = {
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

type LoopStageDefinition = {
  key: string
  label: string
  agentRole: LoopAgentRole
  agentTemplateId?: string
  description?: string
  next?: string | null
  terminal?: boolean
  required?: boolean
  approvalRequired?: boolean
  expectedArtifacts?: LoopExpectedArtifact[]
  allowedSendBackTo?: string[]
  questions?: LoopQuestion[]
  contextPolicy: StageContextPolicy
  repoAccess: boolean
  toolPolicy: StageToolPolicy
  promptProfileKey?: string
  // Per-stage execution budget. When the workflow's WORKBENCH_TASK node
  // declares `loopDefinition.stages[*].limits`, those values override the
  // env-based WORKBENCH_*_MAX_STEPS defaults. Lets the workflow author
  // tune budgets per stage (e.g. QA-review at 22, release-readiness at
  // 18) without code changes or env vars. The runtime defaults (28 for
  // mutating dev, 22 for verification, 14 read-only) remain the safety
  // net when no per-stage limit is declared.
  limits?: { maxSteps?: number; timeoutSec?: number }
  // M82 S2 (2026-05-26) — opt-in shortcut. When true, the workbench
  // shows a "Mark done & advance" affordance that POSTs verdict=
  // MARK_DONE. saveStageVerdict treats it as PASS but bypasses the
  // missingRequiredQuestions check. Structural gates (accumulated
  // code change for dev, verification receipts, etc.) stay in place.
  // Use for stages where the operator's eyes-on review IS the
  // approval contract — e.g. story intake, design — and the
  // questions are documentation rather than gates.
  allowMarkDone?: boolean
  // M99 — Phase 0 automation flags. Declarative opt-in to the platform-
  // controlled pre-edit guards. Optional; when a workflow's WORKBENCH_TASK
  // node sets them they ship in the StageExecutionPolicy to CF, which gates
  // each automation on BOTH its env flag AND the matching policy flag (see
  // context-fabric governed_automation.py). Undefined → CF's env-flag default.
  autoLocalize?: boolean
  autoBaseline?: boolean
  autoVerify?: boolean
  gitPreflightRequired?: boolean
}

type LoopDefinition = {
  version: number
  name: string
  stages: LoopStageDefinition[]
  maxLoopsPerStage: number
  maxTotalSendBacks: number
}

type GateRecommendation = {
  verdict: LoopVerdict
  confidence: number
  reason: string
  targetStageKey?: string
}

type StageAttempt = {
  id: string
  stageKey: string
  // Milestones (big-change mode): the milestone this attempt belongs to.
  // undefined for non-milestone sessions and for session-level stages
  // (intake/plan/aggregation). Drives milestone-scoped latestStageAttempt.
  milestoneId?: string
  stageLabel: string
  agentRole: LoopAgentRole
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
  inputSignature?: string
  gateRecommendation?: GateRecommendation
  correlation?: Record<string, unknown>
  tokensUsed?: Record<string, unknown>
  metrics?: Record<string, unknown>
  pendingApproval?: Record<string, unknown> | null
  verificationReceipts?: Array<Record<string, unknown>>
}

type WorkbenchConsumableRef = {
  artifactId: string
  artifactKind: string
  title: string
  consumableId: string
  consumableVersion: number
  status: string
  stageKey?: string
  stageLabel?: string
  attemptId?: string
  artifactRequired?: boolean
}

type WorkflowLinkWarning = {
  reason: 'workflow_instance_not_found' | 'workflow_node_not_found' | 'workflow_link_repaired' | 'browser_run_snapshot'
  message: string
  workflowInstanceId?: string
  workflowNodeId?: string
  browserRunId?: string
  originalWorkflowInstanceId?: string
  suggestedFix: string
}

type WorkflowLinkResolution = {
  workflowInstanceId?: string
  workflowNodeId?: string
  browserRunId?: string
  warning?: WorkflowLinkWarning
}

type ReviewEvent = {
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

type FinalPack = {
  id: string
  status: string
  generatedAt: string
  generatedById?: string
  summary: string
  stages: Array<{ stageKey: string; label: string; verdict: LoopVerdict; attemptNumber: number; artifactIds: string[] }>
  artifactKinds: string[]
  stageConsumables?: WorkbenchConsumableRef[]
  consumableIds?: string[]
  finalPackArtifactId?: string
  finalPackConsumableId?: string
  finalPackConsumableVersion?: number
}

type WorkbenchDocumentRef = {
  id: string
  artifactId: string
  kind: string
  title: string
  stage?: string
  stageKey?: string
  attemptId?: string
  version?: number
  content: string
  createdAt?: string
  consumableId?: string
  consumableVersion?: number
  consumableStatus?: string
  source: 'blueprint-workbench'
}

// Milestones (big-change mode) — a single Workbench session decomposes one big
// goal into an ordered series of milestones, each implemented by re-running the
// per-milestone stages (develop→security→qa) on the SAME branch. State lives in
// LoopState (session.metadata); legacy/non-milestone sessions have milestone
// undefined or { enabled:false } and behave exactly as before.
type Milestone = {
  id: string                 // 'M1','M2',… — also the StageAttempt.milestoneId tag
  title: string
  subGoal: string            // becomes the per-milestone "goal" fed to the stages
  acceptanceCriteria: string[]
  dependsOn: string[]        // milestone ids that must complete first (topo order)
  status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'SKIPPED'
  estimate?: string
}

type MilestoneHistoryEntry = {
  milestoneId: string
  status: 'COMPLETED' | 'SKIPPED'
  completedAt: string
  finalAttemptIdsByStage: Record<string, string>  // accepted attempt per stage
  commitShas: string[]                             // commits this milestone landed
}

type MilestoneState = {
  enabled: boolean
  plan: Milestone[]                  // ordered, post-topo-sort
  currentMilestoneId: string | null  // the active milestone (null before/after)
  history: MilestoneHistoryEntry[]
  planArtifactId?: string            // the milestone_plan artifact id
}

type LoopState = {
  workflowNodeId?: string
  browserRunId?: string
  gateMode: 'manual' | 'auto'
  loopDefinition: LoopDefinition
  currentStageKey: string | null
  stageAttempts: StageAttempt[]
  reviewEvents: ReviewEvent[]
  decisionAnswers: DecisionAnswer[]
  finalPack?: FinalPack
  // M66 — Receipts (test runs, lint runs, formal verifier results)
  // accumulated across stages in this session. Each stage's /mcp/invoke
  // runs in its own state.verificationReceipts array, so without this
  // session-level accumulator the developer stage's auto-finish would see
  // an empty receipt list even though an earlier QA stage ran tests. Bumped
  // by appendVerificationReceipts() after every runCodingStage call; read
  // by runLoopStageExecute and passed to context-fabric as
  // prior_verification_receipts.
  verificationReceiptHistory?: Array<Record<string, unknown>>
  // Milestones (big-change mode). Undefined / { enabled:false } => legacy
  // single-goal loop (unchanged behavior).
  milestone?: MilestoneState
  intakeDefaults?: z.infer<typeof intakeDefaultsSchema>
  intakeOverrides?: z.infer<typeof intakeOverridesSchema>
  executionConfig?: {
    snapshotMode?: 'summary' | 'relevant_excerpts' | 'full_debug'
    excerptBudgetChars?: number
    reuseUnchangedAttempt?: boolean
    modelAlias?: string
    stageModelAliases?: Record<string, string>
    // M100 — per-stage, per-phase model alias overrides:
    //   { [stageKeyOrLabel]: { [PHASE]: modelAlias } }
    stagePhaseModelAliases?: Record<string, Record<string, string>>
    governanceMode?: 'fail_open' | 'fail_closed' | 'degraded' | 'human_approval_required'
    maxContextTokens?: number
    maxOutputTokens?: number
    maxPromptChars?: number
    maxLayerChars?: number
  }
}

type ManifestEntry = {
  path: string
  size: number
  language?: string
  sha?: string
  excerpt?: string
}

type SnapshotResult = {
  manifest: ManifestEntry[]
  summary: Record<string, unknown>
  fileCount: number
  totalBytes: number
  rootHash: string
}

blueprintRouter.get('/sessions', async (req, res, next) => {
  try {
    const createdById = req.user!.userId
    const sessions = await prisma.blueprintSession.findMany({
      // Task #81 — exclude ABANDONED sessions from the discovery query.
      // When a WorkItem is detached from its source workflow, the matching
      // session is marked ABANDONED (see detachWorkItemFromWorkflow). Without
      // this filter, re-attaching the WorkItem and starting a new run would
      // resume the stale session (workbench frontend picks the latest match
      // by updatedAt). The session row is preserved for audit; we just want
      // it out of the "pick up where you left off" candidate pool.
      where: {
        createdById,
        status: {
          in: [
            BlueprintSessionStatus.DRAFT,
            BlueprintSessionStatus.SNAPSHOTTED,
            BlueprintSessionStatus.RUNNING,
            BlueprintSessionStatus.COMPLETED,
            BlueprintSessionStatus.APPROVED,
            BlueprintSessionStatus.FAILED,
          ],
        },
      },
      include: {
        snapshots: { orderBy: { createdAt: 'desc' }, take: 1 },
        stageRuns: { orderBy: { createdAt: 'desc' } },
        artifacts: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    })
    res.json({ items: sessions.map(shapeSession) })
  } catch (err) { next(err) }
})

// Global artifacts browser — every artifact across the caller's runs, newest
// first, for the top-level "Artifacts" nav. Scoped to createdById (ownership);
// optional ?kind / ?limit filters. Each item carries its session + run linkage
// so the UI can deep-link back to the owning run.
blueprintRouter.get('/artifacts', async (req, res, next) => {
  try {
    const createdById = req.user!.userId
    const q = req.query as Record<string, string | undefined>
    const kind = q.kind?.trim() || undefined
    const workflowInstanceId = q.workflowInstanceId?.trim() || undefined
    const workItem = (q.workItemId ?? q.workCode)?.trim() || undefined
    const workflowStatus = q.workflowStatus?.trim().toUpperCase() || undefined
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500)

    // Build the set of workflowInstanceIds to restrict to, from the work-item
    // and/or workflow-status filters. Each is resolved separately (the
    // session→instance link is a plain column, not a Prisma relation) and the
    // results are INTERSECTED. instanceFilter === null means "no instance-
    // based filter active"; an empty array means "filter active but matched
    // nothing" → return zero results (don't silently widen).
    let instanceFilter: Set<string> | null = workflowInstanceId ? new Set([workflowInstanceId]) : null
    const intersect = (next: string[]) => {
      const ns = new Set(next)
      instanceFilter = instanceFilter === null ? ns : new Set([...instanceFilter].filter(x => ns.has(x)))
    }

    if (workItem) {
      // Accept either a work-item UUID or a workCode (e.g. WRK-513D4).
      const wi = await prisma.workItem.findFirst({
        where: { OR: [{ id: workItem }, { workCode: workItem }] },
        select: { sourceWorkflowInstanceId: true, targets: { select: { childWorkflowInstanceId: true } } },
      })
      intersect(uniqueStrings([
        wi?.sourceWorkflowInstanceId,
        ...(wi?.targets.map(t => t.childWorkflowInstanceId) ?? []),
      ]))
    }

    if (workflowStatus) {
      // Guard the enum so an unknown status returns empty instead of a Prisma
      // 500 on an invalid enum value.
      const VALID = ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED']
      if (!VALID.includes(workflowStatus)) {
        res.json({ count: 0, items: [] })
        return
      }
      const instances = await prisma.workflowInstance.findMany({
        where: { status: workflowStatus as InstanceStatus },
        select: { id: true },
        take: 2000,
      })
      intersect(instances.map(i => i.id))
    }

    // instanceFilter active but empty → nothing matches.
    if (instanceFilter !== null && instanceFilter.size === 0) {
      res.json({ count: 0, items: [] })
      return
    }

    const rows = await prisma.blueprintArtifact.findMany({
      where: {
        ...(kind ? { kind } : {}),
        session: {
          createdById,
          ...(instanceFilter ? { workflowInstanceId: { in: [...instanceFilter] } } : {}),
        },
      },
      include: { session: { select: { id: true, goal: true, workflowInstanceId: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    // Enrich with the owning workflow instance's status/name (separate lookup
    // since there's no Prisma relation on the session column).
    const instanceIds = uniqueStrings(rows.map(r => r.session?.workflowInstanceId))
    const instanceById = new Map<string, { status: string; name: string }>()
    if (instanceIds.length > 0) {
      const instances = await prisma.workflowInstance.findMany({
        where: { id: { in: instanceIds } },
        select: { id: true, status: true, name: true },
      })
      for (const i of instances) instanceById.set(i.id, { status: i.status, name: i.name })
    }

    const items = rows.map(row => {
      const iid = row.session?.workflowInstanceId ?? null
      const inst = iid ? instanceById.get(iid) : undefined
      return {
        ...shapeArtifact(row),
        sessionGoal: row.session?.goal ?? null,
        workflowInstanceId: iid,
        workflowName: inst?.name ?? null,
        workflowStatus: inst?.status ?? null,
      }
    })
    res.json({ count: items.length, items })
  } catch (err) { next(err) }
})

// Filter options for the Artifacts explorer — the distinct work items and
// workflow instances that ACTUALLY have artifacts for this caller, so the UI
// can auto-populate its filter dropdowns instead of free-text. Scoped to
// createdById to match /artifacts.
blueprintRouter.get('/artifacts/facets', async (req, res, next) => {
  try {
    const createdById = req.user!.userId
    // Distinct instance ids across the caller's artifact-bearing sessions.
    const sessions = await prisma.blueprintSession.findMany({
      where: { createdById, artifacts: { some: {} }, workflowInstanceId: { not: null } },
      select: { workflowInstanceId: true },
      take: 2000,
    })
    const instanceIds = uniqueStrings(sessions.map(s => s.workflowInstanceId))

    const instances = instanceIds.length
      ? await prisma.workflowInstance.findMany({
          where: { id: { in: instanceIds } },
          select: { id: true, name: true, status: true },
          orderBy: { startedAt: 'desc' },
        })
      : []

    // Work items linked to those instances, via the source instance OR a
    // target's child instance. De-duplicated by id.
    const workItems = instanceIds.length
      ? await prisma.workItem.findMany({
          where: {
            OR: [
              { sourceWorkflowInstanceId: { in: instanceIds } },
              { targets: { some: { childWorkflowInstanceId: { in: instanceIds } } } },
            ],
          },
          select: { id: true, workCode: true, title: true, status: true },
          orderBy: { createdAt: 'desc' },
          take: 500,
        })
      : []

    res.json({
      workItems: workItems.map(w => ({ id: w.id, workCode: w.workCode, title: w.title, status: w.status })),
      instances: instances.map(i => ({ id: i.id, name: i.name, status: i.status })),
      statuses: ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED'],
    })
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions', validate(createSessionSchema), async (req, res, next) => {
  try {
    const body = req.body as CreateSessionInput
    const workflowLink = await resolveWorkflowLink(body.workflowInstanceId, body.workflowNodeId)
    if (body.workflowInstanceId?.trim() && !workflowLink.workflowInstanceId && !workflowLink.browserRunId) {
      throw new ValidationError(
        workflowLink.warning?.message
          ?? `Workflow run ${body.workflowInstanceId.trim()} was not found. Open the Workbench from an active workflow run/task so consumables can be published.`,
      )
    }

    // M85.s5 — blueprint-workbench only renders 'workbench'-profile
    // instances. When the caller is attaching this session to a real
    // workflow run, verify the run's profile. 'main' profile instances
    // are meant for the standard workflow viewer, not the workbench.
    //
    // Two opt-outs:
    //   • Sessions WITHOUT a workflowInstanceId (standalone / preview
    //     blueprints) — allowed, since they have no parent run to check
    //     against. blueprint-workbench will refuse the file-browser /
    //     test-runner panels for these via the existing bind-workitem
    //     path (M83.z2).
    //   • If the env flag WORKBENCH_ALLOW_MAIN_PROFILE=true is set —
    //     escape hatch for migration / debugging.
    if (workflowLink.workflowInstanceId) {
      const linkedInstance = await prisma.workflowInstance.findUnique({
        where: { id: workflowLink.workflowInstanceId },
        select: { profile: true, name: true },
      })
      const allowMain = (process.env.WORKBENCH_ALLOW_MAIN_PROFILE ?? '').toLowerCase() === 'true'
      if (linkedInstance && linkedInstance.profile !== 'workbench' && !allowMain) {
        throw new ValidationError(
          `Workflow run "${linkedInstance.name}" has profile='${linkedInstance.profile}'. ` +
          `The workbench only opens workflows with profile='workbench'. ` +
          `Either: (a) point the parent workflow's CALL_WORKFLOW node at a workbench-profile template ` +
          `so its child run inherits the right profile, or (b) open this run in the standard workflow viewer instead.`,
        )
      }
    }

    const initialLoopDefinition = applyLoopLimitSettings(normalizeLoopDefinition(body.loopDefinition, body), body)
    const resolvedWorkflowInstanceId = workflowLink.workflowInstanceId ?? null
    const resolvedBrowserRunId = body.browserRunId?.trim() || workflowLink.browserRunId
    const resolvedWorkflowNodeId = resolvedWorkflowInstanceId || resolvedBrowserRunId ? workflowLink.workflowNodeId : undefined

    // M94.1 (2026-05-28) — Shared-session resolution for the multinode
    // workbench model. In the literal "4 independent stage-nodes" design
    // (Option A), each of the child workbench-profile workflow's
    // WORKBENCH_TASK nodes (Story Intake / Design / Develop / QA) hits
    // this endpoint as it activates. We MUST NOT mint a fresh session per
    // node — that would fork the loop state, artifacts, receipts, and the
    // shared wi/<code> branch into four disjoint sessions. Instead, the
    // FIRST node to activate creates the session; every subsequent node
    // for the SAME workflow instance resumes it. Keying by
    // workflowInstanceId (the child instance) is what makes one session
    // thread across all four nodes — artifact + receipt continuity then
    // comes for free from the existing per-session metadata.
    //
    // Gated behind WORKBENCH_MULTINODE so single-node behavior (one node =
    // one full-loop session) is byte-for-byte unchanged when off. We only
    // reuse a session that's still live (not COMPLETED/ABANDONED) so a
    // re-run after completion starts clean.
    const multinodeEnabled = (process.env.WORKBENCH_MULTINODE ?? '').toLowerCase() === 'true'
    if (multinodeEnabled && resolvedWorkflowInstanceId) {
      const existing = await prisma.blueprintSession.findFirst({
        where: {
          workflowInstanceId: resolvedWorkflowInstanceId,
          status: { notIn: [BlueprintSessionStatus.COMPLETED, BlueprintSessionStatus.ABANDONED] },
        },
        orderBy: { createdAt: 'asc' },
        include: {
          snapshots: { orderBy: { createdAt: 'desc' }, take: 1 },
          stageRuns: { orderBy: { createdAt: 'desc' } },
          artifacts: { orderBy: { createdAt: 'desc' } },
        },
      })
      if (existing) {
        // Resume the instance-shared session. Record which node triggered
        // the resume so the audit trail shows the cross-node hops.
        await recordBlueprintAudit(existing.id, 'BlueprintSessionResumedForNode', req.user!.userId, {
          workflowInstanceId: resolvedWorkflowInstanceId,
          workflowNodeId: resolvedWorkflowNodeId,
          reason: 'multinode-shared-session',
        })
        res.json(shapeSession(existing))
        return
      }
    }
    const governanceMode = body.governanceMode
      ?? await resolveWorkbenchGovernanceMode(resolvedWorkflowInstanceId)
    const agentTemplateIds = resolveSessionAgentTemplateIds(body, initialLoopDefinition)
    const hydratedLoopDefinition = hydrateLoopAgentTemplates(initialLoopDefinition, agentTemplateIds)
    // Milestones — add the milestone_plan expected artifact to the design stage
    // so the architect decomposes the goal before the per-milestone stages run.
    const loopDefinition = body.milestonesMode
      ? withMilestonePlanArtifact(hydratedLoopDefinition)
      : hydratedLoopDefinition
    const now = new Date().toISOString()
    const reviewEvents: ReviewEvent[] = [{
      id: crypto.randomUUID(),
      type: 'SESSION_CREATED',
      stageKey: loopDefinition.stages[0]?.key,
      message: `Workbench session created with ${loopDefinition.stages.length} loop stages.`,
      actorId: req.user!.userId,
      createdAt: now,
      payload: { gateMode: body.gateMode, workflowNodeId: resolvedWorkflowNodeId, browserRunId: resolvedBrowserRunId },
    }]
    if (workflowLink.warning) {
      reviewEvents.push({
        id: crypto.randomUUID(),
        type: 'WORKFLOW_LINK_WARNING',
        stageKey: loopDefinition.stages[0]?.key,
        message: workflowLink.warning.message,
        actorId: req.user!.userId,
        createdAt: now,
        payload: workflowLink.warning as unknown as Record<string, unknown>,
      })
    }
    if (body.intakeOverrides?.goalEdited || body.intakeOverrides?.sourceEdited) {
      reviewEvents.push({
        id: crypto.randomUUID(),
        type: 'INTAKE_OVERRIDE_RECORDED',
        stageKey: loopDefinition.stages[0]?.key,
        message: 'Workbench intake goal/source was edited from the resolved workflow defaults before session creation.',
        actorId: req.user!.userId,
        createdAt: now,
        payload: {
          intakeDefaults: body.intakeDefaults,
          intakeOverrides: body.intakeOverrides,
        } as Record<string, unknown>,
      })
    }
    const initialLoopState: LoopState = {
      workflowNodeId: resolvedWorkflowNodeId,
      browserRunId: resolvedBrowserRunId,
      gateMode: body.gateMode,
      loopDefinition,
      currentStageKey: loopDefinition.stages[0]?.key ?? null,
      stageAttempts: [],
      decisionAnswers: [],
      reviewEvents,
      intakeDefaults: body.intakeDefaults,
      intakeOverrides: body.intakeOverrides,
      executionConfig: {
        snapshotMode: body.snapshotMode,
        excerptBudgetChars: body.excerptBudgetChars ?? DEFAULT_WORKBENCH_EXECUTION_CONFIG.excerptBudgetChars,
        reuseUnchangedAttempt: body.reuseUnchangedAttempt,
        governanceMode,
        modelAlias: body.modelAlias ?? WORKBENCH_DEFAULT_MODEL_ALIAS,
        stageModelAliases: sanitizeStageModelAliases(body.stageModelAliases),
        stagePhaseModelAliases: sanitizeStagePhaseModelAliases(body.stagePhaseModelAliases),
        maxContextTokens: body.maxContextTokens ?? DEFAULT_WORKBENCH_EXECUTION_CONFIG.maxContextTokens,
        maxOutputTokens: body.maxOutputTokens ?? DEFAULT_WORKBENCH_EXECUTION_CONFIG.maxOutputTokens,
        maxPromptChars: body.maxPromptChars ?? DEFAULT_WORKBENCH_EXECUTION_CONFIG.maxPromptChars,
        maxLayerChars: body.maxLayerChars ?? DEFAULT_WORKBENCH_EXECUTION_CONFIG.maxLayerChars,
      },
      // Milestones — seed the cursor when launched in milestones mode. The plan
      // is populated once the Architect emits the milestone_plan artifact.
      milestone: body.milestonesMode
        ? { enabled: true, plan: [], currentMilestoneId: null, history: [] }
        : undefined,
    }
    const session = await prisma.blueprintSession.create({
      data: {
        goal: body.goal,
        sourceType: body.sourceType === 'github' ? BlueprintSourceType.GITHUB : BlueprintSourceType.LOCALDIR,
        sourceUri: body.sourceUri,
        sourceRef: body.sourceRef ?? null,
        includeGlobs: body.includeGlobs as Prisma.InputJsonValue,
        excludeGlobs: body.excludeGlobs as Prisma.InputJsonValue,
        capabilityId: body.capabilityId,
        architectAgentTemplateId: agentTemplateIds.architectAgentTemplateId,
        developerAgentTemplateId: agentTemplateIds.developerAgentTemplateId,
        qaAgentTemplateId: agentTemplateIds.qaAgentTemplateId,
        workflowInstanceId: resolvedWorkflowInstanceId,
        phaseId: body.phaseId ?? null,
        metadata: initialLoopState as unknown as Prisma.InputJsonValue,
        createdById: req.user!.userId,
      },
    })
    await recordBlueprintAudit(session.id, 'BlueprintSessionCreated', req.user!.userId, {
      capabilityId: session.capabilityId,
      sourceType: session.sourceType,
      workflowInstanceId: session.workflowInstanceId,
      workflowNodeId: resolvedWorkflowNodeId,
      workflowLinkWarning: workflowLink.warning,
      intakeDefaults: body.intakeDefaults,
      intakeOverrides: body.intakeOverrides,
    })
    if (body.intakeOverrides?.goalEdited || body.intakeOverrides?.sourceEdited) {
      await recordBlueprintAudit(session.id, 'BlueprintIntakeOverrideRecorded', req.user!.userId, {
        workflowInstanceId: session.workflowInstanceId,
        workflowNodeId: resolvedWorkflowNodeId,
        intakeDefaults: body.intakeDefaults,
        intakeOverrides: body.intakeOverrides,
      })
    }
    res.status(201).json(await loadSession(session.id, req.user!.userId))
  } catch (err) { next(err) }
})

blueprintRouter.get('/sessions/:id', async (req, res, next) => {
  try {
    res.json(await loadSession(req.params.id, req.user!.userId))
  } catch (err) { next(err) }
})

// M98 P2 — Lightweight session status. The full GET /sessions/:id eagerly
// loads snapshots + stageRuns + artifacts and reshapes the whole blob; a live
// "is the current stage done yet?" poll only needs a handful of fields. The
// workbench polls this (cheap — no relation includes) while a stage is RUNNING
// and refetches the full session only when something actually changed
// (session.updatedAt advances on every metadata write, so it's a reliable
// single change signal).
blueprintRouter.get('/sessions/:id/status', async (req, res, next) => {
  try {
    const session = await prisma.blueprintSession.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        goal: true,
        status: true,
        metadata: true,
        updatedAt: true,
        createdById: true,
        architectAgentTemplateId: true,
        developerAgentTemplateId: true,
        qaAgentTemplateId: true,
        workflowInstanceId: true,
        phaseId: true,
      },
    })
    if (!session) throw new NotFoundError('BlueprintSession', req.params.id)
    assertBlueprintAccess(session, req.user!.userId)

    const loop = readLoopState(session)
    const currentStageKey = loop.currentStageKey
    const attemptsForStage = currentStageKey
      ? loop.stageAttempts.filter(a => a.stageKey === currentStageKey)
      : []
    const latestAttempt = attemptsForStage.length
      ? attemptsForStage.reduce((best, a) => (a.attemptNumber >= best.attemptNumber ? a : best))
      : undefined

    res.json({
      id: session.id,
      status: session.status,
      currentStageKey,
      updatedAt: session.updatedAt.toISOString(),
      latestAttempt: latestAttempt
        ? {
            id: latestAttempt.id,
            stageKey: latestAttempt.stageKey,
            attemptNumber: latestAttempt.attemptNumber,
            status: latestAttempt.status,
            verdict: latestAttempt.verdict ?? null,
          }
        : null,
    })
  } catch (err) { next(err) }
})

blueprintRouter.patch('/sessions/:id/settings', validate(updateSessionSettingsSchema), async (req, res, next) => {
  try {
    const body = req.body as UpdateSessionSettingsInput
    const sessionId = String(req.params.id)
    const session = await prisma.blueprintSession.findUnique({ where: { id: sessionId } })
    if (!session) throw new NotFoundError('BlueprintSession', sessionId)
    assertBlueprintAccess(session, req.user!.userId)

    const state = readLoopState(session)
    const nextLoopDefinition = applyLoopLimitSettings(state.loopDefinition, body)
    const nextExecutionConfig: LoopState['executionConfig'] = {
      ...(state.executionConfig ?? {}),
      ...(body.snapshotMode !== undefined ? { snapshotMode: body.snapshotMode } : {}),
      ...(body.excerptBudgetChars !== undefined ? { excerptBudgetChars: body.excerptBudgetChars } : {}),
      ...(body.reuseUnchangedAttempt !== undefined ? { reuseUnchangedAttempt: body.reuseUnchangedAttempt } : {}),
      ...(body.governanceMode !== undefined ? { governanceMode: body.governanceMode } : {}),
      ...(body.maxContextTokens !== undefined ? { maxContextTokens: body.maxContextTokens } : {}),
      ...(body.maxOutputTokens !== undefined ? { maxOutputTokens: body.maxOutputTokens } : {}),
      ...(body.maxPromptChars !== undefined ? { maxPromptChars: body.maxPromptChars } : {}),
      ...(body.maxLayerChars !== undefined ? { maxLayerChars: body.maxLayerChars } : {}),
    }
    if (body.modelAlias !== undefined) {
      if (body.modelAlias === null) delete nextExecutionConfig.modelAlias
      else nextExecutionConfig.modelAlias = body.modelAlias
    }
    if (body.stageModelAliases !== undefined) {
      nextExecutionConfig.stageModelAliases = sanitizeStageModelAliases(body.stageModelAliases)
    }
    if (body.stagePhaseModelAliases !== undefined) {
      nextExecutionConfig.stagePhaseModelAliases = sanitizeStagePhaseModelAliases(body.stagePhaseModelAliases)
    }
    const nextState: LoopState = {
      ...state,
      loopDefinition: nextLoopDefinition,
      executionConfig: nextExecutionConfig,
      reviewEvents: [
        ...state.reviewEvents,
        {
          id: crypto.randomUUID(),
          type: 'SETTINGS_UPDATED',
          stageKey: state.currentStageKey ?? undefined,
          message: 'Workbench runtime settings were updated.',
          actorId: req.user!.userId,
          payload: {
            maxLoopsPerStage: nextLoopDefinition.maxLoopsPerStage,
            maxTotalSendBacks: nextLoopDefinition.maxTotalSendBacks,
            executionConfig: nextExecutionConfig,
          },
          createdAt: new Date().toISOString(),
        },
      ],
    }
    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: { metadata: stateToMetadata(session, nextState) },
    })
    await recordBlueprintAudit(session.id, 'BlueprintSessionSettingsUpdated', req.user!.userId, {
      capabilityId: session.capabilityId,
      maxLoopsPerStage: nextLoopDefinition.maxLoopsPerStage,
      maxTotalSendBacks: nextLoopDefinition.maxTotalSendBacks,
      executionConfig: nextExecutionConfig,
    })
    res.json(await loadSession(session.id, req.user!.userId))
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions/:id/stages/:stageKey/reset-attempts', async (req, res, next) => {
  try {
    const sessionId = String(req.params.id)
    const requestedStageKey = String(req.params.stageKey)
    const session = await prisma.blueprintSession.findUnique({ where: { id: sessionId } })
    if (!session) throw new NotFoundError('BlueprintSession', sessionId)
    assertBlueprintAccess(session, req.user!.userId)

    const state = readLoopState(session)
    const stage = state.loopDefinition.stages.find(item => item.key === requestedStageKey || item.key === slug(requestedStageKey))
    if (!stage) throw new ValidationError(`Unknown Workbench stage: ${requestedStageKey}`)
    const removedAttempts = state.stageAttempts.filter(attempt => attempt.stageKey === stage.key)
    if (removedAttempts.length === 0) {
      res.json(await loadSession(session.id, req.user!.userId))
      return
    }

    // Delete artifacts produced by the removed attempts
    const removedArtifactIds = removedAttempts.flatMap(attempt => attempt.artifactIds ?? [])
    if (removedArtifactIds.length > 0) {
      await prisma.blueprintArtifact.deleteMany({ where: { id: { in: removedArtifactIds } } })
    }

    // Delete source snapshots so the next run takes a fresh one
    await prisma.blueprintSourceSnapshot.deleteMany({ where: { sessionId: session.id } })

    // Clear the stage chat thread so the next attempt starts a fresh conversation
    const stageChats = readStageChats(session.metadata)
    delete stageChats[stage.key]

    const nextState: LoopState = {
      ...state,
      currentStageKey: stage.key,
      stageAttempts: state.stageAttempts.filter(attempt => attempt.stageKey !== stage.key),
      reviewEvents: [
        ...state.reviewEvents,
        {
          id: crypto.randomUUID(),
          type: 'STAGE_ATTEMPTS_RESET',
          stageKey: stage.key,
          message: `Reset ${removedAttempts.length} attempt${removedAttempts.length === 1 ? '' : 's'} for ${stage.label}. Artifacts and snapshots cleared.`,
          actorId: req.user!.userId,
          payload: {
            stageKey: stage.key,
            stageLabel: stage.label,
            removedAttemptIds: removedAttempts.map(attempt => attempt.id),
            removedAttemptCount: removedAttempts.length,
            removedArtifactCount: removedArtifactIds.length,
            snapshotsDeleted: true,
          },
          createdAt: new Date().toISOString(),
        },
      ],
    }
    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: {
        status: session.status === 'COMPLETED' || session.status === 'APPROVED' ? 'RUNNING' : session.status,
        metadata: {
          ...(stateToMetadata(session, nextState) as Record<string, unknown>),
          stageChats,
        },
      },
    })
    await recordBlueprintAudit(session.id, 'BlueprintStageAttemptsReset', req.user!.userId, {
      capabilityId: session.capabilityId,
      workflowInstanceId: session.workflowInstanceId,
      workflowNodeId: state.workflowNodeId,
      stageKey: stage.key,
      stageLabel: stage.label,
      removedAttemptCount: removedAttempts.length,
      removedAttemptIds: removedAttempts.map(attempt => attempt.id),
      removedArtifactCount: removedArtifactIds.length,
      snapshotsDeleted: true,
    })
    res.json(await loadSession(session.id, req.user!.userId))
  } catch (err) { next(err) }
})

// ── M89.e — Cancel in-flight attempt ───────────────────────────────────
//
// /reset-attempts (above) is the nuclear option — it deletes every
// attempt + artifact for the stage and clears the chat. Too coarse for
// the common case: "the agent is stuck or wedged; let me kill it and
// re-run without losing the prior history."
//
// This endpoint is surgical. It finds the single in-flight attempt
// (status=RUNNING or PAUSED) for the stage and marks it FAILED with a
// human-attributed reason. Other attempts in the array stay intact.
// The next call to start a stage attempt will then succeed (the
// in-flight guard at L2947 looks for RUNNING/PAUSED).
//
// We don't proactively reach into context-fabric to cancel the live
// run — CF's governed loop has its own internal max_turns + HTTP
// timeout (15min envelope) which will reap the orphaned worker
// eventually. Cancelling here is about unwedging the platform's
// view of state so the operator can move forward immediately.
//
// Repro 2026-05-27 (the trigger for this slice): workgraph-api got
// restarted mid-attempt; the BlueprintSession.metadata kept the
// attempt at status=RUNNING forever; "Snapshot + run" refused with
// "in-flight attempt" until the row was hand-patched in SQL.
blueprintRouter.post('/sessions/:id/stages/:stageKey/cancel-attempt', async (req, res, next) => {
  try {
    const sessionId = String(req.params.id)
    const requestedStageKey = String(req.params.stageKey)
    const session = await prisma.blueprintSession.findUnique({ where: { id: sessionId } })
    if (!session) throw new NotFoundError('BlueprintSession', sessionId)
    assertBlueprintAccess(session, req.user!.userId)

    const state = readLoopState(session)
    const stage = state.loopDefinition.stages.find(item => item.key === requestedStageKey || item.key === slug(requestedStageKey))
    if (!stage) throw new ValidationError(`Unknown Workbench stage: ${requestedStageKey}`)

    const inflight = state.stageAttempts.find(
      a => a.stageKey === stage.key && (a.status === 'RUNNING' || a.status === 'PAUSED'),
    )
    if (!inflight) {
      // Nothing to do — return the session as-is.
      res.json(await loadSession(session.id, req.user!.userId))
      return
    }

    const now = new Date().toISOString()
    const nextState: LoopState = {
      ...state,
      stageAttempts: state.stageAttempts.map(a =>
        a.id === inflight.id
          ? {
              ...a,
              status: 'FAILED' as const,
              completedAt: now,
              failureReason: 'Cancelled by operator',
            }
          : a,
      ),
      reviewEvents: [
        ...state.reviewEvents,
        {
          id: crypto.randomUUID(),
          type: 'STAGE_ATTEMPT_CANCELLED',
          stageKey: stage.key,
          message: `Cancelled in-flight attempt #${inflight.attemptNumber} for ${stage.label}`,
          actorId: req.user!.userId,
          payload: {
            stageKey: stage.key,
            stageLabel: stage.label,
            attemptId: inflight.id,
            attemptNumber: inflight.attemptNumber,
            priorStatus: inflight.status,
          },
          createdAt: now,
        },
      ],
    }
    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: { metadata: stateToMetadata(session, nextState) as Prisma.InputJsonValue },
    })
    await recordBlueprintAudit(session.id, 'BlueprintStageAttemptCancelled', req.user!.userId, {
      capabilityId: session.capabilityId,
      workflowInstanceId: session.workflowInstanceId,
      workflowNodeId: state.workflowNodeId,
      stageKey: stage.key,
      stageLabel: stage.label,
      attemptId: inflight.id,
      attemptNumber: inflight.attemptNumber,
      priorStatus: inflight.status,
    })
    res.json(await loadSession(session.id, req.user!.userId))
  } catch (err) { next(err) }
})

// ── M45 — Loop trace for the Workbench Loop tab ─────────────────────────
// Builds the deterministic trace_id from session + stage and synthesizes
// the step/phase timeline from audit-gov events. Previously proxied to
// mcp-server's /mcp/audit/loop-trace, but that store has no data for
// post-M71 governed runs (context-fabric emits to audit-gov instead).
// The synthesizer pulls governed.llm_request/response + tool_dispatched
// events for the trace and pairs them into steps.
blueprintRouter.get('/sessions/:id/stages/:stageKey/loop-trace', async (req, res, next) => {
  try {
    const session = await prisma.blueprintSession.findUnique({ where: { id: req.params.id } })
    if (!session) throw new NotFoundError('BlueprintSession', req.params.id)
    assertBlueprintAccess(session, req.user!.userId)
    const traceId = `blueprint-${session.id}-${req.params.stageKey}`
    const trace = await synthesizeLoopTrace(traceId)
    res.json(trace)
  } catch (err) { next(err) }
})

// ─── M83 S1 — Worktree browser endpoints ─────────────────────────────────
// Proxy read-only views of the workitem's wi/<code> worktree from
// mcp-server (which owns the filesystem) to the workbench. We resolve
// the workItemCode from the session's workflow context (set during the
// WORKBENCH_TASK node activation) so the workbench just sends sessionId
// and the path; no client trust on the workitem identity.
async function getWorktreeWorkItemCode(sessionId: string): Promise<string> {
  const session = await prisma.blueprintSession.findUnique({ where: { id: sessionId } })
  if (!session) throw new NotFoundError('BlueprintSession', sessionId)
  const ctx = await workflowWorkItemContext(session.workflowInstanceId)
  if (ctx.workItemCode) return ctx.workItemCode
  // No WorkItem bound — the common case for a workbench run launched directly
  // by URL (it never goes through the workflow engine's WORKBENCH_TASK
  // routeWorkItem step). The governed stages DON'T require a WorkItem: they
  // materialize the worktree under workbenchWorkitemBranch()'s fallback
  // identity (workflowInstanceId -> blueprint-<sessionId>). Resolve the worktree
  // browser to that SAME identity (the branch minus its `wi/` prefix, which is
  // exactly what mcp-server keys the per-workitem worktree on) so the Code
  // workspace reads the dev's real diff instead of erroring. Reusing
  // workbenchWorkitemBranch guarantees the browser identity can never drift
  // from the materialization identity.
  return workbenchWorkitemBranch(session, null).replace(/^wi\//, '')
}

// M83.z2 (2026-05-27) — Manual session ↔ WorkItem binding.
//
// Normal flow: workflow runs, WORKBENCH_TASK node activates, the
// runtime sets `workflowInstance.context._workItem` via routeWorkItem(),
// and getWorktreeWorkItemCode() resolves cleanly from there.
//
// This endpoint is the recovery path when that didn't happen — e.g.
// the workflow stalled before reaching WORKBENCH_TASK, or the
// operator opened the workbench on a session whose workflow context
// is missing the binding for some other reason. Without this, the
// only fix is to restart the whole workflow.
//
// Resolves the WorkItem by id OR workCode (operator can use either),
// validates the operator has access to it, then patches the linked
// workflow instance's context to set `_workItem`. Subsequent worktree
// API calls resolve normally. Audited as
// `BlueprintSessionBoundToWorkItem` so the operator action is on
// record in audit-gov.
const bindWorkItemSchema = z.object({
  workItemId: z.string().uuid().optional(),
  workItemCode: z.string().min(1).max(80).optional(),
}).refine(
  data => Boolean(data.workItemId) !== Boolean(data.workItemCode),
  { message: 'Provide exactly one of workItemId or workItemCode' },
)

blueprintRouter.post(
  '/sessions/:id/bind-workitem',
  validate(bindWorkItemSchema),
  async (req, res, next) => {
    try {
      const session = await prisma.blueprintSession.findUnique({ where: { id: req.params.id } })
      if (!session) throw new NotFoundError('BlueprintSession', req.params.id)
      assertBlueprintAccess(session, req.user!.userId)

      if (!session.workflowInstanceId) {
        throw new ValidationError(
          'Cannot bind: this session has no workflowInstanceId. ' +
          'The bind path updates the workflow instance context — a session without one ' +
          'needs to be attached to a workflow first via the normal stage-run path.',
        )
      }

      const body = req.body as z.infer<typeof bindWorkItemSchema>
      const workItem = body.workItemId
        ? await prisma.workItem.findUnique({ where: { id: body.workItemId } })
        : await prisma.workItem.findUnique({ where: { workCode: body.workItemCode! } })
      if (!workItem) {
        throw new NotFoundError('WorkItem', body.workItemId ?? body.workItemCode!)
      }

      const instance = await prisma.workflowInstance.findUnique({
        where: { id: session.workflowInstanceId },
        select: { id: true, context: true },
      })
      if (!instance) {
        throw new NotFoundError('WorkflowInstance', session.workflowInstanceId)
      }

      const previousContext = isRecord(instance.context) ? instance.context : {}
      const previousWorkItem = isRecord(previousContext._workItem) ? previousContext._workItem : null
      const previousWorkCode = jsonStringField(previousWorkItem ?? {}, 'workCode')

      // Patch — preserve any unrelated context keys. _workItem shape
      // mirrors what work-item-routing.service.ts:routeWorkItem writes
      // so downstream readers (workflowWorkItemContext, branch naming,
      // mcp-server materializer) see an identical structure.
      const nextContext: Prisma.InputJsonValue = {
        ...previousContext,
        _workItem: {
          id: workItem.id,
          workCode: workItem.workCode,
          title: workItem.title,
          // The boundManually marker lets audit-gov distinguish operator
          // binds from runtime binds when investigating "how did this
          // session get attached to this workitem" later.
          boundManually: true,
          boundAt: new Date().toISOString(),
          boundByUserId: req.user!.userId,
          ...(previousWorkCode ? { previousWorkCode } : {}),
        } as Prisma.InputJsonValue,
      }

      await prisma.workflowInstance.update({
        where: { id: instance.id },
        data: { context: nextContext },
      })

      await recordBlueprintAudit(
        session.id,
        'BlueprintSessionBoundToWorkItem',
        req.user!.userId,
        {
          workflowInstanceId: instance.id,
          workItemId: workItem.id,
          workItemCode: workItem.workCode,
          workItemTitle: workItem.title,
          previousWorkCode,
        },
      )

      res.json({
        ok: true,
        sessionId: session.id,
        workflowInstanceId: instance.id,
        workItem: {
          id: workItem.id,
          workCode: workItem.workCode,
          title: workItem.title,
        },
        replacedPrevious: previousWorkCode ?? null,
      })
    } catch (err) { next(err) }
  },
)

blueprintRouter.get('/sessions/:id/worktree/tree', async (req, res, next) => {
  try {
    const session = await prisma.blueprintSession.findUnique({ where: { id: req.params.id } })
    if (!session) throw new NotFoundError('BlueprintSession', req.params.id)
    assertBlueprintAccess(session, req.user!.userId)
    assertStageRepoRead(session, req.query.stageKey)
    const workItemCode = await getWorktreeWorkItemCode(req.params.id)
    const params = new URLSearchParams()
    if (typeof req.query.path === 'string') params.set('path', req.query.path)
    if (req.query.showHidden === 'true') params.set('showHidden', 'true')
    const mcpUrl = config.MCP_SERVER_URL.replace(/\/+$/, '')
    const upstream = await fetch(`${mcpUrl}/mcp/worktree/${encodeURIComponent(workItemCode)}/tree?${params.toString()}`, {
      headers: { authorization: `Bearer ${config.MCP_BEARER_TOKEN}` },
    })
    const body = await upstream.json().catch(() => ({})) as { success?: boolean; data?: unknown; error?: { message?: string } }
    if (!upstream.ok) {
      throw new ValidationError(body.error?.message ?? `mcp-server worktree tree returned ${upstream.status}`)
    }
    res.json(body.data ?? body)
  } catch (err) { next(err) }
})

blueprintRouter.get('/sessions/:id/worktree/file', async (req, res, next) => {
  try {
    const session = await prisma.blueprintSession.findUnique({ where: { id: req.params.id } })
    if (!session) throw new NotFoundError('BlueprintSession', req.params.id)
    assertBlueprintAccess(session, req.user!.userId)
    assertStageRepoRead(session, req.query.stageKey)
    if (typeof req.query.path !== 'string' || !req.query.path.trim()) {
      throw new ValidationError("'path' query parameter is required")
    }
    const workItemCode = await getWorktreeWorkItemCode(req.params.id)
    const params = new URLSearchParams({ path: req.query.path })
    const mcpUrl = config.MCP_SERVER_URL.replace(/\/+$/, '')
    const upstream = await fetch(`${mcpUrl}/mcp/worktree/${encodeURIComponent(workItemCode)}/file?${params.toString()}`, {
      headers: { authorization: `Bearer ${config.MCP_BEARER_TOKEN}` },
    })
    const body = await upstream.json().catch(() => ({})) as { success?: boolean; data?: unknown; error?: { message?: string } }
    if (!upstream.ok) {
      throw new ValidationError(body.error?.message ?? `mcp-server worktree file returned ${upstream.status}`)
    }
    res.json(body.data ?? body)
  } catch (err) { next(err) }
})

// M83 S2 — operator commits a file edit to wi/<code>. workgraph-api
// injects the IAM identity (email + displayName) into the request so
// mcp-server can attribute the git commit to the human, not the
// platform account. expectedSha enables optimistic concurrency vs.
// concurrent agent attempts on the same branch.
blueprintRouter.put('/sessions/:id/worktree/file', async (req, res, next) => {
  try {
    const session = await prisma.blueprintSession.findUnique({ where: { id: req.params.id } })
    if (!session) throw new NotFoundError('BlueprintSession', req.params.id)
    assertBlueprintAccess(session, req.user!.userId)
    assertStageMutation(session, req.query.stageKey)
    if (typeof req.query.path !== 'string' || !req.query.path.trim()) {
      throw new ValidationError("'path' query parameter is required")
    }
    const workItemCode = await getWorktreeWorkItemCode(req.params.id)
    const params = new URLSearchParams({ path: req.query.path })
    const mcpUrl = config.MCP_SERVER_URL.replace(/\/+$/, '')
    // Inject the operator identity from the verified JWT. The client
    // can't override this — even if it sends authorEmail/authorName
    // in the body, we replace before forwarding to mcp-server.
    const clientBody = (req.body ?? {}) as Record<string, unknown>
    const proxyBody = {
      ...clientBody,
      authorEmail: req.user!.email,
      authorName: req.user!.displayName,
    }
    const upstream = await fetch(`${mcpUrl}/mcp/worktree/${encodeURIComponent(workItemCode)}/file?${params.toString()}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${config.MCP_BEARER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(proxyBody),
    })
    const body = await upstream.json().catch(() => ({})) as { success?: boolean; data?: unknown; error?: { message?: string; code?: string } }
    if (!upstream.ok) {
      const code = body.error?.code
      // 409 stale-sha is special — bubble it as a typed error so the
      // workbench can re-fetch and re-apply rather than discard.
      if (upstream.status === 409) {
        res.status(409).json({ code: 'STALE_EDIT', message: body.error?.message ?? 'stale edit', upstreamCode: code })
        return
      }
      throw new ValidationError(body.error?.message ?? `mcp-server worktree write returned ${upstream.status}`)
    }
    res.json(body.data ?? body)
  } catch (err) { next(err) }
})

// M83 S4 v1 — API caller proxy. The operator brings the workitem's
// service up however they want (host JVM, docker compose, sibling
// container) and points this endpoint at it. We do the fetch
// server-side so CORS, cookies, and the workbench origin lock all
// stay sane, and so we can enforce the target-host allowlist
// (private/loopback only — no exfiltration vectors).
//
// Followup (deferred S4.b/c, see docs/M83-ide-develop-stage.md):
// long-lived `serve` lifecycle that spins up a runner container
// running `mvn spring-boot:run` / `npm start` and registers a
// proxyId. v1 just trusts the operator to bring up the service.
// SSRF-safe target resolution for the api-call proxy. Validates protocol +
// host, DNS-resolves the hostname, and requires EVERY resolved address to be
// private/loopback. Returns the address to actually connect to so the caller
// can PIN the connection to the validated IP — this defeats DNS rebinding
// (the host could re-resolve to a public/metadata IP between check and fetch).
// IP classification (incl. cloud metadata 169.254.169.254, IPv6, IPv4-mapped)
// lives in lib/ssrf-guard.ts and is unit-tested.
async function resolveApiCallerTarget(
  rawUrl: string,
): Promise<{ ok: true; url: URL; connectIp: string; host: string } | { ok: false; reason: string }> {
  const pre = precheckTargetUrl(rawUrl)
  if (!pre.ok) return pre

  // IP literal already classified as private by precheck → connect to it directly.
  if (pre.ipLiteral) {
    return { ok: true, url: pre.url, connectIp: pre.ipLiteral, host: pre.host }
  }

  // Hostname: resolve ALL addresses and require every one to be internal.
  // (Resolving all, not just the first, blocks a host that returns one private
  // + one public address.)
  let addrs: { address: string }[]
  try {
    addrs = await dnsLookup(pre.host, { all: true })
  } catch (err) {
    return { ok: false, reason: `could not resolve host '${pre.host}': ${(err as Error).message}` }
  }
  if (addrs.length === 0) {
    return { ok: false, reason: `host '${pre.host}' resolved to no addresses` }
  }
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) {
      return { ok: false, reason: `host '${pre.host}' resolves to non-private address ${a.address}` }
    }
  }
  // Pin to the first validated address. We preserve the original Host header
  // (set in the route) so vhost-routed internal services still match.
  return { ok: true, url: pre.url, connectIp: addrs[0].address, host: pre.host }
}

blueprintRouter.post('/sessions/:id/api-call', async (req, res, next) => {
  try {
    const session = await prisma.blueprintSession.findUnique({ where: { id: req.params.id } })
    if (!session) throw new NotFoundError('BlueprintSession', req.params.id)
    assertBlueprintAccess(session, req.user!.userId)
    const body = (req.body ?? {}) as {
      method?: string
      url?: string
      headers?: Record<string, string>
      body?: string
      timeoutMs?: number
      stageKey?: string
    }
    assertStageToolRun(session, body.stageKey)
    const method = (body.method ?? 'GET').toUpperCase()
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) {
      throw new ValidationError(`Method '${method}' is not allowed`)
    }
    if (typeof body.url !== 'string' || !body.url.trim()) {
      throw new ValidationError("'url' is required")
    }
    const guard = await resolveApiCallerTarget(body.url)
    if (!guard.ok) {
      throw new ValidationError(`API caller refused: ${guard.reason}`)
    }
    const timeoutMs = Math.min(Math.max(body.timeoutMs ?? 30_000, 1_000), 120_000)
    const startedAt = Date.now()
    const headers = new Headers(body.headers ?? {})
    // Strip any client-supplied Authorization to prevent the operator
    // from accidentally forwarding their workbench JWT to the proxied
    // target. If they need auth on the target, they supply a separate
    // header like X-Target-Authorization that the target accepts.
    headers.delete('authorization')
    headers.delete('cookie')
    // SSRF rebinding defense: connect to the IP we just validated, not the
    // hostname (which could re-resolve to a public/metadata IP between the
    // check above and this fetch). We rewrite the URL's host to the pinned
    // IP and preserve the original Host header so vhost routing still works.
    // HTTPS to a pinned IP would break SNI/cert validation, so HTTPS targets
    // keep their hostname (rebinding is far less practical over TLS, and these
    // targets are operator-run internal dev services that are typically http).
    const connectUrl = new URL(guard.url.toString())
    if (connectUrl.protocol === 'http:' && net.isIP(guard.connectIp)) {
      if (!headers.has('host')) headers.set('host', guard.url.host)
      connectUrl.hostname = net.isIP(guard.connectIp) === 6 ? `[${guard.connectIp}]` : guard.connectIp
    }
    const fetchInit: RequestInit = {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      // Only pass a body when the method supports it. fetch will throw
      // on GET/HEAD with body.
      ...(method !== 'GET' && method !== 'HEAD' && body.body
        ? { body: body.body }
        : {}),
    }
    let upstream: Response
    try {
      upstream = await fetch(connectUrl.toString(), fetchInit)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.json({
        ok: false,
        status: 0,
        error: msg,
        durationMs: Date.now() - startedAt,
      })
      return
    }
    // Collect headers + body. Cap at 5 MB to avoid eating workgraph-api
    // memory on a misbehaving target.
    const responseHeaders: Record<string, string> = {}
    upstream.headers.forEach((value, key) => { responseHeaders[key] = value })
    const buf = await upstream.arrayBuffer().catch(() => new ArrayBuffer(0))
    const MAX = 5 * 1024 * 1024
    const truncated = buf.byteLength > MAX
    const bodyText = Buffer.from(buf.slice(0, MAX)).toString('utf8')
    res.json({
      ok: upstream.ok,
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
      body: bodyText,
      byteLength: buf.byteLength,
      truncated,
      durationMs: Date.now() - startedAt,
    })
  } catch (err) { next(err) }
})

// M83 S3 — Test runner SSE proxy. The mcp-server endpoint returns
// text/event-stream; we pipe the response straight through so the
// workbench's EventSource gets the started → stdout/stderr → finished
// stream as the runner produces it. workgraph-api's role here is auth
// + session-to-workitem resolution; no buffering, no transformation.
blueprintRouter.post('/sessions/:id/worktree/run-test', async (req, res, next) => {
  try {
    const session = await prisma.blueprintSession.findUnique({ where: { id: req.params.id } })
    if (!session) throw new NotFoundError('BlueprintSession', req.params.id)
    assertBlueprintAccess(session, req.user!.userId)
    assertStageToolRun(session, (req.body ?? {})?.stageKey)
    const workItemCode = await getWorktreeWorkItemCode(req.params.id)
    const mcpUrl = config.MCP_SERVER_URL.replace(/\/+$/, '')
    const upstream = await fetch(`${mcpUrl}/mcp/worktree/${encodeURIComponent(workItemCode)}/run-test`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.MCP_BEARER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(req.body ?? {}),
    })
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '')
      throw new ValidationError(`mcp-server worktree run-test returned ${upstream.status}: ${text.slice(0, 300)}`)
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // Pipe the upstream SSE bytes straight to the client. Node 22's
    // fetch returns a web ReadableStream; we drain it manually so we
    // don't depend on a stream-utils import.
    const reader = upstream.body.getReader()
    const onAbort = () => { void reader.cancel().catch(() => undefined) }
    req.on('close', onAbort)
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) res.write(value)
      }
    } finally {
      req.off('close', onAbort)
      res.end()
    }
  } catch (err) { next(err) }
})

// M83 S3.2 — Persist a human-origin verification receipt against the
// latest stage attempt. Called by the workbench Test Runner panel when
// the operator finishes a manual `mvn test` / `pytest` / etc. so the
// approval gate (attemptHasPassingVerificationReceipt) sees the human
// evidence in addition to whatever the agent captured. Origin marker
// keeps the audit trail honest: the receipt didn't come from the LLM.
blueprintRouter.post('/sessions/:id/worktree/verification', async (req, res, next) => {
  try {
    const session = await prisma.blueprintSession.findUnique({ where: { id: req.params.id } })
    if (!session) throw new NotFoundError('BlueprintSession', req.params.id)
    assertBlueprintAccess(session, req.user!.userId)
    // A human verification receipt feeds the approval gate; only allow it on
    // stages that actually permit tool execution (MUTATION/VERIFICATION),
    // matching the UI's canRunTools gate. Prevents fabricating a passing
    // receipt on a story-only / read-only / review stage.
    assertStageToolRun(session)

    const body = req.body as {
      command?: string
      passed?: boolean
      exitCode?: number | null
      durationMs?: number
      toolName?: string
      output?: string
      notes?: string
    } | undefined
    if (!body || typeof body.command !== 'string' || !body.command.trim()) {
      throw new ValidationError('command is required')
    }
    if (typeof body.passed !== 'boolean') {
      throw new ValidationError('passed (boolean) is required')
    }
    const exitCodeNum = typeof body.exitCode === 'number' ? body.exitCode : null
    const durationMs = typeof body.durationMs === 'number' && Number.isFinite(body.durationMs)
      ? Math.max(0, Math.round(body.durationMs))
      : 0
    // Receipts are bounded; output_excerpt keeps the tail (the part with
    // failures/assertions) and caps at 4KB so metadata stays compact.
    const outputExcerpt = typeof body.output === 'string' && body.output.length > 0
      ? body.output.slice(-4000)
      : undefined
    const notes = typeof body.notes === 'string' && body.notes.length > 0
      ? body.notes.slice(0, 1000)
      : undefined

    const state = readLoopState(session)
    const currentStageKey = state.currentStageKey
    if (!currentStageKey) {
      throw new ValidationError('No current stage on this session — cannot attach a receipt')
    }
    const latestAttempt = latestStageAttempt(state, currentStageKey)
    if (!latestAttempt) {
      throw new ValidationError(`No stage attempt exists yet for ${currentStageKey}`)
    }

    const receipt: Record<string, unknown> = {
      id: crypto.randomUUID(),
      toolName: body.toolName?.trim() || 'run_test_human',
      command: body.command.trim(),
      exit_code: exitCodeNum,
      passed: body.passed,
      durationMs,
      origin: 'human',
      capturedBy: req.user?.email ?? req.user?.userId ?? 'operator',
      capturedAt: new Date().toISOString(),
      ...(outputExcerpt ? { output_excerpt: outputExcerpt } : {}),
      ...(notes ? { notes } : {}),
    }

    const existingReceipts = Array.isArray(latestAttempt.verificationReceipts)
      ? latestAttempt.verificationReceipts
      : []
    const updatedAttempts = state.stageAttempts.map(item => item.id === latestAttempt.id
      ? { ...item, verificationReceipts: [...existingReceipts, receipt] }
      : item)
    const updatedState: LoopState = { ...state, stageAttempts: updatedAttempts }

    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: { metadata: stateToMetadata(session, updatedState) },
    })
    // Mirror into the session-level rolling history so the next stage's
    // prior_verification_receipts thread includes it. The de-dup logic
    // already handles re-runs of the same command.
    await appendVerificationReceiptsToSession(session.id, [receipt])

    await recordBlueprintAudit(session.id, 'HumanVerificationReceiptAttached', req.user!.userId, {
      stageKey: currentStageKey,
      attemptId: latestAttempt.id,
      command: receipt.command,
      passed: receipt.passed,
      exitCode: receipt.exit_code,
      origin: 'human',
    })

    res.json({
      ok: true,
      receipt,
      attemptId: latestAttempt.id,
      stageKey: currentStageKey,
      totalReceipts: existingReceipts.length + 1,
    })
  } catch (err) { next(err) }
})

// Artifacts produced by an executed run, for the dedicated Run Artifacts view.
// Two entry points because artifacts hang off the BLUEPRINT SESSION, but a run
// is identified by its WORKFLOW INSTANCE id (the Run Viewer's :id):
//   GET /sessions/:id/artifacts            — session-keyed (the natural owner)
//   GET /instances/:instanceId/artifacts   — resolves instance → session(s)
// Both inherit authMiddleware + assertBlueprintAccess. content/payload are
// returned inline (already the case via shapeArtifact). Optional ?stageKey
// filter mirrors /code-changes.
function shapeArtifactsResponse(
  session: { id: string; workflowInstanceId?: string | null; artifacts?: Array<{ payload?: Prisma.JsonValue | null; createdAt: Date }> },
  stageKey?: string,
) {
  let items = (session.artifacts ?? []).map(shapeArtifact)
  if (stageKey) items = items.filter(a => a.stageKey === stageKey)
  return {
    sessionId: session.id,
    workflowInstanceId: session.workflowInstanceId ?? null,
    count: items.length,
    items,
  }
}

blueprintRouter.get('/sessions/:id/artifacts', async (req, res, next) => {
  try {
    const session = await prisma.blueprintSession.findUnique({
      where: { id: req.params.id },
      include: { artifacts: { orderBy: { createdAt: 'asc' } } },
    })
    if (!session) throw new NotFoundError('BlueprintSession', req.params.id)
    assertBlueprintAccess(session, req.user!.userId)
    const stageKey = typeof req.query.stageKey === 'string' && req.query.stageKey.trim()
      ? req.query.stageKey.trim()
      : undefined
    res.json(shapeArtifactsResponse(session, stageKey))
  } catch (err) { next(err) }
})

blueprintRouter.get('/instances/:instanceId/artifacts', async (req, res, next) => {
  try {
    // A workflow instance may have spawned more than one blueprint session
    // (re-runs / multiple workbench nodes). Return every accessible session's
    // artifacts, grouped, plus a flattened list for simple consumers.
    const sessions = await prisma.blueprintSession.findMany({
      where: { workflowInstanceId: req.params.instanceId },
      include: { artifacts: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    })
    const stageKey = typeof req.query.stageKey === 'string' && req.query.stageKey.trim()
      ? req.query.stageKey.trim()
      : undefined
    // Filter to sessions the caller may access (createdById === actor). Unowned
    // / other-user sessions are silently excluded rather than 404'ing the run.
    const accessible = sessions.filter(s => s.createdById && s.createdById === req.user!.userId)
    const groups = accessible.map(s => shapeArtifactsResponse(s, stageKey))
    res.json({
      workflowInstanceId: req.params.instanceId,
      sessionCount: groups.length,
      count: groups.reduce((n, g) => n + g.count, 0),
      sessions: groups,
      items: groups.flatMap(g => g.items),
    })
  } catch (err) { next(err) }
})

// Artifacts for a WORK ITEM — the work-item detail page's "Artifacts" panel.
// A work item relates to runs two ways: the run that created it
// (sourceWorkflowInstanceId) and the run(s) it spawned
// (target.childWorkflowInstanceId — the workbench coding runs that produce
// artifacts). We gather every linked instance id, then every accessible
// blueprint session under those instances, and return their artifacts.
blueprintRouter.get('/work-items/:id/artifacts', async (req, res, next) => {
  try {
    const workItem = await prisma.workItem.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        sourceWorkflowInstanceId: true,
        targets: { select: { childWorkflowInstanceId: true } },
      },
    })
    if (!workItem) throw new NotFoundError('WorkItem', req.params.id)
    const instanceIds = uniqueStrings([
      workItem.sourceWorkflowInstanceId,
      ...workItem.targets.map(t => t.childWorkflowInstanceId),
    ])
    const stageKey = typeof req.query.stageKey === 'string' && req.query.stageKey.trim()
      ? req.query.stageKey.trim()
      : undefined
    if (instanceIds.length === 0) {
      res.json({ workItemId: workItem.id, instanceIds: [], sessionCount: 0, count: 0, sessions: [], items: [] })
      return
    }
    const sessions = await prisma.blueprintSession.findMany({
      where: { workflowInstanceId: { in: instanceIds } },
      include: { artifacts: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    })
    // Same ownership rule as the instance route: only the caller's sessions.
    const accessible = sessions.filter(s => s.createdById && s.createdById === req.user!.userId)
    const groups = accessible.map(s => shapeArtifactsResponse(s, stageKey))
    res.json({
      workItemId: workItem.id,
      instanceIds,
      sessionCount: groups.length,
      count: groups.reduce((n, g) => n + g.count, 0),
      sessions: groups,
      items: groups.flatMap(g => g.items),
    })
  } catch (err) { next(err) }
})

blueprintRouter.get('/sessions/:id/code-changes', async (req, res, next) => {
  try {
    const session = await prisma.blueprintSession.findUnique({
      where: { id: req.params.id },
      include: { artifacts: { orderBy: { createdAt: 'desc' } } },
    })
    if (!session) throw new NotFoundError('BlueprintSession', req.params.id)
    assertBlueprintAccess(session, req.user!.userId)

    const stageKey = typeof req.query.stageKey === 'string' && req.query.stageKey.trim()
      ? req.query.stageKey.trim()
      : undefined
    const state = readLoopState(session)
    const lookups = new Map<string, { cfCallId: string; codeChangeIds: Set<string>; mcpServerId?: string }>()
    // (2026-05-26) Inline code-change records harvested by the governed
    // orchestrator adapter. Keyed by record id so we can merge them with
    // the CF roundtrip and prefer the inline diff body when both exist.
    // See orchestrator.ts → adaptGovernedStageToCodingRun → codeChangeRecords.
    const inlineRecords = new Map<string, Record<string, unknown>>()
    const addLookup = (source: Record<string, unknown>) => {
      const cfCallId = source.cfCallId
      if (typeof cfCallId !== 'string' || !cfCallId) return
      const current = lookups.get(cfCallId) ?? { cfCallId, codeChangeIds: new Set<string>() }
      const rawIds = source.codeChangeIds
      if (Array.isArray(rawIds)) {
        for (const rawId of rawIds) {
          if (typeof rawId === 'string' && rawId.trim()) current.codeChangeIds.add(rawId.trim())
        }
      }
      const mcpServerId = source.mcpServerId
      if (typeof mcpServerId === 'string' && mcpServerId.trim()) current.mcpServerId = mcpServerId.trim()
      lookups.set(cfCallId, current)
      const inlineList = source.codeChangeRecords
      if (Array.isArray(inlineList)) {
        for (const raw of inlineList) {
          if (!isRecord(raw)) continue
          const id = raw.id
          if (typeof id !== 'string' || !id) continue
          inlineRecords.set(id, raw)
        }
      }
    }
    for (const attempt of state.stageAttempts ?? []) {
      if (stageKey && attempt.stageKey !== stageKey) continue
      const correlation = isRecord(attempt.correlation) ? attempt.correlation : {}
      addLookup(correlation)
    }
    for (const artifact of session.artifacts ?? []) {
      const payload = isRecord(artifact.payload) ? artifact.payload : {}
      if (stageKey && payload.stageKey !== stageKey) continue
      addLookup(payload)
    }

    const lookupList = [...lookups.values()].filter(lookup => lookup.codeChangeIds.size > 0)
    // Skip MCP roundtrip entirely when every expected id already has an
    // inline record — mcp-server's ring doesn't index by tool_invocation_id
    // and would just return stale placeholders anyway.
    const needsCfLookup = lookupList.some(lookup =>
      [...lookup.codeChangeIds].some(id => !inlineRecords.has(id)),
    )
    const settled = needsCfLookup
      ? await Promise.allSettled(lookupList.map(lookup => contextFabricClient.listCodeChanges(lookup.cfCallId, {
          codeChangeIds: [...lookup.codeChangeIds],
          mcpServerId: lookup.mcpServerId,
        })))
      : []
    // Merge: inline records win when both sources have the same id, since
    // they always carry the diff/patch body. CF/MCP results fill any
    // remaining ids (typically empty placeholders for legacy paths).
    const cfItems = settled.flatMap(result => result.status === 'fulfilled' ? result.value.items : [])
    const itemsById = new Map<string, Record<string, unknown>>()
    for (const cfItem of cfItems) {
      const rec = cfItem as unknown as Record<string, unknown>
      const id = typeof rec.id === 'string' ? rec.id : null
      if (id) itemsById.set(id, rec)
    }
    for (const [id, inline] of inlineRecords) {
      // Inline always wins — it's the authoritative source we just captured.
      itemsById.set(id, inline)
    }
    const items = [...itemsById.values()] as Array<Record<string, unknown> & { paths_touched?: string[] }>
    const rankCodeChange = (item: { paths_touched?: string[] }) => {
      const paths = Array.isArray(item.paths_touched) ? item.paths_touched : []
      if (paths.some(path => /\.(java|kt|scala|ts|tsx|js|jsx|py|go|rs|cs|cpp|c|h|hpp)$/i.test(path))) return 0
      if (paths.some(path => !/\.(md|markdown|txt)$/i.test(path))) return 1
      return 2
    }
    items.sort((a, b) => rankCodeChange(a) - rankCodeChange(b))
    const stale = settled.some(result => result.status === 'fulfilled' && result.value.stale)
    const errors = settled.flatMap(result => result.status === 'rejected' ? [(result.reason as Error).message] : [])
    res.json({ sessionId: session.id, cfCallIds: lookupList.map(lookup => lookup.cfCallId), items, stale, errors })
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions/:id/snapshot', async (req, res, next) => {
  try {
    const session = await prisma.blueprintSession.findUnique({ where: { id: req.params.id } })
    if (!session) throw new NotFoundError('BlueprintSession', req.params.id)
    assertBlueprintAccess(session, req.user!.userId)

    let result: SnapshotResult
    try {
      result = session.sourceType === BlueprintSourceType.LOCALDIR
        ? await snapshotLocalDir(session.sourceUri, jsonStrings(session.includeGlobs), jsonStrings(session.excludeGlobs))
        : await snapshotGithub(session.sourceUri, session.sourceRef ?? undefined, jsonStrings(session.includeGlobs), jsonStrings(session.excludeGlobs))
    } catch (err) {
      const failed = await prisma.blueprintSourceSnapshot.create({
        data: {
          sessionId: session.id,
          status: 'FAILED',
          error: (err as Error).message,
          manifest: [],
          summary: { error: (err as Error).message },
        },
      })
      await prisma.blueprintSession.update({ where: { id: session.id }, data: { status: BlueprintSessionStatus.FAILED } })
      await recordBlueprintAudit(session.id, 'BlueprintSnapshotFailed', req.user!.userId, {
        sessionId: session.id,
        error: (err as Error).message,
      })
      return res.status(422).json({ snapshot: failed, error: (err as Error).message })
    }

    const snapshot = await prisma.blueprintSourceSnapshot.create({
      data: {
        sessionId: session.id,
        manifest: result.manifest as unknown as Prisma.InputJsonValue,
        summary: result.summary as Prisma.InputJsonValue,
        fileCount: result.fileCount,
        totalBytes: result.totalBytes,
        rootHash: result.rootHash,
      },
    })
    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: { status: BlueprintSessionStatus.SNAPSHOTTED },
    })
    await recordBlueprintAudit(session.id, 'BlueprintSourceSnapshotted', req.user!.userId, {
      snapshotId: snapshot.id,
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes,
    })
    res.status(201).json(await loadSession(session.id, req.user!.userId))
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions/:id/run', async (req, res, next) => {
  try {
    const session = await prisma.blueprintSession.findUnique({
      where: { id: req.params.id },
      include: {
        snapshots: { orderBy: { createdAt: 'desc' }, take: 1 },
        artifacts: { orderBy: { createdAt: 'asc' } },
      },
    })
    if (!session) throw new NotFoundError('BlueprintSession', req.params.id)
    assertBlueprintAccess(session, req.user!.userId)
    const snapshot = session.snapshots[0]
    if (!snapshot || snapshot.status !== 'COMPLETED') {
      throw new ValidationError('Create a successful source snapshot before running the workbench agents')
    }

    await prisma.blueprintSession.update({ where: { id: session.id }, data: { status: BlueprintSessionStatus.RUNNING } })

    // M36.2 — Resolve each stage's task body + system-prompt fragment from
    // prompt-composer (StagePromptBinding). Replaces the inline architectTask
    // / developerTask / qaTask / stageSystemPrompt functions. Prompt text now
    // lives in singularity_composer DB; edit via seed.ts and re-seed to roll
    // forward without redeploying workgraph-api.
    const resolved = await Promise.all([
      promptComposerClient.resolveStage({
        stageKey: 'blueprint.architect',
        vars: { goal: session.goal },
      }),
      promptComposerClient.resolveStage({
        stageKey: 'blueprint.developer',
        vars: { goal: session.goal },
      }),
      promptComposerClient.resolveStage({
        stageKey: 'blueprint.qa',
        vars: { goal: session.goal },
      }),
    ])

    const stages: Array<{
      stage: BlueprintStage;
      agentTemplateId: string;
      task: string;
      systemPromptAppend: string;
    }> = [
      {
        stage: BlueprintStage.ARCHITECT,
        agentTemplateId: session.architectAgentTemplateId,
        task: resolved[0].task,
        systemPromptAppend: resolved[0].systemPromptAppend,
      },
      {
        stage: BlueprintStage.DEVELOPER,
        agentTemplateId: session.developerAgentTemplateId,
        task: resolved[1].task,
        systemPromptAppend: resolved[1].systemPromptAppend,
      },
      {
        stage: BlueprintStage.QA,
        agentTemplateId: session.qaAgentTemplateId,
        task: resolved[2].task,
        systemPromptAppend: resolved[2].systemPromptAppend,
      },
    ]

    const queuedRuns = new Map<BlueprintStage, string>()
    for (const stage of stages) {
      const created = await prisma.blueprintStageRun.create({
        data: {
          sessionId: session.id,
          stage: stage.stage,
          status: BlueprintStageStatus.PENDING,
          task: stage.task,
        },
      })
      queuedRuns.set(stage.stage, created.id)
    }

    let failed = false
    for (const stage of stages) {
      const runId = queuedRuns.get(stage.stage)
      if (!runId) throw new ValidationError(`Missing queued run for stage ${stage.stage}`)
      await prisma.blueprintStageRun.update({
        where: { id: runId },
        data: { status: BlueprintStageStatus.RUNNING, startedAt: new Date() },
      })
      try {
        const result = await runStage(session, snapshot, stage.stage, stage.agentTemplateId, stage.task, stage.systemPromptAppend)
        await recordBlueprintBudgetUsage(session, result, stage.stage.toLowerCase())
        await prisma.blueprintStageRun.update({
          where: { id: runId },
          data: {
            status: result.status === 'FAILED' ? BlueprintStageStatus.FAILED : BlueprintStageStatus.COMPLETED,
            response: result.finalResponse ?? '',
            correlation: result.correlation as unknown as Prisma.InputJsonValue,
            tokensUsed: result.tokensUsed as unknown as Prisma.InputJsonValue,
            completedAt: new Date(),
            error: result.status === 'FAILED' ? result.finishReason ?? 'stage failed' : null,
          },
        })
        await createStageArtifacts(session, snapshot, stage.stage, result)
        if (result.status === 'FAILED') {
          failed = true
          break
        }
      } catch (err) {
        const message = err instanceof ContextFabricError
          ? `context-fabric error (${err.status}): ${err.message}`
          : (err as Error).message
        await prisma.blueprintStageRun.update({
          where: { id: runId },
          data: {
            status: BlueprintStageStatus.FAILED,
            error: message,
            completedAt: new Date(),
          },
        })
        await prisma.blueprintArtifact.create({
          data: {
            sessionId: session.id,
            stage: stage.stage,
            kind: 'stage_error',
            title: `${humanStage(stage.stage)} error`,
            content: message,
          },
        })
        failed = true
        break
      }
    }

    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: { status: failed ? BlueprintSessionStatus.FAILED : BlueprintSessionStatus.COMPLETED },
    })
    await recordBlueprintAudit(session.id, failed ? 'BlueprintRunFailed' : 'BlueprintRunCompleted', req.user!.userId, {
      sessionId: session.id,
    })
    res.json(await loadSession(session.id, req.user!.userId))
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions/:id/stages/:stageKey/run', async (req, res, next) => {
  try {
    const params = stageActionParamsSchema.parse(req.params)
    const updated = await runLoopStage(params.id, params.stageKey, req.user!.userId)
    res.json(updated)
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions/:id/stages/:stageKey/approval', validate(stageApprovalSchema), async (req, res, next) => {
  try {
    const params = stageActionParamsSchema.parse(req.params)
    const updated = await resumeLoopStageApproval(params.id, params.stageKey, req.body as StageApprovalInput, req.user!.userId)
    res.json(updated)
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions/:id/stages/:stageKey/verdict', validate(verdictSchema), async (req, res, next) => {
  try {
    const params = stageActionParamsSchema.parse(req.params)
    const body = req.body as z.infer<typeof verdictSchema>
    const updated = await saveStageVerdict(params.id, params.stageKey, body, req.user!.userId)
    res.json(updated)
  } catch (err) { next(err) }
})

// M82 S1 (2026-05-26) — operator overwrites an artifact body before
// approval. Refused unless the artifact's kind is declared with
// editable=true on at least one stage's expectedArtifacts in the
// session's loopDefinition. Previous content is preserved in
// payload.revisions for audit + rollback; an audit event captures
// the actor, reason, and length delta.
blueprintRouter.patch('/sessions/:id/artifacts/:artifactId', validate(editArtifactSchema), async (req, res, next) => {
  try {
    const params = artifactActionParamsSchema.parse(req.params)
    const body = req.body as z.infer<typeof editArtifactSchema>
    const updated = await editArtifactContent(params.id, params.artifactId, body, req.user!.userId)
    res.json(updated)
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions/:id/stages/:stageKey/send-back', validate(sendBackSchema), async (req, res, next) => {
  try {
    const params = stageActionParamsSchema.parse(req.params)
    const body = req.body as z.infer<typeof sendBackSchema>
    const updated = await sendStageBack(params.id, params.stageKey, body, req.user!.userId)
    res.json(updated)
  } catch (err) { next(err) }
})

// M78 Slice 3 — Create a remediation work item from an inherited test
// failure. Triggered by the workbench's InheritedFailureCard "Create
// remediation WI →" button.  Each failure spawns its own WI so the
// operator can choose which subset of inherited failures actually
// needs fixing right now versus deferring.
const inheritedFailurePayloadSchema = z.object({
  test: z.string().min(1),
  file: z.string().min(1),
  exception: z.string().optional(),
  exceptionLine: z.number().int().positive().optional(),
  hint: z.string().optional(),
})
const createRemediationSchema = z.object({
  failure: inheritedFailurePayloadSchema,
  originAttemptId: z.string().optional(),
  // Optional override; defaults to the inferred title built from the failure.
  titleOverride: z.string().min(1).max(180).optional(),
  // When omitted, the new WI targets the session's parent capability
  // (most common: remediation lives in the same capability that
  // surfaced the failure). Override only when the operator knows the
  // bug actually lives in a different capability's repo.
  targetCapabilityId: z.string().optional(),
})

blueprintRouter.post(
  '/sessions/:id/stages/:stageKey/inherited-failure/remediate',
  validate(createRemediationSchema),
  async (req, res, next) => {
    try {
      const params = stageActionParamsSchema.parse(req.params)
      const body = req.body as z.infer<typeof createRemediationSchema>
      const created = await createInheritedFailureRemediation(
        params.id, params.stageKey, body, req.user!.userId,
      )
      res.status(201).json(created)
    } catch (err) { next(err) }
  },
)

blueprintRouter.post('/sessions/:id/finalize', async (req, res, next) => {
  try {
    const updated = await finalizeLoop(req.params.id, req.user!.userId)
    res.json(updated)
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions/:id/approve', async (req, res, next) => {
  try {
    const session = await prisma.blueprintSession.findUnique({
      where: { id: req.params.id },
      include: { stageRuns: { orderBy: { createdAt: 'desc' } } },
    })
    if (!session) throw new NotFoundError('BlueprintSession', req.params.id)
    assertBlueprintAccess(session, req.user!.userId)
    const completed = new Set(
      session.stageRuns
        .filter(r => r.status === BlueprintStageStatus.COMPLETED)
        .map(r => r.stage),
    )
    for (const stage of [BlueprintStage.ARCHITECT, BlueprintStage.DEVELOPER, BlueprintStage.QA]) {
      if (!completed.has(stage)) throw new ValidationError(`Cannot approve until ${humanStage(stage)} is completed`)
    }
    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: {
        status: BlueprintSessionStatus.APPROVED,
        approvedById: req.user!.userId,
        approvedAt: new Date(),
      },
    })
    await prisma.blueprintArtifact.create({
      data: {
        sessionId: session.id,
        kind: 'approval_receipt',
        title: 'Blueprint approval receipt',
        payload: {
          approvedById: req.user!.userId,
          approvedAt: new Date().toISOString(),
          requiredStages: ['ARCHITECT', 'DEVELOPER', 'QA'],
        } as Prisma.InputJsonValue,
      },
    })
    await recordBlueprintAudit(session.id, 'BlueprintApproved', req.user!.userId, { sessionId: session.id })
    res.json(await loadSession(session.id, req.user!.userId))
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions/:id/decision-answers', validate(saveDecisionAnswersSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof saveDecisionAnswersSchema>
    const sessionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
    const session = await prisma.blueprintSession.findUnique({ where: { id: sessionId } })
    if (!session) throw new NotFoundError('BlueprintSession', sessionId)
    assertBlueprintAccess(session, req.user!.userId)

    const metadata = isRecord(session.metadata) ? session.metadata : {}
    const updatedAt = new Date().toISOString()
    const decisionAnswers = body.answers.map(answer => ({
        questionId: answer.questionId,
        questionText: answer.questionText?.trim() || undefined,
        normalizedQuestion: answer.normalizedQuestion?.trim() || normalizeQuestionText(answer.questionText),
        answerType: answer.answerType,
        selectedOptionLabel: answer.selectedOptionLabel?.trim() || undefined,
        selectedOptionLabels: answer.selectedOptionLabels?.map(label => label.trim()).filter(Boolean) ?? undefined,
        customAnswer: answer.customAnswer?.trim() || undefined,
        notes: answer.notes?.trim() || undefined,
        updatedAt,
        updatedById: req.user!.userId,
    }))
    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: {
        metadata: {
          ...metadata,
          decisionAnswers,
          decisionAnswersUpdatedAt: updatedAt,
        } as Prisma.InputJsonValue,
      },
    })

    const snapshot = await prisma.blueprintSourceSnapshot.findFirst({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'desc' },
    })
    if (snapshot?.status === 'COMPLETED') {
      const ctx = buildSnapshotContext(snapshot as ArtifactSnapshot)
      await prisma.blueprintArtifact.createMany({
        data: [
          {
            sessionId: session.id,
            kind: 'stakeholder_answers',
            title: 'Stakeholder answers',
            content: buildStakeholderAnswersMarkdown(decisionAnswers),
            payload: { answers: decisionAnswers } as Prisma.InputJsonValue,
          },
          {
            sessionId: session.id,
            stage: BlueprintStage.QA,
            kind: 'implementation_contract',
            title: 'Implementation contract',
            content: buildImplementationContractMarkdown(session, ctx, decisionAnswers),
            payload: { contract: buildImplementationContractPayload(session, ctx, decisionAnswers) } as Prisma.InputJsonValue,
          },
        ],
      })
    }

    await recordBlueprintAudit(session.id, 'BlueprintDecisionAnswersSaved', req.user!.userId, {
      answerCount: body.answers.length,
      normalizedQuestions: decisionAnswers.map(answer => answer.normalizedQuestion).filter(Boolean),
    })
    res.json(await loadSession(session.id, req.user!.userId))
  } catch (err) { next(err) }
})

// M41.2 — Stage Chat: list the operator/agent thread for a stage.
// The thread persists across stage navigation and feeds back into the
// next attempt via {{operatorChat}}.
blueprintRouter.get('/sessions/:id/stages/:stageKey/messages', async (req, res, next) => {
  try {
    const params = stageActionParamsSchema.parse(req.params)
    const session = await prisma.blueprintSession.findUnique({ where: { id: params.id } })
    if (!session) throw new NotFoundError('BlueprintSession', params.id)
    assertBlueprintAccess(session, req.user!.userId)
    res.json({ items: readStageChatThread(session.metadata, params.stageKey) })
  } catch (err) { next(err) }
})

// M41.2 — Stage Chat: append a message. We cap each stage's thread at
// 200 messages on the write path so a runaway transcript can't bloat
// session.metadata indefinitely.
const STAGE_CHAT_THREAD_CAP = 200

blueprintRouter.post(
  '/sessions/:id/stages/:stageKey/messages',
  validate(stageChatMessageSchema),
  async (req, res, next) => {
    try {
      const params = stageActionParamsSchema.parse(req.params)
      const body = req.body as z.infer<typeof stageChatMessageSchema>
      const session = await prisma.blueprintSession.findUnique({ where: { id: params.id } })
      if (!session) throw new NotFoundError('BlueprintSession', params.id)
      assertBlueprintAccess(session, req.user!.userId)

      const metadata = isRecord(session.metadata) ? session.metadata : {}
      const stageChats = readStageChats(metadata)
      const existing = stageChats[params.stageKey] ?? []
      const message: StageChatMessage = {
        id: crypto.randomUUID(),
        role: body.role ?? 'operator',
        content: body.content.trim(),
        createdAt: new Date().toISOString(),
        authorId: req.user!.userId,
      }
      const nextThread = [...existing, message]
      // Ring buffer — drop oldest if over cap so older guidance is shed first.
      const capped = nextThread.length > STAGE_CHAT_THREAD_CAP
        ? nextThread.slice(nextThread.length - STAGE_CHAT_THREAD_CAP)
        : nextThread

      await prisma.blueprintSession.update({
        where: { id: session.id },
        data: {
          metadata: {
            ...metadata,
            stageChats: { ...stageChats, [params.stageKey]: capped },
          } as unknown as Prisma.InputJsonValue,
        },
      })

      await recordBlueprintAudit(session.id, 'BlueprintStageChatMessage', req.user!.userId, {
        stageKey: params.stageKey,
        messageId: message.id,
        role: message.role,
        contentLen: message.content.length,
      })

      res.json({ message, thread: capped })
    } catch (err) { next(err) }
  },
)

async function loadSession(id: string, actorId?: string) {
  const session = await prisma.blueprintSession.findUnique({
    where: { id },
    include: {
      snapshots: { orderBy: { createdAt: 'desc' } },
      stageRuns: { orderBy: { createdAt: 'asc' } },
      artifacts: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!session) throw new NotFoundError('BlueprintSession', id)
  if (actorId) assertBlueprintAccess(session, actorId)
  return shapeSession(session)
}

function assertBlueprintAccess(session: { id: string; createdById?: string | null }, actorId: string) {
  // Deny-by-default for unowned sessions. Previously `!session.createdById`
  // returned (granted) — meaning a session with a null/empty createdById was
  // reachable by ANY authenticated user, widening every session-scoped route
  // (incl. the worktree/api-call surfaces) to cross-user access. A session
  // with no owner is treated as not-yours.
  if (session.createdById && session.createdById === actorId) return
  throw new NotFoundError('BlueprintSession', session.id)
}

// ── Server-side stage-policy enforcement for the workbench worktree /
// api-call / run-test / verification routes ─────────────────────────────────
// The workbench UI hides edit/test/api affordances by the active stage's
// toolPolicy (canEdit = MUTATION; canRunTools = MUTATION||VERIFICATION) and
// hides repo browsing when repoAccess is off. Those are CLIENT-SIDE only —
// without these server guards a user with session access could call the
// endpoints directly during STORY_ONLY / READ_ONLY / review stages. We resolve
// the active stage server-side (currentStageKey, or an explicit ?stageKey /
// body.stageKey override that must match a real stage) and enforce the same
// policy the UI derives. Deny-by-default: if the stage can't be resolved, the
// action is refused.
function resolveActiveStage(
  session: LoopSessionSeed,
  requestedStageKey?: unknown,
): LoopStageDefinition {
  const state = readLoopState(session)
  const wanted = typeof requestedStageKey === 'string' && requestedStageKey.trim()
    ? requestedStageKey.trim()
    : state.currentStageKey
  if (!wanted) {
    throw new ForbiddenError('No active stage on this session; action refused by stage policy')
  }
  const stage = state.loopDefinition.stages.find(s => s.key === wanted || s.key === slug(wanted))
  if (!stage) {
    throw new ForbiddenError(`Unknown Workbench stage '${String(wanted)}'; action refused by stage policy`)
  }
  return stage
}

// Pure stage-policy decision, exported for unit tests. Returns null when the
// action is allowed, or a human-readable refusal reason. Mirrors the UI's
// canEdit / canRunTools / repo-browse derivation so server enforcement and the
// client affordances can't drift. Kept pure (no session/IO) so it's testable
// in isolation, per the router-test convention (see curation.router tests).
export type WorkbenchStageAction = 'repoRead' | 'mutation' | 'toolRun'

export function stageActionRefusalReason(
  stage: Pick<LoopStageDefinition, 'key' | 'contextPolicy' | 'toolPolicy' | 'repoAccess'>,
  action: WorkbenchStageAction,
): string | null {
  if (action === 'repoRead') {
    return stageUsesRepoContext(stage as LoopStageDefinition)
      ? null
      : `Stage '${stage.key}' does not have repo access (contextPolicy=${stage.contextPolicy}, toolPolicy=${stage.toolPolicy}); code browsing is not permitted on this stage`
  }
  if (action === 'mutation') {
    return stage.toolPolicy === 'MUTATION'
      ? null
      : `Stage '${stage.key}' is not a mutation stage (toolPolicy=${stage.toolPolicy}); editing files is not permitted on this stage`
  }
  // toolRun
  return stage.toolPolicy === 'MUTATION' || stage.toolPolicy === 'VERIFICATION'
    ? null
    : `Stage '${stage.key}' does not permit tool execution (toolPolicy=${stage.toolPolicy}); running tests / API calls is not permitted on this stage`
}

function assertStageAction(session: LoopSessionSeed, action: WorkbenchStageAction, requestedStageKey?: unknown): void {
  const stage = resolveActiveStage(session, requestedStageKey)
  const refusal = stageActionRefusalReason(stage, action)
  if (refusal) throw new ForbiddenError(refusal)
}

function assertStageRepoRead(session: LoopSessionSeed, requestedStageKey?: unknown): void {
  assertStageAction(session, 'repoRead', requestedStageKey)
}

function assertStageMutation(session: LoopSessionSeed, requestedStageKey?: unknown): void {
  assertStageAction(session, 'mutation', requestedStageKey)
}

function assertStageToolRun(session: LoopSessionSeed, requestedStageKey?: unknown): void {
  assertStageAction(session, 'toolRun', requestedStageKey)
}

async function recordBlueprintAudit(
  sessionId: string,
  eventType: string,
  actorId: string,
  payload: Record<string, unknown> = {},
) {
  await logEvent(eventType, 'BlueprintSession', sessionId, actorId, { sessionId, actorId, ...payload })
  await publishOutbox('BlueprintSession', sessionId, eventType, { sessionId, actorId, ...payload })
}

type LoopSessionSeed = {
  id?: string
  goal: string
  architectAgentTemplateId?: string | null
  developerAgentTemplateId?: string | null
  qaAgentTemplateId?: string | null
  metadata?: Prisma.JsonValue
  workflowInstanceId?: string | null
  phaseId?: string | null
}

type AgentTemplateSeed = {
  architectAgentTemplateId?: string | null
  developerAgentTemplateId?: string | null
  qaAgentTemplateId?: string | null
}

type ResolvedAgentTemplateSeed = {
  architectAgentTemplateId: string
  developerAgentTemplateId: string
  qaAgentTemplateId: string
}

function shapeSession<T extends LoopSessionSeed & { artifacts?: Array<{ payload?: Prisma.JsonValue | null }> }>(session: T) {
  const loop = readLoopState(session)
  return {
    ...session,
    browserRunId: loop.browserRunId,
    workflowNodeId: loop.workflowNodeId,
    gateMode: loop.gateMode,
    loopDefinition: loop.loopDefinition,
    currentStageKey: loop.currentStageKey,
    stageAttempts: loop.stageAttempts,
    reviewEvents: loop.reviewEvents,
    decisionAnswers: loop.decisionAnswers,
    // M41.2 — surface the stage chat threads so the workbench SPA can
    // render the docked Stage Chat without an extra fetch.
    stageChats: readStageChats(session.metadata),
    finalPack: loop.finalPack,
    executionConfig: loop.executionConfig,
    // Milestones — surface the milestone cursor/plan so the SPA can render the
    // MilestoneRail. Omitted entirely for legacy/non-milestone sessions.
    milestone: loop.milestone,
    artifacts: session.artifacts?.map(shapeArtifact) ?? [],
  }
}

function shapeArtifact<T extends { payload?: Prisma.JsonValue | null }>(artifact: T) {
  const payload = isRecord(artifact.payload) ? artifact.payload : {}
  const consumable = readConsumableRefFromPayload({ ...(artifact as Record<string, unknown>), payload })
  const consumablePublish = isRecord(payload.consumablePublish) ? payload.consumablePublish : undefined
  return {
    ...artifact,
    stageKey: typeof payload.stageKey === 'string' ? payload.stageKey : undefined,
    attemptId: typeof payload.attemptId === 'string' ? payload.attemptId : undefined,
    version: typeof payload.version === 'number' ? payload.version : undefined,
    consumableId: consumable?.consumableId,
    consumableVersion: consumable?.consumableVersion,
    consumableStatus: consumable?.status,
    consumablePublish,
  }
}

async function resolveWorkflowLink(
  workflowInstanceId?: string | null,
  workflowNodeId?: string | null,
): Promise<WorkflowLinkResolution> {
  const instanceId = typeof workflowInstanceId === 'string' && workflowInstanceId.trim()
    ? workflowInstanceId.trim()
    : undefined
  const nodeId = typeof workflowNodeId === 'string' && workflowNodeId.trim()
    ? workflowNodeId.trim()
    : undefined
  if (!instanceId) return { workflowNodeId: nodeId }

  const instance = await prisma.workflowInstance.findUnique({
    where: { id: instanceId },
    select: nodeId
      ? { id: true, nodes: { where: { id: nodeId }, select: { id: true }, take: 1 } }
      : { id: true },
  })
  if (!instance) {
    const browserRun = await prisma.runSnapshot.findUnique({
      where: { runId: instanceId },
      select: { runId: true },
    })
    if (browserRun) {
      return {
        browserRunId: browserRun.runId,
        workflowNodeId: nodeId,
        warning: {
          reason: 'browser_run_snapshot',
          message: `Workflow run ${instanceId} is a browser-player run snapshot, not a server workflow instance. Workbench will stay linked to this browser run and auto-return to the player, but workflow consumables will not be published.`,
          browserRunId: browserRun.runId,
          workflowNodeId: nodeId,
          suggestedFix: 'Use a server workflow run when you need Workgraph consumables, or continue in browser-run mode for local guided delivery.',
        },
      }
    }
    if (nodeId) {
      const node = await prisma.workflowNode.findUnique({
        where: { id: nodeId },
        select: { id: true, instanceId: true },
      })
      if (node) {
        return {
          workflowInstanceId: node.instanceId,
          workflowNodeId: node.id,
          warning: {
            reason: 'workflow_link_repaired',
            message: `Workflow run ${instanceId} was not found, but node ${nodeId} belongs to active run ${node.instanceId}. Workbench relinked to that run so workflow consumables can still be published.`,
            workflowInstanceId: node.instanceId,
            workflowNodeId: node.id,
            originalWorkflowInstanceId: instanceId,
            suggestedFix: 'Refresh the Workbench URL from the active workflow run to remove the stale workflowInstanceId.',
          },
        }
      }
    }
    return {
      workflowNodeId: undefined,
      warning: {
        reason: 'workflow_instance_not_found',
        message: `Workflow run ${instanceId} was not found. Workbench will continue standalone and will not publish workflow consumables.`,
        workflowInstanceId: instanceId,
        workflowNodeId: nodeId,
        suggestedFix: 'Open the Workbench from an active workflow run/task so the URL contains a valid workflowInstanceId.',
      },
    }
  }

  const nodes = Array.isArray((instance as { nodes?: unknown }).nodes)
    ? (instance as { nodes?: Array<{ id: string }> }).nodes ?? []
    : []
  if (nodeId && nodes.length === 0) {
    return {
      workflowInstanceId: instanceId,
      workflowNodeId: nodeId,
      warning: {
        reason: 'workflow_node_not_found',
        message: `Workflow node ${nodeId} was not found on run ${instanceId}. Consumables will still attach to the run but may not appear under the expected node.`,
        workflowInstanceId: instanceId,
        workflowNodeId: nodeId,
        suggestedFix: 'Reopen the Workbench from the active Workbench Task so the workflowNodeId matches the runtime node.',
      },
    }
  }

  return { workflowInstanceId: instanceId, workflowNodeId: nodeId }
}

async function resolveWorkbenchGovernanceMode(workflowInstanceId?: string | null): Promise<GovernanceMode> {
  const instanceId = typeof workflowInstanceId === 'string' && workflowInstanceId.trim()
    ? workflowInstanceId.trim()
    : undefined
  if (!instanceId) return 'fail_open'

  const instance = await prisma.workflowInstance.findUnique({
    where: { id: instanceId },
    select: {
      template: {
        select: {
          status: true,
          metadata: true,
          budgetPolicy: true,
        },
      },
    },
  })
  const template = instance?.template
  const policy = isRecord(template?.budgetPolicy) ? template.budgetPolicy : {}
  const policyMode = policy.governanceMode
  if (isGovernanceMode(policyMode)) return policyMode

  const metadata = isRecord(template?.metadata) ? template.metadata : {}
  const criticality = String(metadata.criticality ?? metadata.risk ?? '').toUpperCase()
  const dataSensitivity = String(metadata.dataSensitivity ?? '').toUpperCase()
  const workflowType = String(metadata.workflowType ?? '').toUpperCase()
  if (workflowType === 'COMPLIANCE' || dataSensitivity === 'RESTRICTED') return 'fail_closed'
  if (criticality === 'HIGH' || criticality === 'CRITICAL' || criticality === 'SOX' || criticality === 'PCI') {
    return 'human_approval_required'
  }
  if (template?.status && template.status !== 'DRAFT') return 'human_approval_required'
  return 'fail_open'
}

function isGovernanceMode(value: unknown): value is GovernanceMode {
  return typeof value === 'string' && (GOVERNANCE_MODES as readonly string[]).includes(value)
}

// M66 — Append verification receipts from a just-completed stage to the
// session-level rolling history. Called right after every runCodingStage /
// resumeCodingStage so the next stage's runLoopStageExecute can read them
// and thread into prior_verification_receipts. De-duplicates by
// {command, exit_code, passed} so back-to-back stage runs against the same
// session don't double-count when nothing new ran. Caps at 100 entries
// (matches readLoopState's slice) so unbounded sessions don't blow up
// metadata size.
async function appendVerificationReceiptsToSession(
  sessionId: string,
  newReceipts: ReadonlyArray<Record<string, unknown>> | undefined | null,
): Promise<void> {
  if (!newReceipts || newReceipts.length === 0) return
  const session = await prisma.blueprintSession.findUnique({ where: { id: sessionId } })
  if (!session) return
  const metadata = isRecord(session.metadata) ? session.metadata : {}
  const existing = Array.isArray(metadata.verificationReceiptHistory)
    ? (metadata.verificationReceiptHistory as unknown[])
        .filter((r): r is Record<string, unknown> => isRecord(r))
    : []
  // Build a dedupe key — receipts carry an id when mcp-server enriched them;
  // fall back to the command+exit+passed triple. Two stage runs of the same
  // test should appear once, not twice, so policy lookups stay stable.
  const keyFor = (r: Record<string, unknown>): string => {
    if (typeof r.id === 'string' && r.id) return `id:${r.id}`
    if (typeof r.toolInvocationId === 'string' && r.toolInvocationId) return `tii:${r.toolInvocationId}`
    return JSON.stringify({
      command: r.command,
      exit: r.exit_code ?? r.exitCode,
      passed: r.passed,
    })
  }
  const seen = new Set(existing.map(keyFor))
  for (const r of newReceipts) {
    const key = keyFor(r)
    if (seen.has(key)) continue
    seen.add(key)
    existing.push(r)
  }
  const trimmed = existing.slice(-100)
  await prisma.blueprintSession.update({
    where: { id: sessionId },
    data: {
      metadata: {
        ...metadata,
        verificationReceiptHistory: trimmed,
      } as Prisma.InputJsonValue,
    },
  })
}

// ── Milestones: decomposition (P2) ──────────────────────────────────────────
const MILESTONE_PLAN_INSTRUCTIONS = [
  'MILESTONES MODE — decompose this big goal into an ordered series of milestones.',
  'Produce a `milestone_plan` artifact (format JSON) with EXACTLY this shape:',
  '{ "version": 1, "milestones": [ { "id": "M1", "title": "short title", "subGoal": "what this milestone implements", "acceptanceCriteria": ["criterion", ...], "dependsOn": [] }, ... ] }',
  'Rules: ids are M1, M2, … in order; each milestone builds on the previous, so dependsOn lists only EARLIER ids (no cycles, no self-refs); 2–8 milestones; each subGoal must be independently implementable AND verifiable on the shared branch.',
].join('\n')

const milestoneInputSchema = z.object({
  id: z.string().trim().min(1).max(40),
  title: z.string().trim().min(3).max(200),
  subGoal: z.string().trim().min(8).max(4000),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1).max(20),
  dependsOn: z.array(z.string().trim()).max(20).default([]),
  estimate: z.string().trim().max(80).optional(),
})
const milestonePlanInputSchema = z.object({
  version: z.literal(1).optional(),
  milestones: z.array(milestoneInputSchema).min(1).max(20),
})

// Parse + validate a milestone_plan artifact body into an ordered Milestone[].
// Topo-sorts by dependsOn; rejects dup ids, unknown/self refs, and cycles.
// Returns null on any failure (caller leaves the cursor unset). Tolerates a
// ```json fenced body. All milestones come back PENDING; applyMilestonePlan
// marks the first ACTIVE.
function parseMilestonePlan(raw: unknown): Milestone[] | null {
  let obj: unknown = raw
  if (typeof raw === 'string') {
    const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    try { obj = JSON.parse(stripped) } catch { return null }
  }
  const parsed = milestonePlanInputSchema.safeParse(obj)
  if (!parsed.success) return null
  const ms = parsed.data.milestones
  const ids = new Set(ms.map(m => m.id))
  if (ids.size !== ms.length) return null
  for (const m of ms) for (const d of m.dependsOn) if (!ids.has(d) || d === m.id) return null
  const byId = new Map(ms.map(m => [m.id, m]))
  const indeg = new Map(ms.map(m => [m.id, m.dependsOn.length]))
  const queue = ms.filter(m => (indeg.get(m.id) ?? 0) === 0).map(m => m.id)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift() as string
    order.push(id)
    for (const m of ms) {
      if (!m.dependsOn.includes(id)) continue
      const n = (indeg.get(m.id) ?? 0) - 1
      indeg.set(m.id, n)
      if (n === 0) queue.push(m.id)
    }
  }
  if (order.length !== ms.length) return null
  return order.map((id): Milestone => {
    const m = byId.get(id) as z.infer<typeof milestoneInputSchema>
    return {
      id: m.id, title: m.title, subGoal: m.subGoal,
      acceptanceCriteria: m.acceptanceCriteria, dependsOn: m.dependsOn,
      status: 'PENDING', estimate: m.estimate,
    }
  })
}

// Populate the cursor from a parsed plan: marks the first milestone ACTIVE and
// sets currentMilestoneId. No-op when milestones aren't enabled.
function applyMilestonePlan(state: LoopState, milestones: Milestone[]): LoopState {
  if (!state.milestone?.enabled || milestones.length === 0) return state
  const plan = milestones.map((m, i): Milestone => ({ ...m, status: i === 0 ? 'ACTIVE' : 'PENDING' }))
  return { ...state, milestone: { ...state.milestone, plan, currentMilestoneId: plan[0].id } }
}

// Inject the milestone_plan expected artifact into the architect/design stage
// (the stage right before the first DEVELOPER stage) so the architect produces
// it and the stage gate enforces it. Idempotent.
function withMilestonePlanArtifact(loopDef: LoopDefinition): LoopDefinition {
  const devIdx = loopDef.stages.findIndex(s => (s.agentRole ?? '').toUpperCase() === 'DEVELOPER')
  const targetIdx = devIdx > 0 ? devIdx - 1 : Math.max(0, loopDef.stages.length - 1)
  const stages = loopDef.stages.map((stage, i) => {
    if (i !== targetIdx) return stage
    const existing = stage.expectedArtifacts ?? []
    if (existing.some(a => a.kind === 'milestone_plan')) return stage
    return {
      ...stage,
      expectedArtifacts: [
        ...existing,
        {
          kind: 'milestone_plan', title: 'Milestone plan',
          description: MILESTONE_PLAN_INSTRUCTIONS,
          required: true, format: 'JSON' as const, editable: true,
        },
      ],
    }
  })
  return { ...loopDef, stages }
}

// Load + parse the latest milestone_plan artifact for a session (null if none
// or unparseable). Used to ingest the architect's decomposition into the cursor.
async function loadLatestMilestonePlan(sessionId: string): Promise<Milestone[] | null> {
  const artifact = await prisma.blueprintArtifact.findFirst({
    where: { sessionId, kind: 'milestone_plan' },
    orderBy: { createdAt: 'desc' },
  })
  if (!artifact?.content) return null
  return parseMilestonePlan(artifact.content)
}

// Milestones — defensive parse of the persisted milestone state. Returns
// undefined for legacy sessions (no `milestone` key) so they behave unchanged.
function readMilestoneState(value: unknown): MilestoneState | undefined {
  if (!isRecord(value)) return undefined
  const plan: Milestone[] = (Array.isArray(value.plan) ? value.plan : [])
    .filter(isRecord)
    .map((m): Milestone | null => {
      const id = typeof m.id === 'string' ? m.id.trim() : ''
      if (!id) return null
      return {
        id,
        title: typeof m.title === 'string' ? m.title : id,
        subGoal: typeof m.subGoal === 'string' ? m.subGoal : '',
        acceptanceCriteria: Array.isArray(m.acceptanceCriteria)
          ? m.acceptanceCriteria.filter((s): s is string => typeof s === 'string')
          : [],
        dependsOn: Array.isArray(m.dependsOn)
          ? m.dependsOn.filter((s): s is string => typeof s === 'string')
          : [],
        status: m.status === 'ACTIVE' || m.status === 'COMPLETED' || m.status === 'SKIPPED' ? m.status : 'PENDING',
        estimate: typeof m.estimate === 'string' ? m.estimate : undefined,
      }
    })
    .filter((m): m is Milestone => m !== null)
  const history: MilestoneHistoryEntry[] = (Array.isArray(value.history) ? value.history : [])
    .filter(isRecord)
    .map((h): MilestoneHistoryEntry => ({
      milestoneId: typeof h.milestoneId === 'string' ? h.milestoneId : '',
      status: h.status === 'SKIPPED' ? 'SKIPPED' : 'COMPLETED',
      completedAt: typeof h.completedAt === 'string' ? h.completedAt : '',
      finalAttemptIdsByStage: isRecord(h.finalAttemptIdsByStage)
        ? Object.fromEntries(Object.entries(h.finalAttemptIdsByStage).filter(([, v]) => typeof v === 'string')) as Record<string, string>
        : {},
      commitShas: Array.isArray(h.commitShas) ? h.commitShas.filter((s): s is string => typeof s === 'string') : [],
    }))
    .filter(h => h.milestoneId)
  return {
    enabled: value.enabled === true,
    plan,
    currentMilestoneId: typeof value.currentMilestoneId === 'string' ? value.currentMilestoneId : null,
    history,
    planArtifactId: typeof value.planArtifactId === 'string' ? value.planArtifactId : undefined,
  }
}

function readLoopState(session: LoopSessionSeed): LoopState {
  const metadata = isRecord(session.metadata) ? session.metadata : {}
  const loopDefinition = normalizeLoopDefinition(metadata.loopDefinition, session)
  const currentStageKey = typeof metadata.currentStageKey === 'string'
    ? metadata.currentStageKey
    : loopDefinition.stages[0]?.key ?? null
  const decisionAnswers = enrichDecisionAnswers(
    readDecisionAnswers(metadata.decisionAnswers),
    loopDefinition,
  )
  return {
    workflowNodeId: typeof metadata.workflowNodeId === 'string' ? metadata.workflowNodeId : undefined,
    browserRunId: typeof metadata.browserRunId === 'string' ? metadata.browserRunId : undefined,
    gateMode: metadata.gateMode === 'auto' ? 'auto' : 'manual',
    loopDefinition,
    currentStageKey,
    stageAttempts: Array.isArray(metadata.stageAttempts) ? (metadata.stageAttempts as unknown[]).filter(isStageAttempt) : [],
    reviewEvents: Array.isArray(metadata.reviewEvents) ? (metadata.reviewEvents as unknown[]).filter(isReviewEvent) : [],
    decisionAnswers,
    finalPack: isFinalPack(metadata.finalPack) ? metadata.finalPack : undefined,
    // M66 — Read accumulated receipts from prior stages. Defensive: cast
    // through unknown and require each entry be a record. Caps growth at
    // 100 receipts to bound metadata size; stages running test commands
    // typically produce 1-3 receipts each, so 100 covers ~30 stages.
    verificationReceiptHistory: Array.isArray(metadata.verificationReceiptHistory)
      ? (metadata.verificationReceiptHistory as unknown[])
          .filter((r): r is Record<string, unknown> => isRecord(r))
          .slice(-100)
      : undefined,
    milestone: readMilestoneState(metadata.milestone),
    executionConfig: readExecutionConfig(metadata.executionConfig),
  }
}

function stateToMetadata(session: LoopSessionSeed, state: LoopState): Prisma.InputJsonValue {
  const current = isRecord(session.metadata) ? session.metadata : {}
  return {
    ...current,
    workflowNodeId: state.workflowNodeId,
    browserRunId: state.browserRunId,
    gateMode: state.gateMode,
    loopDefinition: state.loopDefinition,
    currentStageKey: state.currentStageKey,
    stageAttempts: state.stageAttempts,
    reviewEvents: state.reviewEvents,
    decisionAnswers: state.decisionAnswers,
    finalPack: state.finalPack,
    // M66 — Persist receipt history alongside the rest of loop state so
    // every subsequent stage's runLoopStageExecute can read it and pass
    // through to mcp-server's priorVerificationReceipts.
    verificationReceiptHistory: state.verificationReceiptHistory,
    milestone: state.milestone,
    executionConfig: state.executionConfig,
    decisionAnswersUpdatedAt: current.decisionAnswersUpdatedAt,
  } as Prisma.InputJsonValue
}

function sanitizeStageModelAliases(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (key.trim() && trimmed) out[key.trim()] = trimmed
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// M100 — sanitize the persisted per-stage, per-phase model alias map. Same
// trim/drop-empty discipline as sanitizeStageModelAliases, but nested and
// with the inner key whitelisted (upper-cased) to GOVERNED_PHASES. Used on
// both write (create/PATCH body) and read (metadata round-trip), so an
// invalid value persisted out-of-band can never reach the spawn path.
function sanitizeStagePhaseModelAliases(value: unknown): Record<string, Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, Record<string, string>> = {}
  for (const [stageKey, phaseMap] of Object.entries(value)) {
    if (!stageKey.trim() || !isRecord(phaseMap)) continue
    const inner: Record<string, string> = {}
    for (const [phase, raw] of Object.entries(phaseMap)) {
      if (typeof raw !== 'string') continue
      const trimmed = raw.trim()
      const phaseKey = phase.trim().toUpperCase()
      if (trimmed && (GOVERNED_PHASES as readonly string[]).includes(phaseKey)) inner[phaseKey] = trimmed
    }
    if (Object.keys(inner).length > 0) out[stageKey.trim()] = inner
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function readExecutionConfig(value: unknown): LoopState['executionConfig'] {
  if (!isRecord(value)) return undefined
  return {
    snapshotMode: value.snapshotMode === 'summary' || value.snapshotMode === 'full_debug' ? value.snapshotMode : 'relevant_excerpts',
    excerptBudgetChars: typeof value.excerptBudgetChars === 'number' ? value.excerptBudgetChars : undefined,
    reuseUnchangedAttempt: value.reuseUnchangedAttempt !== false,
    modelAlias: typeof value.modelAlias === 'string' && value.modelAlias.trim() ? value.modelAlias.trim() : undefined,
    stageModelAliases: sanitizeStageModelAliases(value.stageModelAliases),
    stagePhaseModelAliases: sanitizeStagePhaseModelAliases(value.stagePhaseModelAliases),
    governanceMode: ['fail_open', 'fail_closed', 'degraded', 'human_approval_required'].includes(String(value.governanceMode))
      ? value.governanceMode as NonNullable<LoopState['executionConfig']>['governanceMode']
      : 'fail_open',
    maxContextTokens: typeof value.maxContextTokens === 'number' ? value.maxContextTokens : undefined,
    maxOutputTokens: typeof value.maxOutputTokens === 'number' ? value.maxOutputTokens : undefined,
    maxPromptChars: typeof value.maxPromptChars === 'number' ? value.maxPromptChars : undefined,
    maxLayerChars: typeof value.maxLayerChars === 'number' ? value.maxLayerChars : undefined,
  }
}

// Minimum context budget enforced for any workbench loop. Set high enough that
// a developer agent can read 3-4 medium-size source files (≈2-3K tokens each)
// plus tool descriptors + system prompt without immediately triggering sliding-
// window compression. Sessions created before this minimum was raised still
// have their old (8K) value persisted in metadata.executionConfig; this floor
// transparently upgrades them so the user does not need to re-create the loop.
const MIN_WORKBENCH_CONTEXT_TOKENS = 24_000

// Minimum output budget. Below ~4K the model truncates write_file content
// arguments mid-emit, which manifests as content="" in the tool call → the
// agent writes empty files and retries in a loop until agent_loop_repetition
// kicks in. Sessions persisted with the old 800-token cap get clamped up.
const MIN_WORKBENCH_OUTPUT_TOKENS = 4_000

function workbenchExecutionLimits(executionConfig: LoopState['executionConfig']) {
  const persistedContextTokens = executionConfig?.maxContextTokens ?? DEFAULT_WORKBENCH_EXECUTION_CONFIG.maxContextTokens
  const persistedOutputTokens = executionConfig?.maxOutputTokens ?? DEFAULT_WORKBENCH_EXECUTION_CONFIG.maxOutputTokens
  return {
    // Clamp persisted value up to the minimum to avoid stranded sessions that
    // were created before the budget was raised (see RCA: stored 8K caused
    // every developer step to thrash on context compression and the agent
    // forgot earlier file reads).
    maxContextTokens: Math.max(persistedContextTokens, MIN_WORKBENCH_CONTEXT_TOKENS),
    // Same protection for output budget — see RCA: stored 800 caused empty
    // write_file content args → agent_loop_repetition on retries.
    maxOutputTokens: Math.max(persistedOutputTokens, MIN_WORKBENCH_OUTPUT_TOKENS),
    maxPromptChars: executionConfig?.maxPromptChars ?? DEFAULT_WORKBENCH_EXECUTION_CONFIG.maxPromptChars,
    maxLayerChars: executionConfig?.maxLayerChars ?? DEFAULT_WORKBENCH_EXECUTION_CONFIG.maxLayerChars,
  }
}

function stageModelAlias(
  executionConfig: LoopState['executionConfig'],
  stageKey: string,
  stageLabel?: string,
): string | undefined {
  const aliases = executionConfig?.stageModelAliases
  if (!aliases) return executionConfig?.modelAlias ?? WORKBENCH_DEFAULT_MODEL_ALIAS
  const candidates = [
    stageKey,
    stageKey.toLowerCase(),
    stageKey.toUpperCase(),
    stageLabel,
    stageLabel?.toLowerCase(),
    stageLabel?.toUpperCase(),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  for (const candidate of candidates) {
    const alias = aliases[candidate]
    if (alias?.trim()) return alias.trim()
  }
  return executionConfig?.modelAlias ?? WORKBENCH_DEFAULT_MODEL_ALIAS
}

// M100 — resolve the per-phase model override map for a stage. Uses the
// same stageKey/label candidate lookup as stageModelAlias() so the operator
// can key the map by either the stage key or its human label. Returns the
// stage's `{ PHASE: alias }` map (only phases the operator pinned), or
// undefined when nothing is set. CF treats absent phases as "use the
// stage-level model_alias", so we intentionally do NOT fill every phase.
function phaseModelAliases(
  executionConfig: LoopState['executionConfig'],
  stageKey: string,
  stageLabel?: string,
): Record<string, string> | undefined {
  const byStage = executionConfig?.stagePhaseModelAliases
  if (!byStage) return undefined
  const candidates = [
    stageKey,
    stageKey.toLowerCase(),
    stageKey.toUpperCase(),
    stageLabel,
    stageLabel?.toLowerCase(),
    stageLabel?.toUpperCase(),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  for (const candidate of candidates) {
    const map = byStage[candidate]
    if (map && Object.keys(map).length > 0) return map
  }
  return undefined
}

function applyLoopLimitSettings(
  loopDefinition: LoopDefinition,
  input: { maxLoopsPerStage?: number; maxTotalSendBacks?: number },
): LoopDefinition {
  return {
    ...loopDefinition,
    maxLoopsPerStage: input.maxLoopsPerStage ?? loopDefinition.maxLoopsPerStage,
    maxTotalSendBacks: input.maxTotalSendBacks ?? loopDefinition.maxTotalSendBacks,
  }
}

function normalizeLoopDefinition(input: unknown, session: AgentTemplateSeed): LoopDefinition {
  if (isRecord(input) && Array.isArray(input.stages)) {
    const rawStages = input.stages.filter(isRecord)
    const stages = rawStages.map((raw, index) => normalizeLoopStage(raw, index, session)).filter((stage): stage is LoopStageDefinition => Boolean(stage))
    if (stages.length > 0) {
      const known = new Set(stages.map(stage => stage.key))
      return {
        version: typeof input.version === 'number' ? input.version : 1,
        name: typeof input.name === 'string' ? input.name : 'Workflow blueprint loop',
        stages: stages.map((stage, index) => ({
          ...stage,
          next: stage.next && known.has(stage.next) ? stage.next : stage.terminal ? null : stages[index + 1]?.key ?? null,
          allowedSendBackTo: (stage.allowedSendBackTo ?? []).filter(key => known.has(key)),
        })),
        maxLoopsPerStage: numberOr(input.maxLoopsPerStage, 3),
        maxTotalSendBacks: numberOr(input.maxTotalSendBacks, 8),
      }
    }
  }
  return defaultLoopDefinition(session)
}

function normalizeLoopStage(raw: Record<string, unknown>, index: number, session: AgentTemplateSeed): LoopStageDefinition | null {
  const key = slug(typeof raw.key === 'string' ? raw.key : typeof raw.id === 'string' ? raw.id : `stage-${index + 1}`)
  if (!key) return null
  const agentRole = normalizeAgentRole(raw.agentRole ?? raw.role)
  const label = typeof raw.label === 'string' ? raw.label : titleFromKey(key)
  const contextPolicy = normalizeStageContextPolicy(raw.contextPolicy, { key, label, agentRole, terminal: raw.terminal === true })
  const toolPolicy = normalizeStageToolPolicy(raw.toolPolicy, contextPolicy, { key, label, agentRole })
  return {
    key,
    label,
    agentRole,
    agentTemplateId: typeof raw.agentTemplateId === 'string' ? raw.agentTemplateId : defaultAgentTemplateForRole(session, agentRole),
    description: typeof raw.description === 'string' ? raw.description : undefined,
    next: typeof raw.next === 'string' ? slug(raw.next) : raw.next === null ? null : undefined,
    terminal: raw.terminal === true,
    required: raw.required !== false,
    approvalRequired: raw.approvalRequired !== false,
    expectedArtifacts: normalizeExpectedArtifacts(raw.expectedArtifacts),
    allowedSendBackTo: Array.isArray(raw.allowedSendBackTo) ? raw.allowedSendBackTo.filter((item): item is string => typeof item === 'string').map(slug) : [],
    questions: Array.isArray(raw.questions) ? raw.questions.filter(isRecord).map(normalizeQuestion).filter((q): q is LoopQuestion => Boolean(q)) : [],
    contextPolicy,
    repoAccess: typeof raw.repoAccess === 'boolean' ? raw.repoAccess : contextPolicy !== 'STORY_ONLY' && toolPolicy !== 'NONE',
    toolPolicy,
    promptProfileKey: typeof raw.promptProfileKey === 'string' && raw.promptProfileKey.trim() ? raw.promptProfileKey.trim() : undefined,
    limits: normalizeStageLimits(raw.limits),
    // M82 S2 — opt-in. When the workflow's WORKBENCH_TASK node declares
    // `allowMarkDone: true` on this stage, the workbench surfaces a
    // "Mark done & advance" affordance that bypasses the
    // missingRequiredQuestions gate. Defaults to false so the safer
    // PASS-with-answers flow stays the norm.
    allowMarkDone: raw.allowMarkDone === true,
    // M99 — Phase 0 automation flags. Read camelCase or snake_case from the
    // node config; leave undefined when not declared so CF falls back to its
    // env-flag default rather than forcing the automation off.
    autoLocalize: optionalBool(raw.autoLocalize ?? raw.auto_localize),
    autoBaseline: optionalBool(raw.autoBaseline ?? raw.auto_baseline),
    autoVerify: optionalBool(raw.autoVerify ?? raw.auto_verify),
    gitPreflightRequired: optionalBool(raw.gitPreflightRequired ?? raw.git_preflight_required),
  }
}

// Coerce a raw config value to a boolean only when it's actually a boolean;
// otherwise undefined (so "not declared" stays distinct from "declared false").
function optionalBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeStageLimits(value: unknown): { maxSteps?: number; timeoutSec?: number } | undefined {
  if (!isRecord(value)) return undefined
  const out: { maxSteps?: number; timeoutSec?: number } = {}
  const maxSteps = numberOr(value.maxSteps ?? value.max_steps ?? value.maxTurns ?? value.max_turns, NaN)
  if (Number.isFinite(maxSteps) && maxSteps > 0) out.maxSteps = Math.floor(maxSteps)
  const timeoutSec = numberOr(value.timeoutSec ?? value.timeout_sec ?? value.timeout, NaN)
  if (Number.isFinite(timeoutSec) && timeoutSec > 0) out.timeoutSec = Math.floor(timeoutSec)
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeStageContextPolicy(
  value: unknown,
  stage: { key: string; label?: string; agentRole?: string; terminal?: boolean },
): StageContextPolicy {
  const normalized = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  if (normalized === 'STORY_ONLY' || normalized === 'REPO_READ_ONLY' || normalized === 'CODE_EDIT' || normalized === 'VERIFY_ONLY' || normalized === 'EVIDENCE_REVIEW') {
    return normalized
  }
  const signature = `${stage.key} ${stage.label ?? ''} ${stage.agentRole ?? ''}`.toLowerCase()
  // Order matters: non-mutating intents (story / review / evidence / verify)
  // are checked BEFORE the generic "code" → CODE_EDIT fallback, otherwise a
  // read-only stage like "Code Review" matches "code" first and silently
  // becomes mutation-capable. The "code" match is also word-bounded so it
  // doesn't trip on encode/decode/codebase.
  if (signature.includes('intake') || signature.includes('story') || signature.includes('product_owner')) return 'STORY_ONLY'
  if (signature.includes('verify') || signature.includes('qa') || signature.includes('quality') || signature.includes('test')) return 'VERIFY_ONLY'
  if (stage.terminal || signature.includes('review') || signature.includes('evidence') || signature.includes('approval')) return 'EVIDENCE_REVIEW'
  if (signature.includes('develop') || signature.includes('developer') || signature.includes('engineer') || /\bcode\b/.test(signature)) return 'CODE_EDIT'
  return 'REPO_READ_ONLY'
}

function normalizeStageToolPolicy(
  value: unknown,
  contextPolicy: StageContextPolicy,
  stage: { key: string; label?: string; agentRole?: string },
): StageToolPolicy {
  const normalized = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  if (normalized === 'NONE' || normalized === 'READ_ONLY' || normalized === 'MUTATION' || normalized === 'VERIFICATION') return normalized
  if (contextPolicy === 'STORY_ONLY') return 'NONE'
  if (contextPolicy === 'CODE_EDIT') return 'MUTATION'
  if (contextPolicy === 'VERIFY_ONLY') return 'VERIFICATION'
  const signature = `${stage.key} ${stage.label ?? ''} ${stage.agentRole ?? ''}`.toLowerCase()
  if (signature.includes('develop') || signature.includes('developer') || signature.includes('engineer')) return 'MUTATION'
  if (signature.includes('verify') || signature.includes('qa') || signature.includes('quality') || signature.includes('test')) return 'VERIFICATION'
  return 'READ_ONLY'
}

function stageUsesRepoContext(stage: LoopStageDefinition): boolean {
  return stage.repoAccess !== false && stage.contextPolicy !== 'STORY_ONLY' && stage.toolPolicy !== 'NONE'
}

function stageAllowsMutation(stage: LoopStageDefinition): boolean {
  // Source of truth: the workflow's WORKBENCH_TASK node declares each
  // stage's policy via normalizeLoopStage (contextPolicy / toolPolicy).
  // We trust those fields exclusively — no role-string heuristic.
  //
  // Earlier this function also returned true when agentRole.includes('DEV'),
  // which incorrectly matched 'DEVOPS' (release-readiness) and triggered
  // FINALIZE_PROVENANCE_MISSING on read-only review stages. The policy
  // fields are populated by normalizeLoopStage with a signature-based
  // fallback that already handles agent-role-vs-policy mapping cleanly,
  // so the heuristic here was redundant and wrong.
  return stage.contextPolicy === 'CODE_EDIT' || stage.toolPolicy === 'MUTATION'
}

// Verification-running stages (e.g. qa-review) take longer because they
// invoke run_test / run_command in the VERIFY phase. Driven by the
// explicit toolPolicy='VERIFICATION' from the workflow's WORKBENCH_TASK
// node — no role-string fallback for the same reason as above.
function stageRunsVerification(stage: LoopStageDefinition): boolean {
  return stage.toolPolicy === 'VERIFICATION'
}

// Per-stage execution budget. Workflow-declared `stage.limits.maxSteps`
// wins. If the WORKBENCH_TASK node didn't declare a budget for this
// stage, fall back to env-based role-class defaults so existing
// workflows keep working without migration:
//   • mutating dev → WORKBENCH_DEVELOPER_MAX_STEPS (28)
//   • verification  → WORKBENCH_QA_MAX_STEPS         (22)
//   • read-only     → WORKBENCH_DEFAULT_MAX_STEPS    (14)
// New workflows should set `limits.maxSteps` per stage rather than
// relying on the env-based class fallback.
function resolveStageMaxSteps(stage: LoopStageDefinition): number {
  if (stage.limits?.maxSteps && stage.limits.maxSteps > 0) {
    return stage.limits.maxSteps
  }
  if (stageAllowsMutation(stage)) return WORKBENCH_DEVELOPER_MAX_STEPS
  if (stageRunsVerification(stage)) return WORKBENCH_QA_MAX_STEPS
  return WORKBENCH_DEFAULT_MAX_STEPS
}

// Per-stage wall-clock budget for the CF execute envelope. Same
// precedence as resolveStageMaxSteps — workflow-declared
// `stage.limits.timeoutSec` wins, else fall back to role-class
// defaults. Tuned to fit comfortably under the blueprint-workbench
// nginx proxy_read_timeout (600s) so the browser sees the real
// stage outcome before nginx pre-empts with a 504.
//
// Role-class defaults:
//   • mutating dev → 540s (long verify steps in develop's VERIFY phase)
//   • verification  → 540s (qa-review / test-certification can run
//                           4 mvn/pytest invocations each 30-75s)
//   • read-only     → 360s (no shelling out, mostly LLM + AST/grep)
//
// Operators raising `limits.timeoutSec` above 540 must also bump the
// blueprint-workbench nginx /api/ `proxy_read_timeout` to stay
// consistent — otherwise nginx returns 504 before the longer per-stage
// envelope can drain.
function resolveStageTimeoutSec(stage: LoopStageDefinition): number {
  if (stage.limits?.timeoutSec && stage.limits.timeoutSec > 0) {
    return stage.limits.timeoutSec
  }
  if (stageAllowsMutation(stage)) return 540
  if (stageRunsVerification(stage)) return 540
  return 360
}

function stagePromptKey(stage: LoopStageDefinition): string {
  if (stage.promptProfileKey?.trim()) return stage.promptProfileKey.trim()
  return `loop.stage.${stage.key}`
}

function normalizeExpectedArtifacts(input: unknown): LoopExpectedArtifact[] {
  if (!Array.isArray(input)) return []
  return input
    .filter(isRecord)
    .map((raw, index): LoopExpectedArtifact | null => {
      const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : undefined
      const rawKind = typeof raw.kind === 'string' && raw.kind.trim() ? artifactKind(raw.kind) : title ? artifactKind(title) : `artifact_${index + 1}`
      // Upgrade the legacy "simulated" developer artifact to the real-edit
      // contract. The current loop template + the DEVELOPER/ACT prompt both
      // mandate real MCP/git edits (actual_code_change); only stale URLs (whose
      // base64 loopDefinition predates that change) still carry the simulated
      // kind. Remapping here means those runs also contract the developer for
      // real edits rather than a write-up.
      const kind = (rawKind === 'simulated_code_change' || rawKind === 'simulated_code-change')
        ? 'actual_code_change'
        : rawKind
      if (!kind || !title) return null
      const format = raw.format === 'TEXT' || raw.format === 'JSON' || raw.format === 'CODE' ? raw.format : 'MARKDOWN'
      return {
        kind,
        title,
        description: typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : undefined,
        required: raw.required !== false,
        format,
        // M102 — carry the catalog template link through so buildLoopStageVars
        // can inject the template's section skeleton into the agent prompt.
        templateId: typeof raw.templateId === 'string' && raw.templateId.trim() ? raw.templateId.trim() : undefined,
        // (2026-05-31) Universal editability: every artifact is editable by
        // default while work is in flight. Authors can still opt OUT per kind
        // with { editable: false }. The binding read-only guard is now the
        // approval lock in editArtifactContent (session APPROVED/COMPLETED, or
        // a stage attempt the operator accepted) — not this static flag.
        editable: raw.editable !== false,
      }
    })
    .filter((artifact): artifact is LoopExpectedArtifact => Boolean(artifact))
}

function normalizeQuestion(raw: Record<string, unknown>): LoopQuestion | null {
  const id = typeof raw.id === 'string' ? raw.id : undefined
  const question = typeof raw.question === 'string' ? raw.question : undefined
  if (!id || !question) return null
  const options = Array.isArray(raw.options) ? raw.options.filter(isRecord).map(option => ({
    label: String(option.label ?? ''),
    impact: typeof option.impact === 'string' ? option.impact : undefined,
    recommended: option.recommended === true,
  })).filter(option => option.label.trim()) : []
  const rawType = typeof raw.type === 'string' ? raw.type : undefined
  const type = rawType === 'single_select' || rawType === 'multi_select' || rawType === 'freeform' || rawType === 'clarification'
    ? rawType
    : options.length > 0
      ? raw.multiSelect === true ? 'multi_select' : 'single_select'
      : raw.freeform === false ? 'single_select' : 'freeform'
  return {
    id,
    question,
    type,
    required: raw.required === true,
    freeform: raw.freeform !== false,
    options,
    source: raw.source === 'llm_open_question' ? 'llm_open_question' : 'configured',
    stageKey: typeof raw.stageKey === 'string' ? raw.stageKey : undefined,
    attemptId: typeof raw.attemptId === 'string' ? raw.attemptId : undefined,
  }
}

function defaultLoopDefinition(session: AgentTemplateSeed): LoopDefinition {
  // Canonical 4-stage Workbench loop: STORY_INTAKE → DESIGN → DEVELOP → QA.
  // The terminal QA stage absorbs the previous "verify" and "review" responsibilities.
  return {
    version: 1,
    name: 'Workflow-owned workbench loop',
    maxLoopsPerStage: 3,
    maxTotalSendBacks: 6,
    stages: [
      {
        key: 'intake',
        label: 'Story Intake',
        agentRole: 'PRODUCT_OWNER',
        agentTemplateId: firstAgentTemplate(session.architectAgentTemplateId),
        description: 'Capture the story, acceptance criteria, scope, priority, risks, and open business questions without repository access.',
        next: 'design',
        allowedSendBackTo: [],
        required: true,
        approvalRequired: true,
        contextPolicy: 'STORY_ONLY',
        repoAccess: false,
        toolPolicy: 'NONE',
        promptProfileKey: 'loop.stage.intake',
        expectedArtifacts: [
          { kind: 'story_brief', title: 'Story brief', required: true, format: 'MARKDOWN' },
          { kind: 'acceptance_contract', title: 'Acceptance contract', required: true, format: 'MARKDOWN' },
          { kind: 'clarification_questions', title: 'Clarification questions', required: false, format: 'MARKDOWN' },
        ],
        questions: [
          { id: 'INTAKE-001', question: 'What business behavior must change?', required: true, freeform: true },
          { id: 'INTAKE-002', question: 'What acceptance examples prove the story is complete?', required: true, freeform: true },
        ],
      },
      {
        key: 'design',
        label: 'Design',
        agentRole: 'ARCHITECT',
        agentTemplateId: firstAgentTemplate(session.architectAgentTemplateId),
        description: 'Use the accepted story context plus read-only repository evidence to produce a solution design and implementation contract.',
        next: 'develop',
        allowedSendBackTo: ['intake'],
        required: true,
        approvalRequired: true,
        contextPolicy: 'REPO_READ_ONLY',
        repoAccess: true,
        toolPolicy: 'READ_ONLY',
        expectedArtifacts: [
          { kind: 'solution_architecture', title: 'Solution architecture', required: true, format: 'MARKDOWN' },
          { kind: 'approved_spec_draft', title: 'Approved spec draft', required: true, format: 'MARKDOWN' },
          { kind: 'gaps', title: 'Gaps and open risks', required: false, format: 'MARKDOWN' },
        ],
        questions: [
          { id: 'DESIGN-001', question: 'Is the design ready for development?', required: true, options: [
            { label: 'Ready for development', recommended: true, impact: 'Developer can produce the code change.' },
            { label: 'Needs design rework', impact: 'Run another design pass with constraints.' },
          ], freeform: true },
        ],
      },
      {
        key: 'develop',
        label: 'Develop',
        agentRole: 'DEVELOPER',
        agentTemplateId: firstAgentTemplate(session.developerAgentTemplateId),
        description: 'Produce the proposed implementation, file changes, and code-change evidence (commits on the work branch).',
        next: 'qa',
        allowedSendBackTo: ['intake', 'design'],
        required: true,
        approvalRequired: true,
        contextPolicy: 'CODE_EDIT',
        repoAccess: true,
        toolPolicy: 'MUTATION',
        expectedArtifacts: [
          { kind: 'developer_task_pack', title: 'Developer task pack', required: true, format: 'MARKDOWN' },
          { kind: 'actual_code_change', title: 'Actual MCP/git code-change evidence', required: true, format: 'MARKDOWN' },
        ],
        questions: [
          { id: 'DEV-001', question: 'Is the implementation complete enough for QA to review?', required: true, options: [
            { label: 'Ready for QA', recommended: true, impact: 'Move into QA review.' },
            { label: 'Needs developer rework', impact: 'Run another developer iteration.' },
          ], freeform: true },
        ],
      },
      {
        key: 'qa',
        label: 'QA',
        agentRole: 'QA',
        agentTemplateId: firstAgentTemplate(session.qaAgentTemplateId),
        description: 'Verify the change against acceptance criteria, run/inspect tests, build the traceability matrix, and decide whether the workflow can receive the final handoff.',
        next: null,
        terminal: true,
        allowedSendBackTo: ['design', 'develop'],
        required: true,
        approvalRequired: true,
        contextPolicy: 'VERIFY_ONLY',
        repoAccess: true,
        toolPolicy: 'VERIFICATION',
        expectedArtifacts: [
          { kind: 'verification_receipt', title: 'Verification receipt', required: true, format: 'MARKDOWN' },
          { kind: 'traceability_matrix', title: 'Traceability matrix', required: true, format: 'MARKDOWN' },
          { kind: 'final_handoff_notes', title: 'Final handoff notes', required: true, format: 'MARKDOWN' },
        ],
        questions: [
          { id: 'QA-001', question: 'Can this be finalized for workflow handoff?', required: true, options: [
            { label: 'Finalize', recommended: true, impact: 'Generate the final implementation pack.' },
            { label: 'Send back', impact: 'Return to the failing stage with feedback.' },
          ], freeform: true },
        ],
      },
    ],
  }
}

function normalizeAgentRole(value: unknown): LoopAgentRole {
  const role = String(value ?? 'ARCHITECT').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return role || 'ARCHITECT'
}

function defaultAgentTemplateForRole(session: AgentTemplateSeed, role: LoopAgentRole) {
  const normalizedRole = normalizeAgentRole(role)
  if (normalizedRole.includes('DEV') || normalizedRole === 'ENGINEER') {
    return firstAgentTemplate(session.developerAgentTemplateId, session.architectAgentTemplateId, session.qaAgentTemplateId)
  }
  if (normalizedRole.includes('QA') || normalizedRole.includes('TEST') || normalizedRole.includes('VERIFY')) {
    return firstAgentTemplate(session.qaAgentTemplateId, session.developerAgentTemplateId, session.architectAgentTemplateId)
  }
  return firstAgentTemplate(session.architectAgentTemplateId, session.developerAgentTemplateId, session.qaAgentTemplateId)
}

function firstAgentTemplate(...ids: Array<string | null | undefined>) {
  return ids.find((id): id is string => Boolean(id?.trim()))
}

function resolveSessionAgentTemplateIds(input: AgentTemplateSeed, loopDefinition: LoopDefinition): ResolvedAgentTemplateSeed {
  const stageIds = loopDefinition.stages.map(stage => stage.agentTemplateId).filter((id): id is string => Boolean(id?.trim()))
  const architect = input.architectAgentTemplateId ?? stageIds.find((_, index) => index === 0)
  const developer = input.developerAgentTemplateId
    ?? loopDefinition.stages.find(stage => normalizeAgentRole(stage.agentRole).includes('DEV') && stage.agentTemplateId)?.agentTemplateId
    ?? stageIds[1]
    ?? architect
  const qa = input.qaAgentTemplateId
    ?? loopDefinition.stages.find(stage => {
      const role = normalizeAgentRole(stage.agentRole)
      return (role.includes('QA') || role.includes('TEST') || role.includes('VERIFY')) && stage.agentTemplateId
    })?.agentTemplateId
    ?? stageIds.at(-1)
    ?? developer
    ?? architect

  if (!architect || !developer || !qa) {
    throw new ValidationError('At least one agent template must be selected, either as a default binding or per loop phase')
  }
  return {
    architectAgentTemplateId: architect,
    developerAgentTemplateId: developer,
    qaAgentTemplateId: qa,
  }
}

function hydrateLoopAgentTemplates(loopDefinition: LoopDefinition, session: ResolvedAgentTemplateSeed): LoopDefinition {
  return {
    ...loopDefinition,
    stages: loopDefinition.stages.map(stage => ({
      ...stage,
      agentTemplateId: stage.agentTemplateId ?? defaultAgentTemplateForRole(session, stage.agentRole),
      approvalRequired: stage.approvalRequired !== false,
    })),
  }
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function normalizeQuestionText(value?: string | null): string | undefined {
  const normalized = String(value ?? '')
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|please|should|could|would|do|does|is|are|there|any)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
  return normalized || undefined
}

function artifactKind(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function titleFromKey(key: string): string {
  return key.split('-').filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

async function runLoopStage(sessionId: string, stageKey: string, actorId: string) {
  const session = await prisma.blueprintSession.findUnique({
    where: { id: sessionId },
    include: {
      snapshots: { orderBy: { createdAt: 'desc' }, take: 1 },
      artifacts: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!session) throw new NotFoundError('BlueprintSession', sessionId)
  assertBlueprintAccess(session, actorId)
  const state = readLoopState(session)
  const stage = findLoopStage(state, stageKey)
  const snapshot = session.snapshots[0]?.status === 'COMPLETED' ? session.snapshots[0] : undefined
  if (stageUsesRepoContext(stage) && !snapshot) {
    throw new ValidationError('Create a successful source snapshot before running a repo-aware loop stage')
  }
  const priorAttempts = state.stageAttempts.filter(attempt => attempt.stageKey === stage.key)
  const agentTemplateId = stage.agentTemplateId ?? defaultAgentTemplateForRole(session, stage.agentRole)
  if (!agentTemplateId) {
    throw new ValidationError(`Stage ${stage.label} needs an agent template before it can run`)
  }
  // M36.2 / M36.6 — Resolve the loop-stage task body, system-prompt fragment,
  // AND per-execution extraContext from prompt-composer. Replaces inline
  // loopStageTask + loopStageSystemPrompt + the developer/non-developer
  // extraContext block. All three live in StagePromptBinding now.
  const stageVars = await buildLoopStageVars(session, stage, state)
  const resolvedStage = await promptComposerClient.resolveStage({
    stageKey: stagePromptKey(stage),
    agentRole: stage.agentRole ? normalizeAgentRole(stage.agentRole) : undefined,
    promptProfileKey: stage.promptProfileKey,
    vars: stageVars,
  })
  // M46.C — Append prior-attempt learnings directly to the task string so it
  // lands in the prompt regardless of whether the DB-managed `loop.stage`
  // template references the new var. The compact block (≤2.5K chars) tells
  // the new attempt which files the prior attempt already touched, which
  // failed, and the top error lines from the last failed verifier run —
  // letting it skip exploration the prior attempt already did. Empty for
  // first attempts of a stage.
  const task = stageVars.priorAttemptLearnings && stageVars.priorAttemptLearnings.length > 0
    ? `${resolvedStage.task}\n\n## ${stageVars.priorAttemptLearnings}`
    : resolvedStage.task
  const stageSystemPromptAppend = resolvedStage.systemPromptAppend
  const stageExtraContext = resolvedStage.extraContext
  const inputSignature = buildStageInputSignature(snapshot ?? { rootHash: null }, stage, agentTemplateId, task, state)
  const reusable = state.executionConfig?.reuseUnchangedAttempt === false ? undefined : [...priorAttempts].reverse().find(attempt =>
      attempt.inputSignature === inputSignature &&
      attempt.status !== 'RUNNING' &&
      attempt.status !== 'PAUSED' &&
      attempt.status !== 'FAILED' &&
      (!normalizeAgentRole(stage.agentRole).includes('DEV') || ((attempt.correlation?.codeChangeIds as unknown[])?.length ?? 0) > 0) &&
      (attempt.artifactIds?.length ?? 0) > 0,
    )
  if (reusable) {
    const reusedState: LoopState = {
      ...state,
      currentStageKey: stage.key,
      reviewEvents: [...state.reviewEvents, reviewEvent('STAGE_RUN_REUSED', `${stage.label} reused unchanged attempt ${reusable.attemptNumber}.`, actorId, {
        stageKey: stage.key,
        attemptId: reusable.id,
        inputSignature,
        artifactIds: reusable.artifactIds ?? [],
      })],
    }
    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: { status: BlueprintSessionStatus.SNAPSHOTTED, metadata: stateToMetadata(session, reusedState) },
    })
    await recordBlueprintAudit(session.id, 'BlueprintStageRunReused', actorId, {
      stageKey: stage.key,
      stageLabel: stage.label,
      attemptId: reusable.id,
      attemptNumber: reusable.attemptNumber,
      inputSignature,
      artifactIds: reusable.artifactIds ?? [],
    })
    return loadSession(session.id, actorId)
  }
  if (priorAttempts.length >= state.loopDefinition.maxLoopsPerStage) {
    throw new ValidationError(`Stage ${stage.label} reached the max loop count (${state.loopDefinition.maxLoopsPerStage})`)
  }

  // (2026-05-26) Refuse to start a new attempt while another is in-flight.
  //
  // Without this guard, a fast retry (user clicks "re-run" while the
  // workbench still shows the running attempt, OR a server-side polling
  // race) creates two concurrent attempts for the same stage. mcp-server
  // allocates a fresh per-attempt worktree for each, so the agents run
  // in parallel on DIFFERENT worktrees. The mutating tools land their
  // edits in one worktree while finish_work_branch runs against another,
  // producing the "success=True, committed=false, no changes to commit"
  // failure mode — the tool literally has nothing to commit because the
  // edits are stranded on a different worktree.
  //
  // Repro 2026-05-26 session ef0e849e: dev attempts c9309738 (06:43)
  // and 6cc728c0 (06:45) overlapped by ~3 minutes; finish_work_branch
  // on c9309738 landed in worktree 5536e63e but the replace_text edits
  // had gone to worktree 3ca9692f.
  const inflight = priorAttempts.find(a => a.status === 'RUNNING' || a.status === 'PAUSED')
  if (inflight) {
    // (2026-05-31) Idempotent run. A second run request while an attempt is
    // already in-flight is almost always benign — the workflow runtime
    // auto-started the stage (WORKBENCH_TASK) and the operator then clicked Run
    // against a stale view, or a UI double-submit. Creating a 2nd attempt would
    // split the worktree (edits land on one worktree, finish_work_branch runs on
    // another), so the guard must still NOT start a parallel attempt — but it
    // should NOT throw a scary error on the operator's first click either.
    // No-op: return the current session so the UI just shows the running
    // attempt. To intentionally restart, use Reset & rerun (cancel + run).
    await recordBlueprintAudit(session.id, 'BlueprintStageRunNoopInflight', actorId, {
      stageKey: stage.key,
      attemptNumber: inflight.attemptNumber,
      status: inflight.status,
    })
    return loadSession(session.id, actorId)
  }

  const attempt: StageAttempt = {
    id: crypto.randomUUID(),
    stageKey: stage.key,
    // Milestones — tag the attempt with the active milestone so the
    // milestone-aware latestStageAttempt / gates scope correctly. undefined
    // for legacy sessions and session-level stages (cursor null).
    milestoneId: state.milestone?.enabled ? (state.milestone.currentMilestoneId ?? undefined) : undefined,
    stageLabel: stage.label,
    agentRole: stage.agentRole,
    agentTemplateId,
    attemptNumber: priorAttempts.length + 1,
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    inputSignature,
  }
  const startedState: LoopState = {
    ...state,
    currentStageKey: stage.key,
    stageAttempts: [...state.stageAttempts, attempt],
    reviewEvents: [...state.reviewEvents, reviewEvent('STAGE_RUN_STARTED', `${stage.label} attempt ${attempt.attemptNumber} started.`, actorId, { stageKey: stage.key, attemptId: attempt.id })],
  }
  await prisma.blueprintSession.update({
    where: { id: session.id },
    data: { status: BlueprintSessionStatus.RUNNING, metadata: stateToMetadata(session, startedState) },
  })
  await recordBlueprintAudit(session.id, 'BlueprintStageRunStarted', actorId, {
    stageKey: stage.key,
    stageLabel: stage.label,
    attemptId: attempt.id,
    attemptNumber: attempt.attemptNumber,
  })

  const dbRun = await prisma.blueprintStageRun.create({
    data: {
      sessionId: session.id,
      stage: legacyStage(stage),
      status: BlueprintStageStatus.RUNNING,
      task,
      startedAt: new Date(),
    },
  })

  try {
    const codingResult = await runLoopStageExecute(session, snapshot, stage, attempt, task, stageSystemPromptAppend, stageExtraContext)
    const result = codingResult.response
    await recordBlueprintBudgetUsage(session, result, stage.key, readLoopState(session).workflowNodeId)
    // M66 — Persist receipts produced by this stage so the next stage's
    // runLoopStageExecute can thread them as prior_verification_receipts.
    // Runs before any branch-specific session.metadata update below so the
    // rolling history is durable even if the run paused for approval.
    await appendVerificationReceiptsToSession(
      session.id,
      codingResult.verificationReceipts as unknown as Array<Record<string, unknown>>,
    )
    if (!isTerminalCodingResult(codingResult)) {
      await prisma.blueprintStageRun.update({
        where: { id: dbRun.id },
        data: {
          status: blueprintStageStatusFor(codingResult),
          response: result.finalResponse ?? '',
          correlation: {
            ...(result.correlation as unknown as Record<string, unknown>),
            pendingApproval: codingResult.pendingApproval ?? null,
            codingAgent: {
              status: codingResult.status,
              policy: codingResult.policy,
              executeStatus: codingResult.executeStatus,
            },
          } as Prisma.InputJsonValue,
          tokensUsed: result.tokensUsed as unknown as Prisma.InputJsonValue,
          completedAt: null,
          error: null,
        },
      })

      const latest = await prisma.blueprintSession.findUnique({ where: { id: session.id } })
      const pausedState = readLoopState(latest ?? session)
      const pendingApproval = (codingResult.pendingApproval ?? null) as unknown as Record<string, unknown> | null
      const attempts = pausedState.stageAttempts.map(item => item.id === attempt.id ? {
        ...item,
        status: 'PAUSED' as const,
        response: result.finalResponse ?? '',
        error: result.finishReason ?? 'approval_required',
        correlation: {
          ...(result.correlation as unknown as Record<string, unknown>),
          pendingApproval,
        },
        tokensUsed: result.tokensUsed as unknown as Record<string, unknown>,
        metrics: result.metrics as unknown as Record<string, unknown>,
        pendingApproval,
        gateRecommendation: {
          verdict: 'BLOCKED' as const,
          confidence: 0.8,
          reason: `MCP paused ${stage.label} for ${pendingApproval?.tool_name ? `tool approval: ${pendingApproval.tool_name}` : 'human approval'}.`,
          targetStageKey: stage.allowedSendBackTo?.[0],
        },
      } : item)
      const updatedState: LoopState = {
        ...pausedState,
        currentStageKey: stage.key,
        stageAttempts: attempts,
        reviewEvents: [
          ...pausedState.reviewEvents,
          reviewEvent('MCP_APPROVAL_REQUIRED', `${stage.label} is paused for MCP approval.`, actorId, {
            stageKey: stage.key,
            attemptId: attempt.id,
            pendingApproval,
            cfCallId: result.correlation?.cfCallId,
            traceId: result.correlation?.traceId,
          }),
        ],
      }
      await prisma.blueprintSession.update({
        where: { id: session.id },
        data: {
          status: BlueprintSessionStatus.RUNNING,
          metadata: stateToMetadata(latest ?? session, updatedState),
        },
      })
      await recordBlueprintAudit(session.id, 'BlueprintStageRunPaused', actorId, {
        stageKey: stage.key,
        stageLabel: stage.label,
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        cfCallId: result.correlation?.cfCallId,
        traceId: result.correlation?.traceId,
        mcpInvocationId: result.correlation?.mcpInvocationId,
        pendingApproval,
      })
      return loadSession(session.id, actorId)
    }

    const completedAt = new Date().toISOString()
    // (2026-05-26) Provenance check: a mutating stage that claims
    // FINALIZED must have actually invoked finish_work_branch. The
    // orchestrator surfaces finishWorkBranchInvoked from the
    // governed response's tool outcomes — see orchestrator.ts.
    //
    // Scope to stopReason === 'FINALIZED' specifically — when the
    // loop halts at SELF_REVIEW with APPROVAL_PENDING, the agent
    // hasn't even been into FINALIZE yet (that's the point of the
    // approval gate: human approves, then a resume call gives the
    // agent a turn in FINALIZE to call finish_work_branch). The
    // earlier version of this guard fired on APPROVAL_PENDING too
    // and failed dev attempts that were correctly paused for
    // approval. Repro: c1f2f169 + c3420dd8 on 2026-05-26.
    //
    // Why this matters: the dev FINALIZE prompt tells the agent
    // to call finish_work_branch, but the FinalizeReceipt
    // validator only enforces that branch_name + commit_sha are
    // non-empty strings, so a misbehaving agent can fabricate
    // values and the stage closes with no commit on disk. QA
    // then opens a fresh worktree from main and reports "no
    // developer changes detected". Original repro: dev attempts
    // 22b07b16 (04:28) and c119c6b7 (05:21) — both claimed
    // FINALIZED with 3 replace_text calls each, zero
    // finish_work_branch dispatches.
    const governedMeta = (result.correlation as { governed?: { stopReason?: string }; finishWorkBranchInvoked?: boolean }) ?? {}
    const stopReason = governedMeta.governed?.stopReason
    if (
      codingResult.status === 'COMPLETED'
      && stopReason === 'FINALIZED'
      && stageAllowsMutation(stage)
      && governedMeta.finishWorkBranchInvoked === false
    ) {
      codingResult.status = 'FAILED'
      codingResult.warnings = [
        'FINALIZE_PROVENANCE_MISSING: the agent submitted a FinalizeReceipt without successfully invoking finish_work_branch. Edits were made in the worktree but never committed to a branch. Re-run the develop stage so finish_work_branch actually runs.',
        ...(codingResult.warnings ?? []),
      ]
    }
    const gateRecommendation = buildCodingGateRecommendation(codingResult, stage)
    const artifactIds = await createLoopStageArtifacts(session, snapshot, stage, attempt, result, gateRecommendation, actorId)
    const rawLlmOpenQuestions = extractLlmOpenQuestions(result.finalResponse ?? '', stage, attempt)
    await prisma.blueprintStageRun.update({
      where: { id: dbRun.id },
      data: {
        status: blueprintStageStatusFor(codingResult),
        response: result.finalResponse ?? '',
        correlation: {
          ...(result.correlation as unknown as Record<string, unknown>),
          codingAgent: {
            status: codingResult.status,
            policy: codingResult.policy,
            executeStatus: codingResult.executeStatus,
            verificationReceipts: codingResult.verificationReceipts,
          },
        } as unknown as Prisma.InputJsonValue,
        tokensUsed: result.tokensUsed as unknown as Prisma.InputJsonValue,
        completedAt: new Date(completedAt),
        error: codingResult.status === 'FAILED' || codingResult.status === 'DENIED' ? result.finishReason ?? 'stage failed' : null,
      },
    })

    const latest = await prisma.blueprintSession.findUnique({ where: { id: session.id } })
    const nextState = readLoopState(latest ?? session)
    const llmOpenQuestions = filterNewLlmOpenQuestions(rawLlmOpenQuestions, nextState, stage.key)
    const nextLoopDefinition = mergeStageQuestions(nextState.loopDefinition, stage.key, llmOpenQuestions)
    const updatedAttempts = nextState.stageAttempts.map(item => item.id === attempt.id ? {
      ...item,
      status: attemptStatusFor(codingResult),
      completedAt,
      response: result.finalResponse ?? '',
      error: codingResult.status === 'FAILED' || codingResult.status === 'DENIED' ? result.finishReason ?? 'stage failed' : undefined,
      correlation: {
        ...(result.correlation as unknown as Record<string, unknown>),
        codingAgent: {
          status: codingResult.status,
          policy: codingResult.policy,
          executeStatus: codingResult.executeStatus,
        },
      },
      tokensUsed: result.tokensUsed as unknown as Record<string, unknown>,
      metrics: result.metrics as unknown as Record<string, unknown>,
      gateRecommendation,
      artifactIds,
      generatedQuestionIds: llmOpenQuestions.map(question => question.id),
      verificationReceipts: codingResult.verificationReceipts as unknown as Array<Record<string, unknown>>,
    } : item)
    // M83.y P2 — auto-spawn remediation WIs when this is the last
    // allowed attempt and it failed. The persisted attempt is the
    // one we just built in updatedAttempts; look it up via id so
    // the helper sees the FAILED status it just wrote.
    const persistedAttempt = updatedAttempts.find(a => a.id === attempt.id)
    const maxLoopsPerStage = Number(
      (isRecord(nextState.loopDefinition)
        ? (nextState.loopDefinition as { maxLoopsPerStage?: unknown }).maxLoopsPerStage
        : undefined) ?? 3,
    )
    const terminalSpawn = persistedAttempt
      ? await maybeSpawnTerminalRemediation(
          { id: session.id, capabilityId: session.capabilityId, workflowInstanceId: session.workflowInstanceId },
          { key: stage.key, label: stage.label, approvalRequired: stage.approvalRequired },
          persistedAttempt,
          attempt.attemptNumber,
          maxLoopsPerStage,
          actorId,
        )
      : null
    let updatedState: LoopState = {
      ...nextState,
      loopDefinition: nextLoopDefinition,
      currentStageKey: stage.key,
      stageAttempts: updatedAttempts,
      reviewEvents: [
        ...nextState.reviewEvents,
        ...(llmOpenQuestions.length > 0 ? [reviewEvent(
          'CLARIFICATIONS_REQUESTED',
          `${stage.label} asked ${llmOpenQuestions.length} clarification question${llmOpenQuestions.length === 1 ? '' : 's'}.`,
          actorId,
          {
            stageKey: stage.key,
            attemptId: attempt.id,
            questionIds: llmOpenQuestions.map(question => question.id),
          },
        )] : []),
        reviewEvent(
        stage.approvalRequired !== false ? 'ARTIFACTS_AWAITING_APPROVAL' : 'STAGE_RUN_COMPLETED',
        stage.approvalRequired !== false
          ? `${stage.label} produced ${artifactIds.length} artifacts and is waiting for human approval.`
          : `${stage.label} attempt ${attempt.attemptNumber} completed with ${gateRecommendation.verdict}.`,
        actorId,
        {
        stageKey: stage.key,
        attemptId: attempt.id,
        gateRecommendation,
        artifactIds,
        approvalRequired: stage.approvalRequired !== false,
      }),
      // M83.y P2 — surface auto-remediation outcome as a review event
      // so the workbench picks it up via its normal events feed. The
      // payload carries the spawned WI list + any spawn errors; the
      // UI uses that to render "🤖 Spawned WI-1234 to fix inherited
      // failure: testIsNull (NullPointerException at line 136)" cards
      // beneath the red failure banner.
      ...(terminalSpawn && (terminalSpawn.spawned.length > 0 || terminalSpawn.spawnErrors.length > 0)
        ? [reviewEvent(
            'AUTO_REMEDIATION_SPAWNED_ON_TERMINAL_FAILURE',
            terminalSpawn.spawned.length > 0
              ? `${stage.label} exhausted ${attempt.attemptNumber}/${maxLoopsPerStage} attempts; spawned ${terminalSpawn.spawned.length} remediation work item(s).`
              : `${stage.label} exhausted attempts; ${terminalSpawn.spawnErrors.length} remediation spawn(s) failed and need manual creation.`,
            actorId,
            {
              stageKey: stage.key,
              attemptId: attempt.id,
              spawnedWorkItems: terminalSpawn.spawned,
              spawnErrors: terminalSpawn.spawnErrors,
              inheritedFailureCount: terminalSpawn.classification?.inheritedFailures.length ?? 0,
              regressionFailureCount: terminalSpawn.classification?.regressionFailures.length ?? 0,
            },
          )]
        : []),
      ],
    }
    updatedState = maybeApplyAutoGate(updatedState, stage, attempt.id, actorId)
    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: {
        status: BlueprintSessionStatus.SNAPSHOTTED,
        metadata: stateToMetadata(latest ?? session, updatedState),
      },
    })
    await recordBlueprintAudit(session.id, 'BlueprintStageRunCompleted', actorId, {
      stageKey: stage.key,
      stageLabel: stage.label,
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      verdict: gateRecommendation.verdict,
      confidence: gateRecommendation.confidence,
      cfCallId: result.correlation?.cfCallId,
      traceId: result.correlation?.traceId,
      mcpInvocationId: result.correlation?.mcpInvocationId,
      generatedQuestionIds: llmOpenQuestions.map(question => question.id),
      tokensUsed: result.tokensUsed,
      metrics: result.metrics,
    })
    return loadSession(session.id, actorId)
  } catch (err) {
    const message = err instanceof ContextFabricError
      ? `context-fabric error (${err.status}): ${err.message}`
      : (err as Error).message
    await prisma.blueprintStageRun.update({
      where: { id: dbRun.id },
      data: { status: BlueprintStageStatus.FAILED, error: message, completedAt: new Date() },
    })
    const latest = await prisma.blueprintSession.findUnique({ where: { id: session.id } })
    const failedState = readLoopState(latest ?? session)
    const attempts = failedState.stageAttempts.map(item => item.id === attempt.id ? {
      ...item,
      status: 'FAILED' as const,
      completedAt: new Date().toISOString(),
      error: message,
      gateRecommendation: { verdict: 'BLOCKED' as const, confidence: 0.95, reason: message, targetStageKey: stage.allowedSendBackTo?.[0] },
    } : item)
    await prisma.blueprintArtifact.create({
      data: {
        sessionId: session.id,
        stage: legacyStage(stage),
        kind: 'loop_stage_error',
        title: `${stage.label} error`,
        content: message,
        payload: { stageKey: stage.key, attemptId: attempt.id, version: attempt.attemptNumber } as Prisma.InputJsonValue,
      },
    })
    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: {
        status: BlueprintSessionStatus.FAILED,
        metadata: stateToMetadata(latest ?? session, {
          ...failedState,
          currentStageKey: stage.key,
          stageAttempts: attempts,
          reviewEvents: [...failedState.reviewEvents, reviewEvent('STAGE_RUN_FAILED', `${stage.label} failed: ${message}`, actorId, { stageKey: stage.key, attemptId: attempt.id })],
        }),
      },
    })
    await recordBlueprintAudit(session.id, 'BlueprintStageRunFailed', actorId, {
      stageKey: stage.key,
      stageLabel: stage.label,
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      error: message,
    })
    return loadSession(session.id, actorId)
  }
}

async function resumeLoopStageApproval(
  sessionId: string,
  stageKey: string,
  body: StageApprovalInput,
  actorId: string,
) {
  const session = await prisma.blueprintSession.findUnique({
    where: { id: sessionId },
    include: {
      snapshots: { orderBy: { createdAt: 'desc' }, take: 1 },
      artifacts: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!session) throw new NotFoundError('BlueprintSession', sessionId)
  assertBlueprintAccess(session, actorId)
  const state = readLoopState(session)
  const stage = findLoopStage(state, stageKey)
  const snapshot = session.snapshots[0]?.status === 'COMPLETED' ? session.snapshots[0] : undefined
  if (stageUsesRepoContext(stage) && !snapshot) {
    throw new ValidationError('Create a successful source snapshot before resuming a repo-aware loop stage')
  }
  const latestAttempt = latestStageAttempt(state, stage.key)
  if (!latestAttempt || latestAttempt.status !== 'PAUSED') {
    throw new ValidationError(`${stage.label} is not paused for MCP approval`)
  }
  const correlation = isRecord(latestAttempt.correlation) ? latestAttempt.correlation : {}
  const pendingApproval = isRecord(latestAttempt.pendingApproval)
    ? latestAttempt.pendingApproval
    : isRecord(correlation.pendingApproval)
      ? correlation.pendingApproval
      : null
  const cfCallId = typeof correlation.cfCallId === 'string' ? correlation.cfCallId : undefined
  const continuationToken = pendingApproval && typeof pendingApproval.continuation_token === 'string'
    ? pendingApproval.continuation_token
    : undefined
  if (!cfCallId && !continuationToken) {
    throw new ValidationError('Paused stage is missing Context Fabric call id and continuation token')
  }

  const policy = classifyCodingStagePolicy({
    key: stage.key,
    label: stage.label,
    agentRole: stage.agentRole,
    terminal: stage.terminal,
    contextPolicy: stage.contextPolicy,
    toolPolicy: stage.toolPolicy,
  })
  let dbRun = await prisma.blueprintStageRun.findFirst({
    where: {
      sessionId: session.id,
      stage: legacyStage(stage),
      status: BlueprintStageStatus.RUNNING,
    },
    orderBy: { startedAt: 'desc' },
  })
  if (!dbRun) {
    dbRun = await prisma.blueprintStageRun.create({
      data: {
        sessionId: session.id,
        stage: legacyStage(stage),
        status: BlueprintStageStatus.RUNNING,
        task: `Resume paused MCP approval for ${stage.label}`,
        startedAt: new Date(),
      },
    })
  }

  const codingResult = await resumeCodingStage({
    cfCallId,
    continuationToken,
    decision: body.decision,
    reason: body.reason,
    argsOverride: body.argsOverride ?? body.args_override,
    policy,
  })
  const result = codingResult.response
  await recordBlueprintBudgetUsage(session, result, stage.key, state.workflowNodeId)
  // M66 — Same persist-after-stage pattern as the fresh-execute path above.
  // The resume path returns its own verificationReceipts (the resumed
  // session may have run more tests after the approval pause), so persist
  // them too so the next stage sees the complete picture.
  await appendVerificationReceiptsToSession(
    session.id,
    codingResult.verificationReceipts as unknown as Array<Record<string, unknown>>,
  )

  if (!isTerminalCodingResult(codingResult)) {
    await prisma.blueprintStageRun.update({
      where: { id: dbRun.id },
      data: {
        status: blueprintStageStatusFor(codingResult),
        response: result.finalResponse ?? '',
        correlation: {
          ...(result.correlation as unknown as Record<string, unknown>),
          pendingApproval: codingResult.pendingApproval ?? null,
          codingAgent: {
            status: codingResult.status,
            policy: codingResult.policy,
            executeStatus: codingResult.executeStatus,
          },
        } as unknown as Prisma.InputJsonValue,
        tokensUsed: result.tokensUsed as unknown as Prisma.InputJsonValue,
        completedAt: null,
        error: null,
      },
    })
    const latest = await prisma.blueprintSession.findUnique({ where: { id: session.id } })
    const pausedState = readLoopState(latest ?? session)
    const nextPendingApproval = (codingResult.pendingApproval ?? null) as unknown as Record<string, unknown> | null
    const attempts = pausedState.stageAttempts.map(item => item.id === latestAttempt.id ? {
      ...item,
      status: 'PAUSED' as const,
      response: result.finalResponse ?? item.response,
      error: result.finishReason ?? 'approval_required',
      correlation: {
        ...(result.correlation as unknown as Record<string, unknown>),
        pendingApproval: nextPendingApproval,
      },
      tokensUsed: result.tokensUsed as unknown as Record<string, unknown>,
      metrics: result.metrics as unknown as Record<string, unknown>,
      pendingApproval: nextPendingApproval,
      gateRecommendation: {
        verdict: 'BLOCKED' as const,
        confidence: 0.8,
        reason: `MCP paused ${stage.label} for another approval.`,
        targetStageKey: stage.allowedSendBackTo?.[0],
      },
    } : item)
    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: {
        status: BlueprintSessionStatus.RUNNING,
        metadata: stateToMetadata(latest ?? session, {
          ...pausedState,
          currentStageKey: stage.key,
          stageAttempts: attempts,
          reviewEvents: [
            ...pausedState.reviewEvents,
            reviewEvent('MCP_APPROVAL_REQUIRED', `${stage.label} paused again for MCP approval.`, actorId, {
              stageKey: stage.key,
              attemptId: latestAttempt.id,
              pendingApproval: nextPendingApproval,
              cfCallId: result.correlation?.cfCallId,
              traceId: result.correlation?.traceId,
            }),
          ],
        }),
      },
    })
    await recordBlueprintAudit(session.id, 'BlueprintStageRunPaused', actorId, {
      stageKey: stage.key,
      stageLabel: stage.label,
      attemptId: latestAttempt.id,
      attemptNumber: latestAttempt.attemptNumber,
      cfCallId: result.correlation?.cfCallId,
      traceId: result.correlation?.traceId,
      pendingApproval: nextPendingApproval,
    })
    return loadSession(session.id, actorId)
  }

  const completedAt = new Date().toISOString()
  const gateRecommendation = buildCodingGateRecommendation(codingResult, stage)
  const artifactIds = await createLoopStageArtifacts(session, snapshot, stage, latestAttempt, result, gateRecommendation, actorId)
  const rawLlmOpenQuestions = extractLlmOpenQuestions(result.finalResponse ?? '', stage, latestAttempt)
  await prisma.blueprintStageRun.update({
    where: { id: dbRun.id },
    data: {
      status: blueprintStageStatusFor(codingResult),
      response: result.finalResponse ?? '',
      correlation: {
        ...(result.correlation as unknown as Record<string, unknown>),
        codingAgent: {
          status: codingResult.status,
          policy: codingResult.policy,
          executeStatus: codingResult.executeStatus,
          verificationReceipts: codingResult.verificationReceipts,
        },
      } as unknown as Prisma.InputJsonValue,
      tokensUsed: result.tokensUsed as unknown as Prisma.InputJsonValue,
      completedAt: new Date(completedAt),
      error: codingResult.status === 'FAILED' || codingResult.status === 'DENIED' ? result.finishReason ?? 'stage failed' : null,
    },
  })

  const latest = await prisma.blueprintSession.findUnique({ where: { id: session.id } })
  const nextState = readLoopState(latest ?? session)
  const llmOpenQuestions = filterNewLlmOpenQuestions(rawLlmOpenQuestions, nextState, stage.key)
  const nextLoopDefinition = mergeStageQuestions(nextState.loopDefinition, stage.key, llmOpenQuestions)
  const updatedAttempts = nextState.stageAttempts.map(item => item.id === latestAttempt.id ? {
    ...item,
    status: attemptStatusFor(codingResult),
    completedAt,
    response: result.finalResponse ?? '',
    error: codingResult.status === 'FAILED' || codingResult.status === 'DENIED' ? result.finishReason ?? 'stage failed' : undefined,
    correlation: {
      ...(result.correlation as unknown as Record<string, unknown>),
      codingAgent: {
        status: codingResult.status,
        policy: codingResult.policy,
        executeStatus: codingResult.executeStatus,
      },
    },
    tokensUsed: result.tokensUsed as unknown as Record<string, unknown>,
    metrics: result.metrics as unknown as Record<string, unknown>,
    pendingApproval: null,
    gateRecommendation,
    artifactIds,
    generatedQuestionIds: llmOpenQuestions.map(question => question.id),
    verificationReceipts: codingResult.verificationReceipts as unknown as Array<Record<string, unknown>>,
  } : item)
  let updatedState: LoopState = {
    ...nextState,
    loopDefinition: nextLoopDefinition,
    currentStageKey: stage.key,
    stageAttempts: updatedAttempts,
    reviewEvents: [
      ...nextState.reviewEvents,
      reviewEvent('MCP_APPROVAL_RESUMED', `${stage.label} MCP approval ${body.decision}.`, actorId, {
        stageKey: stage.key,
        attemptId: latestAttempt.id,
        decision: body.decision,
        cfCallId: result.correlation?.cfCallId,
        traceId: result.correlation?.traceId,
      }),
      ...(llmOpenQuestions.length > 0 ? [reviewEvent(
        'CLARIFICATIONS_REQUESTED',
        `${stage.label} asked ${llmOpenQuestions.length} clarification question${llmOpenQuestions.length === 1 ? '' : 's'}.`,
        actorId,
        {
          stageKey: stage.key,
          attemptId: latestAttempt.id,
          questionIds: llmOpenQuestions.map(question => question.id),
        },
      )] : []),
      reviewEvent(
        stage.approvalRequired !== false ? 'ARTIFACTS_AWAITING_APPROVAL' : 'STAGE_RUN_COMPLETED',
        stage.approvalRequired !== false
          ? `${stage.label} produced ${artifactIds.length} artifacts and is waiting for human approval.`
          : `${stage.label} attempt ${latestAttempt.attemptNumber} completed with ${gateRecommendation.verdict}.`,
        actorId,
        {
          stageKey: stage.key,
          attemptId: latestAttempt.id,
          gateRecommendation,
          artifactIds,
          approvalRequired: stage.approvalRequired !== false,
        },
      ),
    ],
  }
  updatedState = maybeApplyAutoGate(updatedState, stage, latestAttempt.id, actorId)
  await prisma.blueprintSession.update({
    where: { id: session.id },
    data: {
      status: codingResult.status === 'FAILED' || codingResult.status === 'DENIED'
        ? BlueprintSessionStatus.FAILED
        : BlueprintSessionStatus.SNAPSHOTTED,
      metadata: stateToMetadata(latest ?? session, updatedState),
    },
  })
  await recordBlueprintAudit(session.id, 'BlueprintStageRunResumed', actorId, {
    stageKey: stage.key,
    stageLabel: stage.label,
    attemptId: latestAttempt.id,
    attemptNumber: latestAttempt.attemptNumber,
    decision: body.decision,
    verdict: gateRecommendation.verdict,
    confidence: gateRecommendation.confidence,
    cfCallId: result.correlation?.cfCallId,
    traceId: result.correlation?.traceId,
    mcpInvocationId: result.correlation?.mcpInvocationId,
    generatedQuestionIds: llmOpenQuestions.map(question => question.id),
    tokensUsed: result.tokensUsed,
    metrics: result.metrics,
  })
  return loadSession(session.id, actorId)
}

/**
 * M78 Slice 3 — Spawn a remediation work item that targets a specific
 * inherited test failure surfaced on a develop attempt. Returns the
 * new work item's id + workCode so the workbench can show a link.
 *
 * The new WI:
 *   - Inherits the source session's capability (most common case;
 *     operator can override via `targetCapabilityId` when the bug
 *     belongs to a sibling repo).
 *   - Carries a structured `details.inheritedFailureRemediation`
 *     payload back-linking to the originating session/stage/attempt
 *     so audit-gov + Slice 4's auto-execute hook can find it.
 *   - Defaults to MANUAL routingMode so the operator decides when
 *     to start the loop. Slice 4 will optionally override this with
 *     AUTO_START when the capability has the auto-remediation flag on.
 *
 * The WI title is a concise, search-friendly summary of the bug;
 * the description is structured Markdown that the receiving agent
 * can read as a task pack.
 */
async function createInheritedFailureRemediation(
  sessionId: string,
  stageKey: string,
  body: {
    failure: { test: string; file: string; exception?: string; exceptionLine?: number; hint?: string }
    originAttemptId?: string
    titleOverride?: string
    targetCapabilityId?: string
  },
  actorId: string,
) {
  const session = await prisma.blueprintSession.findUnique({ where: { id: sessionId } })
  if (!session) throw new NotFoundError('BlueprintSession', sessionId)
  assertBlueprintAccess(session, actorId)

  const capabilityId = body.targetCapabilityId ?? session.capabilityId
  if (!capabilityId) {
    throw new ValidationError(
      'Cannot create remediation WI: no target capability. Pass targetCapabilityId explicitly or attach the session to a capability first.',
    )
  }

  const { failure } = body
  // Derive a short, search-friendly title. Examples:
  //   "Fix testIsNull (NullPointer at line 136)"
  //   "Fix testContainsACharacter (no exception data)"
  const shortTest = failure.test.split('.').pop() ?? failure.test
  const shortException = failure.exception ?? 'failing test'
  const linePart = failure.exceptionLine ? ` at line ${failure.exceptionLine}` : ''
  const title = body.titleOverride ?? `Fix ${shortTest} (${shortException}${linePart})`

  // The description doubles as the new WI's task pack — the
  // remediation agent reads it as the goal. Keep it short, factual,
  // and unambiguous about what "done" looks like. The hint comes
  // straight from the analyzer's hintForException() output when it
  // recognises the pattern.
  const descriptionParts: string[] = [
    `## Inherited test failure — remediation task`,
    ``,
    `**Test:** \`${failure.test}\``,
    `**File:** \`${failure.file}${failure.exceptionLine ? `:${failure.exceptionLine}` : ''}\``,
    ...(failure.exception ? [`**Exception:** \`${failure.exception}\``] : []),
    ``,
  ]
  if (failure.hint) {
    descriptionParts.push(`### Hint`, failure.hint, ``)
  }
  descriptionParts.push(
    `### Origin`,
    `Auto-created from inherited-failure remediation on blueprint session \`${sessionId}\` (stage \`${stageKey}\`${body.originAttemptId ? `, attempt \`${body.originAttemptId}\`` : ''}).`,
    `The agent's work in that attempt was correct — this test was already failing in upstream main.`,
    ``,
    `### Acceptance criteria`,
    `- [ ] \`${failure.test}\` no longer throws / fails when invoked via the project's test runner.`,
    `- [ ] No other tests regress (call \`capture_test_baseline\` before editing).`,
    `- [ ] The fix is the minimal change that makes the test pass — do not refactor surrounding code.`,
  )
  const description = descriptionParts.join('\n')

  const workItem = await createWorkItem({
    title,
    description,
    parentCapabilityId: capabilityId,
    sourceWorkflowInstanceId: session.workflowInstanceId ?? undefined,
    targets: [{ targetCapabilityId: capabilityId }],
    details: {
      title,
      description,
      inheritedFailureRemediation: {
        originSessionId: sessionId,
        originStageKey: stageKey,
        originAttemptId: body.originAttemptId ?? null,
        failure,
      },
    },
    urgency: 'NORMAL',
    routingMode: 'MANUAL',
  }, actorId)

  return {
    id: workItem.id,
    workCode: workItem.workCode,
    title,
    capabilityId,
  }
}

// M94.2 (2026-05-28) — Multinode helpers. ⚠️ NOT RUNTIME-VERIFIED.
//
// multinodeEnabled() centralizes the WORKBENCH_MULTINODE flag read so
// every multinode branch agrees on the toggle. Default off → all M94
// behavior is inert until M94.5 cutover.
function multinodeEnabled(): boolean {
  return (process.env.WORKBENCH_MULTINODE ?? '').toLowerCase() === 'true'
}

// advanceMultinodeStageNode — in the 4-stage-nodes model, complete the
// WORKBENCH_TASK node that owns `stageKey` so the runtime advances to the
// next stage-node. The node is identified by config.workbench.stageKey
// (pinned by M94.3's graph generator). Idempotent: skips when no node
// pins the stage (single-node mode) or the node is already COMPLETED.
//
// ⚠️ This calls the workflow runtime's advance() with NO stack
// verification. When verifying: confirm exactly one node matches the
// stageKey, that advance() doesn't re-fire on an already-completed node,
// and that the terminal (QA) node's advance flows into the child END →
// parent CALL_WORKFLOW resume.
async function advanceMultinodeStageNode(
  workflowInstanceId: string,
  stageKey: string,
  actorId?: string,
): Promise<void> {
  const nodes = await prisma.workflowNode.findMany({
    where: { instanceId: workflowInstanceId },
    select: { id: true, status: true, config: true },
  })
  const target = nodes.find(n => {
    const cfg = isRecord(n.config) ? n.config : {}
    const wb = isRecord(cfg.workbench) ? cfg.workbench : {}
    const pinned = typeof wb.stageKey === 'string' ? wb.stageKey : ''
    return pinned && pinned.toUpperCase() === stageKey.toUpperCase()
  })
  if (!target) return            // single-node mode: no per-stage node pin
  if (target.status === 'COMPLETED') return  // idempotent re-entry guard
  const { advance } = await import('../workflow/runtime/WorkflowRuntime')
  await advance(workflowInstanceId, target.id, { _multinodeStageCompleted: stageKey }, actorId)
}

async function saveStageVerdict(
  sessionId: string,
  stageKey: string,
  body: z.infer<typeof verdictSchema>,
  actorId: string,
) {
  const session = await prisma.blueprintSession.findUnique({ where: { id: sessionId } })
  if (!session) throw new NotFoundError('BlueprintSession', sessionId)
  assertBlueprintAccess(session, actorId)
  const state = readLoopState(session)
  const stage = findLoopStage(state, stageKey)
  const latestAttempt = latestStageAttempt(state, stage.key)
  if (!latestAttempt || latestAttempt.status === 'RUNNING' || latestAttempt.status === 'PAUSED') {
    throw new ValidationError(`Run ${stage.label} before saving a verdict`)
  }
  const mergedAnswers = mergeDecisionAnswers(state.decisionAnswers, body.answers ?? [], actorId)
  const missing = missingRequiredQuestions(stage, mergedAnswers)
  // M82 S2 — MARK_DONE bypasses the required-question gate when the
  // stage opts in via allowMarkDone=true on the workflow node. Refuse
  // MARK_DONE on stages that didn't opt in so an unintended client
  // can't sneak past the questions check.
  if (body.verdict === 'MARK_DONE' && stage.allowMarkDone !== true) {
    throw new ValidationError(
      `Stage ${stage.label} does not allow Mark Done. Answer the required questions and use PASS instead, or set allowMarkDone: true on the stage in the workflow node's loopDefinition.`,
    )
  }
  if ((body.verdict === 'PASS' || body.verdict === 'ACCEPTED_WITH_RISK') && missing.length > 0 && !body.acceptRisk) {
    throw new ValidationError(`Required questions must be answered before approval: ${missing.join(', ')}`)
  }

  // MARK_DONE is treated as PASS by every downstream consumer
  // (verdict union, attempt status, workflow auto-advance) — it's
  // purely a UX shortcut that loosens the questions gate. Normalize
  // here so the LoopVerdict type stays clean and nothing downstream
  // has to know about MARK_DONE.
  const wasMarkDone = body.verdict === 'MARK_DONE'
  const persistedVerdict: LoopVerdict = wasMarkDone ? 'PASS' : (body.verdict as LoopVerdict)
  const accepted = persistedVerdict === 'PASS' || persistedVerdict === 'ACCEPTED_WITH_RISK'
  // M81 + 2026-05-26: gate on accumulated branch state, not the
  // latest attempt's records alone. The wi/<code> branch persists
  // commits across attempts, so a no-op re-run review is approvable
  // when an earlier attempt already landed the code. See
  // loopStateHasAccumulatedCodeChange comment for the repro.
  if (
    accepted
    && stageAllowsMutation(stage)
    && !loopStateHasAccumulatedCodeChange(state, stage.key)
  ) {
    throw new ValidationError(
      'Developer stage cannot be approved until an actual MCP/git code change is captured. Re-run Develop with a writable MCP workspace and a tool-capable model alias.',
    )
  }
  if (accepted && attemptHasActualCodeChange(latestAttempt) && (latestAttempt.verificationReceipts?.length ?? 0) === 0) {
    throw new ValidationError(
      'Code-changing stages need a captured MCP verification receipt before approval. Run test, lint, typecheck, or another configured verification tool and rerun the stage.',
    )
  }
  if (accepted && attemptHasActualCodeChange(latestAttempt) && attemptHasFailedVerificationReceipt(latestAttempt)) {
    // M78 Slice 1 — Classify each failed test as REGRESSION (file the
    // agent touched in this attempt) vs INHERITED (failure exists in
    // upstream code the agent didn't modify). When all failures are
    // inherited, the workbench renders actionable cards instead of a
    // wall-of-text validation error — and Slice 3+ can turn that into
    // a one-click remediation WI. Best-effort: when path-resolution
    // fails or the parser couldn't extract structured failingTests we
    // fall back to the legacy string-only error so callers never see
    // worse UX than today.
    const classification = await analyzeAttemptFailures(latestAttempt).catch(() => null)
    const totalClassified = (classification?.inheritedFailures.length ?? 0)
      + (classification?.regressionFailures.length ?? 0)
      // M90.B — include unknownFailures so the gate doesn't short-circuit
      // to the generic legacy message when provenance was missing.
      + (classification?.unknownFailures.length ?? 0)
    if (classification && totalClassified > 0) {
      // M90.B — "inheritedOnly" requires GENUINE inherited classification.
      // unknownFailures (empty provenance bucket) MUST NOT trigger the
      // auto-remediation / soft-block path that inherited triggers.
      const inheritedOnly = classification.regressionFailures.length === 0
                            && classification.unknownFailures.length === 0
                            && classification.inheritedFailures.length > 0
      const unknownOnly = classification.regressionFailures.length === 0
                          && classification.inheritedFailures.length === 0
                          && classification.unknownFailures.length > 0

      // M78 Slice 4 — Auto-remediation. When the platform operator has
      // opted in via WORKGRAPH_AUTO_REMEDIATE_INHERITED_FAILURES AND all
      // failures are inherited (i.e. NOT the agent's fault), spawn one
      // remediation WI per failure right here, before throwing the
      // blocking error. The error still fires (the original WI's gate
      // stays blocked until the operator re-tries approval) but its
      // payload kind flips to `auto_remediation_spawned` so the workbench
      // shows "🤖 auto-spawned WI-1234, WI-1235" instead of the manual-
      // click card. Auto-unblock when remediation completes is a follow-
      // up; today the operator manually re-tries approval. Best-effort:
      // any individual spawn failure just records the error and the
      // remaining failures fall back to manual click; we never block
      // approval harder than the legacy path.
      if (inheritedOnly && config.WORKGRAPH_AUTO_REMEDIATE_INHERITED_FAILURES) {
        const spawned: Array<{ id: string; workCode: string; title: string; test: string }> = []
        const spawnErrors: Array<{ test: string; reason: string }> = []
        for (const failure of classification.inheritedFailures) {
          try {
            const created = await createInheritedFailureRemediation(
              sessionId, stageKey,
              { failure, originAttemptId: latestAttempt?.id },
              actorId,
            )
            spawned.push({ ...created, test: failure.test })
          } catch (err) {
            spawnErrors.push({ test: failure.test, reason: (err as Error).message })
          }
        }
        const allSpawned = spawned.length === classification.inheritedFailures.length
        const message = allSpawned
          ? `Approval blocked — but auto-remediation spawned ${spawned.length} work item(s) to fix the upstream failures. Re-try approval after they complete.`
          : `Approval blocked. Auto-remediation spawned ${spawned.length} of ${classification.inheritedFailures.length} work items; ${spawnErrors.length} failed and need manual handling.`
        throw new ValidationError(message, {
          kind: 'auto_remediation_spawned',
          inheritedOnly: true,
          inheritedFailures: classification.inheritedFailures,
          regressionFailures: [],
          spawnedWorkItems: spawned,
          spawnErrors,
          recommendedActions: spawnErrors.length > 0
            ? ['retry_approval_after_remediation', 'manually_create_remediation_wi']
            : ['retry_approval_after_remediation'],
        })
      }

      // M90.B — message shape per bucket. unknownOnly is its own variant
      // because we genuinely don't know whether to push the operator
      // toward send-back or remediation-WI — they have to look.
      let message: string
      if (inheritedOnly) {
        message = `Approval blocked: ${classification.inheritedFailures.length} test failure(s) are inherited from upstream — your agent's own changes didn't introduce them. Create a remediation work item to fix the upstream tests, or accept the risk to proceed.`
      } else if (unknownOnly) {
        message = `Approval blocked: ${classification.unknownFailures.length} test failure(s) couldn't be classified — the platform has no record of which files this attempt touched, so we can't tell if these are inherited failures or new regressions. Inspect the stdout, then either send the stage back or accept the risk explicitly.`
      } else {
        message = `Approval blocked: ${classification.regressionFailures.length} new test regression(s) introduced by this attempt`
        if (classification.inheritedFailures.length > 0) {
          message += ` + ${classification.inheritedFailures.length} inherited failure(s).`
        }
        if (classification.unknownFailures.length > 0) {
          message += ` + ${classification.unknownFailures.length} unclassified failure(s).`
        }
        message += ' Send the stage back to fix the regressions; inherited failures need their own remediation WI.'
      }
      throw new ValidationError(message, {
        kind: 'verification_failure_analysis',
        inheritedOnly,
        unknownOnly,
        inheritedFailures: classification.inheritedFailures,
        regressionFailures: classification.regressionFailures,
        unknownFailures: classification.unknownFailures,
        unparseable: classification.unparseable,
        recommendedActions: inheritedOnly
          ? ['create_remediation_wi', 'accept_risk']
          : unknownOnly
            ? ['inspect_stdout', 'accept_risk', 'send_back_to_develop']
            : ['send_back_to_develop'],
      })
    }
    throw new ValidationError(
      'Code-changing stages cannot be approved with failed verification receipts. Either: ' +
      '(a) Send the stage back so the agent can fix the failing tests, OR ' +
      '(b) Have the agent call `capture_test_baseline` BEFORE editing (in EXPLORE) — pre-existing failures then pass through the gate as long as no NEW regressions appear.',
    )
  }
  if (accepted && attemptHasActualCodeChange(latestAttempt) && attemptHasUnavailableVerificationReceipt(latestAttempt) && (body.verdict !== 'ACCEPTED_WITH_RISK' || !body.acceptRisk)) {
    throw new ValidationError(
      'Verification was explicitly recorded as unavailable. Use Accepted with risk and confirm accepted risk, or send the stage back for runnable verification.',
    )
  }
  if (accepted && attemptHasActualCodeChange(latestAttempt) && !attemptHasPassingVerificationReceipt(latestAttempt)) {
    throw new ValidationError(
      'Code-changing stages need at least one passing MCP verification receipt before approval.',
    )
  }
  // ── Phased Agent Reasoning Model (v4) — path-coverage gate ────────────
  // When the run was a phased developer attempt, mcp-server's response
  // includes `correlation.codeChangeCoverage`. If any `required: true` code
  // target is missing AND wasn't explicitly skipped-with-reason, block the
  // approval. This is the fix for the lazy-edit failure mode where the
  // agent edits a docs file but skips the actual service code.
  if (accepted) {
    const coverage = attemptCodeChangeCoverage(latestAttempt)
    if (coverage && coverage.hasRequiredCodeGap) {
      throw new ValidationError(
        `Plan-coverage gate: ${coverage.missing.length} required code target${coverage.missing.length === 1 ? '' : 's'} (${coverage.missing.join(', ')}) ${coverage.missing.length === 1 ? 'was' : 'were'} not edited in this attempt. ` +
        `Send the stage back so the agent can complete the implementation, or revise the plan to mark ${coverage.missing.length === 1 ? 'that file' : 'those files'} skipped with an explicit reason.`,
      )
    }
    // ── M43 Slice 3 — Deterministic verification gate ─────────────────
    // mcp-server (with MCP_DETERMINISTIC_VERIFICATION_GATE_ENABLED=true) emits
    // `correlation.verificationCoverage`. When `gap=true`, the run produced
    // code changes but no verification receipt at all (not even an explicit
    // verification_unavailable). Refuse to approve — the agent must either
    // run a verifier or explicitly acknowledge no verifier exists.
    const verCoverage = attemptVerificationCoverage(latestAttempt)
    if (verCoverage && verCoverage.gap) {
      throw new ValidationError(
        `Verification gate: code changes are present in this attempt but no verification receipt was captured. ` +
        `The agent must call run_test (with a recommended_verification command), run_command, ` +
        `or verification_unavailable with an explicit reason before this stage can be approved. ` +
        `Send the stage back so the agent can complete VERIFY.`,
      )
    }
  }
  const attempts = state.stageAttempts.map(item => item.id === latestAttempt.id ? {
    ...item,
    status: verdictToAttemptStatus(persistedVerdict),
    verdict: persistedVerdict,
    confidence: body.confidence,
    feedback: body.feedback,
    acceptedAt: accepted ? new Date().toISOString() : item.acceptedAt,
    acceptedById: accepted ? actorId : item.acceptedById,
  } : item)
  const nextStageKey = accepted ? stage.next ?? null : stage.key
  // Milestones (P2) — when the architect stage that owns milestone_plan is
  // accepted and the cursor isn't populated yet, ingest the decomposition.
  let milestoneState = state.milestone
  if (accepted && milestoneState?.enabled && milestoneState.plan.length === 0) {
    const parsed = await loadLatestMilestonePlan(sessionId)
    if (parsed) milestoneState = applyMilestonePlan(state, parsed).milestone
  }
  const nextState: LoopState = {
    ...state,
    milestone: milestoneState,
    decisionAnswers: mergedAnswers,
    currentStageKey: nextStageKey,
    stageAttempts: attempts,
    reviewEvents: [...state.reviewEvents, reviewEvent('STAGE_VERDICT', `${stage.label} marked ${persistedVerdict}${wasMarkDone ? ' (via Mark Done)' : ''}.`, actorId, {
      stageKey: stage.key,
      attemptId: latestAttempt.id,
      verdict: persistedVerdict,
      // Preserve the original verb so audit-gov can distinguish a
      // deliberate "I read it and waived the questions" from a
      // standard PASS-with-answers.
      verdictOrigin: wasMarkDone ? 'mark_done' : 'pass_with_answers',
      feedback: body.feedback,
      missingQuestionsAcceptedWithRisk: missing,
    })],
  }
  await prisma.blueprintSession.update({
    where: { id: session.id },
    data: {
      status: isLoopGreen(nextState) ? BlueprintSessionStatus.COMPLETED : BlueprintSessionStatus.SNAPSHOTTED,
      metadata: stateToMetadata(session, nextState),
    },
  })

  // M94.2 (2026-05-28) — Multinode per-node completion. ⚠️ NOT RUNTIME-VERIFIED.
  //
  // In the literal "4 independent stage-nodes" model (Option A), each
  // stage of the loop is owned by its own WORKBENCH_TASK node in the
  // child workbench-profile workflow. When a stage is ACCEPTED here, the
  // owning workflow node must complete so the runtime advances to the
  // next stage-node (which will resume this same shared session — M94.1).
  // In single-node mode this hook is a no-op: no node pins a stageKey, so
  // advanceMultinodeStageNode finds nothing and returns. Gated behind
  // WORKBENCH_MULTINODE so production is untouched until M94.5 flips it.
  //
  // ⚠️ This advance() wiring has NOT been verified against a running stack.
  // Known risks to check when verifying: (a) double-advance with the
  // finalization path (attachFinalPackToWorkflowNode also calls advance —
  // guarded below to skip in multinode); (b) ordering vs. the next node's
  // session-resume; (c) the terminal QA node advancing into the child END.
  if (accepted && multinodeEnabled() && session.workflowInstanceId) {
    try {
      await advanceMultinodeStageNode(session.workflowInstanceId, stage.key, actorId)
    } catch (err) {
      // Best-effort — a failed node advance must not roll back the verdict
      // save. Surfaced in audit-gov so the stuck node is observable.
      await recordBlueprintAudit(session.id, 'BlueprintMultinodeAdvanceFailed', actorId, {
        workflowInstanceId: session.workflowInstanceId,
        stageKey: stage.key,
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined)
    }
  }

  await transitionAttemptConsumables(
    latestAttempt.artifactIds ?? [],
    accepted ? 'APPROVED' : 'REJECTED',
    actorId,
    accepted ? 'BlueprintStageConsumablesApproved' : 'BlueprintStageConsumablesRejected',
    {
      sessionId: session.id,
      stageKey: stage.key,
      stageLabel: stage.label,
      attemptId: latestAttempt.id,
      verdict: persistedVerdict,
      verdictOrigin: wasMarkDone ? 'mark_done' : 'pass_with_answers',
    },
  )
  await recordBlueprintAudit(session.id, 'BlueprintStageVerdictSaved', actorId, {
    stageKey: stage.key,
    stageLabel: stage.label,
    attemptId: latestAttempt.id,
    verdict: persistedVerdict,
    verdictOrigin: wasMarkDone ? 'mark_done' : 'pass_with_answers',
    confidence: body.confidence,
    acceptRisk: body.acceptRisk === true,
    missingQuestionsAcceptedWithRisk: missing,
  })
  return loadSession(session.id, actorId)
}

// M82 S1 (2026-05-26) — operator-driven artifact edit. Persists the
// new content, snapshots the previous body into payload.revisions, and
// emits an audit trail. Refuses if the artifact's kind isn't declared
// editable on at least one stage's expectedArtifacts in the session's
// loopDefinition.
//
// Design rationale (per the team's earlier "things should come from
// the workbench node" principle): editability is a per-kind decision
// the workflow author makes in the WORKBENCH_TASK node config, not a
// hardcoded allowlist. Reviewer outputs (security findings, qa
// receipts) stay read-only by default; story briefs and design docs
// can opt in.
/**
 * (2026-05-31) Artifact IDs locked because the loop stage attempt that
 * produced them has been accepted by the operator (acceptedAt set = approved /
 * marked done). Edits to these are refused so an approved result can't be
 * silently rewritten. Non-loop (blueprint-mode) sessions return an empty set —
 * those are guarded by the session-level APPROVED/COMPLETED lock instead.
 */
function approvedArtifactIds(session: Parameters<typeof readLoopState>[0]): Set<string> {
  const locked = new Set<string>()
  try {
    const state = readLoopState(session)
    for (const attempt of state.stageAttempts ?? []) {
      if (!attempt.acceptedAt) continue
      for (const id of attempt.artifactIds ?? []) locked.add(id)
    }
  } catch {
    // Not a loop session (or no loop state) — session-level lock applies.
  }
  return locked
}

async function editArtifactContent(
  sessionId: string,
  artifactId: string,
  body: { content: string; reason?: string },
  actorId: string,
) {
  const session = await prisma.blueprintSession.findUnique({ where: { id: sessionId } })
  if (!session) throw new NotFoundError('BlueprintSession', sessionId)
  assertBlueprintAccess(session, actorId)

  const artifact = await prisma.blueprintArtifact.findUnique({ where: { id: artifactId } })
  if (!artifact || artifact.sessionId !== sessionId) {
    throw new NotFoundError('BlueprintArtifact', artifactId)
  }

  // (2026-05-31) Universal editability with an approval lock. Every artifact is
  // editable while work is in flight; it locks once the work is approved so an
  // operator edit can't silently rewrite an approved result. Two signals:
  //   1. session finalized — the blueprint was APPROVED or COMPLETED.
  //   2. per-stage (loop profile) — the artifact was produced by a stage
  //      attempt the operator accepted (acceptedAt set = approved / marked done).
  if (session.status === 'APPROVED' || session.status === 'COMPLETED') {
    throw new ValidationError(
      `This blueprint is ${String(session.status).toLowerCase()}; its artifacts are locked. Edits are only allowed before final approval.`,
    )
  }
  if (approvedArtifactIds(session).has(artifact.id)) {
    throw new ValidationError(
      `This artifact's stage has been approved; it is now read-only. Edits are only allowed before a stage is approved.`,
    )
  }

  if (body.content === artifact.content) {
    // No-op edit; don't bother revisioning. Still return the full
    // session so the frontend cache stays consistent.
    return loadSession(session.id, actorId)
  }

  // Snapshot the previous body into payload.revisions[] so the original
  // agent-produced text is never lost. Last entry = most recent
  // pre-edit state.
  const priorPayload = isRecord(artifact.payload) ? artifact.payload : {}
  const priorRevisions = Array.isArray(priorPayload.revisions) ? priorPayload.revisions : []
  const nextPayload: Record<string, unknown> = {
    ...priorPayload,
    revisions: [
      ...priorRevisions,
      {
        content: artifact.content ?? '',
        editedAt: new Date().toISOString(),
        editedBy: actorId,
        reason: body.reason ?? null,
        // length delta is a cheap audit signal — humans can spot a
        // suspicious wholesale-replace without diffing.
        priorChars: (artifact.content ?? '').length,
        nextChars: body.content.length,
      },
    ],
  }

  const updated = await prisma.blueprintArtifact.update({
    where: { id: artifact.id },
    data: {
      content: body.content,
      payload: nextPayload as Prisma.InputJsonValue,
    },
  })

  await recordBlueprintAudit(session.id, 'BlueprintArtifactEdited', actorId, {
    artifactId: updated.id,
    kind: updated.kind,
    title: updated.title,
    priorChars: (artifact.content ?? '').length,
    nextChars: body.content.length,
    reason: body.reason ?? null,
    revisionCount: priorRevisions.length + 1,
  })

  return loadSession(session.id, actorId)
}

/**
 * Tell mcp-server to invalidate any pending approval tokens tied to this
 * workflow run. Called on send-back so the new attempt doesn't inherit a
 * stale "Approve MCP action…" UI prompt or, worse, accidentally resume a
 * tool call from the run we just unwound.
 *
 * Best-effort: a network error here should not block the send-back. If
 * mcp-server is down the pending tokens will expire on their own
 * (MCP_WORKSPACE_LOCK_STALE_MS default 30 min).
 */
async function clearMcpPendingApprovalsFor(workflowInstanceId: string): Promise<void> {
  const url = `${config.MCP_SERVER_URL.replace(/\/$/, '')}/mcp/pending/clear`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.MCP_BEARER_TOKEN}`,
      },
      body: JSON.stringify({ workflowInstanceId }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[sendStageBack] mcp-server pending/clear returned ${res.status}: ${text.slice(0, 200)}`)
    }
  } catch (err) {
    console.warn(`[sendStageBack] mcp-server pending/clear failed (best-effort): ${(err as Error).message}`)
  }
}

async function sendStageBack(
  sessionId: string,
  stageKey: string,
  body: z.infer<typeof sendBackSchema>,
  actorId: string,
) {
  const session = await prisma.blueprintSession.findUnique({ where: { id: sessionId } })
  if (!session) throw new NotFoundError('BlueprintSession', sessionId)
  assertBlueprintAccess(session, actorId)
  const state = readLoopState(session)
  const stage = findLoopStage(state, stageKey)
  const target = findLoopStage(state, body.targetStageKey)
  if (!(stage.allowedSendBackTo ?? []).includes(target.key)) {
    throw new ValidationError(`${stage.label} cannot send work back to ${target.label}`)
  }
  if (sendBackCount(state) >= state.loopDefinition.maxTotalSendBacks) {
    throw new ValidationError(`Session reached the max send-back count (${state.loopDefinition.maxTotalSendBacks})`)
  }
  const latestAttempt = latestStageAttempt(state, stage.key)
  const attempts = latestAttempt ? state.stageAttempts.map(item => item.id === latestAttempt.id ? {
    ...item,
    status: 'NEEDS_REWORK' as const,
    verdict: item.verdict ?? 'NEEDS_REWORK' as const,
    feedback: body.reason,
  } : item) : state.stageAttempts

  // ── Clean-slate rollback for the TARGET stage ───────────────────────────
  // When operators send work back, the target stage should start fresh: the
  // previous attempt's chat history, artifacts, and bookkeeping must NOT
  // leak into the next attempt's agent memory. Previously these stuck around
  // and (a) confused operators with stale "Approve MCP action…" prompts and
  // (b) let the LLM see prior tool turns whose tool_results had been pruned
  // → Anthropic 400 "tool_use without tool_result". See RCA notes.
  const targetAttemptsToRemove = attempts.filter(a => a.stageKey === target.key)
  const targetArtifactIdsToRemove = targetAttemptsToRemove.flatMap(a => a.artifactIds ?? [])

  // 1. Delete artifacts produced by the target stage's prior attempts.
  if (targetArtifactIdsToRemove.length > 0) {
    await prisma.blueprintArtifact.deleteMany({ where: { id: { in: targetArtifactIdsToRemove } } })
  }
  // 2. Reject any published consumables tied to those attempts (mirrors the
  //    reset-attempts endpoint so workflow runs see them as withdrawn).
  for (const attempt of targetAttemptsToRemove) {
    if (attempt.artifactIds?.length) {
      await transitionAttemptConsumables(
        attempt.artifactIds,
        'REJECTED',
        actorId,
        'BlueprintStageConsumablesRejected',
        {
          sessionId: session.id,
          stageKey: target.key,
          stageLabel: target.label,
          targetStageKey: target.key,
          attemptId: attempt.id,
          reason: `Send-back from ${stage.label}: ${body.reason}`,
        },
      ).catch(err => {
        // Don't fail the whole send-back if a consumable transition errors —
        // log via the audit trail and continue. The artifacts are already
        // deleted; this is just consumable-ledger bookkeeping.
        console.warn(`[sendStageBack] failed to reject consumable for attempt ${attempt.id}: ${(err as Error).message}`)
      })
    }
  }
  // 3. Drop target-stage attempts from state so the next attempt is the
  //    "first" again (matches reset-attempts semantics).
  const attemptsAfterClean = attempts.filter(a => a.stageKey !== target.key)
  // 4. Clear the target stage's chat thread so prior operator notes don't
  //    feed back into the next attempt's prompt.
  const stageChats = readStageChats(session.metadata)
  const targetChatHadMessages = Boolean(stageChats[target.key]?.length)
  delete stageChats[target.key]

  const nextState: LoopState = {
    ...state,
    currentStageKey: target.key,
    stageAttempts: attemptsAfterClean,
    reviewEvents: [
      ...state.reviewEvents,
      reviewEvent('SEND_BACK', `${stage.label} sent back to ${target.label}: ${body.reason}`, actorId, {
        stageKey: stage.key,
        targetStageKey: target.key,
        attemptId: latestAttempt?.id,
        reason: body.reason,
        requiredChanges: body.requiredChanges,
        blockingQuestions: body.blockingQuestions ?? [],
        // M60 Slice 2 — line-anchored annotations are persisted on the
        // review event payload so they survive snapshot/replay and can
        // be read back by buildLoopStageVars when assembling the next
        // attempt's task.
        annotations: body.annotations ?? [],
      }),
      // A second event so the UI can show what was cleared. Distinct type
      // from SEND_BACK keeps the dual-purpose nature explicit.
      reviewEvent('STAGE_ATTEMPTS_RESET', `Cleared ${target.label} memory (${targetAttemptsToRemove.length} prior attempt${targetAttemptsToRemove.length === 1 ? '' : 's'}${targetChatHadMessages ? ', chat thread' : ''}) for the new attempt.`, actorId, {
        stageKey: target.key,
        stageLabel: target.label,
        removedAttemptIds: targetAttemptsToRemove.map(a => a.id),
        removedAttemptCount: targetAttemptsToRemove.length,
        removedArtifactCount: targetArtifactIdsToRemove.length,
        clearedChatThread: targetChatHadMessages,
        triggeredBy: 'send-back',
      }),
    ],
  }
  await prisma.blueprintSession.update({
    where: { id: session.id },
    data: {
      status: BlueprintSessionStatus.SNAPSHOTTED,
      metadata: {
        ...(stateToMetadata(session, nextState) as Record<string, unknown>),
        stageChats,
      },
    },
  })
  if (latestAttempt?.artifactIds?.length) {
    await transitionAttemptConsumables(
      latestAttempt.artifactIds,
      'REJECTED',
      actorId,
      'BlueprintStageConsumablesRejected',
      {
        sessionId: session.id,
        stageKey: stage.key,
        stageLabel: stage.label,
        targetStageKey: target.key,
        attemptId: latestAttempt.id,
        reason: body.reason,
      },
    )
  }
  await recordBlueprintAudit(session.id, 'BlueprintStageSentBack', actorId, {
    stageKey: stage.key,
    stageLabel: stage.label,
    targetStageKey: target.key,
    targetStageLabel: target.label,
    attemptId: latestAttempt?.id,
    reason: body.reason,
    requiredChanges: body.requiredChanges,
    blockingQuestions: body.blockingQuestions ?? [],
    // M60 Slice 2 — annotation count only in audit (the structured
    // payload lives on the review event); ledger consumers can join
    // back to the SEND_BACK review event by attemptId.
    annotationsCount: body.annotations?.length ?? 0,
    cleanedTargetAttempts: targetAttemptsToRemove.length,
    cleanedTargetArtifacts: targetArtifactIdsToRemove.length,
    clearedTargetChatThread: targetChatHadMessages,
  })
  // Best-effort: invalidate any pending MCP approval tokens for this workflow
  // so the new attempt doesn't see stale "Approve MCP action…" prompts.
  if (session.workflowInstanceId) {
    await clearMcpPendingApprovalsFor(session.workflowInstanceId)
  }
  return loadSession(session.id, actorId)
}

async function finalizeLoop(sessionId: string, actorId: string) {
  const session = await prisma.blueprintSession.findUnique({
    where: { id: sessionId },
    include: { artifacts: { orderBy: { createdAt: 'asc' } } },
  })
  if (!session) throw new NotFoundError('BlueprintSession', sessionId)
  assertBlueprintAccess(session, actorId)
  const state = readLoopState(session)
  if (!session.workflowInstanceId && hasUnresolvedWorkflowLink(state)) {
    throw new ValidationError('This Workbench session was opened from a workflow link that could not be resolved, so it cannot publish consumables or advance the workflow. Start a new Workbench session from the active workflow run.')
  }
  // M70.7 — Idempotent re-handoff path. When the parent workflow is
  // restarted (NODE_RESTARTED on Start), the Workbench node bounces
  // back to ACTIVE while the session keeps its prior `finalPack`. The
  // operator needs a way to re-send the existing pack and advance the
  // node without re-running every stage. If we already have a
  // finalPack, skip the build-pack + publish-consumable steps and just
  // re-call attachFinalPackToWorkflowNode → completeLinkedWorkbenchTask
  // → advance(). attachFinalPackToWorkflowNode is already safe to
  // re-run (it overwrites the node.config.workbench block), and
  // completeLinkedWorkbenchTask no-ops on already-completed nodes.
  if (state.finalPack && session.workflowInstanceId && state.workflowNodeId) {
    await attachFinalPackToWorkflowNode(session, state.finalPack, actorId, session.artifacts)
    await recordBlueprintAudit(session.id, 'BlueprintFinalizeReplayed', actorId, {
      finalPackId: state.finalPack.id,
      workflowInstanceId: session.workflowInstanceId,
      workflowNodeId: state.workflowNodeId,
      reason: 'workflow node re-activated after restart; re-attached existing pack',
    })
    return loadSession(session.id, actorId)
  }
  if (!isLoopGreen(state)) {
    throw new ValidationError('All required loop stages must be passed or accepted with risk before finalizing')
  }
  const finalPack = buildFinalPack(state, session.artifacts, actorId)
  const artifact = await prisma.blueprintArtifact.create({
    data: {
      sessionId: session.id,
      kind: 'final_implementation_pack',
      title: 'Final implementation pack',
      content: buildFinalPackMarkdown(finalPack, state),
      payload: { finalPack, stageKey: state.currentStageKey, version: 1 } as Prisma.InputJsonValue,
    },
  })
  const finalConsumable = await publishBlueprintArtifactAsConsumable({
    session,
    artifact,
    actorId,
    typeName: 'WORKBENCH_FINAL_PACK',
    status: 'PUBLISHED',
    extraPayload: {
      finalPack,
      stageConsumables: finalPack.stageConsumables ?? [],
      consumableIds: finalPack.consumableIds ?? [],
    },
  })
  const stampedPack: FinalPack = {
    ...finalPack,
    artifactKinds: [...finalPack.artifactKinds, artifact.kind],
    finalPackArtifactId: artifact.id,
    finalPackConsumableId: finalConsumable?.consumableId,
    finalPackConsumableVersion: finalConsumable?.consumableVersion,
    consumableIds: uniqueStrings([
      ...(finalPack.consumableIds ?? []),
      finalConsumable?.consumableId,
    ]),
  }
  const finalArtifactPayload = {
    finalPack: stampedPack,
    stageKey: state.currentStageKey,
    version: 1,
    consumableId: stampedPack.finalPackConsumableId,
    consumableVersion: stampedPack.finalPackConsumableVersion,
    consumableStatus: finalConsumable?.status,
    stageConsumables: stampedPack.stageConsumables ?? [],
    consumableIds: stampedPack.consumableIds ?? [],
  } satisfies Record<string, unknown>
  await prisma.blueprintArtifact.update({
    where: { id: artifact.id },
    data: {
      payload: finalArtifactPayload as Prisma.InputJsonValue,
    },
  })
  const handoffArtifacts = [
    ...session.artifacts,
    {
      ...artifact,
      payload: finalArtifactPayload as Prisma.JsonValue,
    },
  ]
  const finalizedState: LoopState = {
    ...state,
    finalPack: stampedPack,
    reviewEvents: [...state.reviewEvents, reviewEvent('FINALIZED', 'Final implementation pack generated for workflow handoff.', actorId, {
      artifactId: artifact.id,
      finalPackConsumableId: stampedPack.finalPackConsumableId,
      consumableIds: stampedPack.consumableIds ?? [],
    })],
  }
  await prisma.blueprintSession.update({
    where: { id: session.id },
    data: {
      status: BlueprintSessionStatus.APPROVED,
      approvedById: actorId,
      approvedAt: new Date(),
      metadata: stateToMetadata(session, finalizedState),
    },
  })
  await attachFinalPackToWorkflowNode(session, stampedPack, actorId, handoffArtifacts)
  await recordBlueprintAudit(session.id, 'BlueprintFinalized', actorId, {
    artifactId: artifact.id,
    finalPackId: stampedPack.id,
    finalPackConsumableId: stampedPack.finalPackConsumableId,
    consumableIds: stampedPack.consumableIds ?? [],
    workflowInstanceId: session.workflowInstanceId,
    workflowNodeId: state.workflowNodeId,
  })
  return loadSession(session.id, actorId)
}

async function runLoopStageExecute(
  session: Awaited<ReturnType<typeof prisma.blueprintSession.findUnique>> & { id: string },
  snapshot: { id?: string; summary: Prisma.JsonValue; manifest: Prisma.JsonValue; rootHash: string | null } | undefined,
  stage: LoopStageDefinition,
  attempt: StageAttempt,
  task: string,
  // M36.2 — resolved by caller from prompt-composer (was: loopStageSystemPrompt(stage))
  systemPromptAppend: string,
  // M36.6 — resolved by caller from prompt-composer (was: inline isDeveloperStage ternary)
  extraContext: string,
): Promise<CodingRunResult> {
  const traceId = `blueprint-${session.id}-${stage.key}`
  const state = readLoopState(session)
  const executionConfig = state.executionConfig
  const modelAlias = stageModelAlias(executionConfig, stage.key, stage.label)
  // M100 — per-phase model overrides for this stage (if the operator pinned
  // any). CF routes each governed phase to its alias, falling back to
  // `modelAlias` for unset phases. Undefined → single stage model (legacy).
  const phaseModelAliasMap = phaseModelAliases(executionConfig, stage.key, stage.label)
  const limits = workbenchExecutionLimits(executionConfig)
  const isDeveloperStage = stageAllowsMutation(stage)
  const usesRepoContext = stageUsesRepoContext(stage)
  // (2026-05-25) Full stageVars bundle — needed so the governed path
  // surfaces capturedDecisions, latestAccepted, sendBacks, operatorChat,
  // questions, artifacts, priorApprovedArtifacts, implementationDirective,
  // and priorAttemptLearnings to the per-phase prompts. The previous
  // implementation cherry-picked a subset and silently dropped operator-
  // facing inputs — most visibly, "Save & re-run with answers" had no
  // effect because capturedDecisions never reached context-fabric. The
  // legacy /execute path called buildLoopStageVars implicitly via the
  // pre-rendered `task` body; the governed path needs the vars spread
  // explicitly because each per-phase prompt picks the ones it needs.
  const stageVars = await buildLoopStageVars(session, stage, state)
  const linkedWorkItem = await workflowWorkItemContext(session.workflowInstanceId)
  const agentTemplateId = attempt.agentTemplateId
  const executeArtifacts = usesRepoContext && snapshot
    ? [{
        label: 'Source snapshot',
        role: 'CONTEXT',
        mediaType: 'application/json',
        content: encodeComposerArtifactContent(buildSnapshotExecuteArtifact(snapshot, {
          stageKey: stage.key,
          stageLabel: stage.label,
          task,
          snapshotMode: executionConfig?.snapshotMode,
          excerptBudgetChars: executionConfig?.excerptBudgetChars,
        })),
      }]
    : [{
        label: 'Story intake context',
        role: 'CONTEXT',
        mediaType: 'application/json',
        content: JSON.stringify({
          goal: session.goal,
          stageKey: stage.key,
          stageLabel: stage.label,
          contextPolicy: stage.contextPolicy,
          repoAccess: false,
          guidance: 'Story-only stage. Do not use repository/source context; capture business intent, acceptance criteria, scope, risks, and open questions.',
        }),
      }]
  const policy = classifyCodingStagePolicy({
    key: stage.key,
    label: stage.label,
    agentRole: stage.agentRole,
    terminal: stage.terminal,
    contextPolicy: stage.contextPolicy,
    toolPolicy: stage.toolPolicy,
  })
  // M71 Slice F — Governed-loop cutover.
  //
  // context-fabric now drives the entire stage server-side: it loads the
  // StagePolicy from prompt-composer, resolves the per-phase prompt, calls
  // llm-gateway, hard-refuses out-of-phase tool calls (PHASE_TOOL_FORBIDDEN),
  // dispatches allowed calls to mcp-server /mcp/tool-run, validates phase
  // receipts, and advances the state machine. The legacy /execute → mcp /invoke
  // chain is retired (POST /mcp/invoke now returns 410 — see Slice I).
  //
  // Most of the old executeRequest fields are no longer needed:
  //   - prior_verification_receipts: receipts persist in PhaseState.receipts
  //   - overrides.systemPromptAppend/extraContext: resolved per-phase
  //   - context_policy / limits: sourced from StagePolicy.{contextPolicy,limits}
  //   - allow_autonomous_mutation: implied by StagePolicy.editPolicy
  //   - governance_mode: future — wire when context-fabric exposes the knob
  //
  // What we still pass:
  //   - vars (mustache substitution context for the per-phase prompt)
  //   - run_context (workflow correlation for audit + sandbox routing)
  //   - model_alias (forwarded to llm-gateway)
  //
  // Phase-state continuity: future iteration will read the saved
  // BlueprintSession.metadata.phaseStateByStage[stageKey] here so a resumed
  // stage picks up where it left off. For now each attempt starts from a
  // fresh PLAN — context-fabric mints PhaseState.fresh() when phase_state
  // is omitted.
  //
  // The pre-resolved `task`, `systemPromptAppend`, and `extraContext`
  // arguments to this function are no longer needed under the governed
  // path (prompt-composer is called per-phase server-side). They stay in
  // the signature to keep older call sites in this router working without
  // a sweep; we explicitly mark them used here to satisfy noUnusedLocals.
  void executeArtifacts; void systemPromptAppend; void extraContext;

  // M74 Phase 2B — closed-loop wiring. Before launching this attempt,
  // ask audit-gov whether the previous attempt of this stage was blocked
  // by a quality-gate failure. If so, the structured feedback (judge
  // score + reason + failing examples) rides into vars.eval_feedback,
  // where context-fabric's stage_driver renders it as a user message at
  // the head of the first turn's prompt. The agent then sees its prior
  // failure mode and can address it explicitly.
  //
  // Fail-soft: audit-gov outage just returns null; the stage launches as
  // a first-attempt would. The lookup is keyed on workflowInstanceId
  // (EvalGateExecutor's join key) with stageKey as an optional narrower
  // filter so we don't pull feedback from a sibling stage's gate.
  const workflowInstanceIdForFeedback = session.workflowInstanceId ?? undefined
  const evalFeedback = workflowInstanceIdForFeedback
    ? await fetchEvalFeedback({
        workflowInstanceId: workflowInstanceIdForFeedback,
        stageKey: stage.key,
      })
    : null

  // M93.D (2026-05-27) — Build the workflow's resolved StageExecutionPolicy
  // from the WorkbenchStage row's policy fields. Pre-M93.D the blueprint
  // path put these in `vars` (so per-phase prompts could interpolate
  // them) but did NOT pass them as a structured stage_execution_policy
  // to context-fabric — meaning M91.A's runtime tool filtering only
  // ran for non-blueprint callers. tool_policy=READ_ONLY pinned on a
  // QA stage in the designer was decoration for every real coding
  // session that ran through here.
  //
  // CF's apply_execution_policy treats this as an override layer on top
  // of the DB-seeded StagePolicy:
  //   - tool_policy / repo_access filter the per-phase allowed_tools.
  //   - context_policy is recorded for audit (M93.G will make it bind).
  //   - prompt_profile_key overrides StagePromptBinding resolution
  //     (M93.F wires this through resolve_phase_prompt).
  //
  // We populate only when the WorkbenchStage actually has the fields
  // set; an empty policy would be a no-op anyway, but skipping the
  // object keeps the wire payload smaller and keeps CF's
  // "no override → use base policy" path identical to pre-M91.A
  // behaviour for stages the operator hasn't pinned anything on.
  const stageExecutionPolicy = (() => {
    const contextPolicy = stage.contextPolicy?.trim() || undefined
    const toolPolicy = stage.toolPolicy?.trim() || undefined
    // usesRepoContext was computed earlier in this function as the
    // effective repo-access decision for the stage; that's the truth
    // we want to ship (not raw stage.repoAccess which may be the
    // operator's literal toggle pre-derivation).
    const repoAccess: boolean | undefined =
      typeof stage.repoAccess === 'boolean' ? stage.repoAccess : usesRepoContext
    const promptProfileKey = stage.promptProfileKey?.trim() || undefined
    // M99 — forward the Phase 0 automation flags when the stage declares them
    // (undefined when not set, so CF keeps its env-flag default).
    //
    // Code-edit stages (contextPolicy CODE_EDIT / toolPolicy MUTATION) default
    // auto_baseline=true: WorkbenchStage has no autoBaseline column, so a loop
    // definition can never turn it on, yet a pre-edit test baseline is exactly
    // what the verification gate needs to tell pre-existing failures apart from
    // new regressions on these stages. An explicit stage.autoBaseline still
    // wins, and CF's CF_AUTO_BASELINE_ENABLED env flag remains the master gate
    // (both must be on — see governed_automation.automation_enabled).
    const isCodeEditStage =
      stage.contextPolicy?.trim().toUpperCase() === 'CODE_EDIT' ||
      stage.toolPolicy?.trim().toUpperCase() === 'MUTATION'
    const m99 = {
      auto_localize: stage.autoLocalize,
      auto_baseline: stage.autoBaseline ?? (isCodeEditStage ? true : undefined),
      auto_verify: stage.autoVerify,
      git_preflight_required: stage.gitPreflightRequired,
    }
    const hasM99 = Object.values(m99).some(v => v !== undefined)
    if (!contextPolicy && !toolPolicy && repoAccess === undefined && !promptProfileKey && !hasM99) {
      return undefined
    }
    return {
      stage_key: stage.key,
      agent_role: stage.agentRole ?? undefined,
      context_policy: contextPolicy,
      tool_policy: toolPolicy,
      repo_access: repoAccess,
      prompt_profile_key: promptProfileKey,
      ...m99,
    }
  })()

  return runCodingStageGoverned({
    stageKey: stage.key,
    agentRole: stage.agentRole,
    policy,
    modelAlias,
    phaseModelAliases: phaseModelAliasMap,
    stageExecutionPolicy,
    vars: {
      // (2026-05-25) Spread the full stageVars bundle FIRST so all the
      // operator-facing context (capturedDecisions, latestAccepted,
      // sendBacks, operatorChat, questions, artifacts, ...) reaches
      // the per-phase prompts. This is what makes "Save & re-run with
      // answers" actually work — without spreading capturedDecisions
      // the agent re-runs blind to the operator's answers.
      ...stageVars,
      blueprintSessionId: session.id,
      // M74 Phase 2B — present only when there's prior-attempt feedback to
      // surface. context-fabric's stage_driver checks vars.eval_feedback and
      // injects the synthetic prompt message only when this key is set.
      ...(evalFeedback ? { eval_feedback: evalFeedback } : {}),
      // Explicit overrides for vars that need different values than
      // buildLoopStageVars produces. These all match what stageVars
      // already has but stay explicit so a code reader can see the
      // contract at the call site.
      goal: session.goal ?? '',
      stageKey: stage.key,
      stageLabel: stage.label,
      // The pre-rendered task body still flows through so prompt-composer's
      // top-level loopDefaultTask vars resolve when a phase-specific binding
      // doesn't exist. Phase-specific prompts (Slice E) reference the
      // individual vars from stageVars above; this `task` is the legacy
      // fallback for stage-level bindings.
      task,
      stageDescription: stage.description ?? '',
      agentRole: stage.agentRole ?? '',
      stageContextPolicy: stage.contextPolicy,
      stageToolPolicy: stage.toolPolicy,
      stageRepoAccess: usesRepoContext,
      promptProfileKey: stage.promptProfileKey ?? '',
      sourceType: usesRepoContext ? session.sourceType : '',
      sourceUri: usesRepoContext ? session.sourceUri : '',
      sourceRef: usesRepoContext ? session.sourceRef : '',
      modelAlias,
    },
    runContext: {
      workflow_instance_id: session.workflowInstanceId ?? `blueprint-${session.id}`,
      workflow_node_id: readLoopState(session).workflowNodeId ?? session.phaseId ?? `blueprint-${stage.key}`,
      agent_run_id: isDeveloperStage ? attempt.id : undefined,
      // M81 P2/P4 (2026-05-26) — attempt_id is intentionally NOT passed.
      // The M72 Slice C per-attempt isolation has been replaced by the
      // no-parallel-attempts guard (e8cb38a), and the new long-lived
      // workitem branch (wi/<workItemCode>) gives every stage attempt
      // continuity into the prior work without needing a separate
      // worktree. Passing attemptId here would put each call into its
      // own .singularity/workitems/<workItem>/attempts/<id>/ directory,
      // causing the worktree-split bug (different tools landing in
      // different worktrees in the same logical attempt).
      work_item_id: linkedWorkItem.workItemId,
      work_item_code: linkedWorkItem.workItemCode,
      capability_id: session.capabilityId,
      agent_template_id: agentTemplateId,
      user_id: session.createdById ?? undefined,
      trace_id: traceId,
      branch_base: isDeveloperStage ? session.sourceRef ?? undefined : undefined,
      // M81 P4 (2026-05-26) — workitem-scoped long-lived branch. ALL stages
      // (not just developer) share the same wi/<workItemCode> branch so
      // QA/security/devops see the developer's commits naturally. The
      // mcp-server source-materializer (P1) checks remote first, then
      // local cache, then creates from sourceRef. finish_work_branch (P3)
      // auto-pushes when the active branch starts with wi/. Without a
      // workItemCode we fall back to the legacy per-attempt name so old
      // sessions still work.
      // (2026-06-02) Stage-INDEPENDENT shared worktree branch for ALL
      // repo-using stages (not just developer). Pre-fix, an unbound workbench
      // session (no _workItem) left workitem_branch undefined and gave only
      // the developer stage a per-stage branch_name — so review stages
      // resolved to the shared base /workspace, re-cloned, and couldn't see
      // the developer's committed diff. workbenchWorkitemBranch() falls back
      // to the workflow instance id; a bound WorkItem code still wins.
      // Story-only stages (usesRepoContext=false) keep no branch.
      branch_name: usesRepoContext ? workbenchWorkitemBranch(session, linkedWorkItem) : undefined,
      workitem_branch: usesRepoContext ? workbenchWorkitemBranch(session, linkedWorkItem) : undefined,
      source_type: usesRepoContext ? session.sourceType.toLowerCase() : undefined,
      source_uri: usesRepoContext ? session.sourceUri : undefined,
      source_ref: usesRepoContext ? session.sourceRef ?? undefined : undefined,
      // M75 Slice 4 — opt-in laptop bridge routing for governed stages.
      // The legacy AgentTaskExecutor path reads this from cfg.preferLaptop
      // on the workflow node; the governed coding stage doesn't have a
      // per-node config, so we honor an operator toggle stashed on the
      // BlueprintSession.metadata.preferLaptop instead. Semantics in cf:
      //   true  → route via this user's laptop mcp-server (HTTP fallback
      //           if the WS bridge has no live connection).
      //   false → force HTTP (never use the laptop, even if connected).
      //   unset → HTTP only — auto-prefer-when-available is a future
      //           enhancement that needs upstream "is bridge live?" plumbing.
      // Per docs/M75-laptop-bridge-cutover.md Slice 4. The key is omitted
      // entirely when undefined so dispatch.py's `if prefer_laptop is True`
      // short-circuit stays tight.
      ...readPreferLaptopFlag(session.metadata),
    },
    // Per-stage execution budget — workflow-declared limit wins, with
    // env-based role-class defaults as the fallback. See
    // resolveStageMaxSteps / resolveStageTimeoutSec.
    maxTurns: resolveStageMaxSteps(stage),
    timeoutSec: resolveStageTimeoutSec(stage),
  })
}

function jsonStringField(root: unknown, key: string): string | undefined {
  if (!isRecord(root)) return undefined
  const value = root[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

async function workflowWorkItemContext(workflowInstanceId?: string | null): Promise<{ workItemId?: string; workItemCode?: string }> {
  const instanceId = typeof workflowInstanceId === 'string' && workflowInstanceId.trim()
    ? workflowInstanceId.trim()
    : undefined
  if (!instanceId) return {}
  const instance = await prisma.workflowInstance.findUnique({
    where: { id: instanceId },
    select: { context: true },
  })
  const context = isRecord(instance?.context) ? instance.context : {}
  const workItem = isRecord(context._workItem)
    ? context._workItem
    : isRecord(context.workItem)
      ? context.workItem
      : {}
  return {
    workItemId: jsonStringField(workItem, 'id') ?? jsonStringField(context, 'workItemId'),
    workItemCode: jsonStringField(workItem, 'workCode') ?? jsonStringField(context, 'workItemCode'),
  }
}

/**
 * Stage-INDEPENDENT shared worktree branch for a workbench governed run.
 *
 * Every repo-using stage of a single run MUST land on the same wi/<id> branch
 * — and therefore the same per-workitem worktree — so DEVELOP commits and
 * SECURITY/QA review stages see that committed diff. The identity is the bound
 * WorkItem's code when present, otherwise the workflow instance id (a workbench
 * run launched directly by URL has no _workItem bound in the workflow context),
 * finally the session id.
 *
 * This deliberately does NOT embed the stage key or attempt id: doing so
 * (the prior per-stage `sg/<id>/<stage>/<attempt>` scheme) gave every stage a
 * *different* branch/worktree and left non-developer stages with none, so
 * review stages fell back to the shared base /workspace, re-cloned a fresh
 * tree, and reported "cannot verify implementation without diff". `wi/`-
 * prefixed branches also auto-push on finish_work_branch (mcp-server P3), so
 * the dev's commits become fetchable by later stages.
 */
export function workbenchWorkitemBranch(
  session: { id: string; workflowInstanceId?: string | null },
  linkedWorkItem?: { workItemCode?: string | null } | null,
): string {
  const identity =
    linkedWorkItem?.workItemCode?.trim()
    || session.workflowInstanceId?.trim()
    || `blueprint-${session.id}`
  return `wi/${identity}`
    .replace(/[^a-zA-Z0-9._/-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180)
}

async function createLoopStageArtifacts(
  session: ArtifactSession,
  snapshot: ArtifactSnapshot | undefined,
  stage: LoopStageDefinition,
  attempt: StageAttempt,
  result: ExecuteResponse,
  gateRecommendation: GateRecommendation,
  actorId?: string,
): Promise<string[]> {
  const ctx = snapshot ? buildSnapshotContext(snapshot) : emptySnapshotContext()
  const response = isUsefulModelResponse(result.finalResponse) ? result.finalResponse ?? '' : ''
  const executionFallback = buildExecutionFallbackMarkdown(result)
  // (2026-05-29) Deterministic branch fallback for code-change evidence.
  // The governed loop commits on the same branch run_context declared
  // (wi/<code>, or the per-attempt workbench branch), but when its
  // finish_work_branch result didn't surface a branch, the artifact would
  // record an empty workspaceBranch and dead-end GitPushExecutor at
  // NO_COMMIT_TO_PUSH. Recompute that branch name the same way run_context
  // does so the evidence carries it. Mirrors the branch_name logic at the
  // run_context build site above. Only resolved for code-change stages to
  // avoid an extra WorkItem lookup on plan/design attempts.
  const isCodeChangeStage =
    (stage.expectedArtifacts ?? []).some(artifact => isCodeChangeArtifactKind(artifact.kind))
    || normalizeAgentRole(stage.agentRole).includes('DEV')
  let codeChangeEvidenceFallback: { workspaceBranch?: string } | undefined
  if (isCodeChangeStage) {
    const linkedWorkItem = await workflowWorkItemContext(session.workflowInstanceId)
    codeChangeEvidenceFallback = {
      // Must mirror the run_context branch_name logic at the build site above
      // (now workbenchWorkitemBranch) so the git-push evidence points at the
      // branch the stage actually committed on — else GitPushExecutor
      // dead-ends at NO_COMMIT_TO_PUSH.
      workspaceBranch: workbenchWorkitemBranch(session, linkedWorkItem),
    }
  }
  const commonPayload = {
    workflowInstanceId: session.workflowInstanceId ?? undefined,
    workflowNodeId: readLoopState(session).workflowNodeId ?? undefined,
    stageKey: stage.key,
    stageLabel: stage.label,
    attemptId: attempt.id,
    version: attempt.attemptNumber,
    agentRole: stage.agentRole,
    agentTemplateId: attempt.agentTemplateId,
    gateRecommendation,
    cfCallId: result.correlation.cfCallId,
    traceId: result.correlation.traceId,
    promptAssemblyId: result.correlation.promptAssemblyId,
    mcpInvocationId: result.correlation.mcpInvocationId,
    codeChangeIds: result.correlation.codeChangeIds ?? [],
    tokensUsed: result.tokensUsed ?? {},
    modelUsage: result.modelUsage ?? {},
    usage: result.usage ?? {},
    metrics: result.metrics ?? {},
    warnings: result.warnings ?? [],
  }
  const baseContent = buildLoopStageMarkdown(session, ctx, stage, attempt, response, gateRecommendation, executionFallback)
  const specs: Array<{ kind: string; title: string; content: string; payload?: Record<string, unknown> }> = [
    {
      kind: `loop_${stage.key}_attempt`,
      title: `${stage.label} attempt ${attempt.attemptNumber}`,
      content: baseContent,
    },
  ]
  if ((stage.expectedArtifacts ?? []).length > 0) {
    specs.push(...(stage.expectedArtifacts ?? []).map(artifact => {
      if (isCodeChangeArtifactKind(artifact.kind)) {
        const evidence = buildActualCodeChangeEvidence(session, ctx, result, codeChangeEvidenceFallback)
        return {
          kind: 'actual_code_change',
          title: `Actual MCP/git code-change evidence v${attempt.attemptNumber}`,
          content: evidence.markdown,
          payload: {
            expectedArtifact: { ...artifact, kind: 'actual_code_change', title: 'Actual MCP/git code-change evidence' },
            artifactRequired: artifact.required !== false,
            approvalRequired: stage.approvalRequired !== false,
            paths: evidence.paths,
            diff: evidence.diff,
            lines_added: evidence.linesAdded,
            lines_removed: evidence.linesRemoved,
            actual: evidence.actual,
            simulated: false,
            codeChangeIds: evidence.codeChangeIds,
            workspaceBranch: evidence.workspaceBranch,
            workspaceCommitSha: evidence.workspaceCommitSha,
            workspaceRoot: evidence.workspaceRoot,
            astIndexStatus: evidence.astIndexStatus,
          },
        }
      }
      return {
        kind: artifact.kind,
        title: `${artifact.title} v${attempt.attemptNumber}`,
        content: buildConfiguredArtifactMarkdown(session, ctx, stage, attempt, response, executionFallback, gateRecommendation, artifact),
        payload: {
          expectedArtifact: artifact,
          artifactRequired: artifact.required !== false,
          approvalRequired: stage.approvalRequired !== false,
        },
      }
    }))
  } else if (stage.key === 'plan') {
    specs.push(
      { kind: 'mental_model', title: `Mental model v${attempt.attemptNumber}`, content: buildMentalModel(session, ctx) },
      { kind: 'gaps', title: `Gaps v${attempt.attemptNumber}`, content: buildGaps(session, ctx) },
    )
  } else if (stage.key === 'design') {
    specs.push(
      { kind: 'solution_architecture', title: `Solution architecture v${attempt.attemptNumber}`, content: buildSolutionArchitecture(session, ctx) },
      { kind: 'approved_spec_draft', title: `Spec draft v${attempt.attemptNumber}`, content: buildApprovedSpec(session, ctx, response) },
    )
  } else if (normalizeAgentRole(stage.agentRole).includes('DEV')) {
    const codeChangeEvidence = buildActualCodeChangeEvidence(session, ctx, result, codeChangeEvidenceFallback)
    specs.push(
      { kind: 'developer_task_pack', title: `Developer task pack v${attempt.attemptNumber}`, content: buildDeveloperTaskPack(session, ctx, response) },
      {
        kind: 'actual_code_change',
        title: `Actual MCP/git code-change evidence v${attempt.attemptNumber}`,
        content: codeChangeEvidence.markdown,
        payload: {
          paths: codeChangeEvidence.paths,
          diff: codeChangeEvidence.diff,
          lines_added: codeChangeEvidence.linesAdded,
          lines_removed: codeChangeEvidence.linesRemoved,
          actual: codeChangeEvidence.actual,
          simulated: false,
          codeChangeIds: codeChangeEvidence.codeChangeIds,
          workspaceBranch: codeChangeEvidence.workspaceBranch,
          workspaceCommitSha: codeChangeEvidence.workspaceCommitSha,
          workspaceRoot: codeChangeEvidence.workspaceRoot,
          astIndexStatus: codeChangeEvidence.astIndexStatus,
        },
      },
    )
  } else if (stage.key.includes('test') || stage.terminal) {
    specs.push(
      { kind: 'verification_rules', title: `Verification rules v${attempt.attemptNumber}`, content: buildVerificationRules(session, ctx) },
      { kind: 'traceability_matrix', title: `Traceability matrix v${attempt.attemptNumber}`, content: buildTraceabilityMatrix() },
      { kind: 'certification_receipt', title: `Certification receipt v${attempt.attemptNumber}`, content: buildCertificationReceipt(session, ctx) },
    )
  } else {
    specs.push({ kind: 'qa_task_pack', title: `QA task pack v${attempt.attemptNumber}`, content: buildQaTaskPack(session, ctx, response) })
  }

  const artifactIds: string[] = []
  for (const spec of specs) {
    const artifact = await prisma.blueprintArtifact.create({
      data: {
        sessionId: session.id,
        stage: legacyStage(stage),
        kind: spec.kind,
        title: spec.title,
        content: spec.content,
        payload: { ...commonPayload, ...(spec.payload ?? {}) } as Prisma.InputJsonValue,
      },
    })
    artifactIds.push(artifact.id)
    await publishBlueprintArtifactAsConsumable({
      session,
      artifact,
      actorId,
      typeName: 'WORKBENCH_STAGE_ARTIFACT',
      status: stage.approvalRequired !== false ? 'UNDER_REVIEW' : 'APPROVED',
      stage,
      attempt,
      extraPayload: spec.payload ?? {},
    })
  }
  return artifactIds
}

function buildExecutionFallbackMarkdown(result: ExecuteResponse) {
  const warnings = (result.warnings ?? []).filter(Boolean)
  const modelAlias = result.modelUsage?.modelAlias ?? result.usage?.modelAlias ?? result.correlation.modelAlias
  const provider = result.modelUsage?.provider ?? result.usage?.provider
  const model = result.modelUsage?.model ?? result.usage?.model
  const estimatedCost = result.modelUsage?.estimatedCost ?? result.usage?.estimatedCost
  const inputTokens = result.tokensUsed?.input ?? result.modelUsage?.inputTokens ?? result.usage?.inputTokens
  const outputTokens = result.tokensUsed?.output ?? result.modelUsage?.outputTokens ?? result.usage?.outputTokens
  const totalTokens = result.tokensUsed?.total ?? result.modelUsage?.totalTokens ?? result.usage?.totalTokens
  const promptCache = result.modelUsage?.promptCache ?? result.usage?.promptCache ?? result.promptCache ?? result.tokensUsed?.promptCache
  const promptCacheSummary = promptCache
    ? `- Prompt cache: reported=${String(promptCache.reported ?? false)}, read=${String(promptCache.cacheReadTokens ?? 0)}, write=${String(promptCache.cacheWriteTokens ?? 0)}`
    : undefined
  const lines = [
    'No model-authored narrative was returned for this stage. The artifact was generated from the source snapshot, gate evidence, and execution receipt below.',
    '',
    '### Execution receipt',
    `- Status: ${result.status || 'unknown'}`,
    result.finishReason ? `- Finish reason: ${result.finishReason}` : undefined,
    result.blockedReason ? `- Blocked reason: ${result.blockedReason}` : undefined,
    result.governanceMode || result.executionPosture
      ? `- Governance: ${[result.governanceMode, result.executionPosture].filter(Boolean).join(' / ')}`
      : undefined,
    modelAlias ? `- Model alias: ${modelAlias}` : undefined,
    provider || model ? `- Resolved model: ${[provider, model].filter(Boolean).join(' / ')}` : undefined,
    totalTokens != null ? `- Tokens: input=${inputTokens ?? 0}, output=${outputTokens ?? 0}, total=${totalTokens ?? 0}` : undefined,
    estimatedCost != null ? `- Estimated cost: ${estimatedCost}` : undefined,
    promptCacheSummary,
    '',
    '### Correlation',
    result.correlation.cfCallId ? `- Context Fabric call: ${result.correlation.cfCallId}` : undefined,
    result.correlation.promptAssemblyId ? `- Prompt assembly: ${result.correlation.promptAssemblyId}` : undefined,
    result.correlation.mcpInvocationId ? `- MCP invocation: ${result.correlation.mcpInvocationId}` : undefined,
    result.correlation.contextPlanHash ? `- Context plan hash: ${result.correlation.contextPlanHash}` : result.contextPlanHash ? `- Context plan hash: ${result.contextPlanHash}` : undefined,
    '',
    warnings.length ? '### Warnings' : undefined,
    ...warnings.map(warning => `- ${warning}`),
  ].filter(Boolean)
  return lines.join('\n')
}

function buildConfiguredArtifactMarkdown(
  session: ArtifactSession,
  ctx: SnapshotContext,
  stage: LoopStageDefinition,
  attempt: StageAttempt,
  response: string,
  executionFallback: string,
  gate: GateRecommendation,
  artifact: LoopExpectedArtifact,
) {
  return [
    `# ${artifact.title}`,
    '',
    `Stage: ${stage.label} (${stage.key})`,
    `Agent role: ${stage.agentRole}`,
    `Attempt: ${attempt.attemptNumber}`,
    `Required: ${artifact.required !== false ? 'yes' : 'no'}`,
    `Format: ${artifact.format ?? 'MARKDOWN'}`,
    '',
    artifact.description ? `## Artifact intent\n${artifact.description}` : undefined,
    '## Workbench output',
    response || executionFallback,
    '',
    '## Gate recommendation',
    `- Verdict: ${gate.verdict}`,
    `- Confidence: ${Math.round(gate.confidence * 100)}%`,
    `- Reason: ${gate.reason}`,
    '',
    '## Source context signal',
    `- Goal: ${session.goal}`,
    `- Languages: ${Object.keys(ctx.languages).join(', ') || 'unknown'}`,
    `- Key files: ${ctx.keyFiles.slice(0, 5).join(', ') || 'none detected'}`,
    `- Sampled files: ${ctx.sampledFiles.length}`,
    '',
    '## Human approval',
    stage.approvalRequired !== false
      ? 'This artifact must be reviewed and approved, accepted with risk, or sent back before the loop can advance.'
      : 'This stage is configured for automatic progression after execution.',
  ].filter(Boolean).join('\n')
}

// M36.2 — was: loopStageTask() + loopStageSystemPrompt() inline functions.
// Now: build the Mustache var dict that prompt-composer's `loop.stage`
// StagePromptBinding templates consume. The text content lives in
// prompt-composer/prisma/seed.ts (loopDefaultTask, loopDeveloperTask,
// loopQaTask). Edit there + re-seed to roll forward — no redeploy here.
type LoopArtifactContextRecord = {
  id: string
  kind: string
  title: string
  content?: string | null
}

// M102 — render the stage's expected-artifact contract for the agent prompt
// ({{artifacts}}). Each artifact is a line; when it links a catalog
// ArtifactTemplate (templateId), the template's section skeleton is appended
// so the agent fills the catalog's structure (e.g. Design Doc → Context /
// Components / Trade-offs) instead of free-form text of the right kind.
async function renderExpectedArtifacts(expected: LoopExpectedArtifact[]): Promise<string> {
  if (expected.length === 0) return '- No explicit artifact contract; produce the stage default artifact pack.'
  const templateIds = expected.map(a => a.templateId).filter((x): x is string => Boolean(x))
  const templates = templateIds.length
    ? await prisma.artifactTemplate.findMany({ where: { id: { in: templateIds } }, select: { id: true, name: true, sections: true } }).catch(() => [])
    : []
  const byId = new Map(templates.map(t => [t.id, t]))
  return expected.map(artifact => {
    const head = `- ${artifact.title} (${artifact.kind})${artifact.required !== false ? ' [required]' : ''}${artifact.description ? `: ${artifact.description}` : ''}`
    const tmpl = artifact.templateId ? byId.get(artifact.templateId) : undefined
    const sections = tmpl && Array.isArray(tmpl.sections) ? tmpl.sections : []
    if (!tmpl || sections.length === 0) return head
    const outline = sections.map(raw => {
      const s = isRecord(raw) ? raw : {}
      const title = typeof s.title === 'string' ? s.title : 'Section'
      const req = s.required === true ? ' [required]' : ''
      let line = `    • ${title}${req}`
      if (Array.isArray(s.fields) && s.fields.length > 0) {
        const labels = s.fields.map(f => (isRecord(f) ? (typeof f.label === 'string' ? f.label : typeof f.key === 'string' ? f.key : '') : '')).filter(Boolean)
        if (labels.length) line += ` — fields: ${labels.join(', ')}`
      }
      if (Array.isArray(s.items) && s.items.length > 0) {
        const labels = s.items.map(i => (isRecord(i) && typeof i.label === 'string' ? i.label : '')).filter(Boolean)
        if (labels.length) line += ` — checklist: ${labels.join('; ')}`
      }
      return line
    }).join('\n')
    return `${head}\n  Fill the "${tmpl.name}" template — sections:\n${outline}`
  }).join('\n')
}

async function buildLoopStageVars(
  session: ArtifactSession & { artifacts?: LoopArtifactContextRecord[] },
  stage: LoopStageDefinition,
  state: LoopState,
): Promise<Record<string, string>> {
  // M41.2 — operator chat thread for this stage, rendered as chronological
  // lines so prompt-composer's loopDefaultTask can splice it under
  // "Operator guidance:".
  const chatThread = readStageChatThread(session.metadata, stage.key)
  const operatorChat = chatThread.length === 0
    ? '- No operator guidance.'
    : chatThread.map(m => {
        const ts = m.createdAt?.slice(11, 16) ?? ''
        const who = m.role === 'system' ? 'SYSTEM' : m.role === 'agent' ? 'AGENT' : 'OPERATOR'
        return `[${ts}] ${who}: ${m.content}`
      }).join('\n')
  const isDeveloperStage = normalizeAgentRole(stage.agentRole).includes('DEV')
  const usesRepoContext = stageUsesRepoContext(stage)
  const priorApprovedArtifacts = buildPriorApprovedArtifactContext(session, state, stage.key)
  // M46.C — Carry learnings from prior failed attempts of the SAME stage
  // forward, so the new attempt can skip exploration that's already been
  // done and avoid edits that already failed. Capped so it doesn't bloat
  // the prompt the way verbatim transcripts would.
  const priorAttemptLearnings = buildPriorAttemptLearnings(state, stage.key)
  // M60 Slice 2 — pull line-anchored annotations from the most recent
  // SEND_BACK whose targetStageKey matches this stage. Empty string when
  // the operator didn't attach any.
  const priorAttemptAnnotations = buildPriorAttemptAnnotations(state, stage.key)
  const implementationDirective = isDeveloperStage
    ? [
      'Use the approved artifact context as the implementation backlog for this attempt.',
      'If the Goal is generic, derive the concrete change from Story Intake, Plan, and Design artifacts instead of asking the operator to restate the task.',
      'If the approved behavior already exists in code, make a verifiable codebase change such as focused tests or documentation updates that prove the accepted contract.',
      'A Developer attempt is not approvable until MCP returns a real code_change receipt plus verification evidence.',
    ].join(' ')
    : ''
  const latestAccepted = state.stageAttempts
    .filter(attempt => attempt.verdict === 'PASS' || attempt.verdict === 'ACCEPTED_WITH_RISK')
    .map(attempt => `${attempt.stageLabel}#${attempt.attemptNumber}: ${attempt.verdict}`)
    .join('\n') || 'No accepted stages yet.'
  const questions = (stage.questions ?? []).map(question =>
    `- ${question.id}: ${question.question}${question.required ? ' (required)' : ''}`,
  ).join('\n') || '- No configured questions.'
  const artifacts = await renderExpectedArtifacts(stage.expectedArtifacts ?? [])
  const sendBacks = state.reviewEvents
    .filter(event => event.type === 'SEND_BACK' || event.type === 'AUTO_SEND_BACK')
    .slice(-5)
    .map(event => `- ${event.message}`)
    .join('\n') || '- No send-backs yet.'
  const capturedDecisions = state.decisionAnswers.length
    ? state.decisionAnswers.map(answer =>
        `- ${answer.questionText ?? answer.questionId}: ${decisionAnswerText(answer) ?? answer.notes ?? 'answered'}${answer.notes ? ` | notes: ${answer.notes}` : ''}`,
      ).join('\n')
    : '- No stakeholder decisions captured yet.'
  return {
    goal: session.goal,
    stageKey: stage.key,
    stageLabel: stage.label,
    agentRole: stage.agentRole ?? '',
    stageDescription: stage.description ?? 'No description supplied.',
    artifacts,
    questions,
    latestAccepted,
    priorApprovedArtifacts,
    implementationDirective,
    capturedDecisions,
    sendBacks,
    stageContextPolicy: stage.contextPolicy,
    stageToolPolicy: stage.toolPolicy,
    stageRepoAccess: usesRepoContext ? 'true' : 'false',
    promptProfileKey: stage.promptProfileKey ?? '',
    // M36.6 — source context vars consumed by loopDeveloperExtraContext template.
    sourceType: usesRepoContext ? session.sourceType : '',
    sourceUri: usesRepoContext ? session.sourceUri : '',
    sourceRef: usesRepoContext ? session.sourceRef ?? '' : '',
    // Helper for the "X @ Y" suffix without forcing the template to do conditionals.
    sourceRefSuffix: usesRepoContext && session.sourceRef ? ` @ ${session.sourceRef}` : '',
    // M41.2 — operator → agent guidance thread. The prompt-composer renderer
    // performs simple var substitution, so provide an explicit empty-state line.
    operatorChat,
    // M46.C — distilled learnings from prior attempts of the same stage.
    // Empty string when this is the first attempt.
    priorAttemptLearnings,
    // M60 Slice 2 — line-anchored reviewer annotations from the most
    // recent operator send-back targeting this stage. Empty string when
    // none. Rendered as a structured "## Reviewer line annotations"
    // block; loop-developer template can opt in by referencing
    // {{priorAttemptAnnotations}}.
    priorAttemptAnnotations,
  }
}

/**
 * M46.C — Compose a compact "lessons from prior attempts" block.
 *
 * The previous-attempt transcript is too large to replay verbatim, but the
 * structured signals on each StageAttempt let us build a short summary the
 * new attempt can use to (a) skip exploration the prior attempt already did
 * and (b) avoid the exact edits that broke things.
 *
 * For each prior failed attempt of the SAME stage (most recent up to 3):
 *   - verdict + reason if available (feedback / error)
 *   - which files the attempt successfully mutated (from correlation.codeChangeIds…
 *     proxied via the prior attempt's verificationReceipts' changed_paths and
 *     correlation. paths_touched)
 *   - the last failed verification command + its top error lines
 *
 * Capped at ~2_500 chars total so it never dominates the prompt.
 */
function buildPriorAttemptLearnings(state: LoopState, currentStageKey: string): string {
  // M70.2 — Broaden the failure filter to include BLOCKED verdicts (the
  // formal-verifier blocking the auto-finish), not just NEEDS_REWORK /
  // FAILED. Before, four straight formal-block attempts produced zero
  // repair feedback because their verdict was BLOCKED and the filter
  // missed them — the agent looped doing the same thing.
  const priorOfThisStage = state.stageAttempts
    .filter(attempt =>
      attempt.stageKey === currentStageKey &&
      (
        attempt.verdict === 'NEEDS_REWORK' ||
        attempt.verdict === 'BLOCKED' ||
        attempt.status === 'FAILED' ||
        attempt.status === 'NEEDS_REWORK' ||
        attempt.status === 'BLOCKED'
      ),
    )
    .slice(-3) // most recent up to 3
  if (priorOfThisStage.length === 0) return ''

  const blocks: string[] = []
  const maxTotalChars = 2_500
  let used = 0

  for (const attempt of priorOfThisStage) {
    const lines: string[] = []
    lines.push(`### Attempt #${attempt.attemptNumber} — ${attempt.verdict ?? attempt.status}`)

    // Touched paths so the new attempt knows which files were already edited.
    const correlation = isRecord(attempt.correlation) ? attempt.correlation : {}
    const codeChangeCoverage = isRecord(correlation.codeChangeCoverage) ? correlation.codeChangeCoverage : null
    const covered = Array.isArray(codeChangeCoverage?.covered) ? (codeChangeCoverage!.covered as string[]) : []
    const missing = Array.isArray(codeChangeCoverage?.missing) ? (codeChangeCoverage!.missing as string[]) : []
    if (covered.length > 0) lines.push(`- Files touched: ${covered.slice(0, 6).join(', ')}${covered.length > 6 ? ` (+${covered.length - 6} more)` : ''}`)
    if (missing.length > 0) lines.push(`- Files claimed but NOT touched: ${missing.slice(0, 5).join(', ')} — DO touch these this time`)

    // Failure feedback (from human send-back or verdict).
    if (attempt.feedback) lines.push(`- Send-back feedback: ${attempt.feedback.slice(0, 240)}`)
    if (attempt.error && !attempt.feedback) lines.push(`- Error: ${attempt.error.slice(0, 240)}`)

    // Last failed verification receipt — the actionable signal.
    const receipts = attempt.verificationReceipts ?? []
    const failedReceipt = [...receipts].reverse().find(r => r.passed === false || (typeof r.exit_code === 'number' && r.exit_code !== 0))
    if (failedReceipt) {
      const cmd = typeof failedReceipt.command === 'string' ? failedReceipt.command : '(unknown command)'
      // M70.1 — Surface the no-tests-ran reason so the agent learns its
      // -Dtest filter was wrong, not that the test code itself failed.
      const noTestsReason = typeof failedReceipt.no_tests_ran_reason === 'string' ? failedReceipt.no_tests_ran_reason : null
      // Extract a meaningful chunk of stderr/stdout — top 600 chars of the most error-y lines.
      const stdout = typeof failedReceipt.stdout_excerpt === 'string' ? failedReceipt.stdout_excerpt : ''
      const errorLines = stdout
        .split('\n')
        .filter(l => /error|fail|exception|\[ERROR\]/i.test(l))
        .slice(0, 6)
        .join('\n')
      if (noTestsReason) {
        lines.push(`- Last verification: ${cmd} → FAILED (${noTestsReason})`)
        lines.push(`  ⚠ The test filter matched ZERO methods. Either fix the filter to match real method names, or write the test first.`)
      } else {
        lines.push(`- Last verification: ${cmd} → FAILED`)
        if (errorLines) lines.push(`  Top error lines:\n${errorLines.split('\n').map(l => `    ${l}`).join('\n')}`)
      }
    }

    // M70.2 — Surface formal-verifier block reasons. The orchestrator's
    // verificationReceiptsFrom strips formal-kind receipts from
    // attempt.verificationReceipts (M68.1) to avoid poisoning cross-stage
    // threading. But the raw response correlation still holds them, and
    // the next attempt urgently needs to know WHY the gate blocked —
    // otherwise it repeats the same finish without a real receipt.
    const rawReceipts = Array.isArray(correlation.verificationReceipts) ? correlation.verificationReceipts as Array<Record<string, unknown>> : []
    const formalBlock = [...rawReceipts].reverse().find(r =>
      r.verification_kind === 'formal' && r.passed === false,
    )
    if (formalBlock) {
      const explanation = typeof formalBlock.explanation === 'string' ? formalBlock.explanation : ''
      const recommendations = Array.isArray(formalBlock.recommendations)
        ? (formalBlock.recommendations as unknown[]).filter((x): x is string => typeof x === 'string')
        : []
      lines.push(`- Formal verifier: BLOCKED`)
      if (explanation) lines.push(`  Why: ${explanation.slice(0, 240)}`)
      if (recommendations.length > 0) {
        lines.push(`  How to fix:`)
        for (const rec of recommendations.slice(0, 2)) {
          lines.push(`    - ${rec.slice(0, 220)}`)
        }
      }
    }

    const block = lines.join('\n')
    if (used + block.length > maxTotalChars) {
      blocks.push('### (older attempts elided — over budget)')
      break
    }
    blocks.push(block)
    used += block.length
  }

  return blocks.length > 0
    ? `Prior attempt learnings (use these to skip duplicate exploration AND avoid repeating mistakes):\n\n${blocks.join('\n\n')}`
    : ''
}

/**
 * M60 Slice 2 — Render line-anchored operator annotations from the most
 * recent SEND_BACK whose targetStageKey matches the current stage.
 *
 * The annotations are persisted on the review event payload by
 * `sendStageBack`. We walk the reviewEvents newest-first to find the
 * most recent send-back into this stage; if it has an annotations array,
 * format each entry into the structured block below. Older send-backs
 * are ignored — once a new attempt produces another diff, line numbers
 * from older reviews are stale and would mislead the agent.
 *
 * Output shape (when present):
 *
 *   ## Reviewer line annotations (must address before re-running)
 *   - path/to/File.java:142-148  (must-fix)
 *     "comment text"
 *   - path/to/Other.java:55  (suggestion)
 *     "comment text"
 *
 * Returns '' when no annotations are attached.
 */
export function buildPriorAttemptAnnotations(state: LoopState, currentStageKey: string): string {
  // Newest-first scan so we pick the latest review for this stage.
  const event = [...state.reviewEvents]
    .reverse()
    .find(ev =>
      (ev.type === 'SEND_BACK' || ev.type === 'AUTO_SEND_BACK') &&
      isRecord(ev.payload) &&
      ev.payload.targetStageKey === currentStageKey,
    )
  if (!event || !isRecord(event.payload)) return ''
  const raw = event.payload.annotations
  if (!Array.isArray(raw) || raw.length === 0) return ''

  // Defensive parse — review-event payloads are JSON blobs, so trust
  // nothing about the runtime shape.
  const lines: string[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const file = typeof item.file === 'string' ? item.file.trim() : ''
    // Strict positive-integer check — startLine=0 is a degenerate payload
    // from a buggy upstream and would render as ":0" in the prompt.
    const startLine = typeof item.startLine === 'number' && Number.isFinite(item.startLine) && item.startLine > 0
      ? Math.floor(item.startLine)
      : null
    const comment = typeof item.comment === 'string' ? item.comment.trim() : ''
    if (!file || startLine === null || !comment) continue
    const endLine = typeof item.endLine === 'number' && item.endLine > startLine
      ? item.endLine
      : null
    const severity = typeof item.severity === 'string' ? item.severity : ''
    const range = endLine ? `${startLine}-${endLine}` : String(startLine)
    const severityTag = severity ? `  (${severity})` : ''
    // Each annotation is two lines: location header, then the
    // double-quoted comment indented for readability.
    lines.push(`- ${file}:${range}${severityTag}`)
    lines.push(`  "${comment.replace(/"/g, '\\"')}"`)
  }
  if (lines.length === 0) return ''
  return [
    '## Reviewer line annotations (must address before re-running)',
    ...lines,
  ].join('\n')
}

function buildPriorApprovedArtifactContext(
  session: ArtifactSession & { artifacts?: LoopArtifactContextRecord[] },
  state: LoopState,
  currentStageKey: string,
): string {
  const acceptedArtifactIds = new Set(
    state.stageAttempts
      .filter(attempt =>
        attempt.stageKey !== currentStageKey &&
        (attempt.verdict === 'PASS' || attempt.verdict === 'ACCEPTED_WITH_RISK'),
      )
      .flatMap(attempt => attempt.artifactIds ?? []),
  )
  const artifacts = (session.artifacts ?? [])
    .map((artifact, index) => ({ artifact, index }))
    .filter(({ artifact }) => acceptedArtifactIds.has(artifact.id) && artifact.content?.trim())

  if (artifacts.length === 0) {
    return [
      '- No prior approved artifact content is available.',
      '- Inspect the repository and implement the smallest verifiable change implied by the current task.',
      '- If no product delta is explicit, add or update tests/docs that prove the accepted behavior.',
    ].join('\n')
  }

  const priority = new Map<string, number>([
    ['acceptance_contract', 0],
    ['approved_spec_draft', 1],
    ['solution_architecture', 2],
    ['story_brief', 3],
    ['gaps', 4],
    ['mental_model', 5],
  ])
  const maxTotalChars = 6_000
  const maxArtifactChars = 1_000
  let used = 0
  const blocks: string[] = []
  for (const { artifact } of artifacts.sort((a, b) =>
    (priority.get(a.artifact.kind) ?? 50) - (priority.get(b.artifact.kind) ?? 50) || a.index - b.index,
  )) {
    const raw = (artifact.content ?? '').trim()
    if (!raw) continue
    const excerpt = raw.length > maxArtifactChars ? `${raw.slice(0, maxArtifactChars).trim()}\n...` : raw
    const block = `## ${artifact.title} (${artifact.kind})\n${excerpt}`
    if (used + block.length > maxTotalChars) break
    blocks.push(block)
    used += block.length
  }

  return blocks.length > 0 ? blocks.join('\n\n') : '- Prior approved artifacts were present but exceeded the prompt budget.'
}

function buildStageInputSignature(
  snapshot: { rootHash: string | null },
  stage: LoopStageDefinition,
  agentTemplateId: string,
  task: string,
  state: LoopState,
): string {
  const accepted = state.stageAttempts
    .filter(attempt => attempt.verdict === 'PASS' || attempt.verdict === 'ACCEPTED_WITH_RISK')
    .map(attempt => ({
      stageKey: attempt.stageKey,
      attemptNumber: attempt.attemptNumber,
      verdict: attempt.verdict,
      artifactIds: attempt.artifactIds ?? [],
      acceptedAt: attempt.acceptedAt,
    }))
  const answers = state.decisionAnswers.map(answer => ({
    questionId: answer.questionId,
    normalizedQuestion: answer.normalizedQuestion ?? normalizeQuestionText(answer.questionText),
    answerType: answer.answerType,
    selectedOptionLabel: answer.selectedOptionLabel,
    selectedOptionLabels: answer.selectedOptionLabels,
    customAnswer: answer.customAnswer,
    notes: answer.notes,
  }))
  return sha256(JSON.stringify({
    rootHash: snapshot.rootHash,
    stageKey: stage.key,
    agentRole: stage.agentRole,
    stagePolicy: {
      contextPolicy: stage.contextPolicy,
      repoAccess: stage.repoAccess,
      toolPolicy: stage.toolPolicy,
      promptProfileKey: stage.promptProfileKey,
    },
    agentTemplateId,
    taskHash: sha256(task),
    accepted,
    answers,
    executionConfig: state.executionConfig,
  }))
}

function buildSnapshotExecuteArtifact(
  snapshot: { id?: string; summary: Prisma.JsonValue; manifest: Prisma.JsonValue; rootHash: string | null },
  input: {
    stageKey: string
    stageLabel: string
    task: string
    snapshotMode?: 'summary' | 'relevant_excerpts' | 'full_debug'
    excerptBudgetChars?: number
  },
): Record<string, unknown> {
  const summary = isRecord(snapshot.summary) ? snapshot.summary : {}
  const snapshotMode = input.snapshotMode ?? 'relevant_excerpts'
  const excerptBudgetChars = Math.min(input.excerptBudgetChars ?? EXECUTE_EXCERPT_BUDGET_CHARS, snapshotMode === 'full_debug' ? 120_000 : EXECUTE_EXCERPT_BUDGET_CHARS)
  const sampledFiles = Array.isArray(summary.sampledFiles)
    ? summary.sampledFiles.filter((file): file is { path: string; excerpt: string } =>
        isRecord(file) && typeof file.path === 'string' && typeof file.excerpt === 'string',
      )
    : []
  const manifest = Array.isArray(snapshot.manifest) ? snapshot.manifest as ManifestEntry[] : []
  const compactManifest = manifest.slice(0, EXECUTE_MANIFEST_MAX_FILES).map(file => ({
    path: file.path,
    size: file.size,
    language: file.language,
    sha: file.sha,
  }))
  const relevantExcerpts = snapshotMode === 'summary' ? [] : selectRelevantSnapshotExcerpts(sampledFiles, {
      ...input,
      maxFiles: snapshotMode === 'full_debug' ? MAX_EXCERPT_FILES : EXECUTE_EXCERPT_MAX_FILES,
      maxCharsPerFile: EXECUTE_EXCERPT_MAX_CHARS,
      totalBudgetChars: excerptBudgetChars,
    })
  const { sampledFiles: _omitted, ...compactSummary } = summary
  const testing = detectTestingTools(compactManifest, sampledFiles)
  const repoInstructions = extractRepoInstructions(sampledFiles)
  return {
    snapshotId: snapshot.id,
    rootHash: snapshot.rootHash,
    snapshotMode,
    compactSummary,
    compactManifest,
    manifestTruncated: manifest.length > compactManifest.length,
    relevantExcerpts,
    repoInstructions,
    testing,
    excerptBudgetChars,
    estimatedChars: JSON.stringify({ compactSummary, compactManifest, relevantExcerpts, repoInstructions, testing }).length,
    guidance: 'Use the snapshotId/rootHash as the stable source reference. Treat repoInstructions as first-class coding constraints and ask for more context only when these excerpts are insufficient.',
  }
}

function detectTestingTools(
  manifest: Array<{ path: string; size?: number; language?: string; sha?: string }>,
  sampledFiles: Array<{ path: string; excerpt: string }>,
) {
  const paths = new Set(manifest.map(file => file.path))
  const corpus = sampledFiles.map(file => `${file.path}\n${file.excerpt}`).join('\n')
  const commands: Array<{ tool: string; command: string; reason: string; stages: string[]; confidence: number }> = []
  const add = (tool: string, command: string, reason: string, confidence = 0.8) => {
    if (commands.some(item => item.command === command)) return
    commands.push({ tool, command, reason, stages: ['DEVELOPER', 'QA'], confidence })
  }

  const packageJson = sampledFiles.find(file => /(^|\/)package\.json$/i.test(file.path))?.excerpt ?? ''
  const hasPath = (pattern: RegExp) => [...paths].some(path => pattern.test(path))
  const packageManager = hasPath(/(^|\/)pnpm-lock\.yaml$/i) ? 'pnpm' : hasPath(/(^|\/)yarn\.lock$/i) ? 'yarn' : 'npm'
  if (hasPath(/(^|\/)package\.json$/i) || /"scripts"\s*:/i.test(packageJson)) {
    add(packageManager, packageManager === 'yarn' ? 'yarn test' : `${packageManager} test`, 'package.json was detected.')
    if (/"lint"\s*:/i.test(packageJson)) add(packageManager, packageManager === 'yarn' ? 'yarn lint' : `${packageManager} run lint`, 'package.json exposes a lint script.', 0.75)
    if (/"typecheck"\s*:/i.test(packageJson)) add(packageManager, packageManager === 'yarn' ? 'yarn typecheck' : `${packageManager} run typecheck`, 'package.json exposes a typecheck script.', 0.7)
  }
  if (hasPath(/(^|\/)pom\.xml$/i)) add('Maven', 'mvn test', 'pom.xml was detected.')
  if (hasPath(/(^|\/)gradlew$/i)) add('Gradle', './gradlew test', 'Gradle wrapper was detected.')
  else if (hasPath(/(^|\/)build\.gradle(\.kts)?$/i)) add('Gradle', 'gradle test', 'Gradle build file was detected.', 0.7)
  if (hasPath(/(^|\/)(pytest\.ini|pyproject\.toml|requirements\.txt)$/i) || /\bpytest\b/i.test(corpus)) add('pytest', 'pytest', 'Python test tooling was detected.')
  if (hasPath(/(^|\/)go\.mod$/i)) add('Go', 'go test ./...', 'go.mod was detected.')
  if (hasPath(/(^|\/)Cargo\.toml$/i)) add('Cargo', 'cargo test', 'Cargo.toml was detected.')
  if (hasPath(/\.(sln|csproj)$/i)) add('.NET', 'dotnet test', '.NET project files were detected.')
  if (hasPath(/(^|\/)Makefile$/i) && /\btest:/i.test(corpus)) add('Make', 'make test', 'Makefile test target was detected.', 0.7)

  return {
    detectedCommands: commands.slice(0, 8),
    guidance: commands.length
      ? 'Dev and QA stages should run the most focused relevant command after code changes and report command/status/output evidence.'
      : 'No test command was confidently detected. Inspect repo runbooks/package files before claiming verification.',
  }
}

function isRepoInstructionPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/')
  const lower = normalized.toLowerCase()
  const base = lower.split('/').pop() ?? lower
  return (
    base === 'agents.md' ||
    base === 'claude.md' ||
    base === 'skill.md' ||
    base === 'copilot-instructions.md' ||
    lower === '.github/copilot-instructions.md' ||
    lower.includes('/.github/copilot-instructions.md') ||
    lower.includes('/.cursor/rules') ||
    lower.includes('/.windsurf/rules') ||
    lower.endsWith('.cursorrules') ||
    lower.endsWith('.windsurfrules')
  )
}

function extractRepoInstructions(sampledFiles: Array<{ path: string; excerpt: string }>): Array<{ path: string; excerpt: string }> {
  return sampledFiles
    .filter(file => isRepoInstructionPath(file.path))
    .slice(0, 8)
    .map(file => ({
      path: file.path,
      excerpt: file.excerpt.slice(0, 4_000),
    }))
}

function encodeComposerArtifactContent(snapshotArtifact: Record<string, unknown>): string {
  const compact = JSON.stringify(snapshotArtifact)
  if (compact.length <= COMPOSER_ARTIFACT_CONTENT_MAX_CHARS) return compact

  const clone = JSON.parse(compact) as Record<string, unknown>
  const excerpts = Array.isArray(clone.relevantExcerpts)
    ? clone.relevantExcerpts.filter((item): item is Record<string, unknown> => isRecord(item))
    : []

  if (excerpts.length > 0) {
    let excerptChars = Math.max(180, Math.floor(7_000 / excerpts.length))
    while (excerptChars >= 120) {
      clone.relevantExcerpts = excerpts.map(item => ({
        path: item.path,
        score: item.score,
        excerpt: String(item.excerpt ?? '').slice(0, excerptChars),
      }))
      const encoded = JSON.stringify({
        ...clone,
        artifactEncoding: {
          compactedForPromptComposer: true,
          maxChars: COMPOSER_ARTIFACT_CONTENT_MAX_CHARS,
          excerptCharsPerFile: excerptChars,
        },
      })
      if (encoded.length <= COMPOSER_ARTIFACT_CONTENT_MAX_CHARS) return encoded
      excerptChars = Math.floor(excerptChars * 0.7)
    }
  }

  const manifest = Array.isArray(clone.compactManifest) ? clone.compactManifest : []
  const encoded = JSON.stringify({
    snapshotId: clone.snapshotId,
    rootHash: clone.rootHash,
    snapshotMode: clone.snapshotMode,
    compactSummary: clone.compactSummary,
    compactManifest: manifest.slice(0, 40),
    manifestTruncated: true,
    relevantExcerpts: [],
    artifactEncoding: {
      compactedForPromptComposer: true,
      maxChars: COMPOSER_ARTIFACT_CONTENT_MAX_CHARS,
      reason: 'Snapshot exceeded Prompt Composer artifact.content limit.',
    },
    guidance: clone.guidance,
  })
  return encoded.length <= COMPOSER_ARTIFACT_CONTENT_MAX_CHARS
    ? encoded
    : JSON.stringify({
        snapshotId: clone.snapshotId,
        rootHash: clone.rootHash,
        snapshotMode: clone.snapshotMode,
        compactManifest: manifest.slice(0, 20),
        relevantExcerpts: [],
        artifactEncoding: {
          compactedForPromptComposer: true,
          maxChars: COMPOSER_ARTIFACT_CONTENT_MAX_CHARS,
          reason: 'Snapshot metadata was compacted to satisfy Prompt Composer validation.',
        },
      })
}

function selectRelevantSnapshotExcerpts(
  files: Array<{ path: string; excerpt: string }>,
  input: { stageKey: string; stageLabel: string; task: string; maxFiles: number; maxCharsPerFile: number; totalBudgetChars: number },
): Array<{ path: string; excerpt: string; score: number }> {
  const keywords = snapshotKeywords(`${input.stageKey} ${input.stageLabel} ${input.task}`)
  let used = 0
  return files
    .map(file => ({
      ...file,
      score: snapshotExcerptScore(file, keywords),
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, Math.max(input.maxFiles * 2, input.maxFiles))
    .reduce<Array<{ path: string; excerpt: string; score: number }>>((selected, file) => {
      if (selected.length >= input.maxFiles || used >= input.totalBudgetChars) return selected
      const remaining = input.totalBudgetChars - used
      const excerpt = file.excerpt.slice(0, Math.min(input.maxCharsPerFile, remaining)).trim()
      if (!excerpt) return selected
      selected.push({ path: file.path, excerpt, score: file.score })
      used += excerpt.length
      return selected
    }, [])
}

function snapshotKeywords(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(token => token.length >= 3 && !['the', 'and', 'for', 'with', 'this', 'that', 'from', 'stage', 'agent', 'return'].includes(token))
  return new Set(tokens.slice(0, 80))
}

function snapshotExcerptScore(file: { path: string; excerpt: string }, keywords: Set<string>): number {
  const pathText = file.path.toLowerCase()
  const excerptText = file.excerpt.toLowerCase()
  let score = 0
  for (const keyword of keywords) {
    if (pathText.includes(keyword)) score += 8
    if (excerptText.includes(keyword)) score += 2
  }
  if (/readme|claude|agents|skill|instruction|docs\//i.test(file.path)) score += 12
  if (/test|spec|rule|engine|operator|service|controller|model|schema/i.test(file.path)) score += 8
  if (/\.(ts|tsx|js|jsx|py|java|kt|go|rs)$/i.test(file.path)) score += 4
  return score
}

function buildGateRecommendation(result: ExecuteResponse, stage: LoopStageDefinition): GateRecommendation {
  if (result.status === 'FAILED') {
    return {
      verdict: 'BLOCKED',
      confidence: 0.95,
      reason: result.finishReason ?? 'Context Fabric reported a failed stage.',
      targetStageKey: stage.allowedSendBackTo?.[0],
    }
  }
  if (normalizeAgentRole(stage.agentRole).includes('DEV') && (result.correlation?.codeChangeIds ?? []).length === 0) {
    return {
      verdict: 'NEEDS_REWORK',
      confidence: 0.92,
      reason: 'Developer stage did not capture an actual MCP/git code change. Use a tool-capable model and a writable MCP workspace that matches the requested repo, then rerun the stage.',
      targetStageKey: stage.allowedSendBackTo?.[0],
    }
  }
  const warningCount = result.warnings?.length ?? 0
  if (warningCount > 1) {
    return {
      verdict: 'NEEDS_REWORK',
      confidence: 0.86,
      reason: `${warningCount} execution warnings were produced; human review should decide whether to send work back.`,
      targetStageKey: stage.allowedSendBackTo?.[0],
    }
  }
  return {
    verdict: 'PASS',
    confidence: 0.74,
    reason: 'No blocking execution signal was detected. Human review still owns the stage verdict.',
  }
}

function buildCodingGateRecommendation(result: CodingRunResult, stage: LoopStageDefinition): GateRecommendation {
  if (result.status === 'FAILED' || result.status === 'DENIED') {
    return {
      verdict: 'BLOCKED',
      confidence: 0.95,
      reason: result.response.finishReason ?? result.response.finalResponse ?? 'Coding stage did not complete successfully.',
      targetStageKey: stage.allowedSendBackTo?.[0],
    }
  }
  const base = buildGateRecommendation(result.response, stage)
  if (base.verdict !== 'PASS') return base
  if (hasFailedVerificationReceipt(result)) {
    return {
      verdict: 'NEEDS_REWORK',
      confidence: 0.94,
      reason: 'A test, lint, typecheck, or formal verification receipt failed. Send the work back with the verifier output before approval.',
      targetStageKey: stage.allowedSendBackTo?.[0],
    }
  }
  if (stageRequiresVerification(result.policy) && hasActualCodeChange(result) && !hasVerificationReceipt(result)) {
    return {
      verdict: 'NEEDS_REWORK',
      confidence: 0.9,
      reason: 'Code changed but no test, lint, typecheck, or verification receipt was captured. Run the detected verification command through MCP before approval.',
      targetStageKey: stage.allowedSendBackTo?.[0],
    }
  }
  if (stageRequiresVerification(result.policy) && hasActualCodeChange(result) && !hasPassingVerificationReceipt(result)) {
    return {
      verdict: hasUnavailableVerificationReceipt(result) ? 'ACCEPTED_WITH_RISK' : 'NEEDS_REWORK',
      confidence: hasUnavailableVerificationReceipt(result) ? 0.78 : 0.9,
      reason: hasUnavailableVerificationReceipt(result)
        ? 'Code changed and MCP recorded verification as unavailable. Human accepted-risk approval is required.'
        : 'Code changed but no passing verification receipt was captured. Run the detected verification command through MCP before approval.',
      targetStageKey: stage.allowedSendBackTo?.[0],
    }
  }
  return base
}

function attemptHasActualCodeChange(attempt: StageAttempt): boolean {
  const correlation = isRecord(attempt.correlation) ? attempt.correlation : {}
  const codeChangeIds = correlation.codeChangeIds
  return Array.isArray(codeChangeIds) && codeChangeIds.some(id => typeof id === 'string' && id.trim().length > 0)
}

// (2026-05-26) Under M81's per-workitem branch model, a dev stage's
// commits accumulate on wi/<code> across attempts. A subsequent
// attempt may correctly produce zero new code changes — e.g. when
// the workflow re-runs develop after QA approval and the agent
// (correctly) sees the work is already committed and acts as a
// reviewer rather than an editor.
//
// Repro 2026-05-26 attempt dea06240 on WRK-984AD: branch already
// had 3 commits from prior attempt fde84058 (containsACharacter
// implementation + tests). The re-run agent on Haiku spent 9
// turns in PLAN/EXPLORE confirming the implementation existed,
// then submitted a SelfReviewReceipt(recommended_for_approval=true,
// risk_level=low) with thoughtful risk callouts. Attempt-level
// codeChangeIds was empty (no NEW changes) so the dev approval
// gate blocked with "Re-run Develop with a writable MCP workspace
// and a tool-capable model alias" — wrong answer: the work is
// already on the branch, just from a different attempt.
//
// Check ANY attempt for this stage instead of just the latest.
function loopStateHasAccumulatedCodeChange(state: LoopState, stageKey: string): boolean {
  return state.stageAttempts.some(attempt => attempt.stageKey === stageKey && attemptHasActualCodeChange(attempt))
}

/** Phased Agent Reasoning Model (v4) — extract the code-change coverage
 *  summary from a stage attempt's correlation payload. Returns null when
 *  the run was NOT a phased run (correlation.codeChangeCoverage absent).
 *  The shape mirrors mcp-server's `CodeChangeCoverage` type. */
function attemptCodeChangeCoverage(attempt: StageAttempt): {
  required: string[]
  covered: string[]
  skipped: Array<{ file: string; reason: string }>
  missing: string[]
  hasRequiredCodeGap: boolean
} | null {
  const correlation = isRecord(attempt.correlation) ? attempt.correlation : {}
  const raw = correlation.codeChangeCoverage
  if (!isRecord(raw)) return null
  return {
    required: Array.isArray(raw.required) ? raw.required.filter((x): x is string => typeof x === 'string') : [],
    covered: Array.isArray(raw.covered) ? raw.covered.filter((x): x is string => typeof x === 'string') : [],
    skipped: Array.isArray(raw.skipped)
      ? raw.skipped
          .filter(isRecord)
          .map(s => ({
            file: typeof s.file === 'string' ? s.file : '',
            reason: typeof s.reason === 'string' ? s.reason : '',
          }))
          .filter(s => s.file.length > 0)
      : [],
    missing: Array.isArray(raw.missing) ? raw.missing.filter((x): x is string => typeof x === 'string') : [],
    hasRequiredCodeGap: raw.hasRequiredCodeGap === true,
  }
}

/** M43 Slice 3 — read `correlation.verificationCoverage` shape emitted by
 *  mcp-server when MCP_DETERMINISTIC_VERIFICATION_GATE_ENABLED=true. Returns
 *  null when the field is absent (gate flag off, or pre-M43 mcp-server). */
function attemptVerificationCoverage(attempt: StageAttempt): {
  codeChanged: boolean
  receiptsPresent: boolean
  hasPassingReceipt: boolean
  hasUnavailableReceipt: boolean
  gap: boolean
} | null {
  const correlation = isRecord(attempt.correlation) ? attempt.correlation : {}
  const raw = correlation.verificationCoverage
  if (!isRecord(raw)) return null
  return {
    codeChanged: raw.codeChanged === true,
    receiptsPresent: raw.receiptsPresent === true,
    hasPassingReceipt: raw.hasPassingReceipt === true,
    hasUnavailableReceipt: raw.hasUnavailableReceipt === true,
    gap: raw.gap === true,
  }
}

function attemptReceiptExitCode(receipt: Record<string, unknown>): number | undefined {
  return typeof receipt.exitCode === 'number'
    ? receipt.exitCode
    : typeof receipt.exit_code === 'number'
      ? receipt.exit_code
      : undefined
}

/**
 * M78 Slice 1 — Resolve a develop attempt's verification failures into
 * structured `{inherited[], regression[]}` lists by:
 *   1. Pulling tool_invocation_ids from attempt.correlation.codeChangeIds
 *   2. Resolving them to file paths via contextFabricClient.listCodeChanges
 *   3. Cross-referencing failing-test FQNs with those paths via the
 *      analyzer module (inherited-failure-analyzer.ts).
 * Returns null when the receipt set lacks structured parsed_tests data
 * (e.g. Jest runner before M72 D supports it) — caller falls back to the
 * legacy string-only validation error. Best-effort throughout: failures
 * to reach context-fabric just degrade to "no agent paths known", which
 * classifies every failure as inherited rather than blocking the gate.
 */
// M83.y P2 (2026-05-27) — Auto-spawn remediation work items when an
// autonomous develop attempt finishes FAILED on its terminal try
// (attemptNumber === maxLoopsPerStage). Today M78 Slice 4's auto-spawn
// only fires when the operator clicks Approve and gets blocked; that
// leaves the "stage just ran out of attempts" path with no path
// forward unless someone notices. This helper mirrors the
// Approve-blocked logic but triggers from the autonomous run path
// so a dead-end develop attempt at least leaves remediation WIs
// behind for the operator to pick up.
//
// Returns the array of spawned WIs (possibly empty) plus any spawn
// errors so the caller can attach them to a reviewEvent.
async function maybeSpawnTerminalRemediation(
  session: { id: string; capabilityId: string | null; workflowInstanceId: string | null },
  stage: { key: string; label: string; approvalRequired?: boolean },
  attempt: StageAttempt,
  attemptNumber: number,
  maxLoopsPerStage: number,
  actorId: string,
): Promise<{
  spawned: Array<{ id: string; workCode: string; title: string; test: string }>
  spawnErrors: Array<{ test: string; reason: string }>
  classification: FailureClassification | null
} | null> {
  if (!config.WORKGRAPH_AUTO_REMEDIATE_INHERITED_FAILURES) {
    // Feature flag off — match M78 Slice 4's contract. Operator can
    // still click Approve to fall back to the manual remediation card.
    return null
  }
  if (attempt.status !== 'FAILED') {
    return null
  }
  if (attemptNumber < maxLoopsPerStage) {
    // Not terminal yet — the next attempt might pass. Don't spawn
    // remediation WIs prematurely.
    return null
  }
  if (!attemptHasActualCodeChange(attempt)) {
    // No code change → no test verification to classify. The
    // workbench surfaces a different failure shape for these
    // (no-edit attempts) and remediation here would be guessing.
    return null
  }

  const classification = await analyzeAttemptFailures(attempt).catch(() => null)
  if (!classification) return null
  if (classification.inheritedFailures.length === 0) {
    // No inherited failures to spawn for. If regressions exist, those
    // are the agent's own and remediation isn't the right tool — they
    // need a send-back. Caller's reviewEvent surfaces this distinction.
    return { spawned: [], spawnErrors: [], classification }
  }

  const spawned: Array<{ id: string; workCode: string; title: string; test: string }> = []
  const spawnErrors: Array<{ test: string; reason: string }> = []
  for (const failure of classification.inheritedFailures) {
    try {
      const created = await createInheritedFailureRemediation(
        session.id, stage.key,
        { failure, originAttemptId: attempt.id },
        actorId,
      )
      spawned.push({ ...created, test: failure.test })
    } catch (err) {
      spawnErrors.push({ test: failure.test, reason: (err as Error).message })
    }
  }
  return { spawned, spawnErrors, classification }
}

async function analyzeAttemptFailures(attempt: StageAttempt): Promise<FailureClassification | null> {
  const correlation = isRecord(attempt.correlation) ? attempt.correlation : {}
  const cfCallId = typeof correlation.cfCallId === 'string' ? correlation.cfCallId : ''
  const rawIds = correlation.codeChangeIds
  const codeChangeIds: string[] = Array.isArray(rawIds)
    ? rawIds.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : []

  let agentChangedPaths: string[] = []
  if (cfCallId && codeChangeIds.length > 0) {
    try {
      const { items } = await contextFabricClient.listCodeChanges(cfCallId, { codeChangeIds })
      agentChangedPaths = items.flatMap(item =>
        Array.isArray((item as { paths_touched?: unknown }).paths_touched)
          ? ((item as { paths_touched: unknown[] }).paths_touched.filter(
              (p): p is string => typeof p === 'string' && p.trim().length > 0))
          : [],
      )
    } catch {
      // context-fabric unreachable / 5xx — leave agentChangedPaths empty.
      // M90.B (2026-05-27) — the analyzer now puts every failure in
      // `unknownFailures` (not `inheritedFailures`) when provenance is
      // empty. This fixes the silent green-light from a CF outage that
      // pre-M90.B made an empty provenance set look like "all failures
      // are upstream-broken." Operator must explicitly judge each.
    }
  }

  // Coerce the attempt's verificationReceipts into the analyzer's shape.
  // The receipts on attempt are the M71-summarised version that now
  // carries parsedTests + stdoutExcerpt (M78 orchestrator change).
  const receiptsRaw = Array.isArray(attempt.verificationReceipts)
    ? attempt.verificationReceipts as Array<Record<string, unknown>>
    : []
  const receipts = receiptsRaw.map(r => ({
    passed: typeof r.passed === 'boolean' ? r.passed : (r.passed ?? null) as boolean | null,
    command: typeof r.command === 'string' ? r.command : null,
    exit_code: typeof r.exit_code === 'number' ? r.exit_code as number :
               (typeof r.exitCode === 'number' ? r.exitCode as number : null),
    stdout_excerpt: typeof r.stdout_excerpt === 'string' ? r.stdout_excerpt :
                    (typeof r.stdoutExcerpt === 'string' ? r.stdoutExcerpt : null),
    parsed_tests: isRecord(r.parsed_tests) ? r.parsed_tests as Record<string, unknown> :
                  (isRecord(r.parsedTests) ? r.parsedTests as Record<string, unknown> : null),
  }))

  const classification = classifyFailures(receipts, agentChangedPaths)
  // If we couldn't parse a single failure and there's no agent-touched
  // path data, the classifier has nothing to say — return null so the
  // caller falls back to the legacy message. M90.B — unknownFailures
  // also counts as "something to surface" (don't lose the bucket).
  if (classification.inheritedFailures.length === 0
      && classification.regressionFailures.length === 0
      && classification.unknownFailures.length === 0) {
    return null
  }
  return classification
}

function attemptHasFailedVerificationReceipt(attempt: StageAttempt): boolean {
  return (attempt.verificationReceipts ?? []).some(receipt => {
    const exitCode = attemptReceiptExitCode(receipt)
    if (attemptReceiptUnavailable(receipt)) return false
    // M48 — When a per-test baseline diff is attached AND there are no
    // regressions, the receipt failed only because of pre-existing upstream
    // failures the agent didn't cause. Honour the diff's effective_passed
    // signal so the gate distinguishes "upstream-broken" from "agent broke it".
    if (receipt.effective_passed === true) return false
    return receipt.passed === false || (typeof exitCode === 'number' && exitCode !== 0)
  })
}

function attemptHasPassingVerificationReceipt(attempt: StageAttempt): boolean {
  return (attempt.verificationReceipts ?? []).some(receipt =>
    receipt.passed === true ||
    receipt.effective_passed === true ||           // M48 — baseline-diff-clean counts as passing
    attemptReceiptExitCode(receipt) === 0,
  )
}

function attemptReceiptUnavailable(receipt: Record<string, unknown>): boolean {
  return receipt.unavailable === true || receipt.verification_kind === 'unavailable'
}

function attemptHasUnavailableVerificationReceipt(attempt: StageAttempt): boolean {
  return (attempt.verificationReceipts ?? []).some(receipt => attemptReceiptUnavailable(receipt))
}

function maybeApplyAutoGate(state: LoopState, stage: LoopStageDefinition, attemptId: string, actorId: string): LoopState {
  if (state.gateMode !== 'auto') return state
  const attempt = state.stageAttempts.find(item => item.id === attemptId)
  const rec = attempt?.gateRecommendation
  if (!attempt || !rec || rec.verdict === 'PASS' || rec.confidence < 0.9) return state
  const target = rec.targetStageKey && (stage.allowedSendBackTo ?? []).includes(rec.targetStageKey) ? rec.targetStageKey : undefined
  if (!target || sendBackCount(state) >= state.loopDefinition.maxTotalSendBacks) return state
  return {
    ...state,
    currentStageKey: target,
    stageAttempts: state.stageAttempts.map(item => item.id === attemptId ? {
      ...item,
      status: 'NEEDS_REWORK',
      verdict: rec.verdict,
      feedback: rec.reason,
    } : item),
    reviewEvents: [...state.reviewEvents, reviewEvent('AUTO_SEND_BACK', `${stage.label} automatically sent back to ${titleFromKey(target)}: ${rec.reason}`, actorId, {
      stageKey: stage.key,
      targetStageKey: target,
      attemptId,
      gateRecommendation: rec,
    })],
  }
}

function buildLoopStageMarkdown(
  session: ArtifactSession,
  ctx: SnapshotContext,
  stage: LoopStageDefinition,
  attempt: StageAttempt,
  response: string,
  gateRecommendation: GateRecommendation,
  executionFallback: string,
) {
  return [
    `# ${stage.label} Attempt ${attempt.attemptNumber}`,
    '',
    `Goal: ${session.goal}`,
    `Stage key: ${stage.key}`,
    `Agent role: ${stage.agentRole}`,
    '',
    '## Gate Recommendation',
    '',
    `- Verdict: ${gateRecommendation.verdict}`,
    `- Confidence: ${gateRecommendation.confidence}`,
    `- Reason: ${gateRecommendation.reason}`,
    '',
    '## Source Signals',
    '',
    `- Snapshot files: ${ctx.files.length}`,
    `- Key files: ${ctx.keyFiles.map(file => `\`${file}\``).join(', ') || 'none detected'}`,
    '',
    '## Model Notes',
    '',
    response || executionFallback,
  ].join('\n')
}

function findLoopStage(state: LoopState, stageKey: string): LoopStageDefinition {
  const stage = state.loopDefinition.stages.find(item => item.key === slug(stageKey) || item.key === stageKey)
  if (!stage) throw new NotFoundError('BlueprintLoopStage', stageKey)
  return stage
}

function latestStageAttempt(
  state: LoopState,
  stageKey: string,
  // Milestones: default-scope to the ACTIVE milestone so the verification /
  // code-change / coverage gates never treat a PRIOR milestone's attempt as
  // "latest". For legacy sessions and session-level stages (intake/plan/
  // aggregation, which carry no milestoneId) this resolves to undefined =>
  // identical to the original behavior. When the active milestone has no
  // attempt for this stage yet, fall back to untagged (session-level) attempts
  // so session-level stages still resolve while a milestone is active.
  milestoneId: string | undefined = state.milestone?.enabled
    ? (state.milestone.currentMilestoneId ?? undefined)
    : undefined,
): StageAttempt | undefined {
  const all = state.stageAttempts.filter(attempt => attempt.stageKey === stageKey)
  if (milestoneId === undefined) return all.at(-1)
  const tagged = all.filter(attempt => attempt.milestoneId === milestoneId)
  if (tagged.length > 0) return tagged.at(-1)
  return all.filter(attempt => attempt.milestoneId === undefined).at(-1)
}

function verdictToAttemptStatus(verdict: LoopVerdict): LoopAttemptStatus {
  return verdict === 'PASS' ? 'PASSED' : verdict
}

function mergeStageQuestions(loopDefinition: LoopDefinition, stageKey: string, incoming: LoopQuestion[]): LoopDefinition {
  if (incoming.length === 0) return loopDefinition
  return {
    ...loopDefinition,
    stages: loopDefinition.stages.map(stage => {
      if (stage.key !== stageKey) return stage
      const byId = new Map((stage.questions ?? []).map(question => [question.id, question]))
      const byQuestion = new Map((stage.questions ?? []).flatMap(question => {
        const key = normalizeQuestionText(question.question)
        return key ? [[key, question.id] as const] : []
      }))
      for (const question of incoming) {
        const semanticKey = normalizeQuestionText(question.question)
        const existingId = semanticKey ? byQuestion.get(semanticKey) : undefined
        byId.set(existingId ?? question.id, existingId ? { ...question, id: existingId } : question)
        if (semanticKey) byQuestion.set(semanticKey, existingId ?? question.id)
      }
      return {
        ...stage,
        questions: Array.from(byId.values()),
      }
    }),
  }
}

function filterNewLlmOpenQuestions(incoming: LoopQuestion[], state: LoopState, stageKey: string): LoopQuestion[] {
  if (incoming.length === 0) return []
  const seenAnswered = new Set<string>()
  for (const stage of state.loopDefinition.stages) {
    for (const question of stage.questions ?? []) {
      const key = normalizeQuestionText(question.question)
      if (key && hasDecisionAnswerForQuestion(question, state.decisionAnswers)) seenAnswered.add(key)
    }
  }
  const currentStage = state.loopDefinition.stages.find(stage => stage.key === stageKey)
  for (const question of currentStage?.questions ?? []) {
    const key = normalizeQuestionText(question.question)
    if (key && hasDecisionAnswerForQuestion(question, state.decisionAnswers)) seenAnswered.add(key)
  }
  const emitted = new Set<string>()
  return incoming.filter(question => {
    if (hasDecisionAnswerForQuestion(question, state.decisionAnswers)) return false
    const key = normalizeQuestionText(question.question)
    if (!key) return true
    if (seenAnswered.has(key) || emitted.has(key)) return false
    emitted.add(key)
    return true
  })
}

export function extractLlmOpenQuestions(response: string, stage: LoopStageDefinition, attempt: StageAttempt): LoopQuestion[] {
  const section = extractMarkdownSection(response, ['open questions', 'questions for user', 'clarifications', 'clarification questions'])
  if (!section) return []
  const questions: LoopQuestion[] = []
  for (const line of section.split('\n').map(item => item.trim()).filter(Boolean)) {
    // M57 — Skip markdown-table syntax. Claude (and Anthropic models in
    // general) sometimes render "Open Questions" as a status table:
    //   | Assumption | Rationale | Validation |
    //   |------------|------------|------------|
    //   | Operator enum already registered | Confirmed in snapshot ... | ✓ |
    // Earlier the parser stripped leading bullets but not table pipes,
    // so every row became a phantom "question". Detect three table shapes:
    //   1. Separator rows:  |---|---|---|  (pipes + dashes only)
    //   2. Header / data rows starting with `|` (table border)
    //   3. Lines that are pure pipes-and-whitespace (degenerate)
    if (/^\|[\s|:\-]*\|?$/.test(line)) continue           // separator row
    if (line.startsWith('|') && line.endsWith('|') && line.includes(' | ')) continue  // table data row
    if (/^\|/.test(line) && !/\?/.test(line) && line.split('|').length >= 3) continue  // any pipe-delimited multi-col row

    const cleaned = line
      .replace(/^[-*]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .trim()
    if (!cleaned || cleaned.length < 12) continue
    // M69 follow-up — Strip leading markdown emphasis BEFORE the "none"
    // sentinel check. Models emit "**None.** ..." or "*None* ..." or
    // even "_No clarifications needed_ ..." as a header-style negative
    // answer; the previous regex only matched bare `none` and let the
    // emphasised forms through, producing fake required questions that
    // blocked the workflow at Story Intake every time. Pattern strips
    // any combination of `*` / `_` / `~` at the head (markdown's three
    // emphasis chars).
    const stripped = cleaned.replace(/^[*_~`]+\s*/, '').trim()
    // M69 — Broadened sentinel match. Catches the actual phrases models
    // emit when they decided no clarification was needed:
    //   **None.** ...   → after strip: "None. ..."
    //   No clarifications needed.
    //   No questions at this time.
    //   The goal statement and stakeholder intent are sufficiently clear...
    //   All ambiguities deferred to <Stage>.
    if (/^(none|n\/a|no\b|nothing\b|all\b)/i.test(stripped)) continue
    if (/^(the\s+(goal|story|spec|requirements|stakeholder)|all\s+(ambiguities|questions|clarifications))/i.test(stripped)) continue
    if (/(sufficiently\s+clear|no\s+open\s+questions|no\s+clarifications?\s+(are\s+)?needed|deferred\s+to\s+\w+\s+stage)/i.test(stripped)) continue
    // M57 — Final safety net: require at least one alphabetic chunk that
    // looks like a real word (>=4 letters). Pure punctuation/pipes that
    // slip past the table-syntax checks won't have one.
    if (!/[a-zA-Z]{4,}/.test(cleaned)) continue
    // M69 — Final shape gate: a real clarification question almost
    // always contains either a `?` or one of the imperative verbs
    // ("should", "must", "what", "which", "how", "when"). Without one,
    // it's a statement masquerading as a question. Falls through to
    // accept-anything when the model uses indirect phrasing on a real
    // question, so keep this generous.
    if (!/\?/.test(stripped) && !/\b(should|must|what|which|how|when|where|who|why|can|may|does|do|is|are|will|would|specify|confirm|clarify|decide|choose)\b/i.test(stripped)) continue
    const parsed = classifyOpenQuestion(cleaned)
    const index = questions.length + 1
    questions.push({
      id: `${stage.key.toUpperCase()}-LLM-${attempt.attemptNumber}-${index}`,
      question: parsed.question,
      type: parsed.type,
      // (2026-05-26) LLM-generated open questions are clarifications, NOT
      // hard gates. Treating them as `required: true` made the per-stage
      // verdict endpoint (missingRequiredQuestions check) reject any
      // PASS attempt as long as the agent kept finding "useful to know"
      // items — which it always does, because asking is its job in
      // intake. Operators got stuck in a loop: answer 5 questions →
      // re-run → agent finds 5 new ones → repeat.
      //
      // The operator-configured questions on the stage (stage.questions
      // array, source='configured') stay required:true — those are
      // author-designed gates and should block approval. LLM-generated
      // clarifications surface in the workbench modal for the operator
      // to answer if useful, but the operator can also just record
      // PASS and move on. Repro 2026-05-26 session 5f95ad4b: 3
      // story-intake attempts each generated 5 fresh open questions,
      // no path to verdict=PASS without filling all 15.
      required: false,
      freeform: parsed.freeform,
      options: parsed.options,
      source: 'llm_open_question',
      stageKey: stage.key,
      attemptId: attempt.id,
    })
    if (questions.length >= 12) break
  }
  return questions
}

function extractMarkdownSection(markdown: string, headings: string[]): string {
  if (!markdown.trim()) return ''
  const lines = markdown.split('\n')
  let start = -1
  let headingLevel = 0
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].trim().match(/^(#{1,6})\s+(.+?)\s*#*$/)
    if (!match) continue
    const title = match[2].trim().toLowerCase().replace(/[:：]$/, '')
    if (headings.some(heading => title.includes(heading))) {
      start = index + 1
      headingLevel = match[1].length
      break
    }
  }
  if (start === -1) return ''
  const body: string[] = []
  for (let index = start; index < lines.length; index += 1) {
    const match = lines[index].trim().match(/^(#{1,6})\s+/)
    if (match && match[1].length <= headingLevel) break
    body.push(lines[index])
  }
  return body.join('\n').trim()
}

function classifyOpenQuestion(raw: string): Pick<LoopQuestion, 'question' | 'type' | 'options' | 'freeform'> {
  const { question, options } = splitQuestionOptions(raw)
  const lower = question.toLowerCase()
  const hasOptions = options.length > 0
  const isMulti = /\b(multi|multiple|choose all|select all|which .* apply|all that apply)\b/.test(lower)
  const isBinary = /^(should|do|does|is|are|can|will|would|has|have)\b/.test(lower)
  if (isMulti) {
    return {
      question,
      type: 'multi_select',
      options: hasOptions ? options.map((label, index) => ({ label, recommended: index === 0 })) : [],
      freeform: true,
    }
  }
  if (hasOptions || isBinary) {
    return {
      question,
      type: 'single_select',
      options: hasOptions ? options.map((label, index) => ({ label, recommended: index === 0 })) : [
        { label: 'Yes', impact: 'Proceed with this assumption.' },
        { label: 'No', impact: 'Send the stage back or adjust the plan.' },
        { label: 'Needs discussion', impact: 'Capture details before approving.' },
      ],
      freeform: true,
    }
  }
  return {
    question,
    type: 'clarification',
    options: [],
    freeform: true,
  }
}

function splitQuestionOptions(raw: string): { question: string; options: string[] } {
  const optionMatch = raw.match(/^(.*?)(?:\s+options?\s*[:：]\s*|\s+\((?:options?|choose|select)\s*[:：]\s*)(.+?)\)?$/i)
  if (!optionMatch) return { question: raw.trim(), options: [] }
  const question = optionMatch[1].trim().replace(/[;:,-]+$/, '')
  const options = optionMatch[2]
    .split(/\s*(?:\||,|;|\/|\bor\b)\s*/i)
    .map(option => option.trim().replace(/^["']|["']$/g, ''))
    .filter(option => option.length > 0)
    .slice(0, 8)
  return { question: question || raw.trim(), options }
}

function missingRequiredQuestions(stage: LoopStageDefinition, answers: DecisionAnswer[]): string[] {
  return (stage.questions ?? [])
    .filter(question => question.required && !hasDecisionAnswerForQuestion(question, answers))
    .map(question => question.id)
}

function mergeDecisionAnswers(existing: DecisionAnswer[], incoming: DecisionAnswer[], actorId: string): DecisionAnswer[] {
  const byId = new Map(existing.map(answer => [answer.questionId, answer]))
  const byQuestion = new Map(existing.flatMap(answer => {
    const key = answer.normalizedQuestion ?? normalizeQuestionText(answer.questionText)
    return key ? [[key, answer] as const] : []
  }))
  const updatedAt = new Date().toISOString()
  for (const answer of incoming) {
    const normalizedQuestion = answer.normalizedQuestion?.trim() || normalizeQuestionText(answer.questionText)
    const existingSemanticAnswer = normalizedQuestion ? byQuestion.get(normalizedQuestion) : undefined
    const nextAnswer = {
      questionId: answer.questionId,
      questionText: answer.questionText?.trim() || existingSemanticAnswer?.questionText,
      normalizedQuestion,
      answerType: answer.answerType,
      selectedOptionLabel: answer.selectedOptionLabel?.trim() || undefined,
      selectedOptionLabels: answer.selectedOptionLabels?.map(label => label.trim()).filter(Boolean) ?? undefined,
      customAnswer: answer.customAnswer?.trim() || undefined,
      notes: answer.notes?.trim() || undefined,
      updatedAt,
      updatedById: actorId,
    }
    if (existingSemanticAnswer && existingSemanticAnswer.questionId !== answer.questionId) byId.delete(existingSemanticAnswer.questionId)
    byId.set(answer.questionId, nextAnswer)
    if (normalizedQuestion) byQuestion.set(normalizedQuestion, nextAnswer)
  }
  return Array.from(byId.values())
}

function enrichDecisionAnswers(answers: DecisionAnswer[], loopDefinition: LoopDefinition): DecisionAnswer[] {
  if (answers.length === 0) return []
  const questionsById = new Map<string, LoopQuestion>()
  for (const stage of loopDefinition.stages) {
    for (const question of stage.questions ?? []) {
      questionsById.set(question.id, question)
    }
  }
  return answers.map(answer => {
    const question = questionsById.get(answer.questionId)
    const questionText = answer.questionText ?? question?.question
    const normalizedQuestion = answer.normalizedQuestion ?? normalizeQuestionText(questionText)
    return {
      ...answer,
      questionText,
      normalizedQuestion,
    }
  })
}

function hasDecisionAnswerForQuestion(question: LoopQuestion, answers: DecisionAnswer[]): boolean {
  const normalized = normalizeQuestionText(question.question)
  return answers.some(answer => {
    if (!isAnsweredDecision(answer)) return false
    if (answer.questionId === question.id) return true
    const answerQuestion = answer.normalizedQuestion ?? normalizeQuestionText(answer.questionText)
    return questionKeysMatch(normalized, answerQuestion)
  })
}

function questionKeysMatch(left?: string, right?: string): boolean {
  if (!left || !right) return false
  if (left === right) return true
  const leftTokens = new Set(left.split(' ').filter(token => token.length > 2))
  const rightTokens = new Set(right.split(' ').filter(token => token.length > 2))
  if (leftTokens.size < 4 || rightTokens.size < 4) return false
  let shared = 0
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1
  }
  const overlap = shared / Math.min(leftTokens.size, rightTokens.size)
  return overlap >= 0.72
}

function isAnsweredDecision(answer: DecisionAnswer): boolean {
  return Boolean(
    answer.selectedOptionLabel?.trim()
    || answer.selectedOptionLabels?.some(label => label.trim())
    || answer.customAnswer?.trim()
    || answer.notes?.trim(),
  )
}

function isLoopGreen(state: LoopState): boolean {
  return state.loopDefinition.stages
    .filter(stage => stage.required !== false)
    .every(stage => {
      const attempt = latestStageAttempt(state, stage.key)
      return attempt?.verdict === 'PASS' || attempt?.verdict === 'ACCEPTED_WITH_RISK'
    })
}

function hasUnresolvedWorkflowLink(state: LoopState): boolean {
  return state.reviewEvents.some(event => {
    if (event.type !== 'WORKFLOW_LINK_WARNING') return false
    return isRecord(event.payload) && event.payload.reason === 'workflow_instance_not_found'
  })
}

function sendBackCount(state: LoopState): number {
  return state.reviewEvents.filter(event => event.type === 'SEND_BACK' || event.type === 'AUTO_SEND_BACK').length
}

function reviewEvent(type: string, message: string, actorId: string, payload: Record<string, unknown> = {}): ReviewEvent {
  return {
    id: crypto.randomUUID(),
    type,
    stageKey: typeof payload.stageKey === 'string' ? payload.stageKey : undefined,
    targetStageKey: typeof payload.targetStageKey === 'string' ? payload.targetStageKey : undefined,
    attemptId: typeof payload.attemptId === 'string' ? payload.attemptId : undefined,
    message,
    actorId,
    payload,
    createdAt: new Date().toISOString(),
  }
}

function legacyStage(stage: LoopStageDefinition): BlueprintStage {
  const role = normalizeAgentRole(stage.agentRole)
  if (role.includes('DEV') || role === 'ENGINEER') return BlueprintStage.DEVELOPER
  if (role.includes('QA') || role.includes('TEST') || role.includes('VERIFY')) return BlueprintStage.QA
  return BlueprintStage.ARCHITECT
}

function buildFinalPack(state: LoopState, artifacts: Array<{ id: string; kind: string; payload?: Prisma.JsonValue | null }>, actorId: string): FinalPack {
  const latestAccepted = state.loopDefinition.stages.reduce<FinalPack['stages']>((acc, stage) => {
    const attempt = latestStageAttempt(state, stage.key)
    if (!attempt || (attempt.verdict !== 'PASS' && attempt.verdict !== 'ACCEPTED_WITH_RISK')) return acc
    acc.push({
      stageKey: stage.key,
      label: stage.label,
      verdict: attempt.verdict,
      attemptNumber: attempt.attemptNumber,
      artifactIds: attempt.artifactIds ?? [],
    })
    return acc
  }, [])
  const artifactKinds = new Set<string>()
  for (const artifact of artifacts) {
    const payload = isRecord(artifact.payload) ? artifact.payload : {}
    if (latestAccepted.some(stage => stage.artifactIds.includes(artifact.id)) || payload.stageKey) artifactKinds.add(artifact.kind)
  }
  const acceptedArtifactIds = new Set(latestAccepted.flatMap(stage => stage.artifactIds))
  const stageConsumables = artifacts
    .filter(artifact => acceptedArtifactIds.has(artifact.id))
    .map(readConsumableRefFromPayload)
    .filter((item): item is WorkbenchConsumableRef => Boolean(item))
  return {
    id: crypto.randomUUID(),
    status: 'READY_FOR_WORKFLOW_HANDOFF',
    generatedAt: new Date().toISOString(),
    generatedById: actorId,
    summary: `Final pack combines ${latestAccepted.length} accepted loop stages with ${state.decisionAnswers.length} captured stakeholder answers.`,
    stages: latestAccepted,
    artifactKinds: Array.from(artifactKinds).sort(),
    stageConsumables,
    consumableIds: uniqueStrings(stageConsumables.map(item => item.consumableId)),
  }
}

function buildFinalPackMarkdown(finalPack: FinalPack, state: LoopState) {
  return [
    '# Final Implementation Pack',
    '',
    `Status: ${finalPack.status}`,
    `Generated: ${finalPack.generatedAt}`,
    '',
    '## Summary',
    '',
    finalPack.summary,
    '',
    '## Accepted Stages',
    '',
    ...finalPack.stages.map(stage => `- ${stage.label}: ${stage.verdict} on attempt ${stage.attemptNumber}`),
    '',
    '## Stakeholder Answers',
    '',
    ...(state.decisionAnswers.length
      ? state.decisionAnswers.map(answer => `- ${answer.questionId}: ${answer.selectedOptionLabel ?? answer.customAnswer ?? answer.notes ?? 'answered'}`)
      : ['- No stakeholder answers captured.']),
    '',
    '## Artifact Kinds',
    '',
    ...finalPack.artifactKinds.map(kind => `- ${kind}`),
  ].join('\n')
}

async function attachFinalPackToWorkflowNode(
  session: { id: string; workflowInstanceId?: string | null; metadata?: Prisma.JsonValue },
  finalPack: FinalPack,
  actorId: string,
  artifacts: Array<BlueprintArtifactRecord & { createdAt?: Date | string | null }> = [],
) {
  const state = readLoopState(session as LoopSessionSeed)
  if (!session.workflowInstanceId || !state.workflowNodeId) return
  const node = await prisma.workflowNode.findFirst({
    where: { id: state.workflowNodeId, instanceId: session.workflowInstanceId },
    select: { id: true, config: true, instanceId: true },
  })
  if (!node) return
  const config = isRecord(node.config) ? node.config : {}
  const workbench = isRecord(config.workbench) ? config.workbench : {}
  const outputs = isRecord(workbench.outputs) ? workbench.outputs : {}
  const finalPackKey = typeof outputs.finalPackKey === 'string' && outputs.finalPackKey.trim()
    ? outputs.finalPackKey.trim()
    : 'finalImplementationPack'
  const workbenchDocuments = buildWorkbenchDocumentRefs(artifacts)
  const workbenchDocumentsByKind = workbenchDocumentsByKindMap(workbenchDocuments)
  const workflowOutput = {
    blueprintSessionId: session.id,
    workbenchStatus: 'FINALIZED',
    finalImplementationPack: finalPack,
    [finalPackKey]: finalPack,
    finalPackConsumableId: finalPack.finalPackConsumableId,
    stageConsumables: finalPack.stageConsumables ?? [],
    consumableIds: finalPack.consumableIds ?? [],
    stageArtifactsByKind: stageConsumablesByKind(finalPack.stageConsumables ?? []),
    workbenchArtifacts: workbenchDocuments,
    workbenchDocuments,
    workbenchArtifactsByKind: workbenchDocumentsByKind,
    workbenchDocumentsByKind,
    workbench: {
      profile: typeof workbench.profile === 'string' ? workbench.profile : 'blueprint',
      sessionId: session.id,
      workflowInstanceId: node.instanceId,
      workflowNodeId: node.id,
      completedAt: finalPack.generatedAt,
      finalPackConsumableId: finalPack.finalPackConsumableId,
      stageConsumables: finalPack.stageConsumables ?? [],
      consumableIds: finalPack.consumableIds ?? [],
      stageArtifactsByKind: stageConsumablesByKind(finalPack.stageConsumables ?? []),
      artifacts: workbenchDocuments,
      documents: workbenchDocuments,
      artifactsByKind: workbenchDocumentsByKind,
      documentsByKind: workbenchDocumentsByKind,
    },
  }
  const nextConfig = {
    ...config,
    workbench: {
      ...workbench,
      sessionId: session.id,
      finalPack,
      output: workflowOutput,
      finalizedAt: finalPack.generatedAt,
    },
  }
  await prisma.$transaction([
    prisma.workflowNode.update({
      where: { id: node.id },
      data: { config: nextConfig as Prisma.InputJsonValue },
    }),
    prisma.workflowMutation.create({
      data: {
        instanceId: node.instanceId,
        nodeId: node.id,
        mutationType: 'BLUEPRINT_FINAL_PACK_ATTACHED',
        beforeState: { workbench } as Prisma.InputJsonValue,
        afterState: { workbench: nextConfig.workbench } as Prisma.InputJsonValue,
        performedById: actorId,
      },
    }),
  ])
  await logEvent('BlueprintFinalPackAttachedToWorkflowNode', 'WorkflowNode', node.id, actorId, {
    sessionId: session.id,
    finalPackId: finalPack.id,
    finalPackConsumableId: finalPack.finalPackConsumableId,
    consumableIds: finalPack.consumableIds ?? [],
    workflowInstanceId: node.instanceId,
  })
  await publishOutbox('WorkflowNode', node.id, 'BlueprintFinalPackAttached', {
    sessionId: session.id,
    finalPackId: finalPack.id,
    finalPackConsumableId: finalPack.finalPackConsumableId,
    consumableIds: finalPack.consumableIds ?? [],
    workflowInstanceId: node.instanceId,
    actorId,
  })
  await completeLinkedWorkbenchTask({
    instanceId: node.instanceId,
    nodeId: node.id,
    sessionId: session.id,
    finalPackId: finalPack.id,
    output: workflowOutput,
    actorId,
  })
}

async function completeLinkedWorkbenchTask({
  instanceId,
  nodeId,
  sessionId,
  finalPackId,
  output,
  actorId,
}: {
  instanceId: string
  nodeId: string
  sessionId: string
  finalPackId: string
  output: Record<string, unknown>
  actorId: string
}) {
  const node = await prisma.workflowNode.findFirst({
    where: { id: nodeId, instanceId },
    select: { id: true, status: true },
  })
  if (!node || node.status === 'COMPLETED') return
  if (node.status !== 'ACTIVE') {
    await logEvent('BlueprintWorkflowAutoAdvanceSkipped', 'WorkflowNode', nodeId, actorId, {
      instanceId,
      sessionId,
      finalPackId,
      nodeStatus: node.status,
      reason: 'workbench node is not active',
    })
    return
  }

  const task = await prisma.task.findFirst({
    where: {
      instanceId,
      nodeId,
      status: { not: 'COMPLETED' },
    },
    orderBy: { createdAt: 'desc' },
  })

  if (task) {
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'COMPLETED' },
    })
    await prisma.taskStatusHistory.create({
      data: {
        taskId: task.id,
        previousStatus: task.status,
        newStatus: 'COMPLETED',
        changedById: actorId,
      },
    })
    const eventId = await logEvent('TaskCompleted', 'Task', task.id, actorId, {
      instanceId,
      nodeId,
      completedBy: 'blueprint-workbench-finalize',
      blueprintSessionId: sessionId,
      finalPackId,
    })
    await createReceipt('TASK_COMPLETED', 'Task', task.id, {
      taskId: task.id,
      completedBy: actorId,
      instanceId,
      nodeId,
      blueprintSessionId: sessionId,
      finalPackId,
    }, eventId)
    await publishOutbox('Task', task.id, 'TaskCompleted', {
      taskId: task.id,
      instanceId,
      nodeId,
      blueprintSessionId: sessionId,
      finalPackId,
      completedBy: actorId,
    })
  }

  // M94.2 (2026-05-28) — ⚠️ NOT RUNTIME-VERIFIED. In multinode mode the
  // per-stage verdict hook (advanceMultinodeStageNode) already completes
  // each stage-node, including the terminal QA node which flows into the
  // child END. The single-node finalization advance below would target
  // the session's origin node (Story Intake), which is long-completed —
  // re-advancing it risks a double-advance / wrong-node error. So skip
  // the finalization advance entirely when multinode is on; node
  // completion is the verdict hook's job there.
  if (multinodeEnabled()) {
    await logEvent('BlueprintWorkflowFinalizeSkippedMultinode', 'WorkflowNode', nodeId, actorId, {
      instanceId,
      sessionId,
      finalPackId,
      reason: 'multinode-per-stage-advance-owns-completion',
    })
    return
  }

  try {
    const { advance } = await import('../workflow/runtime/WorkflowRuntime')
    await advance(instanceId, nodeId, output, actorId)
    await logEvent('BlueprintWorkflowAutoAdvanced', 'WorkflowNode', nodeId, actorId, {
      instanceId,
      sessionId,
      finalPackId,
    })
  } catch (err) {
    console.error('Workflow auto-advance failed after Blueprint finalization:', err)
    await logEvent('BlueprintWorkflowAutoAdvanceFailed', 'WorkflowNode', nodeId, actorId, {
      instanceId,
      sessionId,
      finalPackId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function runStage(
  session: Awaited<ReturnType<typeof prisma.blueprintSession.findUnique>> & { id: string },
  snapshot: { id?: string; summary: Prisma.JsonValue; manifest: Prisma.JsonValue; rootHash: string | null },
  stage: BlueprintStage,
  agentTemplateId: string,
  task: string,
  // M36.2 — resolved by caller from prompt-composer (was: stageSystemPrompt(stage))
  systemPromptAppend: string,
): Promise<ExecuteResponse> {
  const traceId = `blueprint-${session.id}-${stage.toLowerCase()}`
  const loopStateForStage = readLoopState(session)
  const executionConfig = loopStateForStage.executionConfig
  const stageKey = stage.toLowerCase()
  const modelAlias = stageModelAlias(executionConfig, stageKey, humanStage(stage))
  const limits = workbenchExecutionLimits(executionConfig)
  const isDeveloperStage = stage === BlueprintStage.DEVELOPER
  // Pull the stage definition off the workflow's loopDefinition so we
  // can honor `limits.maxSteps` if the WORKBENCH_TASK node declared one.
  // Falls back to env-based class defaults via resolveStageMaxSteps when
  // the loopDefinition is silent.
  const stageDefForLimits = loopStateForStage.loopDefinition.stages.find(s => s.key === stageKey)
  const stageMaxSteps = stageDefForLimits ? resolveStageMaxSteps(stageDefForLimits)
    : isDeveloperStage ? WORKBENCH_DEVELOPER_MAX_STEPS
      : stage === BlueprintStage.QA ? WORKBENCH_QA_MAX_STEPS
        : WORKBENCH_DEFAULT_MAX_STEPS
  // Same precedence for the wall-clock budget — workflow node's
  // `limits.timeoutSec` wins, else role-class default. See
  // resolveStageTimeoutSec for the nginx-coordinated ceiling.
  const stageTimeoutSec = stageDefForLimits ? resolveStageTimeoutSec(stageDefForLimits)
    : isDeveloperStage ? 540
      : stage === BlueprintStage.QA ? 540
        : 360
  const linkedWorkItem = await workflowWorkItemContext(session.workflowInstanceId)
  const snapshotArtifact = buildSnapshotExecuteArtifact(snapshot, {
    stageKey,
    stageLabel: humanStage(stage),
    task,
    snapshotMode: executionConfig?.snapshotMode,
    excerptBudgetChars: executionConfig?.excerptBudgetChars,
  })
  return contextFabricClient.execute({
    trace_id: traceId,
    idempotency_key: `${session.id}:${stage}`,
    run_context: {
      workflow_instance_id: session.workflowInstanceId ?? `blueprint-${session.id}`,
      workflow_node_id: session.phaseId ?? `blueprint-${stage.toLowerCase()}`,
      // (2026-06-02 M81 cross-stage fix) The WorkItem identity is no longer
      // gated to the developer stage. This legacy ARCHITECT → DEVELOPER → QA
      // flow shares one workspace, but gating work_item_id/work_item_code to
      // the developer meant the QA stage reached mcp-server with NO workitem
      // identity — so workspaceRootForRunContext dropped it onto the base
      // sandbox root instead of the per-workitem worktree the developer
      // committed to, and QA reviewed an empty/re-cloned tree rather than the
      // diff. Every stage now keys off the same workitem (the governed coding
      // path at the runCodingStageGoverned call site already does this), so
      // downstream review stages read the developer's work directly.
      work_item_id: linkedWorkItem.workItemId,
      work_item_code: linkedWorkItem.workItemCode,
      capability_id: session.capabilityId,
      agent_template_id: agentTemplateId,
      user_id: session.createdById ?? undefined,
      trace_id: traceId,
    },
    task,
    vars: {
      blueprintSessionId: session.id,
      sourceType: session.sourceType,
      sourceUri: session.sourceUri,
      sourceRef: session.sourceRef,
      stage,
      modelAlias,
    },
    artifacts: [
      {
        label: 'Source snapshot',
        role: 'CONTEXT',
        mediaType: 'application/json',
        content: encodeComposerArtifactContent(snapshotArtifact),
      },
    ],
    overrides: {
      // M36.2 — systemPromptAppend resolved by caller via prompt-composer
      // /api/v1/stage-prompts/resolve.
      systemPromptAppend,
      extraContext: isDeveloperStage
        ? 'Use the writable MCP workspace for real code edits. Inspect relevant symbols/files first, apply the requested change with tools, and finish the work branch so MCP returns code-change receipts and a git diff for human review.'
        : undefined,
    },
    model_overrides: {
      ...(modelAlias ? { modelAlias } : {}),
      temperature: 0.2,
      maxOutputTokens: limits.maxOutputTokens,
      promptCache: {
        enabled: true,
        strategy: 'provider_auto',
        key: `${session.id}:${stageKey}:${session.sourceRef ?? 'default'}`,
      },
    },
    context_policy: {
      optimizationMode: 'code_aware',
      maxContextTokens: limits.maxContextTokens,
      compareWithRaw: false,
      knowledgeTopK: 4,
      memoryTopK: 2,
      codeTopK: 5,
      maxLayerChars: limits.maxLayerChars,
      maxPromptChars: limits.maxPromptChars,
    },
    limits: {
      maxSteps: stageMaxSteps,
      timeoutSec: stageTimeoutSec,
      inputTokenBudget: limits.maxContextTokens,
      outputTokenBudget: limits.maxOutputTokens,
      maxHistoryMessages: 16,
      maxHistoryTokens: Math.max(1000, Math.floor(limits.maxContextTokens * 0.75)),
      summaryEveryMessages: 6,
      compressToolResults: true,
      maxToolResultChars: 8000,
      maxPromptChars: limits.maxPromptChars,
      // ── Phased Agent Reasoning Model (v4) ──────────────────────────
      // Only opted in for developer stages; read-only stages (PLAN, DESIGN,
      // QA_REVIEW etc.) use the existing flat-loop path. Server still has
      // to honor MCP_AGENT_PHASES_ENABLED; passing this here is a no-op
      // unless both flags align.
      ...(WORKBENCH_AGENT_PHASES_ENABLED && isDeveloperStage
        ? {
            agentReasoningMode: 'phased' as const,
            phaseBudgets: WORKBENCH_DEVELOPER_PHASE_BUDGETS,
          }
        : {}),
    },
    governance_mode: executionConfig?.governanceMode ?? 'fail_open',
  })
}

async function recordBlueprintBudgetUsage(
  session: { workflowInstanceId?: string | null; workflowNodeId?: string | null; phaseId?: string | null },
  result: ExecuteResponse,
  stageKey: string,
  workflowNodeId?: string | null,
) {
  if (!session.workflowInstanceId) return
  try {
    await recordWorkflowLlmUsage(session.workflowInstanceId, {
      nodeId: workflowNodeId ?? session.workflowNodeId ?? session.phaseId ?? null,
      cfCallId: result.correlation.cfCallId,
      promptAssemblyId: result.correlation.promptAssemblyId,
      inputTokens: result.tokensUsed?.input,
      outputTokens: result.tokensUsed?.output,
      totalTokens: result.tokensUsed?.total,
      estimatedCost: result.modelUsage?.estimatedCost ?? result.usage?.estimatedCost ?? result.tokensUsed?.estimatedCost ?? result.tokensUsed?.estimated_cost,
      provider: result.modelUsage?.provider,
      model: result.modelUsage?.model,
      metadata: {
        source: 'blueprint-workbench',
        stageKey,
        modelAlias: result.modelUsage?.modelAlias ?? result.usage?.modelAlias ?? result.correlation.modelAlias,
        finishReason: result.finishReason,
        status: result.status,
        tokensSaved: result.usage?.tokensSaved,
        promptCache: result.modelUsage?.promptCache ?? result.usage?.promptCache ?? result.promptCache ?? result.tokensUsed?.promptCache,
      },
    })
  } catch (err) {
    await logEvent('WorkflowBudgetUsageRecordFailed', 'WorkflowInstance', session.workflowInstanceId, undefined, {
      stageKey,
      cfCallId: result.correlation.cfCallId,
      error: (err as Error).message,
    })
  }
}

type ArtifactSession = {
  id: string
  goal: string
  sourceType: BlueprintSourceType
  sourceUri: string
  sourceRef?: string | null
  capabilityId?: string | null
  workflowInstanceId?: string | null
  workflowNodeId?: string | null
  phaseId?: string | null
  createdById?: string | null
  metadata?: Prisma.JsonValue
}

type ArtifactSnapshot = {
  summary: Prisma.JsonValue
  manifest: Prisma.JsonValue
  rootHash: string | null
}

async function createStageArtifacts(session: ArtifactSession, snapshot: ArtifactSnapshot, stage: BlueprintStage, result: ExecuteResponse) {
  const ctx = buildSnapshotContext(snapshot)
  const response = isUsefulModelResponse(result.finalResponse)
    ? `\n\n## Model notes\n\n${result.finalResponse}`
    : ''
  const commonPayload = {
    workflowInstanceId: session.workflowInstanceId ?? undefined,
    workflowNodeId: readLoopState(session).workflowNodeId ?? undefined,
    stageKey: stage.toLowerCase(),
    stageLabel: humanStage(stage),
    cfCallId: result.correlation.cfCallId,
    traceId: result.correlation.traceId,
    promptAssemblyId: result.correlation.promptAssemblyId,
    mcpInvocationId: result.correlation.mcpInvocationId,
    codeChangeIds: result.correlation.codeChangeIds ?? [],
    status: result.status,
    tokensUsed: result.tokensUsed ?? {},
    modelUsage: result.modelUsage ?? {},
    usage: result.usage ?? {},
    metrics: result.metrics ?? {},
    warnings: result.warnings ?? [],
  }
  type ArtifactSpec = { kind: string; title: string; content: string; payload?: Record<string, unknown> }
  const codeChangeEvidence = stage === BlueprintStage.DEVELOPER ? buildActualCodeChangeEvidence(session, ctx, result) : undefined
  const artifacts =
    stage === BlueprintStage.ARCHITECT ? [
      { kind: 'decision_tree', title: 'Question tree', content: buildDecisionTreeMarkdown(session, ctx), payload: { tree: buildDecisionTreePayload(session, ctx) } },
      { kind: 'agent_questions', title: 'Agent questions', content: buildAgentQuestions(session, ctx) },
      { kind: 'mental_model', title: 'Mental model', content: buildMentalModel(session, ctx) },
      { kind: 'gaps', title: 'Gaps and open questions', content: buildGaps(session, ctx) },
      { kind: 'solution_architecture', title: 'Solution architecture', content: buildSolutionArchitecture(session, ctx) },
      { kind: 'approved_spec_draft', title: 'Approved spec draft', content: buildApprovedSpec(session, ctx, response) },
    ] :
	    stage === BlueprintStage.DEVELOPER ? [
	      { kind: 'developer_task_pack', title: 'Developer task pack', content: buildDeveloperTaskPack(session, ctx, response) },
	      {
	        kind: 'actual_code_change',
	        title: 'Actual MCP/git code-change evidence',
	        content: codeChangeEvidence?.markdown ?? '',
	        payload: {
	          paths: codeChangeEvidence?.paths ?? [],
	          diff: codeChangeEvidence?.diff ?? '',
	          lines_added: codeChangeEvidence?.linesAdded ?? 0,
	          lines_removed: codeChangeEvidence?.linesRemoved ?? 0,
	          actual: codeChangeEvidence?.actual ?? false,
	          simulated: false,
	          codeChangeIds: codeChangeEvidence?.codeChangeIds ?? [],
	          workspaceBranch: codeChangeEvidence?.workspaceBranch,
	          workspaceCommitSha: codeChangeEvidence?.workspaceCommitSha,
	          workspaceRoot: codeChangeEvidence?.workspaceRoot,
	          astIndexStatus: codeChangeEvidence?.astIndexStatus,
	        },
	      },
	    ] : [
	      { kind: 'implementation_contract', title: 'Implementation contract', content: buildImplementationContractMarkdown(session, ctx, readSessionDecisionAnswers(session)), payload: { contract: buildImplementationContractPayload(session, ctx, readSessionDecisionAnswers(session)) } },
	      { kind: 'qa_task_pack', title: 'QA task pack', content: buildQaTaskPack(session, ctx, response) },
	      { kind: 'verification_rules', title: 'Verification rules', content: buildVerificationRules(session, ctx) },
	      { kind: 'traceability_matrix', title: 'Traceability matrix', content: buildTraceabilityMatrix() },
	      { kind: 'certification_receipt', title: 'Certification receipt', content: buildCertificationReceipt(session, ctx) },
	    ] satisfies ArtifactSpec[]

  for (const artifactSpec of artifacts) {
    const artifact = await prisma.blueprintArtifact.create({
      data: {
        sessionId: session.id,
        stage,
        kind: artifactSpec.kind,
        title: artifactSpec.title,
        content: artifactSpec.content,
        payload: { ...commonPayload, ...(artifactSpec.payload ?? {}) } as Prisma.InputJsonValue,
      },
    })
    await publishBlueprintArtifactAsConsumable({
      session,
      artifact,
      typeName: 'WORKBENCH_STAGE_ARTIFACT',
      status: 'UNDER_REVIEW',
      extraPayload: artifactSpec.payload ?? {},
    })
  }
}

type BlueprintArtifactRecord = {
  id: string
  stage?: BlueprintStage | null
  kind: string
  title: string
  content?: string | null
  payload?: Prisma.JsonValue | null
}

async function publishBlueprintArtifactAsConsumable(args: {
  session: ArtifactSession
  artifact: BlueprintArtifactRecord
  typeName: 'WORKBENCH_STAGE_ARTIFACT' | 'WORKBENCH_FINAL_PACK'
  status: ConsumableStatus
  actorId?: string
  stage?: LoopStageDefinition
  attempt?: StageAttempt
  extraPayload?: Record<string, unknown>
}): Promise<WorkbenchConsumableRef | undefined> {
  const state = readLoopState(args.session)
  const rawWorkflowInstanceId = args.session.workflowInstanceId ?? undefined
  const rawWorkflowNodeId = state.workflowNodeId ?? args.session.workflowNodeId ?? args.session.phaseId ?? undefined
  if (!rawWorkflowInstanceId) return undefined
  if (!rawWorkflowNodeId) {
    await markConsumablePublishSkipped({
      session: args.session,
      artifact: args.artifact,
      actorId: args.actorId,
      warning: {
        reason: 'workflow_node_not_found',
        message: 'Workflow run is linked, but no workflow node id was provided. Workbench artifact was kept locally and no workflow consumable was created.',
        workflowInstanceId: rawWorkflowInstanceId,
        workflowNodeId: undefined,
        suggestedFix: 'Open the Workbench from the Workbench Task drawer or regenerate the embedded Workbench URL so workflowNodeId is present.',
      },
    })
    return undefined
  }
  const workflowLink = await resolveWorkflowLink(rawWorkflowInstanceId, rawWorkflowNodeId)
  if (!workflowLink.workflowInstanceId) {
    await markConsumablePublishSkipped({
      session: args.session,
      artifact: args.artifact,
      actorId: args.actorId,
      warning: workflowLink.warning ?? {
        reason: 'workflow_instance_not_found',
        message: 'Workflow run was not found. Workbench artifact was kept locally and no workflow consumable was created.',
        workflowInstanceId: rawWorkflowInstanceId,
        workflowNodeId: rawWorkflowNodeId,
        suggestedFix: 'Open the Workbench from an active workflow run/task.',
      },
    })
    return undefined
  }
  const workflowInstanceId = workflowLink.workflowInstanceId
  const workflowNodeId = workflowLink.workflowNodeId ?? rawWorkflowNodeId

  const type = await prisma.consumableType.upsert({
    where: { name: args.typeName },
    update: {},
    create: {
      name: args.typeName,
      description: args.typeName === 'WORKBENCH_FINAL_PACK'
        ? 'Approved Workbench final implementation pack for workflow handoff.'
        : 'Reviewable Blueprint Workbench stage artifact with receipt lineage.',
      requiresApproval: args.typeName !== 'WORKBENCH_FINAL_PACK',
      allowVersioning: true,
      schemaDef: {},
    },
  })

  const artifactPayload = isRecord(args.artifact.payload) ? args.artifact.payload : {}
  const stageKey = typeof artifactPayload.stageKey === 'string' ? artifactPayload.stageKey : args.stage?.key
  const stageLabel = typeof artifactPayload.stageLabel === 'string' ? artifactPayload.stageLabel : args.stage?.label
  const attemptId = typeof artifactPayload.attemptId === 'string' ? artifactPayload.attemptId : args.attempt?.id
  const attemptNumber = typeof artifactPayload.version === 'number' ? artifactPayload.version : args.attempt?.attemptNumber
  const name = args.typeName === 'WORKBENCH_FINAL_PACK'
    ? `Final implementation pack - ${args.session.id}`
    : `${stageLabel ?? 'Workbench stage'} - ${args.artifact.title}`
  const payload = {
    artifactType: args.typeName === 'WORKBENCH_FINAL_PACK' ? 'workbench_final_pack' : 'workbench_stage_artifact',
    blueprintArtifactId: args.artifact.id,
    blueprintSessionId: args.session.id,
    workflowInstanceId,
    workflowNodeId,
    capabilityId: args.session.capabilityId ?? undefined,
    stageKey,
    stageLabel,
    artifactKind: args.artifact.kind,
    title: args.artifact.title,
    content: args.artifact.content ?? '',
    attemptId,
    attemptNumber,
    agentRole: args.stage?.agentRole ?? artifactPayload.agentRole,
    agentTemplateId: args.attempt?.agentTemplateId ?? artifactPayload.agentTemplateId,
    source: {
      sourceType: args.session.sourceType,
      sourceUri: args.session.sourceUri,
      sourceRef: args.session.sourceRef ?? undefined,
    },
    receipt: {
      cfCallId: artifactPayload.cfCallId,
      traceId: artifactPayload.traceId,
      promptAssemblyId: artifactPayload.promptAssemblyId,
      mcpInvocationId: artifactPayload.mcpInvocationId,
      tokensUsed: artifactPayload.tokensUsed,
      modelUsage: artifactPayload.modelUsage,
      usage: artifactPayload.usage,
      metrics: artifactPayload.metrics,
      codeChangeIds: artifactPayload.codeChangeIds,
      warnings: artifactPayload.warnings,
    },
    approval: {
      approvalRequired: args.extraPayload?.approvalRequired ?? artifactPayload.approvalRequired ?? args.typeName !== 'WORKBENCH_FINAL_PACK',
      status: args.status,
    },
    ...(args.extraPayload ?? {}),
  }

  const existing = await prisma.consumable.findFirst({
    where: { typeId: type.id, instanceId: workflowInstanceId, nodeId: workflowNodeId, name },
    select: { id: true, currentVersion: true },
  })

  let consumableId: string
  let version: number
  if (existing) {
    consumableId = existing.id
    version = existing.currentVersion + 1
    await prisma.consumableVersion.create({
      data: {
        consumableId,
        version,
        payload: payload as Prisma.InputJsonValue,
        createdById: args.actorId ?? args.session.createdById ?? undefined,
      },
    })
    await prisma.consumable.update({
      where: { id: consumableId },
      data: {
        status: args.status,
        currentVersion: version,
        formData: payload as Prisma.InputJsonValue,
        capabilityId: args.session.capabilityId ?? undefined,
      },
    })
  } else {
    const created = await prisma.consumable.create({
      data: {
        typeId: type.id,
        instanceId: workflowInstanceId,
        nodeId: workflowNodeId,
        name,
        status: args.status,
        currentVersion: 1,
        formData: payload as Prisma.InputJsonValue,
        capabilityId: args.session.capabilityId ?? undefined,
        createdById: args.actorId ?? args.session.createdById ?? undefined,
        versions: {
          create: {
            version: 1,
            payload: payload as Prisma.InputJsonValue,
            createdById: args.actorId ?? args.session.createdById ?? undefined,
          },
        },
      },
    })
    consumableId = created.id
    version = 1
  }

  const ref: WorkbenchConsumableRef = {
    artifactId: args.artifact.id,
    artifactKind: args.artifact.kind,
    title: args.artifact.title,
    consumableId,
    consumableVersion: version,
    status: args.status,
    stageKey,
    stageLabel,
    attemptId,
    artifactRequired: args.extraPayload?.artifactRequired === false ? false : undefined,
  }
  await prisma.blueprintArtifact.update({
    where: { id: args.artifact.id },
    data: {
      payload: {
        ...artifactPayload,
        consumableId,
        consumableVersion: version,
        consumableStatus: args.status,
        consumable: ref,
      } as Prisma.InputJsonValue,
    },
  })
  await logEvent(existing ? 'WorkbenchConsumableVersioned' : 'WorkbenchConsumableCreated', 'Consumable', consumableId, args.actorId ?? args.session.createdById ?? undefined, {
    blueprintSessionId: args.session.id,
    blueprintArtifactId: args.artifact.id,
    workflowInstanceId,
    workflowNodeId,
    stageKey,
    artifactKind: args.artifact.kind,
    version,
  })
  await publishOutbox('Consumable', consumableId, existing ? 'WorkbenchConsumableVersioned' : 'WorkbenchConsumableCreated', {
    consumableId,
    blueprintSessionId: args.session.id,
    blueprintArtifactId: args.artifact.id,
    workflowInstanceId,
    workflowNodeId,
    stageKey,
    artifactKind: args.artifact.kind,
    version,
  })
  return ref
}

async function markConsumablePublishSkipped(args: {
  session: ArtifactSession
  artifact: BlueprintArtifactRecord
  actorId?: string
  warning: WorkflowLinkWarning
}) {
  const artifactPayload = isRecord(args.artifact.payload) ? args.artifact.payload : {}
  const consumablePublish = {
    status: 'SKIPPED',
    skippedAt: new Date().toISOString(),
    ...args.warning,
  }
  await prisma.blueprintArtifact.update({
    where: { id: args.artifact.id },
    data: {
      payload: {
        ...artifactPayload,
        consumablePublish,
        warnings: [
          ...jsonArray(artifactPayload.warnings),
          args.warning.message,
        ],
      } as Prisma.InputJsonValue,
    },
  })
  await logEvent('WorkbenchConsumablePublishSkipped', 'BlueprintArtifact', args.artifact.id, args.actorId ?? args.session.createdById ?? undefined, {
    blueprintSessionId: args.session.id,
    blueprintArtifactId: args.artifact.id,
    ...args.warning,
  })
}

async function transitionAttemptConsumables(
  artifactIds: string[],
  status: ConsumableStatus,
  actorId: string,
  eventType: string,
  metadata: Record<string, unknown>,
) {
  if (artifactIds.length === 0) return
  const artifacts = await prisma.blueprintArtifact.findMany({
    where: { id: { in: artifactIds } },
    select: { id: true, kind: true, title: true, payload: true },
  })
  for (const artifact of artifacts) {
    const ref = readConsumableRefFromPayload(artifact)
    if (!ref) continue
    const consumable = await prisma.consumable.findUnique({
      where: { id: ref.consumableId },
      select: { formData: true },
    })
    const formData = isRecord(consumable?.formData) ? consumable.formData : {}
    const approval = isRecord(formData.approval) ? formData.approval : {}
    await prisma.consumable.update({
      where: { id: ref.consumableId },
      data: {
        status,
        formData: {
          ...formData,
          approval: { ...approval, status },
        } as Prisma.InputJsonValue,
      },
    })
    const payload = isRecord(artifact.payload) ? artifact.payload : {}
    await prisma.blueprintArtifact.update({
      where: { id: artifact.id },
      data: {
        payload: {
          ...payload,
          consumableStatus: status,
          consumable: { ...ref, status },
        } as Prisma.InputJsonValue,
      },
    })
    await logEvent(eventType, 'Consumable', ref.consumableId, actorId, {
      ...metadata,
      blueprintArtifactId: artifact.id,
      artifactKind: artifact.kind,
      consumableId: ref.consumableId,
      status,
    })
    await publishOutbox('Consumable', ref.consumableId, eventType, {
      ...metadata,
      blueprintArtifactId: artifact.id,
      artifactKind: artifact.kind,
      consumableId: ref.consumableId,
      status,
    })
  }
}

function readConsumableRefFromPayload(artifact: {
  id?: string
  kind?: string
  title?: string
  payload?: Prisma.JsonValue | Record<string, unknown> | null
}): WorkbenchConsumableRef | undefined {
  const payload = isRecord(artifact.payload) ? artifact.payload : {}
  const nested = isRecord(payload.consumable) ? payload.consumable : {}
  const consumableId = typeof payload.consumableId === 'string'
    ? payload.consumableId
    : typeof nested.consumableId === 'string' ? nested.consumableId : undefined
  if (!consumableId) return undefined
  const consumableVersion = typeof payload.consumableVersion === 'number'
    ? payload.consumableVersion
    : typeof nested.consumableVersion === 'number' ? nested.consumableVersion : 1
  const status = typeof payload.consumableStatus === 'string'
    ? payload.consumableStatus
    : typeof nested.status === 'string' ? nested.status : 'UNDER_REVIEW'
  return {
    artifactId: typeof nested.artifactId === 'string' ? nested.artifactId : artifact.id ?? '',
    artifactKind: typeof nested.artifactKind === 'string' ? nested.artifactKind : artifact.kind ?? '',
    title: typeof nested.title === 'string' ? nested.title : artifact.title ?? '',
    consumableId,
    consumableVersion,
    status,
    stageKey: typeof payload.stageKey === 'string' ? payload.stageKey : typeof nested.stageKey === 'string' ? nested.stageKey : undefined,
    stageLabel: typeof payload.stageLabel === 'string' ? payload.stageLabel : typeof nested.stageLabel === 'string' ? nested.stageLabel : undefined,
    attemptId: typeof payload.attemptId === 'string' ? payload.attemptId : typeof nested.attemptId === 'string' ? nested.attemptId : undefined,
    artifactRequired: typeof payload.artifactRequired === 'boolean' ? payload.artifactRequired : typeof nested.artifactRequired === 'boolean' ? nested.artifactRequired : undefined,
  }
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))))
}

function stageConsumablesByKind(refs: WorkbenchConsumableRef[]): Record<string, WorkbenchConsumableRef[]> {
  return refs.reduce<Record<string, WorkbenchConsumableRef[]>>((acc, ref) => {
    const key = ref.artifactKind || 'artifact'
    acc[key] = [...(acc[key] ?? []), ref]
    return acc
  }, {})
}

function buildWorkbenchDocumentRefs(
  artifacts: Array<BlueprintArtifactRecord & { createdAt?: Date | string | null }>,
): WorkbenchDocumentRef[] {
  return artifacts.map(artifact => {
    const payload = isRecord(artifact.payload) ? artifact.payload : {}
    const consumable = isRecord(payload.consumable) ? payload.consumable : {}
    const stage = typeof artifact.stage === 'string' ? artifact.stage : undefined
    const stageKey = typeof payload.stageKey === 'string'
      ? payload.stageKey
      : typeof consumable.stageKey === 'string' ? consumable.stageKey : stage?.toLowerCase()
    const createdAt = artifact.createdAt instanceof Date
      ? artifact.createdAt.toISOString()
      : typeof artifact.createdAt === 'string' ? artifact.createdAt : undefined
    return {
      id: artifact.id,
      artifactId: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      stage,
      stageKey,
      attemptId: typeof payload.attemptId === 'string' ? payload.attemptId : typeof consumable.attemptId === 'string' ? consumable.attemptId : undefined,
      version: typeof payload.version === 'number' ? payload.version : undefined,
      content: artifact.content ?? '',
      createdAt,
      consumableId: typeof payload.consumableId === 'string' ? payload.consumableId : typeof consumable.consumableId === 'string' ? consumable.consumableId : undefined,
      consumableVersion: typeof payload.consumableVersion === 'number' ? payload.consumableVersion : typeof consumable.consumableVersion === 'number' ? consumable.consumableVersion : undefined,
      consumableStatus: typeof payload.consumableStatus === 'string' ? payload.consumableStatus : typeof consumable.status === 'string' ? consumable.status : undefined,
      source: 'blueprint-workbench',
    }
  })
}

function workbenchDocumentsByKindMap(refs: WorkbenchDocumentRef[]): Record<string, WorkbenchDocumentRef[]> {
  return refs.reduce<Record<string, WorkbenchDocumentRef[]>>((acc, ref) => {
    const key = ref.kind || 'artifact'
    acc[key] = [...(acc[key] ?? []), ref]
    return acc
  }, {})
}

type SnapshotContext = {
  files: ManifestEntry[]
  sampledFiles: Array<{ path: string; excerpt: string }>
  languages: Record<string, number>
  keyFiles: string[]
  hasBetweenEnum: boolean
  hasBetweenSwitch: boolean
  hasLengthCase: boolean
  hasLengthEnum: boolean
}

function emptySnapshotContext(): SnapshotContext {
  return {
    files: [],
    sampledFiles: [],
    languages: {},
    keyFiles: [],
    hasBetweenEnum: false,
    hasBetweenSwitch: false,
    hasLengthCase: false,
    hasLengthEnum: false,
  }
}

function buildSnapshotContext(snapshot: ArtifactSnapshot): SnapshotContext {
  const files = Array.isArray(snapshot.manifest) ? snapshot.manifest as ManifestEntry[] : []
  const summary = isRecord(snapshot.summary) ? snapshot.summary : {}
  const sampledFiles = Array.isArray(summary.sampledFiles)
    ? summary.sampledFiles.filter((f): f is { path: string; excerpt: string } =>
        isRecord(f) && typeof f.path === 'string' && typeof f.excerpt === 'string',
      )
    : []
  const languages = isRecord(summary.languages) ? Object.fromEntries(
    Object.entries(summary.languages).filter(([, v]) => typeof v === 'number'),
  ) as Record<string, number> : {}
  const keyFiles = files
    .map(f => f.path)
    .filter(p => /RuleEngineService|Operator|Controller|EvaluateRequest|EvaluateResponse|RuleEngine.*Test/.test(p))
    .slice(0, 12)
  const operator = sampledFiles.find(f => f.path.endsWith('Operator.java'))?.excerpt ?? ''
  const service = sampledFiles.find(f => f.path.endsWith('RuleEngineService.java'))?.excerpt ?? ''
  return {
    files,
    sampledFiles,
    languages,
    keyFiles,
    hasBetweenEnum: /\bbetween\b/.test(operator),
    hasBetweenSwitch: /case\s+between\s*:/.test(service),
    hasLengthCase: /case\s+length\s*:/.test(service),
    hasLengthEnum: /\blength\b/.test(operator),
  }
}

function buildAgentQuestions(session: ArtifactSession, ctx: SnapshotContext) {
  return [
    '# Agent Questions',
    '',
    `Goal: ${session.goal}`,
    '',
    '## Architect questions',
    '',
    '- Should `between` be inclusive on both ends (`min <= value <= max`)? The existing service implementation appears inclusive.',
    '- Should `between` support only numbers, or also dates/instants and comparable strings?',
    '- What should happen when the lower bound is greater than the upper bound: reject the rule or return false?',
    '- Should missing/null field values return false or raise a validation error?',
    '',
    '## Developer questions',
    '',
    `- The scan ${ctx.hasBetweenEnum ? 'found' : 'did not find'} ` + '`between` in `Operator.java`.',
    `- The scan ${ctx.hasBetweenSwitch ? 'found' : 'did not find'} a ` + '`case between` branch in `RuleEngineService.java`.',
    '- Should the change mainly add tests/docs, or should the implementation be refactored for stronger validation?',
    ctx.hasLengthCase && !ctx.hasLengthEnum
      ? '- There is a compile-risk signal: `RuleEngineService` references `case length`, but `Operator.java` does not appear to declare `length`.'
      : '- No compile-risk signal was detected from the sampled enum/switch relationship.',
    '',
    '## QA questions',
    '',
    '- Which boundary cases are mandatory: exactly min, exactly max, below min, above max, null, missing field, bad value shape?',
    '- Do API/controller tests need to cover `between`, or is service-level coverage enough for this increment?',
    '- Should invalid `value` arrays produce a 400 response through `GlobalExceptionHandler`?',
  ].join('\n')
}

function buildDecisionTreePayload(session: ArtifactSession, ctx: SnapshotContext) {
  return {
    title: 'Between operator decision tree',
    goal: session.goal,
    nodes: [
      {
        id: 'Q-ARCH-001',
        lane: 'Architect',
        question: 'Should `between` be inclusive on both ends?',
        recommended: 'Yes. Use `min <= fieldValue <= max`.',
        evidence: ctx.hasBetweenSwitch
          ? 'The scanned evaluator already compares with >= lower bound and <= upper bound.'
          : 'Existing comparison operators include lt/lte/gt/gte; inclusive range matches common rule-engine expectations.',
        options: [
          { label: 'Inclusive bounds', status: 'recommended', impact: 'Matches common business rules and boundary QA cases.' },
          { label: 'Exclusive bounds', status: 'not recommended', impact: 'Requires new semantics and additional operator naming such as betweenExclusive.' },
        ],
        downstream: ['DEV-001 verify evaluator branch', 'QA-001 boundary tests'],
      },
      {
        id: 'Q-ARCH-002',
        lane: 'Architect',
        question: 'Which value types should `between` support?',
        recommended: 'Use the existing `compare(...)` behavior for numbers/dates/strings; document exact supported coercions.',
        evidence: 'RuleEngineService already centralizes comparisons through `compare(...)` for lt/lte/gt/gte.',
        options: [
          { label: 'Reuse compare(...)', status: 'recommended', impact: 'Smallest implementation, consistent with existing operators.' },
          { label: 'Numbers only', status: 'safe but narrow', impact: 'Simpler validation but weaker platform capability.' },
          { label: 'Custom range comparator', status: 'defer', impact: 'More control, more test burden.' },
        ],
        downstream: ['DEV-001 contract verification', 'QA-002 malformed value tests'],
      },
      {
        id: 'Q-DEV-001',
        lane: 'Developer',
        question: 'Is implementation required or is this mostly certification?',
        recommended: ctx.hasBetweenEnum && ctx.hasBetweenSwitch
          ? 'Treat as certification/hardening: add tests, docs, and validation review.'
          : 'Add enum support and evaluator implementation before tests.',
        evidence: `Scan result: enum=${ctx.hasBetweenEnum ? 'found' : 'missing'}, evaluator=${ctx.hasBetweenSwitch ? 'found' : 'missing'}.`,
        options: [
          { label: 'Harden existing implementation', status: ctx.hasBetweenEnum && ctx.hasBetweenSwitch ? 'recommended' : 'blocked', impact: 'Fast path when code already exists.' },
          { label: 'Implement from scratch', status: ctx.hasBetweenEnum && ctx.hasBetweenSwitch ? 'avoid duplicate' : 'recommended', impact: 'Needed only when enum/evaluator branch is absent.' },
        ],
        downstream: ['DEV-002 service tests', 'DEV-003 API example'],
      },
      {
        id: 'Q-DEV-002',
        lane: 'Developer',
        question: 'Should compile-risk be fixed in this change?',
        recommended: ctx.hasLengthCase && !ctx.hasLengthEnum
          ? 'Yes. Resolve the `length` enum/switch mismatch before certifying the feature.'
          : 'No extra compile-risk fix detected from sampled files.',
        evidence: ctx.hasLengthCase && !ctx.hasLengthEnum
          ? '`RuleEngineService` references `case length`, but `Operator.java` did not declare `length` in the scanned excerpt.'
          : 'No enum/switch mismatch detected.',
        options: [
          { label: 'Fix now', status: ctx.hasLengthCase && !ctx.hasLengthEnum ? 'recommended' : 'optional', impact: 'Prevents build failure from blocking between-operator QA.' },
          { label: 'Separate task', status: 'risk accepted', impact: 'Keeps scope tight but may fail `mvn test`.' },
        ],
        downstream: ['VR-004 mvn test', 'Certification receipt'],
      },
      {
        id: 'Q-QA-001',
        lane: 'QA',
        question: 'Which tests prove the operator?',
        recommended: 'Use boundary, malformed input, null/missing field, and controller-path tests.',
        evidence: 'Snapshot includes service tests and controller tests, so both layers can be covered.',
        options: [
          { label: 'Service + API tests', status: 'recommended', impact: 'Best confidence for developer-facing certification.' },
          { label: 'Service only', status: 'minimum', impact: 'Faster but misses API error mapping.' },
        ],
        downstream: ['QA-001', 'QA-002', 'QA-003', 'VR-002', 'VR-003'],
      },
    ],
  }
}

function buildDecisionTreeMarkdown(session: ArtifactSession, ctx: SnapshotContext) {
  const tree = buildDecisionTreePayload(session, ctx)
  return [
    '# Question Tree',
    '',
    `Goal: ${session.goal}`,
    '',
    ...tree.nodes.flatMap(node => [
      `## ${node.id}: ${node.question}`,
      '',
      `Lane: ${node.lane}`,
      '',
      `Recommended: ${node.recommended}`,
      '',
      `Evidence: ${node.evidence}`,
      '',
      'Options:',
      ...node.options.map(option => `- ${option.label} (${option.status}): ${option.impact}`),
      '',
      `Downstream: ${node.downstream.join(', ')}`,
      '',
    ]),
  ].join('\n')
}

function buildMentalModel(session: ArtifactSession, ctx: SnapshotContext) {
  return [
    '# Mental Model',
    '',
    `The requested feature is a rule-engine operator change: ${session.goal}`,
    '',
    'The scanned project is a Java/Spring rule engine. A request reaches the API controller, is mapped into DTOs, and delegates rule evaluation to `RuleEngineService`. Operators are represented by the `Operator` enum and evaluated in a switch inside `RuleEngineService`.',
    '',
    '## Codebase signals',
    '',
    `- Snapshot files: ${ctx.files.length}`,
    `- Languages: ${Object.entries(ctx.languages).map(([k, v]) => `${k} ${v}`).join(', ') || 'not available'}`,
    `- Key files: ${ctx.keyFiles.map(f => `\`${f}\``).join(', ')}`,
    `- \`between\` in enum: ${ctx.hasBetweenEnum ? 'yes' : 'no'}`,
    `- \`between\` in evaluator switch: ${ctx.hasBetweenSwitch ? 'yes' : 'no'}`,
    '',
    '## Working theory',
    '',
    ctx.hasBetweenEnum && ctx.hasBetweenSwitch
      ? '`between` looks partially or fully implemented already. The useful next step is to verify behavior, strengthen validation, and add tests/documentation so the feature is certified.'
      : '`between` needs to be added to the operator contract and evaluator dispatch, then covered through service and API tests.',
  ].join('\n')
}

function buildGaps(_session: ArtifactSession, ctx: SnapshotContext) {
  return [
    '# Gaps and Open Questions',
    '',
    '## Confirmed gaps from scan',
    '',
    ctx.hasBetweenEnum && ctx.hasBetweenSwitch
      ? '- Implementation signal exists for `between`, but certification evidence is missing in the generated workbench artifacts.'
      : '- `between` implementation is not fully visible in the scanned enum/evaluator files.',
    '- Need explicit tests for inclusive lower/upper boundaries.',
    '- Need tests for invalid `value` payloads: non-array, one-element array, three-element array, non-comparable values.',
    '- Need API-level examples or README update showing the JSON rule shape.',
    ctx.hasLengthCase && !ctx.hasLengthEnum
      ? '- Compile-risk: `case length` appears in `RuleEngineService`, but `length` was not detected in `Operator.java`.'
      : '- No enum/switch compile-risk was detected for sampled files.',
    '',
    '## Product decisions needed',
    '',
    '- Numeric/date/string support policy.',
    '- Inclusive vs exclusive bounds.',
    '- Validation behavior for reversed bounds.',
    '- Error response shape for malformed rules.',
  ].join('\n')
}

function buildSolutionArchitecture(session: ArtifactSession, ctx: SnapshotContext) {
  return [
    '# Solution Architecture',
    '',
    `Feature: ${session.goal}`,
    '',
    '## Recommended implementation',
    '',
    '1. Treat `between` as an inclusive range operator: `min <= fieldValue <= max`.',
    '2. Keep `Operator` as the source of truth for valid operator names.',
    '3. Keep evaluation inside `RuleEngineService.evalCondition` to match the existing operator architecture.',
    '4. Validate `value` is exactly a two-item array before comparing.',
    '5. Use the existing `compare(...)` path so number/date/string comparison behavior stays consistent with `lt/lte/gt/gte`.',
    '6. Add focused service tests and one API test to prove request-level behavior.',
    '',
    '## Impacted files',
    '',
    ...ctx.keyFiles.map(f => `- \`${f}\``),
    '',
    '## Current scan assessment',
    '',
    ctx.hasBetweenEnum && ctx.hasBetweenSwitch
      ? 'The code already shows `between` in the enum and evaluator branch. The architecture task should therefore certify, test, and harden the existing implementation rather than blindly adding duplicate logic.'
      : 'The code needs enum and evaluator additions before tests can pass.',
  ].join('\n')
}

function buildApprovedSpec(session: ArtifactSession, ctx: SnapshotContext, response: string) {
  return [
    '# approved-spec.md',
    '',
    '## Problem Statement',
    '',
    session.goal,
    '',
    '## Functional Requirements',
    '',
    '- REQ-001: The rule engine must accept `op: "between"` in rule JSON.',
    '- REQ-002: `between` must require `value` to be an array with exactly `[min, max]`.',
    '- REQ-003: Evaluation must return true when the field value is greater than or equal to min and less than or equal to max.',
    '- REQ-004: Evaluation must return false for null or missing field values unless existing comparison policy says otherwise.',
    '- REQ-005: Malformed `between` rules must produce a clear validation error.',
    '',
    '## Non-goals',
    '',
    '- Do not introduce a new rule DSL.',
    '- Do not change existing comparison semantics except where needed for `between` validation.',
    '- Do not mutate files outside the governed MCP work branch created for this WorkItem/run.',
    '',
    '## Acceptance Criteria',
    '',
    '- Service tests cover below min, exactly min, inside range, exactly max, and above max.',
    '- Tests cover malformed `value` payloads.',
    '- API test demonstrates a valid `between` rule through the controller.',
    ctx.hasLengthCase && !ctx.hasLengthEnum ? '- Resolve the `length` enum/switch mismatch before certification.' : '- Existing enum/switch shape remains consistent.',
    response,
  ].join('\n')
}

function buildDeveloperTaskPack(session: ArtifactSession, ctx: SnapshotContext, response: string) {
  return [
    '# developer-task-pack.yaml',
    '',
    'developer_tasks:',
    '  - id: DEV-001',
    '    title: Verify between operator contract',
    '    linked_requirements: [REQ-001, REQ-002]',
    '    expected_files:',
    '      - src/main/java/org/example/rules/Operator.java',
    '      - src/main/java/org/example/rules/RuleEngineService.java',
    `    notes: "${ctx.hasBetweenEnum && ctx.hasBetweenSwitch ? 'Implementation signal already exists; inspect and harden.' : 'Add enum value and evaluator branch.'}"`,
    '  - id: DEV-002',
    '    title: Add service-level coverage for between',
    '    linked_requirements: [REQ-003, REQ-004, REQ-005]',
    '    expected_files:',
    '      - src/test/java/org/example/rules/RuleEngineServiceTest.java',
    '  - id: DEV-003',
    '    title: Add API-level example/coverage',
    '    linked_requirements: [REQ-001, REQ-005]',
    '    expected_files:',
    '      - src/test/java/org/example/api/RuleEngineControllerTest.java',
    '      - README.md',
    '',
    `# Goal: ${session.goal}`,
    response,
  ].join('\n')
}

type CodeChangeEvidence = {
  markdown: string
  paths: string[]
  diff: string
  linesAdded: number
  linesRemoved: number
  actual?: boolean
  codeChangeIds?: string[]
  workspaceBranch?: string
  workspaceCommitSha?: string
  workspaceRoot?: string
  astIndexStatus?: string
}

function isCodeChangeArtifactKind(kind: string) {
  return ['actual_code_change', 'code_change_evidence', 'simulated_code_change', 'simulated_code-change'].includes(kind)
}

function buildActualCodeChangeEvidence(
  session: ArtifactSession,
  ctx: SnapshotContext,
  result: ExecuteResponse,
  // (2026-05-29) Last-resort branch/root when the governed loop didn't
  // surface them. The committed branch is deterministic (wi/<code> or the
  // workbench branch name) and the workspace root is known by convention,
  // so we can backfill rather than emit empty evidence that dead-ends
  // GitPushExecutor at NO_COMMIT_TO_PUSH.
  fallback?: { workspaceBranch?: string; workspaceRoot?: string },
): Required<CodeChangeEvidence> {
  const codeChangeIds = (result.correlation?.codeChangeIds ?? []).filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
  const changedPaths = uniqueStrings([
    ...(result.workspace?.changedPaths ?? []),
    ...(result.correlation?.changedPaths ?? []),
  ].filter((path): path is string => typeof path === 'string' && path.trim().length > 0))
  const workspaceBranch = result.workspace?.workspaceBranch ?? result.correlation?.workspaceBranch ?? fallback?.workspaceBranch ?? ''
  const workspaceCommitSha = result.workspace?.workspaceCommitSha ?? result.correlation?.workspaceCommitSha ?? ''
  const workspaceRoot = result.workspace?.workspaceRoot ?? result.correlation?.workspaceRoot ?? fallback?.workspaceRoot ?? ''
  const astIndexStatus = result.workspace?.astIndexStatus ?? result.correlation?.astIndexStatus ?? ''
  const actual = codeChangeIds.length > 0
  const fallbackPaths = changedPaths.length ? changedPaths : inferChangePaths(ctx, session.goal)
  const markdown = actual
    ? [
      '# actual-code-change-evidence.md',
      '',
      '## Captured MCP/git change',
      '',
      '- repository_mutated: true',
      `- source: ${session.sourceType.toLowerCase()} ${session.sourceUri}`,
      session.sourceRef ? `- source_ref: ${session.sourceRef}` : undefined,
      workspaceBranch ? `- workspace_branch: ${workspaceBranch}` : undefined,
      workspaceCommitSha ? `- commit_sha: ${workspaceCommitSha}` : undefined,
      workspaceRoot ? `- workspace_root: ${workspaceRoot}` : undefined,
      astIndexStatus ? `- ast_index_status: ${astIndexStatus}` : undefined,
      '',
      '## Code-change receipts',
      ...codeChangeIds.map(id => `- ${id}`),
      '',
      '## Changed paths',
      ...(changedPaths.length ? changedPaths : ['No path list was returned; open the MCP code-change receipts for the diff body.']).map(path => `- ${path}`),
      '',
      '## Review note',
      '',
      'The diff body is sourced from the MCP code-change receipts, not from a synthesized Workbench preview.',
    ].filter(Boolean).join('\n')
    : [
      '# actual-code-change-evidence.md',
      '',
      '## No actual MCP/git change captured',
      '',
      '- repository_mutated: false',
      `- source: ${session.sourceType.toLowerCase()} ${session.sourceUri}`,
      session.sourceRef ? `- source_ref: ${session.sourceRef}` : undefined,
      '',
      'The Developer stage did not return a code-change receipt from MCP. Re-run Develop with a writable MCP workspace and a tool-capable model alias before approving this stage.',
      '',
      '## Candidate paths from source context',
      ...fallbackPaths.map(path => `- ${path}`),
    ].filter(Boolean).join('\n')
  return {
    markdown,
    paths: fallbackPaths,
    diff: '',
    linesAdded: 0,
    linesRemoved: 0,
    actual,
    codeChangeIds,
    workspaceBranch,
    workspaceCommitSha,
    workspaceRoot,
    astIndexStatus,
  }
}

function buildCodeChangeEvidence(session: ArtifactSession, ctx: SnapshotContext, response = ''): CodeChangeEvidence {
  const proposed = synthesizeCodeDiff(session, ctx, response)
  const markdown = [
    '# code-change-evidence.yaml',
    '',
    'simulated_change_set:',
    '  mode: proposed_patch_preview',
    '  repository_mutated: false',
    '  expected_paths:',
    ...(proposed.paths.length ? proposed.paths : ctx.keyFiles).map(f => `    - ${f}`),
    '  summary:',
    `    - ${proposed.summary}`,
    '    - Review the proposed diff before marking the Developer stage complete.',
    '',
    'diff: |',
    ...proposed.diff.split('\n').map(line => `  ${line}`),
  ].join('\n')
  return {
    markdown,
    paths: proposed.paths,
    diff: proposed.diff,
    linesAdded: proposed.linesAdded,
    linesRemoved: proposed.linesRemoved,
  }
}

function synthesizeCodeDiff(session: ArtifactSession, ctx: SnapshotContext, response: string) {
  const explicit = extractDiffBlock(response)
  if (explicit) {
    const paths = pathsFromUnifiedDiff(explicit)
    return {
      paths: paths.length ? paths : ['developer-output.patch'],
      diff: explicit,
      linesAdded: countDiffLines(explicit, '+'),
      linesRemoved: countDiffLines(explicit, '-'),
      summary: 'Developer output included a patch-style diff.',
    }
  }

  const color = requestedColor(session.goal)
  if (color) {
    const sampled = preferredChangeFiles(ctx)
    const sections = sampled.flatMap(file => synthesizeFilePatch(file.path, file.excerpt, color))
    if (sections.length > 0) {
      const diff = sections.join('\n')
      return {
        paths: uniqueStrings(sections.map(section => pathFromPatchSection(section))),
        diff,
        linesAdded: countDiffLines(diff, '+'),
        linesRemoved: countDiffLines(diff, '-'),
        summary: `Proposed UI color update to ${color} from actual source snapshot excerpts.`,
      }
    }
  }

  const paths = inferChangePaths(ctx, session.goal)
  const diff = [
    '# No patch-style diff was returned by the execution layer.',
    '# Workbench will show this as evidence-only instead of inventing source edits.',
    ...paths.map(path => `# Candidate path: ${path}`),
  ].join('\n')
  return {
    paths,
    diff,
    linesAdded: 0,
    linesRemoved: 0,
    summary: 'No patch-style diff was returned; review the developer artifact and snapshot evidence before approval.',
  }
}

function extractDiffBlock(response: string) {
  const fenced = response.match(/```(?:diff|patch)\s*([\s\S]*?)```/i)?.[1]?.trim()
  if (fenced && (fenced.includes('diff --git') || fenced.includes('--- ') || fenced.includes('@@'))) return fenced
  const start = response.indexOf('diff --git ')
  if (start >= 0) return response.slice(start).trim()
  return undefined
}

function pathsFromUnifiedDiff(diff: string) {
  return uniqueStrings(Array.from(diff.matchAll(/\+\+\+\s+b\/([^\n]+)/g)).map(match => match[1]?.trim()).filter(Boolean))
}

function requestedColor(goal: string) {
  const known = ['red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'black', 'white', 'gray', 'grey', 'teal', 'cyan', 'indigo']
  const lower = goal.toLowerCase()
  const direct = lower.match(/\b(?:color|colour|theme|background|bg|text)\s+(?:to|as|into)\s+([a-z]+|#[0-9a-f]{3,8})\b/i)?.[1]
  if (direct) return direct === 'grey' ? 'gray' : direct
  return known.find(color => lower.includes(color))?.replace('grey', 'gray')
}

function preferredChangeFiles(ctx: SnapshotContext) {
  const sampled = [...ctx.sampledFiles]
  const css = sampled.filter(file => /\.(css|scss|sass|less)$/i.test(file.path))
  const ui = sampled.filter(file => isLikelyEditableUiFile(file.path))
  const withColorSignals = sampled.filter(file => /(className|style=|color:|background|bg-|text-|border-|#[0-9a-f]{3,8}|rgb\()/i.test(file.excerpt))
  return uniqueByPath([...css, ...withColorSignals, ...ui]).slice(0, 3)
}

function uniqueByPath(files: Array<{ path: string; excerpt: string }>) {
  const seen = new Set<string>()
  return files.filter(file => {
    if (seen.has(file.path)) return false
    seen.add(file.path)
    return true
  })
}

function isLikelyEditableUiFile(path: string) {
  return /\.(tsx|jsx|ts|js|html|css|scss|sass|less)$/i.test(path) &&
    !/(node_modules|dist|build|coverage|\.min\.)/i.test(path)
}

function inferChangePaths(ctx: SnapshotContext, goal: string) {
  const lower = goal.toLowerCase()
  const javaProject = (ctx.languages.Java ?? ctx.languages.java ?? 0) > 0 || ctx.files.some(file => file.path.endsWith('.java'))
  if (javaProject) {
    const goalTerms = lower.split(/[^a-z0-9]+/).filter(term => term.length >= 4)
    const scored = ctx.files
      .filter(file => file.path.endsWith('.java'))
      .map(file => {
        const path = file.path.toLowerCase()
        const score = goalTerms.reduce((acc, term) => acc + (path.includes(term) ? 2 : 0), 0)
          + (/operator|rule|engine|service|controller|test/.test(path) ? 1 : 0)
        return { path: file.path, score }
      })
      .sort((a, b) => b.score - a.score)
      .map(item => item.path)
    return uniqueStrings([...ctx.keyFiles, ...scored]).slice(0, 6)
  }
  return uniqueStrings([...ctx.keyFiles, ...ctx.files.map(file => file.path).filter(path => isLikelyEditableUiFile(path))]).slice(0, 6)
}

function synthesizeFilePatch(path: string, excerpt: string, color: string) {
  const lines = excerpt.split('\n')
  const patches: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index]
    const next = recolorLine(current, color)
    if (next === current) continue
    const start = Math.max(0, index - 2)
    const end = Math.min(lines.length, index + 3)
    const hunk = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -${start + 1},${end - start} +${start + 1},${end - start} @@`,
      ...lines.slice(start, index).map(line => ` ${line}`),
      `-${current}`,
      `+${next}`,
      ...lines.slice(index + 1, end).map(line => ` ${line}`),
    ].join('\n')
    patches.push(hunk)
    break
  }
  return patches
}

function recolorLine(line: string, color: string) {
  let next = line
  const hasStyleSignal = /(color|background|border|accent|fill|stroke|className|class=|bg-|text-|border-)/i.test(line)
  if (!hasStyleSignal) return line
  next = next.replace(/\b(bg|text|border|from|to|via|ring|outline)-(red|blue|green|yellow|orange|purple|pink|gray|grey|slate|zinc|neutral|stone|teal|cyan|indigo)-(\d{2,3})\b/g, (_match, prefix) => `${prefix}-${color}-600`)
  next = next.replace(/#[0-9a-f]{3,8}\b/gi, color)
  next = next.replace(/\brgba?\([^)]+\)/gi, color)
  next = next.replace(/(\b(?:color|background(?:-color)?|border-color|accent-color|fill|stroke)\s*:\s*)([^;"}]+)/gi, `$1${color}`)
  return next
}

function pathFromPatchSection(section: string) {
  return section.match(/\+\+\+\s+b\/([^\n]+)/)?.[1]?.trim()
}

function countDiffLines(diff: string, prefix: '+' | '-') {
  return diff.split('\n').filter(line => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)).length
}

function buildQaTaskPack(session: ArtifactSession, _ctx: SnapshotContext, response: string) {
  return [
    '# qa-task-pack.yaml',
    '',
    'qa_tasks:',
    '  - id: QA-001',
    '    title: Boundary coverage',
    '    scenarios:',
    '      - value below min returns false',
    '      - value equal to min returns true',
    '      - value inside range returns true',
    '      - value equal to max returns true',
    '      - value above max returns false',
    '  - id: QA-002',
    '    title: Malformed rule coverage',
    '    scenarios:',
    '      - missing value',
    '      - non-array value',
    '      - array with fewer or more than two values',
    '      - non-comparable bounds',
    '  - id: QA-003',
    '    title: API behavior',
    '    scenarios:',
    '      - valid between rule through controller',
    '      - invalid between rule maps to expected error response',
    '',
    `# Goal: ${session.goal}`,
    response,
  ].join('\n')
}

function buildImplementationContractPayload(session: ArtifactSession, ctx: SnapshotContext, decisionAnswers: DecisionAnswer[] = []) {
  const compileRisk = ctx.hasLengthCase && !ctx.hasLengthEnum
  const inclusiveDecision = answerText(decisionAnswers, 'Q-ARCH-001', 'Inclusive `min <= fieldValue <= max` semantics.')
  const valueTypeDecision = answerText(decisionAnswers, 'Q-ARCH-002', 'Reuse existing `compare(...)` behavior for comparable values.')
  const implementationDecision = answerText(decisionAnswers, 'Q-DEV-001', ctx.hasBetweenEnum && ctx.hasBetweenSwitch
    ? 'Harden existing implementation rather than duplicating logic.'
    : 'Add the missing enum/evaluator implementation.')
  const compileRiskDecision = answerText(decisionAnswers, 'Q-DEV-002', compileRisk
    ? 'Fix the detected compile risk in this implementation increment.'
    : 'No compile-risk fix is required from the sampled files.')
  const qaDecision = answerText(decisionAnswers, 'Q-QA-001', 'Use service and API tests for certification.')
  return {
    title: 'Final implementation contract',
    status: 'READY_FOR_IMPLEMENTATION_REVIEW',
    goal: session.goal,
    capturedDecisions: decisionAnswers.map(answer => ({
      questionId: answer.questionId,
      answer: decisionAnswerText(answer),
      notes: answer.notes,
      updatedAt: answer.updatedAt,
    })),
    stakeholderInputs: [
      {
        role: 'Architect',
        contribution: `Defines operator semantics and boundaries. Decision: ${inclusiveDecision} Value policy: ${valueTypeDecision}`,
        outputs: ['REQ-001..REQ-005', 'architecture decisions', 'gaps'],
      },
      {
        role: 'Developer',
        contribution: `Owns implementation and hardening. Decision: ${implementationDecision} Compile policy: ${compileRiskDecision}`,
        outputs: ['DEV-001', 'DEV-002', 'DEV-003', 'simulated change evidence'],
      },
      {
        role: 'QA',
        contribution: `Turns the requirement set into executable verification. Decision: ${qaDecision}`,
        outputs: ['QA-001', 'QA-002', 'QA-003', 'VR-001..VR-004'],
      },
    ],
    implementationUnits: [
      {
        id: 'IMP-001',
        title: 'Operator contract',
        owner: 'Developer',
        files: ['src/main/java/org/example/rules/Operator.java'],
        instructions: ctx.hasBetweenEnum
          ? 'Confirm `between` remains in the enum and is documented as a supported operator.'
          : 'Add `between` to the operator enum and make it available to request validation.',
        acceptance: ['REQ-001', 'VR-001'],
      },
      {
        id: 'IMP-002',
        title: 'Evaluator behavior',
        owner: 'Developer',
        files: ['src/main/java/org/example/rules/RuleEngineService.java'],
        instructions: ctx.hasBetweenSwitch
          ? `Verify the evaluator follows the chosen range rule: ${inclusiveDecision}`
          : `Add a \`between\` evaluator branch following the chosen range rule: ${inclusiveDecision}`,
        acceptance: ['REQ-002', 'REQ-003', 'VR-002'],
      },
      {
        id: 'IMP-003',
        title: 'Validation and error behavior',
        owner: 'Architect + Developer',
        files: ['src/main/java/org/example/api/GlobalExceptionHandler.java', 'src/main/java/org/example/api/dto/EvaluateRequest.java'],
        instructions: `Make malformed \`between\` payloads predictable. Value type policy: ${valueTypeDecision}`,
        acceptance: ['REQ-005', 'VR-003'],
      },
      {
        id: 'IMP-004',
        title: 'Proof and certification',
        owner: 'QA',
        files: ['src/test/java/org/example/rules/RuleEngineServiceTest.java', 'src/test/java/org/example/api/RuleEngineControllerTest.java', 'README.md'],
        instructions: `Add proof for the chosen QA policy: ${qaDecision}`,
        acceptance: ['QA-001', 'QA-002', 'QA-003', 'VR-004'],
      },
    ],
    finalChecklist: [
      `Range behavior decision: ${inclusiveDecision}`,
      `Value policy decision: ${valueTypeDecision}`,
      `Implementation decision: ${implementationDecision}`,
      `Compile-risk decision: ${compileRiskDecision}`,
      'Run the project test command and attach logs to the workflow handoff.',
    ],
    handoffArtifacts: [
      'Question tree',
      'Approved spec draft',
      'Developer task pack',
      'QA task pack',
      'Verification rules',
      'Traceability matrix',
      'Certification receipt',
    ],
  }
}

function buildImplementationContractMarkdown(session: ArtifactSession, ctx: SnapshotContext, decisionAnswers: DecisionAnswer[] = []) {
  const contract = buildImplementationContractPayload(session, ctx, decisionAnswers)
  return [
    '# implementation-contract.yaml',
    '',
    `goal: ${session.goal}`,
    `status: ${contract.status}`,
    '',
    'captured_decisions:',
    ...(contract.capturedDecisions.length > 0
      ? contract.capturedDecisions.map(answer => `  - ${answer.questionId}: "${answer.answer ?? answer.notes ?? 'answered'}"`)
      : ['  - none_captured_yet']),
    '',
    'stakeholder_inputs:',
    ...contract.stakeholderInputs.flatMap(input => [
      `  - role: ${input.role}`,
      `    contribution: "${input.contribution}"`,
      `    outputs: [${input.outputs.join(', ')}]`,
    ]),
    '',
    'implementation_units:',
    ...contract.implementationUnits.flatMap(unit => [
      `  - id: ${unit.id}`,
      `    title: ${unit.title}`,
      `    owner: ${unit.owner}`,
      `    files: [${unit.files.join(', ')}]`,
      `    instructions: "${unit.instructions}"`,
      `    acceptance: [${unit.acceptance.join(', ')}]`,
    ]),
    '',
    'final_checklist:',
    ...contract.finalChecklist.map(item => `  - ${item}`),
    '',
    'handoff_artifacts:',
    ...contract.handoffArtifacts.map(item => `  - ${item}`),
  ].join('\n')
}

function buildStakeholderAnswersMarkdown(answers: DecisionAnswer[]) {
  return [
    '# stakeholder-answers.yaml',
    '',
    'answers:',
    ...(answers.length > 0 ? answers.flatMap(answer => [
      `  - question_id: ${answer.questionId}`,
      answer.questionText ? `    question: "${answer.questionText.replaceAll('"', '\\"')}"` : undefined,
      answer.normalizedQuestion ? `    normalized_question: "${answer.normalizedQuestion}"` : undefined,
      `    answer_type: ${answer.answerType}`,
      answer.selectedOptionLabel ? `    selected_option: "${answer.selectedOptionLabel}"` : undefined,
      answer.selectedOptionLabels?.length ? `    selected_options: [${answer.selectedOptionLabels.map(label => `"${label}"`).join(', ')}]` : undefined,
      answer.customAnswer ? `    custom_answer: "${answer.customAnswer}"` : undefined,
      answer.notes ? `    notes: "${answer.notes}"` : undefined,
      answer.updatedAt ? `    updated_at: ${answer.updatedAt}` : undefined,
    ].filter((line): line is string => Boolean(line))) : ['  - none']),
  ].join('\n')
}

function buildVerificationRules(_session: ArtifactSession, ctx: SnapshotContext) {
  return [
    '# verification-rules.yaml',
    '',
    'verification_rules:',
    '  - id: VR-001',
    '    requirement: REQ-001',
    '    check: Operator enum and evaluator accept `between`.',
    `    current_signal: ${ctx.hasBetweenEnum && ctx.hasBetweenSwitch ? 'present' : 'missing_or_partial'}`,
    '  - id: VR-002',
    '    requirement: REQ-003',
    '    check: Inclusive boundary tests pass.',
    '  - id: VR-003',
    '    requirement: REQ-005',
    '    check: Malformed value arrays produce controlled errors.',
    '  - id: VR-004',
    '    requirement: BUILD',
    '    check: `mvn test` passes without enum/switch compile errors.',
  ].join('\n')
}

function buildTraceabilityMatrix() {
  return [
    '# traceability-matrix.yaml',
    '',
    'traceability:',
    '  - requirement: REQ-001',
    '    developer_tasks: [DEV-001]',
    '    qa_tasks: [QA-003]',
    '    verification_rules: [VR-001]',
    '  - requirement: REQ-002',
    '    developer_tasks: [DEV-001]',
    '    qa_tasks: [QA-002]',
    '    verification_rules: [VR-003]',
    '  - requirement: REQ-003',
    '    developer_tasks: [DEV-002]',
    '    qa_tasks: [QA-001]',
    '    verification_rules: [VR-002]',
  ].join('\n')
}

function buildCertificationReceipt(_session: ArtifactSession, ctx: SnapshotContext) {
  return [
    '# certification-receipt.yaml',
    '',
    'certification:',
    `  implementation_signal: ${ctx.hasBetweenEnum && ctx.hasBetweenSwitch ? 'detected' : 'not_detected'}`,
    `  compile_risk: ${ctx.hasLengthCase && !ctx.hasLengthEnum ? 'length_operator_enum_mismatch' : 'none_detected_from_snapshot'}`,
    '  status: READY_FOR_HUMAN_REVIEW',
    '  note: This MVP generated a governed plan and QA pack from read-only source context; it did not mutate code.',
  ].join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isDecisionAnswerRecord(value: unknown): value is DecisionAnswer {
  return readDecisionAnswers([value]).length === 1
}

function isStageAttempt(value: unknown): value is StageAttempt {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.stageKey === 'string'
    && typeof value.stageLabel === 'string'
    && typeof value.agentRole === 'string'
    && typeof value.agentTemplateId === 'string'
    && typeof value.attemptNumber === 'number'
    && typeof value.status === 'string'
    && typeof value.startedAt === 'string'
}

function isReviewEvent(value: unknown): value is ReviewEvent {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.type === 'string'
    && typeof value.message === 'string'
    && typeof value.createdAt === 'string'
}

function isFinalPack(value: unknown): value is FinalPack {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.status === 'string'
    && typeof value.generatedAt === 'string'
    && typeof value.summary === 'string'
    && Array.isArray(value.stages)
    && Array.isArray(value.artifactKinds)
}

function readSessionDecisionAnswers(session: { metadata?: Prisma.JsonValue | null }) {
  return isRecord(session.metadata) ? readDecisionAnswers(session.metadata.decisionAnswers) : []
}

function readDecisionAnswers(value: unknown): DecisionAnswer[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.questionId !== 'string') return []
    const answerType = item.answerType === 'freeform' ? 'freeform' : item.answerType === 'multi_option' ? 'multi_option' : 'option'
    const questionText = typeof item.questionText === 'string' ? item.questionText : undefined
    const normalizedQuestion = typeof item.normalizedQuestion === 'string'
      ? item.normalizedQuestion
      : normalizeQuestionText(questionText)
    const selectedOptionLabel = typeof item.selectedOptionLabel === 'string' ? item.selectedOptionLabel : undefined
    const selectedOptionLabels = Array.isArray(item.selectedOptionLabels)
      ? item.selectedOptionLabels.filter((label): label is string => typeof label === 'string' && Boolean(label.trim()))
      : undefined
    const customAnswer = typeof item.customAnswer === 'string' ? item.customAnswer : undefined
    const notes = typeof item.notes === 'string' ? item.notes : undefined
    const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : undefined
    const updatedById = typeof item.updatedById === 'string' ? item.updatedById : undefined
    if (answerType === 'option' && !selectedOptionLabel) return []
    if (answerType === 'multi_option' && !selectedOptionLabels?.length) return []
    if (answerType === 'freeform' && !customAnswer && !notes) return []
    return [{ questionId: item.questionId, questionText, normalizedQuestion, answerType, selectedOptionLabel, selectedOptionLabels, customAnswer, notes, updatedAt, updatedById }]
  })
}

function answerText(answers: DecisionAnswer[], questionId: string, fallback: string) {
  const answer = answers.find(item => item.questionId === questionId)
  if (!answer) return fallback
  const base = decisionAnswerText(answer)
  return [base, answer.notes].filter(Boolean).join(' | notes: ') || fallback
}

function decisionAnswerText(answer: DecisionAnswer): string | undefined {
  if (answer.answerType === 'option') return answer.selectedOptionLabel
  if (answer.answerType === 'multi_option') return answer.selectedOptionLabels?.join(', ')
  return answer.customAnswer
}

function isUsefulModelResponse(value: string | undefined) {
  return Boolean(value && value.trim() && !value.includes('[mock]'))
}

// M36.2 — architectTask / developerTask / qaTask / stageSystemPrompt deleted.
// Stage prompts now live in prompt-composer's StagePromptBinding rows
// (seeded by agent-and-tools/apps/prompt-composer/prisma/seed.ts) and are
// resolved at runtime via promptComposerClient.resolveStage({stageKey, vars}).
// To change prompt text: edit seed.ts, re-seed singularity_composer DB.
// To change the (stage → profile) mapping: edit a StagePromptBinding row
// directly (or via the future admin UI) — no workgraph-api redeploy.

function humanStage(stage: BlueprintStage) {
  return stage === BlueprintStage.ARCHITECT ? 'Architect'
    : stage === BlueprintStage.DEVELOPER ? 'Developer'
    : 'QA'
}

function jsonStrings(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

async function snapshotLocalDir(root: string, includeGlobs: string[], excludeGlobs: string[]): Promise<SnapshotResult> {
  const absoluteRoot = path.resolve(root)
  const st = await fs.stat(absoluteRoot)
  if (!st.isDirectory()) throw new ValidationError('Local source must be a directory')

  const manifest: ManifestEntry[] = []
  let totalBytes = 0
  let excerptCount = 0

  async function walk(dir: string): Promise<void> {
    if (manifest.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) return
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (manifest.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) return
      const full = path.join(dir, entry.name)
      const rel = path.relative(absoluteRoot, full).split(path.sep).join('/')
      if (isExcluded(rel, excludeGlobs)) continue
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile() || !isIncluded(rel, includeGlobs)) continue
      const stat = await fs.stat(full)
      if (stat.size > MAX_EXCERPT_BYTES * 10) continue
      const file: ManifestEntry = { path: rel, size: stat.size, language: languageFor(rel) }
      totalBytes += stat.size
      if ((excerptCount < MAX_EXCERPT_FILES || isRepoInstructionPath(rel)) && isTextPath(rel) && totalBytes < MAX_TOTAL_BYTES) {
        const buf = await fs.readFile(full)
        const excerpt = buf.toString('utf8', 0, Math.min(buf.length, MAX_EXCERPT_BYTES))
        file.excerpt = excerpt
        file.sha = sha256(excerpt)
        if (!isRepoInstructionPath(rel)) excerptCount += 1
      }
      manifest.push(file)
    }
  }

  await walk(absoluteRoot)
  return summarizeSnapshot({ source: 'localdir', root: absoluteRoot }, manifest, totalBytes)
}

// M73-followup — GitHub fetch helper used by the snapshot path.
//
// Three things this gives us that bare fetch() didn't:
//   1. Authorization — sends `Bearer ${GITHUB_TOKEN}` when the env is
//      set, lifting the rate limit from 60/hr/IP to 5000/hr/token.
//      Without this the snapshot service shares one 60/hr bucket across
//      every Blueprint Workbench user hitting it.
//   2. Single retry on 5xx — GitHub's tree/raw endpoints occasionally
//      return 500/502/503 for entirely transient reasons. Retrying once
//      with 750ms backoff eliminates ~all of them without inflating
//      latency on the happy path.
//   3. Diagnostic error message — includes the X-RateLimit-Remaining
//      and X-GitHub-Request-Id headers so operators don't have to guess
//      whether they hit the cap or GitHub had a hiccup.
function githubAuthHeader(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  return token ? { authorization: `Bearer ${token}` } : {}
}

async function githubFetch(url: string, extraAccept?: string): Promise<Response> {
  const headers: Record<string, string> = {
    accept: extraAccept ?? 'application/vnd.github+json',
    ...githubAuthHeader(),
  }
  let last: Response | null = null
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const resp = await fetch(url, { headers })
      if (resp.ok) return resp
      last = resp
      // Only retry on 5xx — 4xx (404 missing repo, 401 bad token, 403 rate-limit)
      // won't change on a second try.
      if (resp.status < 500) return resp
    } catch (err) {
      // Network throw (undici "fetch failed", DNS, TLS, ECONNRESET).
      // Without this catch the per-file excerpt loop in snapshotGithub
      // crashed the whole snapshot on a single transient blip — fixed
      // 2026-05-24 after a repeatable repro that left the session in
      // FAILED with no actual repo error from GitHub.
      lastError = err
    }
    // Exponential-ish backoff: 750ms, 1500ms. Keeps a flaky raw.githubusercontent
    // request from racing back into the same DNS cache miss.
    if (attempt < 2) await new Promise(r => setTimeout(r, 750 * (attempt + 1)))
  }
  if (last) return last
  // All three attempts were network throws — re-raise the last one so the
  // snapshot route's catch block records a clean "fetch failed" with cause.
  throw lastError
}

function githubErrorDetail(resp: Response): string {
  const rl = resp.headers.get('x-ratelimit-remaining')
  const reqId = resp.headers.get('x-github-request-id')
  const auth = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) ? 'authenticated' : 'unauthenticated'
  const bits = [`status=${resp.status}`, `auth=${auth}`]
  if (rl !== null) bits.push(`rate_remaining=${rl}`)
  if (reqId) bits.push(`req_id=${reqId}`)
  return bits.join(' ')
}

async function snapshotGithub(sourceUri: string, sourceRef: string | undefined, includeGlobs: string[], excludeGlobs: string[]): Promise<SnapshotResult> {
  const parsed = parseGithubUrl(sourceUri)
  const branch = sourceRef || parsed.branch || await githubDefaultBranch(parsed.owner, parsed.repo)
  const treeUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
  const treeResp = await githubFetch(treeUrl)
  if (!treeResp.ok) throw new ValidationError(`GitHub tree scan failed (${githubErrorDetail(treeResp)})`)
  const treeJson = await treeResp.json() as { tree?: Array<{ path: string; type: string; size?: number; sha?: string }> }
  const prefix = parsed.path ? parsed.path.replace(/^\/+|\/+$/g, '') : ''
  const manifest: ManifestEntry[] = []
  let totalBytes = 0
  let excerptCount = 0
  for (const item of treeJson.tree ?? []) {
    if (manifest.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) break
    if (item.type !== 'blob') continue
    const itemPath = item.path
    if (prefix && !itemPath.startsWith(`${prefix}/`) && itemPath !== prefix) continue
    const rel = prefix ? itemPath.slice(prefix.length).replace(/^\/+/, '') : itemPath
    if (!rel || isExcluded(rel, excludeGlobs) || !isIncluded(rel, includeGlobs)) continue
    const size = item.size ?? 0
    if (size > MAX_EXCERPT_BYTES * 10) continue
    const file: ManifestEntry = { path: rel, size, sha: item.sha, language: languageFor(rel) }
    totalBytes += size
    if ((excerptCount < MAX_EXCERPT_FILES || isRepoInstructionPath(rel)) && isTextPath(rel) && size <= MAX_EXCERPT_BYTES) {
      // raw.githubusercontent.com accepts the same Bearer token as the
      // API host; using githubFetch keeps the retry + auth treatment
      // consistent with the tree call above.
      const raw = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${encodeURIComponent(branch)}/${itemPath.split('/').map(encodeURIComponent).join('/')}`
      const rawResp = await githubFetch(raw, '*/*')
      if (rawResp.ok) {
        file.excerpt = (await rawResp.text()).slice(0, MAX_EXCERPT_BYTES)
        if (!isRepoInstructionPath(rel)) excerptCount += 1
      }
    }
    manifest.push(file)
  }
  return summarizeSnapshot({ source: 'github', repo: `${parsed.owner}/${parsed.repo}`, branch, path: prefix }, manifest, totalBytes)
}

function summarizeSnapshot(source: Record<string, unknown>, manifest: ManifestEntry[], totalBytes: number): SnapshotResult {
  const languages: Record<string, number> = {}
  const topLevel: Record<string, number> = {}
  for (const f of manifest) {
    const lang = f.language ?? 'Other'
    languages[lang] = (languages[lang] ?? 0) + 1
    const top = f.path.split('/')[0] || f.path
    topLevel[top] = (topLevel[top] ?? 0) + 1
  }
  const sampledFiles = manifest.filter(f => f.excerpt).map(f => ({ path: f.path, excerpt: f.excerpt }))
  const rootHash = sha256(JSON.stringify(manifest.map(f => [f.path, f.size, f.sha ?? ''])))
  return {
    manifest,
    fileCount: manifest.length,
    totalBytes,
    rootHash,
    summary: {
      ...source,
      generatedAt: new Date().toISOString(),
      limits: { maxFiles: MAX_FILES, maxTotalBytes: MAX_TOTAL_BYTES, maxExcerptBytes: MAX_EXCERPT_BYTES },
      languages,
      topLevel,
      sampledFiles,
    },
  }
}

function parseGithubUrl(sourceUri: string): { owner: string; repo: string; branch?: string; path?: string } {
  const url = new URL(sourceUri)
  if (url.hostname !== 'github.com') throw new ValidationError('GitHub source must be a github.com URL')
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) throw new ValidationError('GitHub URL must include owner and repository')
  const [owner, repoRaw] = parts
  const repo = repoRaw.replace(/\.git$/, '')
  const treeIdx = parts.indexOf('tree')
  if (treeIdx >= 0 && parts.length > treeIdx + 1) {
    return { owner, repo, branch: parts[treeIdx + 1], path: parts.slice(treeIdx + 2).join('/') }
  }
  return { owner, repo }
}

async function githubDefaultBranch(owner: string, repo: string): Promise<string> {
  const res = await githubFetch(`https://api.github.com/repos/${owner}/${repo}`)
  if (!res.ok) throw new ValidationError(`GitHub repository lookup failed (${githubErrorDetail(res)})`)
  const body = await res.json() as { default_branch?: string }
  return body.default_branch ?? 'main'
}

function isExcluded(relPath: string, excludeGlobs: string[]) {
  const parts = relPath.split('/')
  if (parts.some(p => DEFAULT_EXCLUDES.has(p))) return true
  return excludeGlobs.some(pattern => matchesGlob(relPath, pattern))
}

function isIncluded(relPath: string, includeGlobs: string[]) {
  if (includeGlobs.length === 0) return true
  return includeGlobs.some(pattern => matchesGlob(relPath, pattern))
}

function matchesGlob(relPath: string, pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*')
  return new RegExp(`^${escaped}$`).test(relPath)
}

function isTextPath(relPath: string) {
  return /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yml|yaml|toml|prisma|py|rb|go|rs|java|kt|cs|php|css|scss|html|sql|sh|env|txt)$/i.test(relPath)
    || /(^|\/)(Dockerfile|Makefile|README|LICENSE)(\..*)?$/i.test(relPath)
}

function languageFor(relPath: string) {
  const ext = path.extname(relPath).toLowerCase()
  const map: Record<string, string> = {
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript React',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript React',
    '.py': 'Python',
    '.go': 'Go',
    '.rs': 'Rust',
    '.java': 'Java',
    '.css': 'CSS',
    '.scss': 'SCSS',
    '.html': 'HTML',
    '.json': 'JSON',
    '.md': 'Markdown',
    '.yaml': 'YAML',
    '.yml': 'YAML',
    '.prisma': 'Prisma',
    '.sql': 'SQL',
  }
  return map[ext] ?? 'Other'
}

function sha256(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex')
}
