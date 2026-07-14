/**
 * RunGraphView — designer-style graph view of a server-driven workflow run.
 *
 * Renders the run's nodes as a horizontal React Flow graph (like the workflow
 * designer) instead of the vertical timeline. Each node card shows its status +
 * a compact live-log line + actions (Restart / Artifacts / Chat, and
 * Approve / Reject on a stage that's awaiting review). Selecting a node opens a
 * right-side panel with Log / Artifacts / Chat tabs for that stage.
 *
 * Server-only — reuses the same endpoints RunViewerPage uses:
 *   GET  /workflow-instances/:id/nodes | /edges        (passed in as props)
 *   GET  /consumables?instanceId&nodeId                (per-node artifacts/log)
 *   POST /workflow-instances/:id/nodes/:nodeId/restart
 *   POST /workflow-instances/:id/nodes/:nodeId/force-complete   (approve/advance)
 */
import { useMemo, useState, useCallback, useEffect, type CSSProperties, type ElementType } from 'react'
import { RuntimeWidgetForm } from '../forms/widgets/RuntimeWidgetForm'
import type { FormWidget } from '../forms/widgets/types'
import ReactFlow, {
  Background, BackgroundVariant, Controls, Handle, Position, Panel, useNodesState,
  type Edge, type NodeProps,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast, errText } from '../../components/Toast'
import { runStatusVisual } from './runStatus'
import { unwrapList } from '../../lib/unwrap'
import {
  ArrowLeft, List, AlertCircle,
  RotateCw, FileText, MessageSquare, X, Check, Ban, Send, ExternalLink,
  ShieldCheck, CornerUpLeft, Library, Download, Maximize2, Activity, Copy, Pencil, UserPlus,
  Play, Radio, Bot, Cpu, GitBranch, GitMerge, Package, Wrench, Shield, User, Clock,
  Database, Workflow, Repeat, Shuffle, Zap, RadioTower, Terminal, Network, Square,
  ChevronDown, Upload, Paperclip, Loader2,
} from 'lucide-react'
import { api } from '../../lib/api'
import { MarkdownView } from './MarkdownView'
import { ArtifactFullscreen } from './ArtifactFullscreen'
import { buildWorkbenchLaunchUrl } from './workbenchLaunch'
import { CopilotActivityPanel } from './CopilotActivityPanel'

// Non-agentic node types that need their own real handler (form-fill, approval
// decision, workbench, etc.). The graph shows status/log/artifacts/restart for
// them like any node, but for the actual interaction it routes to the Timeline
// view, which already has the purpose-built panels.
const INTERACTIVE_TYPES = new Set([
  'HUMAN_TASK', 'APPROVAL', 'WORKBENCH_TASK', 'CONSUMABLE_CREATION', 'DECISION_GATE', 'WORK_ITEM',
])

export interface RunGraphNodeData {
  id: string
  nodeType: string
  label: string
  status: string
  config: Record<string, unknown>
  positionX?: number
  positionY?: number
  createdAt?: string
}
export interface RunGraphEdgeData {
  id: string
  sourceNodeId: string
  targetNodeId: string
  edgeType: string
  label?: string | null
  condition?: Record<string, unknown> | null
}

// Status visuals come from the shared runtime palette (one source of truth for
// graph / timeline / dashboard).
const st = runStatusVisual

const RUN_DOMAIN = {
  start: '#16a34a',
  end: '#82828e',
  agent: '#7c3aed',
  human: '#d97706',
  governance: '#9333ea',
  decision: '#2563eb',
  data: '#0d9488',
  integration: '#ea580c',
  signal: '#0891b2',
  error: '#dc2626',
} as const

const RUN_NODE_VISUAL: Record<string, { color: string; Icon: ElementType; domain: string }> = {
  START: { color: RUN_DOMAIN.start, Icon: Play, domain: 'Trigger' },
  END: { color: RUN_DOMAIN.end, Icon: Square, domain: 'Finish' },
  AGENT_TASK: { color: RUN_DOMAIN.agent, Icon: Bot, domain: 'Agent' },
  DIRECT_LLM_TASK: { color: RUN_DOMAIN.agent, Icon: Cpu, domain: 'Direct LLM' },
  WORKBENCH_TASK: { color: RUN_DOMAIN.agent, Icon: ShieldCheck, domain: 'Workbench' },
  HUMAN_TASK: { color: RUN_DOMAIN.human, Icon: User, domain: 'Human' },
  APPROVAL: { color: RUN_DOMAIN.governance, Icon: Check, domain: 'Approval' },
  GOVERNANCE_GATE: { color: RUN_DOMAIN.governance, Icon: Shield, domain: 'Governance' },
  POLICY_CHECK: { color: RUN_DOMAIN.governance, Icon: Shield, domain: 'Policy' },
  VERIFIER: { color: RUN_DOMAIN.governance, Icon: ShieldCheck, domain: 'Verifier' },
  EVAL_GATE: { color: RUN_DOMAIN.governance, Icon: Activity, domain: 'Evaluator' },
  DECISION_GATE: { color: RUN_DOMAIN.decision, Icon: GitMerge, domain: 'Decision' },
  INCLUSIVE_GATEWAY: { color: RUN_DOMAIN.decision, Icon: Shuffle, domain: 'Gateway' },
  EVENT_GATEWAY: { color: RUN_DOMAIN.decision, Icon: Zap, domain: 'Event gate' },
  PARALLEL_FORK: { color: RUN_DOMAIN.decision, Icon: GitBranch, domain: 'Parallel' },
  PARALLEL_JOIN: { color: RUN_DOMAIN.decision, Icon: GitMerge, domain: 'Join' },
  FOREACH: { color: RUN_DOMAIN.decision, Icon: Repeat, domain: 'Loop' },
  CONSUMABLE_CREATION: { color: RUN_DOMAIN.data, Icon: Package, domain: 'Artifact' },
  DATA_SINK: { color: RUN_DOMAIN.data, Icon: Database, domain: 'Data' },
  SET_CONTEXT: { color: RUN_DOMAIN.data, Icon: Network, domain: 'Context' },
  TOOL_REQUEST: { color: RUN_DOMAIN.integration, Icon: Wrench, domain: 'Tool' },
  CREATE_BRANCH: { color: RUN_DOMAIN.integration, Icon: GitBranch, domain: 'Git' },
  GIT_PUSH: { color: RUN_DOMAIN.integration, Icon: GitBranch, domain: 'Git' },
  RAISE_PR: { color: RUN_DOMAIN.integration, Icon: GitMerge, domain: 'Git' },
  RUN_PYTHON: { color: RUN_DOMAIN.integration, Icon: Terminal, domain: 'Script' },
  CALL_WORKFLOW: { color: RUN_DOMAIN.integration, Icon: Workflow, domain: 'Workflow' },
  WORK_ITEM: { color: RUN_DOMAIN.integration, Icon: Network, domain: 'Work item' },
  TIMER: { color: RUN_DOMAIN.signal, Icon: Clock, domain: 'Timer' },
  SIGNAL_WAIT: { color: RUN_DOMAIN.signal, Icon: Radio, domain: 'Signal' },
  SIGNAL_EMIT: { color: RUN_DOMAIN.signal, Icon: RadioTower, domain: 'Signal' },
  EVENT_EMIT: { color: RUN_DOMAIN.signal, Icon: Send, domain: 'Event' },
  ERROR_CATCH: { color: RUN_DOMAIN.error, Icon: AlertCircle, domain: 'Error' },
}

const RUN_NODE_LABELS: Record<string, string> = {
  START: 'Start',
  END: 'End',
  HUMAN_TASK: 'Human Task',
  AGENT_TASK: 'Agent Task',
  DIRECT_LLM_TASK: 'Direct LLM',
  WORKBENCH_TASK: 'Workbench',
  APPROVAL: 'Approval',
  DECISION_GATE: 'Decision',
  CONSUMABLE_CREATION: 'Create Artifact',
  TOOL_REQUEST: 'Tool Request',
  CREATE_BRANCH: 'Create Branch',
  GIT_PUSH: 'Git Push',
  RAISE_PR: 'Raise PR',
  POLICY_CHECK: 'Policy Check',
  EVAL_GATE: 'Eval Gate',
  VERIFIER: 'Verifier',
  GOVERNANCE_GATE: 'Governance Gate',
  TIMER: 'Timer',
  SIGNAL_WAIT: 'Signal Wait',
  SIGNAL_EMIT: 'Signal Emit',
  CALL_WORKFLOW: 'Sub-workflow',
  WORK_ITEM: 'Work Item',
  FOREACH: 'For Each',
  PARALLEL_FORK: 'Parallel Fork',
  PARALLEL_JOIN: 'Parallel Join',
  INCLUSIVE_GATEWAY: 'Inclusive Gateway',
  EVENT_GATEWAY: 'Event Gateway',
  DATA_SINK: 'Data Sink',
  SET_CONTEXT: 'Set Context',
  ERROR_CATCH: 'Error Catch',
  RUN_PYTHON: 'Run Python',
  EVENT_EMIT: 'Emit Event',
}

function runNodeVisual(nodeType: string) {
  return RUN_NODE_VISUAL[nodeType] ?? { color: '#82828e', Icon: Workflow, domain: 'Workflow' }
}

function runNodeLabel(nodeType: string) {
  return RUN_NODE_LABELS[nodeType] ?? nodeType.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, s => s.toUpperCase())
}

function activeStatus(status: string | null | undefined): boolean {
  return ['ACTIVE', 'RUNNING'].includes(String(status ?? '').toUpperCase())
}

function terminalStatus(status: string | null | undefined): boolean {
  return ['COMPLETED', 'CANCELLED', 'FAILED', 'SKIPPED'].includes(String(status ?? '').toUpperCase())
}

function configList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : []
}

function nodeArtifactCounts(config: Record<string, unknown>) {
  return {
    reads: configList(config.inputArtifacts).length,
    writes: configList(config.outputArtifacts).length,
  }
}

function executionRouteLabel(config: Record<string, unknown>, nodeType?: string): string {
  const standard = config.standard && typeof config.standard === 'object' ? config.standard as Record<string, unknown> : {}
  const location = String(config.executionLocation ?? standard.executionLocation ?? '').trim()
  const llmRoute = String(config.llmRoute ?? standard.llmRoute ?? '').trim()
  const executor = String(config.executor ?? standard.executor ?? '').trim()
  if (llmRoute) return llmRoute.replace(/[_-]/g, ' ')
  if (executor) return executor.replace(/[_-]/g, ' ')
  if (location) return location.toLowerCase()
  if (nodeType === 'DIRECT_LLM_TASK') return 'workgraph llm'
  if (nodeType === 'AGENT_TASK') return 'mcp/context'
  return 'server'
}

function savedPosition(node: RunGraphNodeData): { x: number; y: number } | null {
  const x = typeof node.positionX === 'number' ? node.positionX : node.config?.positionX
  const y = typeof node.positionY === 'number' ? node.positionY : node.config?.positionY
  if (typeof x === 'number' && typeof y === 'number') return { x, y }
  return null
}

function runEdgeLabel(edge: RunGraphEdgeData): string | undefined {
  const condition = edge.condition ?? {}
  if (typeof condition.label === 'string' && condition.label.trim()) return condition.label.trim()
  if (condition.isDefault === true) return 'else'
  const conditions = Array.isArray(condition.conditions) ? condition.conditions : []
  const first = conditions[0] as Record<string, unknown> | undefined
  if (first && typeof first.left === 'string' && typeof first.op === 'string') {
    const right = ['exists', 'not_exists'].includes(first.op) ? '' : ` ${String(first.right ?? '')}`
    return `${first.left} ${first.op}${right}`.trim()
  }
  return typeof edge.label === 'string' && edge.label.trim() ? edge.label.trim() : undefined
}

// ─── Layout: layered columns by topological depth (horizontal flow) ──────────
function layout(nodes: RunGraphNodeData[], edges: RunGraphEdgeData[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>()
  const haveSaved = nodes.length > 0 && nodes.every(n => savedPosition(n) !== null)
  if (haveSaved) {
    for (const n of nodes) {
      const saved = savedPosition(n)
      if (saved) pos.set(n.id, saved)
    }
    return pos
  }
  const incoming = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const n of nodes) { incoming.set(n.id, 0); adj.set(n.id, []) }
  for (const e of edges) {
    if (!adj.has(e.sourceNodeId) || !incoming.has(e.targetNodeId)) continue
    adj.get(e.sourceNodeId)!.push(e.targetNodeId)
    incoming.set(e.targetNodeId, (incoming.get(e.targetNodeId) ?? 0) + 1)
  }
  const depth = new Map<string, number>()
  const q = nodes.filter(n => (incoming.get(n.id) ?? 0) === 0).map(n => n.id)
  q.forEach(idn => depth.set(idn, 0))
  const indeg = new Map(incoming)
  while (q.length) {
    const cur = q.shift()!
    const d = depth.get(cur) ?? 0
    for (const nxt of adj.get(cur) ?? []) {
      depth.set(nxt, Math.max(depth.get(nxt) ?? 0, d + 1))
      indeg.set(nxt, (indeg.get(nxt) ?? 1) - 1)
      if ((indeg.get(nxt) ?? 0) === 0) q.push(nxt)
    }
  }
  const COL_W = 300, ROW_H = 168
  const perCol = new Map<number, number>()
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0
    const row = perCol.get(d) ?? 0
    perCol.set(d, row + 1)
    pos.set(n.id, { x: d * COL_W, y: row * ROW_H })
  }
  return pos
}

// ─── Custom node card ────────────────────────────────────────────────────────
type CardData = RunGraphNodeData & {
  selected: boolean
  onSelect: (id: string, tab?: PanelTab) => void
  onRestart: (id: string) => void
  onApprove: (id: string) => void
  onStart: (id: string) => void
  busy: boolean
}
function RunGraphNode({ data }: NodeProps<CardData>) {
  const s = st(data.status)
  const active = activeStatus(data.status)
  const done = terminalStatus(data.status)
  const isAgent = data.nodeType === 'AGENT_TASK' || data.nodeType === 'DIRECT_LLM_TASK'
  const isInteractive = INTERACTIVE_TYPES.has(data.nodeType)
  const visual = runNodeVisual(data.nodeType)
  const VIcon = visual.Icon
  const SIcon = s.Icon
  const artifactCounts = nodeArtifactCounts(data.config ?? {})
  const route = executionRouteLabel(data.config ?? {}, data.nodeType)
  // Per-node start gate: a manual/event node sits ACTIVE + _awaitingStart until triggered.
  const std = (data.config?.standard && typeof data.config.standard === 'object' ? data.config.standard as Record<string, unknown> : {})
  const startMode = String(data.config?.startMode ?? std.startMode ?? 'auto').toLowerCase()
  const startSignal = String(data.config?.startSignal ?? std.startSignal ?? '')
  const awaitingStart = active && data.config?._awaitingStart === true
  const btn = (label: string, Icon: typeof RotateCw, onClick: () => void, tone?: 'approve' | 'reject') => (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      disabled={data.busy}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        width: '100%', padding: '6px 8px', borderRadius: 8, fontSize: 11, fontWeight: 800, cursor: 'pointer',
        border: '1px solid', borderColor: tone === 'approve' ? '#2f9e5b' : tone === 'reject' ? '#c0453f' : 'rgba(255,255,255,0.12)',
        background: tone === 'approve' ? 'linear-gradient(135deg, #3fbf75, #2f9e5b)' : tone === 'reject' ? 'linear-gradient(135deg, #e06a66, #c0453f)' : '#17171c',
        color: tone ? '#fff' : '#c4c4cc', opacity: data.busy ? 0.6 : 1,
        boxShadow: 'none',
      }}
    >
      <Icon size={12} /> {label}
    </button>
  )
  return (
    <div
      className="wg-run-node-card"
      onClick={() => data.onSelect(data.id)}
      style={{
        width: 284, borderRadius: 14, background: '#101013', cursor: 'pointer',
        border: `1px solid ${data.selected ? visual.color : 'rgba(255,255,255,0.11)'}`,
        boxShadow: data.selected ? `0 0 0 1px ${visual.color}, 0 0 28px -2px ${visual.color}55, 0 14px 32px -16px rgba(0,0,0,0.75)` : '0 1px 2px rgba(0,0,0,0.4), 0 12px 30px -16px rgba(0,0,0,0.7)',
        overflow: 'hidden',
        position: 'relative',
        opacity: done && !data.selected ? 0.92 : 1,
      }}
    >
      <div style={{ height: 4, background: `linear-gradient(90deg, ${visual.color}, ${s.color}, transparent)` }} />
      <Handle type="target" position={Position.Left} style={{ background: visual.color, border: '2px solid #101013', width: 12, height: 12, left: -6 }} />
      <Handle type="source" position={Position.Right} style={{ background: visual.color, border: '2px solid #101013', width: 12, height: 12, right: -6 }} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 13px 8px' }}>
        <div style={{
          width: 40, height: 40, borderRadius: 12, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: visual.color, background: `${visual.color}14`, border: `1px solid ${visual.color}30`,
        }}>
          <VIcon size={17} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 650, color: '#f2f2f5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>{data.label}</div>
          <div style={{ marginTop: 3, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 9, fontWeight: 800, color: visual.color, letterSpacing: '0.10em', textTransform: 'uppercase' }}>{visual.domain}</span>
            <span style={{ width: 3, height: 3, borderRadius: 999, background: 'rgba(255,255,255,0.2)' }} />
            <span style={{ fontSize: 9, fontWeight: 700, color: '#82828e', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{route}</span>
          </div>
        </div>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontSize: 9, fontWeight: 800, color: s.color, padding: '4px 7px', borderRadius: 999,
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>
          <SIcon size={10} /> {awaitingStart ? (startMode === 'event' ? 'Signal' : 'Start') : s.label}
        </span>
      </div>

      <div style={{ padding: '0 13px 9px', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={nodeMiniPill('#b4b4bd', 'rgba(255,255,255,0.05)', 'rgba(255,255,255,0.09)')}>{runNodeLabel(data.nodeType)}</span>
        {artifactCounts.reads > 0 && <span style={nodeMiniPill('#5ab0f0', 'rgba(90,176,240,0.12)', 'rgba(90,176,240,0.3)')}>Reads {artifactCounts.reads}</span>}
        {artifactCounts.writes > 0 && <span style={nodeMiniPill('#52d788', 'rgba(82,215,136,0.12)', 'rgba(82,215,136,0.3)')}>Writes {artifactCounts.writes}</span>}
      </div>

      <div style={{ margin: '0 13px 10px', padding: '8px 9px', borderRadius: 9, background: 'rgba(255,255,255,0.03)', border: `1px solid ${active ? 'rgba(124,124,245,0.4)' : 'rgba(255,255,255,0.07)'}`, minHeight: 42 }}>
        <div style={{ fontSize: 8.5, fontWeight: 800, color: '#82828e', letterSpacing: '0.13em', marginBottom: 3, textTransform: 'uppercase' }}>{active ? 'Live signal' : 'Last output'}</div>
        <LiveLogPeek instanceId={data.config._instanceId as string} nodeId={data.id} active={active} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 13px 13px' }}>
        {awaitingStart && startMode === 'manual' && btn('Start', Play, () => data.onStart(data.id), 'approve')}
        {awaitingStart && startMode === 'event' && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '7px 9px', borderRadius: 8,
            border: '1px dashed rgba(6,182,212,0.5)', background: 'rgba(6,182,212,0.08)', color: '#5ab0f0', fontSize: 10.5, fontWeight: 700,
          }}>
            <Radio size={12} /> Awaiting signal{startSignal ? `: ${startSignal}` : ''}
          </div>
        )}
        {isAgent && active && !awaitingStart && (
          <>
            {btn('Approve', Check, () => data.onApprove(data.id), 'approve')}
            {btn('Reject', Ban, () => data.onSelect(data.id, 'chat'), 'reject')}
          </>
        )}
        {isInteractive && active && !awaitingStart && btn('Open', ExternalLink, () => data.onSelect(data.id))}
        {btn(active ? 'Restart' : 'Restart stage', RotateCw, () => data.onRestart(data.id))}
        <div style={{ display: 'flex', gap: 5 }}>
          {/* Chat = copilot refine — agent stages only. */}
          {isAgent && <span style={{ flex: 1 }}>{btn('Chat', MessageSquare, () => data.onSelect(data.id, 'chat'))}</span>}
          <span style={{ flex: 1 }}>{btn('Artifacts', FileText, () => data.onSelect(data.id, 'artifacts'))}</span>
        </div>
      </div>
    </div>
  )
}

function nodeMiniPill(color: string, background: string, border: string): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    maxWidth: 112,
    padding: '3px 7px',
    borderRadius: 999,
    border: `1px solid ${border}`,
    background,
    color,
    fontSize: 9,
    fontWeight: 850,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }
}

function LiveLogPeek({ instanceId, nodeId, active }: { instanceId: string; nodeId: string; active: boolean }) {
  const { data } = useConsumables(instanceId, nodeId, active)
  const latest = data?.[data.length - 1]
  const text = (latest?.formData?.content ?? '').toString().replace(/\s+/g, ' ').trim()
  if (!text) return <div style={{ fontSize: 10.5, color: '#82828e' }}>{active ? 'Working…' : '—'}</div>
  return <div style={{ fontSize: 10.5, color: '#b4b4bd', lineHeight: 1.35, maxHeight: 42, overflow: 'hidden' }}>{text.slice(0, 140)}{text.length > 140 ? '…' : ''}</div>
}

type Verdict = { passed: boolean; findings: string[]; rationale?: string; method?: string }
type Consumable = { id: string; name?: string; status?: string; nodeId?: string; createdAt?: string; updatedAt?: string; formData?: { content?: string; _verification?: Verdict } }
// Render markdown for everything except source-code files (which stay as code).
const isCodeArtifact = (name?: string) => /\.(java|ts|tsx|js|jsx|py|json|xml|ya?ml|sql|sh|go|rs|c|cpp|h|html|css|toml|gradle)$/i.test(name ?? '')
// Terminal statuses are immutable (supersede to fork a new editable version); everything else is editable.
const canEditConsumable = (status?: string) => !['PUBLISHED', 'CONSUMED', 'SUPERSEDED'].includes(String(status ?? '').toUpperCase())
// /consumables paginates as { content: [...] } (toPageResponse); tolerate content
// (real key), items (legacy), or a bare array.
// List unwrapping lives in lib/unwrap (one shared helper for every API shape).
function useConsumables(instanceId: string, nodeId: string, live: boolean) {
  return useQuery<Consumable[]>({
    queryKey: ['run-graph-consumables', instanceId, nodeId],
    // /consumables may return a bare array OR a paginated { items: [...] } — handle both.
    queryFn: () => api.get('/consumables', { params: { instanceId, nodeId } }).then(r => unwrapList<Consumable>(r.data)),
    enabled: !!instanceId && !!nodeId,
    refetchInterval: live ? 5_000 : false,
    staleTime: 4_500,
  })
}
// All artifacts across the run — for the phase-by-phase catalog.
function useAllConsumables(instanceId: string, live: boolean) {
  return useQuery<Consumable[]>({
    queryKey: ['run-graph-all-consumables', instanceId],
    queryFn: () => api.get('/consumables', { params: { instanceId } }).then(r => unwrapList<Consumable>(r.data)),
    enabled: !!instanceId,
    refetchInterval: live ? 6_000 : false,
    staleTime: 5_000,
  })
}

type PanelTab = 'form' | 'log' | 'questions' | 'prompt' | 'artifacts' | 'chat'
// Consumable name AgentTaskExecutor stores parsed Copilot clarifying questions under.
const COPILOT_QUESTIONS_NAME = '_copilot_questions'

function consumableText(c: Consumable): string {
  return (c.formData?.content ?? '').toString()
}

function isVisibleDocumentConsumable(c: Consumable): boolean {
  return c.name !== COPILOT_QUESTIONS_NAME && consumableText(c).trim().length > 0
}

function consumableTime(c: Consumable): number {
  const raw = c.updatedAt ?? c.createdAt
  if (!raw) return 0
  const ms = new Date(raw).getTime()
  return Number.isFinite(ms) ? ms : 0
}

function sortConsumablesByNameThenTime(a: Consumable, b: Consumable): number {
  const byName = (a.name ?? '').localeCompare(b.name ?? '')
  return byName || consumableTime(b) - consumableTime(a)
}

type CopilotQuestion = { id: string; question: string; options?: string[] }
// A document uploaded against a run + node for the stage's agent to use on rework.
type UploadedDoc = { id: string; name: string; kind?: string; mimeType?: string | null; sizeBytes?: number | null; uploadedAt?: string }
// Interactive node types that collect a widget form from the user at runtime.
type FillKind = 'task' | 'approval' | 'consumable'
const fillKindFor = (nodeType: string): FillKind | null =>
  nodeType === 'HUMAN_TASK' ? 'task'
  : nodeType === 'APPROVAL' ? 'approval'
  : nodeType === 'CONSUMABLE_CREATION' ? 'consumable'
  : null

export function RunGraphView({ instanceId, instanceStatus, runName, nodes, edges, runContext, usesCopilot, onTimeline, onBack }: {
  instanceId: string
  instanceStatus: string
  runName: string
  nodes: RunGraphNodeData[]
  edges: RunGraphEdgeData[]
  runContext?: Record<string, unknown>
  usesCopilot?: boolean
  onTimeline: () => void
  onBack: () => void
}) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<PanelTab>('log')
  const [showCatalog, setShowCatalog] = useState(false)
  const [showActivity, setShowActivity] = useState(false)
  const live = !['COMPLETED', 'CANCELLED', 'FAILED'].includes((instanceStatus ?? '').toUpperCase())
  const { data: allConsumables = [] } = useAllConsumables(instanceId, live)
  const runDocuments = useMemo(() => allConsumables.filter(isVisibleDocumentConsumable), [allConsumables])

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['run-instance', instanceId] })
  }, [qc, instanceId])

  const restartMut = useMutation({
    mutationFn: (nodeId: string) => api.post(`/workflow-instances/${instanceId}/nodes/${nodeId}/restart`).then(r => r.data),
    onSuccess: () => { toast.success('Stage restarted'); invalidate() },
    onError: (e) => toast.error(errText(e, 'Restart failed')),
  })
  const approveMut = useMutation({
    mutationFn: (nodeId: string) =>
      api.post(`/workflow-instances/${instanceId}/nodes/${nodeId}/force-complete`, { comment: 'Approved from run graph' }).then(r => r.data),
    onSuccess: () => { toast.success('Stage completed — workflow advancing'); invalidate() },
    onError: (e) => toast.error(errText(e, 'Complete & advance failed')),
  })
  // Take over the run: reassign ownership to you (your runtime drives it + clones the
  // work branch if it's not local) and resume if paused.
  const takeOverMut = useMutation({
    mutationFn: () => api.post(`/workflow-instances/${instanceId}/take-over`).then(r => r.data as { alreadyOwner?: boolean }),
    onSuccess: (d) => { toast.success(d?.alreadyOwner ? 'You already own this run' : 'Took over — the run resumes under your runtime'); invalidate() },
    onError: (e) => toast.error(errText(e, 'Take over failed')),
  })
  // Manual start — trigger a node gated with startMode=manual that is ACTIVE and awaiting start.
  const startMut = useMutation({
    mutationFn: (nodeId: string) => api.post(`/workflow-instances/${instanceId}/nodes/${nodeId}/start`).then(r => r.data),
    onSuccess: () => { toast.success('Stage started'); invalidate() },
    onError: (e) => toast.error(errText(e, 'Start failed')),
  })

  // Export the run as a portable Copilot workflow + executable local runner.
  const downloadCopilotExport = useCallback(async (kind: 'yaml' | 'runner', fromPhase?: string) => {
    const path = kind === 'yaml' ? 'copilot-yaml' : 'copilot-runner.sh'
    const ext = kind === 'yaml' ? 'yaml' : 'sh'
    const qs = fromPhase ? `?fromPhase=${encodeURIComponent(fromPhase)}` : ''
    const res = await api.get(`/workflow-instances/${instanceId}/export/${path}${qs}`, { responseType: 'blob' })
    const url = URL.createObjectURL(res.data as Blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `copilot-sdlc-${instanceId.slice(0, 8)}.${ext}`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }, [instanceId])

  const onSelect = useCallback((id: string, t?: PanelTab) => {
    setShowCatalog(false); setShowActivity(false); setSelected(id)
    if (t) { setTab(t); return }
    // Open straight to the form for an active human-task / approval / data-collection node.
    const n = nodes.find(x => x.id === id)
    const w = n?.config?.formWidgets
    const kind = n ? fillKindFor(n.nodeType) : null
    const isFormNode = !!n && kind !== null
      && ['ACTIVE', 'RUNNING'].includes((n.status ?? '').toUpperCase())
      && ((Array.isArray(w) && w.length > 0) || kind === 'approval')
    // A COMPLETED agent stage opens to Documents (the produced deliverables) rather
    // than the execution log — the docs are what the operator wants to see. Active
    // stages still open to the live log.
    const isDoneAgent = (n?.nodeType === 'AGENT_TASK' || n?.nodeType === 'DIRECT_LLM_TASK') && !['ACTIVE', 'RUNNING'].includes((n.status ?? '').toUpperCase())
    setTab(isFormNode ? 'form' : isDoneAgent ? 'artifacts' : 'log')
  }, [nodes])

  const positions = useMemo(() => layout(nodes, edges), [nodes, edges])
  // phases in left→right (execution) order, for the catalog + send-back list
  const orderedRunNodes = useMemo(() => nodes.slice().sort((a, b) => {
    const pa = positions.get(a.id) ?? { x: 0, y: 0 }, pb = positions.get(b.id) ?? { x: 0, y: 0 }
    return pa.x - pb.x || pa.y - pb.y
  }), [nodes, positions])
  const orderedPhases = useMemo(() => orderedRunNodes.map(n => ({ id: n.id, label: n.label })), [orderedRunNodes])
  const completedNodes = useMemo(
    () => orderedPhases.filter(p => (nodes.find(x => x.id === p.id)?.status ?? '').toUpperCase() === 'COMPLETED'),
    [orderedPhases, nodes])
  const busyId = restartMut.isPending ? restartMut.variables : approveMut.isPending ? approveMut.variables : startMut.isPending ? startMut.variables : null
  const statusCounts = useMemo(() => ({
    total: orderedRunNodes.length,
    completed: orderedRunNodes.filter(n => (n.status ?? '').toUpperCase() === 'COMPLETED').length,
    active: orderedRunNodes.filter(n => activeStatus(n.status)).length,
    blocked: orderedRunNodes.filter(n => (n.status ?? '').toUpperCase() === 'BLOCKED').length,
    failed: orderedRunNodes.filter(n => (n.status ?? '').toUpperCase() === 'FAILED').length,
  }), [orderedRunNodes])
  const focusNode = useMemo(() =>
    orderedRunNodes.find(n => (n.status ?? '').toUpperCase() === 'BLOCKED')
    ?? orderedRunNodes.find(n => activeStatus(n.status))
    ?? orderedRunNodes.find(n => (n.status ?? '').toUpperCase() === 'PENDING')
    ?? orderedRunNodes[orderedRunNodes.length - 1]
    ?? null,
    [orderedRunNodes])
  const nextNode = useMemo(() => {
    if (!focusNode) return null
    const idx = orderedRunNodes.findIndex(n => n.id === focusNode.id)
    return orderedRunNodes.slice(Math.max(idx + 1, 0)).find(n => !terminalStatus(n.status)) ?? null
  }, [focusNode, orderedRunNodes])
  const activeNodeIds = useMemo(() => new Set(orderedRunNodes.filter(n => activeStatus(n.status)).map(n => n.id)), [orderedRunNodes])

  // Draggable react-flow nodes (useNodesState) so the user can hand-align the graph.
  // Rebuilt when the run data changes, PRESERVING any positions the user dragged so a
  // poll refresh doesn't snap them back to the computed layout.
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<CardData>([])
  useEffect(() => {
    setRfNodes(prev => {
      const dragged = new Map(prev.map(p => [p.id, p.position]))
      return nodes.map(n => ({
        id: n.id,
        type: 'runCard',
        position: dragged.get(n.id) ?? positions.get(n.id) ?? { x: 0, y: 0 },
        data: {
          ...n,
          config: { ...n.config, _instanceId: instanceId },
          selected: selected === n.id,
          onSelect, onRestart: restartMut.mutate, onApprove: approveMut.mutate, onStart: startMut.mutate,
          busy: busyId === n.id,
        },
      }))
    })
    // onSelect + the *.mutate callbacks are stable; the deps below drive the rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, positions, selected, instanceId, busyId])

  // "Re-align" — snap every node back to the computed topological layout.
  const realign = useCallback(() => {
    setRfNodes(prev => prev.map(n => ({ ...n, position: positions.get(n.id) ?? n.position })))
  }, [positions, setRfNodes])

  const rfEdges: Edge[] = useMemo(() => edges.map(e => {
    const isLiveEdge = live && (activeNodeIds.has(e.sourceNodeId) || activeNodeIds.has(e.targetNodeId))
    const isConditional = e.edgeType === 'CONDITIONAL'
    const isDefault = e.condition?.isDefault === true
    return {
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      label: runEdgeLabel(e),
      animated: isLiveEdge,
      className: isLiveEdge ? 'wg-live-edge' : undefined,
      style: {
        stroke: isLiveEdge ? '#7c7cf5' : isDefault ? '#f5c451' : isConditional ? '#5ab0f0' : 'rgba(255,255,255,0.16)',
        strokeWidth: isLiveEdge ? 2 : isConditional ? 1.75 : 1.25,
        ...(isDefault ? { strokeDasharray: '6 4' } : {}),
      },
      labelStyle: {
        fill: isDefault ? '#f5c451' : '#82828e',
        fontSize: 10,
        fontWeight: 800,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
      },
      labelBgStyle: { fill: '#0c0c0f', fillOpacity: 0.94 },
      labelBgPadding: [6, 3],
      labelBgBorderRadius: 999,
    }
  }), [edges, live, activeNodeIds])

  const nodeTypes = useMemo(() => ({ runCard: RunGraphNode }), [])
  const selectedNode = nodes.find(n => n.id === selected) ?? null

  return (
    <div className="wg-command-center wg-run-dark" style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: '#08080a', color: '#f2f2f5', zIndex: 10 }}>
      <style>{RUN_DARK_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', background: 'rgba(12,12,15,0.85)', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0, minWidth: 0, overflowX: 'auto', backdropFilter: 'blur(18px)' }}>
        <button onClick={onBack} style={topBtn}><ArrowLeft size={13} /> Back</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 640, color: '#f2f2f5', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>{runName}</div>
            <span style={{ fontSize: 10, fontWeight: 700, color: st(instanceStatus).color, padding: '4px 9px', borderRadius: 999, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', letterSpacing: '0.10em', textTransform: 'uppercase' }}>{instanceStatus}</span>
          </div>
          <div style={{ marginTop: 2, fontSize: 10.5, color: '#82828e', fontWeight: 500 }}>Run cockpit · graph, stage actions, documents, receipts, and handoff exports</div>
        </div>
        <MetricPill label="Stages" value={String(statusCounts.total)} tone="#2563eb" />
        <MetricPill label="Done" value={String(statusCounts.completed)} tone="#16a34a" />
        {(statusCounts.blocked > 0 || statusCounts.failed > 0) && <MetricPill label={statusCounts.failed > 0 ? 'Failed' : 'Blocked'} value={String(statusCounts.failed || statusCounts.blocked)} tone={statusCounts.failed > 0 ? '#dc2626' : '#d97706'} />}
        <MetricPill label="Docs" value={String(runDocuments.length)} tone="#0d9488" />
        <button onClick={() => downloadCopilotExport('yaml')} style={topBtn} title="Download this run as a Copilot workflow YAML with artifact/metric pushback instructions"><Download size={13} /> Copilot YAML</button>
        <button onClick={() => downloadCopilotExport('runner')} style={topBtn} title="Download an executable script that runs Copilot CLI and posts artifacts/metrics back to the platform"><Download size={13} /> Runner</button>
        <button disabled={!selected} onClick={() => selected && downloadCopilotExport('yaml', selected)} style={{ ...topBtn, opacity: selected ? 1 : 0.45, cursor: selected ? 'pointer' : 'not-allowed' }} title="Select a phase, then download a Copilot handoff YAML starting there: earlier phases inlined as context (full artifacts + diffs), this phase onward as runnable composed prompts to continue on your own Copilot CLI"><Download size={13} /> Handoff</button>
        <button onClick={() => { setShowCatalog(c => !c); setShowActivity(false); setSelected(null) }} style={{ ...topBtn, ...(showCatalog ? { background: 'rgba(90,176,240,0.12)', borderColor: '#06b6d4', color: '#5ab0f0' } : {}) }} title="All documents this run produced, grouped by agent (mirrors git deliverables/<work-id>/<agent>/) — view or edit each"><Library size={13} /> Documents</button>
        {usesCopilot && (
          <button onClick={() => { setShowActivity(a => !a); setShowCatalog(false); setSelected(null) }} style={{ ...topBtn, ...(showActivity ? { background: 'rgba(124,124,245,0.13)', borderColor: '#8b5cf6', color: '#9a9aff' } : {}) }} title="Live governed activity for this copilot run (LLM calls, tools, phases, commits)"><Activity size={13} /> Activity</button>
        )}
        <button onClick={() => takeOverMut.mutate()} disabled={takeOverMut.isPending} style={topBtn} title="Take over this run: reassign it to you so your runtime drives it (clones the work branch wi/<code> if it isn't local) and resume it if paused"><UserPlus size={13} /> {takeOverMut.isPending ? 'Taking over…' : 'Take over'}</button>
        <button onClick={onTimeline} style={topBtn}><List size={13} /> Timeline</button>
      </div>
      <RunStageRail
        nodes={orderedRunNodes}
        selectedId={selected}
        focusNode={focusNode}
        nextNode={nextNode}
        documents={runDocuments.length}
        onSelect={(nodeId) => onSelect(nodeId)}
      />
      {focusNode && (
        <RunFocusBanner
          node={focusNode}
          nextNode={nextNode}
          selected={selected === focusNode.id}
          onSelect={() => onSelect(focusNode.id)}
        />
      )}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <ReactFlow
            nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            fitView fitViewOptions={{ padding: 0.2 }}
            nodesDraggable nodesConnectable={false} elementsSelectable
            proOptions={{ hideAttribution: true }}
            onPaneClick={() => setSelected(null)}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgba(255,255,255,0.06)" />
            <Controls showInteractive={false} />
            <Panel position="top-right">
              <button
                onClick={realign}
                title="Snap all nodes back to the auto layout"
                style={{ fontSize: 11, fontWeight: 550, color: '#c4c4cc', background: '#141418', border: '1px solid rgba(255,255,255,0.11)', borderRadius: 8, padding: '5px 10px', cursor: 'pointer' }}
              >Re-align</button>
            </Panel>
          </ReactFlow>
        </div>
        {showActivity
          ? <CopilotActivityPanel instanceId={instanceId} />
          : showCatalog
          ? <ArtifactCatalog instanceId={instanceId} live={live} phases={orderedPhases} onClose={() => setShowCatalog(false)} />
          : selectedNode && (
            <NodePanel
              key={selectedNode.id}
              instanceId={instanceId}
              runName={runName}
              node={selectedNode}
              runContext={runContext}
              usesCopilot={usesCopilot}
              live={live}
              tab={tab} setTab={setTab}
              completedNodes={completedNodes}
              onClose={() => setSelected(null)}
              onRestart={() => restartMut.mutate(selectedNode.id)}
              onApprove={() => approveMut.mutate(selectedNode.id)}
              onRestartNode={(nid) => restartMut.mutate(nid)}
              onOpenTimeline={onTimeline}
              busy={busyId === selectedNode.id}
            />
          )}
      </div>
    </div>
  )
}

function MetricPill({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '6px 9px', borderRadius: 999,
      border: `1px solid ${tone}26`, background: `${tone}0f`, color: tone,
      fontSize: 10, fontWeight: 900, letterSpacing: '0.08em', textTransform: 'uppercase',
      whiteSpace: 'nowrap',
      flexShrink: 0,
    }}>
      <strong style={{ fontSize: 12, letterSpacing: 0 }}>{value}</strong>{label}
    </span>
  )
}

function RunStageRail({ nodes, selectedId, focusNode, nextNode, documents, onSelect }: {
  nodes: RunGraphNodeData[]
  selectedId: string | null
  focusNode: RunGraphNodeData | null
  nextNode: RunGraphNodeData | null
  documents: number
  onSelect: (nodeId: string) => void
}) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      gap: 12,
      alignItems: 'center',
      padding: '10px 16px',
      background: 'rgba(248,250,252,0.90)',
      borderBottom: '1px solid rgba(255,255,255,0.1)',
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, overflowX: 'auto', paddingBottom: 1 }}>
        {nodes.map((node, idx) => {
          const status = st(node.status)
          const visual = runNodeVisual(node.nodeType)
          const VIcon = visual.Icon
          const selected = selectedId === node.id
          const focus = focusNode?.id === node.id
          return (
            <button
              key={node.id}
              onClick={() => onSelect(node.id)}
              title={`${node.label} · ${runNodeLabel(node.nodeType)} · ${status.label}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                minWidth: 0,
                maxWidth: 220,
                padding: '7px 9px',
                borderRadius: 999,
                border: `1px solid ${selected ? visual.color : focus ? status.ring : 'rgba(255,255,255,0.1)'}`,
                background: selected ? `${visual.color}12` : focus ? status.bg : '#101013',
                color: selected ? visual.color : '#c4c4cc',
                cursor: 'pointer',
                boxShadow: selected ? `0 0 0 3px ${visual.color}18` : '0 1px 0 rgba(255,255,255,0.9) inset',
                flex: '0 0 auto',
              }}
            >
              <span style={{ color: visual.color, display: 'flex' }}><VIcon size={13} /></span>
              <span style={{ fontSize: 10, fontWeight: 900, color: '#82828e' }}>{idx + 1}</span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 850 }}>{node.label}</span>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: status.color, boxShadow: activeStatus(node.status) ? `0 0 0 4px ${status.color}18` : undefined, flex: '0 0 auto' }} />
            </button>
          )
        })}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, minWidth: 260,
        padding: '7px 10px', borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.1)', background: '#101013',
      }}>
        <div style={{ color: '#0d9488', display: 'flex' }}><Library size={15} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 900, color: '#82828e', letterSpacing: '0.10em', textTransform: 'uppercase' }}>Evidence rail</div>
          <div style={{ fontSize: 11.5, fontWeight: 800, color: '#f2f2f5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {documents} document{documents === 1 ? '' : 's'} · next {nextNode?.label ?? 'no pending stage'}
          </div>
        </div>
      </div>
    </div>
  )
}

function RunFocusBanner({ node, nextNode, selected, onSelect }: {
  node: RunGraphNodeData
  nextNode: RunGraphNodeData | null
  selected: boolean
  onSelect: () => void
}) {
  const status = st(node.status)
  const visual = runNodeVisual(node.nodeType)
  const VIcon = visual.Icon
  const upper = (node.status ?? '').toUpperCase()
  const action =
    upper === 'BLOCKED' ? 'Blocked. Open this stage to see the cause, evidence, and retry or send-back options.'
    : upper === 'FAILED' ? 'Failed. Open logs and decide whether to retry, send back, or inspect artifacts.'
    : activeStatus(node.status) && (node.nodeType === 'AGENT_TASK' || node.nodeType === 'DIRECT_LLM_TASK') ? 'Agent is working or waiting for review. Inspect output, answer questions, or approve.'
    : activeStatus(node.status) ? 'Current stage is active. Open it for required input, logs, or live output.'
    : upper === 'PENDING' ? 'Waiting for upstream stages to produce required inputs.'
    : upper === 'COMPLETED' ? 'Completed. Inspect produced evidence and downstream handoff.'
    : 'Inspect this stage for details.'
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'auto minmax(0, 1fr) auto',
      gap: 12,
      alignItems: 'center',
      margin: '10px 16px 0',
      padding: '12px 14px',
      borderRadius: 16,
      border: `1px solid ${upper === 'BLOCKED' || upper === 'FAILED' ? status.ring : 'rgba(255,255,255,0.1)'}`,
      background: upper === 'BLOCKED' || upper === 'FAILED' ? status.bg : 'rgba(255,255,255,0.86)',
      boxShadow: '0 12px 28px rgba(15,23,42,0.07)',
      flexShrink: 0,
    }}>
      <div style={{
        width: 42, height: 42, borderRadius: 14,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: visual.color, background: `${visual.color}14`, border: `1px solid ${visual.color}30`,
      }}>
        <VIcon size={18} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 10, fontWeight: 950, color: status.color, letterSpacing: '0.14em', textTransform: 'uppercase' }}>Current focus</span>
          <span style={{ width: 3, height: 3, borderRadius: 999, background: 'rgba(255,255,255,0.16)' }} />
          <span style={{ fontSize: 10, fontWeight: 900, color: visual.color, letterSpacing: '0.10em', textTransform: 'uppercase' }}>{runNodeLabel(node.nodeType)}</span>
        </div>
        <div style={{ marginTop: 3, fontSize: 14, fontWeight: 950, color: '#f2f2f5', letterSpacing: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.label}</div>
        <div style={{ marginTop: 3, fontSize: 11.5, color: '#b4b4bd', lineHeight: 1.4 }}>
          {action}{nextNode ? ` Next: ${nextNode.label}.` : ' No downstream stage is waiting.'}
        </div>
      </div>
      <button onClick={onSelect} style={{ ...topBtn, background: selected ? `${visual.color}12` : '#101013', color: selected ? visual.color : '#c4c4cc', borderColor: selected ? `${visual.color}45` : 'rgba(255,255,255,0.1)' }}>
        Open stage
      </button>
    </div>
  )
}

// Dark-skins React Flow's own chrome (Controls, edge labels) which ships as light CSS. Scoped to
// the run cockpit via .wg-run-dark so it can't leak into the rest of the app.
const RUN_DARK_CSS = `
.wg-run-dark .react-flow__controls { box-shadow: none; border: 1px solid rgba(255,255,255,0.1); border-radius: 9px; overflow: hidden; }
.wg-run-dark .react-flow__controls-button { background: #141418; border-bottom: 1px solid rgba(255,255,255,0.07); }
.wg-run-dark .react-flow__controls-button:hover { background: #1c1c22; }
.wg-run-dark .react-flow__controls-button svg { fill: #b4b4bd; }
.wg-run-dark .react-flow__edge-text { fill: #b4b4bd; }
.wg-run-dark .react-flow__edge-textbg { fill: #0c0c0f; }
@keyframes wg-spin { to { transform: rotate(360deg); } }
.wg-spin { animation: wg-spin 0.8s linear infinite; }
`

const topBtn: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5, padding: '6px 11px', borderRadius: 8,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'rgba(255,255,255,0.11)',
  background: '#141418',
  cursor: 'pointer',
  color: '#c4c4cc',
  fontSize: 12,
  fontWeight: 550,
  whiteSpace: 'nowrap',
  flexShrink: 0,
  boxShadow: '0 1px 0 rgba(255,255,255,0.9) inset',
}

function NodePanel({ instanceId, runName, node, runContext, usesCopilot, live, tab, setTab, completedNodes, onClose, onRestart, onApprove, onRestartNode, onOpenTimeline, busy }: {
  instanceId: string
  runName: string
  node: RunGraphNodeData
  runContext?: Record<string, unknown>
  usesCopilot?: boolean
  live: boolean
  tab: PanelTab
  setTab: (t: PanelTab) => void
  completedNodes: { id: string; label: string }[]
  onClose: () => void
  onRestart: () => void
  onApprove: () => void
  onRestartNode: (id: string) => void
  onOpenTimeline: () => void
  busy: boolean
}) {
  const s = st(node.status)
  const visual = runNodeVisual(node.nodeType)
  const VIcon = visual.Icon
  const SIcon = s.Icon
  const artifactCounts = nodeArtifactCounts(node.config ?? {})
  const route = executionRouteLabel(node.config ?? {}, node.nodeType)
  const qc = useQueryClient()
  const [sendBackOpen, setSendBackOpen] = useState(false)
  const { data: consumables = [] } = useConsumables(instanceId, node.id, live)
  const active = activeStatus(node.status)
  // The parsed Copilot questions ride in a hidden `_copilot_questions` consumable;
  // keep it out of the Log + Artifacts views and surface it in its own tab.
  const questions = useMemo<CopilotQuestion[]>(() => {
    const raw = consumables.find(c => c.name === COPILOT_QUESTIONS_NAME)?.formData?.content
    if (!raw) return []
    try { const q = JSON.parse(raw.toString()); return Array.isArray(q) ? q as CopilotQuestion[] : [] } catch { return [] }
  }, [consumables])
  const visibleConsumables = consumables.filter(c => c.name !== COPILOT_QUESTIONS_NAME)
  const latest = visibleConsumables[visibleConsumables.length - 1]
  const isAgent = node.nodeType === 'AGENT_TASK' || node.nodeType === 'DIRECT_LLM_TASK'

  // "Documents produced through this stage" — every run deliverable (from ANY node)
  // created up to when THIS stage completed, so the panel shows the cumulative set
  // (upstream inputs + this stage's output), not just files this run freshly changed.
  // A not-yet-completed stage shows everything produced so far.
  const { data: allRunDocs = [] } = useAllConsumables(instanceId, live)
  const stageCutoff = (node as { completedAt?: string }).completedAt
    ? new Date((node as { completedAt?: string }).completedAt as string).getTime() + 2000
    : Number.MAX_SAFE_INTEGER
  const stageDocs = useMemo(() => allRunDocs
    .filter(isVisibleDocumentConsumable)
    .filter(c => (c.createdAt ? new Date(c.createdAt).getTime() : 0) <= stageCutoff)
    .sort((a, b) => (a.createdAt ? new Date(a.createdAt).getTime() : 0) - (b.createdAt ? new Date(b.createdAt).getTime() : 0)),
    [allRunDocs, stageCutoff])
  const sendBackTargets = completedNodes.filter(c => c.id !== node.id)
  const isInteractive = INTERACTIVE_TYPES.has(node.nodeType)
  const callWorkflowChildId = typeof node.config?._childInstanceId === 'string' ? node.config._childInstanceId : ''
  const { data: callWorkflowChildNodes = [] } = useQuery<RunGraphNodeData[]>({
    queryKey: ['run-instance', callWorkflowChildId, 'nodes'],
    queryFn: () => api.get(`/workflow-instances/${callWorkflowChildId}/nodes`).then(r => r.data),
    enabled: Boolean(callWorkflowChildId),
    refetchInterval: live ? 5_000 : false,
  })
  const callWorkflowWorkbenchNode = callWorkflowChildNodes.find(n => n.nodeType === 'WORKBENCH_TASK')
  const callWorkflowWorkbenchUrl = callWorkflowChildId
    ? buildWorkbenchLaunchUrl(callWorkflowChildId, callWorkflowWorkbenchNode?.id, asRecord(callWorkflowWorkbenchNode?.config?.workbench), 'neo', runContext ?? {})
    : ''
  // Human-task / approval / data-collection: render the widget form inline when
  // the node is active and has a form, instead of pointing at the Timeline view.
  const fillKind = fillKindFor(node.nodeType)
  // Interactive CREATE_BRANCH: paused mid-run to ask the operator for the base branch
  // (+ local/clone dir) before creating the work branch.
  const awaitingBranchInput = active && node.nodeType === 'CREATE_BRANCH' && node.config?._awaitingBranchInput === true
  const formWidgets = (node.config?.formWidgets as FormWidget[] | undefined) ?? []
  // Approvals render their decision controls even with no widget form, so an
  // operator approves/rejects HERE instead of being bounced to the Timeline.
  const showForm = active && !!fillKind && (formWidgets.length > 0 || fillKind === 'approval')
  // Gate executors record WHY they paused the run in the instance context —
  // surface that on the blocked node instead of leaving it buried in JSON.
  const blockInfo = runContext
    ? (runContext._blockedByVerifier ?? runContext._blockedByEvalGate ?? runContext._blockedByGitPush ?? null)
    : null
  // Chat (refine) is copilot-only; non-agent nodes get Log + Artifacts. Questions
  // appears only when Copilot asked some; Form leads when input is needed.
  const baseTabs: PanelTab[] = isAgent
    ? (questions.length ? ['log', 'questions', 'prompt', 'artifacts', 'chat'] : ['log', 'prompt', 'artifacts', 'chat'])
    : ['log', 'artifacts']
  const tabs: PanelTab[] = showForm ? ['form', ...baseTabs] : baseTabs
  const activeTab: PanelTab =
    (tab === 'form' && !showForm) ? 'log'
    : (tab === 'chat' && !isAgent) ? 'log'
    : (tab === 'prompt' && !isAgent) ? 'log'
    : (tab === 'questions' && questions.length === 0) ? 'log'
    : tab

  // Artifact expand/download (parity with the workbench cockpit + the other run panels).
  const [expandedConsumableId, setExpandedConsumableId] = useState<string | null>(null)
  const expandedConsumable = stageDocs.find(c => c.id === expandedConsumableId) ?? visibleConsumables.find(c => c.id === expandedConsumableId)
  // Inline edit-and-save of a document's content. Save re-opens the governance gate
  // (server clears the verdict; APPROVED/UNDER_REVIEW → DRAFT).
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const saveEditMut = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) =>
      api.patch(`/consumables/${id}/content`, { content }).then(r => r.data),
    onSuccess: () => {
      toast.success('Saved — verification re-opened for this document')
      qc.invalidateQueries({ queryKey: ['run-graph-consumables'] })
      qc.invalidateQueries({ queryKey: ['run-graph-all-consumables'] })
      setEditingId(null)
    },
    onError: (e) => toast.error(errText(e, 'save failed')),
  })

  // Upload a reference document for this stage's agent to use on rework — the file
  // is stored against this run + node (POST /documents/upload, kind UPLOAD) and
  // listed back below so the operator can confirm what's attached before restarting.
  const { data: nodeUploads = [] } = useQuery<UploadedDoc[]>({
    queryKey: ['node-uploads', instanceId, node.id],
    enabled: activeTab === 'artifacts' && !!instanceId && !!node.id,
    queryFn: () => api.get('/documents/', { params: { instanceId, nodeId: node.id } }).then(r => r.data as UploadedDoc[]),
  })
  const uploadMut = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('instanceId', instanceId)
      fd.append('nodeId', node.id)
      return api.post('/documents/upload', fd).then(r => r.data)
    },
    onSuccess: () => {
      toast.success('Uploaded — attached to this stage for rework')
      qc.invalidateQueries({ queryKey: ['node-uploads', instanceId, node.id] })
    },
    onError: (e) => toast.error(errText(e, 'upload failed')),
  })
  const openUpload = useCallback(async (id: string) => {
    try {
      const d = await api.get(`/documents/${id}`).then(r => r.data as { downloadUrl?: string })
      if (d?.downloadUrl) window.open(d.downloadUrl, '_blank', 'noopener')
      else toast.error('No download URL available for this file')
    } catch (e) { toast.error(errText(e, 'could not open file')) }
  }, [])

  // Resizable review drawer. Width is persisted in localStorage so it survives
  // re-selecting a node (this panel remounts per selectedNode) and page reloads.
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 760
    const saved = Number(window.localStorage.getItem('runDrawerWidth'))
    return Number.isFinite(saved) && saved >= 320 && saved <= 2400 ? saved : Math.min(880, Math.round(window.innerWidth * 0.92))
  })
  const startPanelResize = (startX: number) => {
    const startWidth = panelWidth
    const onMove = (ev: MouseEvent) => {
      // Drawer is anchored to the right, so dragging LEFT widens it.
      const next = Math.min(Math.max(startWidth + (startX - ev.clientX), 320), Math.round(window.innerWidth * 0.9))
      setPanelWidth(next)
      try { window.localStorage.setItem('runDrawerWidth', String(next)) } catch { /* ignore */ }
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const downloadConsumable = (c: typeof visibleConsumables[number]) => {
    const text = c.formData?.content?.toString() ?? ''
    if (!text) return
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const safe = (c.name ?? 'artifact').toString().replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'artifact'
    link.href = url
    link.download = isCodeArtifact(c.name) ? safe : `${safe}.md`
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url)
  }

  // Single-intent "what's next" for copilot nodes — mirrors the cockpit's FocusPane idea.
  const isCopilotNode = !!usesCopilot || node.config?.executor === 'copilot'
  const nextStep: { label: string; onClick?: () => void; tone: 'amber' | 'green' | 'muted' } | null =
    !isCopilotNode ? null
    : questions.length > 0 ? { label: `Answer ${questions.length} question${questions.length === 1 ? '' : 's'} to continue`, onClick: () => setTab('questions'), tone: 'amber' }
    : (active && isAgent) ? (busy ? { label: 'Working…', tone: 'muted' } : { label: 'Review the output, then approve to advance', onClick: onApprove, tone: 'green' })
    : active ? { label: 'Working…', tone: 'muted' }
    : null

  return (
    <>
    {/* Dim backdrop — the panel overlays the whole cockpit; click outside to dismiss. */}
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 44, background: 'rgba(4,4,6,0.62)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }} />
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: panelWidth, maxWidth: '96vw', zIndex: 45, background: '#0d0d10', borderLeft: '1px solid rgba(255,255,255,0.12)', display: 'flex', flexDirection: 'column', minHeight: 0, boxShadow: '-40px 0 110px rgba(0,0,0,0.6)' }}>
      {/* Drag handle on the left edge — resize the review drawer; double-click resets. */}
      <div
        onMouseDown={(e) => { e.preventDefault(); startPanelResize(e.clientX) }}
        onDoubleClick={() => { setPanelWidth(760); try { window.localStorage.setItem('runDrawerWidth', '760') } catch { /* ignore */ } }}
        title="Drag to resize · double-click to reset"
        style={{ position: 'absolute', left: -3, top: 0, bottom: 0, width: 7, cursor: 'col-resize', zIndex: 20 }}
      />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.1)', background: '#101013' }}>
        <div style={{
          width: 42, height: 42, borderRadius: 14, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: visual.color, background: `${visual.color}14`, border: `1px solid ${visual.color}30`,
        }}>
          <VIcon size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 950, color: '#f2f2f5', letterSpacing: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.label}</div>
          <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
            <span style={nodeMiniPill(visual.color, `${visual.color}10`, `${visual.color}28`)}>{runNodeLabel(node.nodeType)}</span>
            <span style={nodeMiniPill('#b4b4bd', 'rgba(255,255,255,0.05)', 'rgba(255,255,255,0.1)')}>{route}</span>
            {artifactCounts.reads > 0 && <span style={nodeMiniPill('#2563eb', 'rgba(90,176,240,0.1)', '#bfdbfe')}>Reads {artifactCounts.reads}</span>}
            {artifactCounts.writes > 0 && <span style={nodeMiniPill('#0f766e', 'rgba(82,215,136,0.1)', '#99f6e4')}>Writes {artifactCounts.writes}</span>}
          </div>
        </div>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontSize: 9, fontWeight: 900, color: s.color, padding: '4px 7px', borderRadius: 999,
          background: s.bg, border: `1px solid ${s.ring}`, letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>
          <SIcon size={10} /> {s.label}
        </span>
        <button onClick={onClose} style={{ ...topBtn, padding: 6 }}><X size={14} /></button>
      </div>
      <IoContract node={node} />
      <NodeDecisionRecord instanceId={instanceId} nodeId={node.id} />
      <div style={{ display: 'flex', gap: 4, padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        {tabs.map(t => {
          const isQ = t === 'questions'
          return (
            <button key={t} onClick={() => setTab(t)} style={{
              flex: 1, padding: '6px 8px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
              border: '1px solid',
              borderColor: activeTab === t ? (isQ ? '#f59e0b' : '#5ab0f0') : 'transparent',
              background: activeTab === t ? (isQ ? 'rgba(245,196,81,0.1)' : 'rgba(90,176,240,0.1)') : 'transparent',
              color: activeTab === t ? (isQ ? '#f5c451' : '#5ab0f0') : (isQ ? '#f5c451' : '#82828e'),
            }}>{isQ ? `Questions (${questions.length})` : t === 'artifacts' ? 'Documents' : t}</button>
          )
        })}
      </div>
      {nextStep && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 14px 0', padding: '9px 11px', borderRadius: 9, ...nextStepTone(nextStep.tone) }}>
          <div style={{ flex: 1, fontSize: 11.5, fontWeight: 600, lineHeight: 1.4 }}>{nextStep.label}</div>
          {nextStep.onClick && (
            <button onClick={nextStep.onClick} disabled={busy} style={{ ...footBtn, flex: 'none', padding: '5px 11px', fontSize: 11, opacity: busy ? 0.6 : 1 }}>Go</button>
          )}
        </div>
      )}
      {awaitingBranchInput && (
        <CreateBranchForm
          instanceId={instanceId}
          nodeId={node.id}
          capabilityId={(() => {
            // The run's capability (work item's target/parent), not the CREATE_BRANCH
            // node — that's how the server resolves the repo URL + its branches.
            const v = ((runContext?._vars ?? {}) as Record<string, unknown>)
            const fromVars = [v.parentCapabilityId, v.targetCapabilityId, v.capabilityId]
              .find((x): x is string => typeof x === 'string' && x.trim().length > 0)
            return fromVars ?? (node.config?.capabilityId as string | undefined) ?? undefined
          })()}
          initial={(() => {
            const g = ((runContext?._globals ?? {}) as Record<string, unknown>)
            return {
              baseBranch: typeof g.sourceRef === 'string' ? g.sourceRef : undefined,
              cloneDir: typeof g.cloneDir === 'string' ? g.cloneDir : undefined,
              sourceType: typeof g.sourceType === 'string' ? g.sourceType : undefined,
              sourceUri: typeof g.sourceUri === 'string' ? g.sourceUri : undefined,
            }
          })()}
          onDone={() => qc.invalidateQueries({ queryKey: ['run-instance', instanceId] })}
        />
      )}
      {active && isInteractive && !awaitingBranchInput && !showForm && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 14px 0', padding: '9px 11px', borderRadius: 9, background: 'rgba(245,196,81,0.1)', border: '1px solid rgba(245,196,81,0.35)' }}>
          <AlertCircle size={14} color="#d97706" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, fontSize: 11.5, color: '#f5c451', lineHeight: 1.4 }}>This stage needs input ({node.nodeType.replace(/_/g, ' ').toLowerCase()}). Complete it in the Timeline view.</div>
        </div>
      )}
      {(node.status ?? '').toUpperCase() === 'BLOCKED' && blockInfo != null && (
        <div style={{ margin: '10px 14px 0', padding: '9px 11px', borderRadius: 9, background: 'rgba(247,123,123,0.1)', border: '1px solid #fecaca', fontSize: 11.5, color: '#991b1b', lineHeight: 1.45, maxHeight: 190, overflow: 'auto' }}>
          <div style={{ fontWeight: 800, marginBottom: 4 }}>Why this stage is blocked</div>
          <BlockReasonBody info={blockInfo} />
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: 14, minHeight: 0 }}>
        {activeTab === 'form' && fillKind && (
          <NodeFormFill instanceId={instanceId} nodeId={node.id} runName={runName} kind={fillKind} widgets={formWidgets} />
        )}
        {activeTab === 'log' && (
          <pre style={{ fontSize: 11.5, lineHeight: 1.5, color: '#c4c4cc', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'ui-monospace, monospace' }}>
            {latest?.formData?.content?.toString() ?? (active ? 'Working… (live output appears here as the stage produces it)' : 'No output yet.')}
          </pre>
        )}
        {activeTab === 'questions' && <CopilotQuestions instanceId={instanceId} node={node} questions={questions} busy={busy} onRestart={onRestart} />}
        {activeTab === 'artifacts' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Upload a reference document for this stage's agent to use on rework. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <label style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: '12px 14px', borderRadius: 10, cursor: uploadMut.isPending ? 'wait' : 'pointer',
                border: '1px dashed rgba(124,124,245,0.5)', background: 'rgba(124,124,245,0.08)',
                color: '#9a9aff', fontSize: 12, fontWeight: 700,
              }}>
                {uploadMut.isPending ? <Loader2 size={14} className="wg-spin" /> : <Upload size={14} />}
                {uploadMut.isPending ? 'Uploading…' : 'Upload a document for this stage'}
                <input
                  type="file"
                  disabled={uploadMut.isPending}
                  onChange={e => { const f = e.target.files?.[0]; if (f) uploadMut.mutate(f); e.currentTarget.value = '' }}
                  style={{ display: 'none' }}
                />
              </label>
              <div style={{ fontSize: 10.5, color: '#82828e', lineHeight: 1.4 }}>
                Attach reference material (a spec, corrected requirements, an example). It stays with this stage so the agent can use it when you restart or send back for rework.
              </div>
            </div>

            {nodeUploads.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: '#82828e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Uploaded for this stage ({nodeUploads.length})</div>
                {nodeUploads.map(u => (
                  <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, background: 'rgba(255,255,255,0.03)' }}>
                    <Paperclip size={12} color="#9a9aff" style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: 600, color: '#c4c4cc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</span>
                    {formatBytes(u.sizeBytes) ? <span style={{ fontSize: 10, color: '#82828e', flexShrink: 0 }}>{formatBytes(u.sizeBytes)}</span> : null}
                    <button onClick={() => openUpload(u.id)} title="Download" style={artifactIconBtn}><Download size={12} /></button>
                  </div>
                ))}
              </div>
            )}

            {stageDocs.length === 0
              ? <div style={{ fontSize: 12, color: '#82828e' }}>No documents produced yet.</div>
              : <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: '#82828e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Documents produced through this stage ({stageDocs.length})</div>
                {stageDocs.map(c => {
                  const content = c.formData?.content?.toString() ?? ''
                  const editable = canEditConsumable(c.status)
                  const isEditing = editingId === c.id
                  return (
                  <div key={c.id} style={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: 9, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', background: 'rgba(255,255,255,0.03)', fontSize: 11.5, fontWeight: 700, color: '#c4c4cc' }}>
                      <FileText size={12} />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name ?? 'Artifact'} {c.status ? <span style={{ fontWeight: 600, color: '#82828e' }}>· {c.status}</span> : null}</span>
                      {!isEditing ? (
                        <>
                          {editable && <button onClick={() => { setEditingId(c.id); setDraft(content) }} title="Edit" style={artifactIconBtn}><Pencil size={12} /></button>}
                          {content ? (
                            <>
                              <button onClick={() => downloadConsumable(c)} title="Download" style={artifactIconBtn}><Download size={12} /></button>
                              <button onClick={() => setExpandedConsumableId(c.id)} title="Expand to full screen" style={artifactIconBtn}><Maximize2 size={12} /></button>
                            </>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                    {isEditing ? (
                      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <textarea
                          value={draft}
                          onChange={e => setDraft(e.target.value)}
                          rows={14}
                          spellCheck={false}
                          style={{ width: '100%', boxSizing: 'border-box', fontSize: 11.5, lineHeight: 1.5, fontFamily: 'ui-monospace, monospace', color: '#c4c4cc', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 7, padding: 9, resize: 'vertical' }}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ flex: 1, fontSize: 10.5, color: '#82828e', lineHeight: 1.4 }}>Saving snapshots a new version and re-opens verification for this document.</span>
                          <button onClick={() => setEditingId(null)} disabled={saveEditMut.isPending} style={{ ...footBtn, flex: 'none', padding: '5px 11px', fontSize: 11, background: 'transparent', color: '#82828e', border: '1px solid rgba(255,255,255,0.1)' }}>Cancel</button>
                          <button onClick={() => saveEditMut.mutate({ id: c.id, content: draft })} disabled={saveEditMut.isPending || draft === content} style={{ ...footBtn, flex: 'none', padding: '5px 11px', fontSize: 11, opacity: (saveEditMut.isPending || draft === content) ? 0.6 : 1 }}>{saveEditMut.isPending ? 'Saving…' : 'Save'}</button>
                        </div>
                      </div>
                    ) : content ? (
                      <div style={{ margin: 0, padding: 10, fontSize: 11.5, lineHeight: 1.5, color: '#c4c4cc', maxHeight: 320, overflow: 'auto' }}>
                        {isCodeArtifact(c.name)
                          ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, monospace' }}>{content}</pre>
                          : <MarkdownView source={content} />}
                      </div>
                    ) : null}
                  </div>
                  )
                })}
              </div>
            }
          </div>
        )}
        {activeTab === 'chat' && <ChatRefine instanceId={instanceId} node={node} busy={busy} onRestart={onRestart} />}
        {activeTab === 'prompt' && <PromptView instanceId={instanceId} node={node} />}
      </div>
      {sendBackOpen && sendBackTargets.length > 0 && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', padding: '8px 8px', maxHeight: 170, overflow: 'auto', background: 'rgba(255,255,255,0.03)' }}>
          <div style={{ fontSize: 9.5, fontWeight: 800, color: '#82828e', letterSpacing: 0.4, padding: '2px 6px 6px' }}>SEND BACK TO A PREVIOUS STAGE</div>
          {sendBackTargets.map(t => (
            <button key={t.id} onClick={() => { onRestartNode(t.id); onClose() }}
              style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: '7px 9px', borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#c4c4cc', textAlign: 'left' }}>
              <CornerUpLeft size={12} color="#5ab0f0" /> {t.label}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.1)', flexWrap: 'wrap' }}>
        {active && isAgent && (
          <button onClick={onApprove} disabled={busy} style={{ ...footBtn, background: '#22c55e', borderColor: '#16a34a', color: '#fff', opacity: busy ? 0.6 : 1 }}>
            <Check size={13} /> Approve &amp; advance
          </button>
        )}
        {isCopilotNode && isAgent && (
          // Open this copilot stage in the full Workbench cockpit (review artifacts, evidence,
          // and chat). Advancing the run stays here (Approve & advance); the cockpit is the
          // review surface. Requires WORKBENCH_ALLOW_MAIN_PROFILE for non-workbench runs.
          <a
            href={buildWorkbenchLaunchUrl(instanceId, node.id, (node.config?.workbench ?? {}) as Record<string, unknown>, 'neo', runContext ?? {})}
            target="_blank"
            rel="noreferrer"
            title="Open this copilot stage in the Workbench cockpit"
            style={{ ...footBtn, flex: 'none', padding: '8px 11px', textDecoration: 'none', background: '#7c3aed', borderColor: '#9a9aff', color: '#fff' }}
          >
            <ExternalLink size={13} /> Open in Workbench
          </a>
        )}
        {node.nodeType === 'CALL_WORKFLOW' && callWorkflowChildId && (
          <>
            <a
              href={callWorkflowWorkbenchUrl}
              target="_blank"
              rel="noreferrer"
              title="Open the spawned child workflow in Workbench Neo"
              style={{ ...footBtn, flex: 'none', padding: '8px 11px', textDecoration: 'none', background: '#7c3aed', borderColor: '#9a9aff', color: '#fff' }}
            >
              <ExternalLink size={13} /> Open Workbench Neo
            </a>
            <a
              href={`/runs/${callWorkflowChildId}`}
              title="Open the raw child workflow timeline"
              style={{ ...footBtn, flex: 'none', padding: '8px 11px', textDecoration: 'none' }}
            >
              <ExternalLink size={13} /> View sub-run
            </a>
          </>
        )}
        {active && isInteractive && (
          <button onClick={onOpenTimeline} style={{ ...footBtn, background: '#5ab0f0', borderColor: '#5ab0f0', color: '#fff' }}>
            <ExternalLink size={13} /> Open in Timeline
          </button>
        )}
        <button onClick={onRestart} disabled={busy} style={{ ...footBtn, opacity: busy ? 0.6 : 1 }}>
          <RotateCw size={13} /> {busy ? 'Working…' : active ? 'Cancel & restart' : 'Restart stage'}
        </button>
        {sendBackTargets.length > 0 && (
          <button onClick={() => setSendBackOpen(o => !o)}
            style={{ ...footBtn, flex: 'none', padding: '8px 11px', ...(sendBackOpen ? { background: 'rgba(90,176,240,0.1)', borderColor: '#5ab0f0', color: '#5ab0f0' } : {}) }}>
            <CornerUpLeft size={13} /> Send back
          </button>
        )}
      </div>
      {expandedConsumable && (
        <ArtifactFullscreen
          title={(expandedConsumable.name ?? 'Artifact').toString()}
          content={isCodeArtifact(expandedConsumable.name) ? undefined : expandedConsumable.formData?.content?.toString()}
          body={expandedConsumable.formData?.content?.toString() ?? ''}
          canDownload={!!expandedConsumable.formData?.content}
          onDownload={() => downloadConsumable(expandedConsumable)}
          onClose={() => setExpandedConsumableId(null)}
        />
      )}
    </div>
    </>
  )
}

const footBtn: CSSProperties = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  padding: '8px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
  border: '1px solid rgba(255,255,255,0.1)', background: '#101013', color: '#c4c4cc',
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

const artifactIconBtn: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
  padding: 4, borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: '#101013', cursor: 'pointer', color: '#82828e',
}

function formatBytes(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function nextStepTone(tone: 'amber' | 'green' | 'muted'): CSSProperties {
  if (tone === 'amber') return { background: 'rgba(245,196,81,0.1)', border: '1px solid rgba(245,196,81,0.35)', color: '#f5c451' }
  if (tone === 'green') return { background: 'rgba(82,215,136,0.1)', border: '1px solid rgba(82,215,136,0.35)', color: '#166534' }
  return { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', color: '#82828e' }
}

// The node's artifact IN/OUT contract (config.inputArtifacts / outputArtifacts):
// what this phase READS from upstream and WRITES for downstream — the visible
// data-flow of the delivery pipeline. Read-only; renders nothing for nodes with
// no declared artifacts.
type DecisionRecord = {
  node?: { durationMs?: number | null; retryAttempts?: number; stuckRecovered?: boolean; lastError?: unknown }
  agentRuns?: unknown[]
  artifacts?: unknown[]
  consumables?: Array<{ verification?: unknown }>
}

// WF-3 UI — per-node decision record in the inspector. Self-contained: fetches the
// node detail (which carries decisionRecord) and renders nothing until it arrives,
// so it can't affect the rest of the inspector.
function NodeDecisionRecord({ instanceId, nodeId }: { instanceId: string; nodeId: string }) {
  const [collapsed, setCollapsed] = useState(false)
  const { data } = useQuery({
    queryKey: ['node-decision-record', instanceId, nodeId],
    enabled: !!instanceId && !!nodeId,
    queryFn: async () => (await api.get(`/workflow-instances/${instanceId}/nodes/${nodeId}`)).data as { decisionRecord?: DecisionRecord },
  })
  const dr = data?.decisionRecord
  if (!dr) return null
  const row = (label: string, value: string) => (
    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
      <span style={{ color: '#82828e' }}>{label}</span>
      <span style={{ color: '#f2f2f5', fontWeight: 600, textAlign: 'right' }}>{value}</span>
    </div>
  )
  const agentRuns = dr.agentRuns ?? []
  const artifacts = dr.artifacts ?? []
  const verified = (dr.consumables ?? []).filter(c => c.verification)
  const err = dr.node?.lastError
  const errMsg = typeof err === 'string'
    ? err
    : (err && typeof err === 'object' ? String((err as { message?: unknown }).message ?? 'error') : null)
  return (
    <div style={{ margin: '0 16px 12px', padding: 10, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, background: '#101013', display: 'grid', gap: collapsed ? 0 : 6 }}>
      <button
        onClick={() => setCollapsed(c => !c)}
        title={collapsed ? 'Expand decision record' : 'Collapse decision record'}
        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
      >
        <ChevronDown size={13} color="#82828e" style={{ flexShrink: 0, transition: 'transform 140ms ease', transform: collapsed ? 'rotate(-90deg)' : 'none' }} />
        <span style={{ flex: 1, fontSize: 10, fontWeight: 800, color: '#b4b4bd', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Decision record</span>
        {collapsed ? (
          <span style={{ fontSize: 10, fontWeight: 600, color: '#82828e' }}>
            {dr.node?.durationMs != null ? `${Math.round(dr.node.durationMs / 1000)}s · ` : ''}{agentRuns.length} run{agentRuns.length === 1 ? '' : 's'} · {artifacts.length} artifact{artifacts.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </button>
      {!collapsed && (
        <>
          {row('Duration', dr.node?.durationMs != null ? `${Math.round(dr.node.durationMs / 1000)}s` : '—')}
          {row('Attempts', String(dr.node?.retryAttempts ?? 0))}
          {row('Agent runs', String(agentRuns.length))}
          {row('Artifacts', String(artifacts.length))}
          {verified.length > 0 ? row('Verified', String(verified.length)) : null}
          {dr.node?.stuckRecovered ? (
            <div style={{ fontSize: 10, color: '#f5c451', background: 'rgba(245,196,81,0.1)', border: '1px solid rgba(245,196,81,0.35)', borderRadius: 6, padding: '3px 6px' }}>Stuck-recovered by the watchdog</div>
          ) : null}
          {errMsg ? (
            <div style={{ fontSize: 10, color: '#dc2626', background: 'rgba(247,123,123,0.1)', border: '1px solid #fecaca', borderRadius: 6, padding: '4px 6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{errMsg}</div>
          ) : null}
        </>
      )}
    </div>
  )
}

function IoContract({ node }: { node: RunGraphNodeData }) {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object') : [])
  const reads = list(cfg.inputArtifacts)
  const writes = list(cfg.outputArtifacts)
  if (!reads.length && !writes.length) return null
  const chip = (a: Record<string, unknown>, tone: 'in' | 'out') => {
    const label = String(a.name || a.artifactType || (tone === 'in' ? 'input' : 'output'))
    const optional = a.required === false
    const st = tone === 'in'
      ? { color: '#4b6ba8', borderColor: '#cdd8ec', background: 'rgba(255,255,255,0.05)' }
      : { color: '#a24428', borderColor: 'rgba(255,255,255,0.16)', background: 'rgba(255,255,255,0.05)' }
    return (
      <span key={`${tone}-${label}`} title={[String(a.description || ''), optional ? '(optional)' : ''].filter(Boolean).join(' ')}
        style={{ fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 6, border: '1px solid', ...st, opacity: optional ? 0.75 : 1 }}>
        {label}{optional ? ' ?' : ''}
      </span>
    )
  }
  const row = (label: string, items: Record<string, unknown>[], tone: 'in' | 'out') => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 9, fontWeight: 800, color: '#82828e', letterSpacing: 0.5, width: 42, flexShrink: 0 }}>{label}</span>
      {items.length ? items.map(a => chip(a, tone)) : <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.16)' }}>—</span>}
    </div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)', background: '#0c0c0f' }}>
      {reads.length > 0 && row('READS', reads, 'in')}
      {writes.length > 0 && row('WRITES', writes, 'out')}
    </div>
  )
}

// "The prompt used" — the FULL composed prompt (role contract + repo world model +
// work item + task) this phase's agent runs, fetched on demand (the same composition
// the Copilot handoff export builds). Works for pending AND completed phases; a
// degraded flag warns when it fell back toward the raw task.
function PromptView({ instanceId, node }: { instanceId: string; node: RunGraphNodeData }) {
  const qc = useQueryClient()
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [promptDraft, setPromptDraft] = useState('')
  const q = useQuery({
    queryKey: ['run-node-prompt', instanceId, node.id],
    queryFn: () => api.get(`/workflow-instances/${instanceId}/nodes/${node.id}/composed-prompt`).then(r => r.data as {
      composable: boolean; prompt?: string; degraded?: boolean; warning?: string; role?: string; stageKey?: string; reason?: string; overridden?: boolean
    }),
    staleTime: 30_000,
  })
  const savePromptMut = useMutation({
    mutationFn: (prompt: string) => api.post(`/workflow-instances/${instanceId}/nodes/${node.id}/prompt`, { prompt }).then(r => r.data),
    onSuccess: () => {
      toast.success('Prompt updated — re-running the phase')
      qc.invalidateQueries({ queryKey: ['run-node-prompt', instanceId, node.id] })
      qc.invalidateQueries({ queryKey: ['run-instance', instanceId] })
      setEditing(false)
    },
    onError: (e) => toast.error(errText(e, 'update failed')),
  })
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
      .catch(() => { /* clipboard blocked — ignore */ })
  }
  if (q.isLoading) return <div style={{ fontSize: 12, color: '#82828e' }}>Composing the prompt…</div>
  if (q.isError) return <div style={{ fontSize: 12, color: '#b91c1c' }}>Couldn&apos;t load the prompt. {errText(q.error, 'request failed')}</div>
  const d = q.data
  if (!d || d.composable === false) {
    return <div style={{ fontSize: 12, color: '#82828e' }}>{d?.reason ?? 'No composed prompt for this phase.'}</div>
  }
  const prompt = d.prompt ?? ''
  if (editing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 11, color: '#82828e', lineHeight: 1.45 }}>
          Edit the full prompt below — the agent runs it <strong>verbatim</strong> (composition is skipped, so keep the role, work item, and world model you want). Saving re-runs the phase.
        </div>
        <textarea value={promptDraft} onChange={e => setPromptDraft(e.target.value)} rows={20} spellCheck={false}
          style={{ width: '100%', boxSizing: 'border-box', fontSize: 11.5, lineHeight: 1.5, fontFamily: 'ui-monospace, monospace', color: '#c4c4cc', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 7, padding: 9, resize: 'vertical' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={() => setEditing(false)} disabled={savePromptMut.isPending} style={{ ...footBtn, flex: 'none', padding: '5px 11px', fontSize: 11, background: 'transparent', color: '#82828e', border: '1px solid rgba(255,255,255,0.1)' }}>Cancel</button>
          <button onClick={() => savePromptMut.mutate(promptDraft)} disabled={savePromptMut.isPending || !promptDraft.trim() || promptDraft === prompt} style={{ ...footBtn, flex: 'none', padding: '5px 11px', fontSize: 11, opacity: (savePromptMut.isPending || !promptDraft.trim() || promptDraft === prompt) ? 0.6 : 1 }}>{savePromptMut.isPending ? 'Saving…' : 'Save & re-run'}</button>
        </div>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, fontSize: 11, color: '#82828e', lineHeight: 1.45 }}>
          The full prompt this phase&apos;s agent runs{d.role ? ` · role ${d.role}` : ''} — role contract + repo world model + work item + task.
        </div>
        <button onClick={() => { setPromptDraft(prompt); setEditing(true) }} disabled={!prompt} title="Edit this prompt and re-run the phase"
          style={{ ...footBtn, flex: 'none', padding: '5px 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 5, opacity: prompt ? 1 : 0.5 }}>
          <Pencil size={12} /> Edit prompt
        </button>
        <button onClick={() => copy(prompt)} disabled={!prompt}
          style={{ ...footBtn, flex: 'none', padding: '5px 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 5, opacity: prompt ? 1 : 0.5 }}>
          <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {d.overridden && (
        <div style={{ fontSize: 10.5, color: '#5ab0f0', background: 'rgba(90,176,240,0.1)', border: '1px solid #bae6fd', borderRadius: 7, padding: '6px 9px' }}>
          This phase is running an edited prompt (overrides the composed default). Edit again to change it.
        </div>
      )}
      {d.degraded && (
        <div style={{ display: 'flex', gap: 7, padding: '8px 10px', borderRadius: 8, background: 'rgba(245,196,81,0.1)', border: '1px solid rgba(245,196,81,0.35)', fontSize: 11, color: '#f5c451', lineHeight: 1.4 }}>
          <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} color="#d97706" />
          <span>Composed with a fallback{d.warning ? ` — ${d.warning}` : ' — the repo world model or composer was unavailable, so this is closer to the raw task than the fully grounded prompt.'}</span>
        </div>
      )}
      <pre style={{ margin: 0, fontSize: 11.5, lineHeight: 1.55, color: '#c4c4cc', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, monospace', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 9, padding: 12 }}>
        {prompt || 'The composer returned an empty prompt.'}
      </pre>
    </div>
  )
}

function ChatRefine({ instanceId, node, busy, onRestart }: {
  instanceId: string; node: RunGraphNodeData; busy: boolean; onRestart: () => void
}) {
  const qc = useQueryClient()
  const [msg, setMsg] = useState('')
  const [sent, setSent] = useState<string[]>([])
  const refineMut = useMutation({
    mutationFn: (feedback: string) =>
      api.post(`/workflow-instances/${instanceId}/nodes/${node.id}/refine`, { feedback })
        .then(r => r.data)
        .catch(() => { onRestart(); return { fallback: true } }),
    onSuccess: (_d, feedback) => { toast.success('Feedback sent — stage re-running'); setSent(s => [...s, feedback]); setMsg(''); qc.invalidateQueries({ queryKey: ['run-instance', instanceId] }) },
    onError: (e) => toast.error(errText(e, 'Failed to send feedback')),
  })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sent.length === 0
          ? <div style={{ fontSize: 12, color: '#82828e', lineHeight: 1.5 }}>
              Send feedback to refine this stage. The stage re-runs with your note as guidance (e.g. “tighten the acceptance criteria”, “add an edge case for empty lists”).
            </div>
          : sent.map((m, i) => (
              <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '85%', padding: '7px 10px', borderRadius: 10, background: 'rgba(90,176,240,0.1)', border: '1px solid #bae6fd', fontSize: 12, color: '#0c4a6e' }}>{m}</div>
            ))}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
        <textarea
          value={msg} onChange={e => setMsg(e.target.value)} placeholder="Refine this stage…" rows={2}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && msg.trim()) refineMut.mutate(msg.trim()) }}
          style={{ flex: 1, resize: 'none', padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)', fontSize: 12, fontFamily: 'inherit' }}
        />
        <button
          onClick={() => msg.trim() && refineMut.mutate(msg.trim())}
          disabled={busy || refineMut.isPending || !msg.trim()}
          style={{ ...footBtn, flex: 'none', width: 40, padding: 8, opacity: (busy || refineMut.isPending || !msg.trim()) ? 0.5 : 1 }}
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}

// Copilot clarifying questions — rendered like the workbench's question cards
// (option chips + free-text), answered, then the stage re-runs with the answers
// injected as decisions (POST /answer-questions → restartNode).
function CopilotQuestions({ instanceId, node, questions, busy, onRestart }: {
  instanceId: string; node: RunGraphNodeData; questions: CopilotQuestion[]; busy: boolean; onRestart: () => void
}) {
  const qc = useQueryClient()
  const [answers, setAnswers] = useState<Record<string, { option?: string; text?: string }>>({})
  const answerText = (q: CopilotQuestion): string => {
    const a = answers[q.id]; if (!a) return ''
    const opt = a.option ?? ''; const txt = (a.text ?? '').trim()
    return opt && txt ? `${opt} — ${txt}` : (txt || opt)
  }
  const payload = questions
    .map(q => ({ questionId: q.id, question: q.question, answer: answerText(q) }))
    .filter(a => a.answer)
  const mut = useMutation({
    mutationFn: () =>
      api.post(`/workflow-instances/${instanceId}/nodes/${node.id}/answer-questions`, { answers: payload })
        .then(r => r.data)
        .catch(() => { onRestart(); return { fallback: true } }),
    onSuccess: () => { toast.success('Answers saved — stage re-running with your decisions'); setAnswers({}); qc.invalidateQueries({ queryKey: ['run-instance', instanceId] }) },
    onError: (e) => toast.error(errText(e, 'Failed to save answers')),
  })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ fontSize: 11.5, color: '#f5c451', background: 'rgba(245,196,81,0.1)', border: '1px solid rgba(245,196,81,0.35)', borderRadius: 8, padding: '8px 10px', lineHeight: 1.45 }}>
        Copilot asked {questions.length} question{questions.length > 1 ? 's' : ''} for this stage. Answer and re-run — your answers are injected as confirmed decisions so it won't guess.
      </div>
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {questions.map(q => (
          <div key={q.id} style={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: 9, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#f2f2f5', lineHeight: 1.4 }}>{q.question}</div>
            {q.options && q.options.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {q.options.map(opt => {
                  const sel = answers[q.id]?.option === opt
                  return (
                    <button key={opt} type="button"
                      onClick={() => setAnswers(s => ({ ...s, [q.id]: { ...s[q.id], option: sel ? undefined : opt } }))}
                      style={{
                        padding: '5px 10px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', border: '1px solid',
                        borderColor: sel ? '#5ab0f0' : 'rgba(255,255,255,0.1)', background: sel ? 'rgba(90,176,240,0.1)' : '#101013', color: sel ? '#5ab0f0' : '#b4b4bd',
                      }}>{opt}</button>
                  )
                })}
              </div>
            )}
            <textarea rows={2} value={answers[q.id]?.text ?? ''}
              onChange={e => setAnswers(s => ({ ...s, [q.id]: { ...s[q.id], text: e.target.value } }))}
              placeholder={q.options?.length ? 'Add detail (optional)…' : 'Your answer…'}
              style={{ resize: 'none', padding: '7px 9px', borderRadius: 7, border: '1px solid rgba(255,255,255,0.1)', fontSize: 11.5, fontFamily: 'inherit' }} />
          </div>
        ))}
      </div>
      <button onClick={() => payload.length && mut.mutate()} disabled={busy || mut.isPending || payload.length === 0}
        style={{ ...footBtn, opacity: (busy || mut.isPending || payload.length === 0) ? 0.5 : 1 }}>
        <Send size={14} /> Save answers &amp; re-run ({payload.length}/{questions.length})
      </button>
    </div>
  )
}

// Renders a gate executor's block payload (verifier docs+findings, eval-gate
// missing evidence, git-push error) as readable text; JSON fallback for shapes
// we don't recognize.
function BlockReasonBody({ info }: { info: unknown }) {
  const o = info as Record<string, unknown>
  if (Array.isArray(o?.documents)) { // VERIFIER: per-document findings
    const docs = o.documents as Array<{ name?: string; passed?: boolean; findings?: string[]; rationale?: string }>
    const failed = docs.filter(d => !d.passed)
    if (failed.length === 0) return <div>{String(o.note ?? 'Verification blocked this stage.')}</div>
    return (
      <div>
        {failed.map((d, i) => (
          <div key={i} style={{ marginBottom: 5 }}>
            <strong>{d.name ?? 'document'}</strong>{d.rationale ? ` — ${d.rationale}` : null}
            {(d.findings?.length ?? 0) > 0 && (
              <ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>{d.findings!.slice(0, 5).map((f, j) => <li key={j}>{f}</li>)}</ul>
            )}
          </div>
        ))}
      </div>
    )
  }
  if (typeof o?.pushError === 'string') return <div>{o.pushError}</div> // GIT_PUSH
  if (Array.isArray(o?.missingEvidence) && o.missingEvidence.length > 0) { // EVAL_GATE
    return <ul style={{ margin: 0, paddingLeft: 16 }}>{(o.missingEvidence as string[]).map((m, i) => <li key={i}>{m}</li>)}</ul>
  }
  if (Array.isArray(o?.blocked) && typeof o?.effectiveMode === 'string') { // GOVERNANCE_GATE
    const blocked = o.blocked as Array<{ controlKey?: string; reason?: string; mode?: string }>
    const satisfied = Array.isArray(o.satisfied) ? (o.satisfied as string[]) : []
    const waived = Array.isArray(o.waived) ? (o.waived as string[]) : []
    const checks = Array.isArray(o.checks)
      ? o.checks as Array<{ controlKey?: string; status?: string; bindingType?: string; reason?: string }>
      : []
    return (
      <div>
        {o.note ? <div style={{ marginBottom: 4 }}>{String(o.note)}</div> : null}
        {checks.length > 0 && (
          <div style={{ display: 'grid', gap: 4, marginBottom: 6 }}>
            {checks.slice(0, 8).map((check, i) => {
              const status = String(check.status ?? 'MISSING').toUpperCase()
              const tone = status === 'SATISFIED' ? '#16a34a' : status === 'WAIVED' ? '#7c3aed' : status === 'BLOCKED' ? '#dc2626' : '#d97706'
              return (
                <div key={`${check.controlKey ?? 'check'}-${i}`} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', borderRadius: 6,
                  background: 'rgba(15,23,42,0.04)', border: '1px solid rgba(148,163,184,0.25)',
                }}>
                  <span style={{ fontSize: 8, fontWeight: 900, color: tone, minWidth: 64 }}>{status}</span>
                  <span style={{ fontSize: 10, fontWeight: 800, color: '#c4c4cc', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{check.controlKey ?? 'control'}</span>
                  {check.bindingType && <span style={{ fontSize: 8.5, color: '#82828e' }}>{check.bindingType}</span>}
                </div>
              )
            })}
          </div>
        )}
        {blocked.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {blocked.map((b, i) => (
              <li key={i}><strong>{b.controlKey}</strong>{b.mode ? ` (${b.mode})` : ''}{b.reason ? ` — ${b.reason}` : ''}</li>
            ))}
          </ul>
        )}
        {(satisfied.length > 0 || waived.length > 0) && (
          <div style={{ marginTop: 4, opacity: 0.7, fontSize: '0.85em' }}>
            satisfied: {satisfied.join(', ') || '—'} · waived: {waived.join(', ') || '—'}
          </div>
        )}
      </div>
    )
  }
  return <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit' }}>{JSON.stringify(info, null, 1).slice(0, 600)}</pre>
}

// Inline runtime form for an active human-task / approval / data-collection node.
// Fetches the task/approval/consumable record for this node and renders the SAME
// RuntimeWidgetForm the Timeline uses, so clicking the node shows the form here.
function unwrapEntity(d: unknown): { id: string; formData?: Record<string, unknown>; attachments?: any[] } | null {
  return unwrapList<{ id: string; formData?: Record<string, unknown>; attachments?: any[] }>(d)[0] ?? null
}
// Interactive CREATE_BRANCH form — choose the base branch to start work from (+ the
// source mode / local dir), then create the wi/<code> work branch and continue.
function CreateBranchForm({ instanceId, nodeId, capabilityId, initial, onDone }: {
  instanceId: string; nodeId: string; capabilityId?: string
  initial?: { baseBranch?: string; cloneDir?: string; sourceType?: string; sourceUri?: string }
  onDone: () => void
}) {
  // Pre-fill from any values chosen at launch (globals) so the operator confirms/tweaks
  // instead of re-typing — one place to set it, here, mid-run.
  const initLocal = (initial?.sourceType ?? '').toLowerCase().includes('local')
  const [baseBranch, setBaseBranch] = useState(initial?.baseBranch ?? '')
  const [sourceMode, setSourceMode] = useState<'github' | 'local_dir'>(initLocal ? 'local_dir' : 'github')
  const [localPath, setLocalPath] = useState(initLocal ? (initial?.sourceUri ?? '') : '')
  const [cloneDir, setCloneDir] = useState(initial?.cloneDir ?? '')
  const branchesQuery = useQuery<{ branches?: string[]; repo?: string; connector?: { repo?: string }; reason?: string }>({
    queryKey: ['cb-branches', instanceId, capabilityId ?? ''],
    // Pass instanceId so the server resolves the repo from the RUN's context (repoUrl
    // var → capability's linked repo) — reliable even when the capability var name varies.
    queryFn: () => api.get('/connectors/git/branches', {
      params: { instanceId, ...(capabilityId ? { capabilityId } : {}) },
    }).then(r => r.data),
    staleTime: 60_000,
  })
  const branches = branchesQuery.data?.branches ?? []
  const repoUrl = branchesQuery.data?.repo ?? branchesQuery.data?.connector?.repo
  const repoLabel = repoUrl?.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '')
  const submit = useMutation({
    mutationFn: () => api.post(`/workflow-instances/${instanceId}/nodes/${nodeId}/create-branch`, {
      ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
      ...(sourceMode === 'local_dir'
        ? (localPath.trim() ? { sourceType: 'local_dir', sourceUri: localPath.trim() } : {})
        : (cloneDir.trim() ? { cloneDir: cloneDir.trim() } : {})),
    }).then(r => r.data),
    onSuccess: () => { toast.success('Work branch created — continuing'); onDone() },
    onError: (e) => toast.error(errText(e, 'Create branch failed')),
  })
  const inputStyle: CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: 7, border: '1px solid rgba(255,255,255,0.16)', fontSize: 12, outline: 'none' }
  const labelStyle: CSSProperties = { fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#82828e', margin: '0 0 4px' }
  const hint: CSSProperties = { fontSize: 10, color: '#82828e', marginTop: 4 }
  return (
    <div style={{ margin: '10px 14px 0', padding: 12, borderRadius: 10, background: 'rgba(90,176,240,0.1)', border: '1px solid #bae6fd' }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: '#5ab0f0', marginBottom: 8 }}>Create work branch — choose where to start</div>
      <div style={{ marginBottom: 10 }}>
        <p style={labelStyle}>Repository (from capability)</p>
        <div style={{ ...inputStyle, background: 'rgba(255,255,255,0.03)', color: repoUrl ? '#f2f2f5' : '#82828e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={repoUrl ?? undefined}>
          {branchesQuery.isLoading ? 'Resolving…' : (repoUrl || (branchesQuery.data?.reason ? `Not resolved — ${branchesQuery.data.reason}` : 'Not resolved — the capability has no linked repo / GIT connector'))}
        </div>
      </div>
      <div style={{ marginBottom: 10 }}>
        <p style={labelStyle}>Start work from branch</p>
        {branches.length > 0 ? (
          <select value={baseBranch} onChange={e => setBaseBranch(e.target.value)} style={inputStyle}>
            <option value="">main (default)</option>
            {baseBranch && !branches.includes(baseBranch) && <option value={baseBranch}>{baseBranch}</option>}
            {branches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        ) : (
          <input value={baseBranch} onChange={e => setBaseBranch(e.target.value)} placeholder="e.g. main" style={inputStyle} />
        )}
        <p style={hint}>{branches.length > 0 ? `${branches.length} branch${branches.length === 1 ? '' : 'es'}${repoLabel ? ` from ${repoLabel}` : ''}. ` : ''}The <code>wi/&lt;code&gt;</code> work branch is cut from this. Blank = main.</p>
      </div>
      <div style={{ marginBottom: 10 }}>
        <p style={labelStyle}>Source</p>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['github', 'local_dir'] as const).map(m => (
            <button key={m} type="button" onClick={() => setSourceMode(m)} style={{ flex: 1, padding: 6, borderRadius: 7, border: `1px solid ${sourceMode === m ? '#5ab0f0' : 'rgba(255,255,255,0.16)'}`, background: sourceMode === m ? 'rgba(90,176,240,0.13)' : '#101013', color: sourceMode === m ? '#5ab0f0' : '#b4b4bd', fontWeight: sourceMode === m ? 800 : 600, fontSize: 11.5, cursor: 'pointer' }}>
              {m === 'github' ? 'GitHub repo' : 'Local directory'}
            </button>
          ))}
        </div>
      </div>
      {sourceMode === 'local_dir' ? (
        <div style={{ marginBottom: 10 }}>
          <p style={labelStyle}>Local directory path</p>
          <input value={localPath} onChange={e => setLocalPath(e.target.value)} placeholder="/Users/me/code/my-project" style={inputStyle} />
          <p style={hint}>Absolute path on the runtime (inside MCP_ALLOWED_LOCAL_SOURCE_ROOTS).</p>
        </div>
      ) : (
        <div style={{ marginBottom: 10 }}>
          <p style={labelStyle}>Clone into folder (optional)</p>
          <input value={cloneDir} onChange={e => setCloneDir(e.target.value)} placeholder="e.g. my-checkout" style={inputStyle} />
        </div>
      )}
      <button onClick={() => submit.mutate()} disabled={submit.isPending} style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #5ab0f0', background: '#5ab0f0', color: '#fff', fontWeight: 800, fontSize: 12, cursor: submit.isPending ? 'default' : 'pointer', opacity: submit.isPending ? 0.6 : 1 }}>
        {submit.isPending ? 'Creating…' : 'Create branch & continue'}
      </button>
    </div>
  )
}

function NodeFormFill({ instanceId, nodeId, runName, kind, widgets }: {
  instanceId: string; nodeId: string; runName: string; kind: FillKind; widgets: FormWidget[]
}) {
  const qc = useQueryClient()
  const path = kind === 'task' ? '/tasks' : kind === 'approval' ? '/approvals' : '/consumables'
  const entityQuery = useQuery({
    queryKey: ['rg-fill-entity', kind, nodeId, instanceId],
    queryFn: () => api.get(path, { params: { nodeId, instanceId } }).then(r => r.data),
    enabled: !!nodeId && !!instanceId,
  })
  const entity = unwrapEntity(entityQuery.data)
  const [snapshot, setSnapshot] = useState<{ data: Record<string, unknown>; attachmentIds: string[] }>({ data: {}, attachmentIds: [] })

  // Approval nodes may not have a pending record yet — create one on demand.
  const ensureMut = useMutation({
    mutationFn: () => api.post(`/approvals/workflow-node/${nodeId}/ensure`).then(r => r.data),
    onSuccess: () => entityQuery.refetch(),
  })
  useEffect(() => {
    if (kind === 'approval' && entityQuery.isFetched && !entity
        && !ensureMut.isPending && !ensureMut.isSuccess && !ensureMut.isError) {
      ensureMut.mutate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, entityQuery.isFetched, !!entity])

  const decisionMut = useMutation({
    mutationFn: async (decision: 'APPROVED' | 'REJECTED') => {
      if (!entity) return
      await api.post(`/approvals/${entity.id}/form-submission`, { data: snapshot.data, attachmentIds: snapshot.attachmentIds })
      return api.post(`/approvals/${entity.id}/decision`, {
        decision, notes: `${decision === 'APPROVED' ? 'Approved' : 'Rejected'} from run graph`,
      }).then(r => r.data)
    },
    onSuccess: (_d, decision) => {
      toast.success(decision === 'APPROVED' ? 'Approved — workflow advancing' : 'Rejected — recorded')
      qc.invalidateQueries({ queryKey: ['run-instance', instanceId] }); entityQuery.refetch()
    },
    onError: (e) => toast.error(errText(e, 'Decision failed')),
  })

  if (entityQuery.isLoading) return <div style={{ fontSize: 12, color: '#82828e' }}>Loading form…</div>
  if (!entity) return <div style={{ fontSize: 12, color: '#82828e' }}>Waiting for the {kind} record to be created…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 11, color: '#0c4a6e', background: 'rgba(90,176,240,0.1)', border: '1px solid #bae6fd', borderRadius: 8, padding: '7px 10px', lineHeight: 1.45 }}>
        Fill this form to complete the step — Run <strong>{runName}</strong>.
      </div>
      <RuntimeWidgetForm
        widgets={widgets}
        submitTo={{ kind, id: entity.id }}
        link={{ taskId: kind === 'task' ? entity.id : undefined, nodeId, instanceId }}
        initialData={entity.formData ?? {}}
        initialAttachments={Array.isArray(entity.attachments) ? entity.attachments : []}
        canComplete
        onSubmitted={() => { qc.invalidateQueries({ queryKey: ['run-instance', instanceId] }); entityQuery.refetch() }}
        onValuesChange={kind === 'approval' ? setSnapshot : undefined}
        hideActions={kind === 'approval'}
        primaryLabel={kind === 'approval' ? 'Save sign-off form' : undefined}
      />
      {kind === 'approval' && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 10 }}>
          <button onClick={() => decisionMut.mutate('REJECTED')} disabled={decisionMut.isPending}
            style={{ ...footBtn, flex: 'none', width: 'auto', padding: '7px 12px', color: '#991b1b' }}>Reject</button>
          <button onClick={() => decisionMut.mutate('APPROVED')} disabled={decisionMut.isPending}
            style={{ ...footBtn, flex: 'none', width: 'auto', padding: '7px 12px', background: '#16a34a', color: '#fff', borderColor: '#16a34a' }}>
            {decisionMut.isPending ? 'Saving…' : 'Approve & advance'}
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Artifact catalog: every doc across the run, grouped by phase, by name ───
const catBtn: CSSProperties = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
  padding: '5px 8px', borderRadius: 6, fontSize: 10.5, fontWeight: 700, cursor: 'pointer',
  border: '1px solid', background: '#101013',
}
function ArtifactCatalog({ instanceId, live, phases, onClose }: {
  instanceId: string
  live: boolean
  phases: { id: string; label: string }[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { data: all = [] } = useAllConsumables(instanceId, live)
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({})
  const [forceConfirm, setForceConfirm] = useState<string | null>(null)
  const [openDoc, setOpenDoc] = useState<Consumable | null>(null)
  // Edit-and-save from the Documents viewer (re-opens the governance gate server-side).
  const [editingDoc, setEditingDoc] = useState(false)
  const [docDraft, setDocDraft] = useState('')
  const saveDocMut = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) =>
      api.patch(`/consumables/${id}/content`, { content }).then(r => r.data as Consumable),
    onSuccess: (updated) => {
      toast.success('Saved — verification re-opened for this document')
      qc.invalidateQueries({ queryKey: ['run-graph-all-consumables', instanceId] })
      qc.invalidateQueries({ queryKey: ['run-graph-consumables'] })
      setEditingDoc(false)
      if (updated) setOpenDoc(updated)
    },
    onError: (e) => toast.error(errText(e, 'save failed')),
  })
  const approveMut = useMutation({
    mutationFn: ({ cid, force }: { cid: string; force?: boolean }) =>
      api.post(`/consumables/${cid}/approve${force ? '?force=true' : ''}`).then(r => r.data),
    onSuccess: () => { toast.success('Document approved'); setForceConfirm(null); qc.invalidateQueries({ queryKey: ['run-graph-all-consumables', instanceId] }) },
    onError: (err: unknown, vars) => {
      // Verify-before-approve gate fired (409) — surface the findings + offer override.
      const data = (err as { response?: { data?: { error?: string; verification?: Verdict } } })?.response?.data
      if (data?.error === 'verification_failed') {
        if (data.verification) setVerdicts(s => ({ ...s, [vars.cid]: { passed: false, findings: data.verification!.findings ?? [], rationale: data.verification!.rationale } }))
        setForceConfirm(vars.cid)
        toast.error('Verification failed — review the findings, or click "Approve anyway"')
      } else {
        toast.error(errText(err, 'Approve failed'))
      }
    },
  })
  // Verify → runs the verifier agent (reads the run's standards/policies + LLM-judges).
  const verifyMut = useMutation({
    mutationFn: (cid: string) => api.post(`/consumables/${cid}/verify`).then(r => r.data),
    onSuccess: (d: { passed?: boolean; findings?: string[]; rationale?: string }, cid) => {
      setVerdicts(v => ({ ...v, [cid]: { passed: !!d?.passed, findings: d?.findings ?? [], rationale: d?.rationale } }))
      if (d?.passed) toast.success('Verified — meets the standards')
      else toast.info(`${d?.findings?.length ?? 0} issue${(d?.findings?.length ?? 0) === 1 ? '' : 's'} found against the standards`)
    },
    onError: (e) => toast.error(errText(e, 'Verification failed to run')),
  })
  // Verify all → run the agent across every document, sequentially (each is an LLM
  // call), updating verdicts as they land.
  const [verifyAll, setVerifyAll] = useState<{ done: number; total: number } | null>(null)
  const documents = useMemo(
    () => all.filter(isVisibleDocumentConsumable).slice().sort(sortConsumablesByNameThenTime),
    [all],
  )
  const runVerifyAll = async () => {
    if (verifyAll || documents.length === 0) return
    setVerifyAll({ done: 0, total: documents.length })
    for (let i = 0; i < documents.length; i++) {
      try {
        const d = await api.post(`/consumables/${documents[i].id}/verify`).then(r => r.data)
        setVerdicts(v => ({ ...v, [documents[i].id]: { passed: !!d?.passed, findings: d?.findings ?? [], rationale: d?.rationale } }))
      } catch { /* skip this doc, keep going */ }
      setVerifyAll({ done: i + 1, total: documents.length })
    }
    setVerifyAll(null)
    qc.invalidateQueries({ queryKey: ['run-graph-all-consumables', instanceId] })
  }
  const groups = useMemo(() => {
    const phaseIds = new Set(phases.map(p => p.id))
    const known = phases
      .map(p => ({ phase: p, docs: documents.filter(c => c.nodeId === p.id).slice().sort(sortConsumablesByNameThenTime) }))
      .filter(g => g.docs.length > 0)
    const unlinked = documents
      .filter(c => !c.nodeId || !phaseIds.has(c.nodeId))
      .slice()
      .sort(sortConsumablesByNameThenTime)
    if (unlinked.length === 0) return known
    return [
      ...known,
      { phase: { id: '__unlinked_documents__', label: 'Other generated documents' }, docs: unlinked },
    ]
  }, [documents, phases])

  return (
    <div style={{ width: 400, flexShrink: 0, background: '#101013', borderLeft: '1px solid rgba(255,255,255,0.1)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        <Library size={16} color="#5ab0f0" />
        <div style={{ flex: 1 }} title="Grouped by agent — mirrors the git layout deliverables/<work-id>/<agent>/. Open a document to view or edit it.">
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#f2f2f5' }}>Documents</div>
          <div style={{ fontSize: 10.5, color: '#82828e' }}>{documents.length} document{documents.length === 1 ? '' : 's'} · by agent</div>
        </div>
        <button onClick={runVerifyAll} disabled={!!verifyAll || documents.length === 0}
          title="Run the verifier agent on every document"
          style={{ ...topBtn, padding: '5px 9px', fontSize: 11, color: '#7c3aed', borderColor: 'rgba(124,124,245,0.2)', opacity: (!!verifyAll || documents.length === 0) ? 0.6 : 1 }}>
          <ShieldCheck size={12} /> {verifyAll ? `Verifying ${verifyAll.done}/${verifyAll.total}…` : 'Verify all'}
        </button>
        <button onClick={onClose} style={{ ...topBtn, padding: 6 }}><X size={14} /></button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {groups.length === 0 && <div style={{ fontSize: 12, color: '#82828e' }}>No artifacts produced yet.</div>}
        {groups.map(g => (
          <section key={g.phase.id}>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#82828e', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 7 }}>{g.phase.label}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {g.docs.map(d => {
                const approved = ['APPROVED', 'PUBLISHED'].some(k => (d.status ?? '').toUpperCase().includes(k))
                // Effective verdict: the one just clicked, else the persisted one.
                const v: Verdict | undefined = verdicts[d.id] ?? d.formData?._verification
                const needsForce = forceConfirm === d.id
                return (
                  <div key={d.id} style={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: 9, padding: '8px 10px' }}>
                    <div onClick={() => setOpenDoc(d)} title="Open" style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7, cursor: 'pointer' }}>
                      <FileText size={13} color="#5ab0f0" />
                      <div style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: '#5ab0f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name ?? 'Artifact'}</div>
                      {(d.updatedAt || d.createdAt) && <span style={{ fontSize: 9, color: '#82828e', whiteSpace: 'nowrap' }}>{new Date(d.updatedAt ?? d.createdAt!).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
                      {d.status && <span style={{ fontSize: 9.5, fontWeight: 700, color: approved ? '#16a34a' : '#82828e' }}>{d.status}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => approveMut.mutate({ cid: d.id, force: needsForce })} disabled={approved || approveMut.isPending}
                        title={needsForce ? 'This document failed verification — approve anyway?' : undefined}
                        style={{ ...catBtn, color: needsForce ? '#f5c451' : '#16a34a', borderColor: needsForce ? 'rgba(245,196,81,0.35)' : 'rgba(82,215,136,0.35)', opacity: approved ? 0.5 : 1 }}>
                        <Check size={11} /> {approved ? 'Approved' : needsForce ? 'Approve anyway' : 'Approve'}
                      </button>
                      {(() => {
                        const color = v ? (v.passed ? '#16a34a' : '#d97706') : '#7c3aed'
                        const border = v ? (v.passed ? 'rgba(82,215,136,0.35)' : 'rgba(245,196,81,0.35)') : 'rgba(124,124,245,0.2)'
                        const label = verifyMut.isPending && verifyMut.variables === d.id ? 'Verifying…'
                          : v ? (v.passed ? 'Verified ✓' : `${v.findings.length} issue${v.findings.length === 1 ? '' : 's'}`)
                          : 'Verify'
                        return (
                          <button onClick={() => verifyMut.mutate(d.id)} disabled={verifyMut.isPending}
                            title={v && !v.passed ? v.findings.join('\n') : v?.rationale}
                            style={{ ...catBtn, color, borderColor: border }}>
                            <ShieldCheck size={11} /> {label}
                          </button>
                        )
                      })()}
                    </div>
                    {v && (!v.passed || v.rationale) && (
                      <div style={{ marginTop: 7, padding: '6px 8px', borderRadius: 7, fontSize: 10.5, lineHeight: 1.4,
                        background: v.passed ? 'rgba(82,215,136,0.1)' : 'rgba(245,196,81,0.1)', border: `1px solid ${v.passed ? 'rgba(82,215,136,0.35)' : 'rgba(245,196,81,0.35)'}`, color: v.passed ? '#52d788' : '#f5c451' }}>
                        {v.rationale && <div style={{ marginBottom: !v.passed && v.findings.length ? 4 : 0 }}>{v.rationale}</div>}
                        {!v.passed && v.findings.length > 0 && (
                          <ul style={{ margin: 0, paddingLeft: 16 }}>{v.findings.slice(0, 6).map((f, i) => <li key={i}>{f}</li>)}</ul>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>
      {openDoc && (
        <div onClick={() => { setOpenDoc(null); setEditingDoc(false) }} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 24 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(840px, 92vw)', maxHeight: '88vh', background: '#101013', borderRadius: 14, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 12px 48px rgba(0,0,0,0.3)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '13px 16px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
              <FileText size={15} color="#5ab0f0" />
              <div style={{ flex: 1, fontSize: 14, fontWeight: 700, color: '#f2f2f5' }}>{openDoc.name ?? 'Artifact'}</div>
              {editingDoc ? (
                <>
                  <button onClick={() => saveDocMut.mutate({ id: openDoc.id, content: docDraft })} disabled={saveDocMut.isPending || docDraft === (openDoc.formData?.content ?? '')} style={{ ...catBtn, color: '#5ab0f0', borderColor: '#bae6fd', opacity: (saveDocMut.isPending || docDraft === (openDoc.formData?.content ?? '')) ? 0.6 : 1 }}>{saveDocMut.isPending ? 'Saving…' : 'Save'}</button>
                  <button onClick={() => setEditingDoc(false)} disabled={saveDocMut.isPending} style={{ ...catBtn, color: '#82828e', borderColor: 'rgba(255,255,255,0.1)' }}>Cancel</button>
                </>
              ) : (
                <>
                  {canEditConsumable(openDoc.status) && <button onClick={() => { setDocDraft(openDoc.formData?.content ?? ''); setEditingDoc(true) }} title="Edit" style={{ ...topBtn, padding: 6 }}><Pencil size={14} /></button>}
                  {(openDoc.updatedAt || openDoc.createdAt) && <span style={{ fontSize: 10.5, color: '#82828e' }}>{new Date(openDoc.updatedAt ?? openDoc.createdAt!).toLocaleString()}</span>}
                </>
              )}
              <button onClick={() => { setOpenDoc(null); setEditingDoc(false) }} style={{ ...topBtn, padding: 6 }}><X size={15} /></button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '18px 22px', minHeight: 0 }}>
              {(() => {
                const dv: Verdict | undefined = verdicts[openDoc.id] ?? openDoc.formData?._verification
                if (!dv) return null
                return (
                  <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 9, fontSize: 12, lineHeight: 1.45,
                    background: dv.passed ? 'rgba(82,215,136,0.1)' : 'rgba(245,196,81,0.1)', border: `1px solid ${dv.passed ? 'rgba(82,215,136,0.35)' : 'rgba(245,196,81,0.35)'}`, color: dv.passed ? '#52d788' : '#f5c451' }}>
                    <div style={{ fontWeight: 700, marginBottom: dv.rationale || (!dv.passed && dv.findings.length) ? 5 : 0 }}>
                      {dv.passed ? '✓ Verified — meets the standards' : `⚠ ${dv.findings.length} issue${dv.findings.length === 1 ? '' : 's'} against the standards`}
                    </div>
                    {dv.rationale && <div style={{ marginBottom: !dv.passed && dv.findings.length ? 5 : 0 }}>{dv.rationale}</div>}
                    {!dv.passed && dv.findings.length > 0 && <ul style={{ margin: 0, paddingLeft: 18 }}>{dv.findings.map((f, i) => <li key={i}>{f}</li>)}</ul>}
                  </div>
                )
              })()}
              {editingDoc ? (
                <>
                  <textarea value={docDraft} onChange={e => setDocDraft(e.target.value)} spellCheck={false}
                    style={{ width: '100%', boxSizing: 'border-box', minHeight: '52vh', fontSize: 12.5, lineHeight: 1.55, fontFamily: 'ui-monospace, monospace', color: '#c4c4cc', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 8, padding: 12, resize: 'vertical' }} />
                  <div style={{ marginTop: 8, fontSize: 10.5, color: '#82828e' }}>Saving snapshots a new version and re-opens verification for this document.</div>
                </>
              ) : isCodeArtifact(openDoc.name)
                ? <pre style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#c4c4cc', fontFamily: 'ui-monospace, monospace' }}>{openDoc.formData?.content ?? '(empty)'}</pre>
                : <MarkdownView source={openDoc.formData?.content ?? '(empty)'} />}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
