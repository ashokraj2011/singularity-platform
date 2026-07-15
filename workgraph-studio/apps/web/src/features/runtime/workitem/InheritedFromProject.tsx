import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { cardStyle, mutedText } from './workspaceStyles'

/**
 * Inheritance surface — a work item attached to a Specification Project draws on the project's
 * shared upstream baseline. This renders that baseline READ-ONLY, clearly labelled "Inherited from
 * project {code}", above the item's own (editable) spec section — so the mental model is explicit:
 * project = shared baseline, work item = local delta / override. Renders nothing for a standalone
 * (unattached) item, and nothing when the project hasn't authored that section yet.
 */

type Section = 'analysis' | 'requirements' | 'decisions'

interface Stakeholder { role?: string; name?: string; interest?: string }
interface ProjectAnalysis { problem?: string; goals?: string[]; stakeholders?: Stakeholder[]; assumptions?: string[]; constraints?: string[] }
interface ProjectRequirement { id?: string; statement?: string; priority?: string; acceptanceCriteria?: string[]; rationale?: string }
interface ProjectDecision { id?: string; title?: string; status?: string; context?: string; decision?: string; consequences?: string }
interface InheritedSpec {
  project: { id: string; code: string; name: string } | null
  spec: { revision: number; package: { analysis?: ProjectAnalysis; requirements?: ProjectRequirement[]; decisions?: ProjectDecision[] }; updatedAt: string } | null
}

const wrap: React.CSSProperties = {
  ...cardStyle,
  background: 'var(--color-surface)',
  borderStyle: 'dashed',
  borderColor: 'var(--color-outline)',
}
const label: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em',
  textTransform: 'uppercase', padding: '3px 8px', borderRadius: 999,
  background: 'var(--color-primary-container, var(--color-surface-bright))', color: 'var(--color-primary)',
  border: '1px solid var(--color-outline-variant)',
}
const link: React.CSSProperties = { fontSize: 11.5, color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 600 }
const fieldLabel: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--color-on-surface)', margin: '8px 0 2px' }
const bodyText: React.CSSProperties = { fontSize: 12.5, color: 'var(--color-on-surface)', whiteSpace: 'pre-wrap', margin: 0 }

const List = ({ items }: { items?: string[] }) =>
  items && items.length ? (
    <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>{items.map((x, i) => <li key={i} style={bodyText}>{x}</li>)}</ul>
  ) : <p style={mutedText}>—</p>

function AnalysisView({ a }: { a: ProjectAnalysis }) {
  return (
    <div>
      <div style={fieldLabel}>Problem</div>
      <p style={bodyText}>{a.problem?.trim() || '—'}</p>
      <div style={fieldLabel}>Goals</div><List items={a.goals} />
      <div style={fieldLabel}>Stakeholders</div>
      {a.stakeholders && a.stakeholders.length
        ? <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>{a.stakeholders.map((s, i) => <li key={i} style={bodyText}>{[s.role, s.name].filter(Boolean).join(' — ')}{s.interest ? `: ${s.interest}` : ''}</li>)}</ul>
        : <p style={mutedText}>—</p>}
      <div style={fieldLabel}>Assumptions</div><List items={a.assumptions} />
      <div style={fieldLabel}>Constraints</div><List items={a.constraints} />
    </div>
  )
}

function RequirementsView({ reqs }: { reqs: ProjectRequirement[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {reqs.map((r, i) => (
        <div key={r.id ?? i} style={{ borderLeft: '2px solid var(--color-outline-variant)', paddingLeft: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            {r.priority && <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--color-primary)' }}>{r.priority}</span>}
            <p style={{ ...bodyText, fontWeight: 600 }}>{r.statement?.trim() || '—'}</p>
          </div>
          {r.acceptanceCriteria && r.acceptanceCriteria.length ? (<><div style={fieldLabel}>Acceptance criteria</div><List items={r.acceptanceCriteria} /></>) : null}
          {r.rationale ? (<><div style={fieldLabel}>Rationale</div><p style={bodyText}>{r.rationale}</p></>) : null}
        </div>
      ))}
    </div>
  )
}

function DecisionsView({ decisions }: { decisions: ProjectDecision[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {decisions.map((d, i) => (
        <div key={d.id ?? i} style={{ borderLeft: '2px solid var(--color-outline-variant)', paddingLeft: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            {d.status && <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--color-primary)' }}>{d.status}</span>}
            <p style={{ ...bodyText, fontWeight: 700 }}>{d.title?.trim() || '—'}</p>
          </div>
          {d.context ? (<><div style={fieldLabel}>Context</div><p style={bodyText}>{d.context}</p></>) : null}
          {d.decision ? (<><div style={fieldLabel}>Decision</div><p style={bodyText}>{d.decision}</p></>) : null}
          {d.consequences ? (<><div style={fieldLabel}>Consequences</div><p style={bodyText}>{d.consequences}</p></>) : null}
        </div>
      ))}
    </div>
  )
}

function hasContent(section: Section, pkg: NonNullable<InheritedSpec['spec']>['package']): boolean {
  if (section === 'analysis') {
    const a = pkg.analysis ?? {}
    return Boolean(a.problem?.trim() || a.goals?.length || a.stakeholders?.length || a.assumptions?.length || a.constraints?.length)
  }
  if (section === 'requirements') return Boolean(pkg.requirements?.length)
  return Boolean(pkg.decisions?.length)
}

export function InheritedFromProject({ workItemId, section }: { workItemId: string; section: Section }) {
  const q = useQuery<InheritedSpec>({
    queryKey: ['inherited-spec', workItemId],
    queryFn: () => api.get(`/work-items/${workItemId}/inherited-spec`).then((r) => r.data),
  })
  const data = q.data
  if (!data?.project || !data.spec) return null
  if (!hasContent(section, data.spec.package)) return null

  const { project, spec } = data
  return (
    <section style={wrap}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={label}>Inherited from project</span>
        <span style={link}>{project.code} · {project.name}</span>
        <span style={{ ...mutedText, marginLeft: 'auto' }}>Baseline r{spec.revision} · read-only · open “Project baseline” to edit</span>
      </div>
      {section === 'analysis' && <AnalysisView a={spec.package.analysis ?? {}} />}
      {section === 'requirements' && <RequirementsView reqs={spec.package.requirements ?? []} />}
      {section === 'decisions' && <DecisionsView decisions={spec.package.decisions ?? []} />}
    </section>
  )
}
