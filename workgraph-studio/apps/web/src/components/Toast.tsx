// Dependency-free toast notifications. Mutations call toast.success/error/info;
// <Toaster /> (mounted once in App.tsx) renders them bottom-center and
// auto-dismisses. Replaces the old pattern of silent mutations where the user
// waited for the next 5s poll to learn whether anything happened.
import { useEffect, useState, type CSSProperties } from 'react'

type Kind = 'success' | 'error' | 'info'
type ToastMsg = { id: number; kind: Kind; text: string }

let nextId = 1
const listeners = new Set<(t: ToastMsg) => void>()

function emit(kind: Kind, text: string) {
  const t = { id: nextId++, kind, text: String(text ?? '').slice(0, 300) }
  listeners.forEach(l => l(t))
}

export const toast = {
  success: (text: string) => emit('success', text),
  error: (text: string) => emit('error', text),
  info: (text: string) => emit('info', text),
}

const KIND_STYLE: Record<Kind, { bg: string; border: string; color: string; icon: string }> = {
  success: { bg: '#f0fdf4', border: '#bbf7d0', color: '#15803d', icon: '✓' },
  error:   { bg: '#fef2f2', border: '#fecaca', color: '#b91c1c', icon: '✕' },
  info:    { bg: '#f0f9ff', border: '#bae6fd', color: '#0369a1', icon: 'ℹ' },
}

export function Toaster() {
  const [toasts, setToasts] = useState<ToastMsg[]>([])

  useEffect(() => {
    const onToast = (t: ToastMsg) => {
      setToasts(s => [...s.slice(-3), t]) // keep at most 4 visible
      const ttl = t.kind === 'error' ? 7000 : 3500
      window.setTimeout(() => setToasts(s => s.filter(x => x.id !== t.id)), ttl)
    }
    listeners.add(onToast)
    return () => { listeners.delete(onToast) }
  }, [])

  if (toasts.length === 0) return null
  const wrap: CSSProperties = {
    position: 'fixed', bottom: 18, left: '50%', transform: 'translateX(-50%)',
    display: 'flex', flexDirection: 'column', gap: 8, zIndex: 200, alignItems: 'center',
    pointerEvents: 'none',
  }
  return (
    <div style={wrap} aria-live="polite">
      {toasts.map(t => {
        const s = KIND_STYLE[t.kind]
        return (
          <div key={t.id} onClick={() => setToasts(x => x.filter(y => y.id !== t.id))} style={{
            pointerEvents: 'auto', cursor: 'pointer', maxWidth: 'min(560px, 90vw)',
            display: 'flex', alignItems: 'flex-start', gap: 8, padding: '9px 14px',
            borderRadius: 10, background: s.bg, border: `1px solid ${s.border}`, color: s.color,
            fontSize: 12.5, fontWeight: 600, lineHeight: 1.4, boxShadow: '0 6px 24px rgba(15,23,42,0.18)',
          }}>
            <span style={{ flexShrink: 0 }}>{s.icon}</span>
            <span style={{ wordBreak: 'break-word' }}>{t.text}</span>
          </div>
        )
      })}
    </div>
  )
}

// Pull a human-readable message out of an axios-ish error for toast.error.
export function errText(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { message?: string; error?: string } }; message?: string }
  return e?.response?.data?.message ?? e?.response?.data?.error ?? e?.message ?? fallback
}
