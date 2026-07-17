"use client";

import { useCallback } from "react";
import { usePathname } from "next/navigation";
import ReactFlow, { addEdge, applyEdgeChanges, applyNodeChanges, Background, Controls, MarkerType, MiniMap, Panel, ReactFlowProvider, type Connection, type Edge, type EdgeChange, type Node, type NodeChange } from "reactflow";
import { Box, CircleHelp, Download, GitFork, Plus, StickyNote, Trash2 } from "lucide-react";
import { SynthesisShell } from "../SynthesisShell";
import { NoProjectSelected, ProjectPicker, useSelectedProjectId } from "../ProjectPicker";
import { useLocalWorkspace } from "../hooks/useLocalWorkspace";

type DiagramState = { nodes: Node[]; edges: Edge[] };
const STARTER: DiagramState = { nodes: [
  { id: "problem", position: { x: 80, y: 90 }, data: { label: "Problem / opportunity" }, style: { border: "1px solid #60a5fa", borderRadius: 6, background: "#dbeafe", width: 180, fontWeight: 700 } },
  { id: "decision", position: { x: 360, y: 90 }, data: { label: "Key decision" }, style: { border: "1px solid #f59e0b", borderRadius: 6, background: "#fef3c7", width: 170, fontWeight: 700 } },
  { id: "outcome", position: { x: 640, y: 90 }, data: { label: "Desired outcome" }, style: { border: "1px solid #34d399", borderRadius: 6, background: "#dcfce7", width: 180, fontWeight: 700 } },
], edges: [
  { id: "problem-decision", source: "problem", target: "decision", markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#64748b" } },
  { id: "decision-outcome", source: "decision", target: "outcome", markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#64748b" } },
] };

export function DiagramWorkspaceScreen() {
  const pathname = usePathname() ?? "/synthesis/diagrams";
  const projectId = useSelectedProjectId();
  return <SynthesisShell title="System Diagrams" fullBleed headerActions={<ProjectPicker pathname={pathname} />}>{projectId ? <ReactFlowProvider><DiagramCanvas projectId={projectId} /></ReactFlowProvider> : <NoProjectSelected surface="System Diagrams" />}</SynthesisShell>;
}

function DiagramCanvas({ projectId }: { projectId: string }) {
  const [state, setState] = useLocalWorkspace<DiagramState>(`synthesis:diagram:${projectId}`, STARTER);
  const onNodesChange = useCallback((changes: NodeChange[]) => setState(current => ({ ...current, nodes: applyNodeChanges(changes, current.nodes) })), [setState]);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setState(current => ({ ...current, edges: applyEdgeChanges(changes, current.edges) })), [setState]);
  const onConnect = useCallback((connection: Connection) => setState(current => ({ ...current, edges: addEdge({ ...connection, markerEnd: { type: MarkerType.ArrowClosed } }, current.edges) })), [setState]);

  function addNode(kind: "process" | "decision" | "note") {
    const palette = kind === "decision" ? { background: "#fef3c7", border: "1px solid #f59e0b" } : kind === "note" ? { background: "#ede9fe", border: "1px solid #a78bfa" } : { background: "#dbeafe", border: "1px solid #60a5fa" };
    setState(current => ({ ...current, nodes: [...current.nodes, { id: crypto.randomUUID(), position: { x: 140 + current.nodes.length * 34, y: 180 + current.nodes.length * 28 }, data: { label: kind === "decision" ? "Decision" : kind === "note" ? "Evidence note" : "Process step" }, style: { ...palette, borderRadius: 6, width: 170, fontWeight: 700 } }] }));
  }

  function deleteSelected() { setState(current => { const ids = new Set(current.nodes.filter(node => node.selected).map(node => node.id)); return { nodes: current.nodes.filter(node => !ids.has(node.id)), edges: current.edges.filter(edge => !edge.selected && !ids.has(edge.source) && !ids.has(edge.target)) }; }); }
  function exportJson() { const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "synthesis-diagram.json"; anchor.click(); URL.revokeObjectURL(url); }

  return (
    <div className="h-full min-h-[520px] overflow-hidden border border-outline-variant bg-surface-container-lowest">
      <ReactFlow nodes={state.nodes} edges={state.edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} fitView minZoom={0.2} maxZoom={2.2} proOptions={{ hideAttribution: true }}>
        <Background gap={22} size={1} color="rgba(100,116,139,0.23)" />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap position="bottom-right" pannable zoomable maskColor="rgba(248,250,252,0.78)" />
        <Panel position="top-left"><div className="flex items-center gap-1 rounded-md border border-outline-variant bg-surface-container-lowest p-1 shadow-md"><DiagramTool icon={Box} label="Process" onClick={() => addNode("process")} /><DiagramTool icon={CircleHelp} label="Decision" onClick={() => addNode("decision")} /><DiagramTool icon={StickyNote} label="Note" onClick={() => addNode("note")} /><span className="mx-1 h-6 w-px bg-outline-variant" /><DiagramTool icon={Trash2} label="Delete" onClick={deleteSelected} /><DiagramTool icon={Download} label="Export" onClick={exportJson} /></div></Panel>
        <Panel position="top-right"><div className="inline-flex items-center gap-2 rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-2 text-xs font-semibold text-on-surface-variant shadow-sm"><GitFork size={14} className="text-secondary" /> Drag handles to connect decisions</div></Panel>
      </ReactFlow>
    </div>
  );
}

function DiagramTool({ icon: Icon, label, onClick }: { icon: typeof Plus; label: string; onClick: () => void }) { return <button type="button" onClick={onClick} className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs font-semibold text-on-surface-variant hover:bg-surface-container"><Icon size={14} /><span className="hidden sm:inline">{label}</span></button>; }
