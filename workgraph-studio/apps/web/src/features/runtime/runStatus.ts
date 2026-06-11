// Canonical run/node status visuals — ONE palette for every runtime surface
// (run graph, timeline, dashboard). Replaces the three per-file STATUS maps that
// had drifted (ACTIVE was green on the dashboard but sky-blue in the graph;
// COMPLETED blue vs green). Canon: in-progress = sky, done = green, failed = red,
// blocked/paused = amber, inert (draft/skipped/cancelled/pending) = slate.
//
// `fg`/`color` and `border`/`ring` are aliases so existing call sites keep their
// field names; new code should use color/ring.
import type { ElementType } from 'react'
import {
  Circle, Clock, CheckCircle2, AlertCircle, Pause, RotateCw,
} from 'lucide-react'

export type RunStatusVisual = {
  color: string; fg: string
  bg: string
  ring: string; border: string
  tagBg: string
  label: string
  Icon: ElementType
}

function v(color: string, bg: string, ring: string, label: string, Icon: ElementType): RunStatusVisual {
  return { color, fg: color, bg, ring, border: ring, tagBg: bg, label, Icon }
}

export const RUN_STATUS: Record<string, RunStatusVisual> = {
  DRAFT:     v('#64748b', 'rgba(100,116,139,0.10)', 'rgba(100,116,139,0.25)', 'Draft',     Clock),
  PENDING:   v('#64748b', '#f8fafc',                '#cbd5e1',                'Pending',   Circle),
  ACTIVE:    v('#0284c7', '#f0f9ff',                'rgba(14,165,233,0.45)',  'Active',    Clock),
  RUNNING:   v('#0284c7', '#f0f9ff',                'rgba(14,165,233,0.45)',  'Running',   Clock),
  COMPLETED: v('#16a34a', '#f0fdf4',                'rgba(34,197,94,0.40)',   'Done',      CheckCircle2),
  FAILED:    v('#dc2626', '#fef2f2',                'rgba(239,68,68,0.35)',   'Failed',    AlertCircle),
  BLOCKED:   v('#d97706', '#fffbeb',                'rgba(245,158,11,0.40)',  'Blocked',   AlertCircle),
  PAUSED:    v('#f59e0b', '#fffbeb',                'rgba(245,158,11,0.30)',  'Paused',    Pause),
  RETRYING:  v('#f59e0b', '#fffbeb',                'rgba(245,158,11,0.30)',  'Retrying',  RotateCw),
  SKIPPED:   v('#94a3b8', '#f8fafc',                'rgba(148,163,184,0.30)', 'Skipped',   Circle),
  CANCELLED: v('#64748b', 'rgba(100,116,139,0.10)', 'rgba(100,116,139,0.25)', 'Cancelled', Pause),
}

export function runStatusVisual(status: string | null | undefined): RunStatusVisual {
  return RUN_STATUS[String(status ?? '').toUpperCase()] ?? RUN_STATUS.PENDING
}
