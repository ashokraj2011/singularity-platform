import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import {
  Activity, AlertTriangle, Boxes, CheckCircle2, ClipboardList, Copy, Database, FileText,
  Gauge, GitBranch, KeyRound,
  Network, RefreshCw, ServerCog, ShieldCheck, SlidersHorizontal, Terminal,
  WifiOff, Zap,
} from 'lucide-react'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { auditGovApi, runtimeApi, workgraphApi } from '@/lib/api'
import { cn } from '@/lib/cn'
import { env } from '@/lib/env'

type HealthState = 'ONLINE' | 'DEGRADED' | 'OFFLINE'

interface ServiceCheck {
  id: string
  name: string
  group: string
  endpoint: string
  description: string
  critical?: boolean
}

interface DoctorSummary {
  generatedAt?: string
  configPath?: string
  summary?: { failures: number; warnings: number; checks: number }
  checks?: Array<{ status: 'OK' | 'WARN' | 'FAIL'; message: string; fix?: string }>
}

type OpsTab = 'setup' | 'readiness' | 'trust' | 'audit' | 'workitems' | 'architecture' | 'causality'

interface WorkflowRunRow {
  id: string
  name: string
  status: string
  templateId?: string | null
  startedAt?: string | null
  completedAt?: string | null
  createdAt?: string
}

interface WorkItemRow {
  id: string
  title: string
  description?: string | null
  status: string
  parentCapabilityId?: string | null
  priority?: number
  dueAt?: string | null
  createdAt?: string
  updatedAt?: string
  targets?: Array<{
    id: string
    targetCapabilityId: string
    status: string
    roleKey?: string | null
    childWorkflowTemplateId?: string | null
    childWorkflowInstanceId?: string | null
    claimedById?: string | null
  }>
  events?: Array<{ id: string; eventType: string; createdAt: string; payload?: unknown }>
}

interface CapabilityRow {
  id: string
  name: string
  appId?: string | null
  capabilityType?: string | null
  criticality?: string | null
}

interface WorkflowTemplateRow {
  id: string
  name: string
  status: string
  budgetPolicy?: Record<string, unknown> | null
}

interface CapabilityReadiness {
  capabilityId: string
  generatedAt: string
  score: number
  status: 'READY' | 'NEEDS_ATTENTION' | 'NOT_READY' | 'UNKNOWN'
  categories: Array<{
    key: string
    label: string
    score: number
    maxScore: number
    status: string
    summary: string
    checks: Array<{ key: string; label: string; ok: boolean; detail: string; severity: string }>
  }>
  blockers: Array<{ category: string; key: string; message: string }>
  warnings: Array<{ category: string; key: string; message: string; severity: string }>
  recommendedActions: string[]
  facts?: Record<string, unknown>
}

interface ArchitectureDiagram {
  capabilityId: string
  generatedAt: string
  source: string
  kind: string
  title: string
  description: string
  layers: Array<{ key: string; label: string; items: string[] }>
  mermaid: string
}

const services: ServiceCheck[] = [
  { id: 'iam', name: 'IAM', group: 'Control Plane', endpoint: '/ops-health/iam', description: 'Users, teams, roles, capabilities', critical: true },
  { id: 'workgraph-api', name: 'Workflow API', group: 'Orchestration', endpoint: '/ops-health/workgraph-api', description: 'Workflow runs, tasks, approvals', critical: true },
  { id: 'blueprint-workbench', name: 'Blueprint Workbench', group: 'Orchestration', endpoint: '/ops-health/blueprint-workbench', description: 'Workbench loops, staged artifacts, human gates', critical: true },
  { id: 'prompt-composer', name: 'Prompt Composer', group: 'Composition', endpoint: '/ops-health/prompt-composer', description: 'Prompt layers and assemblies', critical: true },
  { id: 'context-api', name: 'Context Fabric', group: 'Optimization', endpoint: '/ops-health/context-api', description: 'Execution orchestration and memory packaging', critical: true },
  { id: 'llm-gateway', name: 'LLM Gateway', group: 'Optimization', endpoint: '/ops-health/llm-gateway', description: 'Provider routing and token usage' },
  { id: 'context-memory', name: 'Context Memory', group: 'Optimization', endpoint: '/ops-health/context-memory', description: 'Session history and summaries' },
  { id: 'metrics-ledger', name: 'Metrics Ledger', group: 'Governance', endpoint: '/ops-health/metrics-ledger', description: 'Token and cost rollups' },
  { id: 'agent-service', name: 'Agent Service', group: 'Agent & Tools', endpoint: '/ops-health/agent-service', description: 'Agent registry' },
  { id: 'tool-service', name: 'Tool Service', group: 'Agent & Tools', endpoint: '/ops-health/tool-service', description: 'Tool registry and policy' },
  { id: 'agent-runtime', name: 'Agent Runtime', group: 'Agent & Tools', endpoint: '/ops-health/agent-runtime', description: 'Capabilities, agents, learning' },
  { id: 'mcp-server', name: 'Local MCP Server', group: 'Execution', endpoint: '/ops-health/mcp-server', description: 'Local tools, AST index, model catalog', critical: true },
]

const commandGroups = [
  {
    title: 'One Command Doctor',
    icon: ShieldCheck,
    commands: [
      { label: 'Check env files, ports, keys, DBs, MCP', command: './singularity.sh doctor' },
      { label: 'Show masked configuration', command: './singularity.sh config show' },
      { label: 'List services', command: './singularity.sh status' },
    ],
  },
  {
    title: 'Canonical Config Profile',
    icon: Database,
    commands: [
      { label: 'Create office-laptop profile', command: './singularity.sh config init --profile office-laptop' },
      { label: 'Rewrite all generated env files from profile', command: './singularity.sh config write' },
      { label: 'Print shell exports from profile', command: './singularity.sh config export' },
    ],
  },
  {
    title: 'LLM Keys And Model Routing',
    icon: KeyRound,
    commands: [
      { label: 'Create MCP model aliases', command: './singularity.sh config mcp-catalog --default-alias fast' },
      { label: 'Office mode: Copilot only', command: './singularity.sh config office-copilot-only' },
      { label: 'Store OpenAI key locally', command: './singularity.sh config set llm.openai.apiKey sk-...' },
      { label: 'Store OpenRouter key locally', command: './singularity.sh config set llm.openrouter.apiKey sk-or-...' },
      { label: 'Show model alias readiness', command: './singularity.sh config models' },
    ],
  },
  {
    title: 'Default MCP Runtime',
    icon: ServerCog,
    commands: [
      { label: 'Point workflows at the local MCP runtime', command: './singularity.sh config mcp --base-url http://localhost:7100 --public-base-url http://host.docker.internal:7100' },
      { label: 'Set local workspace root for AST and git branches', command: './singularity.sh config mcp --sandbox-root /path/to/repo' },
      { label: 'Laptop MCP login', command: 'cd mcp-server && npm run build && npx singularity-mcp login --email admin@singularity.local --platform http://localhost:8100/api/v1' },
    ],
  },
]

const opsTabs: Array<{ key: OpsTab; label: string; icon: typeof SlidersHorizontal; description: string }> = [
  { key: 'setup', label: 'Setup Center', icon: ServerCog, description: 'Health, config, models' },
  { key: 'readiness', label: 'Readiness', icon: Gauge, description: 'Capability launch score' },
  { key: 'trust', label: 'Trust & Eval', icon: ShieldCheck, description: 'Trace, receipts, evals' },
  { key: 'audit', label: 'Run Audit', icon: FileText, description: 'Timing, cost, receipts' },
  { key: 'workitems', label: 'WorkItems', icon: ClipboardList, description: 'Cross-capability queue' },
  { key: 'architecture', label: 'Architecture', icon: GitBranch, description: 'Capability diagrams' },
  { key: 'causality', label: 'AI Causality Proof', icon: ShieldCheck, description: 'Incident evidence' },
]

function stateFromQuery(q: { isSuccess: boolean; isError: boolean; data?: unknown }): HealthState {
  if (q.isSuccess) return 'ONLINE'
  if (q.isError) return 'OFFLINE'
  return 'DEGRADED'
}

function statusClasses(state: HealthState) {
  if (state === 'ONLINE') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (state === 'OFFLINE') return 'border-red-200 bg-red-50 text-red-700'
  return 'border-amber-200 bg-amber-50 text-amber-700'
}

function StatusIcon({ state }: { state: HealthState }) {
  if (state === 'ONLINE') return <CheckCircle2 className="h-4 w-4" />
  if (state === 'OFFLINE') return <WifiOff className="h-4 w-4" />
  return <AlertTriangle className="h-4 w-4" />
}

function CodeLine({ command }: { command: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
    } catch {
      // Clipboard is a convenience; the command remains visible.
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-950 px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-100">{command}</code>
      <button
        type="button"
        onClick={copy}
        className="rounded p-1 text-slate-300 hover:bg-slate-800 hover:text-white"
        title="Copy command"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function OperationsPage() {
  const [activeTab, setActiveTab] = useState<OpsTab>('setup')
  const healthQueries = useQueries({
    queries: services.map((svc) => ({
      queryKey: ['ops-health', svc.id],
      queryFn: async () => {
        const res = await fetch(svc.endpoint, { headers: { accept: 'application/json' } })
        if (!res.ok) throw new Error(`${svc.name} returned ${res.status}`)
        const contentType = res.headers.get('content-type') ?? ''
        if (contentType.includes('application/json')) return res.json()
        const body = await res.text()
        return {
          status: 'ok',
          service: svc.id,
          warning: 'Health endpoint returned non-JSON content.',
          contentType,
          bodyPreview: body.slice(0, 120),
        }
      },
      retry: 1,
      refetchInterval: 15000,
      refetchOnWindowFocus: false,
    })),
  })

  const modelCatalog = useQuery({
    queryKey: ['mcp', 'models'],
    queryFn: async () => (await workgraphApi.get('/llm/models')).data?.data,
    retry: 1,
    refetchInterval: 30000,
  })

  const providers = useQuery({
    queryKey: ['mcp', 'providers'],
    queryFn: async () => (await workgraphApi.get('/llm/providers')).data?.data,
    retry: 1,
    refetchInterval: 30000,
  })

  const doctor = useQuery({
    queryKey: ['ops-doctor'],
    queryFn: async () => {
      const res = await fetch(`/ops-doctor.json?t=${Date.now()}`, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error('Run ./singularity.sh doctor to generate the setup summary.')
      return res.json() as Promise<DoctorSummary>
    },
    retry: false,
    refetchInterval: 30000,
  })

  const summary = useMemo(() => {
    const states = healthQueries.map(stateFromQuery)
    const online = states.filter((s) => s === 'ONLINE').length
    const offline = states.filter((s) => s === 'OFFLINE').length
    const criticalOffline = services.filter((svc, idx) => svc.critical && states[idx] === 'OFFLINE').length
    return { online, offline, criticalOffline, total: services.length }
  }, [healthQueries])

  const grouped = useMemo(() => {
    const map = new Map<string, { svc: ServiceCheck; state: HealthState; error?: string }[]>()
    services.forEach((svc, idx) => {
      const q = healthQueries[idx]
      const list = map.get(svc.group) ?? []
      list.push({
        svc,
        state: stateFromQuery(q),
        error: q.error instanceof Error ? q.error.message : undefined,
      })
      map.set(svc.group, list)
    })
    return Array.from(map.entries())
  }, [healthQueries])

  const modelRows = Array.isArray(modelCatalog.data?.models) ? modelCatalog.data.models : []
  const providerRows = Array.isArray(providers.data?.providers) ? providers.data.providers : []

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: '#0A2240' }}>
            Setup Center
          </h1>
          <p className="mt-1 max-w-3xl text-sm" style={{ color: '#64748b' }}>
            Configure Singularity from one place: service health, DNS, DBs, IAM mode, local MCP runtime, model aliases, and token budget posture.
          </p>
        </div>
        <div className="flex gap-2">
          <Badge tone={summary.criticalOffline ? 'danger' : summary.offline ? 'warn' : 'ok'}>
            {summary.online}/{summary.total} online
          </Badge>
          <Badge tone={summary.criticalOffline ? 'danger' : 'neutral'}>
            {summary.criticalOffline} critical offline
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-7">
        {opsTabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition',
              activeTab === tab.key
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900 shadow-sm'
                : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50',
            )}
          >
            <tab.icon className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{tab.label}</span>
              <span className="mt-0.5 block text-[11px] opacity-75">{tab.description}</span>
            </span>
          </button>
        ))}
      </div>

      {activeTab === 'setup' ? (
        <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <SetupTile
          title="Canonical profile"
          value={doctor.data?.configPath ?? '.singularity/config.local.json'}
          status={doctor.data ? 'OK' : 'WARN'}
          detail={doctor.data ? `Doctor generated ${formatDate(doctor.data.generatedAt)}` : 'Run ./singularity.sh config init --profile office-laptop'}
        />
        <SetupTile
          title="Doctor checks"
          value={doctor.data?.summary ? `${doctor.data.summary.checks}` : 'Not generated'}
          status={doctor.data?.summary?.failures ? 'FAIL' : doctor.data?.summary?.warnings ? 'WARN' : doctor.data ? 'OK' : 'WARN'}
          detail={doctor.data?.summary ? `${doctor.data.summary.failures} failures, ${doctor.data.summary.warnings} warnings` : 'Run ./singularity.sh doctor'}
        />
        <SetupTile
          title="Token mode"
          value="Balanced"
          status="OK"
          detail="Workflow budgets clamp every LLM-backed step."
        />
        <SetupTile
          title="MCP ownership"
          value="Default runtime"
          status="OK"
          detail="MCP owns local files, AST, branches, tools, and model routing."
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.4fr_0.9fr]">
        <Card>
          <CardHeader
            title="Service Status"
            subtitle="Auto-refreshes every 15 seconds through the portal proxy."
            action={<RefreshCw className={cn('h-4 w-4 text-slate-400', healthQueries.some((q) => q.isFetching) && 'animate-spin')} />}
          />
          <CardBody className="space-y-5">
            {grouped.map(([group, rows]) => (
              <div key={group}>
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-slate-500">
                  <Activity className="h-3.5 w-3.5" />
                  {group}
                </div>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {rows.map(({ svc, state, error }) => (
                    <div key={svc.id} className="rounded-lg border border-slate-200 bg-white p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-900">{svc.name}</div>
                          <div className="mt-0.5 text-xs text-slate-500">{svc.description}</div>
                        </div>
                        <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold', statusClasses(state))}>
                          <StatusIcon state={state} />
                          {state}
                        </span>
                      </div>
                      <div className="mt-2 truncate font-mono text-[10px] text-slate-400">{svc.endpoint}</div>
                      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="MCP Model Readiness" subtitle="MCP owns workflow model routing and provider keys." />
          <CardBody className="space-y-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <Zap className="h-4 w-4 text-emerald-600" />
                Default model
              </div>
              <div className="mt-2 font-mono text-xs text-slate-600">
                {modelCatalog.isLoading ? 'Loading...' : modelCatalog.data?.defaultModelAlias ?? 'No model catalog available'}
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Approved Models</div>
              {modelRows.length ? modelRows.slice(0, 8).map((m: any) => (
                <div key={m.id} className="rounded-lg border border-slate-200 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-900">{m.label ?? m.id}</div>
                      <div className="truncate font-mono text-[11px] text-slate-500">{m.provider}/{m.model}</div>
                    </div>
                    <Badge tone={m.ready ? 'ok' : 'danger'}>{m.ready ? 'Ready' : 'Missing key'}</Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {m.default && <Badge tone="neutral">Default</Badge>}
                    {m.supportsTools && <Badge tone="neutral">Tool capable</Badge>}
                    {m.costTier && <Badge tone={m.costTier === 'high' ? 'warn' : 'neutral'}>{m.costTier} cost</Badge>}
                  </div>
                </div>
              )) : (
                <div className="rounded-md bg-slate-50 px-3 py-6 text-center text-xs text-slate-500">
                  {modelCatalog.isError ? 'MCP model catalog is unavailable.' : 'No models reported yet.'}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Providers</div>
              {providerRows.map((p: any) => (
                <div key={p.name} className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-2">
                  <span className="text-sm text-slate-700">{p.name}</span>
                  <Badge tone={p.ready ? 'ok' : 'neutral'}>{p.ready ? 'Ready' : 'Not configured'}</Badge>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Operator Doctor"
          subtitle="Last generated by ./singularity.sh doctor. Secrets stay local and masked."
          action={<ShieldCheck className="h-4 w-4 text-slate-400" />}
        />
        <CardBody>
          {doctor.isError ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              Run <code>./singularity.sh doctor</code> to generate the local setup report that appears here.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {(doctor.data?.checks ?? []).slice(0, 12).map((check, idx) => (
                <div key={`${check.message}-${idx}`} className="rounded-lg border border-slate-200 bg-white p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900">{check.message}</div>
                      {check.fix && <div className="mt-1 font-mono text-[11px] text-slate-500">{check.fix}</div>}
                    </div>
                    <Badge tone={check.status === 'OK' ? 'ok' : check.status === 'WARN' ? 'warn' : 'danger'}>{check.status}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Configuration Utility"
          subtitle="Use the CLI for secret writes; the portal shows the exact commands operators need."
          action={<Terminal className="h-4 w-4 text-slate-400" />}
        />
        <CardBody>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {commandGroups.map((group) => (
              <div key={group.title} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="mb-3 flex items-center gap-2">
                  <group.icon className="h-4 w-4 text-emerald-700" />
                  <div className="text-sm font-semibold text-slate-900">{group.title}</div>
                </div>
                <div className="space-y-3">
                  {group.commands.map((cmd) => (
                    <div key={cmd.command} className="space-y-1.5">
                      <div className="text-xs font-medium text-slate-600">{cmd.label}</div>
                      <CodeLine command={cmd.command} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <InfoCard
          icon={SlidersHorizontal}
          title="What Can Be Configured"
          body="One local profile controls DB URLs, IAM mode, service endpoints, Context Fabric tokens, MCP bearer token, sandbox root, AST limits, model aliases, and provider keys."
        />
        <InfoCard
          icon={Network}
          title="Default MCP Runtime"
          body="MCP is configured once as the local execution runtime. It does not need to belong to a capability; capability-specific MCP overrides are advanced-only."
        />
        <InfoCard
          icon={ShieldCheck}
          title="Safe Secret Handling"
          body="Secrets are written through the CLI into env files and masked in output. The browser never asks you to paste provider keys into the portal."
        />
      </div>
        </>
      ) : activeTab === 'readiness' ? (
        <ReadinessPanel />
      ) : activeTab === 'trust' ? (
        <TrustEvalPanel />
      ) : activeTab === 'audit' ? (
        <RunAuditPanel />
      ) : activeTab === 'workitems' ? (
        <WorkItemsPanel />
      ) : activeTab === 'architecture' ? (
        <ArchitecturePanel />
      ) : (
        <CausalityPanel />
      )}
    </div>
  )
}

function unwrapEnvelope<T>(value: unknown): T {
  const root = value as any
  return (root?.data?.data ?? root?.data ?? root) as T
}

function unwrapItems<T>(value: unknown): T[] {
  const root = unwrapEnvelope<any>(value)
  if (Array.isArray(root)) return root as T[]
  if (Array.isArray(root?.content)) return root.content as T[]
  if (Array.isArray(root?.items)) return root.items as T[]
  if (Array.isArray(root?.data)) return root.data as T[]
  return []
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    // Visible text remains available.
  }
}

function downloadText(filename: string, text: string, type = 'text/plain') {
  const blob = new Blob([text], { type })
  downloadBlob(filename, blob)
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function errorMessage(err: unknown): string {
  const anyErr = err as any
  const data = anyErr?.response?.data
  if (typeof data === 'string') return data
  return data?.message ?? data?.detail ?? data?.error ?? anyErr?.message ?? 'Request failed'
}

function readinessTone(status?: string): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (status === 'READY') return 'ok'
  if (status === 'NOT_READY') return 'danger'
  if (status === 'NEEDS_ATTENTION' || status === 'UNKNOWN') return 'warn'
  return 'neutral'
}

function workflowBudgetConfigured(workflow: WorkflowTemplateRow): boolean {
  return Boolean(workflow.budgetPolicy && Object.keys(workflow.budgetPolicy).length > 0)
}

function ReadinessPanel() {
  const [capabilityId, setCapabilityId] = useState('')
  const [workerBusy, setWorkerBusy] = useState(false)
  const [workerError, setWorkerError] = useState<string | null>(null)
  const [workerResult, setWorkerResult] = useState<any | null>(null)
  const capabilities = useQuery({
    queryKey: ['ops', 'readiness-capabilities'],
    queryFn: async () => unwrapItems<CapabilityRow>(await runtimeApi.get('/capabilities')),
    retry: 1,
  })
  const readiness = useQuery({
    queryKey: ['ops', 'capability-readiness', capabilityId],
    queryFn: async () => unwrapEnvelope<CapabilityReadiness>(await runtimeApi.get(`/capabilities/${capabilityId}/readiness`)),
    enabled: Boolean(capabilityId),
    retry: 1,
  })
  const workflows = useQuery({
    queryKey: ['ops', 'capability-workflows', capabilityId],
    queryFn: async () => unwrapItems<WorkflowTemplateRow>(await workgraphApi.get('/workflows', { params: { capabilityId, size: 100 } })),
    enabled: Boolean(capabilityId),
    retry: 1,
  })
  const workflowRows = workflows.data ?? []
  const workflowWarnings = [
    workflowRows.length === 0 ? 'No Workgraph workflow is attached to this capability.' : undefined,
    workflowRows.length > 0 && !workflowRows.some(workflowBudgetConfigured) ? 'Attached workflows do not have a template budget policy.' : undefined,
  ].filter(Boolean) as string[]
  const selected = capabilities.data?.find(cap => cap.id === capabilityId)
  const data = readiness.data

  async function runLearningWorker() {
    if (!capabilityId) return
    setWorkerBusy(true)
    setWorkerError(null)
    setWorkerResult(null)
    try {
      const res = await runtimeApi.post(`/capabilities/${capabilityId}/learning-worker/run`, {
        syncApprovedSources: true,
        reembed: true,
      })
      const payload = unwrapEnvelope<any>(res)
      setWorkerResult(payload)
      await readiness.refetch()
    } catch (err) {
      setWorkerError(errorMessage(err))
    } finally {
      setWorkerBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[0.8fr_1.4fr]">
      <Card>
        <CardHeader title="Capability Readiness" subtitle="Choose a capability to see launch blockers, warnings, workflows, and next actions." />
        <CardBody className="space-y-3">
          {(capabilities.data ?? []).map(cap => (
            <button key={cap.id} type="button" onClick={() => setCapabilityId(cap.id)} className={cn('w-full rounded-lg border px-3 py-2 text-left', capabilityId === cap.id ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white hover:bg-slate-50')}>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold text-slate-900">{cap.name}</span>
                <Badge tone="neutral">{cap.criticality ?? 'unrated'}</Badge>
              </div>
              <div className="mt-1 truncate text-xs text-slate-500">{cap.appId ? `App ID ${cap.appId}` : cap.id}</div>
            </button>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={selected ? `${selected.name} readiness` : 'Readiness Score'}
          subtitle={data ? `Generated ${formatDate(data.generatedAt)}` : 'Runtime readiness plus Workgraph workflow/budget evidence.'}
          action={readiness.isFetching || workflows.isFetching ? <RefreshCw className="h-4 w-4 animate-spin text-slate-400" /> : undefined}
        />
        <CardBody className="space-y-5">
          {readiness.isError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">Unable to fetch capability readiness. Check agent-runtime health and auth.</div>
          ) : !capabilityId ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">Choose a capability to generate its readiness score.</div>
          ) : data ? (
            <>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-[180px_1fr]">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-center">
                  <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Score</div>
                  <div className="mt-3 text-5xl font-black text-slate-950">{data.score}</div>
                  <div className="mt-3"><Badge tone={readinessTone(data.status)}>{data.status}</Badge></div>
                </div>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-7">
                  <Metric title="Active agents" value={String(data.facts?.activeAgents ?? 0)} />
                  <Metric title="Knowledge" value={String(data.facts?.knowledgeArtifacts ?? 0)} />
                  <Metric title="Learning pending" value={String(data.facts?.pendingLearningCandidates ?? 0)} />
                  <Metric title="Learning approved" value={String(data.facts?.materializedLearningCandidates ?? 0)} />
                  <Metric title="Code symbols" value={String(data.facts?.codeSymbols ?? 0)} />
                  <Metric title="Workflows" value={String(workflowRows.length)} />
                  <Metric title="Budgeted" value={String(workflowRows.filter(workflowBudgetConfigured).length)} />
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">Capability learning worker</div>
                    <div className="mt-1 text-xs text-slate-500">Sync approved repo/doc sources, backfill embeddings, and report any pending human review gates.</div>
                  </div>
                  <button
                    className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={workerBusy || !capabilityId}
                    onClick={runLearningWorker}
                  >
                    {workerBusy ? 'Running worker...' : 'Run learning worker'}
                  </button>
                </div>
                {workerError && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{workerError}</div>}
                {workerResult && (
                  <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
                    <Metric title="Warnings" value={String(workerResult.warnings?.length ?? 0)} />
                    <Metric title="Next actions" value={String(workerResult.nextActions?.length ?? 0)} />
                    <Metric title="Knowledge after" value={String(workerResult.after?.knowledge?.active ?? 0)} />
                    {(workerResult.nextActions ?? []).length > 0 && (
                      <div className="rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800 lg:col-span-3">
                        <div className="font-semibold">Worker next actions</div>
                        <ul className="mt-1 space-y-1">
                          {workerResult.nextActions.slice(0, 5).map((item: string) => <li key={item}>- {item}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {(data.blockers.length > 0 || data.warnings.length > 0 || workflowWarnings.length > 0) && (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <div className="rounded-xl border border-red-100 bg-red-50 p-4">
                    <div className="text-xs font-semibold uppercase tracking-widest text-red-700">Blockers</div>
                    <ul className="mt-2 space-y-1 text-sm text-red-700">
                      {(data.blockers.length ? data.blockers.map(item => item.message) : ['No hard blockers reported.']).map(item => <li key={item}>- {item}</li>)}
                    </ul>
                  </div>
                  <div className="rounded-xl border border-amber-100 bg-amber-50 p-4">
                    <div className="text-xs font-semibold uppercase tracking-widest text-amber-700">Warnings</div>
                    <ul className="mt-2 space-y-1 text-sm text-amber-700">
                      {[...data.warnings.map(item => item.message), ...workflowWarnings].slice(0, 8).map(item => <li key={item}>- {item}</li>)}
                    </ul>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {data.categories.map(category => (
                  <div key={category.key} className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">{category.label}</div>
                        <div className="mt-1 text-xs text-slate-500">{category.score}/{category.maxScore} · {category.summary}</div>
                      </div>
                      <Badge tone={readinessTone(category.status)}>{category.status}</Badge>
                    </div>
                    <div className="mt-3 space-y-2">
                      {category.checks.map(check => (
                        <div key={check.key} className="flex gap-2 text-xs text-slate-600">
                          {check.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-emerald-600" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 text-amber-600" />}
                          <span><span className="font-semibold text-slate-800">{check.label}:</span> {check.detail}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Recommended next actions</div>
                <ul className="mt-2 space-y-1 text-sm text-slate-700">
                  {[...data.recommendedActions, ...workflowWarnings].slice(0, 8).map(item => <li key={item}>- {item}</li>)}
                </ul>
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">Loading readiness.</div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

function TrustEvalPanel() {
  const [runId, setRunId] = useState('')
  const [selectedTraceId, setSelectedTraceId] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState('')
  const [datasetName, setDatasetName] = useState('Production run examples')
  const [expectedOutput, setExpectedOutput] = useState('')
  const [criteria, setCriteria] = useState('Actual output should satisfy the expected delivery outcome.')
  const [selectedEvaluatorId, setSelectedEvaluatorId] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionResult, setActionResult] = useState<any | null>(null)
  const recentRuns = useQuery({
    queryKey: ['ops', 'trust-runs'],
    queryFn: async () => unwrapItems<WorkflowRunRow>(await workgraphApi.get('/workflow-instances')),
    retry: 1,
  })
  const trace = useQuery({
    queryKey: ['ops', 'trust-trace', runId],
    queryFn: async () => unwrapEnvelope<any>(await workgraphApi.get(`/workflow-instances/${runId}/trust-trace`)),
    enabled: Boolean(runId.trim()),
    retry: 1,
  })
  const receipt = useQuery({
    queryKey: ['ops', 'delivery-receipt', runId],
    queryFn: async () => unwrapEnvelope<any>(await workgraphApi.get(`/workflow-instances/${runId}/delivery-receipt`)),
    enabled: Boolean(runId.trim()),
    retry: 1,
  })
  const evaluators = useQuery({
    queryKey: ['ops', 'engine-evaluators'],
    queryFn: async () => unwrapItems<any>(await auditGovApi.get('/engine/evaluators', { params: { enabled: 'true' } })),
    retry: 1,
  })
  const traceIds: string[] = Array.isArray(trace.data?.traceIds) ? trace.data.traceIds : []
  const timeline: any[] = Array.isArray(trace.data?.timeline) ? trace.data.timeline : []
  const markdown = typeof receipt.data?.markdown === 'string' ? receipt.data.markdown : ''

  async function createExample() {
    if (!runId.trim()) return
    setActionError(null)
    setActionResult(null)
    try {
      const res = await workgraphApi.post(`/workflow-instances/${runId}/eval-examples`, {
        datasetName,
        nodeId: selectedNodeId || undefined,
        traceId: selectedTraceId || undefined,
        expectedOutput,
        criteria: { text: criteria },
        tags: ['ops-portal', 'run-derived'],
      })
      setActionResult({ kind: 'eval-example', payload: unwrapEnvelope<any>(res) })
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  async function runEvaluator() {
    const traceId = selectedTraceId || traceIds[0]
    if (!traceId) return
    setActionError(null)
    setActionResult(null)
    try {
      const res = await auditGovApi.post('/engine/evaluators/run-trace', {
        traceId,
        evaluatorIds: selectedEvaluatorId ? [selectedEvaluatorId] : undefined,
        metadata: { source: 'operations_portal', workflowInstanceId: runId },
      })
      setActionResult({ kind: 'eval-run', payload: unwrapEnvelope<any>(res) })
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[0.85fr_1.35fr]">
      <Card>
        <CardHeader title="Trust & Eval" subtitle="Inspect a trace spine, export the delivery receipt, and create eval examples from real runs." />
        <CardBody className="space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500">Workflow run id</label>
            <input
              value={runId}
              onChange={(event) => {
                setRunId(event.target.value)
                setSelectedTraceId('')
                setSelectedNodeId('')
              }}
              placeholder="Paste workflowInstanceId"
              className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-emerald-400"
            />
          </div>
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Recent runs</div>
            {(recentRuns.data ?? []).slice(0, 6).map(run => (
              <button
                key={run.id}
                type="button"
                onClick={() => {
                  setRunId(run.id)
                  setSelectedTraceId('')
                  setSelectedNodeId('')
                }}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-left hover:bg-slate-50"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-slate-900">{run.name}</span>
                  <Badge tone={run.status === 'COMPLETED' ? 'ok' : run.status === 'FAILED' ? 'danger' : 'neutral'}>{run.status}</Badge>
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-slate-500">{run.id}</div>
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-sm font-semibold text-slate-900">Create eval example from run</div>
            <div className="mt-3 space-y-2">
              <input value={datasetName} onChange={e => setDatasetName(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="Dataset name" />
              <select value={selectedNodeId} onChange={e => setSelectedNodeId(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="">Any node</option>
                {timeline.map(row => <option key={row.node?.id} value={row.node?.id}>{row.node?.label ?? row.node?.id}</option>)}
              </select>
              <select value={selectedTraceId} onChange={e => setSelectedTraceId(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="">Use first available trace</option>
                {traceIds.map(id => <option key={id} value={id}>{id}</option>)}
              </select>
              <textarea value={expectedOutput} onChange={e => setExpectedOutput(e.target.value)} className="min-h-[80px] w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="Expected output or acceptance text" />
              <textarea value={criteria} onChange={e => setCriteria(e.target.value)} className="min-h-[70px] w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="Evaluation criteria" />
              <button className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50" disabled={!runId.trim()} onClick={createExample}>Create eval example</button>
            </div>
          </div>
        </CardBody>
      </Card>

      <div className="space-y-5">
        <Card>
          <CardHeader
            title="Trace Explorer"
            subtitle="Workflow node, prompt, Context Fabric, MCP, tool/code, approval, budget, and audit evidence grouped by trace id."
            action={trace.isFetching ? <RefreshCw className="h-4 w-4 animate-spin text-slate-400" /> : undefined}
          />
          <CardBody className="space-y-4">
            {trace.isError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">Trace Explorer could not load this run.</div>
            ) : !runId ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">Choose a run to inspect its trust trace.</div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Metric title="Trace ids" value={String(traceIds.length)} />
                  <Metric title="Nodes" value={String(trace.data?.totals?.nodes ?? 0)} />
                  <Metric title="Tokens" value={String(trace.data?.totals?.tokens ?? 0)} />
                  <Metric title="Audit events" value={String(trace.data?.totals?.auditEvents ?? 0)} />
                </div>
                {(trace.data?.gaps ?? []).length > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    <div className="font-semibold">Evidence gaps</div>
                    <ul className="mt-1 space-y-1">{trace.data.gaps.map((gap: string) => <li key={gap}>- {gap}</li>)}</ul>
                  </div>
                )}
                <div className="space-y-3">
                  {timeline.map(row => (
                    <details key={row.node?.id} className="rounded-xl border border-slate-200 bg-white p-3">
                      <summary className="cursor-pointer list-none">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-slate-900">{row.node?.label}</div>
                            <div className="mt-1 text-xs text-slate-500">{row.node?.nodeType} · {row.traceIds?.length ?? 0} traces · {row.auditEvents?.length ?? 0} events</div>
                          </div>
                          <Badge tone={row.node?.status === 'COMPLETED' ? 'ok' : row.node?.status === 'BLOCKED' || row.node?.status === 'FAILED' ? 'danger' : 'neutral'}>{row.node?.status}</Badge>
                        </div>
                      </summary>
                      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                        <MiniEvidence title="Prompts" rows={row.promptAssemblyIds?.map((id: string) => ({ id }))} />
                        <MiniEvidence title="Context Fabric / MCP" rows={[...(row.cfCallIds ?? []).map((id: string) => ({ cfCallId: id })), ...(row.mcpInvocationIds ?? []).map((id: string) => ({ mcpInvocationId: id }))]} />
                        <MiniEvidence title="Budget" rows={row.budgetEvents} />
                        <MiniEvidence title="Audit Events" rows={row.auditEvents} />
                      </div>
                    </details>
                  ))}
                </div>
              </>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Delivery Receipt & Evaluators" subtitle="Export an audit-grade receipt or run deterministic evaluators against a trace." />
          <CardBody className="space-y-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Metric title="Receipt status" value={receipt.data?.summary?.status ?? 'n/a'} />
              <Metric title="Eval status" value={receipt.data?.summary?.evalStatus ?? 'n/a'} />
              <Metric title="Cost" value={receipt.data?.summary?.estimatedCost == null ? 'UNPRICED' : `$${Number(receipt.data.summary.estimatedCost).toFixed(4)}`} />
              <Metric title="Artifacts" value={String(receipt.data?.summary?.artifacts ?? 0)} />
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => copyText(markdown)} disabled={!markdown}>Copy Receipt Markdown</button>
              <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => downloadText(`${runId}-delivery-receipt.md`, markdown, 'text/markdown')} disabled={!markdown}>Download Markdown</button>
              <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => downloadText(`${runId}-delivery-receipt.json`, JSON.stringify(receipt.data ?? {}, null, 2), 'application/json')} disabled={!receipt.data}>Download JSON</button>
              {runId && <a className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700" href={`${env.links.workgraphDesigner}/runs/${runId}/insights`} target="_blank" rel="noreferrer">Open Run Insights</a>}
            </div>
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-[1fr_auto]">
              <select value={selectedEvaluatorId} onChange={e => setSelectedEvaluatorId(e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="">All enabled evaluators</option>
                {(evaluators.data ?? []).map(ev => <option key={ev.id} value={ev.id}>{ev.name ?? ev.id} · {ev.evaluator_type}</option>)}
              </select>
              <button className="rounded-lg bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50" disabled={!runId || traceIds.length === 0} onClick={runEvaluator}>Run evaluator</button>
            </div>
            {actionError && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{actionError}</div>}
            {actionResult && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-500">{actionResult.kind}</div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-[11px] text-slate-100">{JSON.stringify(actionResult.payload, null, 2)}</pre>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

function RunAuditPanel() {
  const [runId, setRunId] = useState('')
  const [pdfBusy, setPdfBusy] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const recentRuns = useQuery({
    queryKey: ['ops', 'workflow-instances'],
    queryFn: async () => unwrapItems<WorkflowRunRow>(await workgraphApi.get('/workflow-instances')),
    retry: 1,
  })
  const report = useQuery({
    queryKey: ['ops', 'run-audit', runId],
    queryFn: async () => unwrapEnvelope<any>(await workgraphApi.get(`/workflow-instances/${runId}/evidence-pack`)),
    enabled: Boolean(runId.trim()),
    retry: 1,
  })
  const data = report.data ?? {}
  const summary = data.summary ?? {}
  const sections = data.sections ?? {}
  const stages: any[] = Array.isArray(sections.stageTimeline) ? sections.stageTimeline : []
  const markdown = typeof data.markdown === 'string' ? data.markdown : ''
  const jsonText = JSON.stringify(data, null, 2)

  async function downloadEvidencePdf() {
    if (!runId.trim()) return
    setPdfBusy(true)
    setDownloadError(null)
    try {
      const res = await workgraphApi.get(`/workflow-instances/${runId}/evidence-pack`, {
        params: { format: 'pdf' },
        responseType: 'blob',
      })
      const blob = res.data instanceof Blob ? res.data : new Blob([res.data], { type: 'application/pdf' })
      downloadBlob(`${runId}-evidence-pack.pdf`, blob)
    } catch (err) {
      setDownloadError(errorMessage(err))
    } finally {
      setPdfBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[0.8fr_1.4fr]">
      <Card>
        <CardHeader title="Run Audit" subtitle="Select a workflow run and generate an operator-readable audit report." />
        <CardBody className="space-y-4">
          <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500">Workflow run id</label>
          <input
            value={runId}
            onChange={(event) => setRunId(event.target.value)}
            placeholder="Paste workflowInstanceId"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-emerald-400"
          />
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Recent runs</div>
            {(recentRuns.data ?? []).slice(0, 8).map(run => (
              <button
                key={run.id}
                type="button"
                onClick={() => setRunId(run.id)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-left hover:bg-slate-50"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-slate-900">{run.name}</span>
                  <Badge tone={run.status === 'COMPLETED' ? 'ok' : run.status === 'FAILED' ? 'danger' : 'neutral'}>{run.status}</Badge>
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-slate-500">{run.id}</div>
              </button>
            ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Audit Report"
          subtitle="Stage timing, token/cost rollups, approvals, artifacts, receipts, and Workbench evidence."
          action={report.isFetching ? <RefreshCw className="h-4 w-4 animate-spin text-slate-400" /> : undefined}
        />
        <CardBody className="space-y-4">
          {report.isError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">Unable to fetch run insights.</div>
          ) : !runId ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">Choose a run to generate the audit report.</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Metric title="Status" value={summary.status ?? 'loading'} />
                <Metric title="Tokens" value={String(summary.tokens?.total ?? 0)} />
                <Metric title="Cost" value={summary.estimatedCost == null ? 'UNPRICED' : `$${Number(summary.estimatedCost).toFixed(4)}`} />
                <Metric title="Artifacts" value={String(summary.artifacts ?? 0)} />
              </div>
              {Array.isArray(summary.warnings) && summary.warnings.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  <div className="font-semibold">Evidence gaps</div>
                  <ul className="mt-1 space-y-1">
                    {summary.warnings.map((warning: string) => <li key={warning}>- {warning}</li>)}
                  </ul>
                </div>
              )}
              {downloadError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  PDF export failed: {downloadError}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => copyText(markdown)}>Copy Markdown</button>
                <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => downloadText(`${runId}-evidence-pack.md`, markdown, 'text/markdown')}>Download Markdown</button>
                <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50" disabled={pdfBusy} onClick={downloadEvidencePdf}>{pdfBusy ? 'Preparing PDF...' : 'Download PDF'}</button>
                <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => downloadText(`${runId}-evidence-pack.json`, jsonText, 'application/json')}>Download JSON</button>
                <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => copyText(jsonText)}>Copy JSON</button>
                <a className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700" href={`${env.links.workgraphDesigner}/runs/${runId}/insights`} target="_blank" rel="noreferrer">Open Run Insights</a>
              </div>
              <div className="overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr><th className="px-3 py-2">Stage</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Duration</th><th className="px-3 py-2">Evidence</th></tr>
                  </thead>
                  <tbody>
                    {stages.map((stage: any) => (
                      <tr key={stage.id ?? stage.nodeId} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-semibold text-slate-900">{stage.label ?? stage.nodeId ?? stage.id}</td>
                        <td className="px-3 py-2 text-slate-600">{stage.status ?? '-'}</td>
                        <td className="px-3 py-2 text-slate-600">{formatDuration(stage.durationMs)}</td>
                        <td className="px-3 py-2 text-slate-600">{stage.approvalCount ?? 0} approvals · {(stage.consumableIds?.length ?? 0)} consumables · {(stage.artifactIds?.length ?? 0)} artifacts</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

function WorkItemsPanel() {
  const [targetCapabilityId, setTargetCapabilityId] = useState('')
  const [status, setStatus] = useState('')
  const [mine, setMine] = useState(false)
  const [actionKey, setActionKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const capabilities = useQuery({
    queryKey: ['ops', 'workitem-capabilities'],
    queryFn: async () => unwrapItems<CapabilityRow>(await runtimeApi.get('/capabilities')),
    retry: 1,
  })
  const workItems = useQuery({
    queryKey: ['ops', 'work-items', targetCapabilityId, status, mine],
    queryFn: async () => {
      const res = await workgraphApi.get('/work-items', { params: { targetCapabilityId: targetCapabilityId || undefined, status: status || undefined, mine: mine ? 'true' : undefined } })
      return unwrapEnvelope<{ items: WorkItemRow[] }>(res).items ?? []
    },
    retry: 1,
  })
  const capabilityNames = useMemo(() => new Map((capabilities.data ?? []).map(cap => [cap.id, cap.name])), [capabilities.data])

  async function mutate(path: string, body?: unknown, key?: string) {
    setActionKey(key ?? path)
    setActionError(null)
    try {
      await workgraphApi.post(path, body ?? {})
      await workItems.refetch()
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setActionKey(null)
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Cross-Capability WorkItems" subtitle="Child capability queues, claims, child runs, parent approvals, and rework loops." />
        <CardBody>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_180px_120px]">
            <select value={targetCapabilityId} onChange={e => setTargetCapabilityId(e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-emerald-400">
              <option value="">All target capabilities</option>
              {(capabilities.data ?? []).map(cap => <option key={cap.id} value={cap.id}>{cap.name}</option>)}
            </select>
            <select value={status} onChange={e => setStatus(e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <option value="">Any status</option>
              <option value="QUEUED">Queued</option>
              <option value="CLAIMED">Claimed</option>
              <option value="IN_PROGRESS">In progress</option>
              <option value="SUBMITTED">Submitted</option>
              <option value="APPROVED">Approved</option>
              <option value="REWORK_REQUESTED">Rework</option>
            </select>
            <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600">
              <input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} />
              Mine
            </label>
          </div>
        </CardBody>
      </Card>

      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          WorkItem action failed: {actionError}
        </div>
      )}
      {workItems.isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Unable to load WorkItems. Check Workgraph health and IAM membership sync.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {(workItems.data ?? []).map(item => {
          const targets = item.targets ?? []
          const canApprove = targets.length > 0 && targets.every(target => target.status === 'SUBMITTED' || target.status === 'APPROVED') && item.status !== 'COMPLETED'
          const canRequestRework = targets.some(target => target.status === 'SUBMITTED' || target.status === 'APPROVED')
          return (
            <Card key={item.id}>
              <CardHeader
                title={item.title}
                subtitle={`Parent capability ${item.parentCapabilityId ?? 'n/a'} · priority ${item.priority ?? 50}`}
                action={<Badge tone={item.status === 'COMPLETED' ? 'ok' : item.status === 'CANCELLED' ? 'danger' : item.status === 'AWAITING_PARENT_APPROVAL' ? 'warn' : 'neutral'}>{item.status}</Badge>}
              />
              <CardBody className="space-y-4">
                {item.description && <p className="text-sm leading-6 text-slate-600">{item.description}</p>}
                <div className="space-y-2">
                  {targets.map(target => {
                    const canClaim = (target.status === 'QUEUED' || target.status === 'REWORK_REQUESTED') && !target.claimedById
                    const canStart = target.status === 'CLAIMED' && Boolean(target.claimedById) && Boolean(target.childWorkflowTemplateId) && !target.childWorkflowInstanceId
                    const busyClaim = actionKey === `claim-${target.id}`
                    const busyStart = actionKey === `start-${target.id}`
                    const targetName = capabilityNames.get(target.targetCapabilityId) ?? target.targetCapabilityId
                    return (
                      <div key={target.id} className="rounded-lg border border-slate-200 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-slate-900">{targetName}</div>
                            <div className="mt-1 font-mono text-[11px] text-slate-500">{target.targetCapabilityId}</div>
                            <div className="mt-1 text-xs text-slate-600">
                              Role {target.roleKey ?? 'any'} · {target.claimedById ? `claimed by ${target.claimedById.slice(0, 8)}` : 'unclaimed'} · child run {target.childWorkflowInstanceId ? target.childWorkflowInstanceId.slice(0, 8) : 'not started'}
                            </div>
                            {!target.childWorkflowTemplateId && <div className="mt-1 text-xs text-amber-700">No child workflow template configured.</div>}
                          </div>
                          <Badge tone={target.status === 'SUBMITTED' || target.status === 'APPROVED' ? 'ok' : target.status === 'REWORK_REQUESTED' ? 'warn' : 'neutral'}>{target.status}</Badge>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={!canClaim || Boolean(actionKey)}
                            onClick={() => mutate(`/work-items/${item.id}/targets/${target.id}/claim`, undefined, `claim-${target.id}`)}
                          >
                            {busyClaim ? 'Claiming...' : 'Claim'}
                          </button>
                          <button
                            className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={!canStart || Boolean(actionKey)}
                            onClick={() => mutate(`/work-items/${item.id}/targets/${target.id}/start`, undefined, `start-${target.id}`)}
                          >
                            {busyStart ? 'Starting...' : 'Start child workflow'}
                          </button>
                          {target.childWorkflowInstanceId && <a className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700" href={`${env.links.workgraphDesigner}/runs/${target.childWorkflowInstanceId}/insights`} target="_blank" rel="noreferrer">Child evidence</a>}
                        </div>
                      </div>
                    )
                  })}
                </div>
                {item.events?.length ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Latest events</div>
                    <div className="mt-2 space-y-1">
                      {item.events.map(event => (
                        <div key={event.id} className="flex items-center justify-between gap-3 text-xs text-slate-600">
                          <span className="font-semibold text-slate-800">{event.eventType}</span>
                          <span>{formatDate(event.createdAt)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <button
                    className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!canApprove || Boolean(actionKey)}
                    onClick={() => mutate(`/work-items/${item.id}/approve`, undefined, `approve-${item.id}`)}
                  >
                    {actionKey === `approve-${item.id}` ? 'Approving...' : 'Approve parent result'}
                  </button>
                  <button
                    className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!canRequestRework || Boolean(actionKey)}
                    onClick={() => mutate(`/work-items/${item.id}/request-rework`, { reason: 'Operator requested rework from Operations Portal.' }, `rework-${item.id}`)}
                  >
                    {actionKey === `rework-${item.id}` ? 'Requesting...' : 'Request rework'}
                  </button>
                </div>
              </CardBody>
            </Card>
          )
        })}
        {workItems.data?.length === 0 && <Card><CardBody><div className="py-8 text-center text-sm text-slate-500">No WorkItems match the current filters.</div></CardBody></Card>}
      </div>
    </div>
  )
}

function ArchitecturePanel() {
  const [capabilityId, setCapabilityId] = useState('')
  const capabilities = useQuery({
    queryKey: ['ops', 'capabilities'],
    queryFn: async () => unwrapItems<CapabilityRow>(await runtimeApi.get('/capabilities')),
    retry: 1,
  })
  const diagram = useQuery({
    queryKey: ['ops', 'architecture-diagram', capabilityId],
    queryFn: async () => unwrapEnvelope<ArchitectureDiagram>(await runtimeApi.get(`/capabilities/${capabilityId}/architecture-diagram`)),
    enabled: Boolean(capabilityId),
    retry: 1,
  })

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[0.8fr_1.4fr]">
      <Card>
        <CardHeader title="Capability Architecture" subtitle="Application and TOGAF collection views generated by agent-runtime." />
        <CardBody className="space-y-3">
          {(capabilities.data ?? []).map(cap => (
            <button key={cap.id} type="button" onClick={() => setCapabilityId(cap.id)} className={cn('w-full rounded-lg border px-3 py-2 text-left', capabilityId === cap.id ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white hover:bg-slate-50')}>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold text-slate-900">{cap.name}</span>
                <Badge tone={cap.capabilityType?.toLowerCase().includes('collection') ? 'warn' : 'neutral'}>{cap.capabilityType ?? 'application'}</Badge>
              </div>
              <div className="mt-1 truncate text-xs text-slate-500">{cap.appId ? `App ID ${cap.appId}` : cap.id}</div>
            </button>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={diagram.data?.title ?? 'Diagram Viewer'}
          subtitle={diagram.data ? `${diagram.data.source} · ${diagram.data.kind} · ${formatDate(diagram.data.generatedAt)}` : 'Select a capability.'}
          action={diagram.isFetching ? <RefreshCw className="h-4 w-4 animate-spin text-slate-400" /> : undefined}
        />
        <CardBody className="space-y-4">
          {diagram.data ? (
            <>
              <p className="text-sm leading-6 text-slate-600">{diagram.data.description}</p>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {diagram.data.layers.map(layer => (
                  <div key={layer.key} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">{layer.label}</div>
                    <ul className="mt-2 space-y-1 text-sm text-slate-700">
                      {layer.items.map(item => <li key={item}>- {item}</li>)}
                    </ul>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => copyText(diagram.data!.mermaid)}>Copy Mermaid</button>
                <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => downloadText(`${diagram.data!.capabilityId}.mmd`, diagram.data!.mermaid)}>Export .mmd</button>
                <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => copyText(JSON.stringify(diagram.data, null, 2))}>Copy JSON</button>
              </div>
              <pre className="max-h-80 overflow-auto rounded-lg bg-slate-950 p-4 text-xs text-slate-100">{diagram.data.mermaid}</pre>
            </>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">Choose a capability to view its architecture diagram.</div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

function CausalityPanel() {
  const [form, setForm] = useState({ runId: '', subject: '', path: '', artifactId: '', commitSha: '' })
  const [request, setRequest] = useState<typeof form | null>(null)
  const report = useQuery({
    queryKey: ['ops', 'causality', request],
    queryFn: async () => unwrapEnvelope<any>(await workgraphApi.get(`/workflow-instances/${request!.runId}/ai-causality-report`, {
      params: {
        subject: request!.subject || undefined,
        path: request!.path || undefined,
        artifactId: request!.artifactId || undefined,
        commitSha: request!.commitSha || undefined,
      },
    })),
    enabled: Boolean(request?.runId),
    retry: 1,
  })
  const data = report.data

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[0.8fr_1.4fr]">
      <Card>
        <CardHeader title="AI Causality Proof" subtitle="Incident-style evidence report. Incomplete evidence is marked inconclusive." />
        <CardBody className="space-y-3">
          {(['runId', 'subject', 'path', 'artifactId', 'commitSha'] as const).map(field => (
            <label key={field} className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-widest text-slate-500">{field}</span>
              <input value={form[field]} onChange={e => setForm({ ...form, [field]: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-emerald-400" />
            </label>
          ))}
          <button className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700" onClick={() => setRequest(form)}>Generate evidence report</button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Evidence-Backed RCA" subtitle="Verdict first, then the audit facts behind it." />
        <CardBody className="space-y-4">
          {report.isError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">Unable to generate causality report.</div>
          ) : !data ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">Enter a run id and optional incident subject.</div>
          ) : (
            <>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={data.classification === 'INCONCLUSIVE' ? 'warn' : data.classification?.includes('UNAPPROVED') ? 'danger' : 'ok'}>{data.classification}</Badge>
                  <Badge tone="neutral">Confidence {data.confidence}</Badge>
                </div>
                <p className="mt-3 text-sm leading-6 text-slate-700">{data.verdict}</p>
              </div>
              <EvidenceList title="What AI did" rows={data.evidence?.whatAiDid} />
              <EvidenceList title="Human approvals involved" rows={data.evidence?.humanApprovals} />
              <EvidenceList title="Code/artifact evidence" rows={data.evidence?.codeAndArtifactEvidence} />
              <EvidenceList title="Gaps that make this inconclusive" rows={(data.evidence?.warnings ?? []).map((message: string) => ({ message }))} />
              <div className="flex flex-wrap gap-2">
                <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => copyText(JSON.stringify(data, null, 2))}>Copy JSON</button>
                <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={() => copyText(`# AI Causality Proof\n\n${data.classification}\n\n${data.verdict}`)}>Copy Markdown</button>
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">{title}</div>
      <div className="mt-2 truncate text-sm font-semibold text-slate-900">{value}</div>
    </div>
  )
}

function EvidenceList({ title, rows }: { title: string; rows?: any[] }) {
  const visible = Array.isArray(rows) ? rows.slice(0, 8) : []
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-slate-500">
        <Boxes className="h-3.5 w-3.5" />
        {title}
      </div>
      {visible.length ? (
        <div className="space-y-2">
          {visible.map((row, idx) => (
            <pre key={idx} className="max-h-28 overflow-auto rounded-lg border border-slate-200 bg-white p-3 text-[11px] text-slate-700">{JSON.stringify(row, null, 2)}</pre>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-4 text-sm text-slate-500">No evidence rows.</div>
      )}
    </div>
  )
}

function MiniEvidence({ title, rows }: { title: string; rows?: any[] }) {
  const items = Array.isArray(rows) ? rows.filter(Boolean).slice(0, 6) : []
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">{title}</div>
      {items.length === 0 ? (
        <div className="text-xs text-slate-400">No evidence captured.</div>
      ) : (
        <div className="space-y-2">
          {items.map((row, idx) => (
            <pre key={row.id ?? row.cfCallId ?? row.mcpInvocationId ?? idx} className="max-h-28 overflow-auto whitespace-pre-wrap rounded-md bg-white p-2 text-[10px] text-slate-600">
              {JSON.stringify(row, null, 2)}
            </pre>
          ))}
        </div>
      )}
    </div>
  )
}

function formatDuration(value?: number | string | null) {
  const ms = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return 'n/a'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)} s`
  return `${(sec / 60).toFixed(1)} min`
}

function formatDate(value?: string) {
  if (!value) return 'unknown'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function SetupTile({
  title,
  value,
  detail,
  status,
}: {
  title: string
  value: string
  detail: string
  status: 'OK' | 'WARN' | 'FAIL'
}) {
  return (
    <Card>
      <CardBody>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">{title}</div>
            <div className="mt-2 truncate text-sm font-semibold text-slate-900">{value}</div>
            <div className="mt-1 text-xs leading-5 text-slate-600">{detail}</div>
          </div>
          <Badge tone={status === 'OK' ? 'ok' : status === 'WARN' ? 'warn' : 'danger'}>{status}</Badge>
        </div>
      </CardBody>
    </Card>
  )
}

function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'danger' | 'neutral'; children: ReactNode }) {
  const cls = {
    ok: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    warn: 'border-amber-200 bg-amber-50 text-amber-700',
    danger: 'border-red-200 bg-red-50 text-red-700',
    neutral: 'border-slate-200 bg-slate-50 text-slate-600',
  }[tone]
  return <span className={cn('inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-semibold', cls)}>{children}</span>
}

function InfoCard({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof SlidersHorizontal
  title: string
  body: string
}) {
  return (
    <Card>
      <CardBody>
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700">
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">{title}</div>
            <p className="mt-1 text-xs leading-5 text-slate-600">{body}</p>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
