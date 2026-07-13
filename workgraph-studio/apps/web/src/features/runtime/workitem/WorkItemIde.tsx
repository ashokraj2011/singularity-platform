import { useState, type CSSProperties, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LayoutDashboard, FileText, GitPullRequest, CheckCircle2, Zap, Sun, Moon, ArrowLeft, GitBranch } from 'lucide-react'
import { api } from '../../../lib/api'
import { ideTokens, type IdeTheme } from './ideTheme'
import { SpecExplorerEditor } from './SpecExplorerEditor'
import { SubmissionsStudio } from './SubmissionsStudio'
import { ReconciliationStudio } from './ReconciliationStudio'
import { OverviewDashboard } from './OverviewDashboard'
import { AgentStormPanel } from './AgentStormPanel'

/**
 * Work Item IDE — the whole workspace as an IDE (VS Code register). An activity bar switches views,
 * the editor area renders the existing studios (re-skinned to the ELM palette via ideTokens), a
 * status bar shows the spec/reconciliation state, and Agent Storm rides in a collapsible panel. The
 * complex Overview detail sections are passed in from WorkDetailPage (which owns their mutations).
 */

type View = 'overview' | 'specification' | 'submissions' | 'reconciliation'
const VIEWS: { key: View; label: string; Icon: typeof FileText }[] = [
  { key: 'overview', label: 'Overview', Icon: LayoutDashboard },
  { key: 'specification', label: 'Specification', Icon: FileText },
  { key: 'submissions', label: 'Submissions', Icon: GitPullRequest },
  { key: 'reconciliation', label: 'Reconciliation', Icon: CheckCircle2 },
]

interface WI { workCode?: string; title?: string; status: string; events?: any[]; targets?: any[]; urgency?: string | null; dueAt?: string | null }

export function WorkItemIde({ workItemId, workItem, onBack, overviewDetails }: { workItemId: string; workItem: WI; onBack: () => void; overviewDetails?: ReactNode }) {
  const [view, setView] = useState<View>('overview')
  const [agentOpen, setAgentOpen] = useState(true)
  const [theme, setTheme] = useState<IdeTheme>('dark')
  const [focusRunId, setFocusRunId] = useState<string | null>(null)

  const specQ = useQuery<any>({ queryKey: ['spec-versions', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/specifications`).then((r) => r.data) })
  const reconQ = useQuery<any>({ queryKey: ['reconciliations', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/reconciliations`).then((r) => r.data) })
  const active = (specQ.data?.items ?? []).find((v: any) => v.id === specQ.data?.activeVersionId)
  const specLabel = active ? `spec v${active.version} · Approved` : (specQ.data?.items ?? []).length ? `spec · ${(specQ.data.items).length} draft` : 'no spec'
  const latestRun = (reconQ.data?.items ?? [])[0]

  const shell: CSSProperties = {
    ...(ideTokens(theme) as CSSProperties),
    background: 'var(--ide-bg)', color: 'var(--ide-ink)',
    display: 'grid', gridTemplateColumns: '54px 1fr', gridTemplateRows: 'minmax(0,1fr) 28px',
    height: 'calc(100dvh - 52px)', minHeight: 560,
    borderRadius: 12, overflow: 'hidden', border: '1px solid var(--ide-line)',
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  }

  return (
    <div style={shell}>
      {/* Activity bar */}
      <nav style={{ gridColumn: 1, gridRow: 1, background: 'var(--ide-activity)', borderRight: '1px solid var(--ide-line)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px 0', gap: 4 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(150deg, var(--ide-accent), var(--color-primary-dark))', display: 'grid', placeItems: 'center', color: 'var(--ide-accent-ink)', marginBottom: 8 }}>
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round"><path d="M4 5h16M4 12h10M4 19h16" /><circle cx="18" cy="12" r="2.3" fill="currentColor" stroke="none" /></svg>
        </div>
        {VIEWS.map(({ key, label, Icon }) => (
          <ActBtn key={key} label={label} active={view === key} onClick={() => setView(key)}><Icon size={20} /></ActBtn>
        ))}
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <ActBtn label="Agent Storm" active={agentOpen} onClick={() => setAgentOpen((o) => !o)}><Zap size={20} /></ActBtn>
          <ActBtn label="Toggle theme" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>{theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}</ActBtn>
          <ActBtn label="Back to inbox" onClick={onBack}><ArrowLeft size={19} /></ActBtn>
        </div>
      </nav>

      {/* Main */}
      <div style={{ gridColumn: 2, gridRow: 1, display: 'flex', minWidth: 0, minHeight: 0 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/* Top bar */}
          <header style={{ height: 46, flex: 'none', borderBottom: '1px solid var(--ide-line)', background: 'var(--ide-chrome)', display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px' }}>
            <span style={{ fontFamily: 'var(--mono, ui-monospace)', fontSize: 11.5, color: 'var(--ide-accent)', fontWeight: 600 }}>{workItem.workCode}</span>
            <span style={{ fontSize: 13.5, fontWeight: 700, letterSpacing: '-.01em', color: 'var(--ide-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{workItem.title}</span>
            <span style={{ fontSize: 11, color: 'var(--ide-muted)' }}>›</span>
            <span style={{ fontSize: 12.5, color: 'var(--ide-ink-dim)', fontWeight: 600 }}>{VIEWS.find((v) => v.key === view)?.label}</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999, background: 'var(--ide-accent-soft)', color: 'var(--ide-accent)' }}>{workItem.status}</span>
            {!agentOpen && <button onClick={() => setAgentOpen(true)} title="Agent Storm" style={{ border: '1px solid var(--ide-line)', background: 'transparent', color: 'var(--ide-accent)', width: 30, height: 30, borderRadius: 8, cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Zap size={15} /></button>}
          </header>

          {/* Editor content */}
          <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px 40px', background: 'var(--ide-editor)' }}>
            {view === 'overview' && (<>
              <OverviewDashboard workItemId={workItemId} workItem={workItem} onOpenTab={(t) => setView(t)} />
              {overviewDetails}
            </>)}
            {view === 'specification' && <SpecExplorerEditor workItemId={workItemId} />}
            {view === 'submissions' && <SubmissionsStudio workItemId={workItemId} onGotoReconciliation={(runId) => { setFocusRunId(runId); setView('reconciliation') }} />}
            {view === 'reconciliation' && <ReconciliationStudio workItemId={workItemId} focusRunId={focusRunId} />}
          </div>
        </div>

        {agentOpen && <AgentStormPanel workItemId={workItemId} view={view} onClose={() => setAgentOpen(false)} />}
      </div>

      {/* Status bar */}
      <footer style={{ gridColumn: '1 / -1', gridRow: 2, background: 'var(--ide-accent)', color: 'var(--ide-accent-ink)', display: 'flex', alignItems: 'center', fontFamily: 'var(--mono, ui-monospace)', fontSize: 11, fontWeight: 600 }}>
        <StatusSeg><GitBranch size={12} /> wi/{workItem.workCode}</StatusSeg>
        <StatusSeg>{specLabel}</StatusSeg>
        {latestRun && <StatusSeg>recon {latestRun.status} · {(latestRun.summary?.pass ?? 0)}✓ {(latestRun.summary?.partial ?? 0)}~ {(latestRun.summary?.fail ?? 0)}✕</StatusSeg>}
        <div style={{ marginLeft: 'auto', display: 'flex' }}>
          <StatusSeg>{(workItem.targets ?? []).length} target(s)</StatusSeg>
          <button onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} style={{ border: 'none', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', padding: '0 11px', height: '100%', display: 'flex', alignItems: 'center', gap: 6 }}>◐ {theme}</button>
        </div>
      </footer>
    </div>
  )
}

function ActBtn({ children, label, active, onClick }: { children: ReactNode; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} style={{
      width: 42, height: 42, borderRadius: 9, display: 'grid', placeItems: 'center', cursor: 'pointer', position: 'relative',
      border: 'none', background: active ? 'var(--ide-hover)' : 'transparent', color: active ? 'var(--ide-accent)' : 'var(--ide-muted)',
    }}>
      {active && <span style={{ position: 'absolute', left: -6, top: 9, bottom: 9, width: 2, borderRadius: 2, background: 'var(--ide-accent)' }} />}
      {children}
    </button>
  )
}
function StatusSeg({ children }: { children: ReactNode }) {
  return <span style={{ padding: '0 11px', height: '100%', display: 'flex', alignItems: 'center', gap: 6 }}>{children}</span>
}
