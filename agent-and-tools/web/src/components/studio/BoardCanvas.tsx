"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import ReactFlow, {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type OnSelectionChangeParams,
} from "reactflow";
import {
  Check,
  Copy,
  FileText,
  Frame,
  Link2,
  Loader2,
  MessageSquarePlus,
  MousePointer2,
  Plus,
  Send,
  Sparkles,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import { workgraphFetch } from "@/lib/workgraph";
import { usePresence } from "./usePresence";
import { PresenceBar } from "./PresenceBar";
import { useBoardDoc, type BoardObj } from "./useBoardDoc";
import { useBoardProducer } from "./useBoardProducer";
import type { BoardSynthesisResult, SynthesisInsight } from "@/components/synthesis/types";

const COLORS = ["#fef3c7", "#dbeafe", "#dcfce7", "#ffe4e6", "#ede9fe", "#f1f5f9"];
const STRUCTURAL_TYPES = new Set(["connector", "frame"]);
const CLAIM_TYPES = new Set(["MARKET", "USER", "OPERATIONAL", "TECHNICAL"]);
const IDEA_CATEGORIES = ["USER", "MARKET", "OPERATIONAL", "TECHNICAL"] as const;

type CanvasMode = "project" | "ideas";
type CanvasNodeData = {
  object: BoardObj;
  readOnly: boolean;
  onEdit: (id: string, patch: Record<string, unknown>) => void;
};

export function BoardCanvas({
  projectId,
  boardId,
  mode = "project",
}: {
  projectId: string;
  boardId: string;
  mode?: CanvasMode;
}) {
  return (
    <ReactFlowProvider>
      <BoardCanvasInner projectId={projectId} boardId={boardId} mode={mode} />
    </ReactFlowProvider>
  );
}

function BoardCanvasInner({ projectId, boardId, mode }: { projectId: string; boardId: string; mode: CanvasMode }) {
  const producer = useBoardProducer(boardId);
  const { ready, objects, createObject, moveObject, editObject, deleteObject } = useBoardDoc(projectId, boardId, producer.emit);
  const present = usePresence(projectId, `board:${boardId}`);
  const flow = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [head, setHead] = useState(0);
  const [atSeq, setAtSeq] = useState<number | null>(null);
  const [pastObjects, setPastObjects] = useState<BoardObj[]>([]);
  const [synthesis, setSynthesis] = useState<BoardSynthesisResult | null>(null);
  const [synthesisOpen, setSynthesisOpen] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isPast = atSeq !== null && atSeq < head;
  const shown = isPast ? pastObjects : objects;

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const state = await workgraphFetch<{ headEventSeq: number }>(`/studio/boards/${boardId}/state`);
        if (active && typeof state.headEventSeq === "number") setHead(state.headEventSeq);
      } catch {
        // The live CRDT remains usable while the durable cursor catches up.
      }
      if (active) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [boardId]);

  useEffect(() => {
    if (atSeq === null) return;
    let active = true;
    workgraphFetch<{ objects: BoardObj[] }>(`/studio/boards/${boardId}/state?at=${atSeq}`)
      .then(state => { if (active) setPastObjects(state.objects ?? []); })
      .catch(() => { if (active) setPastObjects([]); });
    return () => { active = false; };
  }, [boardId, atSeq]);

  const edit = useCallback((id: string, patch: Record<string, unknown>) => {
    if (!isPast) editObject(id, patch);
  }, [editObject, isPast]);

  useEffect(() => {
    const nextNodes: Node<CanvasNodeData>[] = shown
      .filter(object => String(object.type ?? "sticky") !== "connector")
      .map(object => {
        const position = positionOf(object);
        const type = String(object.type ?? "sticky");
        return {
          id: object.id,
          type: type === "frame" ? "ideaFrame" : type === "synthesis" ? "synthesis" : "idea",
          position,
          data: { object, readOnly: isPast, onEdit: edit },
          selected: selection.includes(object.id),
          draggable: !isPast,
          selectable: true,
          zIndex: type === "frame" ? -10 : type === "synthesis" ? 4 : 2,
          style: {
            width: numberOf(object.width, type === "frame" ? 520 : type === "synthesis" ? 280 : 220),
            height: numberOf(object.height, type === "frame" ? 320 : type === "synthesis" ? 172 : 148),
          },
        };
      });
    setNodes(nextNodes);

    const known = new Set(nextNodes.map(node => node.id));
    const nextEdges: Edge[] = shown
      .filter(object => String(object.type) === "connector")
      .filter(object => known.has(String(object.sourceId)) && known.has(String(object.targetId)))
      .map(object => ({
        id: object.id,
        source: String(object.sourceId),
        target: String(object.targetId),
        label: typeof object.label === "string" ? object.label : undefined,
        markerEnd: { type: MarkerType.ArrowClosed, color: "#64748b" },
        style: { stroke: "#64748b", strokeWidth: 1.5 },
        labelStyle: { fontSize: 10, fill: "#475569" },
      }));
    setEdges(nextEdges);
  }, [shown, isPast, edit, selection, setNodes, setEdges]);

  const contentObjects = useMemo(
    () => shown.filter(object => !STRUCTURAL_TYPES.has(String(object.type ?? "sticky")) && String(object.type) !== "synthesis"),
    [shown],
  );
  const selectedContent = contentObjects.filter(object => selection.includes(object.id));

  const addObject = useCallback((type: "sticky" | "text" | "frame") => {
    if (isPast) return;
    const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const id = crypto.randomUUID();
    createObject({
      id,
      type,
      x: Math.round(center.x - (type === "frame" ? 260 : 110)),
      y: Math.round(center.y - (type === "frame" ? 160 : 74)),
      text: type === "frame" ? "Theme area" : "",
      ...(type === "frame" ? {} : { category: "USER" }),
      color: type === "frame" ? "#e2e8f0" : COLORS[Math.floor(Math.random() * COLORS.length)]!,
      width: type === "frame" ? 520 : 220,
      height: type === "frame" ? 320 : 148,
    });
    window.setTimeout(() => flow.fitView({ padding: 0.25, duration: 240 }), 60);
  }, [createObject, flow, isPast]);

  const connectSelected = useCallback(() => {
    if (isPast || selection.length !== 2) return;
    createObject({
      id: crypto.randomUUID(),
      type: "connector",
      x: 0,
      y: 0,
      sourceId: selection[0],
      targetId: selection[1],
    });
    setNotice("Ideas connected.");
  }, [createObject, isPast, selection]);

  const deleteSelected = useCallback(() => {
    if (isPast || !selection.length) return;
    const selectedSet = new Set(selection);
    for (const object of shown) {
      if (selectedSet.has(object.id) || (String(object.type) === "connector" && (selectedSet.has(String(object.sourceId)) || selectedSet.has(String(object.targetId))))) {
        deleteObject(object.id);
      }
    }
    setSelection([]);
  }, [deleteObject, isPast, selection, shown]);

  const duplicateSelected = useCallback(() => {
    if (isPast || selectedContent.length !== 1) return;
    const source = selectedContent[0]!;
    createObject({ ...source, id: crypto.randomUUID(), x: positionOf(source).x + 28, y: positionOf(source).y + 28, promotedClaimId: undefined });
  }, [createObject, isPast, selectedContent]);

  const recolorSelected = useCallback((color: string) => {
    if (isPast) return;
    selection.forEach(id => editObject(id, { color }));
  }, [editObject, isPast, selection]);

  async function runSynthesis() {
    if (synthesizing || !contentObjects.length) return;
    setSynthesizing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await workgraphFetch<BoardSynthesisResult>(`/studio/boards/${boardId}/synthesize`, {
        method: "POST",
        body: JSON.stringify({
          ...(selectedContent.length ? { objectIds: selectedContent.map(object => object.id) } : {}),
          maxThemes: 6,
          includeTensions: true,
          includeOpportunities: true,
        }),
      });
      setSynthesis(result);
      setSynthesisOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Synthesis failed.");
    } finally {
      setSynthesizing(false);
    }
  }

  function placeSynthesis() {
    if (!synthesis || isPast) return;
    const insights = [...synthesis.themes, ...synthesis.tensions, ...synthesis.opportunities];
    const maxX = Math.max(0, ...shown.filter(object => String(object.type) !== "connector").map(object => positionOf(object).x + numberOf(object.width, 220)));
    insights.forEach((insight, index) => {
      const id = crypto.randomUUID();
      createObject({
        id,
        type: "synthesis",
        x: maxX + 140 + Math.floor(index / 4) * 330,
        y: 80 + (index % 4) * 205,
        title: insight.title,
        text: insight.summary,
        synthesisKind: insight.kind,
        sourceIds: insight.sourceIds,
        keywords: insight.keywords,
        confidence: insight.confidence,
        color: insight.kind === "THEME" ? "#dbeafe" : insight.kind === "TENSION" ? "#ffe4e6" : "#dcfce7",
        width: 280,
        height: 172,
      });
      insight.sourceIds.slice(0, 12).forEach(sourceId => createObject({
        id: crypto.randomUUID(),
        type: "connector",
        x: 0,
        y: 0,
        sourceId,
        targetId: id,
        label: "synthesized into",
      }));
    });
    setSynthesisOpen(false);
    setNotice(`${insights.length} synthesis cards placed with source links.`);
    window.setTimeout(() => flow.fitView({ padding: 0.18, duration: 420 }), 100);
  }

  async function promoteToClaims() {
    const candidates = selectedContent.filter(object => !object.promotedClaimId);
    if (!candidates.length || promoting) return;
    setPromoting(true);
    setError(null);
    setNotice(null);
    try {
      const rooms = await workgraphFetch<{ items: Array<{ id: string; title: string }> }>(`/studio/projects/${projectId}/rooms`);
      let room = rooms.items.find(item => item.title === "Idea Board");
      if (!room) {
        room = await workgraphFetch<{ id: string; title: string }>(`/studio/projects/${projectId}/rooms`, {
          method: "POST",
          body: JSON.stringify({ title: "Idea Board" }),
        });
      }
      for (const object of candidates) {
        const statement = objectText(object);
        if (!statement) continue;
        const category = String(object.category ?? "TECHNICAL").toUpperCase();
        const claim = await workgraphFetch<{ id: string }>(`/studio/projects/${projectId}/claims`, {
          method: "POST",
          body: JSON.stringify({
            roomId: room.id,
            statement,
            claimType: CLAIM_TYPES.has(category) ? category : "TECHNICAL",
            initialEstimate: 0.5,
            provenance: { origin: "idea-board", boardId, objectId: object.id },
          }),
        });
        editObject(object.id, { promotedClaimId: claim.id, promotedAt: new Date().toISOString() });
      }
      setNotice(`${candidates.length} idea${candidates.length === 1 ? "" : "s"} promoted to governed claims.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not promote the selected ideas.");
    } finally {
      setPromoting(false);
    }
  }

  const onSelectionChange = useCallback(({ nodes: selectedNodes }: OnSelectionChangeParams) => {
    setSelection(selectedNodes.map(node => node.id));
  }, []);

  return (
    <section className="relative overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest shadow-sm">
      <div className="flex min-h-14 flex-wrap items-center gap-2 border-b border-outline-variant bg-surface-container-lowest px-3 py-2">
        <div className="mr-1 flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${ready ? "bg-secondary" : "bg-outline"}`} />
          <span className="font-display text-sm font-semibold text-on-surface">{mode === "ideas" ? "Idea Board" : "Board"}</span>
          <span className="font-mono text-[10px] uppercase text-on-surface-variant">{shown.length} objects</span>
        </div>
        <ToolButton icon={MousePointer2} label="Select" active />
        <ToolButton icon={StickyNote} label="Sticky" onClick={() => addObject("sticky")} disabled={isPast} />
        <ToolButton icon={MessageSquarePlus} label="Text" onClick={() => addObject("text")} disabled={isPast} />
        <ToolButton icon={Frame} label="Frame" onClick={() => addObject("frame")} disabled={isPast} />
        <span className="mx-1 h-6 w-px bg-outline-variant" />
        <ToolButton icon={Link2} label="Connect" onClick={connectSelected} disabled={isPast || selection.length !== 2} />
        <ToolButton icon={Copy} label="Duplicate" onClick={duplicateSelected} disabled={isPast || selectedContent.length !== 1} />
        <ToolButton icon={Trash2} label="Delete" onClick={deleteSelected} disabled={isPast || !selection.length} danger />
        {selection.length > 0 ? (
          <div className="ml-1 flex items-center gap-1 rounded-md border border-outline-variant bg-surface px-1.5 py-1" aria-label="Card color">
            {COLORS.map(color => <button key={color} type="button" onClick={() => recolorSelected(color)} className="h-4 w-4 rounded-sm border border-black/10" style={{ background: color }} title={`Set color ${color}`} />)}
          </div>
        ) : null}
        {mode === "ideas" ? (
          <div className="ml-auto flex items-center gap-2">
            <button type="button" className="btn-secondary h-9 text-xs" onClick={promoteToClaims} disabled={!selectedContent.length || promoting || isPast} title="Turn selected notes into governed claims with board provenance">
              {promoting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Promote
            </button>
            <button type="button" className="btn-primary h-9 text-xs" onClick={runSynthesis} disabled={!contentObjects.length || synthesizing}>
              {synthesizing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Synthesize
            </button>
          </div>
        ) : <div className="ml-auto"><PresenceBar present={present} /></div>}
      </div>

      {isPast ? <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">Viewing event {atSeq} of {head}. This state is read-only.</div> : null}
      {error ? <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-800"><X size={13} />{error}<button className="ml-auto" onClick={() => setError(null)} aria-label="Dismiss error"><X size={13} /></button></div> : null}
      {notice ? <div className="flex items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-800"><Check size={13} />{notice}<button className="ml-auto" onClick={() => setNotice(null)} aria-label="Dismiss message"><X size={13} /></button></div> : null}

      <div className="relative h-[min(720px,calc(100vh-220px))] min-h-[520px] bg-surface-container-low">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={(_, node) => moveObject(node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) })}
          onSelectionChange={onSelectionChange}
          onDoubleClick={event => {
            if (isPast || (event.target as HTMLElement).closest(".react-flow__node")) return;
            const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
            createObject({
              id: crypto.randomUUID(),
              type: "sticky",
              x: Math.round(position.x - 110),
              y: Math.round(position.y - 74),
              text: "",
              category: "USER",
              color: COLORS[0],
              width: 220,
              height: 148,
            });
          }}
          selectionOnDrag
          multiSelectionKeyCode="Shift"
          panOnScroll
          panOnDrag={[1, 2]}
          zoomOnDoubleClick={false}
          fitView
          minZoom={0.2}
          maxZoom={2.2}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} color="rgba(100,116,139,0.22)" />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeColor={node => colorOf(node.data?.object as BoardObj | undefined)}
            maskColor="rgba(248,250,252,0.72)"
          />
          {mode === "ideas" ? <Panel position="top-right"><PresenceBar present={present} /></Panel> : null}
        </ReactFlow>

        {shown.filter(object => String(object.type) !== "connector").length === 0 ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="pointer-events-auto flex flex-col items-center rounded-lg border border-outline-variant bg-surface/95 px-8 py-7 text-center shadow-sm">
              <StickyNote size={24} className="text-secondary" />
              <h3 className="mt-3 font-display text-base font-semibold text-on-surface">Start with one thought</h3>
              <button type="button" onClick={() => addObject("sticky")} className="btn-primary mt-4 text-xs"><Plus size={14} /> Add sticky</button>
            </div>
          </div>
        ) : null}

        {synthesisOpen && synthesis ? (
          <SynthesisDrawer result={synthesis} onClose={() => setSynthesisOpen(false)} onPlace={placeSynthesis} projectId={projectId} />
        ) : null}
      </div>

      <div className="flex min-h-11 items-center gap-3 border-t border-outline-variant bg-surface-container-lowest px-4 py-2">
        <span className="font-mono text-[10px] uppercase text-on-surface-variant">Timeline</span>
        <input type="range" min={0} max={head} value={atSeq ?? head} onChange={event => { const value = Number(event.target.value); setAtSeq(value >= head ? null : value); }} className="min-w-32 flex-1" disabled={head === 0} />
        <span className="min-w-20 text-right font-mono text-[10px] text-on-surface-variant">{isPast ? `${atSeq} / ${head}` : `live · ${head}`}</span>
        {isPast ? <button type="button" className="btn-secondary h-8 text-xs" onClick={() => setAtSeq(null)}>Back to live</button> : null}
      </div>
    </section>
  );
}

function IdeaNode({ data, selected }: NodeProps<CanvasNodeData>) {
  const object = data.object;
  const [text, setText] = useState(objectText(object));
  useEffect(() => setText(objectText(object)), [object]);
  const promoted = typeof object.promotedClaimId === "string";
  return (
    <div className={`h-full w-full rounded-md border p-3 shadow-sm transition-shadow ${selected ? "border-secondary ring-2 ring-secondary/25" : "border-black/10"}`} style={{ background: colorOf(object) }}>
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-outline" />
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-outline" />
      <textarea
        value={text}
        readOnly={data.readOnly}
        onChange={event => setText(event.target.value)}
        onBlur={() => { if (!data.readOnly && text !== objectText(object)) data.onEdit(object.id, { text }); }}
        className="nodrag nowheel h-[92px] w-full resize-none border-0 bg-transparent text-[13px] leading-5 text-slate-900 outline-none placeholder:text-slate-500"
        placeholder="Add an idea…"
      />
      <div className="mt-1 flex items-center justify-between gap-2 text-[9px] font-bold uppercase tracking-wide text-slate-600/75">
        <select
          value={String(object.category ?? "USER")}
          disabled={data.readOnly}
          onChange={event => data.onEdit(object.id, { category: event.target.value })}
          aria-label="Idea category"
          className="nodrag nowheel max-w-[118px] cursor-pointer border-0 bg-transparent p-0 text-[9px] font-bold uppercase text-slate-600 outline-none disabled:cursor-default"
        >
          {IDEA_CATEGORIES.map(category => <option key={category} value={category}>{category.toLowerCase()}</option>)}
        </select>
        {promoted ? <span className="inline-flex items-center gap-1 text-emerald-700"><Check size={10} /> Claim</span> : null}
      </div>
    </div>
  );
}

function SynthesisNode({ data, selected }: NodeProps<CanvasNodeData>) {
  const object = data.object;
  return (
    <div className={`h-full w-full rounded-lg border bg-white p-4 shadow-md ${selected ? "border-secondary ring-2 ring-secondary/25" : "border-slate-200"}`}>
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-secondary" />
      <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-500">{String(object.synthesisKind ?? "Theme")}</span>
      <h4 className="mt-1 text-sm font-semibold text-slate-950">{String(object.title ?? "Synthesis")}</h4>
      <p className="mt-2 line-clamp-3 text-xs leading-5 text-slate-600">{String(object.text ?? "")}</p>
      <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
        <span>{Array.isArray(object.sourceIds) ? object.sourceIds.length : 0} sources</span>
        <span>{Math.round(numberOf(object.confidence, 0) * 100)}%</span>
      </div>
    </div>
  );
}

function IdeaFrame({ data, selected }: NodeProps<CanvasNodeData>) {
  const object = data.object;
  const [title, setTitle] = useState(String(object.text ?? "Theme area"));
  return (
    <div className={`h-full w-full rounded-lg border-2 border-dashed bg-white/35 p-3 ${selected ? "border-secondary" : "border-slate-300"}`}>
      <input value={title} readOnly={data.readOnly} onChange={event => setTitle(event.target.value)} onBlur={() => data.onEdit(object.id, { text: title })} className="nodrag w-full border-0 bg-transparent text-xs font-bold uppercase tracking-wide text-slate-500 outline-none" />
    </div>
  );
}

const NODE_TYPES = { idea: IdeaNode, synthesis: SynthesisNode, ideaFrame: IdeaFrame };

function ToolButton({ icon: Icon, label, onClick, disabled, active, danger }: { icon: typeof MousePointer2; label: string; onClick?: () => void; disabled?: boolean; active?: boolean; danger?: boolean }) {
  return <button type="button" onClick={onClick} disabled={disabled} title={label} aria-label={label} className={`inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${active ? "bg-secondary-container text-on-secondary-container" : danger ? "text-red-700 hover:bg-red-50" : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"}`}><Icon size={15} /><span className="hidden xl:inline">{label}</span></button>;
}

function SynthesisDrawer({ result, onClose, onPlace, projectId }: { result: BoardSynthesisResult; onClose: () => void; onPlace: () => void; projectId: string }) {
  return (
    <aside className="absolute bottom-3 right-3 top-3 z-20 flex w-[370px] max-w-[calc(100%-24px)] flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface shadow-xl">
      <div className="flex items-start gap-3 border-b border-outline-variant px-4 py-4">
        <div className="grid h-9 w-9 place-items-center rounded-md bg-secondary-container text-on-secondary-container"><Sparkles size={17} /></div>
        <div className="min-w-0 flex-1"><h3 className="font-display text-sm font-semibold text-on-surface">Board synthesis</h3><p className="mt-0.5 text-xs text-on-surface-variant">{result.coveredSourceCount}/{result.sourceCount} ideas covered</p></div>
        <button type="button" onClick={onClose} className="icon-button" aria-label="Close synthesis"><X size={16} /></button>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <InsightGroup title="Themes" items={result.themes} />
        <InsightGroup title="Tensions" items={result.tensions} />
        <InsightGroup title="Opportunities" items={result.opportunities} />
        {result.warnings.map(warning => <div key={warning} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{warning}</div>)}
      </div>
      <div className="grid gap-2 border-t border-outline-variant p-4">
        <button type="button" className="btn-primary w-full text-xs" onClick={onPlace}><Sparkles size={14} /> Place synthesis on board</button>
        <Link href={`/synthesis/spec?project=${encodeURIComponent(projectId)}`} className="btn-secondary w-full justify-center text-xs"><FileText size={14} /> Continue to specification</Link>
      </div>
    </aside>
  );
}

function InsightGroup({ title, items }: { title: string; items: SynthesisInsight[] }) {
  if (!items.length) return null;
  return <section><div className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-on-surface-variant">{title}</div><div className="space-y-2">{items.map((item, index) => <div key={`${item.kind}-${index}`} className="rounded-md border border-outline-variant bg-surface-container-low p-3"><div className="flex items-start justify-between gap-2"><h4 className="text-xs font-semibold text-on-surface">{item.title}</h4><span className="font-mono text-[9px] text-on-surface-variant">{Math.round(item.confidence * 100)}%</span></div><p className="mt-1 text-xs leading-5 text-on-surface-variant">{item.summary}</p><div className="mt-2 text-[9px] uppercase text-on-surface-variant">{item.sourceIds.length} source{item.sourceIds.length === 1 ? "" : "s"}</div></div>)}</div></section>;
}

function positionOf(object: BoardObj): { x: number; y: number } {
  const position = object.position && typeof object.position === "object" ? object.position as Record<string, unknown> : {};
  return { x: numberOf(position.x, numberOf(object.x, 0)), y: numberOf(position.y, numberOf(object.y, 0)) };
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function objectText(object: BoardObj): string {
  return [object.title, object.text, object.summary, object.body].filter(value => typeof value === "string" && value.trim()).join(" — ");
}

function colorOf(object?: BoardObj): string {
  return object && typeof object.color === "string" ? object.color : "#fef3c7";
}
