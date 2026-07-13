import type { CSSProperties } from 'react'

/**
 * Shared inline styles + status colors for the Work Item workspace tabs (Specification /
 * Submissions / Reconciliation). Mirrors the idiom of WorkDetailPage.tsx — inline CSSProperties
 * over CSS-variable tokens, no Tailwind — so the tabs match the page under platform-web's build.
 */

export const cardStyle: CSSProperties = {
  padding: 14,
  borderRadius: 12,
  background: '#fff',
  border: '1px solid var(--color-outline-variant)',
  marginBottom: 14,
}

export const primaryButtonStyle: CSSProperties = {
  padding: '8px 13px',
  borderRadius: 9,
  border: 'none',
  background: '#8b5cf6',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 800,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
}

export const secondaryButtonStyle: CSSProperties = {
  padding: '8px 13px',
  borderRadius: 9,
  border: '1px solid var(--color-outline-variant)',
  background: '#fff',
  color: 'var(--color-on-surface)',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 700,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
}

export const inputStyle: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid var(--color-outline-variant)',
  fontSize: 12,
  color: 'var(--color-on-surface)',
  background: '#fff',
  boxSizing: 'border-box',
}

export const monoTextareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: 220,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  lineHeight: 1.5,
  resize: 'vertical',
}

export const preStyle: CSSProperties = {
  marginTop: 12,
  padding: 12,
  borderRadius: 10,
  background: '#0f172a',
  color: '#cbd5e1',
  overflow: 'auto',
  fontSize: 11,
  lineHeight: 1.45,
}

export const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '6px 10px',
  fontSize: 11,
  fontWeight: 800,
  color: 'var(--color-outline)',
  borderBottom: '1px solid var(--color-outline-variant)',
  whiteSpace: 'nowrap',
}

export const tdStyle: CSSProperties = {
  padding: '7px 10px',
  fontSize: 12,
  color: 'var(--color-on-surface)',
  borderBottom: '1px solid var(--color-outline-variant)',
  verticalAlign: 'top',
}

export const mutedText: CSSProperties = { fontSize: 12, color: 'var(--color-outline)' }
export const sectionTitle: CSSProperties = { margin: '0 0 10px', fontSize: 15, color: 'var(--color-on-surface)' }

type Palette = { bg: string; fg: string }
const GREEN: Palette = { bg: '#dcfce7', fg: '#166534' }
const AMBER: Palette = { bg: '#fef3c7', fg: '#92400e' }
const RED: Palette = { bg: '#fee2e2', fg: '#991b1b' }
const BLUE: Palette = { bg: '#dbeafe', fg: '#1e40af' }
const SLATE: Palette = { bg: '#e2e8f0', fg: '#334155' }
const VIOLET: Palette = { bg: '#ede9fe', fg: '#5b21b6' }

const VERDICT: Record<string, Palette> = { PASS: GREEN, PARTIAL: AMBER, FAIL: RED, NOT_APPLICABLE: SLATE, NOT_VERIFIED: BLUE }
const RUN_STATUS: Record<string, Palette> = { PASSED: GREEN, PARTIAL: AMBER, FAILED: RED, PENDING: SLATE, RUNNING: BLUE, ERROR: RED }
const SPEC_STATUS: Record<string, Palette> = { DRAFT: SLATE, IN_REVIEW: BLUE, CHANGES_REQUESTED: AMBER, APPROVED: GREEN, SUPERSEDED: SLATE, REJECTED: RED }
const SUBMISSION_STATUS: Record<string, Palette> = { RECEIVED: BLUE, REJECTED: RED, DISCOVERED: SLATE, ACCEPTED: GREEN }
const SEVERITY: Record<string, Palette> = { ERROR: RED, WARNING: AMBER, INFO: SLATE }
const TARGET_STATUS: Record<string, Palette> = { DRAFT: SLATE, PUBLISHED: VIOLET }

function paletteFor(kind: string, value: string): Palette {
  const maps: Record<string, Record<string, Palette>> = {
    verdict: VERDICT, run: RUN_STATUS, spec: SPEC_STATUS, submission: SUBMISSION_STATUS, severity: SEVERITY, target: TARGET_STATUS,
  }
  return maps[kind]?.[value] ?? SLATE
}

/** Inline style for a small status/verdict pill. `kind` selects the color map. */
export function badgeStyle(kind: 'verdict' | 'run' | 'spec' | 'submission' | 'severity' | 'target', value: string): CSSProperties {
  const { bg, fg } = paletteFor(kind, value)
  return {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 999,
    background: bg,
    color: fg,
    fontSize: 11,
    fontWeight: 800,
    whiteSpace: 'nowrap',
  }
}
