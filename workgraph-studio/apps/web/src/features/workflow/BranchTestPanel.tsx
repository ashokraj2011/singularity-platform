import { useState, useEffect, useMemo } from 'react'
import { motion } from 'motion/react'
import { useMutation } from '@tanstack/react-query'
import { Activity, X, Play, Check, AlertCircle } from 'lucide-react'
import { api } from '../../lib/api'

// ── Types ────────────────────────────────────────────────────────────────────

export type BranchTestReport = {
  edgeId:        string
  label:         string | null
  targetNodeId:  string
  priority:      number
  isDefault:     boolean
  matched:       boolean
}

export type BranchTestResponse = {
  sourceNodeType: string
  branches:       BranchTestReport[]
  firingBranchIds: string[]
  defaultBranchId: string | null
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function BranchTestPanel({
  instanceId, sourceNodeId, sourceNodeLabel, sourceNodeType,
  initialContext, branchLabels, highlightEdgeId, onClose,
  isLight, glassPanel, panelText, panelMuted, panelBdr,
}: {
  instanceId: string
  sourceNodeId: string
  sourceNodeLabel?: string
  sourceNodeType?: string
  initialContext: Record<string, unknown>
  branchLabels: Record<string, string | undefined>
  highlightEdgeId?: string | null
  onClose: () => void
  isLight: boolean
  glassPanel: (l: boolean) => React.CSSProperties
  panelText: string; panelMuted: string; panelBdr: string
}) {
  const initialJson = useMemo(() =>
    JSON.stringify(initialContext ?? {}, null, 2),
    [JSON.stringify(initialContext ?? {})],
  )
  const [jsonText, setJsonText] = useState<string>(initialJson)
  const [parseError, setParseError] = useState<string | null>(null)
  const [result, setResult] = useState<BranchTestResponse | null>(null)

  // When the source node changes, reset so the user starts fresh
  useEffect(() => {
    setJsonText(initialJson)
    setResult(null)
    setParseError(null)
  }, [sourceNodeId, initialJson])

  const evalMut = useMutation({
    mutationFn: (sampleContext: Record<string, unknown>) =>
      api.post(`/workflow-instances/${instanceId}/test-branches`, { sourceNodeId, sampleContext })
        .then(r => r.data as BranchTestResponse),
    onSuccess: data => setResult(data),
  })

  const handleEvaluate = () => {
    setParseError(null)
    let parsed: Record<string, unknown> = {}
    try {
      const v = JSON.parse(jsonText || '{}')
      if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>
      else { setParseError('Sample context must be a JSON object.'); return }
    } catch (err: any) {
      setParseError(err?.message ?? 'Invalid JSON')
      return
    }
    evalMut.mutate(parsed)
  }

  const inputSt: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: 9, borderRadius: 7,
    fontSize: 11, fontFamily: 'monospace', border: `1px solid ${panelBdr}`,
    background: isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)',
    color: panelText, outline: 'none', resize: 'vertical' as const, minHeight: 140,
  }

  return (
    <motion.div
      key="branch-test-panel"
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 16 }}
      transition={{ duration: 0.18 }}
      style={{
        position: 'absolute', right: 16, bottom: 24,
        width: 340, maxHeight: '70vh', zIndex: 28, pointerEvents: 'auto',
        ...glassPanel(isLight),
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px', borderBottom: `1px solid ${panelBdr}` }}>
        <Activity size={13} style={{ color: '#a78bfa' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 12, fontWeight: 700, color: panelText, lineHeight: 1.2 }}>Test branches</p>
          <p style={{ fontSize: 10, color: panelMuted, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sourceNodeLabel ?? sourceNodeId.slice(0, 8)}{sourceNodeType ? ` · ${sourceNodeType}` : ''}
          </p>
        </div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: panelMuted, padding: 4 }}
        >
          <X size={13} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>

        {/* Sample context */}
        <div>
          <label style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: panelMuted, display: 'block', marginBottom: 4 }}>
            Sample context (JSON)
          </label>
          <textarea
            value={jsonText}
            onChange={e => setJsonText(e.target.value)}
            spellCheck={false}
            style={inputSt}
          />
          <p style={{ fontSize: 9, color: panelMuted, marginTop: 4, lineHeight: 1.5 }}>
            Use top-level keys <code style={{ fontFamily: 'monospace' }}>_globals</code>, <code style={{ fontFamily: 'monospace' }}>_vars</code>, <code style={{ fontFamily: 'monospace' }}>_params</code> to populate variable scopes.
          </p>
        </div>

        {(parseError || evalMut.error) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 9px', borderRadius: 7, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#fca5a5', fontSize: 11 }}>
            <AlertCircle size={11} /> {parseError ?? (evalMut.error as any)?.response?.data?.error ?? 'Evaluation failed'}
          </div>
        )}

        {/* Results */}
        {result && (
          <div>
            <label style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: panelMuted, display: 'block', marginBottom: 6 }}>
              Result
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {result.branches.map(b => {
                const fires   = result.firingBranchIds.includes(b.edgeId)
                const matched = b.matched
                const labelText = b.label ?? branchLabels[b.edgeId] ?? `→ ${b.targetNodeId.slice(0, 8)}`
                const tone =
                  fires   ? { bg: 'rgba(34,197,94,0.10)',  br: 'rgba(34,197,94,0.35)',  fg: '#22c55e', tag: 'FIRES' } :
                  matched ? { bg: 'rgba(245,158,11,0.10)', br: 'rgba(245,158,11,0.35)', fg: '#f59e0b', tag: 'matches but not picked' } :
                  b.isDefault ? { bg: 'rgba(245,158,11,0.05)', br: 'rgba(245,158,11,0.20)', fg: '#94a3b8', tag: 'default' } :
                            { bg: 'transparent', br: panelBdr, fg: panelMuted, tag: 'no match' }
                const isHighlighted = highlightEdgeId && highlightEdgeId === b.edgeId
                return (
                  <div key={b.edgeId} style={{
                    display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px',
                    borderRadius: 7, background: tone.bg,
                    border: `${isHighlighted ? '2px' : '1px'} solid ${tone.br}`,
                  }}>
                    {fires
                      ? <Check size={11} style={{ color: tone.fg, flexShrink: 0 }} />
                      : <span style={{ width: 11, flexShrink: 0 }} />}
                    <span style={{ fontSize: 11, fontWeight: 600, color: panelText, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {labelText}
                    </span>
                    <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', color: tone.fg, textTransform: 'uppercase' }}>
                      {tone.tag}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '10px 14px', borderTop: `1px solid ${panelBdr}`, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={handleEvaluate}
          disabled={evalMut.isPending}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '6px 14px', borderRadius: 7, border: 'none',
            background: '#a78bfa', color: '#0f172a',
            fontSize: 11, fontWeight: 700,
            cursor: evalMut.isPending ? 'default' : 'pointer',
            opacity: evalMut.isPending ? 0.6 : 1,
          }}
        >
          <Play size={11} /> {evalMut.isPending ? 'Evaluating…' : 'Evaluate'}
        </button>
      </div>
    </motion.div>
  )
}
