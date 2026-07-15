import { useState, type CSSProperties } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Boxes, Plus, Trash2, Link2, Unlink, Play, GitBranch } from 'lucide-react'
import { api } from '../../../lib/api'
import { cardStyle, inputStyle, mutedText, primaryButtonStyle, secondaryButtonStyle, sectionTitle } from './workspaceStyles'

/**
 * Next-stage automation — attach a Work Program to this work item so that, when it finalizes
 * (reconciliation PASSED → COMPLETED), the program fans out into the next stage of work items,
 * each bound to a workflow. This is the only place in the IDE to pick, create, activate, or
 * detach that program; attachment is only writable while the item is still editable.
 */

const EDITABLE = new Set(['SCHEDULED', 'QUEUED', 'IN_PROGRESS'])
const ROUTING_MODES = ['MANUAL', 'AUTO_ATTACH', 'AUTO_START', 'SCHEDULED_START'] as const

type LookupCapability = { id: string; name: string; capability_type?: string }
type WorkflowRow = { id: string; name: string; capabilityId?: string | null }
type ProgramStep = { stepKey: string; titleTemplate: string; workItemTypeKey?: string; targetCapabilityId: string; workflowTemplateId?: string; routingMode?: string; dependsOnKeys?: string[] }
type Program = { id: string; name: string; description?: string | null; status: string; steps: ProgramStep[]; _count?: { runs: number } }
type WorkItemDetail = { id: string; status: string; completionProgramId?: string | null; completionProgram?: { id: string; name: string; status: string; _count?: { steps: number } } | null }

type DraftStep = { stepKey: string; titleTemplate: string; targetCapabilityId: string; workflowTemplateId: string; routingMode: string; dependsOnKeys: string[] }

function unwrapItems<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.content)) return obj.content as T[]
    if (Array.isArray(obj.items)) return obj.items as T[]
    if (Array.isArray(obj.data)) return obj.data as T[]
  }
  return []
}

function emptyStep(n: number): DraftStep {
  return { stepKey: `step-${n}`, titleTemplate: '', targetCapabilityId: '', workflowTemplateId: '', routingMode: 'AUTO_START', dependsOnKeys: [] }
}

export function NextStagePanel({ workItemId }: { workItemId: string }) {
  const qc = useQueryClient()
  const [mode, setMode] = useState<'view' | 'pick' | 'create'>('view')
  const [pickId, setPickId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [steps, setSteps] = useState<DraftStep[]>([emptyStep(1)])
  const [error, setError] = useState<string | null>(null)

  const itemQ = useQuery<WorkItemDetail>({ queryKey: ['work-item', workItemId], queryFn: () => api.get(`/work-items/${workItemId}`).then((r) => r.data) })
  const programsQ = useQuery<Program[]>({ queryKey: ['work-programs'], queryFn: () => api.get('/work-programs').then((r) => unwrapItems<Program>(r.data)), staleTime: 30_000 })
  const capsQ = useQuery<LookupCapability[]>({ queryKey: ['lookup', 'capabilities'], queryFn: () => api.get('/lookup/capabilities', { params: { size: 200 } }).then((r) => unwrapItems<LookupCapability>(r.data)), staleTime: 60_000 })
  const workflowsQ = useQuery<WorkflowRow[]>({ queryKey: ['workflows', 'main'], queryFn: () => api.get('/workflows', { params: { size: 100, profile: 'main' } }).then((r) => unwrapItems<WorkflowRow>(r.data)), staleTime: 60_000 })

  const item = itemQ.data
  const editable = item ? EDITABLE.has(item.status) : false
  const attached = item?.completionProgram ?? null

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['work-item', workItemId] })
    qc.invalidateQueries({ queryKey: ['work-programs'] })
  }

  const attachMut = useMutation({
    mutationFn: (programId: string | null) => api.patch(`/work-items/${workItemId}`, { completionProgramId: programId }).then((r) => r.data),
    onSuccess: () => { setMode('view'); setError(null); invalidate() },
    onError: (e: any) => setError(e?.response?.data?.error ?? e?.message ?? 'Failed to update work item'),
  })
  const activateMut = useMutation({
    mutationFn: (programId: string) => api.patch(`/work-programs/${programId}`, { status: 'ACTIVE' }).then((r) => r.data),
    onSuccess: () => { setError(null); invalidate() },
    onError: (e: any) => setError(e?.response?.data?.error ?? e?.message ?? 'Failed to activate program'),
  })
  const createMut = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim()
      if (trimmed.length < 2) throw new Error('Program name is required')
      const keys = new Set<string>()
      const payloadSteps = steps.map((s) => {
        const stepKey = s.stepKey.trim()
        if (!stepKey) throw new Error('Every step needs a key')
        if (keys.has(stepKey)) throw new Error(`Duplicate step key ${stepKey}`)
        keys.add(stepKey)
        if (s.titleTemplate.trim().length < 3) throw new Error(`Step ${stepKey} needs a title template`)
        if (!s.targetCapabilityId) throw new Error(`Step ${stepKey} needs a target capability`)
        return {
          stepKey,
          titleTemplate: s.titleTemplate.trim(),
          targetCapabilityId: s.targetCapabilityId,
          ...(s.workflowTemplateId ? { workflowTemplateId: s.workflowTemplateId } : {}),
          routingMode: s.routingMode,
          dependsOnKeys: s.dependsOnKeys.filter((k) => keys.has(k) || steps.some((o) => o.stepKey.trim() === k)),
        }
      })
      const program = await api.post('/work-programs', { name: trimmed, description: description.trim() || undefined, status: 'ACTIVE', steps: payloadSteps }).then((r) => r.data)
      if (editable) await api.patch(`/work-items/${workItemId}`, { completionProgramId: program.id })
      return program
    },
    onSuccess: () => { setMode('view'); setError(null); setName(''); setDescription(''); setSteps([emptyStep(1)]); invalidate() },
    onError: (e: any) => setError(e?.response?.data?.error ?? e?.message ?? 'Failed to create program'),
  })

  if (itemQ.isLoading) return <div style={{ padding: 20, ...mutedText }}>Loading…</div>

  const stepKeys = steps.map((s) => s.stepKey.trim()).filter(Boolean)

  return (
    <div style={{ padding: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <Boxes size={18} color="#8b5cf6" />
        <h3 style={{ margin: 0, fontSize: 16, color: 'var(--color-on-surface)' }}>Next-stage automation</h3>
      </div>
      <p style={{ ...mutedText, margin: '0 0 14px' }}>
        Attach a Work Program. When this item finalizes (reconciliation passes → completed), the program spawns the next stage of
        work items — each bound to a workflow, linked by dependencies, and auto-routed.
      </p>

      {error && <div style={{ ...cardStyle, background: '#fee2e2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 12 }}>{error}</div>}

      {!editable && !attached && (
        <div style={{ ...cardStyle, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', fontSize: 12 }}>
          This item is <strong>{item?.status}</strong> and can no longer be edited, so a program can’t be attached now. Attach one while
          the item is scheduled or in progress, before it completes.
        </div>
      )}

      {/* Attached program */}
      <section style={cardStyle}>
        <h4 style={{ ...sectionTitle, fontSize: 13 }}>Attached Work Program</h4>
        {attached ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <GitBranch size={15} color="#8b5cf6" />
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--color-on-surface)' }}>{attached.name}</div>
                <div style={mutedText}>{attached._count?.steps ?? 0} step(s) · status {attached.status}</div>
              </div>
              {attached.status !== 'ACTIVE' && (
                <span style={{ ...pill, background: '#fef3c7', color: '#92400e' }}>{attached.status} — won’t run until ACTIVE</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {attached.status !== 'ACTIVE' && (
                <button style={secondaryButtonStyle} disabled={activateMut.isPending} onClick={() => activateMut.mutate(attached.id)}>
                  <Play size={13} /> Activate
                </button>
              )}
              {editable && (
                <>
                  <button style={secondaryButtonStyle} disabled={attachMut.isPending} onClick={() => setMode('pick')}><Link2 size={13} /> Change</button>
                  <button style={{ ...secondaryButtonStyle, color: '#991b1b' }} disabled={attachMut.isPending} onClick={() => attachMut.mutate(null)}><Unlink size={13} /> Detach</button>
                </>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <span style={mutedText}>No program attached — this item won’t spawn a next stage on completion.</span>
            {editable && mode === 'view' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={secondaryButtonStyle} onClick={() => setMode('pick')}><Link2 size={13} /> Attach existing</button>
                <button style={primaryButtonStyle} onClick={() => setMode('create')}><Plus size={13} /> Create program</button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Picker */}
      {mode === 'pick' && editable && (
        <section style={cardStyle}>
          <h4 style={{ ...sectionTitle, fontSize: 13 }}>Choose a Work Program</h4>
          {programsQ.isLoading ? (
            <p style={mutedText}>Loading programs…</p>
          ) : (programsQ.data ?? []).length === 0 ? (
            <p style={mutedText}>No Work Programs yet. Create one instead.</p>
          ) : (
            <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
              {(programsQ.data ?? []).map((p) => (
                <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 9, border: `1px solid ${pickId === p.id ? '#8b5cf6' : 'var(--color-outline-variant)'}`, cursor: 'pointer' }}>
                  <input type="radio" name="wp" checked={pickId === p.id} onChange={() => setPickId(p.id)} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-on-surface)' }}>{p.name}</div>
                    <div style={mutedText}>{p.steps?.length ?? 0} step(s) · {p.status}{p._count ? ` · ${p._count.runs} run(s)` : ''}</div>
                  </div>
                  {p.status !== 'ACTIVE' && <span style={{ ...pill, background: '#fef3c7', color: '#92400e' }}>{p.status}</span>}
                </label>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button style={secondaryButtonStyle} onClick={() => { setMode('view'); setError(null) }}>Cancel</button>
            <button style={secondaryButtonStyle} onClick={() => setMode('create')}><Plus size={13} /> New program</button>
            <button style={primaryButtonStyle} disabled={!pickId || attachMut.isPending} onClick={() => attachMut.mutate(pickId)}>
              <Link2 size={13} /> {attachMut.isPending ? 'Attaching…' : 'Attach'}
            </button>
          </div>
        </section>
      )}

      {/* Create */}
      {mode === 'create' && (
        <section style={cardStyle}>
          <h4 style={{ ...sectionTitle, fontSize: 13 }}>Create a Work Program</h4>
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={fieldLabel}>Name
              <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Build & QA stage" />
            </label>
            <label style={fieldLabel}>Description <span style={mutedText}>(optional)</span>
              <input style={inputStyle} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this stage produces" />
            </label>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--color-on-surface)' }}>Steps</span>
              <button style={secondaryButtonStyle} onClick={() => setSteps((s) => [...s, emptyStep(s.length + 1)])}><Plus size={13} /> Add step</button>
            </div>

            {steps.map((s, i) => (
              <div key={i} style={{ padding: 12, borderRadius: 10, border: '1px solid var(--color-outline-variant)', display: 'grid', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-outline)' }}>Step {i + 1}</span>
                  {steps.length > 1 && <button style={{ ...secondaryButtonStyle, padding: 6, color: '#991b1b' }} onClick={() => setSteps((arr) => arr.filter((_, j) => j !== i))}><Trash2 size={13} /></button>}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <label style={fieldLabel}>Step key
                    <input style={inputStyle} value={s.stepKey} onChange={(e) => patchStep(setSteps, i, { stepKey: e.target.value })} />
                  </label>
                  <label style={fieldLabel}>Routing
                    <select style={inputStyle} value={s.routingMode} onChange={(e) => patchStep(setSteps, i, { routingMode: e.target.value })}>
                      {ROUTING_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </label>
                </div>
                <label style={fieldLabel}>Title template <span style={mutedText}>— supports {'{{workCode}}'}, {'{{title}}'}, {'{{projectCode}}'}</span>
                  <input style={inputStyle} value={s.titleTemplate} onChange={(e) => patchStep(setSteps, i, { titleTemplate: e.target.value })} placeholder="e.g. Implement {{workCode}}" />
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <label style={fieldLabel}>Target capability
                    <select style={inputStyle} value={s.targetCapabilityId} onChange={(e) => patchStep(setSteps, i, { targetCapabilityId: e.target.value })}>
                      <option value="">Select…</option>
                      {(capsQ.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </label>
                  <label style={fieldLabel}>Workflow <span style={mutedText}>(optional)</span>
                    <select style={inputStyle} value={s.workflowTemplateId} onChange={(e) => patchStep(setSteps, i, { workflowTemplateId: e.target.value })}>
                      <option value="">None</option>
                      {(workflowsQ.data ?? []).filter((w) => !s.targetCapabilityId || !w.capabilityId || w.capabilityId === s.targetCapabilityId).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </label>
                </div>
                {stepKeys.filter((k) => k && k !== s.stepKey.trim()).length > 0 && (
                  <label style={fieldLabel}>Depends on
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                      {stepKeys.filter((k) => k && k !== s.stepKey.trim()).map((k) => {
                        const on = s.dependsOnKeys.includes(k)
                        return (
                          <button key={k} onClick={() => patchStep(setSteps, i, { dependsOnKeys: on ? s.dependsOnKeys.filter((x) => x !== k) : [...s.dependsOnKeys, k] })}
                            style={{ ...pill, cursor: 'pointer', border: '1px solid var(--color-outline-variant)', background: on ? '#8b5cf6' : 'transparent', color: on ? '#fff' : 'var(--color-outline)' }}>{k}</button>
                        )
                      })}
                    </div>
                  </label>
                )}
              </div>
            ))}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button style={secondaryButtonStyle} onClick={() => { setMode('view'); setError(null) }}>Cancel</button>
              <button style={primaryButtonStyle} disabled={createMut.isPending} onClick={() => createMut.mutate()}>
                {createMut.isPending ? 'Creating…' : (editable ? 'Create & attach' : 'Create')}
              </button>
            </div>
            {!editable && <p style={{ ...mutedText, textAlign: 'right' }}>Item isn’t editable — the program will be created but not attached.</p>}
          </div>
        </section>
      )}
    </div>
  )
}

function patchStep(setSteps: React.Dispatch<React.SetStateAction<DraftStep[]>>, index: number, patch: Partial<DraftStep>) {
  setSteps((arr) => arr.map((s, j) => (j === index ? { ...s, ...patch } : s)))
}

const fieldLabel: CSSProperties = { display: 'grid', gap: 4, fontSize: 12, fontWeight: 700, color: 'var(--color-on-surface)' }
const pill: CSSProperties = { display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' }
