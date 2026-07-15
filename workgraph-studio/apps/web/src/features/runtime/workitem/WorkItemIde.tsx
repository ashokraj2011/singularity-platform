import { useState, type ReactNode, type CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LayoutDashboard, Lightbulb, Compass, FileText, PenTool, GitPullRequest, CheckCircle2, MessageSquare, Zap, GitBranch, ClipboardList, FlaskConical, Users } from 'lucide-react'
import { api } from '../../../lib/api'
import { type IdeTheme } from './ideTheme'
import { IdeShell, IdeActBtn, IdeStatusSeg, type IdeShellView } from './IdeShell'
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
 *
 * When the item belongs to a Specification Project, a scope switch in the top bar flips the same IDE
 * between "This item" (the frozen, item-level spec) and "Project baseline" (the shared upstream) —
 * folding the old /studio project surfaces in as views so there is a single place to work. The
 * project surfaces are Next-app components, so they are injected via renderProjectSurface rather than
 * imported directly (workgraph-web cannot import the platform-web app).
 */

type ItemView = 'overview' | 'analysis' | 'discovery' | 'specification' | 'design' | 'submissions' | 'reconciliation' | 'discussion'
// The upstream SDLC lifecycle, left to right: analyse → specify → design → hand off → verify.
// Discovery is the unified unknowns-resolution surface (elicitation via LLM gateway / Copilot);
// it rides beside Analysis, upstream of Requirements. Discussion is cross-cutting collaboration —
// it rides at the end of the rail, above the tools group.
const VIEWS: IdeShellView<ItemView>[] = [
  { key: 'overview', label: 'Overview', Icon: LayoutDashboard },
  { key: 'analysis', label: 'Analysis', Icon: Lightbulb },
  { key: 'discovery', label: 'Discovery', Icon: Compass },
  { key: 'specification', label: 'Requirements', Icon: FileText },
  { key: 'design', label: 'Design', Icon: PenTool },
  { key: 'submissions', label: 'Submissions', Icon: GitPullRequest },
  { key: 'reconciliation', label: 'Reconciliation', Icon: CheckCircle2 },
  { key: 'discussion', label: 'Discussion', Icon: MessageSquare },
]

// Project-baseline views mirror the old /studio project surfaces, now injected into this IDE.
export type ProjectSurfaceKey = 'analysis' | 'requirements' | 'design' | 'reconciliation' | 'rooms' | 'coedit'
const PROJECT_VIEWS: IdeShellView<ProjectSurfaceKey>[] = [
  { key: 'analysis', label: 'Analysis', Icon: Lightbulb },
  { key: 'requirements', label: 'Requirements', Icon: ClipboardList },
  { key: 'design', label: 'Design', Icon: PenTool },
  { key: 'reconciliation', label: 'Reconciliation', Icon: CheckCircle2 },
  { key: 'rooms', label: 'Rooms', Icon: FlaskConical },
  { key: 'coedit', label: 'Co-edit', Icon: Users },
]

/** Injected by the host app (platform-web) to render a project-baseline surface inside the IDE. */
export type ProjectSurfaceRenderer = (args: { projectId: string; surface: ProjectSurfaceKey; theme: IdeTheme }) => ReactNode

interface WI { workCode?: string; title?: string; status: string; events?: any[]; targets?: any[]; urgency?: string | null; dueAt?: string | null; project?: { id: string; code: string; name: string; status?: string } | null }

export function WorkItemIde({ workItemId, workItem, onBack, overviewDetails, renderProjectSurface }: { workItemId: string; workItem: WI; onBack: () => void; overviewDetails?: ReactNode; renderProjectSurface?: ProjectSurfaceRenderer }) {
  const [itemView, setItemView] = useState<ItemView>('overview')
  const [projectView, setProjectView] = useState<ProjectSurfaceKey>('analysis')
  const [scope, setScope] = useState<'item' | 'project'>('item')
  const [agentOpen, setAgentOpen] = useState(true)
  const [theme, setTheme] = useState<IdeTheme>('dark')
  const [focusRunId, setFocusRunId] = useState<string | null>(null)

  const project = workItem.project
  const canProject = Boolean(project && renderProjectSurface)
  const inProject = scope === 'project' && canProject

  const specQ = useQuery<any>({ queryKey: ['spec-versions', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/specifications`).then((r) => r.data) })
  const reconQ = useQuery<any>({ queryKey: ['reconciliations', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/reconciliations`).then((r) => r.data) })
  const active = (specQ.data?.items ?? []).find((v: any) => v.id === specQ.data?.activeVersionId)
  const specLabel = active ? `spec v${active.version} · Approved` : (specQ.data?.items ?? []).length ? `spec · ${(specQ.data.items).length} draft` : 'no spec'
  const latestRun = (reconQ.data?.items ?? [])[0]

  const views: IdeShellView<string>[] = inProject ? PROJECT_VIEWS : VIEWS
  const currentView: string = inProject ? projectView : itemView
  const currentLabel = views.find((v) => v.key === currentView)?.label

  const scopeSwitch = canProject && project ? (
    <div style={{ display: 'flex', alignItems: 'center', border: '1px solid var(--ide-line)', borderRadius: 8, overflow: 'hidden' }}>
      <button onClick={() => setScope('item')} style={scopeBtn(scope === 'item')}>This item</button>
      <button onClick={() => setScope('project')} title={`Shared baseline · ${project.code}`} style={scopeBtn(scope === 'project')}>Project baseline</button>
    </div>
  ) : null

  const breadcrumb = inProject && project ? (
    <>
      <span style={{ fontFamily: 'var(--mono, ui-monospace)', fontSize: 11.5, color: 'var(--ide-accent)', fontWeight: 600 }}>{project.code}</span>
      <span style={{ fontSize: 13.5, fontWeight: 700, letterSpacing: '-.01em', color: 'var(--ide-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{project.name}</span>
      <span style={{ fontSize: 11, color: 'var(--ide-muted)' }}>›</span>
      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'var(--ide-accent-soft)', color: 'var(--ide-accent)' }}>baseline</span>
      <span style={{ fontSize: 11, color: 'var(--ide-muted)' }}>›</span>
      <span style={{ fontSize: 12.5, color: 'var(--ide-ink-dim)', fontWeight: 600 }}>{currentLabel}</span>
    </>
  ) : (
    <>
      {project && (
        <>
          <button onClick={() => setScope('project')} title={`Specification project ${project.name}`} style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, fontSize: 11.5, fontWeight: 700, color: 'var(--ide-ink-dim)', whiteSpace: 'nowrap' }}>{project.code}</button>
          <span style={{ fontSize: 11, color: 'var(--ide-muted)' }}>›</span>
        </>
      )}
      <span style={{ fontFamily: 'var(--mono, ui-monospace)', fontSize: 11.5, color: 'var(--ide-accent)', fontWeight: 600 }}>{workItem.workCode}</span>
      <span style={{ fontSize: 13.5, fontWeight: 700, letterSpacing: '-.01em', color: 'var(--ide-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{workItem.title}</span>
      <span style={{ fontSize: 11, color: 'var(--ide-muted)' }}>›</span>
      <span style={{ fontSize: 12.5, color: 'var(--ide-ink-dim)', fontWeight: 600 }}>{currentLabel}</span>
    </>
  )

  return (
    <IdeShell<string>
      theme={theme}
      onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      views={views}
      view={currentView}
      onSelectView={(k) => (inProject ? setProjectView(k as ProjectSurfaceKey) : setItemView(k as ItemView))}
      onBack={onBack}
      backLabel="Back to inbox"
      bottomButtons={!inProject ? <IdeActBtn label="Agent Storm" active={agentOpen} onClick={() => setAgentOpen((o) => !o)}><Zap size={20} /></IdeActBtn> : undefined}
      breadcrumb={breadcrumb}
      statusBadge={inProject ? (project?.status === 'ARCHIVED' ? 'ARCHIVED' : 'PROJECT') : workItem.status}
      topBarExtra={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {scopeSwitch}
          {!inProject && !agentOpen && (
            <button onClick={() => setAgentOpen(true)} title="Agent Storm" style={{ border: '1px solid var(--ide-line)', background: 'transparent', color: 'var(--ide-accent)', width: 30, height: 30, borderRadius: 8, cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Zap size={15} /></button>
          )}
        </div>
      }
      rightPanel={!inProject && agentOpen && <AgentStormPanel workItemId={workItemId} view={itemView} onClose={() => setAgentOpen(false)} />}
      statusItems={inProject && project ? (
        <>
          <IdeStatusSeg><GitBranch size={12} /> {project.code}</IdeStatusSeg>
          <IdeStatusSeg>shared baseline</IdeStatusSeg>
        </>
      ) : (
        <>
          <IdeStatusSeg><GitBranch size={12} /> wi/{workItem.workCode}</IdeStatusSeg>
          <IdeStatusSeg>{specLabel}</IdeStatusSeg>
          {latestRun && <IdeStatusSeg>recon {latestRun.status} · {(latestRun.summary?.pass ?? 0)}✓ {(latestRun.summary?.partial ?? 0)}~ {(latestRun.summary?.fail ?? 0)}✕</IdeStatusSeg>}
        </>
      )}
      statusRight={inProject ? <IdeStatusSeg>inherited by this item</IdeStatusSeg> : <IdeStatusSeg>{(workItem.targets ?? []).length} target(s)</IdeStatusSeg>}
    >
      {inProject && project ? (
        renderProjectSurface!({ projectId: project.id, surface: projectView, theme })
      ) : (
        <>
          {itemView === 'overview' && (<>
            <OverviewDashboard workItemId={workItemId} workItem={workItem} onOpenTab={(t) => setItemView(t)} />
            {overviewDetails && (
              <details style={{ marginTop: 10, border: '1px solid var(--ide-line)', borderRadius: 12, background: 'var(--ide-chrome)' }}>
                <summary style={{ cursor: 'pointer', listStyle: 'none', padding: '12px 16px', fontSize: 12.5, fontWeight: 700, color: 'var(--ide-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 10 }}>▸</span> Work item details &amp; routing <span style={{ fontWeight: 500, color: 'var(--ide-faint)' }}>— routing, targets, clarifications, timeline</span>
                </summary>
                <div style={{ padding: '0 16px 8px' }}>{overviewDetails}</div>
              </details>
            )}
          </>)}
          {itemView === 'analysis' && <AnalysisSurface workItemId={workItemId} />}
          {itemView === 'discovery' && <DiscoveryPanel scopeType="WORK_ITEM" scopeId={workItemId} title="Discovery — resolve this work item's unknowns" />}
          {itemView === 'specification' && <SpecExplorerEditor workItemId={workItemId} />}
          {itemView === 'design' && <DesignSurface workItemId={workItemId} />}
          {itemView === 'submissions' && <SubmissionsStudio workItemId={workItemId} onGotoReconciliation={(runId) => { setFocusRunId(runId); setItemView('reconciliation') }} />}
          {itemView === 'reconciliation' && <ReconciliationStudio workItemId={workItemId} focusRunId={focusRunId} />}
          {itemView === 'discussion' && <CommentsPanel workItemId={workItemId} />}
        </>
      )}
    </IdeShell>
  )
}

function scopeBtn(active: boolean): CSSProperties {
  return {
    border: 'none', cursor: 'pointer', font: 'inherit', fontSize: 11.5, fontWeight: 700, padding: '5px 11px',
    background: active ? 'var(--ide-accent)' : 'transparent',
    color: active ? 'var(--ide-accent-ink)' : 'var(--ide-muted)',
  }
}
