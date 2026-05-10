import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'motion/react'
import {
  Plus, Trash2, Edit3, CheckCircle, XCircle, Zap, Link2, Archive,
  RotateCw, ChevronDown, ChevronUp, Play,
  Mail, MessageSquare, GitBranch, Database, Globe, Activity,
  Server, Box, Cpu, Layers,
} from 'lucide-react'
import { api } from '../../lib/api'

// ─── Types ────────────────────────────────────────────────────────────────────

type ConnectorType =
  | 'HTTP' | 'EMAIL' | 'TEAMS' | 'SLACK' | 'JIRA' | 'GIT'
  | 'CONFLUENCE' | 'DATADOG' | 'SERVICENOW' | 'LLM_GATEWAY' | 'S3' | 'POSTGRES'

interface Connector {
  id: string; type: ConnectorType; name: string; description?: string
  config: Record<string, unknown>; archivedAt?: string | null; createdAt: string
}

interface OperationDef {
  id: string; label: string; description?: string
  params: { key: string; label: string; type: string; required?: boolean }[]
}

// ─── Connector visual config ──────────────────────────────────────────────────

const CONNECTOR_VISUAL: Record<ConnectorType, { color: string; Icon: React.ElementType; label: string }> = {
  HTTP:         { color: '#38bdf8', Icon: Globe,        label: 'HTTP / REST' },
  EMAIL:        { color: '#f472b6', Icon: Mail,         label: 'Email' },
  TEAMS:        { color: '#6366f1', Icon: MessageSquare, label: 'Microsoft Teams' },
  SLACK:        { color: '#4ade80', Icon: MessageSquare, label: 'Slack' },
  JIRA:         { color: '#38bdf8', Icon: GitBranch,    label: 'Jira' },
  GIT:          { color: '#f97316', Icon: GitBranch,    label: 'GitHub / GitLab' },
  CONFLUENCE:   { color: '#38bdf8', Icon: Layers,       label: 'Confluence' },
  DATADOG:      { color: '#a855f7', Icon: Activity,     label: 'Datadog' },
  SERVICENOW:   { color: '#22c55e', Icon: Server,       label: 'ServiceNow' },
  LLM_GATEWAY:  { color: '#fbbf24', Icon: Cpu,          label: 'LLM Gateway' },
  S3:           { color: '#f59e0b', Icon: Box,          label: 'S3 / Object Storage' },
  POSTGRES:     { color: '#60a5fa', Icon: Database,     label: 'PostgreSQL' },
}

const CONNECTOR_TYPES = Object.keys(CONNECTOR_VISUAL) as ConnectorType[]

// ─── Credential field templates per type ─────────────────────────────────────

const CRED_FIELDS: Record<ConnectorType, { key: string; label: string; type?: string }[]> = {
  HTTP:         [{ key: 'bearerToken', label: 'Bearer Token' }, { key: 'apiKey', label: 'API Key' }, { key: 'basicUser', label: 'Basic User' }, { key: 'basicPass', label: 'Basic Password', type: 'password' }],
  EMAIL:        [{ key: 'apiKey', label: 'API Key (SendGrid/Mailgun)', type: 'password' }, { key: 'mailgunDomain', label: 'Mailgun Domain' }],
  TEAMS:        [{ key: 'webhookUrl', label: 'Incoming Webhook URL' }, { key: 'clientId', label: 'App Client ID' }, { key: 'clientSecret', label: 'Client Secret', type: 'password' }],
  SLACK:        [{ key: 'botToken', label: 'Bot Token', type: 'password' }, { key: 'webhookUrl', label: 'Webhook URL' }],
  JIRA:         [{ key: 'email', label: 'Account Email' }, { key: 'apiToken', label: 'API Token', type: 'password' }],
  GIT:          [{ key: 'token', label: 'Personal Access Token', type: 'password' }],
  CONFLUENCE:   [{ key: 'email', label: 'Account Email' }, { key: 'apiToken', label: 'API Token', type: 'password' }],
  DATADOG:      [{ key: 'apiKey', label: 'API Key', type: 'password' }, { key: 'appKey', label: 'App Key', type: 'password' }],
  SERVICENOW:   [{ key: 'username', label: 'Username' }, { key: 'password', label: 'Password', type: 'password' }],
  LLM_GATEWAY:  [{ key: 'apiKey', label: 'API Key', type: 'password' }],
  S3:           [{ key: 'accessKeyId', label: 'Access Key ID' }, { key: 'secretAccessKey', label: 'Secret Access Key', type: 'password' }],
  POSTGRES:     [{ key: 'connectionString', label: 'Connection String', type: 'password' }],
}

const CONFIG_FIELDS: Record<ConnectorType, { key: string; label: string; placeholder?: string }[]> = {
  HTTP:         [{ key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.example.com' }],
  EMAIL:        [{ key: 'provider', label: 'Provider (sendgrid|mailgun)', placeholder: 'sendgrid' }, { key: 'fromAddress', label: 'From Address' }, { key: 'fromName', label: 'From Name' }],
  TEAMS:        [{ key: 'defaultWebhookUrl', label: 'Default Webhook URL' }, { key: 'tenantId', label: 'Tenant ID' }, { key: 'defaultTeamId', label: 'Default Team ID' }],
  SLACK:        [{ key: 'defaultChannel', label: 'Default Channel', placeholder: '#general' }],
  JIRA:         [{ key: 'baseUrl', label: 'Jira URL', placeholder: 'https://myorg.atlassian.net' }, { key: 'defaultProjectKey', label: 'Default Project Key' }],
  GIT:          [{ key: 'provider', label: 'Provider (github|gitlab)', placeholder: 'github' }, { key: 'defaultOwner', label: 'Default Owner/Org' }, { key: 'defaultRepo', label: 'Default Repo' }],
  CONFLUENCE:   [{ key: 'baseUrl', label: 'Confluence URL', placeholder: 'https://myorg.atlassian.net' }, { key: 'defaultSpaceKey', label: 'Default Space Key' }],
  DATADOG:      [{ key: 'site', label: 'Site (datadoghq.com|datadoghq.eu)', placeholder: 'datadoghq.com' }],
  SERVICENOW:   [{ key: 'instanceUrl', label: 'Instance URL', placeholder: 'https://myinst.service-now.com' }, { key: 'defaultAssignmentGroup', label: 'Default Assignment Group' }],
  LLM_GATEWAY:  [{ key: 'baseUrl', label: 'Gateway URL', placeholder: 'https://api.anthropic.com/v1' }, { key: 'defaultModel', label: 'Default Model', placeholder: 'claude-sonnet-4-6' }],
  S3:           [{ key: 'bucket', label: 'Default Bucket' }, { key: 'region', label: 'Region', placeholder: 'us-east-1' }, { key: 'endpointUrl', label: 'Custom Endpoint (MinIO etc)' }],
  POSTGRES:     [{ key: 'schema', label: 'Schema', placeholder: 'public' }],
}

// ─── ConnectorForm ─────────────────────────────────────────────────────────────

function ConnectorForm({ existing, onClose }: {
  existing?: Connector; onClose: () => void
}) {
  const qc = useQueryClient()
  const [type, setType] = useState<ConnectorType>(existing?.type ?? 'HTTP')
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [configFields, setConfigFields] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(existing?.config ?? {}).map(([k, v]) => [k, String(v)]))
  )
  const [credFields, setCredFields] = useState<Record<string, string>>({})
  const [showCreds, setShowCreds] = useState(!existing)

  const save = useMutation({
    mutationFn: (payload: unknown) => existing
      ? api.patch(`/connectors/${existing.id}`, payload).then(r => r.data)
      : api.post('/connectors', payload).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connectors'] }); onClose() },
  })

  const handleSubmit = () => {
    const config = Object.fromEntries(Object.entries(configFields).filter(([, v]) => v))
    const credentials = Object.fromEntries(Object.entries(credFields).filter(([, v]) => v))
    save.mutate({ type, name, description, config, ...(Object.keys(credentials).length ? { credentials } : {}) })
  }

  const inputSt: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: 8,
    fontSize: 12, border: '1px solid var(--color-outline-variant)',
    background: 'var(--color-surface-low)',
    color: 'var(--color-on-surface)', outline: 'none', fontFamily: 'inherit',
    transition: 'border-color 0.15s',
  }
  const vis = CONNECTOR_VISUAL[type]

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <p className="label-xs" style={{ marginBottom: 4 }}>Type</p>
          <select value={type} onChange={e => setType(e.target.value as ConnectorType)} style={{ ...inputSt }} disabled={!!existing}>
            {CONNECTOR_TYPES.map(t => <option key={t} value={t}>{CONNECTOR_VISUAL[t].label}</option>)}
          </select>
        </div>
        <div style={{ flex: 2 }}>
          <p className="label-xs" style={{ marginBottom: 4 }}>Name</p>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="My Jira Connector" style={inputSt} />
        </div>
      </div>

      <div>
        <p className="label-xs" style={{ marginBottom: 4 }}>Description</p>
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional" style={inputSt} />
      </div>

      <div style={{ borderRadius: 10, border: '1px solid var(--color-outline-variant)', padding: '10px 12px' }}>
        <p style={{ fontSize: 10, color: vis.color, marginBottom: 8, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Configuration</p>
        {CONFIG_FIELDS[type].map(f => (
          <div key={f.key} style={{ marginBottom: 7 }}>
            <p style={{ fontSize: 10, color: 'var(--color-outline)', marginBottom: 3 }}>{f.label}</p>
            <input value={configFields[f.key] ?? ''} onChange={e => setConfigFields(p => ({ ...p, [f.key]: e.target.value }))} placeholder={f.placeholder} style={inputSt} />
          </div>
        ))}
      </div>

      <div style={{ borderRadius: 10, border: '1px solid var(--color-outline-variant)', padding: '10px 12px' }}>
        <button onClick={() => setShowCreds(s => !s)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-outline)', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', padding: 0, marginBottom: showCreds ? 8 : 0 }}>
          {showCreds ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          Credentials {existing ? '(leave blank to keep existing)' : ''}
        </button>
        {showCreds && CRED_FIELDS[type].map(f => (
          <div key={f.key} style={{ marginBottom: 7 }}>
            <p style={{ fontSize: 10, color: 'var(--color-outline)', marginBottom: 3 }}>{f.label}</p>
            <input type={f.type ?? 'text'} value={credFields[f.key] ?? ''} onChange={e => setCredFields(p => ({ ...p, [f.key]: e.target.value }))} style={inputSt} />
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onClose} style={{ flex: 1, padding: '9px', borderRadius: 8, border: '1px solid var(--color-outline-variant)', background: 'transparent', color: 'var(--color-outline)', cursor: 'pointer', fontSize: 12, fontWeight: 600, transition: 'all 0.12s' }}>
          Cancel
        </button>
        <button onClick={handleSubmit} disabled={save.isPending || !name} style={{ flex: 2, padding: '9px', borderRadius: 8, border: `1.5px solid ${vis.color}60`, background: `${vis.color}18`, color: vis.color, cursor: 'pointer', fontSize: 12, fontWeight: 700, opacity: save.isPending || !name ? 0.6 : 1, transition: 'all 0.12s' }}>
          {save.isPending ? 'Saving…' : existing ? 'Update' : 'Create Connector'}
        </button>
      </div>
    </div>
  )
}

// ─── ConnectorCard ────────────────────────────────────────────────────────────

function ConnectorCard({ connector, onEdit }: {
  connector: Connector
  onEdit: (c: Connector) => void
}) {
  const qc = useQueryClient()
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [ops, setOps] = useState<OperationDef[] | null>(null)
  const [showOps, setShowOps] = useState(false)
  const vis = CONNECTOR_VISUAL[connector.type]

  const archive = useMutation({
    mutationFn: () => api.post(`/connectors/${connector.id}/archive`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connectors'] }),
  })

  const testConn = async () => {
    setTesting(true); setTestResult(null)
    try {
      const r = await api.post(`/connectors/${connector.id}/test`)
      setTestResult(r.data)
    } catch { setTestResult({ ok: false, error: 'Request failed' }) }
    finally { setTesting(false) }
  }

  const loadOps = async () => {
    if (ops) { setShowOps(s => !s); return }
    try {
      const r = await api.get(`/connectors/${connector.id}/operations`)
      setOps(r.data); setShowOps(true)
    } catch {}
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
      style={{
        borderRadius: 12, border: '1px solid var(--color-outline-variant)',
        background: '#ffffff', padding: '14px 16px', overflow: 'hidden',
        boxShadow: '0 2px 8px rgba(12,23,39,0.04)',
        transition: 'all 0.15s',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLDivElement).style.borderColor = `${vis.color}40`
        ;(e.currentTarget as HTMLDivElement).style.boxShadow = `0 4px 16px ${vis.color}14`
        ;(e.currentTarget as HTMLDivElement).style.transform = 'translateY(-1px)'
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--color-outline-variant)'
        ;(e.currentTarget as HTMLDivElement).style.boxShadow = '0 2px 8px rgba(12,23,39,0.04)'
        ;(e.currentTarget as HTMLDivElement).style.transform = 'none'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ width: 38, height: 38, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `${vis.color}12`, border: `1px solid ${vis.color}25`, flexShrink: 0 }}>
          <vis.Icon size={16} style={{ color: vis.color }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-on-surface)', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{connector.name}</p>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 5, fontWeight: 700, background: `${vis.color}12`, color: vis.color, border: `1px solid ${vis.color}25`, textTransform: 'uppercase', letterSpacing: '0.12em' }}>{vis.label}</span>
            {testResult && (
              <span style={{ fontSize: 9, display: 'flex', alignItems: 'center', gap: 3, color: testResult.ok ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 700 }}>
                {testResult.ok ? <CheckCircle size={10} /> : <XCircle size={10} />}
                {testResult.ok ? 'Connected' : testResult.error ?? 'Failed'}
              </span>
            )}
          </div>
          {connector.description && <p style={{ fontSize: 10, color: 'var(--color-outline)', marginTop: 4, lineHeight: 1.5 }}>{connector.description}</p>}
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button onClick={testConn} disabled={testing} title="Test connection" style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid var(--color-outline-variant)', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-outline)', transition: 'all 0.12s' }}>
            {testing ? <RotateCw size={12} className="spin" /> : <Play size={12} />}
          </button>
          <button onClick={loadOps} title="Operations" style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid var(--color-outline-variant)', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-outline)', transition: 'all 0.12s' }}>
            <Zap size={12} />
          </button>
          <button onClick={() => onEdit(connector)} title="Edit" style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid var(--color-outline-variant)', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-outline)', transition: 'all 0.12s' }}>
            <Edit3 size={12} />
          </button>
          <button onClick={() => archive.mutate()} title="Archive" style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid var(--color-outline-variant)', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-outline)', transition: 'all 0.12s' }}>
            <Archive size={12} />
          </button>
        </div>
      </div>

      {showOps && ops && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--color-outline-variant)', paddingTop: 10 }}>
          <p style={{ fontSize: 9, color: 'var(--color-outline)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>Operations</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {ops.map(op => (
              <span key={op.id} title={op.description ?? ''} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 6, background: `${vis.color}12`, color: vis.color, border: `1px solid ${vis.color}25`, fontWeight: 600, cursor: 'default' }}>
                {op.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  )
}

// ─── ConnectorsPage ───────────────────────────────────────────────────────────

export function ConnectorsPage() {
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Connector | null>(null)
  const [filterType, setFilterType] = useState<ConnectorType | ''>('')
  const [showArchived, setShowArchived] = useState(false)

  const qc = useQueryClient()
  const { data: connectors = [] } = useQuery<Connector[]>({
    queryKey: ['connectors', showArchived],
    queryFn: () => api.get(showArchived ? '/connectors/archived' : '/connectors').then(r => r.data),
  })

  const restore = useMutation({
    mutationFn: (id: string) => api.post(`/connectors/${id}/restore`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connectors'] }),
  })

  const filtered = filterType ? connectors.filter(c => c.type === filterType) : connectors

  return (
    <div style={{ padding: '28px 28px 40px', maxWidth: 1020, margin: '0 auto' }}>
      {/* Header */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--color-secondary-dim)', border: '1px solid rgba(0,75,141,0.18)',
            }}>
              <Link2 size={16} style={{ color: 'var(--color-secondary)' }} />
            </div>
            <div>
              <h1 className="page-header">Connectors</h1>
              <p style={{ fontSize: 12, color: 'var(--color-outline)', margin: 0 }}>
                Integrate with external systems — Jira, Teams, Email, Datadog, ServiceNow, and more
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={() => setShowArchived(s => !s)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '8px 14px', borderRadius: 8, border: '1px solid var(--color-outline-variant)',
                background: showArchived ? 'rgba(217,119,6,0.08)' : 'transparent',
                color: showArchived ? 'var(--color-warning)' : 'var(--color-outline)',
                cursor: 'pointer', fontSize: 11, fontWeight: 600, transition: 'all 0.12s',
              }}
            >
              <Archive size={12} /> {showArchived ? 'Active' : 'Archived'}
            </button>
            <button
              onClick={() => { setEditing(null); setShowForm(true) }}
              className="btn-primary"
              style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}
            >
              <Plus size={12} /> New Connector
            </button>
          </div>
        </div>

        {/* Type filter pills */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 18 }}>
          <button
            onClick={() => setFilterType('')}
            style={{
              padding: '4px 11px', borderRadius: 7, border: `1px solid ${filterType === '' ? 'var(--color-secondary)' : 'var(--color-outline-variant)'}`,
              background: filterType === '' ? 'rgba(0,75,141,0.08)' : 'transparent',
              color: filterType === '' ? 'var(--color-secondary)' : 'var(--color-outline)',
              fontSize: 10, fontWeight: 700, cursor: 'pointer', transition: 'all 0.12s',
            }}
          >
            All
          </button>
          {CONNECTOR_TYPES.map(t => {
            const vis = CONNECTOR_VISUAL[t]
            return (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                style={{
                  padding: '4px 11px', borderRadius: 7, border: `1px solid ${filterType === t ? vis.color : 'var(--color-outline-variant)'}`,
                  background: filterType === t ? `${vis.color}12` : 'transparent',
                  color: filterType === t ? vis.color : 'var(--color-outline)',
                  fontSize: 10, fontWeight: 700, cursor: 'pointer', transition: 'all 0.12s',
                }}
              >
                {vis.label}
              </button>
            )
          })}
        </div>
      </motion.div>

      {/* Create/Edit form */}
      <AnimatePresence>
        {(showForm || editing) && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ marginBottom: 20, borderRadius: 12, border: '1px solid var(--color-outline-variant)', background: '#ffffff', overflow: 'hidden', boxShadow: '0 2px 8px rgba(12,23,39,0.04)' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-outline-variant)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-on-surface)' }}>{editing ? `Edit — ${editing.name}` : 'New Connector'}</p>
              <button onClick={() => { setShowForm(false); setEditing(null) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-outline)' }}><Trash2 size={13} /></button>
            </div>
            <ConnectorForm existing={editing ?? undefined} onClose={() => { setShowForm(false); setEditing(null) }} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Connector list */}
      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <Link2 size={20} style={{ color: 'var(--color-secondary)' }} />
          </div>
          <p style={{ fontFamily: "'Public Sans', sans-serif", fontWeight: 700, fontSize: 14, color: 'var(--color-on-surface)', marginBottom: 4 }}>
            No connectors{showArchived ? ' archived' : ' yet'}
          </p>
          <p style={{ fontSize: 12, color: 'var(--color-outline)', marginBottom: 16 }}>
            Click "New Connector" to integrate your first external system.
          </p>
          <button className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }} onClick={() => { setEditing(null); setShowForm(true) }}>
            <Plus size={14} /> New Connector
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
          {filtered.map(c => {
            const cVis = CONNECTOR_VISUAL[c.type] ?? CONNECTOR_VISUAL.HTTP
            const CIcon = cVis.Icon
            return showArchived ? (
            <motion.div
              key={c.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              style={{
                borderRadius: 12, border: '1px solid var(--color-outline-variant)', background: 'var(--color-surface-low)',
                padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, opacity: 0.6,
                boxShadow: '0 2px 8px rgba(12,23,39,0.02)',
              }}
            >
              <div style={{ width: 38, height: 38, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `${cVis.color}12`, border: `1px solid ${cVis.color}25`, flexShrink: 0 }}>
                <CIcon size={16} style={{ color: cVis.color }} />
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-on-surface)' }}>{c.name}</p>
                <p style={{ fontSize: 10, color: 'var(--color-outline)' }}>Archived {new Date(c.archivedAt!).toLocaleDateString()}</p>
              </div>
              <button onClick={() => restore.mutate(c.id)} style={{ padding: '5px 10px', borderRadius: 7, border: '1px solid var(--color-outline-variant)', background: 'transparent', color: 'var(--color-success)', cursor: 'pointer', fontSize: 10, fontWeight: 700, transition: 'all 0.12s' }}>
                Restore
              </button>
            </motion.div>
          ) : (
            <ConnectorCard key={c.id} connector={c} onEdit={c2 => { setEditing(c2); setShowForm(false) }} />
          )
          })}
        </div>
      )}
    </div>
  )
}
