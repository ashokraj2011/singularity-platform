// M100 P3.3 — persistent platform-readiness header strip.
//
// Surfaces a curated set of the existing `/ops-health/*` checks (the same
// same-origin probes the OperationsPage uses) as always-visible status dots, so
// an operator sees platform health from any portal page without opening
// Operations. Polls every 15s; never throws (a down probe just shows red).
import { useQueries } from '@tanstack/react-query'

type Probe = { id: string; label: string; endpoint: string }

// Six readiness signals, mapped to the live /ops-health endpoints the portal
// nginx already proxies. (audit-gov has no ops-health probe; the budget gate is
// a policy state — both live on the Operations page, not here.)
const PROBES: Probe[] = [
  { id: 'iam',             label: 'IAM',        endpoint: '/ops-health/iam' },
  { id: 'workgraph-api',   label: 'Workflow',   endpoint: '/ops-health/workgraph-api' },
  { id: 'context-api',     label: 'Context',    endpoint: '/ops-health/context-api' },
  { id: 'llm-gateway',     label: 'Gateway',    endpoint: '/ops-health/llm-gateway' },
  { id: 'mcp-server',      label: 'MCP',        endpoint: '/ops-health/mcp-server' },
  { id: 'prompt-composer', label: 'Composer',   endpoint: '/ops-health/prompt-composer' },
]

export function ReadinessStrip() {
  const queries = useQueries({
    queries: PROBES.map((p) => ({
      queryKey: ['readiness', p.id],
      queryFn: async () => {
        const res = await fetch(p.endpoint, { headers: { accept: 'application/json' } })
        if (res.ok) return true
        // Bridge mode: the laptop mcp serves no HTTP — a device registered on
        // the laptop bridge counts as MCP online.
        if (p.id === 'mcp-server') {
          const b = await fetch('/api/cf/api/laptop-bridge/status', { headers: { accept: 'application/json' } }).catch(() => null)
          if (b?.ok) {
            const j = await b.json().catch(() => null) as { count?: number } | null
            if ((j?.count ?? 0) > 0) return true
          }
        }
        throw new Error(String(res.status))
      },
      refetchInterval: 15000,
      staleTime: 10000,
      retry: false,
    })),
  })

  return (
    <div
      className="flex items-center gap-4 overflow-x-auto px-8 py-2 text-[11px]"
      style={{
        borderBottom: '1px solid rgba(8,40,33,0.08)',
        background: 'rgba(245,242,234,0.6)',
        color: 'var(--brand-forest, #082821)',
      }}
      aria-label="Platform readiness"
    >
      <span className="font-semibold uppercase tracking-widest opacity-50">Readiness</span>
      {PROBES.map((p, i) => {
        const q = queries[i]
        const tone = q.isSuccess ? 'ok' : q.isLoading ? 'pending' : 'down'
        const color = tone === 'ok' ? '#16a34a' : tone === 'pending' ? '#a3a3a3' : '#dc2626'
        return (
          <span key={p.id} className="inline-flex shrink-0 items-center gap-1.5" title={`${p.label}: ${tone}`}>
            <span style={{ width: 8, height: 8, borderRadius: 9999, background: color, display: 'inline-block' }} />
            {p.label}
          </span>
        )
      })}
    </div>
  )
}
