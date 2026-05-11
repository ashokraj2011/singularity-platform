import { useEffect, useState } from 'react'
import { Send, AlertCircle, Upload, X, FileText, Link2, ExternalLink } from 'lucide-react'
import type { FormWidget } from './types'
import { widgetHasValue } from './types'
import { uploadAttachment, attachLink, type UploadedDocument } from '../../../lib/uploadAttachment'
import { api } from '../../../lib/api'

/**
 * Runtime form fill panel — flat widget list version.  Renders the widgets
 * the designer composed and submits the values when the assignee marks
 * the work complete.
 *
 * Submission targets:
 *   task        → POST /tasks/:id/form-submission        (with `complete: true`)
 *   approval    → POST /approvals/:id/form-submission
 *   consumable  → POST /consumables/:id/form-submission
 */

export type RuntimeFormSubmitTarget =
  | { kind: 'task';       id: string }
  | { kind: 'approval';   id: string }
  | { kind: 'consumable'; id: string }

export function RuntimeWidgetForm({
  widgets, submitTo, link = {}, initialData = {}, initialAttachments = [],
  canComplete = true, onSubmitted, submitOverride, primaryLabel,
  onValuesChange, hideActions = false,
}: {
  widgets:           FormWidget[]
  submitTo:          RuntimeFormSubmitTarget
  link?:             { taskId?: string; nodeId?: string; instanceId?: string }
  initialData?:      Record<string, unknown>
  initialAttachments?: UploadedDocument[]
  canComplete?:      boolean
  onSubmitted?:      (result: { data: Record<string, unknown>; attachmentIds: string[] }) => void
  /** Browser-mode override: when set, called *instead of* posting to the API. */
  submitOverride?:   (result: { data: Record<string, unknown>; attachmentIds: string[]; complete: boolean }) => Promise<void> | void
  /** Override the primary action button label (browser mode often wants "Complete node"). */
  primaryLabel?:     string
  /** Streams the current form data + attachments out so a parent can capture
   *  them without waiting for the user to hit submit. Used by the approval
   *  modal to bundle widget values into the decide() payload. */
  onValuesChange?:   (snapshot: { data: Record<string, unknown>; attachmentIds: string[] }) => void
  /** When true, the Save draft / Submit buttons are not rendered.  The parent
   *  is then responsible for triggering completion via onValuesChange. */
  hideActions?:      boolean
}) {
  const [data,        setData]        = useState<Record<string, unknown>>(initialData)
  const [attachments, setAttachments] = useState<UploadedDocument[]>(initialAttachments)
  const [submitting,  setSubmitting]  = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  // Stream value changes up so the parent can read them without waiting for
  // submit (used by the approval modal's Approve / Reject buttons).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    onValuesChange?.({ data, attachmentIds: attachments.map(a => a.id) })
  }, [data, attachments])

  // Required-field validation (only for value-carrying widgets).
  const validate = (): string | null => {
    for (const w of widgets) {
      if (!widgetHasValue(w.type) || !w.required || !w.key) continue
      const v = data[w.key]
      const isEmpty =
        v === undefined || v === null || v === '' ||
        (Array.isArray(v) && v.length === 0) ||
        (typeof v === 'object' && v && Object.keys(v).length === 0)

      // FILE_UPLOAD's value is an array of doc ids; SIGNATURE is { name, signedAt }
      if (w.type === 'FILE_UPLOAD') {
        const ids = (v as string[] | undefined) ?? []
        if (ids.length === 0) return `"${w.label ?? w.key}" is required.`
      } else if (w.type === 'SIGNATURE') {
        const sig = v as { name?: string } | undefined
        if (!sig?.name?.trim()) return `"${w.label ?? w.key}" is required.`
      } else if (isEmpty) {
        return `"${w.label ?? w.key}" is required.`
      }
    }
    return null
  }

  const handleSubmit = async (complete: boolean) => {
    setError(null)
    if (complete) {
      const err = validate()
      if (err) { setError(err); return }
    }
    setSubmitting(true)
    const attachmentIds = attachments.map(a => a.id)
    try {
      if (submitOverride) {
        await submitOverride({ data, attachmentIds, complete })
        onSubmitted?.({ data, attachmentIds })
      } else {
        const path =
          submitTo.kind === 'task'     ? `/tasks/${submitTo.id}/form-submission` :
          submitTo.kind === 'approval' ? `/approvals/${submitTo.id}/form-submission` :
                                         `/consumables/${submitTo.id}/form-submission`
        const body = submitTo.kind === 'task'
          ? { data, attachmentIds, complete }
          : { data, attachmentIds }
        await api.post(path, body)
        onSubmitted?.({ data, attachmentIds })
      }
    } catch (err: any) {
      setError(err?.response?.data?.error ?? err?.message ?? 'Submission failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (widgets.length === 0) {
    // No designer-defined fields → still render the primary action so the
    // assignee can advance the workflow. (Save-draft is meaningless without
    // fields, so it's omitted.)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ padding: '0 0 4px 0', fontSize: 11, color: 'var(--color-outline)', fontStyle: 'italic' }}>
          No form is defined for this node — review any attachments above and mark complete to continue.
        </p>
        {error && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '8px 12px', borderRadius: 8,
            background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: 12,
          }}>
            <AlertCircle size={13} /> {error}
          </div>
        )}
        {!hideActions && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              onClick={() => handleSubmit(true)}
              disabled={submitting || (submitTo.kind === 'task' && !canComplete)}
              style={btnPrimary(submitting)}
            >
              <Send size={12} />
              {submitting ? 'Submitting…' : (primaryLabel ?? (submitTo.kind === 'task' ? 'Submit & complete' : 'Submit'))}
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {widgets.map(w => (
        <WidgetField
          key={w.id}
          widget={w}
          value={w.key ? data[w.key] : undefined}
          onChange={v => { if (w.key) setData(prev => ({ ...prev, [w.key as string]: v })) }}
          link={link}
          attachments={attachments}
          setAttachments={setAttachments}
        />
      ))}

      {error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '8px 12px', borderRadius: 8,
          background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: 12,
        }}>
          <AlertCircle size={13} /> {error}
        </div>
      )}

      {!hideActions && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {submitTo.kind === 'task' && (
            <button
              onClick={() => handleSubmit(false)}
              disabled={submitting}
              style={btnSecondary(submitting)}
            >
              Save draft
            </button>
          )}
          <button
            onClick={() => handleSubmit(true)}
            disabled={submitting || (submitTo.kind === 'task' && !canComplete)}
            style={btnPrimary(submitting)}
          >
            <Send size={12} />
            {submitting ? 'Submitting…' : (primaryLabel ?? (submitTo.kind === 'task' ? 'Submit & complete' : 'Submit'))}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Per-widget renderers ─────────────────────────────────────────────────────

function WidgetField({
  widget, value, onChange, link, attachments, setAttachments,
}: {
  widget:   FormWidget
  value:    unknown
  onChange: (v: unknown) => void
  link:     { taskId?: string; nodeId?: string; instanceId?: string }
  attachments: UploadedDocument[]
  setAttachments: React.Dispatch<React.SetStateAction<UploadedDocument[]>>
}) {
  // ── Display-only widgets ──────────────────────────────────────────────────
  if (widget.type === 'INSTRUCTIONS') {
    return (
      <div style={{
        padding: '11px 14px', borderRadius: 8,
        background: 'rgba(56,189,248,0.06)',
        border: '1px solid rgba(56,189,248,0.16)',
        fontSize: 12, color: 'var(--color-on-surface)', lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
      }}>
        {widget.content ?? ''}
      </div>
    )
  }
  if (widget.type === 'HEADING') {
    const level = widget.level ?? 2
    const fontSize = level === 1 ? 18 : level === 2 ? 14 : 12
    return (
      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize, fontWeight: 800, color: 'var(--color-on-surface)' }}>
          {widget.label ?? ''}
        </div>
      </div>
    )
  }
  if (widget.type === 'DIVIDER') {
    return <div style={{ height: 1, background: 'var(--color-outline-variant)', margin: '6px 0' }} />
  }

  // ── Input widgets ─────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 11, fontWeight: 700, color: '#334155' }}>
        {widget.label ?? widget.key}
        {widget.required && <span style={{ color: '#ef4444', marginLeft: 4 }}>*</span>}
      </label>

      {widget.type === 'SHORT_TEXT' && (
        <input
          type="text"
          value={(value as string) ?? ''}
          placeholder={widget.placeholder}
          onChange={e => onChange(e.target.value)}
          style={inputSt()}
        />
      )}
      {widget.type === 'LONG_TEXT' && (
        <textarea
          rows={widget.rows ?? 4}
          value={(value as string) ?? ''}
          placeholder={widget.placeholder}
          onChange={e => onChange(e.target.value)}
          style={{ ...inputSt(), resize: 'vertical' }}
        />
      )}
      {widget.type === 'NUMBER' && (
        <input
          type="number"
          min={widget.min} max={widget.max} step={widget.step}
          value={(value as number | undefined) ?? ''}
          onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          style={inputSt()}
        />
      )}
      {widget.type === 'DATE' && (
        <input
          type="date"
          value={(value as string) ?? ''}
          onChange={e => onChange(e.target.value)}
          style={inputSt()}
        />
      )}
      {widget.type === 'EMAIL' && (
        <input
          type="email"
          value={(value as string) ?? ''}
          placeholder={widget.placeholder ?? 'name@example.com'}
          onChange={e => onChange(e.target.value)}
          style={inputSt()}
        />
      )}
      {widget.type === 'URL' && (
        <input
          type="url"
          value={(value as string) ?? ''}
          placeholder={widget.placeholder ?? 'https://…'}
          onChange={e => onChange(e.target.value)}
          style={inputSt()}
        />
      )}
      {widget.type === 'PHONE' && (
        <input
          type="tel"
          value={(value as string) ?? ''}
          placeholder={widget.placeholder}
          onChange={e => onChange(e.target.value)}
          style={inputSt()}
        />
      )}
      {widget.type === 'BOOLEAN' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: 'var(--color-on-surface)' }}>
          <input
            type="checkbox"
            checked={!!value}
            onChange={e => onChange(e.target.checked)}
            style={{ width: 14, height: 14 }}
          />
          {widget.placeholder ?? 'Confirm'}
        </label>
      )}
      {widget.type === 'SELECT' && (
        <select
          value={(value as string) ?? ''}
          onChange={e => onChange(e.target.value)}
          style={{ ...inputSt(), cursor: 'pointer' }}
        >
          <option value="">— Select —</option>
          {(widget.options ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      {widget.type === 'MULTI_SELECT' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(widget.options ?? []).map(o => {
            const arr = (value as string[] | undefined) ?? []
            const checked = arr.includes(o.value)
            return (
              <label key={o.value} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-on-surface)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={e => {
                    const next = e.target.checked
                      ? [...arr, o.value]
                      : arr.filter(x => x !== o.value)
                    onChange(next)
                  }}
                  style={{ width: 14, height: 14 }}
                />
                {o.label}
              </label>
            )
          })}
        </div>
      )}
      {widget.type === 'CHECKLIST' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(widget.items ?? []).map(it => {
            const arr = (value as string[] | undefined) ?? []
            const checked = arr.includes(it.id)
            return (
              <label key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-on-surface)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={e => {
                    const next = e.target.checked
                      ? [...arr, it.id]
                      : arr.filter(x => x !== it.id)
                    onChange(next)
                  }}
                  style={{ width: 14, height: 14 }}
                />
                {it.label}
              </label>
            )
          })}
        </div>
      )}
      {widget.type === 'SIGNATURE' && (
        <SignatureField value={value as { name?: string; signedAt?: string }} onChange={onChange} />
      )}
      {widget.type === 'FILE_UPLOAD' && (
        <FileUploadField
          widget={widget} value={value} onChange={onChange}
          link={link}
          attachments={attachments}
          setAttachments={setAttachments}
        />
      )}

      {widget.helpText && (
        <p style={{ fontSize: 10, color: 'var(--color-outline)', marginTop: 2 }}>{widget.helpText}</p>
      )}
    </div>
  )
}

function SignatureField({
  value, onChange,
}: {
  value:    { name?: string; signedAt?: string } | undefined
  onChange: (v: { name?: string; signedAt?: string }) => void
}) {
  const sig = value ?? {}
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input
        value={sig.name ?? ''}
        placeholder="Type your name to sign…"
        onChange={e => onChange({ name: e.target.value, signedAt: new Date().toISOString() })}
        style={{ ...inputSt(), fontFamily: '"Brush Script MT", cursive', fontSize: 18, color: '#1e293b' }}
      />
      {sig.signedAt && (
        <span style={{ fontSize: 10, color: 'var(--color-outline)', whiteSpace: 'nowrap' }}>
          {new Date(sig.signedAt).toLocaleString()}
        </span>
      )}
    </div>
  )
}

function FileUploadField({
  widget, value, onChange, link, attachments, setAttachments,
}: {
  widget: FormWidget
  value:  unknown
  onChange: (v: unknown) => void
  link: { taskId?: string; nodeId?: string; instanceId?: string }
  attachments:   UploadedDocument[]
  setAttachments: React.Dispatch<React.SetStateAction<UploadedDocument[]>>
}) {
  const ownIds  = (value as string[] | undefined) ?? []
  const ownDocs = attachments.filter(a => ownIds.includes(a.id))
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl,  setLinkUrl]  = useState('')
  const [linkName, setLinkName] = useState('')
  const [linkBusy, setLinkBusy] = useState(false)
  const [linkErr,  setLinkErr]  = useState<string | null>(null)

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    for (const f of files) {
      try {
        const doc = await uploadAttachment(f, link)
        setAttachments(prev => [...prev, doc])
        onChange([...ownIds, doc.id])
      } catch (err) {
        console.error('Upload failed', err)
      }
    }
    e.target.value = ''
  }

  const submitLink = async () => {
    if (!linkUrl.trim()) return
    setLinkBusy(true); setLinkErr(null)
    try {
      const doc = await attachLink(linkUrl.trim(), { name: linkName.trim() || undefined, ...link })
      setAttachments(prev => [...prev, doc])
      onChange([...ownIds, doc.id])
      setLinkUrl(''); setLinkName(''); setLinkOpen(false)
    } catch (err: any) {
      setLinkErr(err?.response?.data?.error ?? err?.message ?? 'Failed to attach link')
    } finally {
      setLinkBusy(false)
    }
  }

  const removeOne = (id: string) => {
    onChange(ownIds.filter(x => x !== id))
    setAttachments(prev => prev.filter(a => a.id !== id))
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6 }}>
        <label style={{
          flex: 1,
          display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px',
          borderRadius: 8, border: '1px dashed var(--color-outline-variant)',
          background: '#fafafa', cursor: 'pointer', fontSize: 12, color: 'var(--color-outline)',
        }}>
          <Upload size={13} />
          <span>{widget.multiple ? 'Upload file(s)' : 'Upload file'}</span>
          <input
            type="file"
            multiple={widget.multiple}
            accept={widget.accept}
            onChange={onPick}
            style={{ display: 'none' }}
          />
        </label>
        <button
          type="button"
          onClick={() => setLinkOpen(v => !v)}
          title="Attach a link to OneDrive, SharePoint, Google Drive, Dropbox, S3, or any URL — no size limit."
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 12px', borderRadius: 8, border: '1px dashed var(--color-outline-variant)',
            background: linkOpen ? 'rgba(56,189,248,0.08)' : '#fafafa', cursor: 'pointer',
            fontSize: 12, color: linkOpen ? '#0284c7' : 'var(--color-outline)',
          }}
        >
          <Link2 size={13} /> Add link
        </button>
      </div>

      {linkOpen && (
        <div style={{
          marginTop: 6, padding: 10, borderRadius: 8,
          border: '1px solid rgba(56,189,248,0.20)', background: 'rgba(56,189,248,0.04)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <input
            type="url"
            placeholder="https://… (OneDrive, SharePoint, Google Drive, Dropbox, S3, …)"
            value={linkUrl}
            onChange={e => setLinkUrl(e.target.value)}
            style={{ ...inputSt(), fontFamily: 'monospace' }}
          />
          <input
            placeholder="Display name (optional)"
            value={linkName}
            onChange={e => setLinkName(e.target.value)}
            style={inputSt()}
          />
          {linkErr && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#b91c1c' }}>
              <AlertCircle size={11} /> {linkErr}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => { setLinkOpen(false); setLinkUrl(''); setLinkName(''); setLinkErr(null) }}
              style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--color-outline-variant)', background: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitLink}
              disabled={linkBusy || !linkUrl.trim()}
              style={{
                padding: '5px 12px', borderRadius: 6, border: 'none',
                background: 'var(--color-primary)', color: '#fff',
                fontSize: 11, fontWeight: 700,
                cursor: (linkBusy || !linkUrl.trim()) ? 'default' : 'pointer',
                opacity: (linkBusy || !linkUrl.trim()) ? 0.6 : 1,
              }}
            >
              {linkBusy ? 'Attaching…' : 'Attach link'}
            </button>
          </div>
        </div>
      )}

      {ownDocs.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {ownDocs.map(d => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 7, background: '#fff', border: '1px solid var(--color-outline-variant)' }}>
              {d.kind === 'LINK' ? <ExternalLink size={12} style={{ color: '#0ea5e9' }} /> : <FileText size={12} style={{ color: 'var(--color-outline)' }} />}
              <a
                href={d.downloadUrl}
                target="_blank" rel="noreferrer"
                style={{ flex: 1, fontSize: 11, color: 'var(--color-on-surface)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {d.name}
              </a>
              {d.kind === 'LINK' && d.provider && (
                <span style={{ fontSize: 9, fontWeight: 700, color: '#0ea5e9', background: 'rgba(14,165,233,0.10)', padding: '2px 5px', borderRadius: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  {d.provider}
                </span>
              )}
              {d.kind !== 'LINK' && typeof d.sizeBytes === 'number' && (
                <span style={{ fontSize: 10, color: 'var(--color-outline)' }}>
                  {(d.sizeBytes / 1024).toFixed(1)} KB
                </span>
              )}
              <button onClick={() => removeOne(d.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444' }}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Style helpers ────────────────────────────────────────────────────────────

function inputSt(): React.CSSProperties {
  return {
    width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 7,
    border: '1px solid var(--color-outline-variant)', fontSize: 12,
    outline: 'none', fontFamily: 'inherit', color: 'var(--color-on-surface)',
  }
}

function btnPrimary(disabled?: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 5,
    padding: '8px 14px', borderRadius: 8, border: 'none',
    background: 'var(--color-primary)', color: '#fff',
    cursor: disabled ? 'default' : 'pointer',
    fontSize: 12, fontWeight: 700,
    opacity: disabled ? 0.6 : 1,
  }
}

function btnSecondary(disabled?: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 5,
    padding: '8px 14px', borderRadius: 8,
    border: '1px solid var(--color-outline-variant)', background: '#fff',
    color: 'var(--color-outline)',
    cursor: disabled ? 'default' : 'pointer',
    fontSize: 12, fontWeight: 600,
  }
}
