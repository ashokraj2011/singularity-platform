import { useMemo, type CSSProperties } from 'react'
import ReactFlow, { Background, BackgroundVariant, Controls, MarkerType, type Edge, type Node } from 'reactflow'
import 'reactflow/dist/style.css'
import { secondaryButtonStyle, inputStyle, mutedText } from './workspaceStyles'

/**
 * Spec Studio diagram — renders a structured node/edge graph with reactflow (already a proven dep;
 * no client-side mermaid). Nodes are auto-laid-out by depth so authors don't drag coordinates. In
 * editable mode a compact form adds/renames/removes nodes and edges; the parent persists the graph
 * as part of the spec package.
 */

export interface DiagramNode { id: string; label: string; kind?: string }
export interface DiagramEdge { id: string; source: string; target: string; label?: string }
export interface DiagramModel { id: string; title?: string; kind?: string; nodes: DiagramNode[]; edges: DiagramEdge[] }

// Topological-ish layout: BFS depth → columns, order within a column → rows. Cycle-safe.
function layout(nodes: DiagramNode[], edges: DiagramEdge[]): Map<string, { x: number; y: number }> {
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]))
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]))
  for (const e of edges) {
    if (adj.has(e.source) && indeg.has(e.target)) { adj.get(e.source)!.push(e.target); indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1) }
  }
  const depth = new Map<string, number>()
  const roots = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id)
  const queue = roots.length ? [...roots] : nodes.slice(0, 1).map((n) => n.id)
  const seen = new Set(queue)
  queue.forEach((id) => depth.set(id, 0))
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]; const d = depth.get(id) ?? 0
    for (const t of adj.get(id) ?? []) {
      if (!depth.has(t) || (depth.get(t) ?? 0) < d + 1) depth.set(t, d + 1)
      if (!seen.has(t)) { seen.add(t); queue.push(t) }
    }
  }
  const byCol = new Map<number, string[]>()
  for (const n of nodes) { const d = depth.get(n.id) ?? 0; if (!byCol.has(d)) byCol.set(d, []); byCol.get(d)!.push(n.id) }
  const pos = new Map<string, { x: number; y: number }>()
  for (const [d, ids] of byCol) ids.forEach((id, row) => pos.set(id, { x: d * 230, y: row * 96 }))
  return pos
}

const nodeStyle: CSSProperties = {
  padding: '8px 12px', borderRadius: 10, border: '1px solid var(--color-outline-variant)',
  background: 'var(--color-surface-bright)', color: 'var(--color-on-surface)', fontSize: 12, fontWeight: 700, minWidth: 120, textAlign: 'center',
}

export function DiagramCanvas({ diagram, editable = false, onChange }: { diagram: DiagramModel; editable?: boolean; onChange?: (d: DiagramModel) => void }) {
  const rf = useMemo(() => {
    const pos = layout(diagram.nodes, diagram.edges)
    const nodes: Node[] = diagram.nodes.map((n) => ({
      id: n.id, data: { label: n.label || n.id }, position: pos.get(n.id) ?? { x: 0, y: 0 },
      sourcePosition: 'right' as any, targetPosition: 'left' as any, style: nodeStyle,
    }))
    const edges: Edge[] = diagram.edges.map((e) => ({
      id: e.id, source: e.source, target: e.target, label: e.label, type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: 'var(--color-outline)' },
    }))
    return { nodes, edges }
  }, [diagram])

  const set = (patch: Partial<DiagramModel>) => onChange?.({ ...diagram, ...patch })
  const addNode = () => set({ nodes: [...diagram.nodes, { id: `n${diagram.nodes.length + 1}`, label: `Step ${diagram.nodes.length + 1}` }] })
  const addEdge = () => {
    if (diagram.nodes.length < 2) return
    set({ edges: [...diagram.edges, { id: `e${diagram.edges.length + 1}`, source: diagram.nodes[0].id, target: diagram.nodes[1].id }] })
  }

  return (
    <div>
      <div style={{ height: 320, borderRadius: 12, border: '1px solid var(--color-outline-variant)', overflow: 'hidden', background: 'var(--color-surface-low)' }}>
        {diagram.nodes.length === 0 ? (
          <div style={{ ...mutedText, display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center' }}>No nodes yet.</div>
        ) : (
          <ReactFlow nodes={rf.nodes} edges={rf.edges} fitView proOptions={{ hideAttribution: true }} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}>
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>

      {editable && onChange && (
        <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={secondaryButtonStyle} onClick={addNode}>+ Node</button>
            <button style={secondaryButtonStyle} onClick={addEdge} disabled={diagram.nodes.length < 2}>+ Connection</button>
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ ...mutedText, fontWeight: 700 }}>Nodes</span>
            {diagram.nodes.map((n, i) => (
              <div key={n.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input style={{ ...inputStyle, width: 90, padding: '5px 7px' }} value={n.id} onChange={(e) => set({ nodes: diagram.nodes.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)) })} />
                <input style={{ ...inputStyle, padding: '5px 7px' }} value={n.label} onChange={(e) => set({ nodes: diagram.nodes.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                <button style={{ ...secondaryButtonStyle, padding: '4px 8px' }} onClick={() => set({ nodes: diagram.nodes.filter((_, j) => j !== i), edges: diagram.edges.filter((e) => e.source !== n.id && e.target !== n.id) })}>✕</button>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ ...mutedText, fontWeight: 700 }}>Connections</span>
            {diagram.edges.map((e, i) => (
              <div key={e.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <NodeSelect value={e.source} nodes={diagram.nodes} onChange={(v) => set({ edges: diagram.edges.map((x, j) => (j === i ? { ...x, source: v } : x)) })} />
                <span style={mutedText}>→</span>
                <NodeSelect value={e.target} nodes={diagram.nodes} onChange={(v) => set({ edges: diagram.edges.map((x, j) => (j === i ? { ...x, target: v } : x)) })} />
                <input style={{ ...inputStyle, width: 120, padding: '5px 7px' }} placeholder="label" value={e.label ?? ''} onChange={(ev) => set({ edges: diagram.edges.map((x, j) => (j === i ? { ...x, label: ev.target.value } : x)) })} />
                <button style={{ ...secondaryButtonStyle, padding: '4px 8px' }} onClick={() => set({ edges: diagram.edges.filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function NodeSelect({ value, nodes, onChange }: { value: string; nodes: DiagramNode[]; onChange: (v: string) => void }) {
  return (
    <select style={{ ...inputStyle, width: 110, padding: '5px 7px' }} value={value} onChange={(e) => onChange(e.target.value)}>
      {nodes.map((n) => <option key={n.id} value={n.id}>{n.id}</option>)}
    </select>
  )
}
