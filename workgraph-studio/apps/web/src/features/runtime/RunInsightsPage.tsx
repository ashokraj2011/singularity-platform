/**
 * M24 — Run Insights dashboard.
 *
 *   /runs/:id/insights
 *
 * One screen: per-step Gantt with durations, artifacts produced, cost +
 * tokens scoped to the run, full audit timeline. Read-only — drives
 * decisions, doesn't mutate anything. Polls every 5s like /audit.
 */
import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft, Clock, Activity, Coins, AlertTriangle, FileText, Box, ShieldCheck, GitBranch,
} from 'lucide-react'
import { api } from '../../lib/api'
import { LiveEventsPanel } from './LiveEventsPanel'

interface InsightNode {
  id: string
  label: string
  nodeType: string
  status: string
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  durationPrecise: boolean
  documents: Array<{ id: string; name: string; kind: string; sizeBytes: number | null; mimeType: string | null; uploadedAt: string }>
  consumables: Array<{ id: string; name: string; status: string; currentVersion: number; updatedAt: string }>
  workspace: Array<{
    branch?: string
    commitSha?: string
    changedPaths: string[]
    astIndexStatus?: string
    astIndexedFiles?: number
    astIndexedSymbols?: number
  }>
  citations: Array<{
    citationKey: string
    sourceKind: string
    sourceId: string
    confidence: number | null
    excerpt: string
  }>
  laptopDevice?: {
    user_id: string
    device_id: string
    device_name?: string
  }
  eventCount: number
}
interface InsightEvent {
  id: string; source_service: string; kind: string; severity: string
  subject_type: string | null; subject_id: string | null
  created_at: string; payload: Record<string, unknown> | null
}
interface InsightsResponse {
  run: {
    id: string; name: string; status: string; templateId: string | null
    startedAt: string | null; completedAt: string | null
    createdAt: string; updatedAt: string; durationMs: number | null
  }
  totals: {
    nodes: number; nodesByStatus: Record<string, number>
    documentsCount: number; consumablesCount: number
    llm_calls: number; total_tokens: number; total_cost_usd: number; governance_denied: number
  }
  nodes: InsightNode[]
  documents: Array<{ id: string; name: string; kind: string; mimeType: string | null; sizeBytes: number | null; nodeId: string | null; taskId: string | null; uploadedAt: string }>
  consumables: Array<{ id: string; name: string; status: string; currentVersion: number; nodeId: string | null; updatedAt: string }>
  costByModel: Array<{ provider: string; model: string; calls: number; total_tokens: number; cost_usd: number }>
  events: InsightEvent[]
}
interface BudgetEvent {
  id: string
  eventType: string
  nodeId: string | null
  agentRunId: string | null
  cfCallId: string | null
  promptAssemblyId: string | null
  inputTokensDelta: number
  outputTokensDelta: number
  totalTokensDelta: number
  estimatedCostDelta: number | null
  pricingStatus: string
  createdAt: string
}
interface BudgetResponse {
  id: string
  status: string
  pricingStatus: string
  maxInputTokens: number | null
  maxOutputTokens: number | null
  maxTotalTokens: number | null
  maxEstimatedCost: number | null
  consumedInputTokens: number
  consumedOutputTokens: number
  consumedTotalTokens: number
  consumedEstimatedCost: number
  warnAtPercent: number
  enforcementMode: string
  remaining: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
    estimatedCost: number | null
  }
  percentUsed: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
    estimatedCost: number | null
  }
  warnings: string[]
  events: BudgetEvent[]
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  const r = Math.round(s - m * 60)
  if (m < 60) return `${m}m ${r}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m - h * 60}m`
}

function fmtBytes(n: number | null): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

const STATUS_COLOR: Record<string, string> = {
  PENDING:   '#94a3b8',
  ACTIVE:    '#0ea5e9',
  RUNNING:   '#0ea5e9',
  COMPLETED: '#16a34a',
  SKIPPED:   '#a3a3a3',
  FAILED:    '#dc2626',
  BLOCKED:   '#f59e0b',
}

export function RunInsightsPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['insights', id],
    enabled:  Boolean(id),
    queryFn:  async () => (await api.get(`/workflow-instances/${id}/insights`)).data as InsightsResponse,
    refetchInterval: 5000,
  })
  const { data: budget } = useQuery({
    queryKey: ['workflow-budget', id],
    enabled: Boolean(id),
    queryFn: async () => (await api.get(`/workflow-instances/${id}/budget`)).data as BudgetResponse,
    refetchInterval: 5000,
  })

  // Map durations to Gantt bar widths
  const maxStep = useMemo(() => {
    const durations = (data?.nodes ?? []).map(n => n.durationMs ?? 0)
    return Math.max(1, ...durations)
  }, [data])

  if (isLoading) return <div style={{ padding: 24, fontSize: 12, color: '#64748b' }}>Loading run insights…</div>
  if (isError)   return <div style={{ padding: 24, fontSize: 12, color: '#dc2626' }}>Failed to load: {(error as Error).message}</div>
  if (!data)     return <div style={{ padding: 24, fontSize: 12, color: '#64748b' }}>No data</div>

  return (
    <div style={{ padding: 18, maxWidth: 1200, margin: '0 auto' }}>
      <button
        onClick={() => navigate(-1)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 11, color: '#64748b', background: 'transparent', border: 'none',
          cursor: 'pointer', marginBottom: 12,
        }}
      ><ArrowLeft size={12} /> Back</button>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 14,
        padding: '14px 16px', borderRadius: 12, marginBottom: 18,
        background: '#fff', border: '1px solid var(--color-outline-variant)',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 16, fontWeight: 800, color: 'var(--color-on-surface)', margin: 0 }}>
            {data.run.name}
          </h1>
          <p style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 4 }}>
            {data.run.status} ·{' '}
            Started {data.run.startedAt ? new Date(data.run.startedAt).toLocaleString() : '—'} ·{' '}
            {data.run.completedAt
              ? `Completed ${new Date(data.run.completedAt).toLocaleString()}`
              : 'In progress'}
          </p>
        </div>
        <button
          onClick={() => navigate(`/runs/${data.run.id}`)}
          style={{
            fontSize: 10, fontWeight: 700, padding: '4px 10px', borderRadius: 6,
            background: '#f1f5f9', color: '#475569', border: '1px solid #cbd5e1',
            cursor: 'pointer', letterSpacing: '0.05em', textTransform: 'uppercase',
          }}
        >Timeline view</button>
      </div>

      {/* Summary tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 20 }}>
        <Tile icon={Clock}         label="Total duration"  value={fmtDuration(data.run.durationMs)} />
        <Tile icon={Activity}      label="Steps"           value={`${data.totals.nodes}`} sub={`${data.totals.nodesByStatus.COMPLETED ?? 0} done · ${data.totals.nodesByStatus.FAILED ?? 0} failed`} />
        <Tile icon={GitBranch}     label="LLM calls"       value={`${data.totals.llm_calls}`} sub={`${data.totals.total_tokens.toLocaleString()} tokens`} />
        <Tile icon={Coins}         label="Total cost"      value={`$${data.totals.total_cost_usd.toFixed(4)}`} />
        {budget && (
          <Tile
            icon={Coins}
            label="Run budget"
            value={budget.percentUsed.totalTokens == null ? 'Active' : `${budget.percentUsed.totalTokens.toFixed(1)}%`}
            sub={`${budget.consumedTotalTokens.toLocaleString()} / ${budget.maxTotalTokens?.toLocaleString() ?? '∞'} tokens`}
            highlight={budget.status === 'EXHAUSTED' || budget.status === 'EXCEEDED' ? 'red' : budget.status === 'WARNED' || budget.pricingStatus === 'UNPRICED' ? 'amber' : undefined}
          />
        )}
        <Tile icon={FileText}      label="Documents"       value={`${data.totals.documentsCount}`} />
        <Tile icon={Box}           label="Consumables"     value={`${data.totals.consumablesCount}`} />
        <Tile icon={ShieldCheck}   label="Denials"         value={`${data.totals.governance_denied}`} highlight={data.totals.governance_denied > 0 ? 'red' : undefined} />
      </div>

      {budget && (
        <Section title="Workflow run budget">
          {budget.warnings.length > 0 && (
            <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
              {budget.warnings.map(w => (
                <div key={w} style={{ fontSize: 11, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '6px 8px' }}>
                  {w}
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginBottom: 12 }}>
            <BudgetBar label="Input tokens" used={budget.consumedInputTokens} max={budget.maxInputTokens} pct={budget.percentUsed.inputTokens} />
            <BudgetBar label="Output tokens" used={budget.consumedOutputTokens} max={budget.maxOutputTokens} pct={budget.percentUsed.outputTokens} />
            <BudgetBar label="Total tokens" used={budget.consumedTotalTokens} max={budget.maxTotalTokens} pct={budget.percentUsed.totalTokens} />
            <BudgetBar label="Estimated cost" used={budget.consumedEstimatedCost} max={budget.maxEstimatedCost} pct={budget.percentUsed.estimatedCost} money />
          </div>
          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#64748b' }}>
                <th style={th()}>Event</th>
                <th style={th()}>Node</th>
                <th style={th(true)}>Input</th>
                <th style={th(true)}>Output</th>
                <th style={th(true)}>Total</th>
                <th style={th(true)}>Cost</th>
                <th style={th()}>When</th>
              </tr>
            </thead>
            <tbody>
              {budget.events.slice(0, 30).map(e => (
                <tr key={e.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={td()}><code>{e.eventType}</code>{e.pricingStatus === 'UNPRICED' ? <span style={{ color: '#b45309', marginLeft: 6 }}>unpriced</span> : null}</td>
                  <td style={td()}>{e.nodeId ?? '—'}</td>
                  <td style={td(true)}>{e.inputTokensDelta ? e.inputTokensDelta.toLocaleString() : '—'}</td>
                  <td style={td(true)}>{e.outputTokensDelta ? e.outputTokensDelta.toLocaleString() : '—'}</td>
                  <td style={td(true)}>{e.totalTokensDelta ? e.totalTokensDelta.toLocaleString() : '—'}</td>
                  <td style={td(true)}>{e.estimatedCostDelta == null ? '—' : `$${e.estimatedCostDelta.toFixed(4)}`}</td>
                  <td style={td()}>{new Date(e.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {id && <LiveEventsPanel runId={id} />}

      {/* Gantt per step */}
      <Section title={`Steps (${data.nodes.length})`}>
        {data.nodes.length === 0 ? (
          <p style={{ fontSize: 11, color: '#94a3b8' }}>No steps recorded yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.nodes.map(n => {
              const widthPct = n.durationMs ? Math.max(2, (n.durationMs / maxStep) * 100) : (n.status === 'ACTIVE' ? 4 : 1)
              const color = STATUS_COLOR[n.status] ?? '#64748b'
              return (
                <div key={n.id} style={{ display: 'grid', gap: 6, fontSize: 11 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 220, minWidth: 220, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        width: 7, height: 7, borderRadius: 4, background: color, flexShrink: 0,
                      }} />
                      <span style={{ fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {n.label}
                      </span>
                      <span style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'monospace' }}>
                        {n.nodeType}
                      </span>
                    </div>
                    <div style={{
                      flex: 1, height: 22, background: '#f1f5f9', borderRadius: 4, position: 'relative', overflow: 'hidden',
                    }}>
                      <div style={{
                        width: `${widthPct}%`, height: '100%',
                        background: color, opacity: n.status === 'COMPLETED' ? 0.9 : 0.6,
                      }} />
                      <div style={{
                        position: 'absolute', inset: 0,
                        display: 'flex', alignItems: 'center', padding: '0 8px',
                        fontSize: 10, color: '#0f172a',
                      }}>
                        {n.durationMs != null ? `${n.durationPrecise ? '' : '≈ '}${fmtDuration(n.durationMs)}` : n.status.toLowerCase()}
                        {(n.documents.length > 0 || n.consumables.length > 0 || n.workspace.length > 0 || n.eventCount > 0 || !!n.laptopDevice || n.citations.length > 0) && (
                          <span style={{ marginLeft: 'auto', fontSize: 9, color: '#475569', display: 'flex', gap: 8 }}>
                            {n.documents.length > 0  && <span>docs {n.documents.length}</span>}
                            {n.consumables.length > 0 && <span>artifacts {n.consumables.length}</span>}
                            {n.workspace.length > 0 && <span>branch {n.workspace[0].branch ?? 'workspace'}</span>}
                            {n.citations.length > 0 && <span>cites {n.citations.length}</span>}
                            {n.eventCount > 0        && <span>events {n.eventCount}</span>}
                            {n.laptopDevice && (
                              <span title={`Served by ${n.laptopDevice.device_name ?? 'laptop'} (device ${n.laptopDevice.device_id.slice(0, 8)}, user ${n.laptopDevice.user_id.slice(0, 8)})`} style={{ color: '#0369a1', fontWeight: 600 }}>
                                laptop {n.laptopDevice.device_name ?? ''}
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ width: 80, minWidth: 80, fontSize: 10, color: '#64748b', textAlign: 'right' }}>
                      {n.status}
                    </div>
                  </div>
                  {n.citations.length > 0 && (
                    <details style={{ marginLeft: 230, border: '1px solid #e2e8f0', borderRadius: 6, padding: '6px 8px', background: '#f8fafc' }}>
                      <summary style={{ cursor: 'pointer', color: '#334155', fontWeight: 700, fontSize: 10 }}>Citations</summary>
                      <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                        {n.citations.map((c) => (
                          <div key={`${n.id}-${c.citationKey}-${c.sourceId}`} style={{ fontSize: 10, color: '#475569' }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                              <code style={{ color: '#0f172a' }}>{c.citationKey || c.sourceId}</code>
                              <span>{c.sourceKind}</span>
                              {c.confidence != null && <span>{Math.round(c.confidence * 100)}%</span>}
                            </div>
                            {c.excerpt && <div style={{ marginTop: 2, color: '#64748b' }}>{c.excerpt}</div>}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )
            })}
            <p style={{ fontSize: 9, color: '#94a3b8', marginTop: 6 }}>
              Durations without "≈" are precise (M24.5: runtime-stamped <code>startedAt</code>/<code>completedAt</code>). The "≈" prefix means the value falls back to <code>createdAt → updatedAt</code> on older runs that pre-date the timing columns.
            </p>
          </div>
        )}
      </Section>

      {data.nodes.some(n => n.workspace.length > 0) && (
        <Section title="Workspace branches">
          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#64748b' }}>
                <th style={th()}>Step</th>
                <th style={th()}>Branch</th>
                <th style={th()}>Commit</th>
                <th style={th(true)}>AST files</th>
                <th style={th(true)}>AST symbols</th>
                <th style={th()}>Changed paths</th>
              </tr>
            </thead>
            <tbody>
              {data.nodes.flatMap(n => n.workspace.map((w, idx) => (
                <tr key={`${n.id}-${idx}`} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={td()}>{n.label}</td>
                  <td style={td()}><code>{w.branch ?? '—'}</code></td>
                  <td style={td()}>{w.commitSha ? <code>{w.commitSha.slice(0, 10)}</code> : '—'}</td>
                  <td style={td(true)}>{w.astIndexedFiles ?? '—'}</td>
                  <td style={td(true)}>{w.astIndexedSymbols ?? '—'}</td>
                  <td style={td()}>{w.changedPaths.length > 0 ? w.changedPaths.slice(0, 4).join(', ') : '—'}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </Section>
      )}

      {/* Artifacts panel */}
      {(data.documents.length > 0 || data.consumables.length > 0) && (
        <Section title="Artifacts produced">
          {data.documents.length > 0 && (
            <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse', marginBottom: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#64748b' }}>
                  <th style={th()}>Document</th>
                  <th style={th()}>Kind</th>
                  <th style={th()}>Mime</th>
                  <th style={th()}>Size</th>
                  <th style={th()}>When</th>
                </tr>
              </thead>
              <tbody>
                {data.documents.map(d => (
                  <tr key={d.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td()}>{d.name}</td>
                    <td style={td()}>{d.kind}</td>
                    <td style={td()}>{d.mimeType ?? '—'}</td>
                    <td style={td()}>{fmtBytes(d.sizeBytes)}</td>
                    <td style={td()}>{new Date(d.uploadedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.consumables.length > 0 && (
            <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#64748b' }}>
                  <th style={th()}>Consumable</th>
                  <th style={th()}>Status</th>
                  <th style={th()}>Version</th>
                  <th style={th()}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {data.consumables.map(c => (
                  <tr key={c.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td()}>{c.name}</td>
                    <td style={td()}>{c.status}</td>
                    <td style={td()}>v{c.currentVersion}</td>
                    <td style={td()}>{new Date(c.updatedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}

      {/* Cost by model */}
      {data.costByModel.length > 0 && (
        <Section title="Cost by model">
          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#64748b' }}>
                <th style={th()}>Provider</th>
                <th style={th()}>Model</th>
                <th style={th(true)}>Calls</th>
                <th style={th(true)}>Tokens</th>
                <th style={th(true)}>Cost (USD)</th>
              </tr>
            </thead>
            <tbody>
              {data.costByModel.map((m, i) => (
                <tr key={`${m.provider}-${m.model}-${i}`} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={td()}>{m.provider}</td>
                  <td style={td()}>{m.model}</td>
                  <td style={td(true)}>{m.calls.toLocaleString()}</td>
                  <td style={td(true)}>{m.total_tokens.toLocaleString()}</td>
                  <td style={td(true)}>${m.cost_usd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* Event timeline */}
      <Section title={`Audit timeline (${data.events.length})`}>
        {data.events.length === 0 ? (
          <p style={{ fontSize: 11, color: '#94a3b8' }}>No audit-governance events recorded for this run.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {data.events.map(e => (
              <div key={e.id} style={{
                fontSize: 11, padding: '6px 10px', borderRadius: 4,
                background: e.severity === 'error' ? '#fef2f2' : e.severity === 'warn' ? '#fffbeb' : '#f8fafc',
                border: '1px solid ' + (e.severity === 'error' ? '#fecaca' : e.severity === 'warn' ? '#fde68a' : '#e2e8f0'),
                display: 'flex', gap: 10, alignItems: 'center',
              }}>
                <span style={{
                  fontSize: 9, padding: '1px 5px', borderRadius: 3,
                  background: '#e2e8f0', color: '#475569', fontFamily: 'monospace',
                  minWidth: 90, textAlign: 'center',
                }}>{e.source_service}</span>
                <code style={{ fontSize: 11, color: '#0f172a', minWidth: 200 }}>{e.kind}</code>
                <span style={{ fontSize: 10, color: '#64748b' }}>
                  {new Date(e.created_at).toLocaleString()}
                </span>
                {e.severity !== 'info' && (
                  <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700,
                    color: e.severity === 'error' ? '#dc2626' : '#b45309',
                    textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {e.severity === 'error' ? <AlertTriangle size={10} style={{ display: 'inline', marginRight: 3 }} /> : null}
                    {e.severity}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

// ── helpers ────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{
      marginBottom: 20, padding: 14, borderRadius: 10,
      background: '#fff', border: '1px solid var(--color-outline-variant)',
    }}>
      <h2 style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', margin: '0 0 10px 0', letterSpacing: '0.02em' }}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Tile({
  icon: Icon, label, value, sub, highlight,
}: { icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>; label: string; value: string; sub?: string; highlight?: 'red' | 'amber' }) {
  const colours = highlight === 'red'
    ? { bg: '#fef2f2', border: '#fecaca', fg: '#b91c1c' }
    : highlight === 'amber'
      ? { bg: '#fffbeb', border: '#fde68a', fg: '#b45309' }
      : { bg: '#fff', border: 'var(--color-outline-variant)', fg: '#0f172a' }
  return (
    <div style={{
      padding: 12, borderRadius: 8, background: colours.bg, border: `1px solid ${colours.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
        <Icon size={11} /> {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, color: colours.fg }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function BudgetBar({
  label, used, max, pct, money,
}: { label: string; used: number; max: number | null; pct: number | null; money?: boolean }) {
  const width = pct == null ? 0 : Math.max(1, Math.min(100, pct))
  const danger = pct != null && pct >= 100
  const warn = pct != null && pct >= 80
  const fmt = (n: number | null) => {
    if (n == null) return '∞'
    if (money) return `$${n.toFixed(4)}`
    return n.toLocaleString()
  }
  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, background: '#f8fafc' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 10, color: '#64748b', marginBottom: 6 }}>
        <strong style={{ color: '#334155' }}>{label}</strong>
        <span>{fmt(used)} / {fmt(max)}</span>
      </div>
      <div style={{ height: 7, borderRadius: 999, background: '#e2e8f0', overflow: 'hidden' }}>
        <div style={{
          width: `${width}%`, height: '100%',
          background: danger ? '#dc2626' : warn ? '#f59e0b' : '#16a34a',
        }} />
      </div>
      <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 4 }}>{pct == null ? 'No limit' : `${pct.toFixed(1)}% used`}</div>
    </div>
  )
}

function th(right = false): React.CSSProperties {
  return {
    fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
    padding: '6px 8px', textAlign: right ? 'right' : 'left',
  }
}
function td(right = false): React.CSSProperties {
  return { padding: '6px 8px', color: '#0f172a', textAlign: right ? 'right' : 'left' }
}
