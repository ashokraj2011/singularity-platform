import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import {
  Activity, AlertTriangle, CheckCircle2, Copy, Database, KeyRound,
  Network, RefreshCw, ServerCog, ShieldCheck, SlidersHorizontal, Terminal,
  WifiOff, Zap,
} from 'lucide-react'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { mcpApi } from '@/lib/api'
import { cn } from '@/lib/cn'

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
  const healthQueries = useQueries({
    queries: services.map((svc) => ({
      queryKey: ['ops-health', svc.id],
      queryFn: async () => {
        const res = await fetch(svc.endpoint, { headers: { accept: 'application/json' } })
        if (!res.ok) throw new Error(`${svc.name} returned ${res.status}`)
        return res.json()
      },
      retry: 1,
      refetchInterval: 15000,
      refetchOnWindowFocus: false,
    })),
  })

  const modelCatalog = useQuery({
    queryKey: ['mcp', 'models'],
    queryFn: async () => (await mcpApi.get('/llm/models')).data?.data,
    retry: 1,
    refetchInterval: 30000,
  })

  const providers = useQuery({
    queryKey: ['mcp', 'providers'],
    queryFn: async () => (await mcpApi.get('/llm/providers')).data?.data,
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
    </div>
  )
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
