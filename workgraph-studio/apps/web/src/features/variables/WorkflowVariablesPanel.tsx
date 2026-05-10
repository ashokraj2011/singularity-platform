import { useState, useEffect } from 'react'
import { motion } from 'motion/react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, X, Save, Globe, Braces, Type, Hash, ToggleLeft, Layers } from 'lucide-react'
import { api } from '../../lib/api'
import type { TemplateVariableDef, InstanceGlobalEntry, VarType } from './types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TYPE_ICON: Record<VarType, React.ElementType> = {
  STRING: Type, NUMBER: Hash, BOOLEAN: ToggleLeft, JSON: Braces,
}

function uid() { return Math.random().toString(36).slice(2, 10) }

function formatValue(v: unknown, type: VarType): string {
  if (v === undefined || v === null) return ''
  if (type === 'JSON') return JSON.stringify(v)
  if (type === 'BOOLEAN') return v ? 'true' : 'false'
  return String(v)
}

function parseInputValue(raw: string, type: VarType): unknown {
  if (raw === '' || raw === undefined) return undefined
  if (type === 'NUMBER') {
    const n = Number(raw); return Number.isNaN(n) ? raw : n
  }
  if (type === 'BOOLEAN') return raw === 'true' || raw === '1'
  if (type === 'JSON') {
    try { return JSON.parse(raw) } catch { return raw }
  }
  return raw
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export function WorkflowVariablesPanel({
  instanceId, templateId, teamId, variables,
  isLight, glassPanel, panelText, panelMuted, panelBdr, onClose,
}: {
  instanceId?: string
  templateId?: string
  teamId?: string
  variables: TemplateVariableDef[]
  isLight: boolean
  glassPanel: (l: boolean) => React.CSSProperties
  panelText: string; panelMuted: string; panelBdr: string
  onClose: () => void
}) {
  const qc = useQueryClient()

  // ── Template variables (editable, per-template) ────────────────────────────
  const [defs, setDefs] = useState<TemplateVariableDef[]>(variables)
  useEffect(() => { setDefs(variables) }, [JSON.stringify(variables)])

  const dirtyTemplate = JSON.stringify(defs) !== JSON.stringify(variables)

  const saveTemplateMut = useMutation({
    mutationFn: (next: TemplateVariableDef[]) =>
      api.patch(`/workflow-templates/${templateId}`, { variables: next }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-templates', templateId] }),
  })

  // ── Instance globals (live values keyed by instance) ───────────────────────
  const { data: globalsResp } = useQuery<{ globals: InstanceGlobalEntry[] }>({
    queryKey: ['workflow-instances', instanceId, 'globals'],
    queryFn: () => api.get(`/workflow-instances/${instanceId}/globals`).then(r => r.data),
    enabled: !!instanceId,
  })
  const globalsList = globalsResp?.globals ?? []
  const fixedGlobals    = globalsList.filter(g => g.scope === 'GLOBAL')
  const instanceGlobals = globalsList.filter(g => g.scope === 'INSTANCE')

  const [draftGlobals, setDraftGlobals] = useState<Record<string, unknown>>({})
  useEffect(() => {
    // Reseed editable values whenever the live values arrive
    const seed: Record<string, unknown> = {}
    for (const g of instanceGlobals) seed[g.key] = g.currentValue
    setDraftGlobals(seed)
  }, [JSON.stringify(instanceGlobals.map(g => [g.key, g.currentValue]))])

  const dirtyGlobals = instanceGlobals.some(g => formatValue(draftGlobals[g.key], g.type) !== formatValue(g.currentValue, g.type))

  const saveGlobalsMut = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.patch(`/workflow-instances/${instanceId}/globals`, { globals: payload }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-instances', instanceId, 'globals'] }),
  })

  // ── Template-variable editor helpers ───────────────────────────────────────
  const addDef = () => setDefs(d => [...d, {
    key: `var_${uid()}`, label: '', type: 'STRING', defaultValue: '', scope: 'INPUT',
  }])
  const updateDef = (i: number, patch: Partial<TemplateVariableDef>) =>
    setDefs(d => d.map((v, idx) => idx === i ? { ...v, ...patch } : v))
  const removeDef = (i: number) => setDefs(d => d.filter((_, idx) => idx !== i))

  const inputSt: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '6px 9px', borderRadius: 7,
    fontSize: 11, border: `1px solid ${panelBdr}`,
    background: isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)',
    color: panelText, outline: 'none',
  }
  const labelSt: React.CSSProperties = {
    fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
    color: panelMuted, display: 'block', marginBottom: 3,
  }

  // Suppress the unused `teamId` warning — kept for future direct team-vars fetch.
  void teamId

  return (
    <motion.div
      key="variables-panel"
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -16 }}
      transition={{ duration: 0.18 }}
      style={{
        position: 'absolute', left: 68, top: 72, bottom: 12,
        width: 380, zIndex: 25, pointerEvents: 'auto',
        ...glassPanel(isLight),
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: `1px solid ${panelBdr}` }}>
        <Braces size={13} style={{ color: '#8b5cf6' }} />
        <span style={{ flex: 1, fontSize: 12, fontWeight: 700, color: panelText, letterSpacing: '0.02em' }}>Variables</span>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: panelMuted, padding: 4 }}
        >
          <X size={13} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* ── Team Globals (fixed) ──────────────────────────────────────────── */}
        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <Globe size={11} style={{ color: '#0ea5e9' }} />
            <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#0ea5e9' }}>
              Global team variables
            </span>
            <span style={{ fontSize: 9, color: panelMuted, marginLeft: 'auto' }}>read-only · {fixedGlobals.length}</span>
          </div>
          {fixedGlobals.length === 0 ? (
            <p style={{ fontSize: 10, color: panelMuted, fontStyle: 'italic', padding: '8px 10px', borderRadius: 7, border: `1px dashed ${panelBdr}` }}>
              No global team variables yet. Configure them on the Team Variables page — they appear here as <code style={{ fontFamily: 'monospace' }}>globals.X</code>.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {fixedGlobals.map(g => {
                const Icon = TYPE_ICON[g.type]
                return (
                  <div key={g.key} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 9px', borderRadius: 7, background: isLight ? 'rgba(14,165,233,0.06)' : 'rgba(14,165,233,0.10)', border: `1px solid ${panelBdr}` }}>
                    <Icon size={10} style={{ color: '#0ea5e9', flexShrink: 0 }} />
                    <code style={{ fontSize: 11, fontFamily: 'monospace', fontWeight: 600, color: panelText }}>globals.{g.key}</code>
                    <span style={{ fontSize: 10, color: panelMuted, fontFamily: 'monospace', marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
                      {formatValue(g.currentValue, g.type)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* ── Per-instance team variables (editable for this instance) ──────── */}
        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <Layers size={11} style={{ color: '#a855f7' }} />
            <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#a855f7' }}>
              Per-instance team variables
            </span>
            <span style={{ fontSize: 9, color: panelMuted, marginLeft: 'auto' }}>{instanceGlobals.length}</span>
          </div>

          {instanceGlobals.length === 0 ? (
            <p style={{ fontSize: 10, color: panelMuted, fontStyle: 'italic', padding: '8px 10px', borderRadius: 7, border: `1px dashed ${panelBdr}` }}>
              None defined. Mark a team variable as <strong>Per-instance</strong> on the Team Variables page so each running instance can have its own value.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {instanceGlobals.map(g => {
                const Icon = TYPE_ICON[g.type]
                const draftValue = draftGlobals[g.key] ?? ''
                const setVal = (v: unknown) => setDraftGlobals(prev => ({ ...prev, [g.key]: v }))
                return (
                  <div key={g.key} style={{ padding: '8px 10px', borderRadius: 8, background: isLight ? 'rgba(168,85,247,0.05)' : 'rgba(168,85,247,0.10)', border: `1px solid rgba(168,85,247,0.20)` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <Icon size={10} style={{ color: '#a855f7', flexShrink: 0 }} />
                      <code style={{ fontSize: 11, fontFamily: 'monospace', fontWeight: 700, color: panelText }}>globals.{g.key}</code>
                      {g.label && <span style={{ fontSize: 10, color: panelMuted }}>· {g.label}</span>}
                      <span style={{ marginLeft: 'auto', fontSize: 9, color: panelMuted, fontFamily: 'monospace' }} title={`Team default: ${formatValue(g.teamDefault, g.type)}`}>
                        default: {formatValue(g.teamDefault, g.type)}
                      </span>
                    </div>
                    {g.type === 'BOOLEAN' ? (
                      <select
                        value={String(draftValue === true)}
                        onChange={e => setVal(e.target.value === 'true')}
                        style={{ ...inputSt, cursor: 'pointer' }}
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : g.type === 'JSON' ? (
                      <textarea
                        value={typeof draftValue === 'string' ? draftValue : JSON.stringify(draftValue ?? '')}
                        onChange={e => setVal(parseInputValue(e.target.value, g.type))}
                        rows={2}
                        style={{ ...inputSt, fontFamily: 'monospace', resize: 'vertical' }}
                      />
                    ) : (
                      <input
                        value={typeof draftValue === 'string' || typeof draftValue === 'number' ? String(draftValue) : ''}
                        onChange={e => setVal(parseInputValue(e.target.value, g.type))}
                        placeholder={formatValue(g.teamDefault, g.type)}
                        style={inputSt}
                      />
                    )}
                    {g.description && <p style={{ fontSize: 9, color: panelMuted, marginTop: 4 }}>{g.description}</p>}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* ── Workflow variables (editable per workflow design) ─────────────── */}
        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <Braces size={11} style={{ color: '#8b5cf6' }} />
            <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#8b5cf6' }}>
              Workflow variables
            </span>
            <span style={{ fontSize: 9, color: panelMuted, marginLeft: 'auto' }}>{defs.length}</span>
          </div>

          {defs.length === 0 && (
            <p style={{ fontSize: 10, color: panelMuted, fontStyle: 'italic', padding: '8px 10px', borderRadius: 7, border: `1px dashed ${panelBdr}` }}>
              No workflow variables. Add one to expose runtime inputs or workflow-baked constants — referenced as <code style={{ fontFamily: 'monospace' }}>vars.X</code>.
            </p>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {defs.map((d, i) => (
              <div key={i} style={{ padding: 9, borderRadius: 8, border: `1px solid ${panelBdr}`, background: isLight ? 'rgba(0,0,0,0.02)' : 'rgba(255,255,255,0.03)' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px 22px', gap: 6, alignItems: 'end' }}>
                  <div>
                    <label style={labelSt}>Key *</label>
                    <input value={d.key} onChange={e => updateDef(i, { key: e.target.value })} placeholder="customer_tier" style={{ ...inputSt, fontFamily: 'monospace' }} />
                  </div>
                  <div>
                    <label style={labelSt}>Label</label>
                    <input value={d.label ?? ''} onChange={e => updateDef(i, { label: e.target.value })} placeholder="Customer tier" style={inputSt} />
                  </div>
                  <div>
                    <label style={labelSt}>Type</label>
                    <select value={d.type} onChange={e => updateDef(i, { type: e.target.value as VarType })} style={{ ...inputSt, cursor: 'pointer' }}>
                      {(['STRING', 'NUMBER', 'BOOLEAN', 'JSON'] as const).map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <button onClick={() => removeDef(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 0, alignSelf: 'center', marginTop: 14 }}>
                    <Trash2 size={11} />
                  </button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px', gap: 6, marginTop: 6 }}>
                  <div>
                    <label style={labelSt}>Default value</label>
                    {d.type === 'BOOLEAN' ? (
                      <select
                        value={String(d.defaultValue === true)}
                        onChange={e => updateDef(i, { defaultValue: e.target.value === 'true' })}
                        style={{ ...inputSt, cursor: 'pointer' }}
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : d.type === 'JSON' ? (
                      <input
                        value={typeof d.defaultValue === 'string' ? d.defaultValue : JSON.stringify(d.defaultValue ?? '')}
                        onChange={e => updateDef(i, { defaultValue: parseInputValue(e.target.value, d.type) })}
                        placeholder='{"foo":1}'
                        style={{ ...inputSt, fontFamily: 'monospace' }}
                      />
                    ) : (
                      <input
                        value={typeof d.defaultValue === 'string' || typeof d.defaultValue === 'number' ? String(d.defaultValue) : ''}
                        onChange={e => updateDef(i, { defaultValue: parseInputValue(e.target.value, d.type) })}
                        placeholder={d.type === 'NUMBER' ? '42' : 'GOLD'}
                        style={inputSt}
                      />
                    )}
                  </div>
                  <div>
                    <label style={labelSt}>Scope</label>
                    <select value={d.scope} onChange={e => updateDef(i, { scope: e.target.value as 'INPUT' | 'CONSTANT' })} style={{ ...inputSt, cursor: 'pointer' }}>
                      <option value="INPUT">INPUT</option>
                      <option value="CONSTANT">CONSTANT</option>
                    </select>
                  </div>
                </div>

                <div style={{ marginTop: 6 }}>
                  <label style={labelSt}>Description</label>
                  <input value={d.description ?? ''} onChange={e => updateDef(i, { description: e.target.value })} placeholder="Where is this used?" style={inputSt} />
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={addDef}
            style={{
              marginTop: 10,
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '6px 10px', borderRadius: 7, border: `1px dashed ${panelBdr}`,
              background: 'transparent', color: '#8b5cf6', cursor: 'pointer',
              fontSize: 11, fontWeight: 700,
            }}
          >
            <Plus size={11} /> Add variable
          </button>
        </section>

      </div>

      {/* Footer — two save buttons */}
      <div style={{ padding: '10px 14px', borderTop: `1px solid ${panelBdr}`, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {instanceGlobals.length > 0 && (
          <button
            disabled={!dirtyGlobals || saveGlobalsMut.isPending || !instanceId}
            onClick={() => saveGlobalsMut.mutate(draftGlobals)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '6px 12px', borderRadius: 7, border: 'none',
              background: dirtyGlobals ? '#a855f7' : panelBdr,
              color: dirtyGlobals ? '#fff' : panelMuted,
              fontSize: 11, fontWeight: 700,
              cursor: !dirtyGlobals || saveGlobalsMut.isPending ? 'default' : 'pointer',
            }}
          >
            <Save size={11} /> {saveGlobalsMut.isPending ? 'Saving…' : 'Save instance values'}
          </button>
        )}
        <button
          disabled={!dirtyTemplate || saveTemplateMut.isPending || !templateId}
          onClick={() => saveTemplateMut.mutate(defs)}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '6px 14px', borderRadius: 7, border: 'none',
            background: dirtyTemplate ? 'var(--color-primary)' : panelBdr,
            color: dirtyTemplate ? '#fff' : panelMuted,
            fontSize: 11, fontWeight: 700,
            cursor: !dirtyTemplate || saveTemplateMut.isPending ? 'default' : 'pointer',
          }}
        >
          <Save size={11} /> {saveTemplateMut.isPending ? 'Saving…' : (dirtyTemplate ? 'Save workflow vars' : 'Saved')}
        </button>
      </div>
    </motion.div>
  )
}
