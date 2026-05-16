import { useCallback, useRef, useState, useEffect, useLayoutEffect, createContext, useContext } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'motion/react'
import ReactFlow, {
  addEdge, useNodesState, useEdgesState,
  Handle, Position, BackgroundVariant, Background,
  type NodeTypes, type Connection, type NodeProps, type Node, type ReactFlowInstance,
} from 'reactflow'
import 'reactflow/dist/style.css'
import {
  GitBranch, Play, Pause, Square, RotateCw, RotateCcw,
  User, Bot, CheckCircle, GitMerge, Package, Wrench, Shield,
  Clock, Radio, RadioTower, Workflow, Repeat, Shuffle, Zap,
  Sun, Moon, Box, X, ArrowLeft, ZoomIn, ZoomOut, Maximize2, Layers,
  Star, Briefcase as BriefcaseIcon, Database, Globe, Mail, Phone,
  Calendar, AlertTriangle, Search, Filter, Activity, Coins,
  SlidersHorizontal, Plus, Trash2, GitFork, ShieldAlert,
  Minimize2, GripVertical, HelpCircle, BookOpen, ChevronDown, Lock, Download, Braces, PenLine, Network,
} from 'lucide-react'
import { api } from '../../lib/api'
import {
  NodeInspector,
  type NodeData, type NodeConfig, type CustomNodeTypeDef,
  type ParamDef, type Branch, type OutgoingEdgeBranch,
} from './NodeInspector'
import { WorkflowVariablesPanel } from '../variables/WorkflowVariablesPanel'
import type { TemplateVariableDef, TeamVariable } from '../variables/types'
import { BranchTestPanel } from './BranchTestPanel'

// ─── Node visual map ──────────────────────────────────────────────────────────

const NODE_VISUAL: Record<string, { color: string; Icon: React.ElementType }> = {
  START:               { color: '#00843D', Icon: Play },
  END:                 { color: '#64748b', Icon: Square },
  HUMAN_TASK:          { color: '#22c55e', Icon: User },
  AGENT_TASK:          { color: '#38bdf8', Icon: Bot },
  WORKBENCH_TASK:      { color: '#ffb786', Icon: Braces },
  APPROVAL:            { color: '#a3e635', Icon: CheckCircle },
  DECISION_GATE:       { color: '#c084fc', Icon: GitMerge },
  CONSUMABLE_CREATION: { color: '#34d399', Icon: Package },
  TOOL_REQUEST:        { color: '#fb923c', Icon: Wrench },
  POLICY_CHECK:        { color: '#94a3b8', Icon: Shield },
  TIMER:               { color: '#facc15', Icon: Clock },
  SIGNAL_WAIT:         { color: '#06b6d4', Icon: Radio },
  SIGNAL_EMIT:         { color: '#0891b2', Icon: RadioTower },
  CALL_WORKFLOW:       { color: '#8b5cf6', Icon: Workflow },
  WORK_ITEM:           { color: '#7c3aed', Icon: Network },
  FOREACH:             { color: '#f43f5e', Icon: Repeat },
  PARALLEL_FORK:       { color: '#f97316', Icon: GitFork },
  PARALLEL_JOIN:       { color: '#d946ef', Icon: GitMerge },
  INCLUSIVE_GATEWAY:   { color: '#a78bfa', Icon: Shuffle },
  EVENT_GATEWAY:       { color: '#fbbf24', Icon: Zap },
  DATA_SINK:           { color: '#0ea5e9', Icon: Database },
  SET_CONTEXT:         { color: '#84cc16', Icon: SlidersHorizontal },
  ERROR_CATCH:         { color: '#ef4444', Icon: ShieldAlert },
}

const NODE_LABELS: Record<string, string> = {
  START: 'Start', END: 'End',
  HUMAN_TASK: 'Human Task', AGENT_TASK: 'Agent Task', WORKBENCH_TASK: 'Workbench Task', APPROVAL: 'Approval',
  DECISION_GATE: 'Decision Gate', CONSUMABLE_CREATION: 'Create Artifact',
  TOOL_REQUEST: 'Tool Request', POLICY_CHECK: 'Policy Check',
  TIMER: 'Timer', SIGNAL_WAIT: 'Signal Wait', SIGNAL_EMIT: 'Signal Emit',
  CALL_WORKFLOW: 'Sub-workflow', WORK_ITEM: 'Work Item',
  FOREACH: 'For Each', PARALLEL_FORK: 'Parallel Fork', PARALLEL_JOIN: 'Parallel Join',
  INCLUSIVE_GATEWAY: 'Inclusive GW', EVENT_GATEWAY: 'Event GW',
  DATA_SINK: 'Data Sink', SET_CONTEXT: 'Set Context', ERROR_CATCH: 'Error Catch',
}

const WORKBENCH_TASK_NODE_CONFIG = {
  workbench: {
    profile: 'blueprint',
    gateMode: 'manual',
    sourceType: 'localdir',
    goal: 'Produce the final implementation contract pack.',
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
        },
        {
          key: 'TEST_CERTIFICATION',
          label: 'Test Certification',
          agentRole: 'QA',
          agentTemplateId: '',
          terminal: true,
          required: true,
          approvalRequired: true,
          allowedSendBackTo: ['DESIGN', 'DEVELOP', 'QA_REVIEW'],
          expectedArtifacts: [
            { kind: 'verification_rules', title: 'Verification rules', required: true, format: 'MARKDOWN' },
            { kind: 'traceability_matrix', title: 'Traceability matrix', required: true, format: 'MARKDOWN' },
            { kind: 'certification_receipt', title: 'Certification receipt', required: true, format: 'MARKDOWN' },
          ],
        },
      ],
    },
    outputs: {
      finalPackKey: 'finalImplementationPack',
    },
  },
  outputArtifacts: [
    { id: 'workbench-final-pack', name: 'finalImplementationPack', bindingPath: 'workbench.finalPack', required: true },
    { id: 'workbench-final-pack-consumable', name: 'finalPackConsumableId', bindingPath: 'workbench.finalPackConsumableId', required: false },
    { id: 'workbench-consumable-ids', name: 'consumableIds', bindingPath: 'workbench.consumableIds', required: false },
    { id: 'workbench-stage-artifacts-by-kind', name: 'stageArtifactsByKind', bindingPath: 'workbench.stageArtifactsByKind', required: false },
  ],
}

const NODE_GROUPS: Array<{ label: string; types: string[] }> = [
  { label: 'Boundary', types: ['START', 'END'] },
  { label: 'Tasks', types: ['HUMAN_TASK', 'AGENT_TASK', 'APPROVAL', 'TOOL_REQUEST'] },
  { label: 'Agentic Workbench', types: ['WORKBENCH_TASK'] },
  { label: 'Artifacts', types: ['CONSUMABLE_CREATION', 'DATA_SINK'] },
  { label: 'Control Flow', types: ['DECISION_GATE', 'PARALLEL_FORK', 'PARALLEL_JOIN', 'INCLUSIVE_GATEWAY', 'EVENT_GATEWAY'] },
  { label: 'Data', types: ['SET_CONTEXT'] },
  { label: 'Async & Timing', types: ['TIMER', 'SIGNAL_WAIT', 'SIGNAL_EMIT'] },
  { label: 'Advanced', types: ['WORK_ITEM', 'CALL_WORKFLOW', 'FOREACH', 'POLICY_CHECK', 'ERROR_CATCH'] },
]

// ─── Validation constants ──────────────────────────────────────────────────────

/** Node types that are valid entry points (no required incoming edge). */
const SOURCE_NODE_TYPES = new Set(['START'])

/** Node types that are valid terminal nodes (can have no outgoing edge). */
const TERMINAL_NODE_TYPES = new Set(['END', 'DATA_SINK', 'CONSUMABLE_CREATION', 'SIGNAL_EMIT'])

/** Human-readable label for what each terminal node type produces. */
const TERMINAL_OUTPUT_LABEL: Record<string, string> = {
  END:                  'Workflow complete',
  DATA_SINK:            'External data write',
  CONSUMABLE_CREATION:  'Consumable artifact',
  SIGNAL_EMIT:          'Signal broadcast',
}

/** Consumable output types for DATA_SINK and CONSUMABLE_CREATION. */
const CONSUMABLE_OUTPUT_TYPES = ['ARTIFACT', 'DOCUMENT', 'CODE', 'DATASET', 'MESSAGE', 'API_RESPONSE', 'DATABASE_RECORD'] as const
type ConsumableOutputType = typeof CONSUMABLE_OUTPUT_TYPES[number]
const CONSUMABLE_OUTPUT_LABEL: Record<ConsumableOutputType, string> = {
  ARTIFACT:        '📦 Artifact',
  DOCUMENT:        '📄 Document',
  CODE:            '💻 Code',
  DATASET:         '🗄 Dataset',
  MESSAGE:         '✉️  Message',
  API_RESPONSE:    '🔌 API Response',
  DATABASE_RECORD: '🗃 DB Record',
}

type ValidationIssue = {
  severity: 'error' | 'warning'
  code: string
  message: string
  nodeId?: string
}

type WorkflowOutput = {
  nodeId: string
  nodeLabel: string
  nodeType: string
  outputType?: string
}

function validateWorkflow(
  nodes: { id: string; data: { label: string; nodeType: string; config?: Record<string, unknown> } }[],
  edges: { source: string; target: string }[],
): { issues: ValidationIssue[]; outputs: WorkflowOutput[] } {
  const issues: ValidationIssue[] = []

  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  for (const n of nodes) { outgoing.set(n.id, []); incoming.set(n.id, []) }
  for (const e of edges) {
    outgoing.get(e.source)?.push(e.target)
    incoming.get(e.target)?.push(e.source)
  }

  const sourceNodes = nodes.filter(n => SOURCE_NODE_TYPES.has(n.data.nodeType))
  const terminalNodes = nodes.filter(n => TERMINAL_NODE_TYPES.has(n.data.nodeType))

  // ── Error rules ──
  if (sourceNodes.length === 0) {
    issues.push({ severity: 'error', code: 'NO_START', message: 'No Start node found. Drag a Start node from the Boundary palette group.' })
  }
  if (terminalNodes.length === 0) {
    issues.push({ severity: 'error', code: 'NO_TERMINAL', message: 'No terminal node found. Add an End, Data Sink, Create Artifact, or Signal Emit node.' })
  }
  if (sourceNodes.length > 1) {
    issues.push({ severity: 'warning', code: 'MULTIPLE_STARTS', message: `${sourceNodes.length} Start nodes found. Workflows typically have one entry point.` })
  }

  for (const n of sourceNodes) {
    if ((outgoing.get(n.id) ?? []).length === 0) {
      issues.push({ severity: 'error', code: 'START_NO_OUTGOING', message: `"${n.data.label}" (Start) has no outgoing edges — nothing will execute.`, nodeId: n.id })
    }
  }

  for (const n of terminalNodes) {
    if ((incoming.get(n.id) ?? []).length === 0) {
      issues.push({ severity: 'error', code: 'TERMINAL_NO_INCOMING', message: `"${n.data.label}" (${NODE_LABELS[n.data.nodeType] ?? n.data.nodeType}) has no incoming edges — it is unreachable.`, nodeId: n.id })
    }
  }

  // Orphan check: non-source, non-terminal nodes with no edges at all
  for (const n of nodes) {
    if (SOURCE_NODE_TYPES.has(n.data.nodeType) || TERMINAL_NODE_TYPES.has(n.data.nodeType)) continue
    const hasIn = (incoming.get(n.id) ?? []).length > 0
    const hasOut = (outgoing.get(n.id) ?? []).length > 0
    if (!hasIn && !hasOut) {
      issues.push({ severity: 'error', code: 'ORPHAN', message: `"${n.data.label}" has no connections — it will never execute.`, nodeId: n.id })
    } else if (hasIn && !hasOut) {
      issues.push({ severity: 'error', code: 'DEAD_END', message: `"${n.data.label}" has incoming edges but no outgoing edges — the workflow will stall here.`, nodeId: n.id })
    }
  }

  // Reachability: BFS from all source nodes
  if (sourceNodes.length > 0) {
    const visited = new Set<string>()
    const queue = [...sourceNodes.map(n => n.id)]
    while (queue.length) {
      const id = queue.shift()!
      if (visited.has(id)) continue
      visited.add(id)
      for (const next of outgoing.get(id) ?? []) queue.push(next)
    }
    for (const n of nodes) {
      if (!visited.has(n.id) && !SOURCE_NODE_TYPES.has(n.data.nodeType)) {
        issues.push({ severity: 'warning', code: 'UNREACHABLE', message: `"${n.data.label}" is not reachable from any Start node.`, nodeId: n.id })
      }
    }
  }

  // ── Warning rules ──
  for (const n of nodes) {
    const cfg = n.data.config ?? {}
    if (n.data.nodeType === 'TOOL_REQUEST' && !cfg.toolId) {
      issues.push({ severity: 'warning', code: 'MISSING_CONFIG', message: `"${n.data.label}" (Tool Request) has no tool selected.`, nodeId: n.id })
    }
    if (n.data.nodeType === 'AGENT_TASK' && !cfg.agentId) {
      issues.push({ severity: 'warning', code: 'MISSING_CONFIG', message: `"${n.data.label}" (Agent Task) has no agent selected.`, nodeId: n.id })
    }
    if (n.data.nodeType === 'WORKBENCH_TASK') {
      for (const message of validateWorkbenchConfig(cfg)) {
        issues.push({ severity: 'warning', code: 'MISSING_CONFIG', message: `"${n.data.label}" (Workbench Task) ${message}`, nodeId: n.id })
      }
    }
    if (n.data.nodeType === 'TIMER' && !cfg.durationMs && !cfg.fireAt) {
      issues.push({ severity: 'warning', code: 'MISSING_CONFIG', message: `"${n.data.label}" (Timer) has no duration or fire-at time configured.`, nodeId: n.id })
    }
    if (n.data.nodeType === 'SIGNAL_WAIT' && !cfg.signalName) {
      issues.push({ severity: 'warning', code: 'MISSING_CONFIG', message: `"${n.data.label}" (Signal Wait) has no signal name configured.`, nodeId: n.id })
    }
    if (n.data.nodeType === 'SIGNAL_EMIT' && !cfg.signalName) {
      issues.push({ severity: 'warning', code: 'MISSING_CONFIG', message: `"${n.data.label}" (Signal Emit) has no signal name configured.`, nodeId: n.id })
    }
    if (n.data.nodeType === 'DECISION_GATE') {
      const outCount = (outgoing.get(n.id) ?? []).length
      if (outCount < 2) {
        issues.push({ severity: 'warning', code: 'DECISION_ONE_BRANCH', message: `"${n.data.label}" (Decision Gate) has only ${outCount} outgoing branch — add at least 2 conditional edges.`, nodeId: n.id })
      }
    }
  }

  // ── Derive workflow outputs ──
  const outputs: WorkflowOutput[] = terminalNodes.map(n => {
    const cfg = n.data.config ?? {}
    let outputType: string | undefined
    if (n.data.nodeType === 'DATA_SINK') {
      const kind = (cfg.sinkConfig as { kind?: string })?.kind ?? cfg.kind as string
      if (kind === 'ARTIFACT') outputType = 'ARTIFACT'
      else if (kind === 'DB_EVENT') outputType = 'DATABASE_RECORD'
      else if (kind === 'CONNECTOR') outputType = 'API_RESPONSE'
    } else if (n.data.nodeType === 'CONSUMABLE_CREATION') {
      outputType = (cfg.consumableOutputType as string) ?? cfg.artifactType as string ?? 'ARTIFACT'
    }
    return { nodeId: n.id, nodeLabel: n.data.label, nodeType: n.data.nodeType, outputType }
  })

  return { issues, outputs }
}

function validateWorkbenchConfig(cfg: Record<string, unknown>): string[] {
  const messages: string[] = []
  const workbench = cfg.workbench && typeof cfg.workbench === 'object' && !Array.isArray(cfg.workbench)
    ? cfg.workbench as Record<string, unknown>
    : {}
  const bindings = workbench.agentBindings && typeof workbench.agentBindings === 'object' && !Array.isArray(workbench.agentBindings)
    ? workbench.agentBindings as Record<string, unknown>
    : {}
  const loop = workbench.loopDefinition && typeof workbench.loopDefinition === 'object' && !Array.isArray(workbench.loopDefinition)
    ? workbench.loopDefinition as Record<string, unknown>
    : {}
  const stages = Array.isArray(loop.stages) ? loop.stages.filter((stage): stage is Record<string, unknown> => Boolean(stage) && typeof stage === 'object' && !Array.isArray(stage)) : []
  const keys = stages.map(stage => String(stage.key ?? '').trim()).filter(Boolean)
  const keySet = new Set(keys)

  if (workbench.profile !== 'blueprint') messages.push('must use the blueprint profile.')
  if (typeof workbench.goal !== 'string' || !workbench.goal.trim()) messages.push('needs a goal.')
  if (workbench.sourceType !== 'github' && workbench.sourceType !== 'localdir') messages.push('needs a source type.')
  if (typeof workbench.capabilityId !== 'string' || !workbench.capabilityId.trim()) messages.push('needs a capability.')
  if (stages.length === 0) messages.push('needs at least one loop phase.')
  if (keys.length !== keySet.size) messages.push('has duplicate phase keys.')
  if (stages.filter(stage => stage.terminal === true).length !== 1) messages.push('must have exactly one terminal phase.')
  for (const stage of stages) {
    const key = String(stage.key ?? '').trim()
    if (!key) messages.push('has a phase without a key.')
    if (typeof stage.label !== 'string' || !stage.label.trim()) messages.push(`${key || 'a phase'} needs a label.`)
    if (typeof stage.agentRole !== 'string' || !stage.agentRole.trim()) messages.push(`${key || 'a phase'} needs an agent role.`)
    if ((typeof stage.agentTemplateId !== 'string' || !stage.agentTemplateId.trim()) && !workflowFallbackAgentForStage(bindings, stage)) {
      messages.push(`${key || 'a phase'} needs a phase agent or default fallback agent.`)
    }
    if (stage.next && typeof stage.next === 'string' && !keySet.has(stage.next)) messages.push(`${key} points to missing next phase ${stage.next}.`)
    const sendBacks = Array.isArray(stage.allowedSendBackTo) ? stage.allowedSendBackTo : []
    for (const target of sendBacks) {
      if (typeof target !== 'string' || !keySet.has(target)) messages.push(`${key} has an invalid send-back target.`)
    }
    const artifacts = Array.isArray(stage.expectedArtifacts) ? stage.expectedArtifacts : []
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) continue
      if (typeof artifact.kind !== 'string' || !artifact.kind.trim() || typeof artifact.title !== 'string' || !artifact.title.trim()) {
        messages.push(`${key} has an incomplete artifact definition.`)
      }
    }
  }
  return messages
}

function workflowFallbackAgentForStage(bindings: Record<string, unknown>, stage: Record<string, unknown>) {
  const role = String(stage.agentRole ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  const architect = typeof bindings.architectAgentTemplateId === 'string' ? bindings.architectAgentTemplateId.trim() : ''
  const developer = typeof bindings.developerAgentTemplateId === 'string' ? bindings.developerAgentTemplateId.trim() : ''
  const qa = typeof bindings.qaAgentTemplateId === 'string' ? bindings.qaAgentTemplateId.trim() : ''
  if (role.includes('DEV') || role === 'ENGINEER') return developer || architect || qa
  if (role.includes('QA') || role.includes('TEST') || role.includes('VERIFY')) return qa || developer || architect
  return architect || developer || qa
}

// ─────────────────────────────────────────────────────────────────────────────

const NODE_DESCRIPTIONS: Record<string, string> = {
  START: 'Entry point of the workflow. Execution begins here when the workflow is started. One Start node is required.',
  END: 'Terminal node. When all paths reach an End node, the workflow instance is marked completed.',
  HUMAN_TASK: 'A task that must be completed by a human. Supports assignment, due dates, and approval gates.',
  AGENT_TASK: 'Delegates work to an AI agent. Output always requires human review before promotion.',
  WORKBENCH_TASK: 'Opens an interactive workbench loop and waits for the approved final implementation pack.',
  APPROVAL: 'Requires an explicit approval decision before the workflow can proceed.',
  DECISION_GATE: 'XOR gateway — evaluates conditions to branch the workflow along one path.',
  CONSUMABLE_CREATION: 'Produces a typed versioned artifact. Must be reviewed before downstream use.',
  TOOL_REQUEST: 'Routes a tool execution request through the Tool Gateway with policy enforcement.',
  POLICY_CHECK: 'Evaluates a named policy before continuing. Blocks the workflow if denied.',
  TIMER: 'Pauses the flow for a fixed duration or until a specific instant.',
  SIGNAL_WAIT: 'Pauses execution until an external signal with a matching name arrives.',
  SIGNAL_EMIT: 'Broadcasts a named signal, waking any SIGNAL_WAIT node listening for it.',
  CALL_WORKFLOW: 'Spawns a child run of another workflow. Parent advances when child completes.',
  WORK_ITEM: 'Delegates work to one or more child capabilities, waits for child runs, then asks parent approval.',
  FOREACH: 'Iterates over a collection. Each item produces one branch of execution.',
  PARALLEL_FORK: 'AND-split gateway. All outgoing branches fire simultaneously.',
  PARALLEL_JOIN: 'AND-join gateway. Waits until ALL incoming parallel branches have arrived.',
  INCLUSIVE_GATEWAY: 'OR-gateway: all outgoing branches whose conditions are true fire simultaneously.',
  EVENT_GATEWAY: 'First-to-fire gateway: whichever SIGNAL_WAIT or TIMER fires first wins.',
  DATA_SINK: 'Writes workflow data to an external system: Connector, DB event, or artifact.',
  SET_CONTEXT: 'Sets or overwrites variables in the workflow context for downstream nodes.',
  ERROR_CATCH: 'Catches failures from an upstream node via an ERROR_BOUNDARY edge.',
}

const NODE_STATUS_COLOR: Record<string, string> = {
  PENDING: '#475569', ACTIVE: '#22c55e', COMPLETED: '#4ade80',
  FAILED: '#f87171', SKIPPED: '#64748b', BLOCKED: '#fbbf24',
}

const INSTANCE_STATUS_COLOR: Record<string, string> = {
  DRAFT: '#64748b', ACTIVE: '#22c55e', PAUSED: '#f59e0b',
  COMPLETED: '#4ade80', CANCELLED: '#ef4444', FAILED: '#dc2626',
}

// ─── Custom icon map ──────────────────────────────────────────────────────────

export const ALL_CUSTOM_ICONS: Record<string, React.ElementType> = {
  Box, Bot, User, CheckCircle, GitMerge, Package, Wrench, Shield, GitBranch,
  Star, Briefcase: BriefcaseIcon, Database, Globe, Mail, Phone,
  Calendar, AlertTriangle, Search, Filter, Activity,
  Clock, Radio, RadioTower, Workflow, Repeat, Shuffle, Zap,
  GitFork, ShieldAlert, SlidersHorizontal,
}

// ─── Decorator types ──────────────────────────────────────────────────────────

type DecoratorEntry = { id: string; type: string; label: string }

const DECORATOR_OPTIONS = [
  { type: 'TIMER',        label: 'Timer' },
  { type: 'TOOL_REQUEST', label: 'Tool Request' },
  { type: 'SIGNAL_WAIT',  label: 'Signal Wait' },
]

// ─── Node context (gives WGNode access to callbacks) ─────────────────────────

type WFNodeCtx = {
  onDelete: (nodeId: string) => void
  onAddDecorator: (nodeId: string, type: string, label: string) => void
  onRemoveDecorator: (nodeId: string, decId: string) => void
  theme: 'light' | 'dark'
}
const WFNodeContext = createContext<WFNodeCtx>({
  onDelete: () => {}, onAddDecorator: () => {}, onRemoveDecorator: () => {}, theme: 'dark',
})

// ─── Rich canvas node card ────────────────────────────────────────────────────

function WGNode({ data, selected, id }: NodeProps<NodeData>) {
  const { onDelete, onAddDecorator, onRemoveDecorator, theme } = useContext(WFNodeContext)
  const [decPickerOpen, setDecPickerOpen] = useState(false)
  const [showNodeTypeTip, setShowNodeTypeTip] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  // Close picker when clicking outside
  useEffect(() => {
    if (!decPickerOpen) return
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && e.target instanceof Element && !pickerRef.current.contains(e.target)) {
        setDecPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [decPickerOpen])

  let vis = NODE_VISUAL[data.nodeType] ?? { color: '#64748b', Icon: GitBranch }
  if (data.nodeType === 'CUSTOM') {
    const cfg = (data.config ?? {}) as Record<string, unknown>
    const customColor = typeof cfg._customTypeColor === 'string' ? cfg._customTypeColor : '#64748b'
    const customIconName = typeof cfg._customTypeIcon === 'string' ? cfg._customTypeIcon : null
    const CustomIcon = (customIconName && ALL_CUSTOM_ICONS[customIconName]) ? ALL_CUSTOM_ICONS[customIconName] : Box
    vis = { color: customColor, Icon: CustomIcon }
  }
  const { color, Icon } = vis

  const statusColor = NODE_STATUS_COLOR[data.status] ?? '#475569'
  const showStatus  = data.status && data.status !== 'PENDING'
  const inputs      = data.config?.inputArtifacts  ?? []
  const outputs     = data.config?.outputArtifacts ?? []
  const attachments = data.config?.attachments ?? []
  const description = data.config?.description ?? ''
  const std         = data.config?.standard ?? {}
  const role        = std.role || std.assignee || std.agentId || ''
  const decorators: DecoratorEntry[] = ((data.config as Record<string, unknown>)?._decorators as DecoratorEntry[]) ?? []

  const hasTimer  = data.nodeType === 'TIMER' || attachments.some(a => a.enabled !== false && (a.type === 'timer' || a.trigger === 'deadline'))
  const hasTools  = data.nodeType === 'TOOL_REQUEST' || attachments.some(a => a.enabled !== false && a.type === 'tool')
  const hasNotify = attachments.some(a => a.enabled !== false && a.type === 'notification')

  const isLight = theme === 'light'
  const cardBg  = isLight ? '#ffffff' : 'rgba(7,17,31,0.96)'
  const cardBdr = selected
    ? `1.5px solid ${color}`
    : isLight ? '1.5px solid rgba(15,23,42,0.08)' : '1.5px solid rgba(255,255,255,0.09)'
  const shadow  = selected
    ? `0 0 0 3px ${color}30, 0 12px 36px rgba(2,6,23,0.34)`
    : isLight
      ? '0 8px 32px rgba(2,6,23,0.14), 0 1px 0 rgba(255,255,255,0.9) inset'
      : '0 8px 32px rgba(0,0,0,0.55)'
  const nameClr = isLight ? '#0f172a' : '#f1f5f9'
  const subClr  = isLight ? '#94a3b8' : '#475569'
  const descClr = isLight ? '#64748b' : '#475569'

  return (
    <div
      style={{
        background: cardBg, border: cardBdr,
        borderRadius: 22, minWidth: 232, maxWidth: 264,
        boxShadow: shadow,
        backdropFilter: 'blur(20px)',
        overflow: 'visible', transition: 'border-color 0.15s, box-shadow 0.15s',
        position: 'relative',
      }}
    >
      {/* Accent strip */}
      <div style={{ height: 3, background: `linear-gradient(90deg, ${color}, ${color}60, transparent)` }} />

      <Handle type="target" position={Position.Left}
        style={{ background: color, width: 12, height: 12, border: `3px solid ${cardBg}`, left: -6, top: '50%' }} />

      {/* ── Header ── */}
      <div style={{ padding: '10px 12px 8px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 11, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${color}16`, border: `1.5px solid ${color}30`,
        }}>
          <Icon style={{ width: 16, height: 16, color }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            fontSize: 12, fontWeight: 700, color: nameClr, lineHeight: 1.3, marginBottom: 2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {data.label}
          </p>
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <p
              style={{ fontSize: 9, color: subClr, textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 700, cursor: 'help', display: 'flex', alignItems: 'center', gap: 3 }}
              onMouseEnter={() => setShowNodeTypeTip(true)}
              onMouseLeave={() => setShowNodeTypeTip(false)}
            >
              {NODE_LABELS[data.nodeType] ?? data.nodeType}
              <HelpCircle size={9} style={{ opacity: 0.5, flexShrink: 0 }} />
            </p>
            {showNodeTypeTip && NODE_DESCRIPTIONS[data.nodeType] && (
              <div style={{
                position: 'absolute', bottom: '100%', left: 0, marginBottom: 6,
                zIndex: 999, width: 220, pointerEvents: 'none',
                background: '#1e293b', border: '1px solid #334155',
                borderRadius: 10, padding: '8px 10px',
                boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
              }}>
                <p style={{ fontSize: 9, fontWeight: 700, color: color, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  {NODE_LABELS[data.nodeType] ?? data.nodeType}
                </p>
                <p style={{ fontSize: 10, color: '#cbd5e1', lineHeight: 1.5, margin: 0 }}>
                  {NODE_DESCRIPTIONS[data.nodeType]}
                </p>
              </div>
            )}
          </div>
        </div>
        <button
          onClick={e => { e.stopPropagation(); onDelete(id) }}
          title="Remove node"
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '3px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: isLight ? '#cbd5e1' : '#334155', borderRadius: 6, flexShrink: 0, marginTop: -1,
            transition: 'color 0.12s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#ef4444' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = isLight ? '#cbd5e1' : '#334155' }}
        >
          <X size={13} />
        </button>
      </div>

      {/* ── Status + role ── */}
      <div style={{ padding: '0 12px 8px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5 }}>
        <span style={{
          fontSize: 8, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.14em',
          padding: '3px 8px', borderRadius: 6,
          background: showStatus ? `${statusColor}14` : `${color}12`,
          color: showStatus ? statusColor : color,
          border: `1px solid ${showStatus ? `${statusColor}28` : `${color}28`}`,
        }}>
          {showStatus ? data.status : (NODE_LABELS[data.nodeType]?.split(' ')[0] ?? 'NODE')}
        </span>
        {role && (
          <span style={{
            fontSize: 8, padding: '3px 7px', borderRadius: 6, maxWidth: 110,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            background: isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)',
            color: isLight ? '#64748b' : '#94a3b8',
            border: `1px solid ${isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)'}`,
          }}>
            {role}
          </span>
        )}
      </div>

      {/* ── Inline artifacts ── */}
      {(inputs.length > 0 || outputs.length > 0) && (
        <div style={{ padding: '0 12px 8px', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {inputs.length > 0 && (
            <p style={{ fontSize: 9, color: '#38bdf8', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span style={{ fontWeight: 700 }}>In: </span>
              {inputs.slice(0, 2).map(a => a.name || a.artifactType).filter(Boolean).join(', ') || 'Defined'}
              {inputs.length > 2 && <span style={{ opacity: 0.7 }}> +{inputs.length - 2}</span>}
            </p>
          )}
          {outputs.length > 0 && (
            <p style={{ fontSize: 9, color: '#34d399', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span style={{ fontWeight: 700 }}>Out: </span>
              {outputs.slice(0, 2).map(a => a.name || a.artifactType).filter(Boolean).join(', ') || 'Defined'}
              {outputs.length > 2 && <span style={{ opacity: 0.7 }}> +{outputs.length - 2}</span>}
            </p>
          )}
        </div>
      )}

      {/* ── Description ── */}
      {description && (
        <div style={{ padding: '0 12px 10px' }}>
          <p style={{
            fontSize: 10, color: descClr, lineHeight: 1.55,
            overflow: 'hidden', display: '-webkit-box',
            WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          }}>
            {description}
          </p>
        </div>
      )}

      {/* ── Decorator badges ── */}
      {decorators.length > 0 && (
        <div style={{ padding: '0 12px 6px', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {decorators.map(dec => {
            const dv = NODE_VISUAL[dec.type] ?? { color: '#64748b', Icon: GitBranch }
            const DIcon = dv.Icon
            return (
              <span key={dec.id} style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                padding: '2px 6px 2px 4px', borderRadius: 8,
                background: `${dv.color}14`, border: `1px solid ${dv.color}35`,
                fontSize: 9, color: dv.color, fontWeight: 700,
              }}>
                <DIcon size={9} style={{ color: dv.color, flexShrink: 0 }} />
                {dec.label}
                <button
                  onClick={e => { e.stopPropagation(); onRemoveDecorator(id, dec.id) }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginLeft: 1, color: 'inherit', opacity: 0.6, display: 'flex', lineHeight: 1 }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '1' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.6' }}
                  title={`Remove ${dec.label}`}
                >
                  <X size={8} />
                </button>
              </span>
            )
          })}
        </div>
      )}

      {/* ── Footer ── */}
      <div style={{
        padding: '6px 12px 8px',
        borderTop: `1px solid ${isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.05)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {inputs.length > 0 && (
            <span style={{
              fontSize: 8, padding: '2px 7px', borderRadius: 5, fontWeight: 700,
              background: 'rgba(56,189,248,0.1)', color: '#38bdf8', border: '1px solid rgba(56,189,248,0.18)',
            }}>In</span>
          )}
          {outputs.length > 0 && (
            <span style={{
              fontSize: 8, padding: '2px 7px', borderRadius: 5, fontWeight: 700,
              background: 'rgba(52,211,153,0.1)', color: '#34d399', border: '1px solid rgba(52,211,153,0.18)',
            }}>Out</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {hasTimer && (
            <span title="Deadline / timer" style={{
              fontSize: 7, padding: '1px 5px', borderRadius: 4, fontWeight: 700,
              background: 'rgba(251,191,36,0.12)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.2)',
              display: 'flex', alignItems: 'center', gap: 2,
            }}>
              <Clock size={7} />
            </span>
          )}
          {hasTools && (
            <span title="Tool attachment" style={{
              fontSize: 7, padding: '1px 5px', borderRadius: 4, fontWeight: 700,
              background: 'rgba(251,146,60,0.12)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.2)',
              display: 'flex', alignItems: 'center', gap: 2,
            }}>
              <Wrench size={7} />
            </span>
          )}
          {hasNotify && (
            <span title="Notification" style={{
              fontSize: 7, padding: '1px 5px', borderRadius: 4, fontWeight: 700,
              background: 'rgba(56,189,248,0.12)', color: '#38bdf8', border: '1px solid rgba(56,189,248,0.2)',
              display: 'flex', alignItems: 'center', gap: 2,
            }}>
              <Radio size={7} />
            </span>
          )}
          {showStatus && (
            <div style={{
              width: 8, height: 8, borderRadius: '50%', background: statusColor,
              boxShadow: `0 0 6px ${statusColor}90`,
            }} />
          )}
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, opacity: 0.4 }} />

          {/* + DEC button */}
          <div ref={pickerRef} style={{ position: 'relative' }}>
            <button
              onClick={e => { e.stopPropagation(); setDecPickerOpen(o => !o) }}
              title="Attach decorator"
              style={{
                fontSize: 7, padding: '2px 5px', borderRadius: 5, fontWeight: 800,
                background: decPickerOpen ? `${color}22` : 'transparent',
                border: `1px solid ${decPickerOpen ? color : (isLight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.14)')}`,
                color: decPickerOpen ? color : (isLight ? '#94a3b8' : '#475569'),
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2,
                transition: 'all 0.12s',
              }}
              onMouseEnter={e => {
                if (!decPickerOpen) {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = color
                  ;(e.currentTarget as HTMLButtonElement).style.color = color
                }
              }}
              onMouseLeave={e => {
                if (!decPickerOpen) {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = isLight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.14)'
                  ;(e.currentTarget as HTMLButtonElement).style.color = isLight ? '#94a3b8' : '#475569'
                }
              }}
            >
              <Plus size={7} /> DEC
            </button>

            {decPickerOpen && (
              <div
                onClick={e => e.stopPropagation()}
                style={{
                  position: 'absolute', bottom: '100%', right: 0, marginBottom: 4,
                  background: isLight ? '#ffffff' : 'rgba(7,17,31,0.97)',
                  border: `1px solid ${isLight ? 'rgba(148,163,184,0.3)' : 'rgba(255,255,255,0.1)'}`,
                  borderRadius: 10, padding: '4px 0',
                  boxShadow: isLight ? '0 8px 24px rgba(15,23,42,0.14)' : '0 8px 24px rgba(0,0,0,0.5)',
                  zIndex: 1000, minWidth: 130,
                }}
              >
                {DECORATOR_OPTIONS.filter(opt =>
                  !decorators.some(d => d.type === opt.type)
                ).map(opt => {
                  const ov = NODE_VISUAL[opt.type] ?? { color: '#64748b', Icon: GitBranch }
                  const OIcon = ov.Icon
                  return (
                    <button
                      key={opt.type}
                      onClick={() => { onAddDecorator(id, opt.type, opt.label); setDecPickerOpen(false) }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 7,
                        width: '100%', padding: '7px 10px', border: 'none', background: 'none',
                        cursor: 'pointer', color: isLight ? '#1e293b' : '#e2e8f0', fontSize: 11, fontWeight: 600,
                        textAlign: 'left', transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.07)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'none' }}
                    >
                      <OIcon size={11} style={{ color: ov.color, flexShrink: 0 }} />
                      {opt.label}
                    </button>
                  )
                })}
                {DECORATOR_OPTIONS.every(opt => decorators.some(d => d.type === opt.type)) && (
                  <p style={{ fontSize: 10, color: isLight ? '#94a3b8' : '#475569', padding: '6px 10px', margin: 0 }}>All attached</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <Handle type="source" position={Position.Right}
        style={{ background: color, width: 12, height: 12, border: `3px solid ${cardBg}`, right: -6, top: '50%' }} />
    </div>
  )
}

const nodeTypes: NodeTypes = { wgNode: WGNode }

// ─── Palette icon (draggable) ─────────────────────────────────────────────────

function PaletteIcon({
  nodeType, color, Icon, label, dragPayload, actualNodeType,
}: {
  nodeType: string; color: string; Icon: React.ElementType
  label: string; dragPayload?: string
  actualNodeType?: string
}) {
  const [showTip, setShowTip] = useState(false)
  const description = NODE_DESCRIPTIONS[nodeType] ?? ''

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('application/wg-node-type', actualNodeType ?? nodeType)
    if (dragPayload) e.dataTransfer.setData('application/wg-node-payload', dragPayload)
    e.dataTransfer.effectAllowed = 'copy'
    setShowTip(false)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <div
        draggable onDragStart={onDragStart}
        onMouseEnter={e => {
          setShowTip(true)
          ;(e.currentTarget as HTMLDivElement).style.background = `${color}26`
          ;(e.currentTarget as HTMLDivElement).style.border = `1px solid ${color}55`
        }}
        onMouseLeave={e => {
          setShowTip(false)
          ;(e.currentTarget as HTMLDivElement).style.background = `${color}14`
          ;(e.currentTarget as HTMLDivElement).style.border = `1px solid ${color}28`
        }}
        style={{
          width: 40, height: 40, borderRadius: 12, cursor: 'grab',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${color}14`, border: `1px solid ${color}28`, transition: 'all 0.12s', position: 'relative',
        }}
      >
        <Icon style={{ width: 16, height: 16, color }} />
        {showTip && (
          <div style={{
            position: 'absolute', left: 48, top: '50%', transform: 'translateY(-50%)',
            zIndex: 100, width: 220, pointerEvents: 'none',
            background: '#1e293b', border: '1px solid #334155',
            borderRadius: 10, padding: '8px 10px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: '#f1f5f9', marginBottom: description ? 4 : 0 }}>
              {label}
            </p>
            {description && (
              <p style={{ fontSize: 10, color: '#94a3b8', lineHeight: 1.5, margin: 0 }}>
                {description}
              </p>
            )}
          </div>
        )}
      </div>
      <span style={{
        fontSize: 9, fontWeight: 600, color: '#94a3b8', textAlign: 'center',
        maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {label}
      </span>
    </div>
  )
}

// ─── Node Help Panel ─────────────────────────────────────────────────────────

const NODE_HELP_SECTIONS = [
  {
    title: 'Core Task Nodes',
    types: ['HUMAN_TASK', 'AGENT_TASK', 'APPROVAL'],
  },
  {
    title: 'Branching & Control',
    types: ['DECISION_GATE', 'PARALLEL_FORK', 'PARALLEL_JOIN', 'INCLUSIVE_GATEWAY', 'EVENT_GATEWAY'],
  },
  {
    title: 'Data & State',
    types: ['SET_CONTEXT', 'DATA_SINK', 'ERROR_CATCH'],
  },
  {
    title: 'Async & Timing',
    types: ['SIGNAL_WAIT', 'SIGNAL_EMIT', 'TIMER'],
  },
  {
    title: 'Task & Execution',
    types: ['FOREACH', 'WORK_ITEM', 'CALL_WORKFLOW', 'TOOL_REQUEST', 'POLICY_CHECK', 'CREATE_ARTIFACT'],
  },
]

const NODE_USAGE_TIPS: Record<string, string> = {
  HUMAN_TASK:        'Set a due date and assignee. Use role field to filter by team role.',
  AGENT_TASK:        'Downstream nodes read output via output.agentResponse. Requires human review in v1.',
  WORKBENCH_TASK:    'Opens a modal workbench loop and completes only after the final pack is approved.',
  APPROVAL:          'Set Min Approvals > 1 for committee gates. Use Escalate To for timeout handling.',
  DECISION_GATE:     'Write JS expressions like output.score > 0.8 or context.status == "active".',
  PARALLEL_FORK:     'Connect to multiple nodes — all branches fire at once. Follow with Parallel Join.',
  PARALLEL_JOIN:     'Set Expected Branches to exactly match the number of paths from the fork.',
  INCLUSIVE_GATEWAY: 'Define conditions on edges. Any edge whose condition is true will fire.',
  EVENT_GATEWAY:     'Connect to SIGNAL_WAIT and TIMER nodes. First to fire wins; others are cancelled.',
  SET_CONTEXT:       'Use {{ context.path }} syntax to copy values. Supports dot-notation for nesting.',
  DATA_SINK:         'Use ARTIFACT kind for versioned outputs that need human review and sign-off.',
  ERROR_CATCH:       'Draw an ERROR_BOUNDARY edge (not a normal edge) from the failing node into this.',
  SIGNAL_WAIT:       'External system calls POST /workflow-instances/:id/signals/:name to wake it.',
  SIGNAL_EMIT:       'Use Correlation Key to target a specific instance rather than all listeners.',
  TIMER:             'Use "30s", "5m", "2h" format for Duration, or ISO datetime for Until.',
  FOREACH:           'Set Parallel=true + Max Concurrency to process items in batches.',
  WORK_ITEM:         'Creates a child capability queue item. Parent waits for child outputs and approval.',
  CALL_WORKFLOW:     'Parent workflow pauses until child completes. Child result is in context.',
  TOOL_REQUEST:      'High-risk tools may auto-pause for approval before execution.',
  POLICY_CHECK:      'Use WARN mode during testing — it logs failures without blocking the workflow.',
  CREATE_ARTIFACT:   'If Requires Approval is true, workflow pauses until a human reviews and approves.',
}

function NodeHelpPanel({ isLight, panelText, panelMuted, panelBdr, onClose }: {
  isLight: boolean; panelText: string; panelMuted: string; panelBdr: string
  onClose: () => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <motion.div
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 16 }}
      transition={{ duration: 0.18 }}
      style={{
        position: 'absolute', top: 10, right: 10, zIndex: 60,
        width: 320, maxHeight: 'calc(100vh - 80px)',
        borderRadius: 18, border: `1px solid ${panelBdr}`,
        background: isLight ? 'rgba(255,255,255,0.97)' : 'rgba(7,17,31,0.97)',
        backdropFilter: 'blur(20px)',
        boxShadow: isLight ? '0 20px 60px rgba(0,0,0,0.14)' : '0 20px 60px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{
        padding: '12px 14px', borderBottom: `1px solid ${panelBdr}`,
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
      }}>
        <BookOpen size={15} style={{ color: '#a78bfa', flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <p style={{ fontSize: 12, fontWeight: 800, color: panelText, margin: 0 }}>Node Reference</p>
          <p style={{ fontSize: 9, color: panelMuted, margin: 0 }}>Click any node type to see details & tips</p>
        </div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: panelMuted, padding: 2, display: 'flex' }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Scrollable body */}
      <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
        {NODE_HELP_SECTIONS.map(section => (
          <div key={section.title} style={{ marginBottom: 4 }}>
            <p style={{ fontSize: 9, color: panelMuted, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', padding: '6px 14px 4px' }}>
              {section.title}
            </p>
            {section.types.map(type => {
              const vis = NODE_VISUAL[type]
              if (!vis) return null
              const { color, Icon } = vis
              const label = NODE_LABELS[type] ?? type
              const desc = NODE_DESCRIPTIONS[type] ?? ''
              const tip = NODE_USAGE_TIPS[type]
              const isOpen = expanded === type
              return (
                <div key={type}>
                  <button
                    onClick={() => setExpanded(isOpen ? null : type)}
                    style={{
                      width: '100%', padding: '8px 14px', border: 'none', background: 'transparent',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 9,
                      transition: 'background 0.1s', textAlign: 'left',
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                  >
                    <div style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `${color}14`, border: `1px solid ${color}28` }}>
                      <Icon size={13} style={{ color }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: panelText, margin: 0 }}>{label}</p>
                      <p style={{ fontSize: 9, color: panelMuted, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{desc}</p>
                    </div>
                    <ChevronDown
                      size={12}
                      style={{ color: panelMuted, flexShrink: 0, transition: 'transform 0.15s', transform: isOpen ? 'rotate(180deg)' : 'none' }}
                    />
                  </button>
                  <AnimatePresence>
                    {isOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        style={{ overflow: 'hidden' }}
                      >
                        <div style={{ padding: '4px 14px 10px 51px' }}>
                          <p style={{ fontSize: 10, color: panelMuted, lineHeight: 1.6, marginBottom: tip ? 8 : 0 }}>{desc}</p>
                          {tip && (
                            <div style={{ padding: '7px 10px', borderRadius: 8, background: `${color}10`, border: `1px solid ${color}22` }}>
                              <p style={{ fontSize: 9, color: panelMuted, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 3 }}>💡 Tip</p>
                              <p style={{ fontSize: 10, color: panelText, lineHeight: 1.5, margin: 0 }}>{tip}</p>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </motion.div>
  )
}

// ─── Floating toolbar button ──────────────────────────────────────────────────

function ToolBtn({
  icon: Icon, title, onClick, active, color,
}: {
  icon: React.ElementType; title: string; onClick?: () => void
  active?: boolean; color?: string
}) {
  const c = active ? (color ?? '#22c55e') : '#94a3b8'
  return (
    <button
      title={title} onClick={onClick}
      style={{
        width: 30, height: 30, borderRadius: 9, border: 'none',
        background: active ? `${color ?? '#22c55e'}18` : 'transparent',
        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: c, transition: 'all 0.12s',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLButtonElement).style.background = active ? `${color ?? '#22c55e'}28` : 'rgba(255,255,255,0.07)'
        ;(e.currentTarget as HTMLButtonElement).style.color = active ? c : '#e2e8f0'
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.background = active ? `${color ?? '#22c55e'}18` : 'transparent'
        ;(e.currentTarget as HTMLButtonElement).style.color = c
      }}
    >
      <Icon size={14} />
    </button>
  )
}

// ─── API types ─────────────────────────────────────────────────────────────────

type ApiNode = { id: string; label: string; nodeType: string; status: string; positionX: number; positionY: number; config?: NodeConfig }
type ApiEdge = { id: string; sourceNodeId: string; targetNodeId: string; edgeType: string; label?: string; condition?: Record<string, unknown> | null }

// ─── Draggable + Resizable Inspector Panel ────────────────────────────────────

const PANEL_MIN_W = 420
const PANEL_MIN_H = 360

type PanelGeom = { x: number; y: number; w: number; h: number }

function DraggableResizablePanel({
  children, title, isLight, glassPanel: gp, panelText, panelMuted, panelBdr,
  containerRef, onCollapse,
}: {
  children: React.ReactNode
  title: string
  isLight: boolean
  glassPanel: (l: boolean) => React.CSSProperties
  panelText: string; panelMuted: string; panelBdr: string
  containerRef: React.RefObject<HTMLDivElement | null>
  onCollapse: () => void
}) {
  const [geom, setGeom] = useState<PanelGeom | null>(null)
  const [modal, setModal] = useState(false)
  const defaultGeomRef = useRef<PanelGeom | null>(null)

  useLayoutEffect(() => {
    if (geom || !containerRef.current) return
    const { clientWidth, clientHeight } = containerRef.current
    const width = Math.min(560, Math.max(PANEL_MIN_W, Math.round(clientWidth * 0.36)))
    const g: PanelGeom = {
      x: Math.max(16, clientWidth - width - 16),
      y: 64,
      w: width,
      h: Math.max(PANEL_MIN_H, clientHeight - 84),
    }
    defaultGeomRef.current = g
    setGeom(g)
  })

  // ── Drag ────────────────────────────────────────────────────────────────────
  const startDrag = (e: React.MouseEvent) => {
    if (modal || e.button !== 0) return
    e.preventDefault()
    const g = geom!
    const sx = e.clientX, sy = e.clientY
    const onMove = (ev: MouseEvent) =>
      setGeom(prev => prev ? { ...prev, x: g.x + ev.clientX - sx, y: g.y + ev.clientY - sy } : prev)
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const resetPosition = () => { if (defaultGeomRef.current) setGeom(defaultGeomRef.current) }

  // ── Resize ──────────────────────────────────────────────────────────────────
  type Handle = 'l' | 'r' | 'b' | 'bl' | 'br'
  const startResize = (e: React.MouseEvent, handle: Handle) => {
    e.preventDefault(); e.stopPropagation()
    if (!geom) return
    const sx = e.clientX, sy = e.clientY
    const { x: gx, w: gw, h: gh } = geom
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy
      setGeom(prev => {
        if (!prev) return prev
        let { x, y, w, h } = prev
        if (handle === 'l' || handle === 'bl') {
          w = Math.max(PANEL_MIN_W, gw - dx)
          x = gx + gw - w
        }
        if (handle === 'r' || handle === 'br') w = Math.max(PANEL_MIN_W, gw + dx)
        if (handle === 'b' || handle === 'bl' || handle === 'br') h = Math.max(PANEL_MIN_H, gh + dy)
        return { x, y, w, h }
      })
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // ── Escape key closes modal ─────────────────────────────────────────────────
  useEffect(() => {
    if (!modal) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setModal(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [modal])

  if (!geom) return null

  const resizeHandle = (handle: Handle, style: React.CSSProperties) => (
    <div
      onMouseDown={e => startResize(e, handle)}
      style={{ position: 'absolute', zIndex: 5, ...style }}
    />
  )

  const cornerDots: React.CSSProperties = {
    backgroundImage: `radial-gradient(circle, ${panelBdr} 1.2px, transparent 1.2px)`,
    backgroundSize: '4px 4px',
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (modal) {
    return (
      <motion.div
        key="panel-modal-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={e => { if (e.target === e.currentTarget) setModal(false) }}
        style={{
          position: 'fixed', inset: 0, zIndex: 200,
          background: 'rgba(2,6,23,0.65)', backdropFilter: 'blur(6px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <motion.div
          initial={{ scale: 0.93, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.93, opacity: 0 }}
          transition={{ duration: 0.18, type: 'spring', stiffness: 280, damping: 28 }}
          style={{
            ...gp(isLight),
            width: 'min(1320px, 96vw)',
            height: 'min(920px, 94vh)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            borderRadius: 20,
          }}
        >
          {/* Modal header */}
          <div style={{
            padding: '16px 20px 14px', flexShrink: 0,
            borderBottom: `1px solid ${panelBdr}`,
            display: 'flex', alignItems: 'center', gap: 8,
            background: isLight ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.02)',
          }}>
            <p style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.16em', color: panelMuted, flex: 1 }}>
              {title}
            </p>
            <button
              onClick={() => setModal(false)}
              title="Exit expanded view (Esc)"
              style={{ width: 26, height: 26, borderRadius: 7, border: 'none', background: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.07)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: panelMuted, transition: 'all 0.1s' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = panelText; (e.currentTarget as HTMLButtonElement).style.background = isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.12)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = panelMuted; (e.currentTarget as HTMLButtonElement).style.background = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.07)' }}
            >
              <Minimize2 size={13} />
            </button>
            <button
              onClick={onCollapse}
              title="Close inspector"
              style={{ width: 26, height: 26, borderRadius: 7, border: 'none', background: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.07)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: panelMuted, transition: 'all 0.1s' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#ef4444'; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(239,68,68,0.1)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = panelMuted; (e.currentTarget as HTMLButtonElement).style.background = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.07)' }}
            >
              <X size={13} />
            </button>
          </div>
          <div className="node-inspector-modal-content" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {children}
          </div>
        </motion.div>
      </motion.div>
    )
  }

  return (
    <motion.div
      key="panel-floating"
      initial={{ opacity: 0, scale: 0.96, x: 10 }}
      animate={{ opacity: 1, scale: 1, x: 0 }}
      exit={{ opacity: 0, scale: 0.96, x: 10 }}
      transition={{ duration: 0.16 }}
      style={{
        position: 'absolute',
        left: geom.x, top: geom.y,
        width: geom.w, height: geom.h,
        zIndex: 20, pointerEvents: 'auto',
        ...gp(isLight),
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      {/* Drag handle header */}
      <div
        onMouseDown={startDrag}
        onDoubleClick={resetPosition}
        style={{
          padding: '13px 16px 12px', flexShrink: 0,
          borderBottom: `1px solid ${panelBdr}`,
          cursor: 'grab', userSelect: 'none',
          display: 'flex', alignItems: 'center', gap: 7,
        }}
      >
        <GripVertical size={13} style={{ color: panelMuted, flexShrink: 0, opacity: 0.5 }} />
        <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.16em', color: panelMuted, flex: 1 }}>
          {title}
        </p>
        {/* Expand to modal */}
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={() => setModal(true)}
          title="Expand to modal (full view)"
          style={{ width: 22, height: 22, borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: panelMuted, transition: 'color 0.1s', flexShrink: 0 }}
          onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.color = panelText)}
          onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.color = panelMuted)}
        >
          <Maximize2 size={12} />
        </button>
        {/* Close / collapse */}
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={onCollapse}
          title="Close inspector"
          style={{ width: 22, height: 22, borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: panelMuted, transition: 'color 0.1s', flexShrink: 0 }}
          onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.color = '#ef4444')}
          onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.color = panelMuted)}
        >
          <X size={12} />
        </button>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {children}
      </div>

      {/* ── Resize handles ── */}
      {/* Left edge */}
      {resizeHandle('l', { left: 0, top: 12, bottom: 12, width: 5, cursor: 'ew-resize' })}
      {/* Right edge */}
      {resizeHandle('r', { right: 0, top: 12, bottom: 12, width: 5, cursor: 'ew-resize' })}
      {/* Bottom edge */}
      {resizeHandle('b', { bottom: 0, left: 12, right: 12, height: 5, cursor: 'ns-resize' })}
      {/* Bottom-left corner */}
      {resizeHandle('bl', { bottom: 0, left: 0, width: 14, height: 14, cursor: 'nesw-resize' })}
      {/* Bottom-right corner — visible grip dots */}
      <div
        onMouseDown={e => startResize(e, 'br')}
        style={{
          position: 'absolute', bottom: 0, right: 0, width: 16, height: 16,
          cursor: 'nwse-resize', zIndex: 5, borderRadius: '0 0 22px 0',
          ...cornerDots,
        }}
      />
    </motion.div>
  )
}

// ─── Workflow Params Panel ────────────────────────────────────────────────────

const PARAM_TYPES = ['string', 'number', 'boolean', 'json'] as const

function newParam(): ParamDef {
  return { id: Math.random().toString(36).slice(2), key: '', label: '', type: 'string', required: false }
}

function WorkflowParamsPanel({
  params, values, isLight, glassPanel, panelText, panelMuted, panelBdr, saving,
  onClose, onSave,
}: {
  params: ParamDef[]
  values: Record<string, unknown>
  isLight: boolean
  glassPanel: (l: boolean) => React.CSSProperties
  panelText: string; panelMuted: string; panelBdr: string
  saving: boolean
  onClose: () => void
  onSave: (defs: ParamDef[], values: Record<string, unknown>) => void
}) {
  const [defs, setDefs] = useState<ParamDef[]>(params)
  const [vals, setVals] = useState<Record<string, unknown>>(values)

  // Sync when external data changes
  useEffect(() => { setDefs(params) }, [params.length])
  useEffect(() => { setVals(values) }, [JSON.stringify(values)])

  const addParam = () => setDefs(d => [...d, newParam()])
  const removeParam = (id: string) => setDefs(d => d.filter(p => p.id !== id))
  const updateParam = (id: string, patch: Partial<ParamDef>) =>
    setDefs(d => d.map(p => p.id === id ? { ...p, ...patch } : p))

  const inputSt: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '6px 9px', borderRadius: 7,
    fontSize: 11, border: `1px solid ${panelBdr}`,
    background: isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)',
    color: panelText, outline: 'none',
  }

  return (
    <motion.div
      key="params-panel"
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -16 }}
      transition={{ duration: 0.18 }}
      style={{
        position: 'absolute', left: 68, top: 72, bottom: 12,
        width: 340, zIndex: 25, pointerEvents: 'auto',
        ...glassPanel(isLight),
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ padding: '14px 16px 10px', borderBottom: `1px solid ${panelBdr}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 26, height: 26, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(167,139,250,0.14)', border: '1px solid rgba(167,139,250,0.3)',
            }}>
              <SlidersHorizontal size={12} style={{ color: '#a78bfa' }} />
            </div>
            <p style={{ fontSize: 11, fontWeight: 700, color: panelText }}>Workflow Parameters</p>
          </div>
          <button
            onClick={onClose}
            style={{ width: 24, height: 24, borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: panelMuted }}
          >
            <X size={12} />
          </button>
        </div>
        <p style={{ fontSize: 10, color: panelMuted, marginTop: 6, lineHeight: 1.6 }}>
          Define typed parameters. Reference them in branch conditions as <span style={{ fontFamily: 'monospace', color: '#a78bfa' }}>params.key</span>
        </p>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
        {defs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '28px 0', color: panelMuted, fontSize: 11 }}>
            No parameters defined yet.<br />Click "+ Add Parameter" below.
          </div>
        ) : (
          defs.map(p => (
            <div key={p.id} style={{
              borderRadius: 10, border: `1px solid ${panelBdr}`,
              background: isLight ? 'rgba(0,0,0,0.02)' : 'rgba(255,255,255,0.03)',
              padding: '10px 12px', marginBottom: 8,
            }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 7 }}>
                <input
                  value={p.key}
                  onChange={e => updateParam(p.id, { key: e.target.value })}
                  placeholder="key"
                  style={{ ...inputSt, flex: 1, fontFamily: 'monospace', fontSize: 11 }}
                />
                <input
                  value={p.label}
                  onChange={e => updateParam(p.id, { label: e.target.value })}
                  placeholder="Label"
                  style={{ ...inputSt, flex: 2 }}
                />
                <button
                  onClick={() => removeParam(p.id)}
                  style={{ width: 26, height: 26, borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', color: panelMuted, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.color = '#ef4444')}
                  onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.color = panelMuted)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <select
                  value={p.type}
                  onChange={e => updateParam(p.id, { type: e.target.value as ParamDef['type'] })}
                  style={{ ...inputSt, flex: 1 }}
                >
                  {PARAM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: panelMuted, cursor: 'pointer', flexShrink: 0 }}>
                  <input
                    type="checkbox"
                    checked={p.required}
                    onChange={e => updateParam(p.id, { required: e.target.checked })}
                    style={{ accentColor: '#a78bfa' }}
                  />
                  Required
                </label>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={p.defaultValue ?? ''}
                  onChange={e => updateParam(p.id, { defaultValue: e.target.value })}
                  placeholder="Default value"
                  style={{ ...inputSt, flex: 1 }}
                />
                <input
                  value={p.enumValues?.join(',') ?? ''}
                  onChange={e => updateParam(p.id, { enumValues: e.target.value ? e.target.value.split(',').map(s => s.trim()) : undefined })}
                  placeholder="Enum options (a,b,c)"
                  style={{ ...inputSt, flex: 1, fontSize: 10 }}
                />
              </div>
              {/* Runtime value input */}
              <div style={{ marginTop: 7, paddingTop: 7, borderTop: `1px solid ${panelBdr}` }}>
                <p style={{ fontSize: 9, color: panelMuted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700 }}>
                  Runtime value
                </p>
                {p.enumValues && p.enumValues.length > 0 ? (
                  <select
                    value={String(vals[p.key] ?? '')}
                    onChange={e => setVals(v => ({ ...v, [p.key]: e.target.value }))}
                    style={inputSt}
                  >
                    <option value="">— choose —</option>
                    {p.enumValues.map(ev => <option key={ev} value={ev}>{ev}</option>)}
                  </select>
                ) : (
                  <input
                    value={String(vals[p.key] ?? '')}
                    onChange={e => setVals(v => ({ ...v, [p.key]: e.target.value }))}
                    placeholder={p.defaultValue ?? `${p.type} value`}
                    style={inputSt}
                  />
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '10px 14px', borderTop: `1px solid ${panelBdr}`, flexShrink: 0, display: 'flex', gap: 7 }}>
        <button
          onClick={addParam}
          style={{
            flex: 1, padding: '8px', borderRadius: 9, fontSize: 11, fontWeight: 600, cursor: 'pointer',
            border: `1px dashed ${panelBdr}`, background: 'transparent', color: panelMuted,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
          }}
        >
          <Plus size={11} /> Add Parameter
        </button>
        <button
          onClick={() => onSave(defs, vals)}
          disabled={saving}
          style={{
            flex: 1, padding: '8px', borderRadius: 9, fontSize: 11, fontWeight: 700, cursor: 'pointer',
            border: '1.5px solid rgba(167,139,250,0.4)', background: 'rgba(167,139,250,0.14)', color: '#a78bfa',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            opacity: saving ? 0.6 : 1,
          }}
        >
          Save
        </button>
      </div>
    </motion.div>
  )
}

type BudgetForm = {
  defaultModelAlias: string
  maxInputTokens: string
  maxOutputTokens: string
  maxTotalTokens: string
  maxEstimatedCost: string
  warnAtPercent: string
  enforcementMode: string
  governanceMode: string
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
  description?: string
  warnings?: string[]
}

type LlmModelCatalog = {
  defaultModelAlias?: string
  models: LlmModelChoice[]
  warnings?: string[]
}

function unwrapModelCatalog(payload: any): LlmModelCatalog {
  const data = payload?.data ?? payload
  return {
    defaultModelAlias: typeof data?.defaultModelAlias === 'string' ? data.defaultModelAlias : undefined,
    models: Array.isArray(data?.models) ? data.models : [],
    warnings: Array.isArray(data?.warnings) ? data.warnings : [],
  }
}

function WorkflowBudgetPanel({
  templateId, policy, isLight, glassPanel, panelText, panelMuted, panelBdr, saving,
  onClose, onSave,
}: {
  templateId?: string
  policy: Record<string, unknown> | null
  isLight: boolean
  glassPanel: (l: boolean) => React.CSSProperties
  panelText: string; panelMuted: string; panelBdr: string
  saving: boolean
  onClose: () => void
  onSave: (policy: Record<string, unknown>) => void
}) {
  const [form, setForm] = useState<BudgetForm>(() => budgetFormFrom(policy))
  useEffect(() => { setForm(budgetFormFrom(policy)) }, [JSON.stringify(policy ?? {})])
  const { data: modelCatalog } = useQuery({
    queryKey: ['llm-model-catalog'],
    queryFn: () => api.get('/llm/models').then(r => unwrapModelCatalog(r.data)),
    staleTime: 30_000,
  })

  const inputSt: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: 8,
    fontSize: 11, border: `1px solid ${panelBdr}`,
    background: isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)',
    color: panelText, outline: 'none',
  }
  const row = (key: keyof BudgetForm, label: string, help: string, type: 'text' | 'number' = 'number') => (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: panelText }}>{label}</span>
      <input
        type={type}
        value={form[key]}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        style={inputSt}
        placeholder="No limit"
      />
      <span style={{ fontSize: 9, color: panelMuted, lineHeight: 1.4 }}>{help}</span>
    </label>
  )

  return (
    <motion.div
      key="budget-panel"
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -16 }}
      transition={{ duration: 0.18 }}
      style={{
        position: 'absolute', left: 68, top: 72, bottom: 12,
        width: 360, zIndex: 25, pointerEvents: 'auto',
        ...glassPanel(isLight),
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      <div style={{ padding: '14px 16px 10px', borderBottom: `1px solid ${panelBdr}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 26, height: 26, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(245,158,11,0.14)', border: '1px solid rgba(245,158,11,0.3)',
            }}>
              <Coins size={12} style={{ color: '#f59e0b' }} />
            </div>
            <p style={{ fontSize: 11, fontWeight: 700, color: panelText }}>Workflow Run Budget</p>
          </div>
          <button
            onClick={onClose}
            style={{ width: 24, height: 24, borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: panelMuted }}
          >
            <X size={12} />
          </button>
        </div>
        <p style={{ fontSize: 10, color: panelMuted, marginTop: 6, lineHeight: 1.6 }}>
          These limits are copied into each run. Run-time overrides can lower them; extra budget uses approval.
        </p>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'grid', gap: 12 }}>
        {!templateId && (
          <div style={{ fontSize: 11, color: '#f59e0b', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 8, padding: 10 }}>
            Budget policy is only editable on workflow designs.
          </div>
        )}
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: panelText }}>Default model</span>
          <select
            value={form.defaultModelAlias}
            onChange={e => setForm(f => ({ ...f, defaultModelAlias: e.target.value }))}
            style={inputSt}
          >
            <option value="">MCP default</option>
            {(modelCatalog?.models ?? []).map(model => (
              <option key={model.id} value={model.id} disabled={model.ready === false}>
                {(model.label ?? model.id)}{model.ready === false ? ' - Missing key' : ''}{model.default ? ' - Default' : ''}
              </option>
            ))}
          </select>
          <span style={{ fontSize: 9, color: panelMuted, lineHeight: 1.4 }}>
            MCP owns the approved model catalog. Nodes can override this default.
          </span>
        </label>
        {row('maxInputTokens', 'Max input tokens', 'Total prompt/context tokens allowed across this workflow run.')}
        {row('maxOutputTokens', 'Max output tokens', 'Total generated tokens allowed across this workflow run.')}
        {row('maxTotalTokens', 'Max total tokens', 'Combined input + output token cap.')}
        {row('maxEstimatedCost', 'Max estimated cost', 'Optional USD cap. Leave blank when provider pricing is unavailable.')}
        {row('warnAtPercent', 'Warn at percent', 'Run Insights flags the budget once this percentage is reached.')}
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: panelText }}>Enforcement</span>
          <select
            value={form.enforcementMode}
            onChange={e => setForm(f => ({ ...f, enforcementMode: e.target.value }))}
            style={inputSt}
          >
            <option value="PAUSE_FOR_APPROVAL">Pause for approval</option>
            <option value="FAIL_HARD">Fail hard</option>
            <option value="WARN_ONLY">Warn only</option>
          </select>
          <span style={{ fontSize: 9, color: panelMuted, lineHeight: 1.4 }}>Default is governed pause before overspend.</span>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: panelText }}>Default governance mode</span>
          <select
            value={form.governanceMode}
            onChange={e => setForm(f => ({ ...f, governanceMode: e.target.value }))}
            style={inputSt}
          >
            <option value="fail_open">Fail open (draft/local)</option>
            <option value="fail_closed">Fail closed</option>
            <option value="degraded">Degraded read-only</option>
            <option value="human_approval_required">Human approval required</option>
          </select>
          <span style={{ fontSize: 9, color: panelMuted, lineHeight: 1.4 }}>
            Nodes can override this. Security/compliance nodes default to fail closed.
          </span>
        </label>
      </div>

      <div style={{ padding: '10px 14px', borderTop: `1px solid ${panelBdr}`, flexShrink: 0, display: 'flex', gap: 7 }}>
        <button
          onClick={onClose}
          style={{
            flex: 1, padding: '8px', borderRadius: 9, fontSize: 11, fontWeight: 600, cursor: 'pointer',
            border: `1px solid ${panelBdr}`, background: 'transparent', color: panelMuted,
          }}
        >
          Cancel
        </button>
        <button
          onClick={() => onSave(policyFromBudgetForm(form))}
          disabled={saving || !templateId}
          style={{
            flex: 1, padding: '8px', borderRadius: 9, fontSize: 11, fontWeight: 700, cursor: 'pointer',
            border: '1.5px solid rgba(245,158,11,0.4)', background: 'rgba(245,158,11,0.14)', color: '#f59e0b',
            opacity: saving || !templateId ? 0.6 : 1,
          }}
        >
          Save Budget
        </button>
      </div>
    </motion.div>
  )
}

function budgetFormFrom(policy: Record<string, unknown> | null): BudgetForm {
  const p = policy ?? {}
  return {
    defaultModelAlias: typeof p.defaultModelAlias === 'string' ? p.defaultModelAlias : '',
    maxInputTokens: valueText(p.maxInputTokens, '100000'),
    maxOutputTokens: valueText(p.maxOutputTokens, '25000'),
    maxTotalTokens: valueText(p.maxTotalTokens, '125000'),
    maxEstimatedCost: valueText(p.maxEstimatedCost, ''),
    warnAtPercent: valueText(p.warnAtPercent, '80'),
    enforcementMode: typeof p.enforcementMode === 'string' ? p.enforcementMode : 'PAUSE_FOR_APPROVAL',
    governanceMode: typeof p.governanceMode === 'string' ? p.governanceMode : 'fail_open',
  }
}

function policyFromBudgetForm(form: BudgetForm): Record<string, unknown> {
  return {
    defaultModelAlias: form.defaultModelAlias || null,
    maxInputTokens: numberOrNull(form.maxInputTokens),
    maxOutputTokens: numberOrNull(form.maxOutputTokens),
    maxTotalTokens: numberOrNull(form.maxTotalTokens),
    maxEstimatedCost: numberOrNull(form.maxEstimatedCost),
    warnAtPercent: numberOrNull(form.warnAtPercent) ?? 80,
    enforcementMode: form.enforcementMode,
    governanceMode: form.governanceMode,
  }
}

function valueText(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return value
  return fallback
}

function numberOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  return Number.isFinite(n) && n > 0 ? n : null
}

// ─── Glassmorphism card style helper ─────────────────────────────────────────

const glassPanel = (isLight: boolean): React.CSSProperties => ({
  background: isLight ? 'rgba(255,255,255,0.88)' : 'rgba(7,17,31,0.88)',
  border: `1px solid ${isLight ? 'rgba(148,163,184,0.3)' : 'rgba(255,255,255,0.08)'}`,
  borderRadius: 22,
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  boxShadow: isLight
    ? '0 20px 48px rgba(15,23,42,0.14)'
    : '0 20px 48px rgba(2,6,23,0.38)',
})

// ─── Main page ─────────────────────────────────────────────────────────────────

export function WorkflowStudioPage() {
  // Two routes funnel into this component:
  //   /design/:workflowId   → editing a Workflow's design graph
  //   /workflow/:instanceId → viewing a run (read-only structurally)
  const params = useParams<{ workflowId?: string; instanceId?: string }>()
  const designWorkflowId = params.workflowId
  const runInstanceId    = params.instanceId
  const isDesignMode     = !!designWorkflowId
  // Single discriminator the rest of the file branches on.
  const instanceId = isDesignMode ? designWorkflowId : runInstanceId

  const navigate = useNavigate()
  const qc = useQueryClient()
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [selectedNode, setSelectedNode] = useState<Node<NodeData> | null>(null)
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(true)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'dark'
    return (localStorage.getItem('workflow-theme') as 'light' | 'dark') || 'dark'
  })
  const isLight = theme === 'light'

  useEffect(() => { localStorage.setItem('workflow-theme', theme) }, [theme])
  useEffect(() => {
    if (selectedNode) setInspectorCollapsed(false)
  }, [selectedNode?.id])

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([])
  const [paramsOpen, setParamsOpen] = useState(false)
  const [variablesOpen, setVariablesOpen] = useState(false)
  const [budgetOpen, setBudgetOpen] = useState(false)
  const [branchTest, setBranchTest] = useState<{ sourceNodeId: string; highlightEdgeId?: string } | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [validateOpen, setValidateOpen] = useState(false)
  const [validationResult, setValidationResult] = useState<{ issues: ValidationIssue[]; outputs: WorkflowOutput[] } | null>(null)

  // ── Undo/Redo history ─────────────────────────────────────────────────────
  type HistoryState = { nodes: typeof rfNodes; edges: typeof rfEdges }
  const [history, setHistory] = useState<HistoryState[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const historyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const saveSnapshot = useCallback(() => {
    const newHistory = history.slice(0, historyIdx + 1)
    newHistory.push({ nodes: rfNodes, edges: rfEdges })
    setHistory(newHistory)
    setHistoryIdx(newHistory.length - 1)
  }, [rfNodes, rfEdges, history, historyIdx])

  const debouncedSaveSnapshot = useCallback(() => {
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current)
    historyTimerRef.current = setTimeout(saveSnapshot, 800)
  }, [saveSnapshot])

  useEffect(() => {
    debouncedSaveSnapshot()
  }, [rfNodes, rfEdges, debouncedSaveSnapshot])

  const undo = useCallback(() => {
    if (historyIdx <= 0) return
    const prevState = history[historyIdx - 1]
    setRfNodes(prevState.nodes)
    setRfEdges(prevState.edges)
    setHistoryIdx(historyIdx - 1)
  }, [history, historyIdx, setRfNodes, setRfEdges])

  const redo = useCallback(() => {
    if (historyIdx >= history.length - 1) return
    const nextState = history[historyIdx + 1]
    setRfNodes(nextState.nodes)
    setRfEdges(nextState.edges)
    setHistoryIdx(historyIdx + 1)
  }, [history, historyIdx, setRfNodes, setRfEdges])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [undo, redo])

  // ── Canvas background tokens ──────────────────────────────────────────────
  const canvasBg = isLight
    ? `radial-gradient(ellipse at top, rgba(14,165,233,0.06), transparent 36%),
       linear-gradient(180deg, #f0f7ff, #eaf1fb 44%, #e4eef8)`
    : `radial-gradient(ellipse at top, rgba(34,197,94,0.10), transparent 28%),
       linear-gradient(180deg, #050e1c, #070f1f 44%, #0a1628)`

  const edgeStroke = isLight ? 'rgba(100,116,139,0.45)' : 'rgba(100,116,139,0.4)'
  const gridLine   = isLight ? 'rgba(148,163,184,0.16)' : 'rgba(148,163,184,0.06)'
  const textMuted  = isLight ? '#64748b' : '#475569'

  // ── Queries ───────────────────────────────────────────────────────────────
  const { data: customNodeTypes = [] } = useQuery<CustomNodeTypeDef[]>({
    queryKey: ['custom-node-types'],
    queryFn: () => api.get('/custom-node-types').then(r => r.data),
    staleTime: 30_000,
  })

  // ── Run-mode: load the instance ────────────────────────────────────────────
  // Only fetched when on /workflow/:instanceId.  In design mode there is no
  // running instance — the studio talks to the Workflow row directly.
  const { data: runInstance, isLoading: instanceLoading } = useQuery<{ id: string; name: string; status: string; templateId?: string; templateVersion?: number | null; createdAt: string; startedAt?: string }>({
    queryKey: ['workflow-instances', runInstanceId],
    queryFn: () => api.get(`/workflow-instances/${runInstanceId}`).then(r => r.data),
    enabled: !isDesignMode && !!runInstanceId,
    refetchInterval: 5_000,
  })

  // ── Workflow row (the design metadata).  Always loaded — in design mode
  // it's the primary entity; in run mode it's the parent for capability /
  // permission / variable resolution.
  const workflowId = isDesignMode ? designWorkflowId : runInstance?.templateId
  const { data: template } = useQuery<{ id: string; status?: string; name: string; teamId?: string; capabilityId?: string | null; variables?: TemplateVariableDef[]; budgetPolicy?: Record<string, unknown> | null }>({
    queryKey: ['workflow-templates', workflowId],
    queryFn: () => api.get(`/workflow-templates/${workflowId}`).then(r => r.data),
    enabled: !!workflowId,
    staleTime: 30_000,
  })

  // Synthesise an instance-shaped object for the rest of the component to
  // consume uniformly.  In design mode the "instance" is a façade over the
  // Workflow row (status DRAFT, no startedAt, etc.).
  const instance = isDesignMode
    ? (template ? {
        id: template.id, name: template.name, status: 'DRAFT',
        templateId: template.id, templateVersion: null,
        createdAt: new Date().toISOString(),
      } : undefined)
    : runInstance

  // Structural edits (add/remove nodes, rewire edges, change config) are only
  // allowed on the design.  Runs are read-only structurally; runtime actions
  // (claim, complete, advance) still work on them.
  const isDesignInstance = isDesignMode
  const isReadOnly = !isDesignInstance
                  || template?.status === 'FINAL'
                  || template?.status === 'ARCHIVED'

  function exportCanvasJson() {
    const doc = {
      _exportVersion: 2,
      exportedAt: new Date().toISOString(),
      template: { name: template?.name ?? instance?.name ?? 'workflow' },
      latestGraphSnapshot: {
        nodes: rfNodes.map(n => ({
          id: n.id, label: n.data.label, nodeType: n.data.nodeType,
          positionX: n.position.x, positionY: n.position.y,
          config: n.data.config,
        })),
        edges: rfEdges.map(e => ({
          id: e.id, sourceNodeId: e.source, targetNodeId: e.target,
          edgeType: e.data?.edgeType, condition: e.data?.condition,
        })),
      },
    }
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `workflow-${(template?.name ?? 'canvas').replace(/\s+/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Graph (nodes + edges) — endpoint differs by mode ──────────────────────
  // Design mode hits the workflow_design_* tables via the design-graph
  // endpoint; run mode hits the workflow_instances graph (read-only).  Both
  // produce the same row shape so the rest of the studio stays uniform.
  const { data: designGraphData } = useQuery<{ phases: any[]; nodes: any[]; edges: any[] }>({
    queryKey: ['workflow-design', designWorkflowId],
    queryFn: () => api.get(`/workflow-templates/${designWorkflowId}/design-graph`).then(r => r.data),
    enabled: isDesignMode && !!designWorkflowId,
    refetchInterval: 5_000,
  })

  const { data: runNodesData } = useQuery({
    queryKey: ['workflow-instances', runInstanceId, 'nodes'],
    queryFn: () => api.get(`/workflow-instances/${runInstanceId}/nodes`).then(r => r.data),
    enabled: !isDesignMode && !!runInstanceId,
    refetchInterval: 5_000,
  })
  const { data: runEdgesData } = useQuery({
    queryKey: ['workflow-instances', runInstanceId, 'edges'],
    queryFn: () => api.get(`/workflow-instances/${runInstanceId}/edges`).then(r => r.data),
    enabled: !isDesignMode && !!runInstanceId,
    refetchInterval: 5_000,
  })

  // Unified data for downstream effects.
  const nodesData = isDesignMode ? designGraphData?.nodes : runNodesData
  const edgesData = isDesignMode ? designGraphData?.edges : runEdgesData

  // Params only exist on running instances; in design mode they're empty.
  const { data: paramsData } = useQuery<{ paramDefs: ParamDef[]; paramValues: Record<string, unknown> }>({
    queryKey: ['workflow-instances', runInstanceId, 'params'],
    queryFn: () => api.get(`/workflow-instances/${runInstanceId}/params`).then(r => r.data),
    enabled: !isDesignMode && !!runInstanceId,
    staleTime: 10_000,
  })
  const workflowParams: ParamDef[] = paramsData?.paramDefs ?? []

  // Team-scoped globals — surfaced in the Assignment section's variable picker
  // so authors can drop in `{{globals.X}}` references at design time.  Also
  // scope-filtered: a workflow may only reference globals visible to it
  // (ORG_GLOBAL + same-capability + same-workflow).
  const { data: teamGlobalsData } = useQuery<TeamVariable[]>({
    queryKey: ['teams', template?.teamId, 'variables'],
    queryFn:  () => api.get(`/teams/${template!.teamId}/variables`).then(r => r.data),
    enabled:  !!template?.teamId,
    staleTime: 30_000,
  })
  const teamGlobals: TeamVariable[] = (() => {
    const all = teamGlobalsData ?? []
    const wfId  = template?.id ?? ''
    const capId = template?.capabilityId ?? null
    return all.filter((g: any) => {
      const v = g.visibility ?? 'ORG_GLOBAL'
      if (v === 'ORG_GLOBAL') return true
      if (v === 'CAPABILITY') return g.visibilityScopeId === capId
      if (v === 'WORKFLOW')   return g.visibilityScopeId === wfId
      return true
    })
  })()

  // ── Sync API → RF ─────────────────────────────────────────────────────────
  useEffect(() => {
    const apiNodes: ApiNode[] = Array.isArray(nodesData) ? nodesData : (nodesData as any)?.content ?? []
    setRfNodes(apiNodes.map(n => ({
      id: n.id, type: 'wgNode',
      position: { x: n.positionX, y: n.positionY },
      // Design nodes don't carry a runtime status — synthesise PENDING so
      // the visual layer stays consistent.
      data: { label: n.label, nodeType: n.nodeType, status: n.status ?? 'PENDING', config: n.config },
    })))
  }, [nodesData, setRfNodes])

  useEffect(() => {
    const apiEdges: ApiEdge[] = Array.isArray(edgesData) ? edgesData : (edgesData?.content ?? [])
    setRfEdges(apiEdges.map(e => {
      const branch = e.condition as Branch | undefined
      const isDefault = branch?.isDefault === true

      // Auto-generate a readable label if the branch has no explicit label.
      // For ordinary conditional edges this surfaces the first condition
      // (e.g. "tier == GOLD") instead of falling through to a node-id.
      let autoLabel: string | undefined
      if (branch?.label) {
        autoLabel = branch.label
      } else if (isDefault) {
        autoLabel = 'else'
      } else if (Array.isArray(branch?.conditions) && branch?.conditions[0]?.left) {
        const c = branch.conditions[0]
        const right = ['exists', 'not_exists'].includes(c.op) ? '' : ` ${c.right ?? ''}`
        autoLabel = `${c.left} ${c.op}${right}`.trim()
      } else {
        autoLabel = e.label
      }

      const stroke = isDefault ? '#f59e0b' : edgeStroke
      return {
        id: e.id, source: e.sourceNodeId, target: e.targetNodeId,
        label: autoLabel,
        data: { edgeType: e.edgeType, condition: e.condition, isDefault },
        style: {
          stroke,
          strokeWidth: 2,
          ...(isDefault ? { strokeDasharray: '6 4' } : {}),
        },
        labelStyle: {
          fill: isDefault ? '#fbbf24' : textMuted,
          fontSize: 10, fontWeight: 700,
          textTransform: 'uppercase' as const, letterSpacing: '0.10em',
        },
        labelBgStyle: {
          fill: isDefault
            ? (isLight ? '#fef3c7' : '#1f1505')
            : (isLight ? '#f0f7ff' : '#050e1c'),
          fillOpacity: 0.92,
        },
        labelBgPadding: [4, 6] as [number, number],
        labelBgBorderRadius: 4,
      }
    }))
  }, [edgesData, setRfEdges, edgeStroke, textMuted, isLight])

  // ── Mutations ─────────────────────────────────────────────────────────────
  // Helper that picks the right URL family based on mode.  Design mode talks
  // to /workflow-templates/:id/design/...; run mode talks to
  // /workflow-instances/:id/...  Run-mode mutations are blocked by isReadOnly
  // upstream of these calls — included here so the API surface stays uniform.
  const designKey = ['workflow-design', designWorkflowId]
  const runKey    = ['workflow-instances', runInstanceId, 'nodes']

  const invalidateGraph = () => {
    if (isDesignMode) {
      qc.invalidateQueries({ queryKey: designKey })
    } else {
      qc.invalidateQueries({ queryKey: ['workflow-instances', runInstanceId, 'nodes'] })
      qc.invalidateQueries({ queryKey: ['workflow-instances', runInstanceId, 'edges'] })
    }
  }

  const addNode = useMutation({
    mutationFn: (payload: { label: string; nodeType: string; positionX: number; positionY: number; config?: Record<string, unknown> }) => {
      const url = isDesignMode
        ? `/workflow-templates/${designWorkflowId}/design/nodes`
        : `/workflow-instances/${runInstanceId}/nodes`
      return api.post(url, payload).then(r => r.data)
    },
    onSuccess: () => invalidateGraph(),
  })

  const deleteNodeMut = useMutation({
    mutationFn: (nodeId: string) => {
      const url = isDesignMode
        ? `/workflow-templates/${designWorkflowId}/design/nodes/${nodeId}`
        : `/workflow-instances/${runInstanceId}/nodes/${nodeId}`
      return api.delete(url)
    },
    onSuccess: () => invalidateGraph(),
  })

  const addEdgeMutation = useMutation({
    mutationFn: (payload: { sourceNodeId: string; targetNodeId: string; edgeType: string }) => {
      const url = isDesignMode
        ? `/workflow-templates/${designWorkflowId}/design/edges`
        : `/workflow-instances/${runInstanceId}/edges`
      return api.post(url, payload).then(r => r.data)
    },
    onSuccess: () => invalidateGraph(),
  })

  const patchNode = useMutation({
    mutationFn: ({ nodeId, ...payload }: { nodeId: string; label?: string; positionX?: number; positionY?: number; config?: NodeConfig }) => {
      const url = isDesignMode
        ? `/workflow-templates/${designWorkflowId}/design/nodes/${nodeId}`
        : `/workflow-instances/${runInstanceId}/nodes/${nodeId}`
      return api.patch(url, payload)
    },
    onSuccess: () => invalidateGraph(),
  })

  // Suppress the unused-var warning for keys carried for future use
  void runKey

  const startInstance = useMutation({
    mutationFn: () => api.post(`/workflow-instances/${instanceId}/start`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-instances', instanceId] })
      qc.invalidateQueries({ queryKey: ['workflow-instances', instanceId, 'nodes'] })
    },
  })

  const pauseInstanceMut = useMutation({
    mutationFn: () => api.post(`/workflow-instances/${instanceId}/pause`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-instances', instanceId] }),
  })

  const resumeInstanceMut = useMutation({
    mutationFn: () => api.post(`/workflow-instances/${instanceId}/resume`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-instances', instanceId] })
      qc.invalidateQueries({ queryKey: ['workflow-instances', instanceId, 'nodes'] })
    },
  })

  const cancelInstanceMut = useMutation({
    mutationFn: (reason?: string) => api.post(`/workflow-instances/${instanceId}/cancel`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-instances', instanceId] })
      qc.invalidateQueries({ queryKey: ['workflow-instances', instanceId, 'nodes'] })
    },
  })

  const patchEdge = useMutation({
    mutationFn: ({ edgeId, ...payload }: { edgeId: string; label?: string; edgeType?: string; condition?: Record<string, unknown> | null }) => {
      const url = isDesignMode
        ? `/workflow-templates/${designWorkflowId}/design/edges/${edgeId}`
        : `/workflow-instances/${runInstanceId}/edges/${edgeId}`
      return api.patch(url, payload).then(r => r.data)
    },
    onSuccess: () => invalidateGraph(),
  })

  const saveWorkflowParams = useMutation({
    mutationFn: (payload: { paramDefs?: ParamDef[]; paramValues?: Record<string, unknown> }) =>
      api.patch(`/workflow-instances/${instanceId}/params`, payload).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-instances', instanceId, 'params'] }),
  })

  const saveBudgetPolicy = useMutation({
    mutationFn: (budgetPolicy: Record<string, unknown>) =>
      api.patch(`/workflow-templates/${template?.id}`, { budgetPolicy }).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-templates', workflowId] })
      setBudgetOpen(false)
    },
  })

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleDeleteNode = useCallback((nodeId: string) => {
    setRfNodes(nds => nds.filter(n => n.id !== nodeId))
    setRfEdges(eds => eds.filter(e => e.source !== nodeId && e.target !== nodeId))
    deleteNodeMut.mutate(nodeId)
    if (selectedNode?.id === nodeId) setSelectedNode(null)
  }, [deleteNodeMut, selectedNode, setRfNodes, setRfEdges])

  const handleAddDecorator = useCallback((nodeId: string, type: string, label: string) => {
    const node = rfNodes.find(n => n.id === nodeId)
    if (!node) return
    const cfg = (node.data.config ?? {}) as Record<string, unknown>
    const existing: DecoratorEntry[] = (cfg._decorators as DecoratorEntry[]) ?? []
    const newDec: DecoratorEntry = { id: Math.random().toString(36).slice(2), type, label }
    const newCfg = { ...cfg, _decorators: [...existing, newDec] }
    setRfNodes(nds => nds.map(n => n.id === nodeId ? { ...n, data: { ...n.data, config: newCfg as unknown as NodeConfig } } : n))
    patchNode.mutate({ nodeId, config: newCfg as unknown as NodeConfig })
  }, [rfNodes, setRfNodes, patchNode])

  const handleRemoveDecorator = useCallback((nodeId: string, decId: string) => {
    const node = rfNodes.find(n => n.id === nodeId)
    if (!node) return
    const cfg = (node.data.config ?? {}) as Record<string, unknown>
    const existing: DecoratorEntry[] = (cfg._decorators as DecoratorEntry[]) ?? []
    const newCfg = { ...cfg, _decorators: existing.filter(d => d.id !== decId) }
    setRfNodes(nds => nds.map(n => n.id === nodeId ? { ...n, data: { ...n.data, config: newCfg as unknown as NodeConfig } } : n))
    patchNode.mutate({ nodeId, config: newCfg as unknown as NodeConfig })
  }, [rfNodes, setRfNodes, patchNode])

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (isReadOnly) return
    const nodeType = e.dataTransfer.getData('application/wg-node-type')
    if (!nodeType || !rfInstance || !reactFlowWrapper.current) return
    const bounds = reactFlowWrapper.current.getBoundingClientRect()
    const position = rfInstance.screenToFlowPosition({ x: e.clientX - bounds.left, y: e.clientY - bounds.top })
    const payloadStr = e.dataTransfer.getData('application/wg-node-payload')
    const payload = payloadStr ? JSON.parse(payloadStr) : undefined
    const config = payload?.config ?? payload
    const label = payload?.label ?? NODE_LABELS[nodeType] ?? nodeType
    addNode.mutate({ label, nodeType, positionX: Math.round(position.x), positionY: Math.round(position.y), ...(config ? { config } : {}) })
  }, [rfInstance, addNode, isReadOnly])

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onConnect = useCallback((connection: Connection) => {
    setRfEdges(eds => addEdge({ ...connection, style: { stroke: edgeStroke, strokeWidth: 2 } }, eds))
    if (connection.source && connection.target) {
      // Decision nodes auto-get CONDITIONAL edges
      const sourceNode = rfNodes.find(n => n.id === connection.source)
      const isDecision = sourceNode && ['DECISION_GATE', 'INCLUSIVE_GATEWAY', 'EVENT_GATEWAY'].includes(sourceNode.data.nodeType)
      addEdgeMutation.mutate({
        sourceNodeId: connection.source,
        targetNodeId: connection.target,
        edgeType: isDecision ? 'CONDITIONAL' : 'SEQUENTIAL',
      })
    }
  }, [setRfEdges, addEdgeMutation, edgeStroke, rfNodes])

  const onNodeDragStop = useCallback((_: React.MouseEvent, node: Node) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      patchNode.mutate({ nodeId: node.id, positionX: Math.round(node.position.x), positionY: Math.round(node.position.y) })
    }, 500)
  }, [patchNode])

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node<NodeData>) => {
    setSelectedNode(node)
    setInspectorCollapsed(false)
  }, [])

  const onPaneClick = useCallback(() => setSelectedNode(null), [])

  const handleInspectorSave = useCallback((nodeId: string, label: string, config: NodeConfig) => {
    patchNode.mutate({ nodeId, label, config }, {
      onSuccess: () => {
        setRfNodes(nds => nds.map(n => n.id === nodeId ? { ...n, data: { ...n.data, label, config } } : n))
        setSelectedNode(prev => prev?.id === nodeId ? { ...prev, data: { ...prev.data, label, config } } : prev)
      },
    })
  }, [patchNode, setRfNodes])

  const handleUpdateBranch = useCallback((edgeId: string, label: string | undefined, branch: Branch) => {
    patchEdge.mutate({
      edgeId,
      edgeType: 'CONDITIONAL',
      label,
      condition: branch as unknown as Record<string, unknown>,
    })
    // Optimistically update the RF edge — label, condition data, default styling
    setRfEdges(eds => eds.map(e => {
      if (e.id !== edgeId) return e
      const isDefault = branch.isDefault === true

      let autoLabel: string | undefined
      if (branch.label) {
        autoLabel = branch.label
      } else if (isDefault) {
        autoLabel = 'else'
      } else if (Array.isArray(branch.conditions) && branch.conditions[0]?.left) {
        const c = branch.conditions[0]
        const right = ['exists', 'not_exists'].includes(c.op) ? '' : ` ${c.right ?? ''}`
        autoLabel = `${c.left} ${c.op}${right}`.trim()
      } else {
        autoLabel = label
      }

      return {
        ...e,
        label: autoLabel,
        data: { ...(e.data as Record<string, unknown> | undefined), edgeType: 'CONDITIONAL', condition: branch, isDefault },
        style: {
          ...(e.style as React.CSSProperties),
          stroke: isDefault ? '#f59e0b' : (e.style as React.CSSProperties)?.stroke,
          strokeDasharray: isDefault ? '6 4' : undefined,
        },
        labelStyle: {
          ...(e.labelStyle as React.CSSProperties),
          fill: isDefault ? '#fbbf24' : (e.labelStyle as React.CSSProperties)?.fill,
        },
      }
    }))
  }, [patchEdge, setRfEdges])

  const handleDeleteBranch = useCallback((edgeId: string) => {
    setRfEdges(eds => eds.filter(e => e.id !== edgeId))
    const url = isDesignMode
      ? `/workflow-templates/${designWorkflowId}/design/edges/${edgeId}`
      : `/workflow-instances/${runInstanceId}/edges/${edgeId}`
    api.delete(url).then(() => invalidateGraph())
  }, [isDesignMode, designWorkflowId, runInstanceId, qc, setRfEdges])

  // Outgoing edges for selected node (feeds BranchesTab)
  const selectedNodeOutgoingEdges: OutgoingEdgeBranch[] = selectedNode
    ? rfEdges
        .filter(e => e.source === selectedNode.id)
        .map(e => ({
          edgeId: e.id,
          label: typeof e.label === 'string' ? e.label : undefined,
          edgeType: (e.data as { edgeType?: string })?.edgeType ?? 'SEQUENTIAL',
          condition: (e.data as { condition?: Branch | null })?.condition ?? null,
          targetNodeId: e.target,
          targetLabel: rfNodes.find(n => n.id === e.target)?.data?.label,
        }))
    : []

  // ── Loading ───────────────────────────────────────────────────────────────
  if (instanceLoading) {
    return (
      <div style={{ display: 'flex', height: '100%', background: '#050e1c', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <div className="skeleton" style={{ height: 14, width: 240, borderRadius: 7 }} />
      </div>
    )
  }

  // ── Derived state ─────────────────────────────────────────────────────────
  const statusClr    = INSTANCE_STATUS_COLOR[instance?.status ?? ''] ?? '#64748b'
  // Validate/Start only apply to a real run.  In design mode, the action is
  // "Start a run" which goes through the RunModal on the workflows list.
  const canValidate  = !isDesignMode && instance?.status === 'DRAFT' && rfNodes.length > 0
  const canStart     = canValidate && validationResult !== null && validationResult.issues.filter(i => i.severity === 'error').length === 0
  const totalNodes   = rfNodes.length
  const completedCnt = rfNodes.filter(n => n.data.status === 'COMPLETED').length
  const activeCnt    = rfNodes.filter(n => n.data.status === 'ACTIVE').length
  const failedCnt    = rfNodes.filter(n => n.data.status === 'FAILED').length
  const pendingCnt   = rfNodes.filter(n => n.data.status === 'PENDING').length
  const completedPct = totalNodes > 0 ? Math.round((completedCnt / totalNodes) * 100) : 0
  const totalEdges   = rfEdges.length

  // ── Shared text/border tokens for floating panels ─────────────────────────
  const panelText   = isLight ? '#1e293b' : '#e2e8f0'
  const panelMuted  = isLight ? '#64748b' : '#475569'
  const panelBdr    = isLight ? 'rgba(148,163,184,0.28)' : 'rgba(255,255,255,0.07)'

  return (
    <WFNodeContext.Provider value={{ onDelete: handleDeleteNode, onAddDecorator: handleAddDecorator, onRemoveDecorator: handleRemoveDecorator, theme }}>
      {/* Full-screen canvas container */}
      <div style={{
        position: 'relative', width: '100%', height: '100%', overflow: 'hidden',
        background: canvasBg,
      }}>
        <div ref={reactFlowWrapper} style={{ position: 'absolute', inset: 0 }}>
          <ReactFlow
            nodes={rfNodes} edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect} onDrop={onDrop} onDragOver={onDragOver}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={onNodeClick} onPaneClick={onPaneClick}
            onInit={inst => setRfInstance(inst)}
            fitView fitViewOptions={{ padding: 0.25 }}
            deleteKeyCode={null}
            style={{ background: 'transparent' }}
            proOptions={{ hideAttribution: true }}
            edgesFocusable
            defaultEdgeOptions={{
              style: { stroke: edgeStroke, strokeWidth: 2 },
              labelStyle: { fill: textMuted, fontSize: 10, fontWeight: 700 },
              labelBgStyle: { fill: isLight ? '#f0f7ff' : '#050e1c', fillOpacity: 0.9 },
              labelBgPadding: [5, 3],
              labelBgBorderRadius: 5,
            }}
          >
            <Background variant={BackgroundVariant.Lines} gap={24} size={0.5} color={gridLine} />

            {/* Empty state overlay */}
            {rfNodes.length === 0 && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', zIndex: 1,
              }}>
                <div style={{
                  ...glassPanel(isLight),
                  padding: '40px 48px', textAlign: 'center', maxWidth: 380,
                }}>
                  <div style={{
                    width: 64, height: 64, borderRadius: 20, margin: '0 auto 20px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(34,197,94,0.10)', border: '1.5px solid rgba(34,197,94,0.22)',
                  }}>
                    <GitBranch size={28} style={{ color: 'rgba(34,197,94,0.6)' }} />
                  </div>
                  <p style={{ fontSize: 16, fontWeight: 700, color: panelText, marginBottom: 10 }}>
                    Empty canvas
                  </p>
                  <p style={{ fontSize: 11, color: panelMuted, lineHeight: 1.7 }}>
                    Drag a node type from the left palette to start designing your workflow
                  </p>
                </div>
              </div>
            )}
          </ReactFlow>
        </div>

        {/* ─── FLOATING COMMANDBAR ──────────────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22 }}
          style={{
            position: 'absolute', top: 12, left: 68, right: inspectorCollapsed ? 16 : 332,
            zIndex: 30, pointerEvents: 'auto',
            ...glassPanel(isLight),
            borderRadius: 18,
            padding: '0 10px',
            height: 48,
            display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          {/* Back */}
          <button
            onClick={() => navigate('/workflows')}
            title="Back to Workflows"
            style={{
              width: 30, height: 30, borderRadius: 9, border: `1px solid ${panelBdr}`,
              background: 'transparent', cursor: 'pointer', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: panelMuted, transition: 'all 0.12s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = panelText }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = panelMuted }}
          >
            <ArrowLeft size={13} />
          </button>

          <div style={{ width: 1, height: 20, background: panelBdr, flexShrink: 0 }} />

          {/* Workflow icon + name + status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(34,197,94,0.14)', border: '1px solid rgba(34,197,94,0.28)',
            }}>
              <GitBranch size={13} style={{ color: '#22c55e' }} />
            </div>
            <h1 style={{
              fontSize: 13, fontWeight: 700, color: panelText, margin: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {instance?.name ?? 'Workflow'}
            </h1>

            {/* Design vs Run badge — distinct shape so it's always obvious which mode you're editing */}
            {isDesignInstance ? (
              <span style={{
                fontSize: 8, fontWeight: 800, padding: '3px 8px', borderRadius: 6, flexShrink: 0,
                background: 'rgba(168,85,247,0.15)', color: '#a855f7', border: '1px solid rgba(168,85,247,0.32)',
                textTransform: 'uppercase', letterSpacing: '0.14em', display: 'flex', alignItems: 'center', gap: 3,
              }}>
                <PenLine size={9} /> Design
              </span>
            ) : (
              <span style={{
                fontSize: 8, fontWeight: 800, padding: '3px 8px', borderRadius: 6, flexShrink: 0,
                background: 'rgba(14,165,233,0.15)', color: '#0ea5e9', border: '1px solid rgba(14,165,233,0.32)',
                textTransform: 'uppercase', letterSpacing: '0.14em', display: 'flex', alignItems: 'center', gap: 3,
              }}>
                <GitFork size={9} /> Run
              </span>
            )}

            {/* Pinned version — only meaningful for runs */}
            {!isDesignInstance && typeof instance?.templateVersion === 'number' && (
              <span title={`Cloned from design v${instance.templateVersion}`} style={{
                fontSize: 8, fontWeight: 800, padding: '3px 8px', borderRadius: 6, flexShrink: 0,
                background: 'rgba(99,102,241,0.12)', color: '#6366f1', border: '1px solid rgba(99,102,241,0.28)',
                textTransform: 'uppercase', letterSpacing: '0.14em', fontFamily: 'monospace',
              }}>
                v{instance.templateVersion}
              </span>
            )}

            <span style={{
              fontSize: 8, fontWeight: 800, padding: '3px 8px', borderRadius: 6, flexShrink: 0,
              background: `${statusClr}16`, color: statusClr, border: `1px solid ${statusClr}28`,
              textTransform: 'uppercase', letterSpacing: '0.14em',
            }}>
              {instance?.status}
            </span>
            {isReadOnly && !isDesignInstance && (
              <span title="Structural edits go to the Design. This is a read-only run." style={{
                fontSize: 8, fontWeight: 800, padding: '3px 8px', borderRadius: 6, flexShrink: 0,
                background: 'rgba(100,116,139,0.16)', color: '#475569', border: '1px solid rgba(100,116,139,0.28)',
                textTransform: 'uppercase', letterSpacing: '0.14em', display: 'flex', alignItems: 'center', gap: 3,
              }}>
                <Lock size={9} /> Read-only
              </span>
            )}
            {isReadOnly && isDesignInstance && (
              <span title="Template is FINAL or ARCHIVED — design is locked." style={{
                fontSize: 8, fontWeight: 800, padding: '3px 8px', borderRadius: 6, flexShrink: 0,
                background: '#ef444416', color: '#ef4444', border: '1px solid #ef444428',
                textTransform: 'uppercase', letterSpacing: '0.14em', display: 'flex', alignItems: 'center', gap: 3,
              }}>
                <Lock size={9} /> Locked
              </span>
            )}
          </div>

          {/* Counts */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 10, color: panelMuted, display: 'flex', alignItems: 'center', gap: 3, fontWeight: 600 }}>
              <Layers size={11} /> {totalNodes}
            </span>
            <span style={{ fontSize: 10, color: panelMuted, display: 'flex', alignItems: 'center', gap: 3, fontWeight: 600 }}>
              <GitBranch size={11} /> {totalEdges}
            </span>
          </div>

          <div style={{ width: 1, height: 20, background: panelBdr, flexShrink: 0 }} />

          {/* Undo/Redo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <ToolBtn
              icon={RotateCcw}
              title={`Undo (${historyIdx > 0 ? historyIdx : 0})`}
              onClick={undo}
              active={historyIdx > 0}
            />
            <ToolBtn
              icon={RotateCw}
              title={`Redo (${historyIdx < history.length - 1 ? history.length - 1 - historyIdx : 0})`}
              onClick={redo}
              active={historyIdx < history.length - 1}
            />
          </div>

          <div style={{ width: 1, height: 20, background: panelBdr, flexShrink: 0 }} />

          {/* Zoom controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <ToolBtn icon={ZoomOut} title="Zoom out" onClick={() => rfInstance?.zoomOut()} />
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: panelMuted, fontWeight: 700, minWidth: 36, textAlign: 'center' }}>
              100%
            </span>
            <ToolBtn icon={ZoomIn} title="Zoom in" onClick={() => rfInstance?.zoomIn()} />
            <ToolBtn icon={Maximize2} title="Fit view" onClick={() => rfInstance?.fitView({ padding: 0.25 })} />
          </div>

          <div style={{ width: 1, height: 20, background: panelBdr, flexShrink: 0 }} />

          {/* Lifecycle */}
          {instance?.status === 'ACTIVE' && (
            <span style={{ fontSize: 9, color: '#22c55e', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', flexShrink: 0 }}>
              ● LIVE
            </span>
          )}

          {/* Design mode: quick "Start Run" — navigates back to workflows list
              with the run modal pre-opened so the user can name + override vars. */}
          {isDesignMode && rfNodes.length > 0 && (
            <button
              onClick={() => navigate(`/workflows?run=${designWorkflowId}`)}
              title="Start a run of this workflow"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '5px 14px', borderRadius: 9, fontSize: 11, fontWeight: 700, flexShrink: 0,
                background: 'rgba(34,197,94,0.18)',
                border: '1.5px solid rgba(34,197,94,0.4)',
                color: '#22c55e', cursor: 'pointer', transition: 'all 0.12s',
              }}
            >
              <Play size={11} /> Start Run
            </button>
          )}

          {canValidate && (
            <button
              onClick={() => {
                const result = validateWorkflow(rfNodes.map(n => ({
                  id: n.id,
                  data: { label: n.data.label, nodeType: n.data.nodeType, config: n.data.config as Record<string, unknown> | undefined },
                })), rfEdges.map(e => ({ source: e.source, target: e.target })))
                setValidationResult(result)
                setValidateOpen(true)
              }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '5px 14px', borderRadius: 9, fontSize: 11, fontWeight: 700, flexShrink: 0,
                background: validationResult !== null
                  ? validationResult.issues.filter(i => i.severity === 'error').length === 0
                    ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.14)'
                  : 'rgba(99,102,241,0.15)',
                border: validationResult !== null
                  ? validationResult.issues.filter(i => i.severity === 'error').length === 0
                    ? '1.5px solid rgba(34,197,94,0.4)' : '1.5px solid rgba(239,68,68,0.4)'
                  : '1.5px solid rgba(99,102,241,0.4)',
                color: validationResult !== null
                  ? validationResult.issues.filter(i => i.severity === 'error').length === 0
                    ? '#22c55e' : '#f87171'
                  : '#818cf8',
                cursor: 'pointer', transition: 'all 0.12s',
              }}
            >
              <CheckCircle size={11} />
              {validationResult === null ? 'Validate' : validationResult.issues.filter(i => i.severity === 'error').length === 0 ? 'Valid ✓' : `${validationResult.issues.filter(i => i.severity === 'error').length} error${validationResult.issues.filter(i => i.severity === 'error').length > 1 ? 's' : ''}`}
            </button>
          )}
          {instance?.status === 'ACTIVE' && (
            <>
              <ToolBtn icon={Pause} title="Pause" color="#fbbf24" active onClick={() => pauseInstanceMut.mutate()} />
              <ToolBtn icon={Square} title="Cancel" color="#f87171" onClick={() => { if (confirm('Cancel this workflow?')) cancelInstanceMut.mutate(undefined) }} />
            </>
          )}
          {instance?.status === 'PAUSED' && (
            <>
              <ToolBtn icon={RotateCw} title="Resume" color="#22c55e" active onClick={() => resumeInstanceMut.mutate()} />
              <ToolBtn icon={Square} title="Cancel" color="#f87171" onClick={() => { if (confirm('Cancel this workflow?')) cancelInstanceMut.mutate(undefined) }} />
            </>
          )}

          {/* Params panel toggle */}
          <ToolBtn
            icon={SlidersHorizontal}
            title="Workflow parameters"
            active={paramsOpen}
            color="#a78bfa"
            onClick={() => setParamsOpen(o => !o)}
          />

          {/* Variables panel toggle (template + globals) */}
          <ToolBtn
            icon={Braces}
            title="Variables (workflow + team globals)"
            active={variablesOpen}
            color="#8b5cf6"
            onClick={() => setVariablesOpen(o => !o)}
          />

          <ToolBtn
            icon={Coins}
            title="Workflow run budget"
            active={budgetOpen}
            color="#f59e0b"
            onClick={() => setBudgetOpen(o => !o)}
          />

          {/* Export JSON */}
          <ToolBtn
            icon={Download}
            title="Export canvas as JSON"
            onClick={exportCanvasJson}
          />

          {/* Help */}
          <ToolBtn
            icon={HelpCircle}
            title="Node reference guide"
            active={helpOpen}
            color="#a78bfa"
            onClick={() => setHelpOpen(o => !o)}
          />

          {/* Theme toggle */}
          <ToolBtn
            icon={isLight ? Moon : Sun}
            title={`Switch to ${isLight ? 'dark' : 'light'} theme`}
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          />
        </motion.div>

        {/* ─── FLOATING LEFT PALETTE DOCK ───────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, x: -12 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.22, delay: 0.05 }}
          style={{
            position: 'absolute', left: 12, top: 72, bottom: 12,
            zIndex: 20, pointerEvents: 'auto',
            display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6,
          }}
        >
          {/* Icon dock */}
          <div style={{
            ...glassPanel(isLight),
            borderRadius: 20, padding: 12,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
            overflowY: 'auto', maxHeight: '100%',
            width: 76,
          }}>
            {/* Toggle button */}
            <button
              onClick={() => setPaletteOpen(p => !p)}
              title={paletteOpen ? 'Collapse palette' : 'Expand palette'}
              style={{
                width: 40, height: 40, borderRadius: 11, border: `1px solid ${panelBdr}`,
                background: 'transparent', cursor: 'pointer', marginBottom: 2,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: panelMuted, transition: 'all 0.12s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = panelText }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = panelMuted }}
            >
              <Layers size={16} />
            </button>

            <div style={{ width: 52, height: 1, background: panelBdr }} />

            {/* Built-in node types - grouped by category */}
            {NODE_GROUPS.map((group, gIdx) => (
              <div key={group.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: '100%' }}>
                {gIdx > 0 && <div style={{ width: 52, height: 1, background: panelBdr }} />}

                <div style={{ fontSize: 7, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#64748b', opacity: 0.7 }}>
                  {group.label}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, width: '100%' }}>
                  {group.types.map(type => {
                    const { color, Icon } = NODE_VISUAL[type] ?? { color: '#64748b', Icon: Box }
                    if (type === 'WORKBENCH_TASK') {
                      return (
                        <PaletteIcon
                          key={type}
                          nodeType={type}
                          color={color}
                          Icon={Icon}
                          label={NODE_LABELS[type] ?? type}
                          dragPayload={JSON.stringify({
                            label: 'Workbench Task',
                            config: WORKBENCH_TASK_NODE_CONFIG,
                          })}
                        />
                      )
                    }
                    return (
                      <PaletteIcon
                        key={type} nodeType={type} color={color} Icon={Icon}
                        label={NODE_LABELS[type] ?? type}
                      />
                    )
                  })}
                </div>
              </div>
            ))}

            {/* Custom types */}
            {customNodeTypes.length > 0 && (
              <>
                <div style={{ width: 28, height: 1, background: panelBdr, margin: '2px 0' }} />
                {customNodeTypes.map(ct => {
                  const Icon = ALL_CUSTOM_ICONS[ct.icon] ?? Box
                  return (
                    <PaletteIcon
                      key={ct.id} nodeType="CUSTOM" color={ct.color} Icon={Icon}
                      label={ct.label}
                      dragPayload={JSON.stringify({
                        _baseType: ct.baseType, _customTypeId: ct.id,
                        _customTypeName: ct.name, _customTypeLabel: ct.label,
                        _customTypeColor: ct.color, _customTypeIcon: ct.icon,
                      })}
                    />
                  )
                })}
              </>
            )}

          </div>
        </motion.div>

        {/* ─── FLOATING PARAMS PANEL ───────────────────────────────────────── */}
        <AnimatePresence>
          {paramsOpen && (
            <WorkflowParamsPanel
              params={workflowParams}
              values={paramsData?.paramValues ?? {}}
              isLight={isLight}
              glassPanel={glassPanel}
              panelText={panelText}
              panelMuted={panelMuted}
              panelBdr={panelBdr}
              saving={saveWorkflowParams.isPending}
              onClose={() => setParamsOpen(false)}
              onSave={(defs, vals) => saveWorkflowParams.mutate({ paramDefs: defs, paramValues: vals })}
            />
          )}
        </AnimatePresence>

        {/* ─── FLOATING VARIABLES PANEL ─────────────────────────────────────── */}
        <AnimatePresence>
          {variablesOpen && (
            <WorkflowVariablesPanel
              instanceId={instanceId}
              templateId={template?.id}
              teamId={template?.teamId}
              variables={template?.variables ?? []}
              isLight={isLight}
              glassPanel={glassPanel}
              panelText={panelText}
              panelMuted={panelMuted}
              panelBdr={panelBdr}
              onClose={() => setVariablesOpen(false)}
            />
          )}
        </AnimatePresence>

        {/* ─── FLOATING BUDGET PANEL ───────────────────────────────────────── */}
        <AnimatePresence>
          {budgetOpen && (
            <WorkflowBudgetPanel
              templateId={template?.id}
              policy={template?.budgetPolicy ?? null}
              isLight={isLight}
              glassPanel={glassPanel}
              panelText={panelText}
              panelMuted={panelMuted}
              panelBdr={panelBdr}
              saving={saveBudgetPolicy.isPending}
              onClose={() => setBudgetOpen(false)}
              onSave={policy => saveBudgetPolicy.mutate(policy)}
            />
          )}
        </AnimatePresence>

        {/* ─── FLOATING BRANCH TEST PANEL ───────────────────────────────────── */}
        <AnimatePresence>
          {branchTest && instanceId && (
            <BranchTestPanel
              instanceId={instanceId}
              sourceNodeId={branchTest.sourceNodeId}
              sourceNodeLabel={rfNodes.find(n => n.id === branchTest.sourceNodeId)?.data?.label}
              sourceNodeType={rfNodes.find(n => n.id === branchTest.sourceNodeId)?.data?.nodeType}
              initialContext={(instance as any)?.context ?? {}}
              branchLabels={Object.fromEntries(
                rfEdges
                  .filter(e => e.source === branchTest.sourceNodeId)
                  .map(e => [e.id, typeof e.label === 'string' ? e.label : undefined]),
              )}
              highlightEdgeId={branchTest.highlightEdgeId}
              onClose={() => setBranchTest(null)}
              isLight={isLight}
              glassPanel={glassPanel}
              panelText={panelText}
              panelMuted={panelMuted}
              panelBdr={panelBdr}
            />
          )}
        </AnimatePresence>

        {/* ─── FLOATING HELP PANEL ─────────────────────────────────────────── */}
        <AnimatePresence>
          {helpOpen && (
            <NodeHelpPanel
              isLight={isLight}
              panelText={panelText}
              panelMuted={panelMuted}
              panelBdr={panelBdr}
              onClose={() => setHelpOpen(false)}
            />
          )}
        </AnimatePresence>

        {/* ─── FLOATING RIGHT INSPECTOR ─────────────────────────────────────── */}
        <AnimatePresence>
          {!inspectorCollapsed ? (
            <DraggableResizablePanel
              key="inspector-panel"
              title={selectedNode ? 'Node Inspector' : 'Workflow'}
              isLight={isLight}
              glassPanel={glassPanel}
              panelText={panelText}
              panelMuted={panelMuted}
              panelBdr={panelBdr}
              containerRef={reactFlowWrapper}
              onCollapse={() => setInspectorCollapsed(true)}
            >
              {selectedNode ? (
                <NodeInspector
                  node={selectedNode}
                  instanceId={instanceId}
                  templateCapabilityId={template?.capabilityId ?? null}
                  onClose={() => setSelectedNode(null)}
                  onSave={handleInspectorSave}
                  saving={patchNode.isPending}
                  customNodeTypes={customNodeTypes}
                  outgoingEdges={selectedNodeOutgoingEdges}
                  workflowParams={workflowParams}
                  templateVariables={template?.variables ?? []}
                  teamGlobals={teamGlobals}
                  onUpdateBranch={handleUpdateBranch}
                  onDeleteBranch={handleDeleteBranch}
                  onTestBranch={(edgeId) => setBranchTest({ sourceNodeId: selectedNode.id, highlightEdgeId: edgeId })}
                />
              ) : (
                /* ── Workflow summary panel ── */
                <div style={{ padding: '16px' }}>
                  {/* Instance summary card */}
                  <div style={{
                    padding: '12px 14px', borderRadius: 14, marginBottom: 14,
                    background: isLight ? 'rgba(34,197,94,0.05)' : 'rgba(34,197,94,0.07)',
                    border: '1px solid rgba(34,197,94,0.18)',
                  }}>
                    <p style={{ fontSize: 13, fontWeight: 700, color: panelText, marginBottom: 5, lineHeight: 1.3 }}>
                      {instance?.name}
                    </p>
                    <span style={{
                      fontSize: 8, fontWeight: 800, padding: '3px 8px', borderRadius: 6,
                      background: `${statusClr}16`, color: statusClr, border: `1px solid ${statusClr}28`,
                      textTransform: 'uppercase', letterSpacing: '0.14em',
                    }}>
                      {instance?.status}
                    </span>
                  </div>

                  {/* Progress bar */}
                  {totalNodes > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: 9, color: panelMuted, textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 700 }}>Progress</span>
                        <span style={{ fontSize: 10, color: '#22c55e', fontWeight: 700, fontFamily: 'monospace' }}>{completedPct}%</span>
                      </div>
                      <div style={{ height: 5, borderRadius: 3, background: isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                        <motion.div
                          style={{ height: '100%', background: 'linear-gradient(90deg,#22c55e,#4ade80)', borderRadius: 3 }}
                          initial={{ width: 0 }}
                          animate={{ width: `${completedPct}%` }}
                          transition={{ duration: 0.6, ease: 'easeOut' }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Node stats grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, marginBottom: 16 }}>
                    {[
                      { label: 'Pending',   count: pendingCnt,   color: panelMuted },
                      { label: 'Active',    count: activeCnt,    color: '#22c55e' },
                      { label: 'Completed', count: completedCnt, color: '#4ade80' },
                      { label: 'Failed',    count: failedCnt,    color: '#f87171' },
                    ].map(({ label, count, color }) => (
                      <div key={label} style={{
                        padding: '10px 12px', borderRadius: 12,
                        background: isLight ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${panelBdr}`,
                      }}>
                        <p style={{ fontSize: 8, color: panelMuted, textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 700, marginBottom: 3 }}>{label}</p>
                        <p style={{ fontSize: 24, fontWeight: 800, color, fontFamily: 'monospace', lineHeight: 1 }}>{count}</p>
                      </div>
                    ))}
                  </div>

                  {/* Lifecycle actions */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {canValidate && (
                      <button
                        onClick={() => {
                          const result = validateWorkflow(rfNodes.map(n => ({
                            id: n.id,
                            data: { label: n.data.label, nodeType: n.data.nodeType, config: n.data.config as Record<string, unknown> | undefined },
                          })), rfEdges.map(e => ({ source: e.source, target: e.target })))
                          setValidationResult(result)
                          setValidateOpen(true)
                        }}
                        style={{
                          padding: '10px', borderRadius: 11,
                          border: canStart ? '1.5px solid rgba(34,197,94,0.4)' : '1.5px solid rgba(99,102,241,0.4)',
                          background: canStart ? 'rgba(34,197,94,0.14)' : 'rgba(99,102,241,0.12)',
                          color: canStart ? '#22c55e' : '#818cf8',
                          fontSize: 12, fontWeight: 700, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                        }}
                      >
                        <CheckCircle size={13} /> {canStart ? 'Validated — Start Workflow' : 'Validate Workflow'}
                      </button>
                    )}
                    {instance?.status === 'ACTIVE' && (
                      <div style={{ display: 'flex', gap: 7 }}>
                        <button
                          onClick={() => pauseInstanceMut.mutate()}
                          style={{
                            flex: 1, padding: '8px', borderRadius: 11, border: '1px solid rgba(251,191,36,0.3)',
                            background: 'rgba(251,191,36,0.10)', color: '#fbbf24',
                            fontSize: 11, fontWeight: 700, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                          }}
                        >
                          <Pause size={11} /> Pause
                        </button>
                        <button
                          onClick={() => { if (confirm('Cancel workflow?')) cancelInstanceMut.mutate(undefined) }}
                          style={{
                            flex: 1, padding: '8px', borderRadius: 11, border: '1px solid rgba(248,113,113,0.3)',
                            background: 'rgba(248,113,113,0.10)', color: '#f87171',
                            fontSize: 11, fontWeight: 700, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                          }}
                        >
                          <Square size={11} /> Cancel
                        </button>
                      </div>
                    )}
                    {instance?.status === 'PAUSED' && (
                      <button
                        onClick={() => resumeInstanceMut.mutate()}
                        style={{
                          padding: '10px', borderRadius: 11, border: '1.5px solid rgba(34,197,94,0.4)',
                          background: 'rgba(34,197,94,0.14)', color: '#22c55e',
                          fontSize: 12, fontWeight: 700, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                        }}
                      >
                        <RotateCw size={13} /> Resume
                      </button>
                    )}
                  </div>

                  <p style={{ fontSize: 9, color: panelMuted, marginTop: 20, lineHeight: 1.7, textAlign: 'center' }}>
                    Click a node on the canvas to inspect and configure it.
                  </p>
                </div>
              )}
            </DraggableResizablePanel>
          ) : (
            /* ── Collapsed inspector trigger ── */
            <motion.button
              key="inspector-collapsed"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 16 }}
              transition={{ duration: 0.18 }}
              onClick={() => setInspectorCollapsed(false)}
              title="Open inspector"
              style={{
                position: 'absolute', right: 12, top: 72, zIndex: 20, pointerEvents: 'auto',
                ...glassPanel(isLight),
                borderRadius: 16, padding: '8px 10px',
                display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                border: `1px solid ${panelBdr}`,
                background: 'none', color: panelMuted, fontSize: 11, fontWeight: 700,
                transition: 'color 0.12s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = panelText }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = panelMuted }}
            >
              <Wrench size={14} />
              <span style={{ writingMode: 'vertical-rl', textOrientation: 'mixed', transform: 'rotate(180deg)', letterSpacing: '0.1em', textTransform: 'uppercase', fontSize: 9, fontWeight: 800 }}>
                Inspect
              </span>
            </motion.button>
          )}
        </AnimatePresence>

        {/* ─── VALIDATION PANEL ──────────────────────────────────────────────── */}
        <AnimatePresence>
          {validateOpen && validationResult && (
            <motion.div
              key="validation-panel"
              initial={{ y: 80, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 80, opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              style={{
                position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
                zIndex: 60, pointerEvents: 'auto',
                width: 520, maxHeight: 440,
                ...glassPanel(isLight),
                borderRadius: 18, border: `1px solid ${panelBdr}`,
                display: 'flex', flexDirection: 'column',
                boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
              }}
            >
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px 10px', borderBottom: `1px solid ${panelBdr}`, flexShrink: 0 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: validationResult.issues.filter(i => i.severity === 'error').length === 0
                    ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                }}>
                  <CheckCircle size={14} style={{ color: validationResult.issues.filter(i => i.severity === 'error').length === 0 ? '#22c55e' : '#f87171' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 13, fontWeight: 700, color: panelText, lineHeight: 1.2 }}>
                    Workflow Validation
                  </p>
                  <p style={{ fontSize: 10, color: panelMuted, marginTop: 1 }}>
                    {validationResult.issues.filter(i => i.severity === 'error').length === 0
                      ? '✓ No errors — workflow is ready to start'
                      : `${validationResult.issues.filter(i => i.severity === 'error').length} error${validationResult.issues.filter(i => i.severity === 'error').length > 1 ? 's' : ''} must be fixed before starting`}
                    {validationResult.issues.filter(i => i.severity === 'warning').length > 0
                      ? ` · ${validationResult.issues.filter(i => i.severity === 'warning').length} warning${validationResult.issues.filter(i => i.severity === 'warning').length > 1 ? 's' : ''}`
                      : ''}
                  </p>
                </div>
                <button onClick={() => setValidateOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: panelMuted, padding: 4 }}>
                  <X size={14} />
                </button>
              </div>

              {/* Scrollable body */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '12px 18px' }}>
                {validationResult.issues.length === 0 && (
                  <p style={{ fontSize: 12, color: '#22c55e', fontWeight: 600 }}>All checks passed.</p>
                )}

                {/* Errors */}
                {validationResult.issues.filter(i => i.severity === 'error').map((issue, idx) => (
                  <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'flex-start' }}>
                    <span style={{ fontSize: 10, color: '#f87171', flexShrink: 0, marginTop: 2 }}>●</span>
                    <p style={{ fontSize: 11, color: '#f87171', lineHeight: 1.5 }}>{issue.message}</p>
                    {issue.nodeId && (
                      <button
                        onClick={() => {
                          const node = rfNodes.find(n => n.id === issue.nodeId)
                          if (node) { rfInstance?.setCenter(node.position.x + 75, node.position.y + 40, { zoom: 1.2, duration: 400 }); setSelectedNode(node) }
                        }}
                        style={{ marginLeft: 'auto', flexShrink: 0, background: 'none', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 5, color: '#f87171', fontSize: 9, padding: '2px 6px', cursor: 'pointer', fontWeight: 700 }}
                      >
                        Show
                      </button>
                    )}
                  </div>
                ))}

                {/* Warnings */}
                {validationResult.issues.filter(i => i.severity === 'warning').length > 0 && (
                  <>
                    <p style={{ fontSize: 9, fontWeight: 700, color: panelMuted, textTransform: 'uppercase', letterSpacing: '0.12em', margin: '10px 0 6px' }}>Warnings</p>
                    {validationResult.issues.filter(i => i.severity === 'warning').map((issue, idx) => (
                      <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 5, alignItems: 'flex-start' }}>
                        <span style={{ fontSize: 10, color: '#fbbf24', flexShrink: 0, marginTop: 2 }}>▲</span>
                        <p style={{ fontSize: 11, color: panelMuted, lineHeight: 1.5 }}>{issue.message}</p>
                        {issue.nodeId && (
                          <button
                            onClick={() => {
                              const node = rfNodes.find(n => n.id === issue.nodeId)
                              if (node) { rfInstance?.setCenter(node.position.x + 75, node.position.y + 40, { zoom: 1.2, duration: 400 }); setSelectedNode(node) }
                            }}
                            style={{ marginLeft: 'auto', flexShrink: 0, background: 'none', border: `1px solid ${panelBdr}`, borderRadius: 5, color: panelMuted, fontSize: 9, padding: '2px 6px', cursor: 'pointer', fontWeight: 700 }}
                          >
                            Show
                          </button>
                        )}
                      </div>
                    ))}
                  </>
                )}

                {/* Outputs */}
                {validationResult.outputs.length > 0 && (
                  <>
                    <div style={{ width: '100%', height: 1, background: panelBdr, margin: '12px 0 10px' }} />
                    <p style={{ fontSize: 9, fontWeight: 700, color: panelMuted, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 8 }}>Workflow Outputs</p>
                    {validationResult.outputs.map((out, idx) => (
                      <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                        <span style={{ fontSize: 12 }}>
                          {out.outputType ? (CONSUMABLE_OUTPUT_LABEL[out.outputType as ConsumableOutputType]?.charAt(0) ?? '📤') : '📤'}
                        </span>
                        <span style={{ fontSize: 11, color: panelText, fontWeight: 600 }}>
                          {out.outputType ? CONSUMABLE_OUTPUT_LABEL[out.outputType as ConsumableOutputType] ?? out.outputType : TERMINAL_OUTPUT_LABEL[out.nodeType] ?? out.nodeType}
                        </span>
                        <span style={{ fontSize: 10, color: panelMuted }}>via "{out.nodeLabel}"</span>
                      </div>
                    ))}
                  </>
                )}
              </div>

              {/* Footer */}
              <div style={{ padding: '10px 18px 14px', borderTop: `1px solid ${panelBdr}`, flexShrink: 0, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setValidateOpen(false)}
                  style={{ padding: '7px 16px', borderRadius: 9, border: `1px solid ${panelBdr}`, background: 'transparent', color: panelMuted, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                >
                  Close
                </button>
                {canStart && (
                  <button
                    onClick={() => { setValidateOpen(false); startInstance.mutate() }}
                    disabled={startInstance.isPending}
                    style={{
                      padding: '7px 18px', borderRadius: 9, border: '1.5px solid rgba(34,197,94,0.5)',
                      background: 'rgba(34,197,94,0.18)', color: '#22c55e',
                      fontSize: 12, fontWeight: 700, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}
                  >
                    <Play size={11} /> Start Workflow
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </WFNodeContext.Provider>
  )
}
