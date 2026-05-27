/**
 * M84.s5 — "Block inside a block" mini-canvas for the WORKBENCH_TASK node.
 *
 * Renders the first-class workbench definition (from /api/workflow-nodes/
 * :nodeId/workbench, M84.s2) as a subgraph: an outer dashed frame
 * containing one box per stage, with forward arrows (solid) and
 * send-back arrows (dashed, curved) between them. Edge labels show the
 * artifact kinds that move along each edge.
 *
 * Read-only for now — the legacy accordion below this canvas remains
 * the edit surface. M84.s4 added a "Refresh tables" button that
 * forces re-promotion of the legacy JSON, so after the operator edits
 * the form and clicks refresh, the mini-canvas reflects the latest
 * shape immediately.
 *
 * Layout: stages auto-laid-out top-to-bottom in ordinal order when no
 * positionX/Y is set. Future iterations will let the operator drag
 * to position; today we just compute a sensible default.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'

type Stage = {
  id: string
  stageKey: string
  label: string
  agentRole: string
  ordinal: number
  positionX: number | null
  positionY: number | null
  terminal: boolean
  approvalRequired: boolean
  toolPolicy: string
  contextPolicy: string
  expectedArtifacts: Array<{ id: string; kind: string; title: string }>
}

type Edge = {
  id: string
  fromStageId: string
  toStageId: string
  kind: 'FORWARD' | 'SEND_BACK'
  label: string | null
}

type DefinitionView = {
  id: string
  name: string
  stages: Stage[]
  edges: Edge[]
}

// ─── Layout ─────────────────────────────────────────────────────────────────
// Auto-layout: stages stacked vertically, equal spacing. Operator can pin
// positions later; until then we compute from ordinal.

const STAGE_W = 240
const STAGE_H = 88
const STAGE_GAP = 56     // vertical gap between stages
const SEND_BACK_OFFSET = 60  // how far right the dashed curve bows

function layoutStages(stages: Stage[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  const sorted = [...stages].sort((a, b) => a.ordinal - b.ordinal)
  for (const s of sorted) {
    positions.set(s.id, {
      x: s.positionX ?? 100,
      y: s.positionY ?? (50 + sorted.indexOf(s) * (STAGE_H + STAGE_GAP)),
    })
  }
  return positions
}

// Compute canvas total height so the SVG sizes correctly.
function canvasHeight(stages: Stage[]): number {
  return Math.max(360, 100 + stages.length * (STAGE_H + STAGE_GAP))
}

// ─── Component ──────────────────────────────────────────────────────────────

export function WorkbenchMiniCanvas({
  nodeId,
  onSelectStage,
}: {
  nodeId: string
  onSelectStage?: (stageKey: string) => void
}): React.ReactElement {
  const { data, isLoading, error, refetch, isFetching } = useQuery<DefinitionView | null>({
    queryKey: ['workbench-definition', nodeId],
    queryFn: async () => {
      try {
        const res = await api.get(`/workflow-nodes/${encodeURIComponent(nodeId)}/workbench`)
        return res.data?.data ?? null
      } catch (err) {
        // 404 just means "not promoted yet" — show empty-state, not error.
        if ((err as { response?: { status?: number } })?.response?.status === 404) return null
        throw err
      }
    },
    staleTime: 5_000,
  })

  const positions = useMemo(() => layoutStages(data?.stages ?? []), [data?.stages])
  const height = canvasHeight(data?.stages ?? [])

  if (isLoading) {
    return (
      <div style={{ padding: 16, color: '#888', fontSize: 12, fontStyle: 'italic' }}>
        Loading workbench definition…
      </div>
    )
  }
  if (error) {
    return (
      <div style={{
        padding: 12,
        border: '1px solid #c33',
        borderRadius: 6,
        color: '#c33',
        fontSize: 12,
      }}>
        Failed to load definition: {(error as Error).message}
      </div>
    )
  }
  if (!data || data.stages.length === 0) {
    return (
      <div style={{
        padding: 24,
        border: '1px dashed #aaa',
        borderRadius: 8,
        color: '#888',
        fontSize: 13,
        textAlign: 'center',
      }}>
        <strong>No stages yet.</strong>
        <div style={{ marginTop: 6, fontSize: 12 }}>
          Add stages in the form below and they'll appear here as a graph.
        </div>
      </div>
    )
  }

  // Build artifact-kind labels per edge: look up the producer stage's
  // produced artifacts as the natural payload of a FORWARD edge. We
  // don't have explicit consumes bindings on this read path yet — the
  // operator pins those in a future iteration; for now show what the
  // producer emits.
  const stageById = new Map(data.stages.map(s => [s.id, s]))

  return (
    <div style={{
      border: '1.5px dashed #888',
      borderRadius: 10,
      padding: 16,
      background: '#fafbfc',
      marginBottom: 14,
    }}>
      {/* Header strip */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 10,
      }}>
        <div>
          <strong style={{ fontSize: 13 }}>{data.name}</strong>
          <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
            {data.stages.length} stage{data.stages.length === 1 ? '' : 's'} ·{' '}
            {data.edges.filter(e => e.kind === 'FORWARD').length} forward,{' '}
            {data.edges.filter(e => e.kind === 'SEND_BACK').length} send-back
          </div>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          style={{
            fontSize: 11,
            padding: '4px 10px',
            border: '1px solid #ccc',
            borderRadius: 4,
            background: isFetching ? '#eee' : '#fff',
            cursor: isFetching ? 'wait' : 'pointer',
          }}
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* SVG canvas */}
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${STAGE_W + 280} ${height}`}
        preserveAspectRatio="xMinYMin meet"
        style={{ display: 'block' }}
      >
        <defs>
          {/* Arrowhead for forward edges */}
          <marker id="arrow-forward" viewBox="0 -5 10 10" refX={9} markerWidth={8} markerHeight={8} orient="auto">
            <path d="M0,-5L10,0L0,5" fill="#444" />
          </marker>
          {/* Arrowhead for send-back edges */}
          <marker id="arrow-sendback" viewBox="0 -5 10 10" refX={9} markerWidth={8} markerHeight={8} orient="auto">
            <path d="M0,-5L10,0L0,5" fill="#c66" />
          </marker>
        </defs>

        {/* Edges first so stage boxes draw over them */}
        {data.edges.map(edge => {
          const from = positions.get(edge.fromStageId)
          const to = positions.get(edge.toStageId)
          if (!from || !to) return null
          const fromCx = from.x + STAGE_W / 2
          const toCx = to.x + STAGE_W / 2

          if (edge.kind === 'FORWARD') {
            // Straight line from bottom of `from` to top of `to`.
            const x1 = fromCx
            const y1 = from.y + STAGE_H
            const x2 = toCx
            const y2 = to.y
            const producerStage = stageById.get(edge.fromStageId)
            const label = (producerStage?.expectedArtifacts ?? [])
              .map(a => a.kind)
              .slice(0, 2)
              .join(', ') + (producerStage && producerStage.expectedArtifacts.length > 2 ? ', …' : '')
            return (
              <g key={edge.id}>
                <line
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke="#444"
                  strokeWidth={2}
                  markerEnd="url(#arrow-forward)"
                />
                {label && (
                  <text
                    x={(x1 + x2) / 2 + 6}
                    y={(y1 + y2) / 2}
                    fontSize={10}
                    fill="#444"
                    fontFamily="ui-monospace, monospace"
                  >
                    {label}
                  </text>
                )}
              </g>
            )
          }
          // SEND_BACK — curved dashed line bowing to the right
          const x1 = from.x + STAGE_W
          const y1 = from.y + STAGE_H / 2
          const x2 = to.x + STAGE_W
          const y2 = to.y + STAGE_H / 2
          const cpx = Math.max(x1, x2) + SEND_BACK_OFFSET
          const cpy = (y1 + y2) / 2
          const path = `M ${x1} ${y1} Q ${cpx} ${cpy} ${x2} ${y2}`
          return (
            <g key={edge.id}>
              <path
                d={path}
                stroke="#c66"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                fill="none"
                markerEnd="url(#arrow-sendback)"
              />
              <text
                x={cpx + 4}
                y={cpy}
                fontSize={9}
                fill="#c66"
                fontStyle="italic"
              >
                send-back
              </text>
            </g>
          )
        })}

        {/* Stage boxes */}
        {data.stages.map(stage => {
          const pos = positions.get(stage.id)
          if (!pos) return null
          const isClickable = Boolean(onSelectStage)
          return (
            <g
              key={stage.id}
              transform={`translate(${pos.x}, ${pos.y})`}
              onClick={() => onSelectStage?.(stage.stageKey)}
              style={{ cursor: isClickable ? 'pointer' : 'default' }}
            >
              <rect
                width={STAGE_W}
                height={STAGE_H}
                rx={6}
                ry={6}
                fill="#fff"
                stroke={stage.terminal ? '#0a7' : '#666'}
                strokeWidth={stage.terminal ? 2 : 1.5}
              />
              <text x={12} y={20} fontSize={12} fontWeight="700">
                {stage.label}
                {stage.terminal && <tspan fill="#0a7" fontSize={10}> ★</tspan>}
              </text>
              <text x={12} y={36} fontSize={10} fill="#666" fontFamily="ui-monospace, monospace">
                {stage.agentRole}
              </text>
              <text x={12} y={52} fontSize={10} fill="#888">
                {stage.toolPolicy === 'NONE' ? 'no tools'
                  : stage.toolPolicy === 'READ_ONLY' ? 'read-only'
                    : stage.toolPolicy === 'MUTATION' ? 'mutation'
                      : 'verification'}
                {' · '}
                {stage.contextPolicy.replaceAll('_', ' ').toLowerCase()}
              </text>
              <text x={12} y={70} fontSize={10} fill="#888">
                {stage.expectedArtifacts.length} artifact{stage.expectedArtifacts.length === 1 ? '' : 's'}
                {stage.approvalRequired && ' · approval ●'}
              </text>
            </g>
          )
        })}
      </svg>

      <div style={{ fontSize: 10, color: '#999', marginTop: 8 }}>
        Solid = forward · Dashed red = send-back · ★ = terminal · ● = approval gate
      </div>
    </div>
  )
}
