import { useState } from 'react'
import { Paperclip, X, Upload, Send, AlertCircle, FileText } from 'lucide-react'
import type { FormSection } from './sections/types'
import { SectionIcon } from './sections/SectionEditor'
import { uploadAttachment, type UploadedDocument } from '../../lib/uploadAttachment'
import { api } from '../../lib/api'

/**
 * Runtime form fill panel.  Renders the section list defined at design time
 * (`config.form.sections`) as live inputs that the assignee can complete.
 *
 * Submission targets vary by node type:
 *  - HUMAN_TASK       → POST /tasks/:id/form-submission
 *  - APPROVAL         → POST /approvals/:id/form-submission
 *  - CONSUMABLE_CREATION → POST /consumables/:id/form-submission
 *
 * Caller wires the entity id + endpoint via `submitTo`.
 */

export type RuntimeFormSubmitTarget =
  | { kind: 'task';       id: string }
  | { kind: 'approval';   id: string }
  | { kind: 'consumable'; id: string }

export function RuntimeFormPanel({
  sections,
  submitTo,
  link = {},
  initialData = {},
  initialAttachments = [],
  canComplete = true,
  onSubmitted,
}: {
  sections: FormSection[]
  submitTo: RuntimeFormSubmitTarget
  link?: { taskId?: string; nodeId?: string; instanceId?: string }
  initialData?: Record<string, unknown>
  initialAttachments?: UploadedDocument[]
  canComplete?: boolean
  onSubmitted?: (result: { data: Record<string, unknown>; attachmentIds: string[] }) => void
}) {
  const [data, setData]               = useState<Record<string, unknown>>(initialData)
  const [attachments, setAttachments] = useState<UploadedDocument[]>(initialAttachments)
  const [submitting, setSubmitting]   = useState(false)
  const [error, setError]             = useState<string | null>(null)

  const setSection = (sectionId: string, value: unknown) =>
    setData(prev => ({ ...prev, [sectionId]: value }))

  const handleSubmit = async (complete: boolean) => {
    setError(null)
    setSubmitting(true)

    // Validate required sections
    for (const s of sections) {
      if (!s.required) continue
      const v = data[s.id]
      const empty = v === undefined || v === null || v === '' ||
                    (Array.isArray(v) && v.length === 0) ||
                    (typeof v === 'object' && v && Object.keys(v as object).length === 0)
      if (empty && s.type !== 'FILE_ATTACHMENT' && s.type !== 'SIGNATURE') {
        setError(`Section "${s.title}" is required.`)
        setSubmitting(false)
        return
      }
    }

    const attachmentIds = attachments.map(a => a.id)
    const path =
      submitTo.kind === 'task'       ? `/tasks/${submitTo.id}/form-submission` :
      submitTo.kind === 'approval'   ? `/approvals/${submitTo.id}/form-submission` :
                                       `/consumables/${submitTo.id}/form-submission`

    const body =
      submitTo.kind === 'task'
        ? { data, attachmentIds, complete }
        : { data, attachmentIds }

    try {
      await api.post(path, body)
      onSubmitted?.({ data, attachmentIds })
    } catch (err: any) {
      setError(err?.response?.data?.error ?? err?.message ?? 'Submission failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (sections.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 11, color: 'var(--color-outline)', fontStyle: 'italic' }}>
        No form is defined for this node.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {sections.map((s, i) => (
        <div key={s.id} style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--color-outline-variant)', background: '#fff' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', fontFamily: 'monospace', minWidth: 18 }}>{String(i + 1).padStart(2, '0')}</span>
            <SectionIcon type={s.type} size={12} />
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-on-surface)' }}>{s.title}</span>
            {s.required && <span style={{ fontSize: 8, fontWeight: 800, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.1em' }}>required</span>}
          </div>
          {s.description && (
            <p style={{ fontSize: 11, color: '#64748b', marginBottom: 8, fontStyle: 'italic' }}>{s.description}</p>
          )}
          <FillBody section={s} value={data[s.id]} onChange={v => setSection(s.id, v)} link={link} attachments={attachments} setAttachments={setAttachments} />
        </div>
      ))}

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px', borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: 12 }}>
          <AlertCircle size={13} /> {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {submitTo.kind === 'task' && (
          <button
            onClick={() => handleSubmit(false)}
            disabled={submitting}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '8px 14px', borderRadius: 8, border: '1px solid var(--color-outline-variant)', background: '#fff', color: 'var(--color-outline)', cursor: submitting ? 'default' : 'pointer', fontSize: 12, fontWeight: 600 }}
          >
            Save draft
          </button>
        )}
        <button
          onClick={() => handleSubmit(true)}
          disabled={submitting || (submitTo.kind === 'task' && !canComplete)}
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '8px 14px', borderRadius: 8, border: 'none', background: 'var(--color-primary)', color: '#fff', cursor: submitting ? 'default' : 'pointer', fontSize: 12, fontWeight: 700, opacity: submitting ? 0.6 : 1 }}
        >
          <Send size={12} /> {submitting ? 'Submitting…' : submitTo.kind === 'task' ? 'Submit & complete' : 'Submit'}
        </button>
      </div>
    </div>
  )
}

// ── Per-section fill bodies ──────────────────────────────────────────────────

function FillBody({
  section, value, onChange, link, attachments, setAttachments,
}: {
  section: FormSection
  value: unknown
  onChange: (v: unknown) => void
  link: { taskId?: string; nodeId?: string; instanceId?: string }
  attachments: UploadedDocument[]
  setAttachments: React.Dispatch<React.SetStateAction<UploadedDocument[]>>
}) {
  const inputBase: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 7,
    border: '1px solid var(--color-outline-variant)', fontSize: 12,
    outline: 'none', fontFamily: 'inherit', color: 'var(--color-on-surface)',
  }

  switch (section.type) {

    // RICH_TEXT — multi-line free-form text
    case 'RICH_TEXT':
      return (
        <textarea
          rows={4}
          value={(value as string) ?? ''}
          placeholder={section.placeholder ?? 'Enter content…'}
          onChange={e => onChange(e.target.value)}
          style={{ ...inputBase, resize: 'vertical' }}
        />
      )

    // CODE_BLOCK — monospace textarea
    case 'CODE_BLOCK':
      return (
        <textarea
          rows={6}
          value={(value as string) ?? section.placeholder ?? ''}
          placeholder={section.placeholder ?? '// code'}
          onChange={e => onChange(e.target.value)}
          style={{ ...inputBase, resize: 'vertical', fontFamily: 'monospace', fontSize: 11, background: '#0f172a', color: '#e2e8f0', borderColor: '#334155' }}
        />
      )

    // STRUCTURED_FIELDS — typed inputs per field
    case 'STRUCTURED_FIELDS': {
      const obj = (value as Record<string, unknown>) ?? {}
      const set = (k: string, v: unknown) => onChange({ ...obj, [k]: v })
      const fields = section.fields ?? []
      if (fields.length === 0) {
        return <p style={{ fontSize: 11, color: 'var(--color-outline)', fontStyle: 'italic' }}>No fields defined.</p>
      }
      return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {fields.map(f => (
            <div key={f.key} style={{ gridColumn: f.type === 'boolean' ? 'span 2' : undefined }}>
              <label style={{ display: 'block', fontSize: 9, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>
                {f.label}{f.required ? ' *' : ''}
              </label>
              {f.type === 'boolean' ? (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-on-surface)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!obj[f.key]} onChange={e => set(f.key, e.target.checked)} />
                  {f.label}
                </label>
              ) : f.type === 'enum' && Array.isArray(f.options) ? (
                <select value={(obj[f.key] as string) ?? ''} onChange={e => set(f.key, e.target.value)} style={{ ...inputBase, cursor: 'pointer' }}>
                  <option value="">— Select —</option>
                  {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : 'text'}
                  value={(obj[f.key] as string | number | undefined) ?? ''}
                  onChange={e => set(f.key, f.type === 'number' ? Number(e.target.value) : e.target.value)}
                  style={inputBase}
                />
              )}
            </div>
          ))}
        </div>
      )
    }

    // TABLE — add/remove rows; columns from design-time
    case 'TABLE': {
      const cols = section.columns ?? []
      const rows = (value as Record<string, string>[]) ?? []
      const addRow = () => onChange([...rows, Object.fromEntries(cols.map(c => [c, '']))])
      const setCell = (i: number, c: string, v: string) =>
        onChange(rows.map((r, idx) => idx === i ? { ...r, [c]: v } : r))
      const removeRow = (i: number) => onChange(rows.filter((_, idx) => idx !== i))
      if (cols.length === 0) return <p style={{ fontSize: 11, color: 'var(--color-outline)', fontStyle: 'italic' }}>No columns defined.</p>
      return (
        <div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: '#f1f5f9' }}>
                {cols.map(c => <th key={c} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 700, color: '#475569', border: '1px solid #e2e8f0' }}>{c}</th>)}
                <th style={{ width: 28, border: '1px solid #e2e8f0' }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {cols.map(c => (
                    <td key={c} style={{ padding: 0, border: '1px solid #e2e8f0' }}>
                      <input value={r[c] ?? ''} onChange={e => setCell(i, c, e.target.value)} style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: 'none', outline: 'none', fontSize: 11, background: 'transparent' }} />
                    </td>
                  ))}
                  <td style={{ textAlign: 'center', border: '1px solid #e2e8f0' }}>
                    <button onClick={() => removeRow(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 4 }}><X size={11} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={addRow} style={{ marginTop: 6, padding: '5px 10px', borderRadius: 7, border: '1px dashed var(--color-outline-variant)', background: 'transparent', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: 'var(--color-primary)' }}>+ Add row</button>
        </div>
      )
    }

    // CHECKLIST — checkboxes per item; value is array of checked ids
    case 'CHECKLIST': {
      const checked = (value as string[]) ?? []
      const toggle = (id: string) =>
        onChange(checked.includes(id) ? checked.filter(x => x !== id) : [...checked, id])
      const items = section.items ?? []
      if (items.length === 0) return <p style={{ fontSize: 11, color: 'var(--color-outline)', fontStyle: 'italic' }}>No items defined.</p>
      return (
        <div>
          {items.map(it => (
            <label key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', cursor: 'pointer' }}>
              <input type="checkbox" checked={checked.includes(it.id)} onChange={() => toggle(it.id)} style={{ width: 14, height: 14 }} />
              <span style={{ fontSize: 12, color: 'var(--color-on-surface)' }}>{it.label}</span>
            </label>
          ))}
        </div>
      )
    }

    // SIGNATURE — typed name + auto-stamped timestamp on submit
    case 'SIGNATURE': {
      const sig = (value as { name?: string; signedAt?: string }) ?? {}
      const setSig = (patch: Partial<typeof sig>) =>
        onChange({ ...sig, ...patch, signedAt: new Date().toISOString() })
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            value={sig.name ?? ''}
            placeholder="Type your name to sign…"
            onChange={e => setSig({ name: e.target.value })}
            style={{ ...inputBase, fontFamily: '"Brush Script MT", cursive', fontSize: 18, color: '#1e293b' }}
          />
          {sig.signedAt && (
            <span style={{ fontSize: 10, color: 'var(--color-outline)', whiteSpace: 'nowrap' }}>
              {new Date(sig.signedAt).toLocaleString()}
            </span>
          )}
        </div>
      )
    }

    // FILE_ATTACHMENT — upload helper, store IDs in section.value as string[]
    case 'FILE_ATTACHMENT': {
      const ownIds = (value as string[]) ?? []
      const ownDocs = attachments.filter(a => ownIds.includes(a.id))

      const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? [])
        for (const f of files) {
          try {
            const doc = await uploadAttachment(f, link)
            setAttachments(prev => [...prev, doc])
            onChange([...(value as string[] ?? []), doc.id])
          } catch (err) {
            console.error('Upload failed', err)
          }
        }
        e.target.value = ''
      }

      const removeAttachment = (id: string) => {
        onChange((value as string[] ?? []).filter(x => x !== id))
        setAttachments(prev => prev.filter(a => a.id !== id))
      }

      return (
        <div>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px',
            borderRadius: 8, border: '1px dashed var(--color-outline-variant)',
            background: '#fafafa', cursor: 'pointer', fontSize: 12, color: 'var(--color-outline)',
          }}>
            <Upload size={13} />
            <span>Click to upload (max 25 MB)</span>
            <input type="file" multiple onChange={onPick} style={{ display: 'none' }} />
          </label>
          {ownDocs.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {ownDocs.map(d => (
                <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 7, background: '#fff', border: '1px solid var(--color-outline-variant)' }}>
                  <FileText size={12} style={{ color: 'var(--color-outline)' }} />
                  <a href={d.downloadUrl} target="_blank" rel="noreferrer" style={{ flex: 1, fontSize: 11, color: 'var(--color-on-surface)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.name}
                  </a>
                  <span style={{ fontSize: 10, color: 'var(--color-outline)' }}>{typeof d.sizeBytes === 'number' ? `${(d.sizeBytes / 1024).toFixed(1)} KB` : ''}</span>
                  <button onClick={() => removeAttachment(d.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444' }}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {ownDocs.length === 0 && (
            <p style={{ marginTop: 6, fontSize: 11, color: 'var(--color-outline)', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 5 }}>
              <Paperclip size={11} /> No files attached yet.
            </p>
          )}
        </div>
      )
    }
  }
}
