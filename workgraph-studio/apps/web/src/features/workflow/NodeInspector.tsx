import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'motion/react'
import {
  X, Save, Loader2, Plus, Trash2, ChevronDown, ChevronRight,
  User, Bot, CheckCircle, GitMerge, Package, Wrench, Shield, GitBranch,
  ArrowDownToLine, ArrowUpFromLine, Hash,
  LayoutGrid, Settings, Cpu,
  Clock, Radio, RadioTower, Workflow, Repeat, Shuffle, Zap, RotateCcw, FileCode, Network,
  Box, Star, Briefcase, Database, Globe, Mail, Phone,
  Calendar, AlertTriangle, Search, Filter, Activity,
  GitFork, ShieldAlert, SlidersHorizontal, Play, Square, Braces,
} from 'lucide-react'
import type { Node } from 'reactflow'
import { fetchAgents, fetchStudioAgents, deriveStudioAgent, fetchTools, fetchCapabilities, registrySource, type RegistryAgent } from '../../lib/registry'
import { useActiveContextStore } from '../../store/activeContext.store'
import { api } from '../../lib/api'
import { UserPicker, TeamPicker, RolePicker, SkillPicker, ConnectorPicker, PickerOrText } from '../../components/lookup/EntityPickers'
import type { FormWidget } from '../forms/widgets/types'
import { WidgetListEditor } from '../forms/widgets/WidgetListEditor'
import { WidgetEditor } from '../forms/widgets/WidgetEditor'
import { RuntimeWidgetForm, type RuntimeFormSubmitTarget } from '../forms/widgets/RuntimeWidgetForm'
import type { UploadedDocument } from '../../lib/uploadAttachment'

const CUSTOM_NODE_ICONS: Record<string, React.ElementType> = {
  Box, Bot, User, CheckCircle, GitMerge, Package, Wrench, Shield, GitBranch,
  Star, Briefcase, Database, Globe, Mail, Phone, Calendar, AlertTriangle, Search, Filter, Activity,
  Clock, Radio, RadioTower, Workflow, Repeat, Shuffle, Zap, RotateCcw,
  GitFork, ShieldAlert, SlidersHorizontal, Network,
}

// ─── Types ────────────────────────────────────────────────────────────────

export type ArtifactDef = {
  id: string
  name: string
  artifactType: string          // e.g. "CampaignBrief", "CustomerSegment"
  direction: 'INPUT' | 'OUTPUT'
  format: 'TEXT' | 'JSON' | 'MARKDOWN' | 'BINARY'
  required: boolean
  description: string
  // Runtime bindings: dot-path into the workflow context.
  // INPUT artifacts read FROM `bindingPath`; OUTPUT artifacts write TO `bindingPath`.
  bindingPath?: string
}

export type KVPair = {
  id: string
  key: string
  value: string
}

export type RetryPolicy = {
  maxAttempts: number
  initialIntervalMs: number
  backoffCoefficient: number
  nonRetryableErrors: string[]
}

export type CompensationConfig = {
  type: 'tool_request' | 'human_task'
  // tool_request fields
  toolId?: string
  actionId?: string
  inputPayload?: string   // JSON string in the editor
  // human_task fields
  assignee?: string
  description?: string
}

export type SinkConfig = {
  kind: 'CONNECTOR' | 'DB_EVENT' | 'ARTIFACT'
  // CONNECTOR
  connectorId?: string
  operation?: string
  paramMap?: Record<string, string>   // paramKey → context path
  // DB_EVENT + ARTIFACT shared
  bodyPath?: string  // context path to extract body / artifact content
  // ARTIFACT only
  artifactType?: string
  namePath?: string  // context path for artifact name
}

type LlmModelChoice = {
  id: string
  label?: string
  provider?: string
  model?: string
  ready?: boolean
  default?: boolean
  supportsTools?: boolean
  costTier?: string
  warnings?: string[]
}

function unwrapModelCatalog(payload: any): { defaultModelAlias?: string; models: LlmModelChoice[] } {
  const data = payload?.data ?? payload
  return {
    defaultModelAlias: typeof data?.defaultModelAlias === 'string' ? data.defaultModelAlias : undefined,
    models: Array.isArray(data?.models) ? data.models : [],
  }
}

type WorkbenchQuestionOption = {
  label: string
  impact?: string
  recommended?: boolean
}

type WorkbenchQuestion = {
  id: string
  question: string
  required: boolean
  freeform: boolean
  options?: WorkbenchQuestionOption[]
}

type WorkbenchExpectedArtifact = {
  kind: string
  title: string
  description?: string
  required: boolean
  format: 'MARKDOWN' | 'TEXT' | 'JSON' | 'CODE'
}

type WorkbenchStage = {
  key: string
  label: string
  agentRole: string
  agentTemplateId?: string
  next?: string | null
  terminal?: boolean
  required: boolean
  approvalRequired?: boolean
  expectedArtifacts?: WorkbenchExpectedArtifact[]
  allowedSendBackTo: string[]
  questions?: WorkbenchQuestion[]
}

type WorkbenchConfig = {
  profile: 'blueprint'
  gateMode: 'manual' | 'auto'
  goal: string
  sourceType: 'github' | 'localdir'
  sourceUri?: string
  sourceRef?: string
  capabilityId: string
  agentBindings: {
    architectAgentTemplateId: string
    developerAgentTemplateId: string
    qaAgentTemplateId: string
  }
  loopDefinition: {
    version: 1
    name: string
    maxLoopsPerStage: number
    maxTotalSendBacks: number
    stages: WorkbenchStage[]
  }
  outputs: {
    finalPackKey: string
  }
}

type WorkItemTargetConfig = {
  id: string
  targetCapabilityId: string
  childWorkflowTemplateId: string
  roleKey: string
}

export type NodeConfig = {
  description: string
  // Standard type-specific fields
  standard: Record<string, string>
  // Design-time key-value pairs
  designKV: KVPair[]
  // Runtime key-value pairs
  runtimeKV: KVPair[]
  // Artifacts
  inputArtifacts: ArtifactDef[]
  outputArtifacts: ArtifactDef[]
  // Retry/error config
  retryPolicy?: RetryPolicy
  // SAGA compensation
  compensationConfig?: CompensationConfig
  // Flat widget-based form definition for HUMAN_TASK / APPROVAL / CONSUMABLE_CREATION
  // (and CUSTOM nodes whose CustomNodeType has supportsForms=true).
  // One widget = one input.  Filled by the assignee at runtime when they
  // mark the work complete.
  formWidgets?: FormWidget[]
  attachments?: Attachment[]
  // Execution location (SERVER | CLIENT | EDGE | EXTERNAL)
  executionLocation?: string
  // DATA_SINK configuration
  sinkConfig?: SinkConfig
  // SET_CONTEXT assignments: key = context path, value = literal or {{path}}
  assignments?: KVPair[]
  // Universal runtime writes into instance context._globals after this node completes.
  globalAssignments?: KVPair[]
  // WORKBENCH_TASK configuration.
  workbench?: WorkbenchConfig
  // WORK_ITEM target child capability rows.
  targets?: WorkItemTargetConfig[]
  // ── Assignment routing (HUMAN_TASK / APPROVAL / CONSUMABLE_CREATION) ──────
  // assignmentMode picks which of the sub-fields is meaningful.  When unset,
  // runtime defaults to DIRECT_USER (legacy behaviour).
  assignmentMode?: 'DIRECT_USER' | 'TEAM_QUEUE' | 'ROLE_BASED' | 'SKILL_BASED' | 'AGENT'
  assignedToId?: string   // DIRECT_USER → IAM user id
  teamId?:       string   // TEAM_QUEUE  → IAM team id
  roleKey?:      string   // ROLE_BASED  → IAM role key (scoped to template's capability)
  skillKey?:     string   // SKILL_BASED → IAM skill key
}

export type NodeData = { label: string; nodeType: string; status: string; config?: NodeConfig }

// ─── Workflow parameters ──────────────────────────────────────────────────────

export type ParamDef = {
  id: string
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'json'
  required: boolean
  defaultValue?: string
  description?: string
  enumValues?: string[]
}

// ─── Branch conditions (stored in edge.condition) ─────────────────────────────

export type ConditionOp =
  | '==' | '!=' | '>' | '>=' | '<' | '<='
  | 'contains' | 'not_contains'
  | 'in' | 'not_in'
  | 'exists' | 'not_exists'
  | 'starts_with' | 'ends_with'

export type BranchCondition = {
  id: string
  left: string      // e.g. "params.tier", "context.score"
  op: ConditionOp
  right: string     // literal value; for 'in'/'not_in': comma-separated
}

export type Branch = {
  label?: string
  logic: 'AND' | 'OR'
  conditions: BranchCondition[]
  // Lower = higher priority. DECISION_GATE evaluates branches in this order
  // and fires the first matching non-default branch.
  priority?: number
  // Marks this branch as the default/else fallback. DECISION_GATE / INCLUSIVE_GATEWAY
  // fall back to this branch only when no other branch matches.
  isDefault?: boolean
}

// Outgoing edge shape passed from parent for the Branches tab
export type OutgoingEdgeBranch = {
  edgeId: string
  label?: string
  edgeType: string
  condition?: Branch | null
  targetNodeId: string
  targetLabel?: string
}

export type CustomNodeTypeDef = {
  id: string
  name: string
  label: string
  description?: string
  color: string
  icon: string
  baseType: string
  fields: Array<{ key: string; label: string; placeholder?: string; multiline?: boolean }>
}

export type Attachment = {
  id: string
  type: 'timer' | 'tool' | 'notification'
  trigger: 'on_activate' | 'on_complete' | 'on_fail' | 'deadline'
  enabled: boolean
  label?: string
  // deadline / timer
  durationMs?: number       // milliseconds
  deadlineEdge?: string     // outgoing edge label to follow on deadline
  // tool
  toolName?: string
  actionName?: string
  inputPayload?: string     // JSON string
  // notification
  channel?: 'email' | 'slack' | 'webhook'
  recipient?: string
  message?: string
}

// ─── Node type map ────────────────────────────────────────────────────────

const NODE_META: Record<string, {
  label: string; color: string; Icon: React.ElementType; description: string
  standardFields: Array<{ key: string; label: string; placeholder: string; multiline?: boolean }>
}> = {
  START: {
    label: 'Start', color: '#00843D', Icon: Play,
    description: 'Entry point of the workflow. Execution begins here when the workflow is started. One Start node is required per workflow.',
    standardFields: [
      { key: 'triggerType',  label: 'Trigger type',      placeholder: 'MANUAL | SCHEDULE | WEBHOOK | API' },
      { key: 'triggerNote',  label: 'Trigger note',       placeholder: 'e.g. Runs every Monday at 09:00', multiline: false },
    ],
  },
  END: {
    label: 'End', color: '#64748b', Icon: Square,
    description: 'Terminal node. All workflow paths should lead to an End node (or another terminal like Data Sink). When reached, the instance is marked completed.',
    standardFields: [
      { key: 'summary',      label: 'Completion summary', placeholder: 'e.g. Customer onboarding complete', multiline: true },
    ],
  },
  HUMAN_TASK: {
    label: 'Human Task', color: '#22c55e', Icon: User,
    description: 'A task that must be completed by a human. Supports assignment, due dates, and approval gates.',
    standardFields: [
      { key: 'role',       label: 'Required role',     placeholder: 'analyst' },
      { key: 'dueInDays',  label: 'Due in (days)',     placeholder: '3' },
      { key: 'priority',   label: 'Priority',          placeholder: 'MEDIUM' },
    ],
  },
  AGENT_TASK: {
    label: 'Agent Task', color: '#38bdf8', Icon: Bot,
    description: 'Delegates work to an AI agent. Output always requires human review before promotion.',
    standardFields: [
      // M10 — capability scopes the agent-template list, the MCP server, and
      // the tool catalog at execute-time. Required.
      { key: 'capabilityId',    label: 'Capability',        placeholder: 'IAM capability uuid' },
      // M10 — agentTemplateId is the agent-and-tools template uuid. The
      // executor snapshots it into a local Agent row at run start.
      { key: 'agentTemplateId', label: 'Agent template',    placeholder: 'agent-template-uuid' },
      { key: 'modelAlias',      label: 'Model',             placeholder: 'Use workflow default' },
      { key: 'governanceMode',  label: 'Governance mode',   placeholder: 'fail_open' },
      { key: 'task',            label: 'Task',              placeholder: 'Audit {{instance.vars.module}} for OWASP issues', multiline: true },
      { key: 'maxTokens',       label: 'Max tokens',        placeholder: '4096' },
    ],
  },
  WORKBENCH_TASK: {
    label: 'Workbench Task', color: '#ffb786', Icon: Braces,
    description: 'Opens a modal-ready workbench loop. The workflow waits here until the final implementation pack is approved.',
    standardFields: [
      { key: 'modelAlias', label: 'Model', placeholder: 'Use workflow default' },
      { key: 'governanceMode', label: 'Governance mode', placeholder: 'fail_open' },
    ],
  },
  WORK_ITEM: {
    label: 'Work Item', color: '#7c3aed', Icon: Network,
    description: 'Creates a cross-capability work contract. Child capability owners claim it, run a child workflow, then the parent reviews the returned artifacts.',
    standardFields: [
      { key: 'title', label: 'Title', placeholder: 'Implement payment retry support' },
      { key: 'description', label: 'Description', placeholder: 'What the child capability should deliver', multiline: true },
      { key: 'priority', label: 'Priority', placeholder: '50' },
      { key: 'dueAt', label: 'Due date', placeholder: '2026-05-20T09:00:00Z' },
      { key: 'outputPath', label: 'Output path', placeholder: 'workItem' },
    ],
  },
  APPROVAL: {
    label: 'Approval', color: '#a3e635', Icon: CheckCircle,
    description: 'Requires an explicit approval decision before the workflow can proceed.',
    standardFields: [
      { key: 'approver',   label: 'Approver (email)',  placeholder: 'manager@example.com' },
      { key: 'minVotes',   label: 'Min approvals',     placeholder: '1' },
      { key: 'dueInDays',  label: 'Due in (days)',     placeholder: '2' },
      { key: 'escalateTo', label: 'Escalate to',       placeholder: 'director@example.com' },
    ],
  },
  DECISION_GATE: {
    label: 'Decision Gate', color: '#c084fc', Icon: GitMerge,
    description: 'XOR branching gate. Picks the first matching outgoing branch by priority; falls back to the branch marked Default if none match. Configure conditions in the Branches tab.',
    standardFields: [],
  },
  CONSUMABLE_CREATION: {
    label: 'Create Artifact', color: '#34d399', Icon: Package,
    description: 'Produces a typed versioned artifact. Must be reviewed and approved before downstream consumption.',
    standardFields: [
      { key: 'consumableType', label: 'Artifact type',  placeholder: 'CampaignBrief' },
      { key: 'version',        label: 'Version',        placeholder: '1.0' },
      { key: 'requiresApproval', label: 'Requires approval', placeholder: 'true | false' },
    ],
  },
  TOOL_REQUEST: {
    label: 'Tool Request', color: '#fb923c', Icon: Wrench,
    description: 'Routes a tool execution request through the Tool Gateway with policy enforcement.',
    standardFields: [
      { key: 'toolName',   label: 'Tool name',   placeholder: 'send-email' },
      { key: 'actionName', label: 'Action',       placeholder: 'send' },
      { key: 'riskLevel',  label: 'Risk level',   placeholder: 'LOW | MEDIUM | HIGH | CRITICAL' },
    ],
  },
  GIT_PUSH: {
    label: 'Git Push', color: '#22c55e', Icon: GitBranch,
    description: 'Pushes the approved MCP WorkItem branch to the configured git remote. Place this after a human approval gate.',
    standardFields: [
      { key: 'remote', label: 'Remote', placeholder: 'origin' },
      { key: 'branchName', label: 'Branch name', placeholder: 'optional; defaults to work/{{workItemCode}}' },
      { key: 'message', label: 'Commit / push message', placeholder: 'optional commit message' },
      { key: 'requireApproval', label: 'Require prior approval', placeholder: 'true' },
      { key: 'workItemCode', label: 'WorkItem code override', placeholder: 'optional WRK-XXXXX' },
    ],
  },
  POLICY_CHECK: {
    label: 'Policy Check', color: '#94a3b8', Icon: Shield,
    description: 'Evaluates a named policy before continuing. Blocks the workflow if the policy denies.',
    standardFields: [
      { key: 'policyName', label: 'Policy name',  placeholder: 'risk-threshold' },
      { key: 'failAction', label: 'On failure',   placeholder: 'BLOCK | WARN | LOG' },
    ],
  },
  EVAL_GATE: {
    label: 'Eval Gate', color: '#c0c1ff', Icon: Activity,
    description: 'Runs deterministic trust evaluators against the current run, a trace, or a dataset. Blocks the workflow when evidence is missing or the pass-rate threshold is not met.',
    standardFields: [
      { key: 'scope', label: 'Scope', placeholder: 'CURRENT_RUN | TRACE | DATASET' },
      { key: 'evaluatorIds', label: 'Evaluator ids', placeholder: 'comma-separated, optional' },
      { key: 'datasetId', label: 'Dataset id', placeholder: 'required for DATASET scope' },
      { key: 'traceId', label: 'Trace id', placeholder: 'required for TRACE scope' },
      { key: 'capabilityId', label: 'Capability', placeholder: 'optional capability filter' },
      { key: 'minPassRate', label: 'Min pass rate', placeholder: '1.0' },
      { key: 'blockOnMissingEvidence', label: 'Block on missing evidence', placeholder: 'true' },
    ],
  },
  TIMER: {
    label: 'Timer', color: '#facc15', Icon: Clock,
    description: 'Pauses the flow for a fixed duration or until a specific instant. Fires automatically when the time elapses.',
    standardFields: [
      { key: 'duration',   label: 'Duration',         placeholder: '30s | 5m | 2h' },
      { key: 'durationMs', label: 'Duration (ms)',    placeholder: '60000' },
      { key: 'until',      label: 'Until (ISO time)', placeholder: '2026-05-01T09:00:00Z' },
    ],
  },
  SIGNAL_WAIT: {
    label: 'Signal Wait', color: '#06b6d4', Icon: Radio,
    description: 'Pauses execution until an external POST /signals/<name> arrives.',
    standardFields: [
      { key: 'signalName',     label: 'Signal name',     placeholder: 'tool_callback' },
      { key: 'correlationKey', label: 'Correlation key', placeholder: 'optional' },
    ],
  },
  CALL_WORKFLOW: {
    label: 'Sub-workflow', color: '#8b5cf6', Icon: Workflow,
    description: 'Spawns a child run of another workflow. Parent advances when the child completes.',
    standardFields: [
      { key: 'templateId', label: 'Template ID', placeholder: 'uuid' },
      { key: 'version',    label: 'Version',     placeholder: '1' },
    ],
  },
  FOREACH: {
    label: 'For Each', color: '#f43f5e', Icon: Repeat,
    description: 'Iterates over a collection in the workflow context. Each item produces one branch of execution.',
    standardFields: [
      { key: 'collectionPath', label: 'Collection path',  placeholder: 'segment.customers' },
      { key: 'itemVar',        label: 'Item variable',    placeholder: 'customer' },
      { key: 'parallel',       label: 'Parallel',         placeholder: 'true | false' },
      { key: 'maxConcurrency', label: 'Max concurrency',  placeholder: '5 or {{globals.parallelTasks}}' },
    ],
  },
  INCLUSIVE_GATEWAY: {
    label: 'Inclusive Gateway', color: '#a78bfa', Icon: Shuffle,
    description: 'OR-gateway: all outgoing branches whose conditions evaluate to true are followed simultaneously.',
    standardFields: [],
  },
  EVENT_GATEWAY: {
    label: 'Event Gateway', color: '#fbbf24', Icon: Zap,
    description: 'First-to-fire gateway: whichever downstream SIGNAL_WAIT or TIMER fires first wins; others are cancelled.',
    standardFields: [
      { key: 'timeoutDuration', label: 'Global timeout',  placeholder: '5m | 1h | 2026-06-01T00:00:00Z' },
    ],
  },
  DATA_SINK: {
    label: 'Data Sink', color: '#0ea5e9', Icon: Database,
    description: 'Writes workflow data to an external system: a Connector (Jira, S3, Postgres…), an internal DB event, or a versioned artifact.',
    standardFields: [],
  },
  PARALLEL_FORK: {
    label: 'Parallel Fork', color: '#f97316', Icon: GitFork,
    description: 'AND-split gateway. All outgoing branches fire simultaneously regardless of conditions. Connect this to multiple downstream nodes to run them in parallel.',
    standardFields: [
      { key: 'expectedBranches', label: 'Expected branches', placeholder: '2 or {{globals.expectedBranches}}' },
    ],
  },
  PARALLEL_JOIN: {
    label: 'Parallel Join', color: '#d946ef', Icon: GitMerge,
    description: 'AND-join gateway. Waits until ALL incoming parallel branches have arrived before advancing. Set Expected Branches to match the number of parallel paths feeding in.',
    standardFields: [
      { key: 'expectedBranches', label: 'Expected branches', placeholder: '2 or {{globals.expectedBranches}}' },
    ],
  },
  SIGNAL_EMIT: {
    label: 'Signal Emit', color: '#0891b2', Icon: RadioTower,
    description: 'Broadcasts a named signal. Wakes any SIGNAL_WAIT node across all workflow instances that is listening for the same signal name. Optionally include a payload from the workflow context.',
    standardFields: [
      { key: 'signalName',     label: 'Signal name',     placeholder: 'order_ready' },
      { key: 'correlationKey', label: 'Correlation key', placeholder: 'optional' },
      { key: 'payloadPath',    label: 'Payload path',    placeholder: 'context.order (dot-notation)' },
    ],
  },
  SET_CONTEXT: {
    label: 'Set Context', color: '#84cc16', Icon: SlidersHorizontal,
    description: 'Sets or overwrites variables in the workflow context. Downstream nodes see the updated values immediately. Use dot-notation for nested paths (e.g. customer.tier). Wrap a value in {{ }} to copy from another context path.',
    standardFields: [],
  },
  ERROR_CATCH: {
    label: 'Error Catch', color: '#ef4444', Icon: ShieldAlert,
    description: 'Catches failures from an upstream node via an ERROR_BOUNDARY edge. The error message and code are written to the workflow context at the configured path. Draw an ERROR_BOUNDARY edge from any failing node into this node to define a fallback path.',
    standardFields: [
      { key: 'catchErrorCode', label: 'Catch error code', placeholder: 'blank = catch all' },
      { key: 'contextPath',    label: 'Context path',     placeholder: '_error' },
    ],
  },
}

const STATUS_COLOR: Record<string, string> = {
  PENDING: '#64748b', ACTIVE: '#22c55e', COMPLETED: '#4ade80',
  FAILED: '#f87171', SKIPPED: '#64748b', BLOCKED: '#fbbf24',
}

const ARTIFACT_FORMATS = ['TEXT', 'JSON', 'MARKDOWN', 'BINARY'] as const
const TABS = ['Overview', 'Workbench', 'Config', 'Branches', 'Actions', 'Artifacts', 'Runtime'] as const
type Tab = typeof TABS[number]

const DECISION_NODE_TYPES = new Set(['DECISION_GATE', 'INCLUSIVE_GATEWAY', 'EVENT_GATEWAY'])

const CONDITION_OPS: { value: ConditionOp; label: string }[] = [
  { value: '==',          label: '= equals' },
  { value: '!=',          label: '≠ not equals' },
  { value: '>',           label: '> greater than' },
  { value: '>=',          label: '≥ greater or equal' },
  { value: '<',           label: '< less than' },
  { value: '<=',          label: '≤ less or equal' },
  { value: 'contains',    label: 'contains' },
  { value: 'not_contains',label: 'not contains' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with',   label: 'ends with' },
  { value: 'in',          label: 'in list (a,b,c)' },
  { value: 'not_in',      label: 'not in list' },
  { value: 'exists',      label: 'exists' },
  { value: 'not_exists',  label: 'not exists' },
]

// ─── Helpers ──────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 9) }

function normalizeAgentRoleInput(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'AGENT'
}

function emptyConfig(): NodeConfig {
  return { description: '', standard: {}, designKV: [], runtimeKV: [], inputArtifacts: [], outputArtifacts: [], executionLocation: 'CLIENT' }
}

function defaultWorkbenchConfig(): WorkbenchConfig {
  return {
    profile: 'blueprint',
    gateMode: 'manual',
    goal: 'Produce the final implementation contract pack.',
    sourceType: 'localdir',
    sourceUri: '',
    sourceRef: '',
    capabilityId: '',
    agentBindings: {
      architectAgentTemplateId: '',
      developerAgentTemplateId: '',
      qaAgentTemplateId: '',
    },
    loopDefinition: {
      version: 1,
      name: 'Blueprint implementation loop',
      maxLoopsPerStage: 3,
      maxTotalSendBacks: 8,
      stages: [
        {
          key: 'PLAN',
          label: 'Plan',
          agentRole: 'ARCHITECT',
          agentTemplateId: '',
          next: 'DESIGN',
          required: true,
          approvalRequired: true,
          allowedSendBackTo: [],
          expectedArtifacts: [
            { kind: 'mental_model', title: 'Mental model', required: true, format: 'MARKDOWN' },
            { kind: 'gaps', title: 'Gaps and risks', required: true, format: 'MARKDOWN' },
          ],
          questions: [],
        },
        {
          key: 'DESIGN',
          label: 'Design',
          agentRole: 'ARCHITECT',
          agentTemplateId: '',
          next: 'DEVELOP',
          required: true,
          approvalRequired: true,
          allowedSendBackTo: ['PLAN'],
          expectedArtifacts: [
            { kind: 'solution_architecture', title: 'Solution architecture', required: true, format: 'MARKDOWN' },
            { kind: 'approved_spec_draft', title: 'Approved spec draft', required: true, format: 'MARKDOWN' },
          ],
          questions: [],
        },
        {
          key: 'DEVELOP',
          label: 'Develop',
          agentRole: 'DEVELOPER',
          agentTemplateId: '',
          next: 'QA_REVIEW',
          required: true,
          approvalRequired: true,
          allowedSendBackTo: ['PLAN', 'DESIGN'],
          expectedArtifacts: [
            { kind: 'developer_task_pack', title: 'Developer task pack', required: true, format: 'MARKDOWN' },
            { kind: 'simulated_code_change', title: 'Simulated code-change evidence', required: true, format: 'MARKDOWN' },
          ],
          questions: [],
        },
        {
          key: 'QA_REVIEW',
          label: 'QA Review',
          agentRole: 'QA',
          agentTemplateId: '',
          next: 'TEST_CERTIFICATION',
          required: true,
          approvalRequired: true,
          allowedSendBackTo: ['DESIGN', 'DEVELOP'],
          expectedArtifacts: [
            { kind: 'qa_task_pack', title: 'QA review pack', required: true, format: 'MARKDOWN' },
          ],
          questions: [],
        },
        {
          key: 'TEST_CERTIFICATION',
          label: 'Test Certification',
          agentRole: 'QA',
          agentTemplateId: '',
          next: null,
          terminal: true,
          required: true,
          approvalRequired: true,
          allowedSendBackTo: ['DESIGN', 'DEVELOP', 'QA_REVIEW'],
          expectedArtifacts: [
            { kind: 'verification_rules', title: 'Verification rules', required: true, format: 'MARKDOWN' },
            { kind: 'traceability_matrix', title: 'Traceability matrix', required: true, format: 'MARKDOWN' },
            { kind: 'certification_receipt', title: 'Certification receipt', required: true, format: 'MARKDOWN' },
          ],
          questions: [],
        },
      ],
    },
    outputs: {
      finalPackKey: 'finalImplementationPack',
    },
  }
}

function normalizeWorkbenchConfig(raw: unknown): WorkbenchConfig {
  const fallback = defaultWorkbenchConfig()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback
  const r = raw as Record<string, unknown>
  const bindings = r.agentBindings && typeof r.agentBindings === 'object' && !Array.isArray(r.agentBindings)
    ? r.agentBindings as Record<string, unknown>
    : {}
  const loop = r.loopDefinition && typeof r.loopDefinition === 'object' && !Array.isArray(r.loopDefinition)
    ? r.loopDefinition as Record<string, unknown>
    : {}
  const outputs = r.outputs && typeof r.outputs === 'object' && !Array.isArray(r.outputs)
    ? r.outputs as Record<string, unknown>
    : {}
  const rawStages = Array.isArray(loop.stages) ? loop.stages : fallback.loopDefinition.stages
  const stages = rawStages
    .filter((stage): stage is Record<string, unknown> => Boolean(stage) && typeof stage === 'object' && !Array.isArray(stage))
    .map((stage, index): WorkbenchStage => ({
      key: typeof stage.key === 'string' && stage.key.trim() ? stage.key.trim() : `STAGE_${index + 1}`,
      label: typeof stage.label === 'string' ? stage.label : `Stage ${index + 1}`,
      agentRole: typeof stage.agentRole === 'string' && stage.agentRole.trim() ? normalizeAgentRoleInput(stage.agentRole) : 'ARCHITECT',
      agentTemplateId: typeof stage.agentTemplateId === 'string' ? stage.agentTemplateId : '',
      next: typeof stage.next === 'string' ? stage.next : stage.next === null ? null : undefined,
      terminal: stage.terminal === true,
      required: stage.required !== false,
      approvalRequired: stage.approvalRequired !== false,
      expectedArtifacts: Array.isArray(stage.expectedArtifacts)
        ? stage.expectedArtifacts
            .filter((artifact): artifact is Record<string, unknown> => Boolean(artifact) && typeof artifact === 'object' && !Array.isArray(artifact))
            .map((artifact, artifactIndex): WorkbenchExpectedArtifact => ({
              kind: typeof artifact.kind === 'string' && artifact.kind.trim() ? artifact.kind.trim() : `artifact_${artifactIndex + 1}`,
              title: typeof artifact.title === 'string' ? artifact.title : '',
              description: typeof artifact.description === 'string' ? artifact.description : '',
              required: artifact.required !== false,
              format: artifact.format === 'TEXT' || artifact.format === 'JSON' || artifact.format === 'CODE' ? artifact.format : 'MARKDOWN',
            }))
        : [],
      allowedSendBackTo: Array.isArray(stage.allowedSendBackTo) ? stage.allowedSendBackTo.filter((item): item is string => typeof item === 'string') : [],
      questions: Array.isArray(stage.questions)
        ? stage.questions.filter((q): q is Record<string, unknown> => Boolean(q) && typeof q === 'object' && !Array.isArray(q)).map((q, qIndex): WorkbenchQuestion => ({
            id: typeof q.id === 'string' && q.id.trim() ? q.id.trim() : `Q-${index + 1}-${qIndex + 1}`,
            question: typeof q.question === 'string' ? q.question : '',
            required: q.required === true,
            freeform: q.freeform !== false,
            options: Array.isArray(q.options)
              ? q.options.filter((option): option is Record<string, unknown> => Boolean(option) && typeof option === 'object' && !Array.isArray(option)).map(option => ({
                  label: String(option.label ?? ''),
                  impact: typeof option.impact === 'string' ? option.impact : undefined,
                  recommended: option.recommended === true,
                })).filter(option => option.label.trim())
              : [],
          }))
        : [],
    }))
  return {
    profile: 'blueprint',
    gateMode: r.gateMode === 'auto' ? 'auto' : 'manual',
    goal: typeof r.goal === 'string' ? r.goal : fallback.goal,
    sourceType: r.sourceType === 'github' ? 'github' : 'localdir',
    sourceUri: typeof r.sourceUri === 'string' ? r.sourceUri : '',
    sourceRef: typeof r.sourceRef === 'string' ? r.sourceRef : '',
    capabilityId: typeof r.capabilityId === 'string' ? r.capabilityId : '',
    agentBindings: {
      architectAgentTemplateId: typeof bindings.architectAgentTemplateId === 'string' ? bindings.architectAgentTemplateId : '',
      developerAgentTemplateId: typeof bindings.developerAgentTemplateId === 'string' ? bindings.developerAgentTemplateId : '',
      qaAgentTemplateId: typeof bindings.qaAgentTemplateId === 'string' ? bindings.qaAgentTemplateId : '',
    },
    loopDefinition: {
      version: 1,
      name: typeof loop.name === 'string' ? loop.name : fallback.loopDefinition.name,
      maxLoopsPerStage: typeof loop.maxLoopsPerStage === 'number' ? loop.maxLoopsPerStage : fallback.loopDefinition.maxLoopsPerStage,
      maxTotalSendBacks: typeof loop.maxTotalSendBacks === 'number' ? loop.maxTotalSendBacks : fallback.loopDefinition.maxTotalSendBacks,
      stages,
    },
    outputs: {
      finalPackKey: typeof outputs.finalPackKey === 'string' && outputs.finalPackKey.trim() ? outputs.finalPackKey.trim() : fallback.outputs.finalPackKey,
    },
  }
}

function normalizeConfig(raw: unknown): NodeConfig {
  const empty = emptyConfig()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const r = raw as Record<string, unknown>
  const retryPolicy = (r.retryPolicy && typeof r.retryPolicy === 'object' && !Array.isArray(r.retryPolicy))
    ? r.retryPolicy as Partial<RetryPolicy>
    : undefined
  const compensationConfig = (r.compensationConfig && typeof r.compensationConfig === 'object' && !Array.isArray(r.compensationConfig))
    ? r.compensationConfig as CompensationConfig
    : undefined
  return {
    description: typeof r.description === 'string' ? r.description : empty.description,
    standard: (r.standard && typeof r.standard === 'object' && !Array.isArray(r.standard))
      ? r.standard as Record<string, string>
      : empty.standard,
    designKV: Array.isArray(r.designKV) ? r.designKV as KVPair[] : empty.designKV,
    runtimeKV: Array.isArray(r.runtimeKV) ? r.runtimeKV as KVPair[] : empty.runtimeKV,
    inputArtifacts: Array.isArray(r.inputArtifacts) ? r.inputArtifacts as ArtifactDef[] : empty.inputArtifacts,
    outputArtifacts: Array.isArray(r.outputArtifacts) ? r.outputArtifacts as ArtifactDef[] : empty.outputArtifacts,
    retryPolicy: retryPolicy ? {
      maxAttempts: typeof retryPolicy.maxAttempts === 'number' ? retryPolicy.maxAttempts : 1,
      initialIntervalMs: typeof retryPolicy.initialIntervalMs === 'number' ? retryPolicy.initialIntervalMs : 1000,
      backoffCoefficient: typeof retryPolicy.backoffCoefficient === 'number' ? retryPolicy.backoffCoefficient : 2,
      nonRetryableErrors: Array.isArray(retryPolicy.nonRetryableErrors) ? retryPolicy.nonRetryableErrors as string[] : [],
    } : undefined,
    compensationConfig,
    formWidgets: Array.isArray(r.formWidgets) ? r.formWidgets as FormWidget[] : undefined,
    attachments: Array.isArray(r.attachments) ? r.attachments as Attachment[] : [],
    executionLocation: typeof r.executionLocation === 'string' ? r.executionLocation : 'CLIENT',
    sinkConfig: (r.sinkConfig && typeof r.sinkConfig === 'object' && !Array.isArray(r.sinkConfig))
      ? {
          kind: (r.sinkConfig as any).kind ?? 'CONNECTOR',
          connectorId: (r.sinkConfig as any).connectorId,
          operation: (r.sinkConfig as any).operation,
          paramMap: (r.sinkConfig as any).paramMap && typeof (r.sinkConfig as any).paramMap === 'object' ? (r.sinkConfig as any).paramMap : {},
          bodyPath: (r.sinkConfig as any).bodyPath,
          namePath: (r.sinkConfig as any).namePath,
          artifactType: (r.sinkConfig as any).artifactType,
        } as SinkConfig
      : undefined,
    assignments: Array.isArray(r.assignments) ? r.assignments as KVPair[] : undefined,
    globalAssignments: Array.isArray(r.globalAssignments) ? r.globalAssignments as KVPair[] : undefined,
    workbench: r.workbench ? normalizeWorkbenchConfig(r.workbench) : undefined,
    targets: Array.isArray(r.targets)
      ? (r.targets as Array<Partial<WorkItemTargetConfig>>).map(t => ({
          id: typeof t.id === 'string' ? t.id : uid(),
          targetCapabilityId: typeof t.targetCapabilityId === 'string' ? t.targetCapabilityId : '',
          childWorkflowTemplateId: typeof t.childWorkflowTemplateId === 'string' ? t.childWorkflowTemplateId : '',
          roleKey: typeof t.roleKey === 'string' ? t.roleKey : '',
        }))
      : undefined,
    assignmentMode:
      r.assignmentMode === 'DIRECT_USER' || r.assignmentMode === 'TEAM_QUEUE' ||
      r.assignmentMode === 'ROLE_BASED'  || r.assignmentMode === 'SKILL_BASED' ||
      r.assignmentMode === 'AGENT'
        ? r.assignmentMode
        : undefined,
    assignedToId: typeof r.assignedToId === 'string' ? r.assignedToId : undefined,
    teamId:       typeof r.teamId       === 'string' ? r.teamId       : undefined,
    roleKey:      typeof r.roleKey      === 'string' ? r.roleKey      : undefined,
    skillKey:     typeof r.skillKey     === 'string' ? r.skillKey     : undefined,
  }
}

function emptyArtifact(direction: 'INPUT' | 'OUTPUT'): ArtifactDef {
  return { id: uid(), name: '', artifactType: '', direction, format: 'TEXT', required: false, description: '' }
}

function emptyKV(): KVPair { return { id: uid(), key: '', value: '' } }

function emptyWorkItemTarget(): WorkItemTargetConfig {
  return { id: uid(), targetCapabilityId: '', childWorkflowTemplateId: '', roleKey: '' }
}

function emptyAttachment(): Attachment {
  return {
    id: uid(),
    type: 'tool',
    trigger: 'on_activate',
    enabled: true,
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────

function TabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.1em', border: 'none', cursor: 'pointer',
        background: active ? 'rgba(34,197,94,0.15)' : 'transparent',
        color: active ? '#22c55e' : '#475569',
        transition: 'all 0.12s',
      }}
    >
      {label}
    </button>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#64748b', marginBottom: 6 }}>
      {children}
    </p>
  )
}

function NeoInput({ value, onChange, placeholder, multiline = false }: {
  value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean
}) {
  const base: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box',
    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 9, padding: '9px 12px', fontSize: 13, lineHeight: 1.45, color: '#e2e8f0',
    outline: 'none', resize: 'vertical' as const, fontFamily: 'inherit',
    transition: 'border-color 0.12s',
  }
  if (multiline) return (
    <textarea
      value={value} rows={3} placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      style={base}
      onFocus={e => (e.target.style.borderColor = 'rgba(34,197,94,0.4)')}
      onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.10)')}
    />
  )
  return (
    <input
      value={value} placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      style={base}
      onFocus={e => (e.target.style.borderColor = 'rgba(34,197,94,0.4)')}
      onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.10)')}
    />
  )
}

function ModelAliasPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useQuery({
    queryKey: ['llm-model-catalog'],
    queryFn: () => api.get('/llm/models').then(r => unwrapModelCatalog(r.data)),
    staleTime: 30_000,
  })
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <select
        value={value || '__workflow_default__'}
        onChange={e => onChange(e.target.value === '__workflow_default__' ? '' : e.target.value)}
        style={{
          width: '100%', boxSizing: 'border-box',
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 9, padding: '9px 12px', fontSize: 13, lineHeight: 1.45, color: '#e2e8f0',
          outline: 'none', cursor: 'pointer',
        }}
      >
        <option value="__workflow_default__" style={{ background: '#0f172a' }}>Use workflow default</option>
        {(data?.models ?? []).map(model => (
          <option key={model.id} value={model.id} disabled={model.ready === false} style={{ background: '#0f172a' }}>
            {(model.label ?? model.id)}{model.ready === false ? ' - Missing key' : ''}{model.costTier ? ` - ${model.costTier}` : ''}
          </option>
        ))}
      </select>
      {value && data?.models?.find(m => m.id === value) && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {(() => {
            const selected = data.models.find(m => m.id === value)!
            const badges = [
              selected.ready === false ? 'Missing key' : 'Ready',
              selected.supportsTools ? 'Tool capable' : undefined,
              selected.costTier ? `${selected.costTier} cost` : undefined,
              selected.provider && selected.model ? `${selected.provider}/${selected.model}` : undefined,
            ].filter(Boolean)
            return badges.map(badge => (
              <span key={badge} style={{
                fontSize: 8, color: '#94a3b8', border: '1px solid rgba(148,163,184,0.22)',
                borderRadius: 999, padding: '2px 6px',
              }}>
                {badge}
              </span>
            ))
          })()}
        </div>
      )}
    </div>
  )
}

function NeoSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select
      value={value} onChange={e => onChange(e.target.value)}
      style={{
        width: '100%', boxSizing: 'border-box',
        background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 9, padding: '9px 12px', fontSize: 13, lineHeight: 1.45, color: '#e2e8f0',
        outline: 'none', appearance: 'none', cursor: 'pointer',
      }}
    >
      {options.map(o => <option key={o} value={o} style={{ background: '#0f172a' }}>{o}</option>)}
    </select>
  )
}

// ─── Artifact Editor ──────────────────────────────────────────────────────

function ArtifactCard({
  artifact, onChange, onDelete,
}: {
  artifact: ArtifactDef
  onChange: (a: ArtifactDef) => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const isInput = artifact.direction === 'INPUT'
  const accentColor = isInput ? '#38bdf8' : '#34d399'

  return (
    <div style={{
      borderRadius: 10, border: `1px solid ${accentColor}20`,
      background: `${accentColor}06`, marginBottom: 6, overflow: 'hidden',
    }}>
      {/* Header row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer',
      }} onClick={() => setOpen(o => !o)}>
        <div style={{
          width: 22, height: 22, borderRadius: 6, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${accentColor}15`, border: `1px solid ${accentColor}25`,
        }}>
          {isInput
            ? <ArrowDownToLine size={10} style={{ color: accentColor }} />
            : <ArrowUpFromLine size={10} style={{ color: accentColor }} />
          }
        </div>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 600, color: '#cbd5e1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {artifact.name || <span style={{ color: '#475569', fontStyle: 'italic' }}>Unnamed artifact</span>}
        </span>
        <span style={{
          fontSize: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
          padding: '2px 6px', borderRadius: 4,
          background: `${accentColor}15`, color: accentColor,
        }}>
          {artifact.format}
        </span>
        {artifact.required && (
          <span style={{ fontSize: 8, color: '#fbbf24', fontWeight: 700 }}>REQ</span>
        )}
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: 2, display: 'flex' }}
          onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.color = '#f87171')}
          onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.color = '#475569')}
        >
          <Trash2 size={11} />
        </button>
        {open ? <ChevronDown size={11} style={{ color: '#475569' }} /> : <ChevronRight size={11} style={{ color: '#475569' }} />}
      </div>

      {/* Expanded fields */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ height: 1, background: `${accentColor}15`, marginBottom: 2 }} />

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <FieldLabel>Name</FieldLabel>
                  <NeoInput value={artifact.name} onChange={v => onChange({ ...artifact, name: v })} placeholder="CampaignBrief" />
                </div>
                <div>
                  <FieldLabel>Artifact type</FieldLabel>
                  <NeoInput value={artifact.artifactType} onChange={v => onChange({ ...artifact, artifactType: v })} placeholder="CustomerSegment" />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <FieldLabel>Format</FieldLabel>
                  <NeoSelect value={artifact.format} onChange={v => onChange({ ...artifact, format: v as ArtifactDef['format'] })} options={[...ARTIFACT_FORMATS]} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', paddingBottom: 7 }}>
                    <input
                      type="checkbox"
                      checked={artifact.required}
                      onChange={e => onChange({ ...artifact, required: e.target.checked })}
                      style={{ accentColor: '#22c55e', width: 13, height: 13 }}
                    />
                    <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600 }}>Required</span>
                  </label>
                </div>
              </div>

              <div>
                <FieldLabel>{isInput ? 'Reads from context path' : 'Writes to context path'}</FieldLabel>
                <NeoInput
                  value={artifact.bindingPath ?? ''}
                  onChange={v => onChange({ ...artifact, bindingPath: v || undefined })}
                  placeholder={isInput ? 'segment.customers' : 'campaign.brief'}
                />
              </div>

              <div>
                <FieldLabel>Description / contract</FieldLabel>
                <NeoInput value={artifact.description} onChange={v => onChange({ ...artifact, description: v })} placeholder="Describe what this artifact contains…" multiline />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function ArtifactsTab({
  config, onChange,
}: { config: NodeConfig; onChange: (c: NodeConfig) => void }) {
  const addArtifact = (dir: 'INPUT' | 'OUTPUT') => {
    const key = dir === 'INPUT' ? 'inputArtifacts' : 'outputArtifacts'
    onChange({ ...config, [key]: [...config[key], emptyArtifact(dir)] })
  }

  const updateArtifact = (dir: 'INPUT' | 'OUTPUT', id: string, a: ArtifactDef) => {
    const key = dir === 'INPUT' ? 'inputArtifacts' : 'outputArtifacts'
    onChange({ ...config, [key]: config[key].map(x => x.id === id ? a : x) })
  }

  const deleteArtifact = (dir: 'INPUT' | 'OUTPUT', id: string) => {
    const key = dir === 'INPUT' ? 'inputArtifacts' : 'outputArtifacts'
    onChange({ ...config, [key]: config[key].filter(x => x.id !== id) })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Input artifacts */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ArrowDownToLine size={12} style={{ color: '#38bdf8' }} />
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#38bdf8' }}>
              Input artifacts
            </span>
            {config.inputArtifacts.length > 0 && (
              <span style={{
                fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                background: 'rgba(56,189,248,0.15)', color: '#38bdf8',
              }}>
                {config.inputArtifacts.length}
              </span>
            )}
          </div>
          <button
            onClick={() => addArtifact('INPUT')}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px',
              borderRadius: 6, border: '1px solid rgba(56,189,248,0.25)',
              background: 'rgba(56,189,248,0.08)', color: '#38bdf8',
              fontSize: 10, fontWeight: 600, cursor: 'pointer',
            }}
          >
            <Plus size={9} /> Add
          </button>
        </div>
        {config.inputArtifacts.length === 0 ? (
          <div style={{
            padding: '10px', borderRadius: 8, textAlign: 'center',
            border: '1px dashed rgba(56,189,248,0.15)', background: 'rgba(56,189,248,0.03)',
          }}>
            <p style={{ fontSize: 10, color: '#334155' }}>No input artifacts defined</p>
          </div>
        ) : config.inputArtifacts.map(a => (
          <ArtifactCard
            key={a.id} artifact={a}
            onChange={updated => updateArtifact('INPUT', a.id, updated)}
            onDelete={() => deleteArtifact('INPUT', a.id)}
          />
        ))}
		                </div>

                <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />

      {/* Output artifacts */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ArrowUpFromLine size={12} style={{ color: '#34d399' }} />
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#34d399' }}>
              Output artifacts
            </span>
            {config.outputArtifacts.length > 0 && (
              <span style={{
                fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                background: 'rgba(52,211,153,0.15)', color: '#34d399',
              }}>
                {config.outputArtifacts.length}
              </span>
            )}
          </div>
          <button
            onClick={() => addArtifact('OUTPUT')}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px',
              borderRadius: 6, border: '1px solid rgba(52,211,153,0.25)',
              background: 'rgba(52,211,153,0.08)', color: '#34d399',
              fontSize: 10, fontWeight: 600, cursor: 'pointer',
            }}
          >
            <Plus size={9} /> Add
          </button>
        </div>
        {config.outputArtifacts.length === 0 ? (
          <div style={{
            padding: '10px', borderRadius: 8, textAlign: 'center',
            border: '1px dashed rgba(52,211,153,0.15)', background: 'rgba(52,211,153,0.03)',
          }}>
            <p style={{ fontSize: 10, color: '#334155' }}>No output artifacts defined</p>
          </div>
        ) : config.outputArtifacts.map(a => (
          <ArtifactCard
            key={a.id} artifact={a}
            onChange={updated => updateArtifact('OUTPUT', a.id, updated)}
            onDelete={() => deleteArtifact('OUTPUT', a.id)}
          />
        ))}
      </div>
    </div>
  )
}

function WorkbenchTab({
  config,
  onChange,
}: {
  config: WorkbenchConfig | undefined
  onChange: (config: WorkbenchConfig) => void
}) {
  const wb = config ?? defaultWorkbenchConfig()
  const stages = wb.loopDefinition.stages
  const stageKeys = stages.map(stage => stage.key).filter(Boolean)
  const errors = validateWorkbenchBuilder(wb)
  const update = (patch: Partial<WorkbenchConfig>) => onChange({ ...wb, ...patch })
  const updateLoop = (patch: Partial<WorkbenchConfig['loopDefinition']>) =>
    update({ loopDefinition: { ...wb.loopDefinition, ...patch } })
  const updateBindings = (patch: Partial<WorkbenchConfig['agentBindings']>) =>
    update({ agentBindings: { ...wb.agentBindings, ...patch } })
  const updateStage = (index: number, patch: Partial<WorkbenchStage>) => {
    updateLoop({ stages: stages.map((stage, i) => i === index ? { ...stage, ...patch } : stage) })
  }
  const addStage = () => {
    const key = `STAGE_${stages.length + 1}`
    updateLoop({
      stages: [
        ...stages.map(stage => stage.terminal ? { ...stage, terminal: false, next: key } : stage),
        {
          key,
          label: `Stage ${stages.length + 1}`,
          agentRole: 'AGENT',
          agentTemplateId: '',
          required: true,
          approvalRequired: true,
          terminal: true,
          next: null,
          allowedSendBackTo: stageKeys,
          expectedArtifacts: [
            { kind: `stage_${stages.length + 1}_artifact`, title: `Stage ${stages.length + 1} artifact`, required: true, format: 'MARKDOWN' },
          ],
          questions: [],
        },
      ],
    })
  }
  const removeStage = (index: number) => {
    if (stages.length <= 1) return
    const removedKey = stages[index].key
    const nextStages = stages
      .filter((_, i) => i !== index)
      .map((stage, i, arr) => ({
        ...stage,
        next: stage.next === removedKey ? arr[i + 1]?.key ?? null : stage.next,
        allowedSendBackTo: stage.allowedSendBackTo.filter(key => key !== removedKey),
      }))
    if (!nextStages.some(stage => stage.terminal)) {
      nextStages[nextStages.length - 1] = { ...nextStages[nextStages.length - 1], terminal: true, next: null }
    }
    updateLoop({ stages: nextStages })
  }
  const addQuestion = (stageIndex: number) => {
    const stage = stages[stageIndex]
    const questions = stage.questions ?? []
    updateStage(stageIndex, {
      questions: [
        ...questions,
        { id: `${stage.key || 'STAGE'}-${questions.length + 1}`, question: '', required: true, freeform: true, options: [] },
      ],
    })
  }
  const updateQuestion = (stageIndex: number, questionIndex: number, patch: Partial<WorkbenchQuestion>) => {
    const stage = stages[stageIndex]
    const questions = stage.questions ?? []
    updateStage(stageIndex, {
      questions: questions.map((question, i) => i === questionIndex ? { ...question, ...patch } : question),
    })
  }
  const removeQuestion = (stageIndex: number, questionIndex: number) => {
    const stage = stages[stageIndex]
    updateStage(stageIndex, { questions: (stage.questions ?? []).filter((_, i) => i !== questionIndex) })
  }
  const addOption = (stageIndex: number, questionIndex: number) => {
    const question = stages[stageIndex].questions?.[questionIndex]
    if (!question) return
    updateQuestion(stageIndex, questionIndex, { options: [...(question.options ?? []), { label: '', impact: '', recommended: false }] })
  }
  const updateOption = (stageIndex: number, questionIndex: number, optionIndex: number, patch: Partial<WorkbenchQuestionOption>) => {
    const question = stages[stageIndex].questions?.[questionIndex]
    if (!question) return
    updateQuestion(stageIndex, questionIndex, {
      options: (question.options ?? []).map((option, i) => i === optionIndex ? { ...option, ...patch } : option),
    })
  }
  const removeOption = (stageIndex: number, questionIndex: number, optionIndex: number) => {
    const question = stages[stageIndex].questions?.[questionIndex]
    if (!question) return
    updateQuestion(stageIndex, questionIndex, { options: (question.options ?? []).filter((_, i) => i !== optionIndex) })
  }
  const addExpectedArtifact = (stageIndex: number) => {
    const stage = stages[stageIndex]
    const artifacts = stage.expectedArtifacts ?? []
    updateStage(stageIndex, {
      expectedArtifacts: [
        ...artifacts,
        { kind: `${stage.key || 'stage'}_artifact_${artifacts.length + 1}`.toLowerCase(), title: `Artifact ${artifacts.length + 1}`, required: true, format: 'MARKDOWN' },
      ],
    })
  }
  const updateExpectedArtifact = (stageIndex: number, artifactIndex: number, patch: Partial<WorkbenchExpectedArtifact>) => {
    const stage = stages[stageIndex]
    const artifacts = stage.expectedArtifacts ?? []
    updateStage(stageIndex, {
      expectedArtifacts: artifacts.map((artifact, i) => i === artifactIndex ? { ...artifact, ...patch } : artifact),
    })
  }
  const removeExpectedArtifact = (stageIndex: number, artifactIndex: number) => {
    const stage = stages[stageIndex]
    updateStage(stageIndex, { expectedArtifacts: (stage.expectedArtifacts ?? []).filter((_, i) => i !== artifactIndex) })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{
        padding: '10px', borderRadius: 10,
        border: '1px solid rgba(255,183,134,0.18)',
        background: 'rgba(255,183,134,0.07)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
          <Braces size={13} style={{ color: '#ffb786' }} />
          <span style={{ fontSize: 11, fontWeight: 800, color: '#ffb786', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            Blueprint Workbench
          </span>
        </div>
        <p style={{ fontSize: 10, color: '#94a3b8', lineHeight: 1.55 }}>
          This node pauses the workflow, opens the Workbench modal, and returns the approved implementation pack as node output.
        </p>
      </div>

      {errors.length > 0 && (
        <div style={{
          padding: '8px 10px', borderRadius: 8,
          border: '1px solid rgba(248,113,113,0.24)',
          background: 'rgba(248,113,113,0.08)',
        }}>
          {errors.map(error => (
            <p key={error} style={{ fontSize: 10, color: '#fca5a5', marginBottom: 3 }}>{error}</p>
          ))}
        </div>
      )}

      <div>
        <FieldLabel>Goal</FieldLabel>
        <NeoInput value={wb.goal} onChange={goal => update({ goal })} placeholder="What should the workbench produce?" multiline />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div>
          <FieldLabel>Source type</FieldLabel>
          <NeoSelect value={wb.sourceType} onChange={sourceType => update({ sourceType: sourceType as WorkbenchConfig['sourceType'] })} options={['localdir', 'github']} />
        </div>
        <div>
          <FieldLabel>Gate mode</FieldLabel>
          <NeoSelect value={wb.gateMode} onChange={gateMode => update({ gateMode: gateMode as WorkbenchConfig['gateMode'] })} options={['manual', 'auto']} />
        </div>
      </div>

      <div>
        <FieldLabel>{wb.sourceType === 'github' ? 'GitHub URL' : 'Local directory'}</FieldLabel>
        <NeoInput value={wb.sourceUri ?? ''} onChange={sourceUri => update({ sourceUri })} placeholder={wb.sourceType === 'github' ? 'https://github.com/org/repo' : '/Users/name/project'} />
      </div>

      <div>
        <FieldLabel>Branch / path filter</FieldLabel>
        <NeoInput value={wb.sourceRef ?? ''} onChange={sourceRef => update({ sourceRef })} placeholder="main, src/**, or leave blank" />
      </div>

      <div>
        <FieldLabel>Capability</FieldLabel>
        <CapabilityPicker value={wb.capabilityId} onChange={capabilityId => update({ capabilityId })} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <FieldLabel>Default agent fallbacks</FieldLabel>
        <AgentBindingRow label="Architect" capabilityId={wb.capabilityId} value={wb.agentBindings.architectAgentTemplateId} onChange={architectAgentTemplateId => updateBindings({ architectAgentTemplateId })} />
        <AgentBindingRow label="Developer" capabilityId={wb.capabilityId} value={wb.agentBindings.developerAgentTemplateId} onChange={developerAgentTemplateId => updateBindings({ developerAgentTemplateId })} />
        <AgentBindingRow label="QA" capabilityId={wb.capabilityId} value={wb.agentBindings.qaAgentTemplateId} onChange={qaAgentTemplateId => updateBindings({ qaAgentTemplateId })} />
        <p style={{ fontSize: 10, color: '#94a3b8', lineHeight: 1.45, margin: 0 }}>
          Each phase can override the agent. These are used only when a phase does not bind its own agent.
        </p>
      </div>

      <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 90px', gap: 8 }}>
        <div>
          <FieldLabel>Loop name</FieldLabel>
          <NeoInput value={wb.loopDefinition.name} onChange={name => updateLoop({ name })} />
        </div>
        <div>
          <FieldLabel>Loops/stage</FieldLabel>
          <NeoInput value={String(wb.loopDefinition.maxLoopsPerStage)} onChange={v => updateLoop({ maxLoopsPerStage: Number(v) || 1 })} />
        </div>
        <div>
          <FieldLabel>Send-backs</FieldLabel>
          <NeoInput value={String(wb.loopDefinition.maxTotalSendBacks)} onChange={v => updateLoop({ maxTotalSendBacks: Number(v) || 1 })} />
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <FieldLabel>Loop phases</FieldLabel>
          <button onClick={addStage} style={miniButton('#ffb786')}>
            <Plus size={10} /> Add phase
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {stages.map((stage, stageIndex) => (
            <div key={`${stage.key}-${stageIndex}`} style={{
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 10,
              background: 'rgba(255,255,255,0.035)',
              padding: 10,
            }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 128px auto', gap: 7, alignItems: 'end' }}>
                <div>
                  <FieldLabel>Key</FieldLabel>
                  <NeoInput value={stage.key} onChange={key => updateStage(stageIndex, { key })} />
                </div>
                <div>
                  <FieldLabel>Label</FieldLabel>
                  <NeoInput value={stage.label} onChange={label => updateStage(stageIndex, { label })} />
                </div>
                <div>
                  <FieldLabel>Agent role</FieldLabel>
                  <NeoInput value={stage.agentRole} onChange={agentRole => updateStage(stageIndex, { agentRole: normalizeAgentRoleInput(agentRole) })} placeholder="ARCHITECT, QA, SECURITY" />
                </div>
                <button onClick={() => removeStage(stageIndex)} disabled={stages.length <= 1} style={iconButton(stages.length <= 1)}>
                  <Trash2 size={11} />
                </button>
              </div>

              <div style={{ marginTop: 8 }}>
                <FieldLabel>Phase agent</FieldLabel>
                <AgentPicker capabilityId={wb.capabilityId || null} value={stage.agentTemplateId ?? ''} onChange={agentTemplateId => updateStage(stageIndex, { agentTemplateId })} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, marginTop: 8 }}>
                <div>
                  <FieldLabel>Next phase</FieldLabel>
                  <select
                    value={stage.terminal ? '' : stage.next ?? ''}
                    disabled={stage.terminal === true}
                    onChange={event => updateStage(stageIndex, { next: event.target.value || null })}
                    style={selectStyle(stage.terminal === true)}
                  >
                    <option value="" style={{ background: '#0f172a' }}>{stage.terminal ? 'Terminal' : 'Select next phase'}</option>
                    {stageKeys.filter(key => key !== stage.key).map(key => <option key={key} value={key} style={{ background: '#0f172a' }}>{key}</option>)}
                  </select>
                </div>
                <div>
                  <FieldLabel>Allowed send-back</FieldLabel>
                  <select
                    multiple
                    value={stage.allowedSendBackTo}
                    onChange={event => {
                      const values = Array.from(event.currentTarget.selectedOptions).map(option => option.value)
                      updateStage(stageIndex, { allowedSendBackTo: values })
                    }}
                    style={{ ...selectStyle(false), minHeight: 62 }}
                  >
                    {stageKeys.filter(key => key !== stage.key).map(key => <option key={key} value={key} style={{ background: '#0f172a' }}>{key}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <label style={checkLabel()}>
                  <input type="checkbox" checked={stage.required} onChange={event => updateStage(stageIndex, { required: event.target.checked })} />
                  Required gate
                </label>
                <label style={checkLabel()}>
                  <input type="checkbox" checked={stage.approvalRequired !== false} onChange={event => updateStage(stageIndex, { approvalRequired: event.target.checked })} />
                  Human approval after artifacts
                </label>
                <label style={checkLabel()}>
                  <input
                    type="checkbox"
                    checked={stage.terminal === true}
                    onChange={event => {
                      const terminal = event.target.checked
                      updateLoop({
                        stages: stages.map((item, i) => i === stageIndex
                          ? { ...item, terminal, next: terminal ? null : item.next }
                          : terminal ? { ...item, terminal: false } : item),
                      })
                    }}
                  />
                  Terminal
                </label>
              </div>

              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 9, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                    Artifacts produced by this phase
                  </span>
                  <button onClick={() => addExpectedArtifact(stageIndex)} style={miniButton('#ffb786')}>
                    <Plus size={10} /> Artifact
                  </button>
                </div>
                {(stage.expectedArtifacts ?? []).length === 0 && (
                  <p style={{ fontSize: 10, color: '#94a3b8', margin: 0 }}>
                    No explicit artifact contract. The Workbench will generate a generic stage artifact.
                  </p>
                )}
                {(stage.expectedArtifacts ?? []).map((artifact, artifactIndex) => (
                  <div key={`${artifact.kind}-${artifactIndex}`} style={{
                    border: '1px solid rgba(255,183,134,0.16)',
                    borderRadius: 8,
                    padding: 8,
                    marginTop: 6,
                    background: 'rgba(255,183,134,0.04)',
                  }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 92px auto', gap: 6, alignItems: 'end' }}>
                      <div>
                        <FieldLabel>Kind</FieldLabel>
                        <NeoInput value={artifact.kind} onChange={kind => updateExpectedArtifact(stageIndex, artifactIndex, { kind })} placeholder="design_doc" />
                      </div>
                      <div>
                        <FieldLabel>Title</FieldLabel>
                        <NeoInput value={artifact.title} onChange={title => updateExpectedArtifact(stageIndex, artifactIndex, { title })} placeholder="Design document" />
                      </div>
                      <div>
                        <FieldLabel>Format</FieldLabel>
                        <NeoSelect value={artifact.format} onChange={format => updateExpectedArtifact(stageIndex, artifactIndex, { format: format as WorkbenchExpectedArtifact['format'] })} options={['MARKDOWN', 'TEXT', 'JSON', 'CODE']} />
                      </div>
                      <button onClick={() => removeExpectedArtifact(stageIndex, artifactIndex)} style={iconButton(false)}>
                        <Trash2 size={11} />
                      </button>
                    </div>
                    <div style={{ marginTop: 6 }}>
                      <FieldLabel>Description</FieldLabel>
                      <NeoInput value={artifact.description ?? ''} onChange={description => updateExpectedArtifact(stageIndex, artifactIndex, { description })} placeholder="What this artifact must contain" multiline />
                    </div>
                    <label style={{ ...checkLabel(), marginTop: 7 }}>
                      <input type="checkbox" checked={artifact.required} onChange={event => updateExpectedArtifact(stageIndex, artifactIndex, { required: event.target.checked })} />
                      Required artifact for approval
                    </label>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 9, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                    Questions
                  </span>
                  <button onClick={() => addQuestion(stageIndex)} style={miniButton('#adc6ff')}>
                    <Plus size={10} /> Question
                  </button>
                </div>
                {(stage.questions ?? []).map((question, questionIndex) => (
                  <div key={`${question.id}-${questionIndex}`} style={{
                    border: '1px solid rgba(173,198,255,0.14)',
                    borderRadius: 8,
                    padding: 8,
                    marginTop: 6,
                    background: 'rgba(173,198,255,0.04)',
                  }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '96px 1fr auto', gap: 6, alignItems: 'end' }}>
                      <div>
                        <FieldLabel>ID</FieldLabel>
                        <NeoInput value={question.id} onChange={id => updateQuestion(stageIndex, questionIndex, { id })} />
                      </div>
                      <div>
                        <FieldLabel>Question</FieldLabel>
                        <NeoInput value={question.question} onChange={text => updateQuestion(stageIndex, questionIndex, { question: text })} />
                      </div>
                      <button onClick={() => removeQuestion(stageIndex, questionIndex)} style={iconButton(false)}>
                        <Trash2 size={11} />
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: 12, marginTop: 7 }}>
                      <label style={checkLabel()}><input type="checkbox" checked={question.required} onChange={event => updateQuestion(stageIndex, questionIndex, { required: event.target.checked })} />Required</label>
                      <label style={checkLabel()}><input type="checkbox" checked={question.freeform} onChange={event => updateQuestion(stageIndex, questionIndex, { freeform: event.target.checked })} />Free form</label>
                    </div>
                    <div style={{ marginTop: 7 }}>
                      <button onClick={() => addOption(stageIndex, questionIndex)} style={miniButton('#c0c1ff')}>
                        <Plus size={10} /> Option
                      </button>
                      {(question.options ?? []).map((option, optionIndex) => (
                        <div key={optionIndex} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', gap: 5, alignItems: 'center', marginTop: 5 }}>
                          <NeoInput value={option.label} onChange={label => updateOption(stageIndex, questionIndex, optionIndex, { label })} placeholder="Option label" />
                          <NeoInput value={option.impact ?? ''} onChange={impact => updateOption(stageIndex, questionIndex, optionIndex, { impact })} placeholder="Impact" />
                          <label style={checkLabel()}><input type="checkbox" checked={option.recommended === true} onChange={event => updateOption(stageIndex, questionIndex, optionIndex, { recommended: event.target.checked })} />Rec</label>
                          <button onClick={() => removeOption(stageIndex, questionIndex, optionIndex)} style={iconButton(false)}><Trash2 size={10} /></button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <FieldLabel>Final output key</FieldLabel>
        <NeoInput
          value={wb.outputs.finalPackKey}
          onChange={finalPackKey => update({ outputs: { finalPackKey } })}
          placeholder="finalImplementationPack"
        />
      </div>
    </div>
  )
}

function AgentBindingRow({ label, capabilityId, value, onChange }: {
  label: string
  capabilityId: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <AgentPicker capabilityId={capabilityId || null} value={value} onChange={onChange} />
    </div>
  )
}

function validateWorkbenchBuilder(config: WorkbenchConfig | undefined): string[] {
  if (!config) return ['Workbench configuration is required.']
  const errors: string[] = []
  const stages = config.loopDefinition.stages
  const keys = stages.map(stage => stage.key.trim()).filter(Boolean)
  const keySet = new Set(keys)
  if (!config.goal.trim()) errors.push('Goal is required.')
  if (!config.capabilityId.trim()) errors.push('Capability is required.')
  if (stages.length === 0) errors.push('At least one loop phase is required.')
  if (keys.length !== stages.length) errors.push('Every phase needs a key.')
  if (keys.length !== keySet.size) errors.push('Phase keys must be unique.')
  if (stages.filter(stage => stage.terminal).length !== 1) errors.push('Exactly one phase must be terminal.')
  for (const stage of stages) {
    if (!stage.label.trim()) errors.push(`${stage.key || 'Phase'} needs a label.`)
    if (!stage.agentRole.trim()) errors.push(`${stage.key || 'Phase'} needs an agent role.`)
    if (!stage.agentTemplateId?.trim() && !fallbackAgentForStage(config, stage).trim()) {
      errors.push(`${stage.key || 'Phase'} needs a phase agent or matching default fallback.`)
    }
    if (!stage.terminal && stage.next && !keySet.has(stage.next)) errors.push(`${stage.key} has an invalid next phase.`)
    if (!stage.terminal && !stage.next) errors.push(`${stage.key} needs a next phase or must be terminal.`)
    for (const target of stage.allowedSendBackTo) {
      if (!keySet.has(target)) errors.push(`${stage.key} has an invalid send-back target.`)
    }
    for (const question of stage.questions ?? []) {
      if (!question.id.trim() || !question.question.trim()) errors.push(`${stage.key} has an incomplete question.`)
      for (const option of question.options ?? []) {
        if (!option.label.trim()) errors.push(`${stage.key} has an option without a label.`)
      }
    }
    for (const artifact of stage.expectedArtifacts ?? []) {
      if (!artifact.kind.trim() || !artifact.title.trim()) errors.push(`${stage.key} has an incomplete artifact definition.`)
    }
  }
  if (!config.outputs.finalPackKey.trim()) errors.push('Final output key is required.')
  return Array.from(new Set(errors))
}

function fallbackAgentForStage(config: WorkbenchConfig, stage: WorkbenchStage) {
  const role = normalizeAgentRoleInput(stage.agentRole)
  if (role.includes('DEV') || role === 'ENGINEER') return config.agentBindings.developerAgentTemplateId || config.agentBindings.architectAgentTemplateId || config.agentBindings.qaAgentTemplateId
  if (role.includes('QA') || role.includes('TEST') || role.includes('VERIFY')) return config.agentBindings.qaAgentTemplateId || config.agentBindings.developerAgentTemplateId || config.agentBindings.architectAgentTemplateId
  return config.agentBindings.architectAgentTemplateId || config.agentBindings.developerAgentTemplateId || config.agentBindings.qaAgentTemplateId
}

function miniButton(color: string): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    border: `1px solid ${color}33`, background: `${color}12`, color,
    borderRadius: 6, padding: '3px 7px', fontSize: 10,
    fontWeight: 700, cursor: 'pointer',
  }
}

function iconButton(disabled: boolean): React.CSSProperties {
  return {
    width: 28, height: 28, borderRadius: 7,
    border: '1px solid rgba(255,255,255,0.10)',
    background: disabled ? 'rgba(255,255,255,0.03)' : 'rgba(248,113,113,0.08)',
    color: disabled ? '#334155' : '#f87171',
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  }
}

function selectStyle(disabled: boolean): React.CSSProperties {
  return {
    width: '100%', boxSizing: 'border-box',
    background: disabled ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 8, padding: '6px 10px', fontSize: 11, color: '#e2e8f0',
    outline: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
  }
}

function checkLabel(): React.CSSProperties {
  return { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#94a3b8', fontWeight: 600 }
}

// ─── KV Tab ───────────────────────────────────────────────────────────────

function KVSection({
  title, pairs, onChange, accentColor,
}: {
  title: string
  pairs: KVPair[]
  onChange: (pairs: KVPair[]) => void
  accentColor: string
}) {
  const add = () => onChange([...pairs, emptyKV()])
  const update = (id: string, field: 'key' | 'value', v: string) =>
    onChange(pairs.map(p => p.id === id ? { ...p, [field]: v } : p))
  const remove = (id: string) => onChange(pairs.filter(p => p.id !== id))

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: accentColor }}>
          {title}
        </span>
        <button
          onClick={add}
          style={{
            display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px',
            borderRadius: 6, border: `1px solid ${accentColor}25`,
            background: `${accentColor}08`, color: accentColor,
            fontSize: 10, fontWeight: 600, cursor: 'pointer',
          }}
        >
          <Plus size={9} /> Add
        </button>
      </div>
      {pairs.length === 0 ? (
        <div style={{
          padding: '10px', borderRadius: 8, textAlign: 'center',
          border: `1px dashed ${accentColor}15`, background: `${accentColor}03`,
        }}>
          <p style={{ fontSize: 10, color: '#334155' }}>No entries — click Add to define a pair</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {pairs.map(pair => (
            <div key={pair.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 5, alignItems: 'center' }}>
              <NeoInput value={pair.key} onChange={v => update(pair.id, 'key', v)} placeholder="key" />
              <NeoInput value={pair.value} onChange={v => update(pair.id, 'value', v)} placeholder="value" />
              <button
                onClick={() => remove(pair.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: 4, display: 'flex' }}
                onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.color = '#f87171')}
                onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.color = '#475569')}
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Compensation Config section ─────────────────────────────────────────

function CompensationConfigSection({
  cfg, onChange,
}: {
  cfg: CompensationConfig | undefined
  onChange: (c: CompensationConfig | undefined) => void
}) {
  const enabled = !!cfg
  const current = cfg ?? { type: 'tool_request' as const }
  const accentColor = '#34d399'

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <RotateCcw size={11} style={{ color: accentColor }} />
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: accentColor }}>
            SAGA Compensation
          </span>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => onChange(e.target.checked ? { type: 'tool_request' } : undefined)}
            style={{ accentColor, width: 13, height: 13 }}
          />
          <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600 }}>Enable</span>
        </label>
      </div>

      {!enabled ? (
        <div style={{
          padding: '10px', borderRadius: 8, textAlign: 'center',
          border: `1px dashed ${accentColor}15`, background: `${accentColor}03`,
        }}>
          <p style={{ fontSize: 10, color: '#334155' }}>If the workflow fails, no compensation action will be taken for this node.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <FieldLabel>Compensation type</FieldLabel>
            <NeoSelect
              value={current.type}
              onChange={v => onChange({ ...current, type: v as CompensationConfig['type'] })}
              options={['tool_request', 'human_task']}
            />
          </div>
          {current.type === 'tool_request' ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <FieldLabel>Tool</FieldLabel>
                  <ToolPicker
                    value={current.toolId ?? ''}
                    onChange={v => onChange({ ...current, toolId: v || undefined })}
                  />
                </div>
                <div>
                  <FieldLabel>Action ID</FieldLabel>
                  <NeoInput value={current.actionId ?? ''} onChange={v => onChange({ ...current, actionId: v || undefined })} placeholder="uuid (optional)" />
                </div>
              </div>
              <div>
                <FieldLabel>Input payload (JSON)</FieldLabel>
                <NeoInput
                  value={current.inputPayload ?? ''}
                  onChange={v => onChange({ ...current, inputPayload: v || undefined })}
                  placeholder='{"key":"value"}'
                  multiline
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <FieldLabel>Assignee (email)</FieldLabel>
                <UserPicker
                  value={current.assignee ?? ''}
                  onChange={v => onChange({ ...current, assignee: v || undefined })}
                  emit="email"
                  placeholder="Select an assignee…"
                />
              </div>
              <div>
                <FieldLabel>Task description</FieldLabel>
                <NeoInput value={current.description ?? ''} onChange={v => onChange({ ...current, description: v || undefined })} placeholder="Manually undo the effects…" multiline />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Assignment Section (DIRECT_USER / TEAM / ROLE / SKILL / AGENT) ────────

type AssignmentMode = NonNullable<NodeConfig['assignmentMode']>

const ASSIGNMENT_MODES: Array<{ value: AssignmentMode; label: string; hint: string; color: string }> = [
  { value: 'DIRECT_USER', label: 'Direct user', hint: 'Pin to one specific person',                color: '#22c55e' },
  { value: 'TEAM_QUEUE',  label: 'Team queue',  hint: 'Anyone on the team can claim',              color: '#0ea5e9' },
  { value: 'ROLE_BASED',  label: 'Role',        hint: 'Anyone with this role on the capability',   color: '#a855f7' },
  { value: 'SKILL_BASED', label: 'Skill',       hint: 'Anyone whose skills include this key',      color: '#f97316' },
  { value: 'AGENT',       label: 'Agent',       hint: 'Hand off to an AI agent (no human queue)',  color: '#38bdf8' },
]

function NodeAssignmentSection({
  config, capabilityId, templateVariables = [], teamGlobals = [], onChange,
}: {
  config: NodeConfig
  capabilityId: string | null   // from the workflow template
  templateVariables?: Array<{ key: string; label?: string; type?: string; description?: string }>
  teamGlobals?:       Array<{ key: string; label?: string; type?: string; description?: string }>
  onChange: (next: NodeConfig) => void
}) {
  const mode = config.assignmentMode ?? 'DIRECT_USER'
  const setField = <K extends keyof NodeConfig>(k: K, v: NodeConfig[K]) =>
    onChange({ ...config, [k]: v })
  const setMode = (m: AssignmentMode) => {
    // Clear sub-fields that don't apply to the new mode.
    const next: NodeConfig = { ...config, assignmentMode: m }
    if (m !== 'DIRECT_USER') next.assignedToId = undefined
    if (m !== 'TEAM_QUEUE')  next.teamId       = undefined
    if (m !== 'ROLE_BASED')  next.roleKey      = undefined
    if (m !== 'SKILL_BASED') next.skillKey     = undefined
    onChange(next)
  }

  const inputSt: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '6px 9px',
    borderRadius: 6, fontSize: 11, color: '#cbd5e1',
    border: '1px solid rgba(255,255,255,0.08)',
    background: 'rgba(255,255,255,0.05)', outline: 'none',
    fontFamily: 'monospace',
  }
  const labelSt: React.CSSProperties = {
    fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
    color: '#64748b', display: 'block', marginBottom: 4,
  }

  // Per-mode field metadata
  const fieldMeta: Record<Exclude<AssignmentMode, 'AGENT'>, {
    label: string
    placeholder: string
    field: keyof NodeConfig
    examples: string[]
  }> = {
    DIRECT_USER: {
      label: 'Assignee identifier',
      placeholder: '{{vars.assigneeId}}',
      field: 'assignedToId',
      examples: ['{{vars.assigneeId}}', '{{globals.defaultApprover}}', '{{output.requesterId}}'],
    },
    TEAM_QUEUE: {
      label: 'Team identifier',
      placeholder: '{{vars.teamId}}',
      field: 'teamId',
      examples: ['{{vars.teamId}}', '{{globals.reviewerTeam}}'],
    },
    ROLE_BASED: {
      label: 'Role key',
      placeholder: '{{vars.requiredRole}}',
      field: 'roleKey',
      examples: ['{{vars.requiredRole}}', '{{globals.defaultRole}}', 'reviewer'],
    },
    SKILL_BASED: {
      label: 'Skill key',
      placeholder: '{{vars.requiredSkill}}',
      field: 'skillKey',
      examples: ['{{vars.requiredSkill}}', '{{globals.requiredSkill}}', 'react'],
    },
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <User size={11} style={{ color: '#22c55e' }} />
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#22c55e' }}>
          Assignment
        </span>
      </div>

      {/* Mode picker */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4, marginBottom: 9 }}>
        {ASSIGNMENT_MODES.map(m => (
          <button
            key={m.value}
            onClick={() => setMode(m.value)}
            title={m.hint}
            style={{
              padding: '6px 4px', borderRadius: 6, cursor: 'pointer',
              border: `1.5px solid ${mode === m.value ? m.color : 'rgba(255,255,255,0.08)'}`,
              background: mode === m.value ? `${m.color}1a` : 'transparent',
              color: mode === m.value ? m.color : '#64748b',
              fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
              textTransform: 'uppercase' as const,
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Mode hint */}
      <p style={{ fontSize: 10, color: '#94a3b8', marginBottom: 8, lineHeight: 1.5 }}>
        Pick the <strong style={{ color: '#cbd5e1' }}>kind</strong> of assignee at design time. The actual identity
        is resolved <strong style={{ color: '#cbd5e1' }}>at runtime</strong> from a workflow variable, team global,
        or upstream output.
      </p>

      {/* Single runtime-bound input + variable picker */}
      {mode !== 'AGENT' && (() => {
        const meta = fieldMeta[mode]
        const fieldKey = meta.field
        const value = (config[fieldKey] as string | undefined) ?? ''
        const setValue = (v: string | undefined) => setField(fieldKey, v as NodeConfig[typeof fieldKey])
        return (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={labelSt}>{meta.label}</span>
              <VariableInsertMenu
                templateVariables={templateVariables}
                teamGlobals={teamGlobals}
                onInsert={(path) => setValue(`{{${path}}}`)}
              />
            </div>
            <PickerOrText
              value={value}
              onChange={v => setValue(v || undefined)}
              placeholder={meta.placeholder}
              inputStyle={inputSt}
              picker={write =>
                  mode === 'DIRECT_USER' ? <UserPicker value={value} onChange={write} placeholder="Select a user…" />
                : mode === 'TEAM_QUEUE'  ? <TeamPicker value={value} onChange={write} placeholder="Select a team…" />
                : mode === 'ROLE_BASED'  ? <RolePicker value={value} onChange={write} placeholder="Select a role…" />
                : mode === 'SKILL_BASED' ? <SkillPicker value={value} onChange={write} placeholder="Select a skill…" />
                : <input value={value} onChange={e => write(e.target.value)} placeholder={meta.placeholder} style={inputSt} />
              }
            />
            <p style={{ fontSize: 9, color: '#64748b', marginTop: 5, lineHeight: 1.5 }}>
              Examples:{' '}
              {meta.examples.map((ex, i) => (
                <span key={ex}>
                  <code style={{ fontFamily: 'monospace', color: '#cbd5e1' }}>{ex}</code>
                  {i < meta.examples.length - 1 && ', '}
                </span>
              ))}
              .
            </p>
            {mode === 'ROLE_BASED' && (
              <p style={{ fontSize: 9, color: '#64748b', marginTop: 5, lineHeight: 1.5 }}>
                Eligibility resolves against capability{' '}
                <code style={{ fontFamily: 'monospace', color: '#cbd5e1' }}>{capabilityId ?? '(not set on workflow)'}</code>.
                {!capabilityId && (
                  <span style={{ color: '#fbbf24', fontWeight: 700 }}> Set a capability on the workflow first.</span>
                )}
              </p>
            )}
          </div>
        )
      })()}

      {mode === 'AGENT' && (
        <p style={{ fontSize: 10, color: '#64748b', fontStyle: 'italic', padding: '8px 10px', borderRadius: 6, border: '1px dashed rgba(255,255,255,0.08)' }}>
          Configure the agent below in the standard fields. The runtime won't enqueue this for human review.
        </p>
      )}
    </div>
  )
}

// ─── Variable insert menu ──────────────────────────────────────────────────
//
// Tiny dropdown that lists the workflow's available variable references — team
// globals (`globals.X`), template variables (`vars.X`), upstream outputs
// (`output.X`).  Clicking inserts the picked path into the parent input wrapped
// in `{{…}}`.
function VariableInsertMenu({
  templateVariables, teamGlobals, onInsert,
}: {
  templateVariables: Array<{ key: string; label?: string; type?: string }>
  teamGlobals:       Array<{ key: string; label?: string; type?: string }>
  onInsert:          (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          padding: '2px 8px', borderRadius: 4,
          background: 'rgba(34,197,94,0.18)', color: '#22c55e',
          border: 'none', cursor: 'pointer',
          fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
        }}
      >
        + Variable
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 30,
            minWidth: 220, maxHeight: 260, overflowY: 'auto',
            background: '#0b1220',
            border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8,
            boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
            padding: 6,
          }}
        >
          <VarGroup title="Team globals (globals.*)" items={teamGlobals} prefix="globals" onPick={(p) => { onInsert(p); setOpen(false) }} />
          <VarGroup title="Workflow variables (vars.*)" items={templateVariables} prefix="vars" onPick={(p) => { onInsert(p); setOpen(false) }} />
          <VarGroup title="Upstream output (output.*)" items={[
            { key: 'form', label: 'Form values from upstream node' },
            { key: 'attachments', label: 'Attachment IDs from upstream node' },
            { key: 'decision', label: 'Approval decision' },
          ]} prefix="output" onPick={(p) => { onInsert(p); setOpen(false) }} />
        </div>
      )}
    </div>
  )
}

function VarGroup({
  title, items, prefix, onPick,
}: {
  title: string
  items: Array<{ key: string; label?: string; type?: string }>
  prefix: string
  onPick: (path: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div style={{ marginBottom: 6 }}>
      <p style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#64748b', padding: '4px 6px' }}>
        {title}
      </p>
      {items.map(v => (
        <button
          key={`${prefix}.${v.key}`}
          onClick={() => onPick(`${prefix}.${v.key}`)}
          style={{
            display: 'block', width: '100%', textAlign: 'left',
            padding: '5px 8px', borderRadius: 5, border: 'none',
            background: 'transparent', color: '#cbd5e1', cursor: 'pointer',
            fontSize: 11,
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <code style={{ fontFamily: 'monospace', color: '#22c55e' }}>{prefix}.{v.key}</code>
          {v.label && <span style={{ color: '#64748b', marginLeft: 8, fontSize: 10 }}>{v.label}</span>}
        </button>
      ))}
    </div>
  )
}

// ─── Node Form Builder (widget-based) ─────────────────────────────────────
//
// Flat list of widgets — one widget = one input.  Designer composes the form
// in the left rail; selected widget's properties (label, key, required, type-
// specific config) edit on the right.  The assignee fills the form at
// runtime when they mark the work complete.

function NodeFormBuilder({
  widgets, onChange, accentColor = '#38bdf8', label = 'Runtime Form',
}: {
  widgets:     FormWidget[] | undefined
  onChange:    (w: FormWidget[] | undefined) => void
  accentColor?: string
  label?:      string
}) {
  const enabled = Array.isArray(widgets)
  const list    = widgets ?? []
  const [selectedId, setSelectedId] = useState<string | null>(list[0]?.id ?? null)

  // Keep selected within the widget list when it changes externally
  useEffect(() => {
    if (selectedId && list.find(w => w.id === selectedId)) return
    setSelectedId(list[0]?.id ?? null)
  }, [list.length])

  const selected = list.find(w => w.id === selectedId) ?? null

  const updateSelected = (next: FormWidget) => {
    onChange(list.map(w => w.id === next.id ? next : w))
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <FileCode size={11} style={{ color: accentColor }} />
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: accentColor }}>
            {label}
          </span>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => onChange(e.target.checked ? [] : undefined)}
            style={{ accentColor, width: 13, height: 13 }}
          />
          <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600 }}>Enable</span>
        </label>
      </div>

      {!enabled ? (
        <div style={{
          padding: '10px', borderRadius: 8, textAlign: 'center',
          border: `1px dashed ${accentColor}25`, background: `${accentColor}05`,
        }}>
          <p style={{ fontSize: 10, color: '#94a3b8' }}>
            No form. Enable to compose a form from widgets — text, number, date, select, signature, file upload, and more.
            Each widget is one input. Mark widgets as required or optional. Filled at runtime when the assignee marks the work complete.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          {/* Left: widget list + add picker */}
          <div style={{ width: 220, flexShrink: 0, padding: 10, borderRadius: 9, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <WidgetListEditor
              widgets={list}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onChange={onChange}
              density="compact"
            />
          </div>

          {/* Right: edit selected widget */}
          <div style={{ flex: 1, minWidth: 0, padding: 12, borderRadius: 9, background: '#fff', border: '1px solid var(--color-outline-variant)' }}>
            {selected
              ? <WidgetEditor widget={selected} onChange={updateSelected} />
              : <p style={{ fontSize: 11, color: 'var(--color-outline)', fontStyle: 'italic', textAlign: 'center', padding: '20px 8px' }}>
                  Add a widget on the left to start building the form, or select an existing one to edit.
                </p>}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Runtime Form section (live fill panel for ACTIVE nodes) ─────────────────

type RuntimeKind = 'task' | 'approval' | 'consumable'

function resolveRuntimeKind(nodeType: string, customBaseType?: string): RuntimeKind | null {
  const t = nodeType === 'CUSTOM' ? customBaseType : nodeType
  if (t === 'HUMAN_TASK')          return 'task'
  if (t === 'APPROVAL')            return 'approval'
  if (t === 'CONSUMABLE_CREATION') return 'consumable'
  return null
}

function RuntimeFormSection({
  nodeId, nodeStatus, instanceId, widgets, kind, accentColor,
}: {
  nodeId: string
  nodeStatus: string
  instanceId?: string
  widgets: FormWidget[]
  kind: RuntimeKind
  accentColor: string
}) {
  // Pull the runtime entity (task / approval / consumable) by nodeId
  const path =
    kind === 'task'      ? '/tasks' :
    kind === 'approval'  ? '/approvals' :
                           '/consumables'

  const { data, isLoading, refetch } = useQuery<{ data?: any[] } | any[]>({
    queryKey: ['runtime-entity', kind, nodeId, instanceId ?? null],
    enabled: !!nodeId && !!instanceId,
    queryFn: async () => {
      const r = await api.get(path, { params: { nodeId, instanceId } })
      return r.data
    },
  })

  // Both paginated and array shapes appear in this codebase; normalise:
  const entity = (() => {
    if (!data) return null
    if (Array.isArray(data)) return data[0] ?? null
    if (Array.isArray((data as any).data)) return (data as any).data[0] ?? null
    return null
  })() as { id: string; formData?: Record<string, unknown>; attachments?: UploadedDocument[] } | null

  const submitTo: RuntimeFormSubmitTarget | null = entity
    ? { kind, id: entity.id }
    : null

  // ── Render states ────────────────────────────────────────────────────────
  return (
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <FileCode size={11} style={{ color: accentColor }} />
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: accentColor }}>
          Runtime form fill
        </span>
        {entity && (
          <span style={{ marginLeft: 'auto', fontSize: 9, color: '#94a3b8', fontFamily: 'monospace' }}>
            {kind} · {entity.id.slice(0, 8)}
          </span>
        )}
      </div>

      {!instanceId ? (
        <p style={{ fontSize: 10, color: '#94a3b8', fontStyle: 'italic' }}>
          Workflow instance unknown — open the node from a running instance to fill the form.
        </p>
      ) : nodeStatus !== 'ACTIVE' && nodeStatus !== 'COMPLETED' ? (
        <p style={{ fontSize: 10, color: '#94a3b8', fontStyle: 'italic' }}>
          The runtime form becomes fillable once this node activates (current status: {nodeStatus.toLowerCase()}).
        </p>
      ) : isLoading ? (
        <p style={{ fontSize: 10, color: '#94a3b8' }}>Looking up {kind}…</p>
      ) : !submitTo ? (
        <p style={{ fontSize: 10, color: '#94a3b8', fontStyle: 'italic' }}>
          No {kind} record found for this node yet.
        </p>
      ) : (
        <div style={{ background: '#fafafa', padding: 14, borderRadius: 10, border: '1px solid var(--color-outline-variant)' }}>
          <RuntimeWidgetForm
            widgets={widgets}
            submitTo={submitTo}
            link={{ taskId: kind === 'task' ? submitTo.id : undefined, nodeId, instanceId }}
            initialData={(entity?.formData as Record<string, unknown>) ?? {}}
            initialAttachments={Array.isArray(entity?.attachments) ? entity.attachments : []}
            canComplete={nodeStatus === 'ACTIVE'}
            onSubmitted={() => refetch()}
          />
        </div>
      )}
    </div>
  )
}

// ─── Registry pickers (Agent / Tool) ────────────────────────────────────

function RegistryHint({ source }: { source: 'internal' | 'external' }) {
  return (
    <span style={{
      fontSize: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
      padding: '1px 5px', borderRadius: 4, marginLeft: 6,
      background: source === 'external' ? 'rgba(99,102,241,0.14)' : 'rgba(148,163,184,0.14)',
      color: source === 'external' ? '#6366f1' : '#94a3b8',
    }}>
      {source === 'external' ? 'External' : 'Internal'}
    </span>
  )
}

// M23 — Studio-aware picker. When a capabilityId is set, fetches the grouped
// {common, capability} shape from the workgraph facade and renders two
// optgroups (Capability Agents first, then Common Library) with inline badges.
// Falls back to a flat fetchAgents call when no capability is selected.
function AgentPicker({ value, onChange, capabilityId }: { value: string; onChange: (v: string) => void; capabilityId?: string | null }) {
  const qc = useQueryClient()
  const [deriveError, setDeriveError] = useState<string | null>(null)
  const { data: studio, isLoading, isError } = useQuery({
    queryKey: ['agent-studio', capabilityId ?? 'none'],
    enabled: Boolean(capabilityId),
    queryFn: () => fetchStudioAgents(capabilityId as string),
    staleTime: 30_000,
  })
  const flat = useQuery({
    queryKey: ['registry', 'agents', 'flat'],
    enabled: !capabilityId,
    queryFn: () => fetchAgents(undefined),
    staleTime: 30_000,
  })

  const capabilityAgents: RegistryAgent[] = studio?.capability ?? []
  const commonAgents:     RegistryAgent[] = studio?.common ?? (flat.data ?? [])
  const allForLookup = [...capabilityAgents, ...commonAgents]
  const selected = allForLookup.find(a => a.id === value)

  const empty = isLoading || flat.isLoading
    ? 'Loading agents…'
    : isError || flat.isError
      ? 'Failed to load agents'
      : (capabilityAgents.length + commonAgents.length) === 0
        ? 'No agents available'
        : 'Select an agent…'

  async function deriveSelected() {
    if (!capabilityId || !selected) return
    setDeriveError(null)
    try {
      const created = await deriveStudioAgent(capabilityId, selected.id, { name: `${selected.name} (cap)` })
      await qc.invalidateQueries({ queryKey: ['agent-studio', capabilityId] })
      onChange(created.id)
    } catch (err) {
      const message = err && typeof err === 'object' && 'response' in err
        ? ((err as { response?: { data?: { message?: string; code?: string } } }).response?.data?.message
            ?? (err as { response?: { data?: { code?: string } } }).response?.data?.code)
        : (err as Error).message
      setDeriveError(message ?? 'Could not derive this agent template.')
    }
  }

  const showDerive = Boolean(capabilityId && selected && selected.scope === 'common')

  return (
    <div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          width: '100%', boxSizing: 'border-box',
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 8, padding: '6px 10px', fontSize: 11, color: '#e2e8f0',
          outline: 'none', appearance: 'none', cursor: 'pointer',
        }}
      >
        <option value="" style={{ background: '#0f172a' }}>{empty}</option>
        {capabilityAgents.length > 0 && (
          <optgroup label="Capability Agents" style={{ background: '#0f172a' }}>
            {capabilityAgents.map(a => (
              <option key={a.id} value={a.id} style={{ background: '#0f172a' }}>
                {a.name}{a.baseTemplateId ? ' [Derived]' : ' [Custom]'}{a.model ? ` · ${a.model}` : ''}
              </option>
            ))}
          </optgroup>
        )}
        {commonAgents.length > 0 && (
          <optgroup label="Common Library (locked)" style={{ background: '#0f172a' }}>
            {commonAgents.map(a => (
              <option key={a.id} value={a.id} style={{ background: '#0f172a' }}>
                {a.name} [Locked]{a.model ? ` · ${a.model}` : ''}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <div style={{ fontSize: 9, color: '#475569', marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        Source: <RegistryHint source={registrySource.agents} />
        {selected && (
          <>
            <AgentBadge selected={selected} />
            {showDerive && (
              <button
                onClick={deriveSelected}
                style={{
                  fontSize: 9, padding: '2px 6px', borderRadius: 4, cursor: 'pointer',
                  background: 'rgba(99,102,241,0.18)', color: '#a5b4fc',
                  border: '1px solid rgba(99,102,241,0.32)',
                }}
                title="Create a capability-scoped child of this common template and select it."
              >
                Derive into this capability →
              </button>
            )}
          </>
        )}
        {selected?.description && (
          <span style={{ marginLeft: 4, fontStyle: 'italic', flexBasis: '100%' }}>{selected.description}</span>
        )}
        {deriveError && (
          <span style={{ color: '#f87171', flexBasis: '100%' }}>
            Derive failed: {deriveError}
          </span>
        )}
      </div>
    </div>
  )
}

function AgentBadge({ selected }: { selected: RegistryAgent }) {
  const isCommon = selected.scope === 'common' || (!selected.capabilityId && selected.lockedReason)
  const isDerived = selected.scope === 'capability' && Boolean(selected.baseTemplateId)
  const noProfile = !selected.basePromptProfileId
  const dot = (color: string, bg: string, label: string) => (
    <span style={{
      fontSize: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
      padding: '1px 5px', borderRadius: 4, background: bg, color,
    }}>{label}</span>
  )
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {isCommon  && dot('#f59e0b', 'rgba(245,158,11,0.16)', 'Locked')}
      {isDerived && dot('#60a5fa', 'rgba(96,165,250,0.16)', 'Derived')}
      {!isCommon && !isDerived && selected.capabilityId && dot('#34d399', 'rgba(52,211,153,0.16)', 'Custom')}
      {noProfile && dot('#f87171', 'rgba(248,113,113,0.16)', 'No profile')}
    </span>
  )
}

// M10 — capability picker (federated /api/lookup/capabilities).
function CapabilityPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const memberships = useActiveContextStore(s => s.memberships)
  const active = useActiveContextStore(s => s.active)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['registry', 'capabilities'],
    queryFn: () => fetchCapabilities(),
    staleTime: 30_000,
  })
  const all = data ?? []
  // If the user has memberships, filter to capabilities they belong to.
  // Otherwise (admin without explicit memberships, dev mode) show everything.
  const allowedIds = new Set(memberships.map(m => m.capability_id))
  const caps = memberships.length > 0 ? all.filter(c => allowedIds.has(c.id)) : all
  // Auto-default to active capability when nothing is set yet.
  useEffect(() => {
    if (!value && active?.capabilityId && caps.some(c => c.id === active.capabilityId)) {
      onChange(active.capabilityId)
    }
  }, [value, active?.capabilityId, caps, onChange])
  const selected = caps.find(c => c.id === value)
  return (
    <div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          width: '100%', boxSizing: 'border-box',
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 8, padding: '6px 10px', fontSize: 11, color: '#e2e8f0',
          outline: 'none', appearance: 'none', cursor: 'pointer',
        }}
      >
        <option value="" style={{ background: '#0f172a' }}>
          {isLoading ? 'Loading capabilities…' : isError ? 'Failed to load' : caps.length === 0 ? 'No capabilities' : 'Select a capability…'}
        </option>
        {caps.map(c => (
          <option key={c.id} value={c.id} style={{ background: '#0f172a' }}>
            {c.name}{c.capability_type ? ` · ${c.capability_type}` : ''}
          </option>
        ))}
      </select>
      <p style={{ fontSize: 9, color: '#475569', marginTop: 4 }}>
        Federated from IAM. {selected?.status ? `Status: ${selected.status}.` : ''}
      </p>
    </div>
  )
}

function ToolPicker({ value, onChange, capabilityId }: { value: string; onChange: (v: string) => void; capabilityId?: string | null }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['registry', 'tools', capabilityId ?? 'all'],
    queryFn: () => fetchTools(capabilityId ?? undefined),
    staleTime: 30_000,
  })
  const tools = data ?? []
  const selected = tools.find(t => t.name === value || t.id === value)

  return (
    <div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          width: '100%', boxSizing: 'border-box',
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 8, padding: '6px 10px', fontSize: 11, color: '#e2e8f0',
          outline: 'none', appearance: 'none', cursor: 'pointer',
        }}
      >
        <option value="" style={{ background: '#0f172a' }}>
          {isLoading ? 'Loading tools…' : isError ? 'Failed to load tools' : tools.length === 0 ? 'No tools available' : 'Select a tool…'}
        </option>
        {tools.map(t => (
          <option key={t.id} value={t.name} style={{ background: '#0f172a' }}>
            {t.name}{t.riskLevel ? ` · ${t.riskLevel}` : ''}
          </option>
        ))}
      </select>
      <p style={{ fontSize: 9, color: '#475569', marginTop: 4, display: 'flex', alignItems: 'center' }}>
        Source: <RegistryHint source={registrySource.tools} />
        {selected?.description && (
          <span style={{ marginLeft: 8, fontStyle: 'italic' }}>{selected.description}</span>
        )}
      </p>
    </div>
  )
}

// ─── Execution location section ─────────────────────────────────────────

const EXEC_LOCATIONS = ['SERVER', 'CLIENT', 'EDGE', 'EXTERNAL'] as const
const EXEC_LOC_META: Record<string, { label: string; desc: string; color: string }> = {
  SERVER:   { label: 'Server',   desc: 'Runs in the WorkGraph API process.',                        color: '#22c55e' },
  CLIENT:   { label: 'Client',   desc: 'Claimed and executed by the browser/desktop SDK. (default)', color: '#38bdf8' },
  EDGE:     { label: 'Edge',     desc: 'Claimed by an edge node or on-premise agent.',              color: '#fb923c' },
  EXTERNAL: { label: 'External', desc: 'Delegated to an external system via PendingExecution poll.', color: '#a78bfa' },
}

// ─── Template picker (CALL_WORKFLOW) ────────────────────────────────────────

function TemplatePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['workflow-templates'],
    queryFn: () => api.get('/workflow-templates').then(r => {
      const d = r.data
      return (Array.isArray(d) ? d : (d?.content ?? [])) as { id: string; name: string; currentVersion: number; archivedAt?: string | null }[]
    }),
    staleTime: 30_000,
  })
  const templates = (data ?? []).filter(t => !t.archivedAt)
  const selected = templates.find(t => t.id === value)

  return (
    <div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          width: '100%', boxSizing: 'border-box',
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 8, padding: '6px 10px', fontSize: 11, color: '#e2e8f0',
          outline: 'none', appearance: 'none', cursor: 'pointer',
        }}
      >
        <option value="" style={{ background: '#0f172a' }}>
          {isLoading ? 'Loading workflows…' : isError ? 'Failed to load workflows' : templates.length === 0 ? 'No workflows available' : 'Select a workflow…'}
        </option>
        {templates.map(t => (
          <option key={t.id} value={t.id} style={{ background: '#0f172a' }}>
            {t.name} · v{t.currentVersion}
          </option>
        ))}
      </select>
      {selected && (
        <p style={{ fontSize: 9, color: '#475569', marginTop: 4 }}>
          ID: <span style={{ fontFamily: 'monospace', color: '#64748b' }}>{selected.id.slice(0, 8)}…</span>
        </p>
      )}
    </div>
  )
}

function WorkItemTargetsEditor({
  targets,
  onChange,
}: {
  targets: WorkItemTargetConfig[]
  onChange: (targets: WorkItemTargetConfig[]) => void
}) {
  const rows = targets.length > 0 ? targets : []
  const update = (id: string, patch: Partial<WorkItemTargetConfig>) => {
    onChange(rows.map(row => row.id === id ? { ...row, ...patch } : row))
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((target, index) => (
        <div key={target.id} style={{
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 10,
          padding: 10,
          background: 'rgba(255,255,255,0.035)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 10, color: '#c4b5fd', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              Target {index + 1}
            </span>
            <button
              onClick={() => onChange(rows.filter(row => row.id !== target.id))}
              style={{
                border: '1px solid rgba(248,113,113,0.24)',
                background: 'rgba(248,113,113,0.08)',
                color: '#fecaca',
                borderRadius: 7,
                padding: '4px 7px',
                cursor: 'pointer',
                fontSize: 10,
                fontWeight: 800,
              }}
            >
              Remove
            </button>
          </div>

          <FieldLabel>Target capability</FieldLabel>
          <CapabilityPicker
            value={target.targetCapabilityId}
            onChange={value => update(target.id, { targetCapabilityId: value })}
          />

          <FieldLabel>Child workflow</FieldLabel>
          <TemplatePicker
            value={target.childWorkflowTemplateId}
            onChange={value => update(target.id, { childWorkflowTemplateId: value })}
          />

          <FieldLabel>Role key</FieldLabel>
          <NeoInput
            value={target.roleKey}
            onChange={value => update(target.id, { roleKey: value })}
            placeholder="owner | developer | verifier"
          />
        </div>
      ))}

      <button
        onClick={() => onChange([...rows, emptyWorkItemTarget()])}
        style={{
          border: '1px dashed rgba(124,58,237,0.55)',
          background: 'rgba(124,58,237,0.10)',
          color: '#ddd6fe',
          borderRadius: 10,
          padding: '8px 10px',
          cursor: 'pointer',
          fontSize: 11,
          fontWeight: 800,
        }}
      >
        + Add child capability target
      </button>
    </div>
  )
}

// ─── Execution location section ─────────────────────────────────────────

function ExecutionLocationSection({
  location, onChange,
}: {
  location: string | undefined
  onChange: (loc: string) => void
}) {
  const current = location ?? 'CLIENT'
  const accentColor = '#06b6d4'
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <Cpu size={11} style={{ color: accentColor }} />
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: accentColor }}>
          Execution location
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {EXEC_LOCATIONS.map(loc => {
          const m = EXEC_LOC_META[loc]
          const active = current === loc
          return (
            <button
              key={loc}
              onClick={() => onChange(loc)}
              style={{
                padding: '8px 10px', borderRadius: 8, border: `1px solid ${active ? m.color : 'rgba(255,255,255,0.08)'}`,
                background: active ? `${m.color}14` : 'rgba(255,255,255,0.03)',
                cursor: 'pointer', textAlign: 'left', transition: 'all 0.12s',
              }}
            >
              <p style={{ fontSize: 10, fontWeight: 700, color: active ? m.color : '#94a3b8', marginBottom: 2 }}>{m.label}</p>
              <p style={{ fontSize: 9, color: '#475569', lineHeight: 1.4 }}>{m.desc}</p>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─── Data sink config section ────────────────────────────────────────────

function SinkConfigSection({
  cfg, onChange,
}: {
  cfg: SinkConfig | undefined
  onChange: (c: SinkConfig) => void
}) {
  const current: SinkConfig = cfg ?? { kind: 'CONNECTOR' }
  const accentColor = '#0ea5e9'

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <Database size={11} style={{ color: accentColor }} />
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: accentColor }}>
          Sink configuration
        </span>
      </div>

      <div style={{ marginBottom: 10 }}>
        <FieldLabel>Kind</FieldLabel>
        <NeoSelect
          value={current.kind}
          onChange={v => onChange({ kind: v as SinkConfig['kind'] })}
          options={['CONNECTOR', 'DB_EVENT', 'ARTIFACT']}
        />
      </div>

      {current.kind === 'CONNECTOR' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <FieldLabel>Connector</FieldLabel>
            <ConnectorPicker
              value={current.connectorId ?? ''}
              onChange={v => onChange({ ...current, connectorId: v })}
              placeholder="Select a connector…"
            />
          </div>
          <div>
            <FieldLabel>Operation</FieldLabel>
            <NeoInput value={current.operation ?? ''} onChange={v => onChange({ ...current, operation: v })} placeholder="sendMessage / putObject / createIssue…" />
          </div>
          <div>
            <FieldLabel>Param mapping</FieldLabel>
            <KVSection
              title=""
              pairs={Object.entries(current.paramMap ?? {}).map(([k, v]) => ({ id: k, key: k, value: v }))}
              onChange={pairs => onChange({ ...current, paramMap: Object.fromEntries(pairs.map(p => [p.key, p.value])) })}
              accentColor={accentColor}
            />
            <p style={{ fontSize: 9, color: '#64748b', marginTop: -4 }}>
              Key = param name · Value = context path (e.g. context.summary)
            </p>
          </div>
        </div>
      )}

      {current.kind === 'DB_EVENT' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <FieldLabel>Body path (context path)</FieldLabel>
            <NeoInput
              value={current.bodyPath ?? ''}
              onChange={v => onChange({ ...current, bodyPath: v })}
              placeholder="context (for entire context) or context.payload"
            />
          </div>
        </div>
      )}

      {current.kind === 'ARTIFACT' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <FieldLabel>Artifact type</FieldLabel>
            <NeoInput value={current.artifactType ?? ''} onChange={v => onChange({ ...current, artifactType: v })} placeholder="ReportOutput" />
          </div>
          <div>
            <FieldLabel>Name path (context path for artifact name)</FieldLabel>
            <NeoInput value={current.namePath ?? ''} onChange={v => onChange({ ...current, namePath: v })} placeholder="context.reportTitle (uses node label if empty)" />
          </div>
          <div>
            <FieldLabel>Body path (context path for artifact content)</FieldLabel>
            <NeoInput value={current.bodyPath ?? ''} onChange={v => onChange({ ...current, bodyPath: v })} placeholder="context.reportMarkdown (uses entire context if empty)" />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Retry policy section ────────────────────────────────────────────────

function RetryPolicySection({
  policy, onChange,
}: {
  policy: RetryPolicy | undefined
  onChange: (p: RetryPolicy | undefined) => void
}) {
  const enabled = !!policy
  const current = policy ?? { maxAttempts: 1, initialIntervalMs: 1000, backoffCoefficient: 2, nonRetryableErrors: [] }
  const accentColor = '#f87171'

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: accentColor }}>
          Error handling
        </span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => onChange(e.target.checked
              ? { maxAttempts: 3, initialIntervalMs: 1000, backoffCoefficient: 2, nonRetryableErrors: [] }
              : undefined)}
            style={{ accentColor, width: 13, height: 13 }}
          />
          <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600 }}>Enable retries</span>
        </label>
      </div>

      {!enabled ? (
        <div style={{
          padding: '10px', borderRadius: 8, textAlign: 'center',
          border: `1px dashed ${accentColor}15`, background: `${accentColor}03`,
        }}>
          <p style={{ fontSize: 10, color: '#334155' }}>Node fails immediately on error. Add ERROR_BOUNDARY edges to route to a recovery handler.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <FieldLabel>Max attempts</FieldLabel>
              <NeoInput
                value={String(current.maxAttempts)}
                onChange={v => {
                  const n = parseInt(v, 10)
                  onChange({ ...current, maxAttempts: Number.isFinite(n) && n > 0 ? n : 1 })
                }}
                placeholder="3"
              />
            </div>
            <div>
              <FieldLabel>Initial interval (ms)</FieldLabel>
              <NeoInput
                value={String(current.initialIntervalMs)}
                onChange={v => {
                  const n = parseInt(v, 10)
                  onChange({ ...current, initialIntervalMs: Number.isFinite(n) && n >= 0 ? n : 0 })
                }}
                placeholder="1000"
              />
            </div>
          </div>
          <div>
            <FieldLabel>Backoff coefficient</FieldLabel>
            <NeoInput
              value={String(current.backoffCoefficient)}
              onChange={v => {
                const n = parseFloat(v)
                onChange({ ...current, backoffCoefficient: Number.isFinite(n) && n >= 1 ? n : 1 })
              }}
              placeholder="2"
            />
          </div>
          <div>
            <FieldLabel>Non-retryable errors (comma-separated codes)</FieldLabel>
            <NeoInput
              value={current.nonRetryableErrors.join(', ')}
              onChange={v => onChange({
                ...current,
                nonRetryableErrors: v.split(',').map(s => s.trim()).filter(Boolean),
              })}
              placeholder="VALIDATION_ERROR, NOT_FOUND"
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Attachment type / trigger helpers ───────────────────────────────────────

const TRIGGER_META: Record<string, { label: string; color: string }> = {
  on_activate:  { label: 'On activate',  color: '#22c55e' },
  on_complete:  { label: 'On complete',  color: '#4ade80' },
  on_fail:      { label: 'On fail',      color: '#f87171' },
  deadline:     { label: 'Deadline',     color: '#fbbf24' },
}

const ATTACH_TYPE_META: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  timer:        { label: 'Timer',        color: '#fbbf24', icon: Clock },
  tool:         { label: 'Tool',         color: '#fb923c', icon: Wrench },
  notification: { label: 'Notify',       color: '#38bdf8', icon: Radio },
}

function AttachmentCard({
  att, onChange, onDelete,
}: {
  att: Attachment
  onChange: (a: Attachment) => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const tm = TRIGGER_META[att.trigger] ?? { label: att.trigger, color: '#64748b' }
  const am = ATTACH_TYPE_META[att.type] ?? { label: att.type, color: '#64748b', icon: Wrench }
  const { icon: AttIcon } = am

  return (
    <div style={{
      borderRadius: 10, border: `1px solid ${am.color}20`,
      background: `${am.color}06`, marginBottom: 6, overflow: 'hidden',
      opacity: att.enabled ? 1 : 0.5,
    }}>
      {/* Header */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px', cursor: 'pointer' }}
        onClick={() => setOpen(o => !o)}
      >
        <div style={{
          width: 22, height: 22, borderRadius: 6, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${am.color}15`, border: `1px solid ${am.color}25`,
        }}>
          <AttIcon size={10} style={{ color: am.color }} />
        </div>
        <span style={{
          fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
          padding: '2px 6px', borderRadius: 4,
          background: `${tm.color}15`, color: tm.color,
        }}>
          {tm.label}
        </span>
        <span style={{ flex: 1, fontSize: 11, color: '#94a3b8', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {att.label || (att.type === 'tool' ? (att.toolName ?? 'Unnamed tool') : att.type === 'timer' ? (att.durationMs ? `${Math.round(att.durationMs / 60000)}m` : 'No duration set') : (att.channel ?? 'No channel'))}
        </span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={att.enabled}
            onChange={e => onChange({ ...att, enabled: e.target.checked })}
            style={{ accentColor: am.color, width: 11, height: 11 }}
          />
        </label>
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: 2, display: 'flex' }}
          onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.color = '#f87171')}
          onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.color = '#475569')}
        >
          <Trash2 size={11} />
        </button>
        {open ? <ChevronDown size={11} style={{ color: '#475569' }} /> : <ChevronRight size={11} style={{ color: '#475569' }} />}
      </div>

      {/* Expanded */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{ padding: '0 10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ height: 1, background: `${am.color}15`, marginBottom: 2 }} />

              {/* Common fields */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <FieldLabel>Type</FieldLabel>
                  <NeoSelect
                    value={att.type}
                    onChange={v => onChange({ ...att, type: v as Attachment['type'] })}
                    options={['timer', 'tool', 'notification']}
                  />
                </div>
                <div>
                  <FieldLabel>Trigger</FieldLabel>
                  <NeoSelect
                    value={att.trigger}
                    onChange={v => onChange({ ...att, trigger: v as Attachment['trigger'] })}
                    options={['on_activate', 'on_complete', 'on_fail', 'deadline']}
                  />
                </div>
              </div>

              <div>
                <FieldLabel>Label (optional)</FieldLabel>
                <NeoInput
                  value={att.label ?? ''}
                  onChange={v => onChange({ ...att, label: v || undefined })}
                  placeholder="e.g. Notify Slack on completion"
                />
              </div>

              {/* Timer / deadline fields */}
              {(att.type === 'timer' || att.trigger === 'deadline') && (
                <>
                  <div>
                    <FieldLabel>Duration (ms)</FieldLabel>
                    <NeoInput
                      value={att.durationMs !== undefined ? String(att.durationMs) : ''}
                      onChange={v => {
                        const n = parseInt(v, 10)
                        onChange({ ...att, durationMs: Number.isFinite(n) && n > 0 ? n : undefined })
                      }}
                      placeholder="e.g. 259200000 (3 days)"
                    />
                  </div>
                  {att.trigger === 'deadline' && (
                    <div>
                      <FieldLabel>Edge label to follow on deadline</FieldLabel>
                      <NeoInput
                        value={att.deadlineEdge ?? ''}
                        onChange={v => onChange({ ...att, deadlineEdge: v || undefined })}
                        placeholder="escalate (must match an edge label)"
                      />
                    </div>
                  )}
                </>
              )}

              {/* Tool fields */}
              {att.type === 'tool' && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div>
                      <FieldLabel>Tool name</FieldLabel>
                      <NeoInput
                        value={att.toolName ?? ''}
                        onChange={v => onChange({ ...att, toolName: v || undefined })}
                        placeholder="slack-notify"
                      />
                    </div>
                    <div>
                      <FieldLabel>Action name</FieldLabel>
                      <NeoInput
                        value={att.actionName ?? ''}
                        onChange={v => onChange({ ...att, actionName: v || undefined })}
                        placeholder="send"
                      />
                    </div>
                  </div>
                  <div>
                    <FieldLabel>Input payload (JSON)</FieldLabel>
                    <NeoInput
                      value={att.inputPayload ?? ''}
                      onChange={v => onChange({ ...att, inputPayload: v || undefined })}
                      placeholder='{"channel":"#ops","text":"Node activated"}'
                      multiline
                    />
                  </div>
                </>
              )}

              {/* Notification fields */}
              {att.type === 'notification' && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div>
                      <FieldLabel>Channel</FieldLabel>
                      <NeoSelect
                        value={att.channel ?? 'email'}
                        onChange={v => onChange({ ...att, channel: v as Attachment['channel'] })}
                        options={['email', 'slack', 'webhook']}
                      />
                    </div>
                    <div>
                      <FieldLabel>Recipient / URL</FieldLabel>
                      <NeoInput
                        value={att.recipient ?? ''}
                        onChange={v => onChange({ ...att, recipient: v || undefined })}
                        placeholder="user@example.com"
                      />
                    </div>
                  </div>
                  <div>
                    <FieldLabel>Message</FieldLabel>
                    <NeoInput
                      value={att.message ?? ''}
                      onChange={v => onChange({ ...att, message: v || undefined })}
                      placeholder="Workflow step completed: {{nodeLabel}}"
                      multiline
                    />
                  </div>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function AttachmentsTab({
  config, onChange,
}: { config: NodeConfig; onChange: (c: NodeConfig) => void }) {
  const attachments = config.attachments ?? []

  const add = () => onChange({ ...config, attachments: [...attachments, emptyAttachment()] })
  const update = (id: string, a: Attachment) =>
    onChange({ ...config, attachments: attachments.map(x => x.id === id ? a : x) })
  const remove = (id: string) =>
    onChange({ ...config, attachments: attachments.filter(x => x.id !== id) })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{
        padding: '8px 10px', borderRadius: 8,
        background: 'rgba(251,146,60,0.05)', border: '1px solid rgba(251,146,60,0.12)',
      }}>
        <p style={{ fontSize: 10, color: '#64748b', lineHeight: 1.6 }}>
          Attachments fire at node lifecycle events — without adding extra nodes to the canvas. Tools and notifications run as side-effects; deadline timers advance the node automatically if it hasn't completed in time.
        </p>
      </div>

      {attachments.length === 0 ? (
        <div style={{
          padding: '20px 10px', borderRadius: 10, textAlign: 'center',
          border: '1px dashed rgba(251,146,60,0.15)', background: 'rgba(251,146,60,0.03)',
        }}>
          <Wrench size={18} style={{ color: 'rgba(251,146,60,0.4)', marginBottom: 8 }} />
          <p style={{ fontSize: 11, color: '#475569', marginBottom: 4, fontWeight: 600 }}>No attachments</p>
          <p style={{ fontSize: 10, color: '#334155', lineHeight: 1.5 }}>
            Attach tools, timers, or notifications that fire at node lifecycle events.
          </p>
        </div>
      ) : (
        attachments.map(att => (
          <AttachmentCard
            key={att.id}
            att={att}
            onChange={updated => update(att.id, updated)}
            onDelete={() => remove(att.id)}
          />
        ))
      )}

      <button
        onClick={add}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: '7px', borderRadius: 8, cursor: 'pointer',
          border: '1px dashed rgba(251,146,60,0.25)',
          background: 'rgba(251,146,60,0.05)', color: '#fb923c',
          fontSize: 11, fontWeight: 600, transition: 'all 0.12s',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(251,146,60,0.1)' }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(251,146,60,0.05)' }}
      >
        <Plus size={11} /> Add attachment
      </button>
    </div>
  )
}

// ─── BranchesTab ──────────────────────────────────────────────────────────────

function emptyCondition(): BranchCondition {
  return { id: uid(), left: '', op: '==', right: '' }
}

function BranchRow({
  edge, workflowParams, canMoveUp, canMoveDown,
  onChange, onDelete, onMove, onSetDefault, onTest,
}: {
  edge: OutgoingEdgeBranch
  workflowParams: ParamDef[]
  canMoveUp: boolean
  canMoveDown: boolean
  onChange: (edgeId: string, branch: Branch) => void
  onDelete: (edgeId: string) => void
  onMove: (edgeId: string, dir: -1 | 1) => void
  onSetDefault: (edgeId: string, isDefault: boolean) => void
  onTest:    (edgeId: string) => void
}) {
  function parseBranch(cond: Branch | null | undefined): Branch {
    if (cond && typeof cond === 'object' && Array.isArray(cond.conditions)) return cond
    return { logic: 'AND', conditions: [emptyCondition()] }
  }

  const [draft, setDraft] = useState<Branch>(() => parseBranch(edge.condition))
  useEffect(() => { setDraft(parseBranch(edge.condition)) }, [edge.edgeId])

  const update = (b: Branch) => { setDraft(b); onChange(edge.edgeId, b) }
  const addCond = () => update({ ...draft, conditions: [...draft.conditions, emptyCondition()] })
  const removeCond = (id: string) => update({ ...draft, conditions: draft.conditions.filter(c => c.id !== id) })
  const setCond = (id: string, patch: Partial<BranchCondition>) =>
    update({ ...draft, conditions: draft.conditions.map(c => c.id === id ? { ...c, ...patch } : c) })

  const paramSuggestions = workflowParams.map(p => `params.${p.key}`)
  const isDefault = draft.isDefault === true

  const accent = isDefault ? '#f59e0b' : (edge.edgeType === 'CONDITIONAL' ? '#22c55e' : '#94a3b8')

  return (
    <div style={{
      borderRadius: 10,
      border: `1px solid ${isDefault ? 'rgba(245,158,11,0.35)' : 'rgba(255,255,255,0.07)'}`,
      background: isDefault ? 'rgba(245,158,11,0.06)' : 'rgba(255,255,255,0.03)',
      padding: '10px 12px', marginBottom: 8,
    }}>
      {/* Branch header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: accent }} />
        <input
          value={edge.label ?? draft.label ?? ''}
          onChange={e => onChange(edge.edgeId, { ...draft, label: e.target.value })}
          placeholder={isDefault ? 'Else (default branch)' : 'Branch label…'}
          style={{
            flex: 1, background: 'transparent', border: 'none', outline: 'none',
            fontSize: 11, fontWeight: 600, color: '#e2e8f0',
          }}
        />
        <span style={{ fontSize: 9, color: '#475569', fontFamily: 'monospace' }}>
          → {edge.targetLabel ?? edge.targetNodeId.slice(0, 8)}
        </span>

        {/* Reorder up/down */}
        <button
          onClick={() => onMove(edge.edgeId, -1)} disabled={!canMoveUp}
          title="Move up (higher priority)"
          style={{ background: 'none', border: 'none', cursor: canMoveUp ? 'pointer' : 'default', color: '#475569', padding: 2, opacity: canMoveUp ? 1 : 0.3 }}
        >
          <ChevronDown size={11} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <button
          onClick={() => onMove(edge.edgeId, 1)} disabled={!canMoveDown}
          title="Move down (lower priority)"
          style={{ background: 'none', border: 'none', cursor: canMoveDown ? 'pointer' : 'default', color: '#475569', padding: 2, opacity: canMoveDown ? 1 : 0.3 }}
        >
          <ChevronDown size={11} />
        </button>

        {/* Test */}
        <button
          onClick={() => onTest(edge.edgeId)}
          title="Test against sample context"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: 2, display: 'flex' }}
          onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.color = '#a78bfa')}
          onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.color = '#475569')}
        >
          <Activity size={11} />
        </button>

        {/* Delete */}
        <button
          onClick={() => onDelete(edge.edgeId)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: 2, display: 'flex' }}
          onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.color = '#ef4444')}
          onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.color = '#475569')}
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* Default toggle */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: isDefault ? 4 : 8, cursor: 'pointer' }}>
        <input
          type="checkbox" checked={isDefault}
          onChange={e => onSetDefault(edge.edgeId, e.target.checked)}
          style={{ width: 12, height: 12, accentColor: '#f59e0b' }}
        />
        <span style={{ fontSize: 10, color: isDefault ? '#fbbf24' : '#64748b', fontWeight: 600 }}>
          Default branch — fires when no other branch matches
        </span>
      </label>

      {/* Hide condition editor entirely when this is the default branch */}
      {isDefault ? (
        <p style={{ fontSize: 10, color: '#475569', fontStyle: 'italic', margin: 0 }}>
          Conditions are ignored on the default branch.
        </p>
      ) : (<>

      {/* Conditions */}
      {draft.conditions.map((cond, idx) => (
        <div key={cond.id} style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 5 }}>
          <span style={{ fontSize: 9, color: '#475569', width: 24, flexShrink: 0, textAlign: 'center', fontWeight: 700 }}>
            {idx === 0 ? 'IF' : draft.logic}
          </span>

          {/* Left: param/path selector */}
          <input
            list={`params-${cond.id}`}
            value={cond.left}
            onChange={e => setCond(cond.id, { left: e.target.value })}
            placeholder="params.key or context.path"
            style={{
              flex: 2, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6, padding: '4px 7px', fontSize: 10, color: '#cbd5e1', outline: 'none',
            }}
          />
          <datalist id={`params-${cond.id}`}>
            {paramSuggestions.map(s => <option key={s} value={s} />)}
          </datalist>

          {/* Operator */}
          <select
            value={cond.op}
            onChange={e => setCond(cond.id, { op: e.target.value as ConditionOp })}
            style={{
              flex: 1, background: '#0f172a', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6, padding: '4px 5px', fontSize: 10, color: '#94a3b8', outline: 'none', minWidth: 0,
            }}
          >
            {CONDITION_OPS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>

          {/* Right value */}
          {!['exists', 'not_exists'].includes(cond.op) && (
            <input
              value={cond.right}
              onChange={e => setCond(cond.id, { right: e.target.value })}
              placeholder={cond.op === 'in' || cond.op === 'not_in' ? 'a,b,c' : 'value'}
              style={{
                flex: 2, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 6, padding: '4px 7px', fontSize: 10, color: '#cbd5e1', outline: 'none',
              }}
            />
          )}

          {draft.conditions.length > 1 && (
            <button
              onClick={() => removeCond(cond.id)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#334155', padding: 2, flexShrink: 0 }}
              onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.color = '#ef4444')}
              onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.color = '#334155')}
            >
              <X size={10} />
            </button>
          )}
        </div>
      ))}

      {/* Footer: AND/OR toggle + add condition */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
        <button
          onClick={addCond}
          style={{
            fontSize: 9, padding: '3px 8px', borderRadius: 5, border: '1px dashed rgba(255,255,255,0.12)',
            background: 'transparent', color: '#64748b', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
          }}
        >
          <Plus size={9} /> Add condition
        </button>
        {draft.conditions.length > 1 && (
          <div style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
            {(['AND', 'OR'] as const).map(l => (
              <button
                key={l}
                onClick={() => update({ ...draft, logic: l })}
                style={{
                  fontSize: 8, padding: '2px 7px', borderRadius: 4,
                  border: `1px solid ${draft.logic === l ? 'rgba(34,197,94,0.4)' : 'rgba(255,255,255,0.08)'}`,
                  background: draft.logic === l ? 'rgba(34,197,94,0.12)' : 'transparent',
                  color: draft.logic === l ? '#22c55e' : '#475569',
                  cursor: 'pointer', fontWeight: 700,
                }}
              >
                {l}
              </button>
            ))}
          </div>
        )}
      </div>
      </>)}
    </div>
  )
}

function BranchesTab({
  outgoingEdges, workflowParams, sourceNodeType, onUpdateBranch, onDeleteBranch, onTestBranch,
}: {
  outgoingEdges: OutgoingEdgeBranch[]
  workflowParams: ParamDef[]
  sourceNodeType: string
  onUpdateBranch: (edgeId: string, label: string | undefined, branch: Branch) => void
  onDeleteBranch: (edgeId: string) => void
  onTestBranch?: (edgeId: string) => void
}) {
  const isDecisionGate = sourceNodeType === 'DECISION_GATE'
  const isInclusiveGw  = sourceNodeType === 'INCLUSIVE_GATEWAY'

  // Sort by priority asc; ties broken by edgeId so order is deterministic.
  const sorted = [...outgoingEdges].sort((a, b) => {
    const pa = (a.condition as Branch | null | undefined)?.priority
    const pb = (b.condition as Branch | null | undefined)?.priority
    const ap = typeof pa === 'number' ? pa : 1_000_000
    const bp = typeof pb === 'number' ? pb : 1_000_000
    if (ap !== bp) return ap - bp
    return a.edgeId.localeCompare(b.edgeId)
  })

  const hasDefault = sorted.some(e => (e.condition as Branch | null | undefined)?.isDefault === true)

  const ensureBranch = (edge: OutgoingEdgeBranch): Branch =>
    (edge.condition && Array.isArray((edge.condition as Branch).conditions))
      ? (edge.condition as Branch)
      : { logic: 'AND', conditions: [emptyCondition()] }

  const handleChange = (edgeId: string, branch: Branch) => {
    const edge = outgoingEdges.find(e => e.edgeId === edgeId)
    onUpdateBranch(edgeId, edge?.label, branch)
  }

  const handleSetDefault = (edgeId: string, isDefault: boolean) => {
    // When marking one branch as default, clear the flag on all others.
    for (const edge of outgoingEdges) {
      const cur = ensureBranch(edge)
      if (edge.edgeId === edgeId) {
        if ((cur.isDefault === true) === isDefault) continue
        onUpdateBranch(edgeId, edge.label, { ...cur, isDefault })
      } else if (isDefault && cur.isDefault) {
        onUpdateBranch(edge.edgeId, edge.label, { ...cur, isDefault: false })
      }
    }
  }

  const handleMove = (edgeId: string, dir: -1 | 1) => {
    const idx = sorted.findIndex(e => e.edgeId === edgeId)
    const next = idx + dir
    if (next < 0 || next >= sorted.length) return
    // Reassign priority indices reflecting the swap.
    const ordered = [...sorted]
    ;[ordered[idx], ordered[next]] = [ordered[next], ordered[idx]]
    ordered.forEach((edge, i) => {
      const cur = ensureBranch(edge)
      onUpdateBranch(edge.edgeId, edge.label, { ...cur, priority: i })
    })
  }

  if (outgoingEdges.length === 0) {
    return (
      <div style={{ padding: '32px 16px', textAlign: 'center' }}>
        <GitMerge size={24} style={{ color: '#334155', marginBottom: 10 }} />
        <p style={{ fontSize: 11, color: '#475569', marginBottom: 6, fontWeight: 600 }}>No outgoing branches</p>
        <p style={{ fontSize: 10, color: '#334155', lineHeight: 1.6 }}>
          Draw edges from this node to other nodes in the canvas.<br />
          Each edge becomes a branch you can configure here.
        </p>
      </div>
    )
  }

  return (
    <div style={{ padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <p style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#475569' }}>
          {sorted.length} branch{sorted.length !== 1 ? 'es' : ''}
        </p>
        <span style={{ marginLeft: 'auto', fontSize: 8, padding: '2px 7px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.08)', color: '#64748b', fontWeight: 700, letterSpacing: '0.08em' }}>
          {isDecisionGate ? 'XOR · first match wins' : isInclusiveGw ? 'OR · all matches fire' : 'fan-out'}
        </span>
      </div>

      {/* Default-branch banner — only meaningful for decision-style nodes */}
      {(isDecisionGate || isInclusiveGw) && !hasDefault && (
        <div style={{
          display: 'flex', gap: 6, alignItems: 'flex-start',
          padding: '7px 10px', borderRadius: 8,
          border: '1px solid rgba(245,158,11,0.25)', background: 'rgba(245,158,11,0.08)',
          marginBottom: 8,
        }}>
          <AlertTriangle size={11} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 1 }} />
          <p style={{ fontSize: 10, color: '#fbbf24', lineHeight: 1.5 }}>
            No default branch. If no condition matches at runtime, the workflow will stall and emit a <code style={{ fontFamily: 'monospace' }}>PathStall</code> audit event. Mark one branch as default to define a fallback.
          </p>
        </div>
      )}

      {sorted.map((edge, i) => (
        <BranchRow
          key={edge.edgeId}
          edge={edge}
          workflowParams={workflowParams}
          canMoveUp={i > 0}
          canMoveDown={i < sorted.length - 1}
          onChange={handleChange}
          onDelete={onDeleteBranch}
          onMove={handleMove}
          onSetDefault={handleSetDefault}
          onTest={(eid) => onTestBranch?.(eid)}
        />
      ))}
      <p style={{ fontSize: 9, color: '#334155', marginTop: 8, lineHeight: 1.6 }}>
        Reference team globals as <code style={{ color: '#94a3b8', fontFamily: 'monospace' }}>globals.X</code>, template variables as <code style={{ color: '#94a3b8', fontFamily: 'monospace' }}>vars.X</code>, or context paths as <code style={{ color: '#94a3b8', fontFamily: 'monospace' }}>context.path</code>. Changes auto-save on edit.
      </p>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────

type Props = {
  node: Node<NodeData>
  instanceId?: string
  templateCapabilityId?: string | null
  onClose: () => void
  onSave: (nodeId: string, label: string, config: NodeConfig) => void
  saving: boolean
  customNodeTypes?: CustomNodeTypeDef[]
  outgoingEdges?: OutgoingEdgeBranch[]
  workflowParams?: ParamDef[]
  /** Workflow-scoped variables (vars.*) — used by the Assignment variable picker. */
  templateVariables?: Array<{ key: string; label?: string; type?: string; description?: string }>
  /** Team-scoped globals (globals.*) — used by the Assignment variable picker. */
  teamGlobals?: Array<{ key: string; label?: string; type?: string; description?: string }>
  onUpdateBranch?: (edgeId: string, label: string | undefined, branch: Branch) => void
  onDeleteBranch?: (edgeId: string) => void
  onTestBranch?: (edgeId: string) => void
}

export function NodeInspector({
  node, instanceId, templateCapabilityId, onClose, onSave, saving, customNodeTypes = [],
  outgoingEdges = [], workflowParams = [],
  templateVariables = [], teamGlobals = [],
  onUpdateBranch, onDeleteBranch, onTestBranch,
}: Props) {
  // Resolve custom type definition for CUSTOM nodes
  const cfg0 = (node.data.config ?? {}) as Record<string, unknown>
  const customTypeId = node.data.nodeType === 'CUSTOM' && typeof cfg0._customTypeId === 'string' ? cfg0._customTypeId : null
  const customTypeDef = customTypeId ? customNodeTypes.find(ct => ct.id === customTypeId) ?? null : null

  const baseMeta = NODE_META[node.data.nodeType] ?? {
    label: node.data.nodeType, color: '#64748b', Icon: GitBranch,
    description: 'Custom node type.', standardFields: [],
  }

  // For CUSTOM nodes, merge in custom type metadata
  const meta = (node.data.nodeType === 'CUSTOM' && customTypeDef) ? {
    ...baseMeta,
    label: customTypeDef.label,
    color: customTypeDef.color,
    Icon: (CUSTOM_NODE_ICONS[customTypeDef.icon] ?? Box) as React.ElementType,
    description: customTypeDef.description ?? `Custom ${customTypeDef.label} node.`,
    standardFields: customTypeDef.fields,
  } : (node.data.nodeType === 'CUSTOM' && !customTypeDef) ? {
    ...baseMeta,
    label: typeof cfg0._customTypeLabel === 'string' ? cfg0._customTypeLabel : 'Custom',
    color: typeof cfg0._customTypeColor === 'string' ? cfg0._customTypeColor : '#64748b',
    Icon: (typeof cfg0._customTypeIcon === 'string' && CUSTOM_NODE_ICONS[cfg0._customTypeIcon as string]
      ? CUSTOM_NODE_ICONS[cfg0._customTypeIcon as string]
      : Box) as React.ElementType,
    description: 'Custom node type.',
    standardFields: [],
  } : baseMeta

  const { color, Icon, description, standardFields } = meta

  const [tab, setTab] = useState<Tab>(node.data.nodeType === 'WORKBENCH_TASK' ? 'Workbench' : 'Overview')
  const [label, setLabel] = useState(node.data.label)
  const [config, setConfig] = useState<NodeConfig>(() => normalizeConfig(node.data.config))

  // Sync when selected node changes
  useEffect(() => {
    setLabel(node.data.label)
    setConfig(normalizeConfig(node.data.config))
    setTab(node.data.nodeType === 'WORKBENCH_TASK' ? 'Workbench' : 'Overview')
  }, [node.id, node.data.nodeType])

  const handleSave = () => onSave(node.id, label, config)
  const statusColor = STATUS_COLOR[node.data.status] ?? '#64748b'
  const workbenchErrors = node.data.nodeType === 'WORKBENCH_TASK'
    ? validateWorkbenchBuilder(config.workbench)
    : []

  return (
    <motion.div
      className="node-inspector-readable"
      key="inspector"
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.18 }}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}
    >
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div style={{
        padding: '14px 16px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: `${color}15`, border: `1px solid ${color}30`,
            }}>
              <Icon style={{ width: 13, height: 13, color }} />
            </div>
            <div>
              <p style={{ fontSize: 12, fontWeight: 700, color: '#cbd5e1', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {meta.label}
              </p>
              <p style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace', marginTop: 2 }}>
                {node.id.slice(0, 12)}…
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
              padding: '3px 8px', borderRadius: 5,
              background: `${statusColor}15`, color: statusColor, border: `1px solid ${statusColor}25`,
            }}>
              {node.data.status || 'PENDING'}
            </span>
            <button
              onClick={onClose}
              style={{
                width: 22, height: 22, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'transparent', border: 'none', color: '#475569', cursor: 'pointer',
              }}
              onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.color = '#94a3b8')}
              onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.color = '#475569')}
            >
              <X size={12} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {TABS
            .filter(t => t !== 'Branches' || DECISION_NODE_TYPES.has(node.data.nodeType))
            .filter(t => t !== 'Workbench' || node.data.nodeType === 'WORKBENCH_TASK')
            .map(t => <TabBtn key={t} label={t} active={tab === t} onClick={() => setTab(t)} />)
          }
        </div>
      </div>

      {/* ── Tab content ────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.1 }}
          >
            {/* OVERVIEW */}
            {tab === 'Overview' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {/* Description pill */}
                <div style={{
                  padding: '8px 10px', borderRadius: 8,
                  background: `${color}08`, border: `1px solid ${color}18`,
                }}>
                  <p style={{ fontSize: 10, color: '#64748b', lineHeight: 1.6 }}>{description}</p>
                </div>

                <div>
                  <FieldLabel>Node label</FieldLabel>
                  <NeoInput value={label} onChange={setLabel} placeholder="Label…" />
                </div>

                <div>
                  <FieldLabel>Description</FieldLabel>
                  <NeoInput
                    value={config.description}
                    onChange={v => setConfig(c => ({ ...c, description: v }))}
                    placeholder="What does this node do in this workflow?"
                    multiline
                  />
                </div>

                {/* Stats row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  {[
                    { icon: <ArrowDownToLine size={10} style={{ color: '#38bdf8' }} />, label: 'Inputs',  value: config.inputArtifacts.length },
                    { icon: <ArrowUpFromLine size={10} style={{ color: '#34d399' }} />, label: 'Outputs', value: config.outputArtifacts.length },
                    { icon: <Hash size={10} style={{ color: '#c084fc' }} />,            label: 'Design KV', value: config.designKV.filter(p => p.key).length },
                    { icon: <Cpu size={10} style={{ color: '#fb923c' }} />,             label: 'Runtime KV', value: config.runtimeKV.filter(p => p.key).length },
                  ].map(({ icon, label: l, value }) => (
                    <div key={l} style={{
                      padding: '8px 10px', borderRadius: 8,
                      background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
                      display: 'flex', alignItems: 'center', gap: 7,
                    }}>
                      {icon}
                      <div>
                        <p style={{ fontSize: 9, color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{l}</p>
                        <p style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0', fontFamily: 'monospace', lineHeight: 1.1 }}>{value}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* WORKBENCH — first-class WORKBENCH_TASK builder */}
            {tab === 'Workbench' && (
              <WorkbenchTab
                config={config.workbench}
                onChange={workbench => setConfig(c => ({ ...c, workbench }))}
              />
            )}

            {/* CONFIG — standard fields + design-time KV */}
            {tab === 'Config' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Standard fields */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <LayoutGrid size={11} style={{ color: color }} />
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color }}>
                      Standard fields
                    </span>
                  </div>
                  {standardFields.length === 0 ? (
                    <p style={{ fontSize: 10, color: '#334155' }}>No standard fields for this node type.</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {standardFields.map(f => {
                        // M10 — picker matching expanded for federated lookups.
                        const isAgentPicker      = node.data.nodeType === 'AGENT_TASK'   && (f.key === 'agentTemplateId' || f.key === 'agentId')
                        const isToolPicker       = node.data.nodeType === 'TOOL_REQUEST' && f.key === 'toolName'
                        const isTemplatePicker   = node.data.nodeType === 'CALL_WORKFLOW' && f.key === 'templateId'
                        const isCapabilityPicker = f.key === 'capabilityId'
                        const isPriority         = f.key === 'priority'
                        const isModelAlias       = f.key === 'modelAlias'
                        const isGovernanceMode   = f.key === 'governanceMode'
                        const isEvalScope        = node.data.nodeType === 'EVAL_GATE' && f.key === 'scope'
                        const isBooleanFlag      = (node.data.nodeType === 'EVAL_GATE' && f.key === 'blockOnMissingEvidence')
                          || (node.data.nodeType === 'GIT_PUSH' && f.key === 'requireApproval')
                        const isVariableAwareNumber = f.key === 'maxConcurrency' || f.key === 'expectedBranches'
                        const cfgCapabilityId    = (config.standard.capabilityId as string | undefined) ?? null
                        return (
                          <div key={f.key}>
                            <FieldLabel>{f.label}</FieldLabel>
                            {isPriority ? (
                              <select
                                value={config.standard[f.key] ?? 'MEDIUM'}
                                onChange={e => setConfig(c => ({ ...c, standard: { ...c.standard, [f.key]: e.target.value } }))}
                                style={{
                                  width: '100%', boxSizing: 'border-box',
                                  background: 'rgba(255,255,255,0.05)',
                                  border: '1px solid rgba(255,255,255,0.10)',
                                  borderRadius: 8, padding: '6px 10px',
                                  fontSize: 11, color: '#e2e8f0',
                                  outline: 'none', cursor: 'pointer',
                                }}
                              >
                                {['CRITICAL','HIGH','MEDIUM','LOW'].map(p => (
                                  <option key={p} value={p} style={{ background: '#0f172a' }}>{p}</option>
                                ))}
                              </select>
                            ) : isCapabilityPicker ? (
                              <CapabilityPicker
                                value={config.standard[f.key] ?? ''}
                                onChange={v => setConfig(c => ({ ...c, standard: { ...c.standard, [f.key]: v } }))}
                              />
                            ) : isAgentPicker ? (
                              <AgentPicker
                                capabilityId={cfgCapabilityId}
                                value={config.standard[f.key] ?? ''}
                                onChange={v => setConfig(c => ({ ...c, standard: { ...c.standard, [f.key]: v } }))}
                              />
                            ) : isToolPicker ? (
                              <ToolPicker
                                capabilityId={cfgCapabilityId}
                                value={config.standard[f.key] ?? ''}
                                onChange={v => setConfig(c => ({ ...c, standard: { ...c.standard, [f.key]: v } }))}
                              />
                            ) : isModelAlias ? (
                              <ModelAliasPicker
                                value={config.standard[f.key] ?? ''}
                                onChange={v => setConfig(c => ({ ...c, standard: { ...c.standard, [f.key]: v } }))}
                              />
                            ) : isGovernanceMode ? (
                              <select
                                value={config.standard[f.key] ?? 'fail_open'}
                                onChange={e => setConfig(c => ({ ...c, standard: { ...c.standard, [f.key]: e.target.value } }))}
                                style={{
                                  width: '100%', boxSizing: 'border-box',
                                  background: 'rgba(255,255,255,0.05)',
                                  border: '1px solid rgba(255,255,255,0.10)',
                                  borderRadius: 8, padding: '7px 10px',
                                  fontSize: 11, color: '#e2e8f0',
                                  outline: 'none', cursor: 'pointer',
                                }}
                              >
                                {[
                                  ['fail_open', 'Fail open (local/dev)'],
                                  ['fail_closed', 'Fail closed'],
                                  ['degraded', 'Degraded read-only'],
                                  ['human_approval_required', 'Human approval required'],
                                ].map(([value, label]) => (
                                  <option key={value} value={value} style={{ background: '#0f172a' }}>{label}</option>
                                ))}
                              </select>
                            ) : isEvalScope ? (
                              <select
                                value={config.standard[f.key] ?? 'CURRENT_RUN'}
                                onChange={e => setConfig(c => ({ ...c, standard: { ...c.standard, [f.key]: e.target.value } }))}
                                style={{
                                  width: '100%', boxSizing: 'border-box',
                                  background: 'rgba(255,255,255,0.05)',
                                  border: '1px solid rgba(255,255,255,0.10)',
                                  borderRadius: 8, padding: '7px 10px',
                                  fontSize: 11, color: '#e2e8f0',
                                  outline: 'none', cursor: 'pointer',
                                }}
                              >
                                {[
                                  ['CURRENT_RUN', 'Current run traces'],
                                  ['TRACE', 'Specific trace id'],
                                  ['DATASET', 'Eval dataset'],
                                ].map(([value, label]) => (
                                  <option key={value} value={value} style={{ background: '#0f172a' }}>{label}</option>
                                ))}
                              </select>
                            ) : isBooleanFlag ? (
                              <select
                                value={String(config.standard[f.key] ?? 'true')}
                                onChange={e => setConfig(c => ({ ...c, standard: { ...c.standard, [f.key]: e.target.value } }))}
                                style={{
                                  width: '100%', boxSizing: 'border-box',
                                  background: 'rgba(255,255,255,0.05)',
                                  border: '1px solid rgba(255,255,255,0.10)',
                                  borderRadius: 8, padding: '7px 10px',
                                  fontSize: 11, color: '#e2e8f0',
                                  outline: 'none', cursor: 'pointer',
                                }}
                              >
                                <option value="true" style={{ background: '#0f172a' }}>
                                  {node.data.nodeType === 'GIT_PUSH' ? 'Require approved gate' : 'Block when evidence is missing'}
                                </option>
                                <option value="false" style={{ background: '#0f172a' }}>
                                  {node.data.nodeType === 'GIT_PUSH' ? 'Allow autonomous push' : 'Allow missing evidence'}
                                </option>
                              </select>
                            ) : isTemplatePicker ? (
                              <TemplatePicker
                                value={config.standard[f.key] ?? ''}
                                onChange={v => setConfig(c => ({ ...c, standard: { ...c.standard, [f.key]: v } }))}
                              />
                            ) : isVariableAwareNumber ? (
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <div style={{ flex: 1 }}>
                                  <NeoInput
                                    value={config.standard[f.key] ?? ''}
                                    onChange={v => setConfig(c => ({ ...c, standard: { ...c.standard, [f.key]: v } }))}
                                    placeholder={f.placeholder}
                                  />
                                </div>
                                <VariableInsertMenu
                                  templateVariables={templateVariables}
                                  teamGlobals={teamGlobals}
                                  onInsert={path => setConfig(c => ({
                                    ...c,
                                    standard: { ...c.standard, [f.key]: `{{${path}}}` },
                                  }))}
                                />
                              </div>
                            ) : (
                              <NeoInput
                                value={config.standard[f.key] ?? ''}
                                onChange={v => setConfig(c => ({ ...c, standard: { ...c.standard, [f.key]: v } }))}
                                placeholder={f.placeholder}
                                multiline={f.multiline}
                              />
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

	                <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />

	                {node.data.nodeType === 'WORK_ITEM' && (
	                  <>
	                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: -4 }}>
	                      <Network size={11} style={{ color: '#7c3aed' }} />
	                      <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#7c3aed' }}>
	                        Child capability targets
	                      </span>
	                    </div>
	                    <WorkItemTargetsEditor
	                      targets={config.targets ?? []}
	                      onChange={targets => setConfig(c => ({ ...c, targets }))}
	                    />
	                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: -4 }}>
	                      <Workflow size={11} style={{ color: '#7c3aed' }} />
	                      <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#7c3aed' }}>
	                        Parent input mapping
	                      </span>
	                    </div>
	                    <KVSection
	                      title=""
	                      pairs={config.assignments ?? []}
	                      onChange={assignments => setConfig(c => ({ ...c, assignments }))}
	                      accentColor="#7c3aed"
	                    />
	                    <p style={{ fontSize: 9, color: '#64748b', marginTop: -10 }}>
	                      Key = child input key · Value = parent context path or <code style={{ fontFamily: 'monospace' }}>{'{{vars.story}}'}</code>.
	                    </p>
	                    <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />
	                  </>
	                )}

	                {/* Design-time KV */}
	                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: -4 }}>
                  <Settings size={11} style={{ color: '#c084fc' }} />
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#c084fc' }}>
                    Design-time config
                  </span>
                </div>
                <KVSection
                  title=""
                  pairs={config.designKV}
                  onChange={designKV => setConfig(c => ({ ...c, designKV }))}
                  accentColor="#c084fc"
                />

                <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />

                {/* Execution location */}
                <ExecutionLocationSection
                  location={config.executionLocation}
                  onChange={loc => setConfig(c => ({ ...c, executionLocation: loc }))}
                />

                <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: -4 }}>
                  <Globe size={11} style={{ color: '#0ea5e9' }} />
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#0ea5e9' }}>
                    Runtime global writes
                  </span>
                </div>
                <KVSection
                  title=""
                  pairs={config.globalAssignments ?? []}
                  onChange={globalAssignments => setConfig(c => ({ ...c, globalAssignments }))}
                  accentColor="#0ea5e9"
                />
                <p style={{ fontSize: 9, color: '#64748b', marginTop: -10 }}>
                  Key = <code style={{ fontFamily: 'monospace' }}>globals.parallelTasks</code> or <code style={{ fontFamily: 'monospace' }}>parallelTasks</code>. Value may be literal JSON or <code style={{ fontFamily: 'monospace' }}>{'{{output.count}}'}</code>.
                </p>

                <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />

                {/* DATA_SINK config */}
                {node.data.nodeType === 'DATA_SINK' && (
                  <>
                    <SinkConfigSection
                      cfg={config.sinkConfig}
                      onChange={sc => setConfig(c => ({ ...c, sinkConfig: sc }))}
                    />
                    <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />
                  </>
                )}

                {/* CALL_WORKFLOW input mapping */}
                {node.data.nodeType === 'CALL_WORKFLOW' && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: -4 }}>
                      <Workflow size={11} style={{ color: '#8b5cf6' }} />
                      <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#8b5cf6' }}>
                        Input Mapping
                      </span>
                    </div>
                    <KVSection
                      title=""
                      pairs={config.assignments ?? []}
                      onChange={assignments => setConfig(c => ({ ...c, assignments }))}
                      accentColor="#8b5cf6"
                    />
                    <p style={{ fontSize: 9, color: '#64748b', marginTop: -4 }}>
                      Key = child context key · Value = parent context path (e.g. order.id)
                    </p>
                    <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />
                  </>
                )}

                {/* SET_CONTEXT assignments */}
                {node.data.nodeType === 'SET_CONTEXT' && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: -4 }}>
                      <SlidersHorizontal size={11} style={{ color: '#84cc16' }} />
                      <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#84cc16' }}>
                        Context Assignments
                      </span>
                    </div>
                    <KVSection
                      title=""
                      pairs={config.assignments ?? []}
                      onChange={assignments => setConfig(c => ({ ...c, assignments }))}
                      accentColor="#84cc16"
                    />
                    <p style={{ fontSize: 9, color: '#64748b', marginTop: -4 }}>
                      Key = context path (e.g. customer.tier) · Value = literal or {'{{'}context.path{'}}'}
                    </p>
                    <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />
                  </>
                )}

                {/* Retry policy / error handling */}
                <RetryPolicySection
                  policy={config.retryPolicy}
                  onChange={p => setConfig(c => ({ ...c, retryPolicy: p }))}
                />

                <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />

                {/* SAGA Compensation */}
                <CompensationConfigSection
                  cfg={config.compensationConfig}
                  onChange={cc => setConfig(c => ({ ...c, compensationConfig: cc }))}
                />

                {/* Assignment routing — HUMAN_TASK / APPROVAL / CONSUMABLE_CREATION,
                    plus CUSTOM nodes whose base type maps to one of these. */}
                {(node.data.nodeType === 'HUMAN_TASK' ||
                  node.data.nodeType === 'APPROVAL' ||
                  node.data.nodeType === 'CONSUMABLE_CREATION' ||
                  (node.data.nodeType === 'CUSTOM' &&
                    ['HUMAN_TASK','APPROVAL','CONSUMABLE_CREATION'].includes(customTypeDef?.baseType ?? ''))) && (
                  <>
                    <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />
                    <NodeAssignmentSection
                      config={config}
                      capabilityId={templateCapabilityId ?? null}
                      templateVariables={templateVariables}
                      teamGlobals={teamGlobals}
                      onChange={setConfig}
                    />
                  </>
                )}

                {/* Section-based form builder — HUMAN_TASK / APPROVAL / CONSUMABLE_CREATION,
                    plus CUSTOM nodes whose CustomNodeType has supportsForms = true.
                    Authors define fields, tables, checklists, signatures, file uploads here;
                    the assignee fills the form at runtime. */}
                {(node.data.nodeType === 'HUMAN_TASK' ||
                  node.data.nodeType === 'APPROVAL' ||
                  node.data.nodeType === 'CONSUMABLE_CREATION' ||
                  (node.data.nodeType === 'CUSTOM' && (customTypeDef as { supportsForms?: boolean } | null)?.supportsForms)) && (
                  <>
                    <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />
                    <NodeFormBuilder
                      widgets={config.formWidgets}
                      onChange={w => setConfig(c => ({ ...c, formWidgets: w }))}
                      accentColor={
                        node.data.nodeType === 'APPROVAL'           ? '#f59e0b' :
                        node.data.nodeType === 'CONSUMABLE_CREATION' ? '#10b981' :
                                                                      '#38bdf8'
                      }
                      label={
                        node.data.nodeType === 'APPROVAL'           ? 'Approval Brief Form' :
                        node.data.nodeType === 'CONSUMABLE_CREATION' ? 'Deliverable Form' :
                                                                      'Task Form'
                      }
                    />
                  </>
                )}
              </div>
            )}

            {/* BRANCHES — decision nodes only */}
            {tab === 'Branches' && (
              <BranchesTab
                outgoingEdges={outgoingEdges}
                workflowParams={workflowParams}
                sourceNodeType={node.data.nodeType}
                onUpdateBranch={onUpdateBranch ?? (() => {})}
                onDeleteBranch={onDeleteBranch ?? (() => {})}
                onTestBranch={onTestBranch}
              />
            )}

            {/* ACTIONS */}
            {tab === 'Actions' && (
              <AttachmentsTab config={config} onChange={setConfig} />
            )}

            {/* ARTIFACTS */}
            {tab === 'Artifacts' && (
              <ArtifactsTab config={config} onChange={setConfig} />
            )}

            {/* RUNTIME */}
            {tab === 'Runtime' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{
                  padding: '8px 10px', borderRadius: 8,
                  background: 'rgba(251,146,60,0.06)', border: '1px solid rgba(251,146,60,0.15)',
                  display: 'flex', alignItems: 'flex-start', gap: 7,
                }}>
                  <Cpu size={11} style={{ color: '#fb923c', flexShrink: 0, marginTop: 1 }} />
                  <p style={{ fontSize: 10, color: '#64748b', lineHeight: 1.6 }}>
                    Runtime config is merged with design-time config at execution time. Use for environment-specific or secret values.
                  </p>
                </div>
                <KVSection
                  title="Runtime key-value pairs"
                  pairs={config.runtimeKV}
                  onChange={runtimeKV => setConfig(c => ({ ...c, runtimeKV }))}
                  accentColor="#fb923c"
                />

                {/* Runtime form fill — only when this node has a widget form
                    AND its base type maps to a runtime entity. */}
                {Array.isArray(config.formWidgets) && config.formWidgets.length > 0 && (() => {
                  const customBase = customTypeDef?.baseType
                  const kind = resolveRuntimeKind(node.data.nodeType, customBase)
                  if (!kind) return null
                  const accent =
                    kind === 'task'       ? '#38bdf8' :
                    kind === 'approval'   ? '#f59e0b' :
                                            '#10b981'
                  return (
                    <RuntimeFormSection
                      nodeId={node.id}
                      nodeStatus={node.data.status}
                      instanceId={instanceId}
                      widgets={config.formWidgets}
                      kind={kind}
                      accentColor={accent}
                    />
                  )
                })()}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ── Footer / Save ───────────────────────────────────────────── */}
      <div style={{ padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
        <button
          onClick={handleSave}
          disabled={saving || !label.trim() || workbenchErrors.length > 0}
          className="workflow-neo-save-btn"
        >
          {saving
            ? <Loader2 style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} />
            : <Save style={{ width: 12, height: 12 }} />
          }
          {saving ? 'Saving…' : 'Save node'}
        </button>
      </div>
    </motion.div>
  )
}
