/**
 * M97.6 — "Download for Copilot" control for the Blueprint Workbench cockpit.
 *
 * Mirrors the button shipped in workgraph-web's NodeInspector (M97.3), but for
 * the neo cockpit. Operators who run a loop here can grab the same single-file
 * GitHub Copilot playbook without bouncing over to the Workflow Designer.
 *
 *   • `agent-md` → the `.agent.md` file the Copilot CLI runs directly
 *     (YAML frontmatter + Markdown body: agent learnings, per-stage prompts,
 *     the stage workflow, and the documents to create).
 *   • `yaml`     → a pure structured `.workflow.yaml` playbook.
 *
 * Prompts are resolved server-side against the SAVED definition, so this hits
 * the live loop (not unsaved form state). MCP tools are supplied by the
 * operator's own Copilot CLI — the export only carries prompts + workflow.
 *
 * The export endpoint is auth-gated, so we attach the bearer token from the
 * shared workbench auth store and stream the response as a Blob. We can't use
 * the JSON `request()` helper in api.ts (it parses the body as JSON); a raw
 * fetch keeps the binary intact.
 */
import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { getToken } from '../api'

type ExportFormat = 'agent-md' | 'yaml'

export function CopilotExportButton({ nodeId }: { nodeId: string | null | undefined }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!nodeId) return null

  const download = async (format: ExportFormat) => {
    setBusy(true)
    setError(null)
    try {
      const token = getToken()
      const res = await fetch(
        `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/workflow-nodes/${nodeId}/workbench/export-copilot?format=${format}`,
        { headers: token ? { authorization: `Bearer ${token}` } : {} },
      )
      if (!res.ok) {
        setError(
          res.status === 404
            ? 'Add at least one stage (and save) before exporting.'
            : 'Export failed — is prompt-composer running?',
        )
        return
      }
      const cd = res.headers.get('content-disposition') ?? ''
      const match = cd.match(/filename="([^"]+)"/)
      const filename = match?.[1] ?? (format === 'yaml' ? 'workbench.workflow.yaml' : 'workbench.agent.md')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      setError('Export failed — network error.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 9, fontWeight: 800, color: '#ffb786', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
        Run from Copilot
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => download('agent-md')}
          title="Download a .agent.md file the GitHub Copilot CLI runs directly"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            fontSize: 10, fontWeight: 700, color: '#ffb786',
            padding: '5px 9px', borderRadius: 7, cursor: busy ? 'default' : 'pointer',
            border: '1px solid rgba(255,183,134,0.35)', background: 'rgba(255,183,134,0.10)',
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
          .agent.md
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => download('yaml')}
          title="Download a pure structured YAML playbook"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            fontSize: 10, fontWeight: 700, color: '#94a3b8',
            padding: '5px 9px', borderRadius: 7, cursor: busy ? 'default' : 'pointer',
            border: '1px solid rgba(148,163,184,0.30)', background: 'rgba(148,163,184,0.08)',
            opacity: busy ? 0.6 : 1,
          }}
        >
          <Download size={12} />
          .yaml
        </button>
      </div>
      {error && <span style={{ fontSize: 9, color: '#fca5a5' }}>{error}</span>}
    </div>
  )
}
