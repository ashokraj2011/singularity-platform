import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { cardStyle, thStyle, tdStyle, mutedText, sectionTitle } from './workspaceStyles'

/**
 * Spec Studio — code context. Surfaces the repository this spec is (or will be) built against, plus
 * any repositories the code-foundry has scanned/indexed, via the direct-HTTP /api/codegen endpoints
 * (no MCP bridge). Best-effort: if code indexing isn't enabled the panel degrades to a note rather
 * than erroring.
 */

interface Handoff {
  target: null | { repository: string; component: string | null; baseBranch: string; baseCommitSha: string; status: string }
}
interface CodegenRepo { id: string; repoPath: string; language?: string; framework?: string; scannedAt?: string }

export function CodePanel({ workItemId }: { workItemId: string }) {
  const handoffQ = useQuery<Handoff>({
    queryKey: ['handoff', workItemId],
    queryFn: () => api.get(`/work-items/${workItemId}/development-target`).then((r) => r.data),
  })
  const reposQ = useQuery<{ items?: CodegenRepo[] } | CodegenRepo[]>({
    queryKey: ['codegen-repos'],
    retry: false,
    queryFn: () => api.get('/codegen/repos').then((r) => r.data),
  })

  const target = handoffQ.data?.target ?? null
  const repos: CodegenRepo[] = Array.isArray(reposQ.data) ? reposQ.data : (reposQ.data?.items ?? [])

  return (
    <div>
      <section style={cardStyle}>
        <h4 style={{ ...sectionTitle, fontSize: 14 }}>Repository</h4>
        {target ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
            <Field label="Repository" value={target.repository} />
            <Field label="Component" value={target.component ?? '—'} />
            <Field label="Base branch" value={target.baseBranch} />
            <Field label="Base commit" value={(target.baseCommitSha ?? '').slice(0, 10) || '—'} />
          </div>
        ) : (
          <p style={mutedText}>No repository is linked yet — configure the developer handoff (Submissions tab) to bind this spec to a repo and base commit.</p>
        )}
      </section>

      <section style={cardStyle}>
        <h4 style={{ ...sectionTitle, fontSize: 14 }}>Indexed code</h4>
        {reposQ.isLoading ? (
          <p style={mutedText}>Loading…</p>
        ) : reposQ.isError ? (
          <p style={mutedText}>Code indexing (code foundry) isn't enabled on this environment, so source browsing isn't available here.</p>
        ) : repos.length === 0 ? (
          <p style={mutedText}>No repositories have been scanned yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Repository', 'Language', 'Framework', 'Scanned'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
              <tbody>
                {repos.map((r) => (
                  <tr key={r.id}>
                    <td style={tdStyle}>{r.repoPath}</td>
                    <td style={tdStyle}>{r.language ?? '—'}</td>
                    <td style={tdStyle}>{r.framework ?? '—'}</td>
                    <td style={tdStyle}>{r.scannedAt ? new Date(r.scannedAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ ...mutedText, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 12, color: 'var(--color-on-surface)', overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  )
}
