import { useMemo, useCallback } from 'react'
import ReactFlow, {
  Background, Controls, MiniMap,
  type Node, type NodeTypes,
  Handle, Position, useNodesState, useEdgesState,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { PageHeader } from '@/components/PageHeader'
import { StatusBadge } from '@/components/StatusBadge'
import { useCapabilities } from '@/hooks/useCapabilities'
import { capabilityTypeColor, capabilityTypeLabel } from '@/lib/format'
import type { Capability } from '@/types'

function CapNode({ data }: { data: { cap: Capability } }) {
  const { cap } = data
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-3 py-2 shadow-sm min-w-[140px] text-center">
      <Handle type="target" position={Position.Top} className="!bg-gray-300" />
      <p className="text-xs font-semibold text-gray-900">{cap.name}</p>
      <p className="font-mono text-[10px] text-gray-400 mt-0.5">{cap.capability_id}</p>
      <div className="mt-1 flex justify-center">
        <StatusBadge label={capabilityTypeLabel(cap.capability_type)} className={`text-[10px] px-1.5 py-0 ${capabilityTypeColor(cap.capability_type)}`} />
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-gray-300" />
    </div>
  )
}

const nodeTypes: NodeTypes = { capability: CapNode }

const REL_COLORS: Record<string, string> = {
  contains: '#6366f1',
  parent_child: '#8b5cf6',
  uses: '#0ea5e9',
  depends_on: '#f59e0b',
  shared_with: '#10b981',
  delivers_to: '#f472b6',
  collects_from: '#64748b',
  governed_by: '#ef4444',
}

export function CapabilityGraphPage() {
  const { data } = useCapabilities({ size: 200 })

  const initialNodes: Node[] = useMemo(() => {
    if (!data?.items) return []
    const cols = 4
    return data.items.map((cap, i) => ({
      id: cap.capability_id,
      type: 'capability',
      position: { x: (i % cols) * 220, y: Math.floor(i / cols) * 140 },
      data: { cap },
    }))
  }, [data])

  const [nodes, , onNodesChange] = useNodesState(initialNodes)
  const [edges, , onEdgesChange] = useEdgesState([])

  const onInit = useCallback(() => {}, [])

  return (
    <div className="flex flex-col h-full">
      <div className="px-8 pt-8 pb-4">
        <PageHeader title="Capability Map" subtitle="Visual map of capability relationships" />
        <div className="flex flex-wrap gap-2">
          {Object.entries(REL_COLORS).map(([type, color]) => (
            <div key={type} className="flex items-center gap-1.5">
              <div className="w-4 h-0.5 rounded" style={{ backgroundColor: color }} />
              <span className="text-xs text-gray-500">{type}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex-1 mx-8 mb-8 rounded-xl border border-gray-200 overflow-hidden bg-gray-50">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onInit={onInit}
          nodeTypes={nodeTypes}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>
    </div>
  )
}
