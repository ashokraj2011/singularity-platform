import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LayoutDashboard, Lightbulb, Compass, FileText, PenTool, GitPullRequest, CheckCircle2, MessageSquare, Zap, GitBranch } from 'lucide-react'
import { api } from '../../../lib/api'
import { type IdeTheme } from './ideTheme'
import { IdeShell, IdeActBtn, IdeStatusSeg } from './IdeShell'
import { SpecExplorerEditor } from './SpecExplorerEditor'
import { AnalysisSurface } from './AnalysisSurface'
import { DesignSurface } from './DesignSurface'
import { SubmissionsStudio } from './SubmissionsStudio'
import { ReconciliationStudio } from './ReconciliationStudio'
import { OverviewDashboard } from './OverviewDashboard'
import { AgentStormPanel } from './AgentStormPanel'
import { CommentsPanel } from './CommentsPanel'
import { DiscoveryPanel } from '../../discovery/DiscoveryPanel'

/**
 * Work Item IDE — the whole workspace as an IDE (VS Code register). An activity bar switches views,
 * the editor area renders the existing studios (re-skinned to the ELM palette via ideTokens), a
 * status bar shows the spec/reconciliation state, and Agent Storm rides in a collapsible panel. The
 * complex Overview detail sections are passed in from WorkDetailPage (which owns their mutations).
 */

type View = 'overview' | 'analysis' | 'discovery' | 'specification' | 'design' | 'submissions' | 'reconciliation' | 'discussion'
// The upstream SDLC lifecycle, left to right: analyse → specify → design → hand off → verify.
// Discovery is the unified unknowns-resolution surface (elicitation via LLM gateway / Copilot);
// it rides beside Analysis, upstream of Requirements. Discussion is cross-cutting collaboration —
// it rides at the end of the rail, above the tools group.
const VIEWS: { key: View; label: string; Icon: typeof FileText }[] = [
  { key: 'overview', label: 'Overview', Icon: LayoutDashboard },
  { key: 'analysis', label: 'Analysis', Icon: Lightbulb },
  { key: 'discovery', label: 'Discovery', Icon: Compass },
  { key: 'specification', label: 'Requirements', Icon: FileText },
  { key: 'design', label: 'Design', Icon: PenTool },
  { key: 'submissions', label: 'Submissions', Icon: GitPullRequest },
  { key: 'reconciliation', label: 'Reconciliation', Icon: CheckCircle2 },
  { key: 'discussion', label: 'Discussion', Icon: MessageSquare },
]

interface WI { workCode?: string; title?: string; status: string; events?: any[]; targets?: any[]; urgency?: string | null; dueAt?: string | null; project?: { id: string; code: string; name: string; status?: string } | null }

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

  const breadcrumb = (
    <>
      {workItem.project && (
        <>
          <a href={`/studio/${workItem.project.id}`} title={`Specification project ${workItem.project.name}`} style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ide-ink-dim)', textDecoration: 'none', whiteSpace: 'nowrap' }}>{workItem.project.code}</a>
          <span style={{ fontSize: 11, color: 'var(--ide-muted)' }}>›</span>
        </>
      )}
      <span style={{ fontFamily: 'var(--mono, ui-monospace)', fontSize: 11.5, color: 'var(--ide-accent)', fontWeight: 600 }}>{workItem.workCode}</span>
      <span style={{ fontSize: 13.5, fontWeight: 700, letterSpacing: '-.01em', color: 'var(--ide-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{workItem.title}</span>
      <span style={{ fontSize: 11, color: 'var(--ide-muted)' }}>›</span>
      <span style={{ fontSize: 12.5, color: 'var(--ide-ink-dim)', fontWeight: 600 }}>{VIEWS.find((v) => v.key === view)?.label}</span>
    </>
  )

  return (
    <IdeShell
      theme={theme}
      onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      views={VIEWS}
      view={view}
      onSelectView={setView}
      onBack={onBack}
      backLabel="Back to inbox"
      bottomButtons={<IdeActBtn label="Agent Storm" active={agentOpen} onClick={() => setAgentOpen((o) => !o)}><Zap size={20} /></IdeActBtn>}
      breadcrumb={breadcrumb}
      statusBadge={workItem.status}
      topBarExtra={!agentOpen && <button onClick={() => setAgentOpen(true)} title="Agent Storm" style={{ border: '1px solid var(--ide-line)', background: 'transparent', color: 'var(--ide-accent)', width: 30, height: 30, borderRadius: 8, cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Zap size={15} /></button>}
      rightPanel={agentOpen && <AgentStormPanel workItemId={workItemId} view={view} onClose={() => setAgentOpen(false)} />}
      statusItems={<>
        <IdeStatusSeg><GitBranch size={12} /> wi/{workItem.workCode}</IdeStatusSeg>
        <IdeStatusSeg>{specLabel}</IdeStatusSeg>
        {latestRun && <IdeStatusSeg>recon {latestRun.status} · {(latestRun.summary?.pass ?? 0)}✓ {(latestRun.summary?.partial ?? 0)}~ {(latestRun.summary?.fail ?? 0)}✕</IdeStatusSeg>}
      </>}
      statusRight={<IdeStatusSeg>{(workItem.targets ?? []).length} target(s)</IdeStatusSeg>}
    >
      {view === 'overview' && (<>
        <OverviewDashboard workItemId={workItemId} workItem={workItem} onOpenTab={(t) => setView(t)} />
        {overviewDetails && (
          <details style={{ marginTop: 10, border: '1px solid var(--ide-line)', borderRadius: 12, background: 'var(--ide-chrome)' }}>
            <summary style={{ cursor: 'pointer', listStyle: 'none', padding: '12px 16px', fontSize: 12.5, fontWeight: 700, color: 'var(--ide-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 10 }}>▸</span> Work item details &amp; routing <span style={{ fontWeight: 500, color: 'var(--ide-faint)' }}>— routing, targets, clarifications, timeline</span>
            </summary>
            <div style={{ padding: '0 16px 8px' }}>{overviewDetails}</div>
          </details>
        )}
      </>)}
      {view === 'analysis' && <AnalysisSurface workItemId={workItemId} />}
      {view === 'discovery' && <DiscoveryPanel scopeType="WORK_ITEM" scopeId={workItemId} title="Discovery — resolve this work item's unknowns" />}
      {view === 'specification' && <SpecExplorerEditor workItemId={workItemId} />}
      {view === 'design' && <DesignSurface workItemId={workItemId} />}
      {view === 'submissions' && <SubmissionsStudio workItemId={workItemId} onGotoReconciliation={(runId) => { setFocusRunId(runId); setView('reconciliation') }} />}
      {view === 'reconciliation' && <ReconciliationStudio workItemId={workItemId} focusRunId={focusRunId} />}
      {view === 'discussion' && <CommentsPanel workItemId={workItemId} />}
    </IdeShell>
  )
}
