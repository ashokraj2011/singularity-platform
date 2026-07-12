"use client";

import Link from "next/link";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import ReactFlow, {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "reactflow";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Bot,
  Braces,
  CheckCircle2,
  ClipboardList,
  Clock,
  Cpu,
  Database,
  GitBranch,
  GitFork,
  GitMerge,
  GitPullRequest,
  HelpCircle,
  Link2,
  Network,
  Package,
  Puzzle,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Shield,
  ShieldCheck,
  Shuffle,
  Square,
  Terminal,
  Trash2,
  Upload,
  User,
  Workflow,
  Wrench,
  Zap,
} from "lucide-react";
import { asRow, asString } from "@/lib/row";
import { formatDate, shortId, unwrapWorkgraphItems, valueText, workgraphFetch } from "@/lib/workgraph";
import { NodeHelpCard } from "@/components/workflows/NodeHelpCard";

type WorkflowTemplate = {
  id: string;
  name: string;
  description?: string | null;
  status?: string | null;
  profile?: string | null;
  capabilityId?: string | null;
  workflowTypeKey?: string | null;
  currentVersion?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type DesignNode = {
  id: string;
  label?: string | null;
  nodeType?: string | null;
  nodeTypeKey?: string | null;
  config?: Record<string, unknown> | null;
  positionX?: number | null;
  positionY?: number | null;
};

type DesignEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType?: string | null;
  label?: string | null;
};

type DesignGraph = {
  phases: Record<string, unknown>[];
  nodes: DesignNode[];
  edges: DesignEdge[];
};

type WorkflowNodeData = {
  label: string;
  type: string;
  id: string;
  config?: Record<string, unknown> | null;
  onDelete: (nodeId: string) => void;
  busy: boolean;
};

const NODE_VISUAL: Record<string, { color: string; Icon: React.ElementType; label: string }> = {
  START: { color: "#2563eb", Icon: Play, label: "Start" },
  END: { color: "#64748b", Icon: Square, label: "End" },
  HUMAN_TASK: { color: "#d97706", Icon: User, label: "Human Task" },
  AGENT_TASK: { color: "#7c3aed", Icon: Bot, label: "Agent Task" },
  DIRECT_LLM_TASK: { color: "#0ea5e9", Icon: Cpu, label: "Direct LLM Task" },
  WORKBENCH_TASK: { color: "#7c3aed", Icon: Braces, label: "Workbench Task" },
  APPROVAL: { color: "#168a5b", Icon: CheckCircle2, label: "Approval" },
  DECISION_GATE: { color: "#2563eb", Icon: GitMerge, label: "Decision Gate" },
  CONSUMABLE_CREATION: { color: "#d97706", Icon: Package, label: "Create Artifact" },
  TOOL_REQUEST: { color: "#ea580c", Icon: Wrench, label: "Tool Request" },
  GIT_PUSH: { color: "#475569", Icon: GitBranch, label: "Git Push" },
  CREATE_BRANCH: { color: "#64748b", Icon: GitBranch, label: "Create Branch" },
  RAISE_PR: { color: "#0f766e", Icon: GitPullRequest, label: "Raise Pull Request" },
  CUSTOM: { color: "#64748b", Icon: Puzzle, label: "Custom Node" },
  POLICY_CHECK: { color: "#475569", Icon: Shield, label: "Policy Check" },
  TIMER: { color: "#ca8a04", Icon: Clock, label: "Timer" },
  SIGNAL_WAIT: { color: "#0891b2", Icon: Radio, label: "Signal Wait" },
  SIGNAL_EMIT: { color: "#0d9488", Icon: Network, label: "Signal Emit" },
  CALL_WORKFLOW: { color: "#8b5cf6", Icon: Workflow, label: "Sub-workflow" },
  FOREACH: { color: "#e11d48", Icon: GitFork, label: "For Each" },
  PARALLEL_FORK: { color: "#f97316", Icon: GitFork, label: "Parallel Fork" },
  PARALLEL_JOIN: { color: "#d946ef", Icon: GitMerge, label: "Parallel Join" },
  INCLUSIVE_GATEWAY: { color: "#7c3aed", Icon: Shuffle, label: "Inclusive Gateway" },
  EVENT_GATEWAY: { color: "#d97706", Icon: Zap, label: "Event Gateway" },
  DATA_SINK: { color: "#0ea5e9", Icon: Database, label: "Data Sink" },
  RUN_PYTHON: { color: "#3776ab", Icon: Terminal, label: "Run Python" },
  GOVERNANCE_GATE: { color: "#7c3aed", Icon: ShieldCheck, label: "Governance Gate" },
  VERIFIER: { color: "#0891b2", Icon: BadgeCheck, label: "Verifier" },
  EVAL_GATE: { color: "#6366f1", Icon: GitMerge, label: "Eval Gate" },
  WORK_ITEM: { color: "#0284c7", Icon: ClipboardList, label: "Work Item" },
  SET_CONTEXT: { color: "#0891b2", Icon: Braces, label: "Set Context" },
  ERROR_CATCH: { color: "#dc2626", Icon: AlertTriangle, label: "Error Catch" },
  EVENT_EMIT: { color: "#ea580c", Icon: Zap, label: "Event Emit" },
};

// Full authorable set (mirrors the Prisma NodeType enum, minus CUSTOM which is
// authored via the custom-type flow). Governance/verification/parallel/event/
// context nodes are now first-class so the canonical app can author the same
// governed workflows the runtime supports.
const NODE_TYPES = [
  "START",
  "HUMAN_TASK",
  "AGENT_TASK",
  "DIRECT_LLM_TASK",
  "WORKBENCH_TASK",
  "APPROVAL",
  "GOVERNANCE_GATE",
  "VERIFIER",
  "EVAL_GATE",
  "POLICY_CHECK",
  "DECISION_GATE",
  "INCLUSIVE_GATEWAY",
  "EVENT_GATEWAY",
  "PARALLEL_FORK",
  "PARALLEL_JOIN",
  "FOREACH",
  "TOOL_REQUEST",
  "RUN_PYTHON",
  "CREATE_BRANCH",
  "GIT_PUSH",
  "RAISE_PR",
  "CALL_WORKFLOW",
  "WORK_ITEM",
  "CONSUMABLE_CREATION",
  "DATA_SINK",
  "SET_CONTEXT",
  "SIGNAL_WAIT",
  "SIGNAL_EMIT",
  "EVENT_EMIT",
  "TIMER",
  "ERROR_CATCH",
  "END",
];

const rfNodeTypes = { workflowNode: WorkflowCanvasNode };

export function WorkflowDesigner({ workflowId }: { workflowId: string }) {
  const { data: templateData, error: templateError, mutate: reloadTemplate } = useSWR<unknown>(`/workflow-templates/${workflowId}`, (path: string) => workgraphFetch<unknown>(path));
  const { data: graphData, error: graphError, isLoading, mutate: reloadGraph } = useSWR<unknown>(`/workflow-templates/${workflowId}/design-graph`, (path: string) => workgraphFetch<unknown>(path), { refreshInterval: 15000 });
  const template = useMemo(() => normalizeWorkflowTemplate(templateData, workflowId), [templateData, workflowId]);
  const graph = useMemo(() => normalizeDesignGraph(graphData), [graphData]);
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<WorkflowNodeData>([]);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [newNodeType, setNewNodeType] = useState("HUMAN_TASK");
  const [newNodeLabel, setNewNodeLabel] = useState("");
  const [sourceNodeId, setSourceNodeId] = useState("");
  const [targetNodeId, setTargetNodeId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeConfigText, setNodeConfigText] = useState("{}");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nodes = graph.nodes;
  const edges = graph.edges;

  const editableName = name || template?.name || "";
  const editableDescription = description || template?.description || "";
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? nodes[0] ?? null;
  const selectedNodeRoute = useMemo(() => {
    try {
      const parsed = JSON.parse(nodeConfigText) as Record<string, unknown>;
      return typeof parsed?.llmRoute === "string" ? parsed.llmRoute : "";
    } catch {
      return "";
    }
  }, [nodeConfigText]);

  useEffect(() => {
    setNodeConfigText(JSON.stringify(selectedNode?.config ?? {}, null, 2));
  }, [selectedNode?.id]);

  const deleteNode = useCallback(async (nodeId: string) => {
    setBusy(nodeId);
    setError(null);
    try {
      await workgraphFetch(`/workflow-templates/${workflowId}/design/nodes/${nodeId}`, { method: "DELETE" });
      if (selectedNodeId === nodeId) setSelectedNodeId(null);
      await reloadGraph();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [reloadGraph, selectedNodeId, workflowId]);

  const computedNodes = useMemo(
    () => nodes.map((node, index): Node<WorkflowNodeData> => ({
      id: node.id,
      type: "workflowNode",
      position: {
        x: typeof node.positionX === "number" ? node.positionX : 100 + index * 220,
        y: typeof node.positionY === "number" ? node.positionY : 160,
      },
      data: {
        id: node.id,
        label: node.label ?? node.id,
        type: node.nodeType ?? node.nodeTypeKey ?? "NODE",
        config: node.config,
        onDelete: (id) => void deleteNode(id),
        busy: busy === node.id,
      },
    })),
    [busy, deleteNode, nodes],
  );

  const computedEdges = useMemo(
    () => edges.map((edge): Edge => ({
      id: edge.id,
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
      label: edge.label ?? valueText(edge.edgeType ?? "SEQUENTIAL"),
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: "#7c8a9a", strokeWidth: 2 },
      labelStyle: { fill: "#465063", fontWeight: 700, fontSize: 11 },
      labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
    })),
    [edges],
  );

  useEffect(() => {
    setFlowNodes(computedNodes);
    setFlowEdges(computedEdges);
  }, [computedEdges, computedNodes, setFlowEdges, setFlowNodes]);

  async function saveTemplate() {
    setBusy("template");
    setError(null);
    try {
      await workgraphFetch(`/workflow-templates/${workflowId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editableName.trim(),
          description: editableDescription.trim() || null,
        }),
      });
      setName("");
      setDescription("");
      await reloadTemplate();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function addNode() {
    if (!newNodeLabel.trim()) return;
    setBusy("node");
    setError(null);
    try {
      await workgraphFetch(`/workflow-templates/${workflowId}/design/nodes`, {
        method: "POST",
        headers: { "x-skip-ref-validation": "1" },
        body: JSON.stringify({
          nodeType: newNodeType,
          nodeTypeKey: newNodeType,
          label: newNodeLabel.trim(),
          config: {},
          positionX: 120 + nodes.length * 80,
          positionY: 130 + (nodes.length % 3) * 110,
        }),
      });
      setNewNodeLabel("");
      await reloadGraph();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function addEdge(source = sourceNodeId, target = targetNodeId) {
    if (!source || !target || source === target) return;
    setBusy("edge");
    setError(null);
    try {
      await workgraphFetch(`/workflow-templates/${workflowId}/design/edges`, {
        method: "POST",
        body: JSON.stringify({ sourceNodeId: source, targetNodeId: target, edgeType: "SEQUENTIAL" }),
      });
      setSourceNodeId("");
      setTargetNodeId("");
      await reloadGraph();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function deleteEdge(edgeId: string) {
    setBusy(edgeId);
    setError(null);
    try {
      await workgraphFetch(`/workflow-templates/${workflowId}/design/edges/${edgeId}`, { method: "DELETE" });
      await reloadGraph();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function saveNodeConfig() {
    if (!selectedNode) return;
    let config: Record<string, unknown>;
    try {
      const parsed = JSON.parse(nodeConfigText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Node config must be a JSON object.");
      config = parsed as Record<string, unknown>;
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setBusy(`config-${selectedNode.id}`);
    setError(null);
    try {
      await workgraphFetch(`/workflow-templates/${workflowId}/design/nodes/${selectedNode.id}`, {
        method: "PATCH",
        body: JSON.stringify({ config }),
      });
      await reloadGraph();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function setNodeLlmRoute(route: string) {
    try {
      const parsed = JSON.parse(nodeConfigText) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      if (route) parsed.llmRoute = route;
      else delete parsed.llmRoute;
      setNodeConfigText(JSON.stringify(parsed, null, 2));
    } catch {
      // The JSON editor remains the source of truth; don't overwrite invalid text.
    }
  }

  async function publish() {
    setBusy("publish");
    setError(null);
    try {
      await workgraphFetch(`/workflow-templates/${workflowId}/publish`, { method: "POST", body: "{}" });
      await reloadTemplate();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    void addEdge(connection.source, connection.target);
  }, [sourceNodeId, targetNodeId]);

  const onNodeDragStop = useCallback(async (_event: React.MouseEvent, node: Node<WorkflowNodeData>) => {
    try {
      await workgraphFetch(`/workflow-templates/${workflowId}/design/nodes/${node.id}`, {
        method: "PATCH",
        body: JSON.stringify({ positionX: Math.round(node.position.x), positionY: Math.round(node.position.y) }),
      });
      await reloadGraph();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [reloadGraph, workflowId]);

  const profile = template?.profile ?? "main";
  const isWorkbench = profile === "workbench" || nodes.some((node) => (node.nodeType ?? node.nodeTypeKey) === "WORKBENCH_TASK");

  return (
    <div style={{ maxWidth: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <Link href="/workflows/templates" className="btn-secondary"><ArrowLeft size={15} /> Back to workflows</Link>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link href="/help#workflow-nodes" className="btn-secondary"><HelpCircle size={15} /> Node guide</Link>
          {isWorkbench && <Link href="/workbench" className="btn-secondary"><Braces size={15} /> Workbench</Link>}
          <Link href={`/workflows/templates?run=${workflowId}`} className="btn-primary"><Play size={15} /> Start Workflow</Link>
          <button className="btn-secondary" type="button" onClick={() => { void reloadGraph(); void reloadTemplate(); }}><RefreshCw size={15} /> Refresh</button>
        </div>
      </div>

      <section className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <div className="label-xs" style={{ color: "var(--accent-workflow)", marginBottom: 8 }}>React Flow Workgraph Designer</div>
            <h1 className="page-header" style={{ marginBottom: 8 }}>{template?.name ?? "Workflow"}</h1>
            <p style={{ color: "var(--color-outline)", fontSize: 13, margin: 0, lineHeight: 1.5, maxWidth: 820 }}>
              {template?.description || "Pan, zoom, connect nodes, and drag to persist graph layout."}
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Badge>{template?.status ?? "DRAFT"}</Badge>
            <Badge>{profile}</Badge>
            <Badge>{template?.workflowTypeKey ?? "workflow"}</Badge>
            <Badge>{shortId(template?.capabilityId)}</Badge>
          </div>
        </div>
      </section>

      {(templateError || graphError || error) && (
        <section className="card" style={{ padding: 16, marginBottom: 16, borderColor: "rgba(185,28,28,0.28)", background: "rgba(254,242,242,0.8)" }}>
          <div style={{ fontWeight: 850, color: "#991b1b" }}>Designer action failed.</div>
          <div style={{ color: "#7f1d1d", fontSize: 13 }}>{error ?? (templateError as Error)?.message ?? (graphError as Error)?.message}</div>
        </section>
      )}

      <section style={{ display: "grid", gridTemplateColumns: "minmax(282px, 340px) minmax(0, 1fr) minmax(260px, 320px)", gap: 14, alignItems: "stretch" }}>
        <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
          <section className="card" style={{ padding: 16 }}>
            <h2 style={panelTitle}>Template</h2>
            <div style={{ display: "grid", gap: 10 }}>
              <Field label="Name"><input value={editableName} onChange={(event) => setName(event.target.value)} style={inputStyle()} /></Field>
              <Field label="Description"><textarea value={editableDescription} onChange={(event) => setDescription(event.target.value)} rows={4} style={inputStyle({ resize: "vertical" })} /></Field>
              <button className="btn-primary" type="button" disabled={busy === "template" || !editableName.trim()} onClick={() => void saveTemplate()}><Save size={14} /> Save template</button>
              {template?.status === "DRAFT" && <button className="btn-secondary" type="button" disabled={busy === "publish"} onClick={() => void publish()}><Upload size={14} /> Publish</button>}
            </div>
          </section>

          <section className="card" style={{ padding: 16 }}>
            <h2 style={panelTitle}>Add Node</h2>
            <div style={{ display: "grid", gap: 10 }}>
              <Field label="Type">
                <select value={newNodeType} onChange={(event) => setNewNodeType(event.target.value)} style={inputStyle()}>
                  {NODE_TYPES.map((type) => <option key={type} value={type}>{nodeTypeLabel(type)}</option>)}
                </select>
              </Field>
              <NodeHelpCard nodeType={newNodeType} compact />
              <Field label="Label"><input value={newNodeLabel} onChange={(event) => setNewNodeLabel(event.target.value)} placeholder="Review request" style={inputStyle()} /></Field>
              <button className="btn-primary" type="button" disabled={busy === "node" || !newNodeLabel.trim()} onClick={() => void addNode()}><Plus size={14} /> Add node</button>
            </div>
          </section>

          <section className="card" style={{ padding: 16 }}>
            <h2 style={panelTitle}>Connect Nodes</h2>
            <div style={{ display: "grid", gap: 10 }}>
              <Field label="Source"><NodeSelect nodes={nodes} value={sourceNodeId} onChange={setSourceNodeId} /></Field>
              <Field label="Target"><NodeSelect nodes={nodes} value={targetNodeId} onChange={setTargetNodeId} /></Field>
              <button className="btn-secondary" type="button" disabled={busy === "edge" || !sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId} onClick={() => void addEdge()}><Link2 size={14} /> Add edge</button>
            </div>
          </section>
        </div>

        <section className="card" style={{ padding: 0, minHeight: 660, overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "13px 14px", borderBottom: "1px solid var(--color-outline-variant)", background: "#fff" }}>
            <h2 style={{ ...panelTitle, margin: 0 }}>Design Graph</h2>
            <span style={{ color: "var(--color-outline)", fontSize: 12 }}>{nodes.length} nodes · {edges.length} edges</span>
          </div>
          {isLoading ? (
            <div style={{ color: "var(--color-outline)", padding: 18 }}>Loading graph...</div>
          ) : nodes.length === 0 ? (
            <div style={{ margin: 18, border: "1px dashed var(--color-outline-variant)", borderRadius: 8, padding: 30, textAlign: "center", color: "var(--color-outline)" }}>
              Add nodes to build this workflow.
            </div>
          ) : (
            <div style={{ width: "100%", height: 610, background: "#f8fafc" }}>
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={rfNodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                onNodeDragStop={onNodeDragStop}
                fitView
                minZoom={0.25}
                maxZoom={1.6}
                defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 2 } }}
              >
                <Background color="#cbd5e1" gap={18} />
                <MiniMap nodeColor={(node) => node.data?.type ? nodeVisual(node.data.type).color : "#94a3b8"} maskColor="rgba(246,248,248,0.72)" pannable zoomable />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>
          )}
        </section>

        <aside style={{ display: "grid", gap: 14, alignContent: "start" }}>
          <section className="card" style={{ padding: 16 }}>
            <h2 style={panelTitle}>Inspector</h2>
            {selectedNode ? (
              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <NodeIcon type={selectedNode.nodeType ?? selectedNode.nodeTypeKey ?? "NODE"} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 850, fontSize: 14, overflowWrap: "anywhere" }}>{selectedNode.label ?? selectedNode.id}</div>
                    <div style={{ color: "var(--color-outline)", fontSize: 11 }}>{nodeTypeLabel(selectedNode.nodeType ?? selectedNode.nodeTypeKey ?? "NODE")} · {shortId(selectedNode.id)}</div>
                  </div>
                </div>
                <NodeHelpCard nodeType={selectedNode.nodeType ?? selectedNode.nodeTypeKey ?? "NODE"} />
                <button className="btn-secondary text-xs" type="button" disabled={busy === selectedNode.id} onClick={() => void deleteNode(selectedNode.id)}><Trash2 size={13} /> Delete node</button>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 12, color: "var(--color-outline)" }}>
                  <div><strong>X:</strong> {selectedNode.positionX ?? 0}</div>
                  <div><strong>Y:</strong> {selectedNode.positionY ?? 0}</div>
                </div>
                {(selectedNode.nodeType ?? selectedNode.nodeTypeKey) === "AGENT_TASK" && (
                  <Field label="LLM route">
                    <select
                      style={inputStyle()}
                      value={selectedNodeRoute}
                      onChange={(event) => setNodeLlmRoute(event.target.value)}
                    >
                      <option value="">Context Fabric governed (default)</option>
                      <option value="context_fabric_direct">Context Fabric direct (no MCP / LLM Gateway)</option>
                      <option value="workgraph">WorkGraph direct (no Context Fabric)</option>
                    </select>
                  </Field>
                )}
                <Field label="Node config JSON">
                  <textarea value={nodeConfigText} onChange={(event) => setNodeConfigText(event.target.value)} rows={12} style={inputStyle({ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11, resize: "vertical" })} />
                </Field>
                <button className="btn-primary text-xs" type="button" disabled={busy === `config-${selectedNode.id}`} onClick={() => void saveNodeConfig()}><Save size={13} /> Save node config</button>
                {(selectedNode.nodeType ?? selectedNode.nodeTypeKey) === "AGENT_TASK" && <p style={{ color: "var(--color-outline)", fontSize: 11, lineHeight: 1.45, margin: 0 }}>Direct Context Fabric nodes use provider/model/baseUrl/credentialEnv from this JSON. Put only the credential environment-variable name here, never the key.</p>}
              </div>
            ) : (
              <p style={{ color: "var(--color-outline)", fontSize: 13, margin: 0 }}>Select a node on the canvas.</p>
            )}
          </section>

          <section className="card" style={{ padding: 16 }}>
            <h2 style={panelTitle}>Edges</h2>
            {edges.length === 0 ? (
              <div style={{ color: "var(--color-outline)", fontSize: 13 }}>No edges yet. Drag from one node handle to another or use Connect Nodes.</div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {edges.map((edge) => (
                  <div key={edge.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8, alignItems: "center", border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "8px 9px", background: "var(--color-surface-container)" }}>
                    <div style={{ fontSize: 12, color: "var(--color-on-surface)", overflowWrap: "anywhere" }}>
                      {nodeLabel(nodes, edge.sourceNodeId)} → {nodeLabel(nodes, edge.targetNodeId)}
                      <div style={{ color: "var(--color-outline)", fontSize: 11 }}>{valueText(edge.edgeType ?? "SEQUENTIAL")}</div>
                    </div>
                    <button className="btn-secondary text-xs" type="button" disabled={busy === edge.id} onClick={() => void deleteEdge(edge.id)} aria-label="Delete edge"><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      </section>

      <section className="card" style={{ padding: 14, marginTop: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, color: "var(--color-outline)", fontSize: 12 }}>
          <div><strong>Created:</strong> {formatDate(template?.createdAt)}</div>
          <div><strong>Updated:</strong> {formatDate(template?.updatedAt)}</div>
          <div><strong>Version:</strong> {template?.currentVersion ?? "-"}</div>
          <div><strong>ID:</strong> {workflowId}</div>
        </div>
      </section>
    </div>
  );
}

function WorkflowCanvasNode({ data, selected }: NodeProps<WorkflowNodeData>) {
  const visual = nodeVisual(data.type);
  const Icon = visual.Icon;
  return (
    <div
      style={{
        width: 214,
        border: selected ? `2px solid ${visual.color}` : "1px solid #cbd5e1",
        borderRadius: 8,
        background: "#ffffff",
        boxShadow: selected ? `0 12px 24px ${hexToRgba(visual.color, 0.18)}` : "0 6px 16px rgba(15,23,42,0.10)",
        overflow: "hidden",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: visual.color, width: 9, height: 9 }} />
      <div style={{ height: 5, background: visual.color }} />
      <div style={{ padding: 11 }}>
        <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
          <span style={{ width: 32, height: 32, borderRadius: 8, display: "grid", placeItems: "center", background: hexToRgba(visual.color, 0.12), color: visual.color, flexShrink: 0 }}>
            <Icon size={16} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 850, color: "#162033", overflowWrap: "anywhere", lineHeight: 1.25 }}>{data.label}</div>
            <div style={{ color: "#6a7486", fontSize: 10, marginTop: 3, textTransform: "uppercase", fontWeight: 800 }}>{visual.label}</div>
          </div>
          <button
            type="button"
            title="Delete node"
            disabled={data.busy}
            onClick={(event) => {
              event.stopPropagation();
              data.onDelete(data.id);
            }}
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              background: "#fff",
              display: "grid",
              placeItems: "center",
              color: "#6a7486",
              cursor: data.busy ? "not-allowed" : "pointer",
              flexShrink: 0,
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
        {data.config && Object.keys(data.config).length > 0 && (
          <div style={{ marginTop: 9, paddingTop: 8, borderTop: "1px solid #e2e8f0", fontSize: 10, color: "#64748b" }}>
            {Object.keys(data.config).slice(0, 3).join(" · ")}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: visual.color, width: 9, height: 9 }} />
    </div>
  );
}

function NodeSelect({ nodes, value, onChange }: { nodes: DesignNode[]; value: string; onChange: (value: string) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} style={inputStyle()}>
      <option value="">Choose node</option>
      {nodes.map((node) => <option key={node.id} value={node.id}>{node.label ?? node.id}</option>)}
    </select>
  );
}

function normalizeWorkflowTemplate(value: unknown, fallbackId: string): WorkflowTemplate | null {
  const row = asRow(value);
  const id = asString(row.id ?? row.templateId ?? row.template_id, fallbackId);
  if (!id) return null;
  return {
    id,
    name: asString(row.name ?? row.displayName ?? row.display_name, id),
    description: asString(row.description) || null,
    status: asString(row.status, "DRAFT"),
    profile: asString(row.profile, "main"),
    capabilityId: asString(row.capabilityId ?? row.capability_id) || null,
    workflowTypeKey: asString(row.workflowTypeKey ?? row.workflow_type_key) || null,
    currentVersion: normalizeOptionalNumber(row.currentVersion ?? row.current_version),
    createdAt: asString(row.createdAt ?? row.created_at) || null,
    updatedAt: asString(row.updatedAt ?? row.updated_at) || null,
  };
}

function normalizeDesignGraph(value: unknown): DesignGraph {
  const row = asRow(value);
  const nodes = uniqueById(unwrapWorkgraphItems<Record<string, unknown>>(row.nodes).map(normalizeDesignNode));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = uniqueById(unwrapWorkgraphItems<Record<string, unknown>>(row.edges)
    .map(normalizeDesignEdge)
    .filter((edge): edge is DesignEdge => Boolean(edge && nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId))));
  return {
    phases: unwrapWorkgraphItems<Record<string, unknown>>(row.phases),
    nodes,
    edges,
  };
}

function normalizeDesignNode(value: unknown, index: number): DesignNode | null {
  const row = asRow(value);
  const id = asString(row.id ?? row.nodeId ?? row.node_id);
  if (!id) return null;
  const nodeType = normalizeNodeType(row.nodeType ?? row.node_type ?? row.type);
  const nodeTypeKey = normalizeNodeType(row.nodeTypeKey ?? row.node_type_key ?? nodeType);
  return {
    id,
    label: asString(row.label ?? row.name, nodeTypeLabel(nodeType)),
    nodeType,
    nodeTypeKey,
    config: normalizeConfig(row.config),
    positionX: normalizePosition(row.positionX ?? row.position_x, 100 + index * 220),
    positionY: normalizePosition(row.positionY ?? row.position_y, 160),
  };
}

function normalizeDesignEdge(value: unknown): DesignEdge | null {
  const row = asRow(value);
  const sourceNodeId = asString(row.sourceNodeId ?? row.source_node_id ?? row.source);
  const targetNodeId = asString(row.targetNodeId ?? row.target_node_id ?? row.target);
  if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) return null;
  const id = asString(row.id, `${sourceNodeId}-${targetNodeId}`);
  return {
    id,
    sourceNodeId,
    targetNodeId,
    edgeType: asString(row.edgeType ?? row.edge_type ?? row.type, "SEQUENTIAL"),
    label: asString(row.label) || null,
  };
}

function normalizeNodeType(value: unknown): string {
  const type = asString(value, "HUMAN_TASK").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return type || "HUMAN_TASK";
}

function normalizeConfig(value: unknown): Record<string, unknown> {
  const row = asRow(value);
  return Object.fromEntries(Object.entries(row).filter(([key]) => key.length > 0).slice(0, 80));
}

function normalizePosition(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(asString(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), -10_000), 10_000);
}

function normalizeOptionalNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(asString(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueById<T extends { id: string }>(items: Array<T | null>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function NodeIcon({ type }: { type: string }) {
  const visual = nodeVisual(type);
  const Icon = visual.Icon;
  return (
    <span style={{ width: 36, height: 36, borderRadius: 8, display: "grid", placeItems: "center", background: hexToRgba(visual.color, 0.12), color: visual.color, flexShrink: 0 }}>
      <Icon size={17} />
    </span>
  );
}

function nodeVisual(type: string) {
  return NODE_VISUAL[type] ?? { color: "#64748b", Icon: Workflow, label: valueText(type) };
}

function nodeTypeLabel(type: string) {
  return nodeVisual(type).label;
}

function nodeLabel(nodes: DesignNode[], id: string): string {
  const node = nodes.find((candidate) => candidate.id === id);
  return node?.label ?? shortId(id);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: "grid", gap: 6 }}><span className="label-xs">{label}</span>{children}</label>;
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 10, fontWeight: 850, padding: "4px 8px", borderRadius: 6, background: "var(--color-surface-container)", color: "var(--color-outline)", border: "1px solid var(--color-outline-variant)", textTransform: "uppercase" }}>{children}</span>;
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const bigint = Number.parseInt(clean.length === 3 ? clean.split("").map((char) => char + char).join("") : clean, 16);
  if (Number.isNaN(bigint)) return `rgba(100,116,139,${alpha})`;
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

const panelTitle: React.CSSProperties = { margin: "0 0 12px", fontSize: 15, fontWeight: 850, color: "var(--color-on-surface)" };

function inputStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    width: "100%",
    minWidth: 0,
    border: "1px solid var(--color-outline-variant)",
    borderRadius: 8,
    padding: "9px 11px",
    background: "#fff",
    color: "var(--color-on-surface)",
    fontSize: 13,
    outline: "none",
    ...extra,
  };
}
