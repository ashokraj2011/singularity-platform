"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizer,
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
  Braces,
  Eye,
  EyeOff,
  FileImage,
  FileUp,
  FileText,
  Frame,
  Image as ImageIcon,
  Lock,
  Link2,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  MousePointer2,
  PanelRightOpen,
  Presentation,
  Plus,
  Redo2,
  Search,
  Send,
  Shapes,
  Sparkles,
  StickyNote,
  Timer,
  Trash2,
  Undo2,
  Unlock,
  Users,
  Vote,
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

type BoardOperation = { kind: "upsert"; object: BoardObj } | { kind: "delete"; id: string };
type HistoryEntry = { label: string; undo: BoardOperation[]; redo: BoardOperation[] };
type BoardComment = { id: string; text: string; author: string; createdAt: string; replies?: BoardComment[] };
type BoardTemplate = {
  id: string;
  title: string;
  description: string;
  objects: Array<Omit<BoardObj, "id"> & { id?: string }>;
};

const BOARD_TEMPLATES: BoardTemplate[] = [
  {
    id: "impact-effort",
    title: "Impact / effort matrix",
    description: "Prioritize ideas by value and delivery complexity.",
    objects: [
      { id: "frame", type: "frame", x: 0, y: 0, text: "Impact / Effort", color: "#e2e8f0", width: 760, height: 520 },
      { type: "text", x: 40, y: 46, text: "High impact", color: "#dcfce7", category: "USER", width: 180, height: 80 },
      { type: "text", x: 540, y: 420, text: "High effort", color: "#ffe4e6", category: "OPERATIONAL", width: 180, height: 80 },
      { type: "sticky", x: 96, y: 136, text: "Quick win", color: "#fef3c7", category: "USER", width: 210, height: 138 },
      { type: "sticky", x: 446, y: 136, text: "Strategic bet", color: "#dbeafe", category: "MARKET", width: 210, height: 138 },
    ],
  },
  {
    id: "assumption-map",
    title: "Assumption map",
    description: "Separate known facts, risky assumptions, and validation probes.",
    objects: [
      { id: "frame", type: "frame", x: 0, y: 0, text: "Assumption Map", color: "#e2e8f0", width: 880, height: 420 },
      { type: "sticky", x: 48, y: 96, text: "Known fact", color: "#dcfce7", category: "MARKET", width: 220, height: 138 },
      { type: "sticky", x: 330, y: 96, text: "Risky assumption", color: "#ffe4e6", category: "USER", width: 220, height: 138 },
      { type: "sticky", x: 612, y: 96, text: "Validation probe", color: "#dbeafe", category: "TECHNICAL", width: 220, height: 138 },
    ],
  },
  {
    id: "sdlc-idea-flow",
    title: "SDLC idea flow",
    description: "Move from intent to contract, execution, verification, and evidence.",
    objects: [
      { id: "frame", type: "frame", x: 0, y: 0, text: "SDLC Idea Flow", color: "#e2e8f0", width: 1040, height: 360 },
      { type: "sticky", x: 44, y: 118, text: "Intent", color: "#fef3c7", category: "USER", width: 170, height: 118 },
      { type: "sticky", x: 246, y: 118, text: "Contract", color: "#dbeafe", category: "TECHNICAL", width: 170, height: 118 },
      { type: "sticky", x: 448, y: 118, text: "Work", color: "#ede9fe", category: "OPERATIONAL", width: 170, height: 118 },
      { type: "sticky", x: 650, y: 118, text: "Verify", color: "#dcfce7", category: "TECHNICAL", width: 170, height: 118 },
      { type: "sticky", x: 852, y: 118, text: "Evidence", color: "#ffe4e6", category: "OPERATIONAL", width: 170, height: 118 },
    ],
  },
  {
    id: "retro",
    title: "Retrospective",
    description: "Capture what worked, what hurt, and what to try next.",
    objects: [
      { id: "frame", type: "frame", x: 0, y: 0, text: "Retrospective", color: "#e2e8f0", width: 840, height: 440 },
      { type: "sticky", x: 52, y: 104, text: "Keep", color: "#dcfce7", category: "OPERATIONAL", width: 220, height: 138 },
      { type: "sticky", x: 310, y: 104, text: "Problem", color: "#ffe4e6", category: "USER", width: 220, height: 138 },
      { type: "sticky", x: 568, y: 104, text: "Try next", color: "#dbeafe", category: "TECHNICAL", width: 220, height: 138 },
    ],
  },
];

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
  const { ready, objects, createObject, editObject, deleteObject } = useBoardDoc(projectId, boardId, producer.emit);
  const flow = useReactFlow();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cursorThrottleRef = useRef(0);
  const [cursor, setCursor] = useState<{ x: number; y: number } | undefined>();
  const [viewport, setViewport] = useState<{ x: number; y: number; zoom: number } | undefined>();
  const present = usePresence(projectId, `board:${boardId}`, { cursor, viewport });
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
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const [clipboardObjects, setClipboardObjects] = useState<BoardObj[]>([]);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [facilitationOpen, setFacilitationOpen] = useState(false);
  const [collaborationOpen, setCollaborationOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [voteMode, setVoteMode] = useState(false);
  const [privateMode, setPrivateMode] = useState(false);
  const [privateDrafts, setPrivateDrafts] = useState<BoardObj[]>([]);
  const [followUserId, setFollowUserId] = useState<string | null>(null);
  const [timerSeconds, setTimerSeconds] = useState(5 * 60);
  const [timerRunning, setTimerRunning] = useState(false);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isPast = atSeq !== null && atSeq < head;
  const baseShown = useMemo(() => isPast ? pastObjects : objects, [isPast, objects, pastObjects]);
  const shown = useMemo(() => {
    if (isPast || !privateDrafts.length) return baseShown;
    return [...baseShown, ...privateDrafts];
  }, [baseShown, isPast, privateDrafts]);
  const objectById = useMemo(() => new Map(shown.map(object => [object.id, object])), [shown]);
  const selectedObjects = useMemo(() => selection.map(id => objectById.get(id)).filter((object): object is BoardObj => Boolean(object)), [objectById, selection]);
  const visibleObjects = useMemo(() => shown.filter(object => String(object.type) !== "connector"), [shown]);
  const frames = useMemo(() => visibleObjects.filter(object => String(object.type) === "frame"), [visibleObjects]);

  const updateViewport = useCallback((nextViewport: { x: number; y: number; zoom: number }) => {
    setViewport(current => {
      if (
        current
        && Math.abs(current.x - nextViewport.x) < 0.5
        && Math.abs(current.y - nextViewport.y) < 0.5
        && Math.abs(current.zoom - nextViewport.zoom) < 0.001
      ) {
        return current;
      }
      return { x: nextViewport.x, y: nextViewport.y, zoom: nextViewport.zoom };
    });
  }, []);

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

  useEffect(() => {
    if (!timerRunning) return;
    const timer = window.setInterval(() => {
      setTimerSeconds(current => {
        if (current <= 1) {
          setTimerRunning(false);
          setNotice("Timer complete.");
          return 0;
        }
        return current - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [timerRunning]);

  useEffect(() => {
    if (!followUserId) return;
    const target = present.find(user => user.userId === followUserId);
    if (!target?.viewport) return;
    flow.setViewport(target.viewport, { duration: 260 });
  }, [flow, followUserId, present]);

  const applyOperation = useCallback((operation: BoardOperation) => {
    if (operation.kind === "delete") {
      if (operation.id.startsWith("private:")) {
        setPrivateDrafts(current => current.filter(object => object.id !== operation.id));
        return;
      }
      deleteObject(operation.id);
      return;
    }
    const existing = objectById.get(operation.object.id);
    if (operation.object.id.startsWith("private:")) {
      setPrivateDrafts(current => current.some(object => object.id === operation.object.id)
        ? current.map(object => object.id === operation.object.id ? operation.object : object)
        : [...current, operation.object]);
    } else if (existing) {
      editObject(operation.object.id, operation.object);
    } else {
      createObject(operation.object);
    }
  }, [createObject, deleteObject, editObject, objectById]);

  const commitOperations = useCallback((label: string, redo: BoardOperation[], undo: BoardOperation[]) => {
    if (isPast || !redo.length) return;
    redo.forEach(applyOperation);
    setUndoStack(current => [...current.slice(-39), { label, undo, redo }]);
    setRedoStack([]);
  }, [applyOperation, isPast]);

  const undo = useCallback(() => {
    if (isPast) return;
    setUndoStack(current => {
      const entry = current[current.length - 1];
      if (!entry) return current;
      entry.undo.forEach(applyOperation);
      setRedoStack(next => [...next.slice(-39), entry]);
      return current.slice(0, -1);
    });
  }, [applyOperation, isPast]);

  const redo = useCallback(() => {
    if (isPast) return;
    setRedoStack(current => {
      const entry = current[current.length - 1];
      if (!entry) return current;
      entry.redo.forEach(applyOperation);
      setUndoStack(next => [...next.slice(-39), entry]);
      return current.slice(0, -1);
    });
  }, [applyOperation, isPast]);

  const edit = useCallback((id: string, patch: Record<string, unknown>) => {
    if (isPast) return;
    const before = objectById.get(id);
    if (!before || isLocked(before)) return;
    commitOperations("Edit object", [{ kind: "upsert", object: { ...before, ...patch } }], [{ kind: "upsert", object: before }]);
  }, [commitOperations, isPast, objectById]);

  useEffect(() => {
    const nextNodes: Node<CanvasNodeData>[] = shown
      .filter(object => String(object.type ?? "sticky") !== "connector")
      .map(object => {
        const position = positionOf(object);
        const type = String(object.type ?? "sticky");
        return {
          id: object.id,
          type: type === "frame" ? "ideaFrame" : type === "synthesis" ? "synthesis" : type === "image" ? "boardImage" : type === "file" ? "boardFile" : type === "shape" ? "shape" : "idea",
          position,
          data: { object, readOnly: isPast || isLocked(object), onEdit: edit },
          selected: selection.includes(object.id),
          draggable: !isPast && !isLocked(object),
          selectable: true,
          zIndex: type === "frame" ? -10 : type === "synthesis" ? 4 : type === "shape" ? 1 : 2,
          style: {
            width: numberOf(object.width, type === "frame" ? 520 : type === "synthesis" ? 280 : type === "image" ? 280 : type === "file" ? 260 : type === "shape" ? 180 : 220),
            height: numberOf(object.height, type === "frame" ? 320 : type === "synthesis" ? 172 : type === "image" ? 190 : type === "file" ? 118 : type === "shape" ? 140 : 148),
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
        markerEnd: { type: MarkerType.ArrowClosed, color: connectorColor(object) },
        style: { stroke: connectorColor(object), strokeWidth: numberOf(object.strokeWidth, 1.7), strokeDasharray: String(object.lineStyle ?? "solid") === "dashed" ? "6 5" : String(object.lineStyle ?? "solid") === "dotted" ? "2 5" : undefined },
        labelStyle: { fontSize: 10, fill: "#475569" },
      }));
    setEdges(nextEdges);
  }, [shown, isPast, edit, selection, setNodes, setEdges]);

  const contentObjects = useMemo(
    () => shown.filter(object => !STRUCTURAL_TYPES.has(String(object.type ?? "sticky")) && String(object.type) !== "synthesis"),
    [shown],
  );
  const selectedContent = contentObjects.filter(object => selection.includes(object.id));

  const createBoardObject = useCallback((object: BoardObj, label = "Create object") => {
    commitOperations(label, [{ kind: "upsert", object }], [{ kind: "delete", id: object.id }]);
  }, [commitOperations]);

  const createPossiblyPrivateObject = useCallback((object: BoardObj, label = "Create object") => {
    if (privateMode && String(object.type) !== "frame" && String(object.type) !== "connector") {
      const privateObject = { ...object, id: `private:${crypto.randomUUID()}`, privateDraft: true };
      setPrivateDrafts(current => [...current, privateObject]);
      setSelection([privateObject.id]);
      setNotice("Private note added. Use Reveal private notes when ready.");
      return;
    }
    createBoardObject(object, label);
  }, [createBoardObject, privateMode]);

  const addObject = useCallback((type: "sticky" | "text" | "frame" | "shape") => {
    if (isPast) return;
    const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const id = crypto.randomUUID();
    createPossiblyPrivateObject({
      id,
      type,
      x: Math.round(center.x - (type === "frame" ? 260 : type === "shape" ? 90 : 110)),
      y: Math.round(center.y - (type === "frame" ? 160 : type === "shape" ? 70 : 74)),
      text: type === "frame" ? "Theme area" : type === "shape" ? "Shape" : "",
      ...(type === "frame" ? {} : { category: "USER" }),
      color: type === "frame" ? "#e2e8f0" : type === "shape" ? "#ffffff" : COLORS[Math.floor(Math.random() * COLORS.length)]!,
      shapeKind: type === "shape" ? "rounded" : undefined,
      width: type === "frame" ? 520 : type === "shape" ? 180 : 220,
      height: type === "frame" ? 320 : type === "shape" ? 140 : 148,
    });
    window.setTimeout(() => flow.fitView({ padding: 0.25, duration: 240 }), 60);
  }, [createPossiblyPrivateObject, flow, isPast]);

  const connectSelected = useCallback(() => {
    if (isPast || selection.length !== 2) return;
    createBoardObject({
      id: crypto.randomUUID(),
      type: "connector",
      x: 0,
      y: 0,
      sourceId: selection[0],
      targetId: selection[1],
    }, "Connect ideas");
    setNotice("Ideas connected.");
  }, [createBoardObject, isPast, selection]);

  const deleteSelected = useCallback(() => {
    if (isPast || !selection.length) return;
    const selectedSet = new Set(selection);
    const deletable = shown.filter(object =>
      !isLocked(object)
      && (selectedSet.has(object.id) || (String(object.type) === "connector" && (selectedSet.has(String(object.sourceId)) || selectedSet.has(String(object.targetId))))),
    );
    commitOperations(
      "Delete selection",
      deletable.map(object => ({ kind: "delete", id: object.id })),
      deletable.map(object => ({ kind: "upsert", object })),
    );
    setSelection([]);
  }, [commitOperations, isPast, selection, shown]);

  const duplicateSelected = useCallback(() => {
    if (isPast || !selectedObjects.length) return;
    const idMap = new Map<string, string>();
    const clones = selectedObjects
      .filter(object => String(object.type) !== "connector")
      .map(object => {
        const id = crypto.randomUUID();
        idMap.set(object.id, id);
        const position = positionOf(object);
        return {
          ...object,
          id,
          x: position.x + 32,
          y: position.y + 32,
          position: { x: position.x + 32, y: position.y + 32 },
          promotedClaimId: undefined,
          promotedAt: undefined,
        };
      });
    const connectorClones = shown
      .filter(object => String(object.type) === "connector" && idMap.has(String(object.sourceId)) && idMap.has(String(object.targetId)))
      .map(object => ({ ...object, id: crypto.randomUUID(), sourceId: idMap.get(String(object.sourceId)), targetId: idMap.get(String(object.targetId)) }));
    const created = [...clones, ...connectorClones];
    commitOperations(
      "Duplicate selection",
      created.map(object => ({ kind: "upsert", object })),
      created.map(object => ({ kind: "delete", id: object.id })),
    );
    setSelection(clones.map(object => object.id));
  }, [commitOperations, isPast, selectedObjects, shown]);

  const recolorSelected = useCallback((color: string) => {
    if (isPast) return;
    const targets = selectedObjects.filter(object => !isLocked(object));
    commitOperations(
      "Recolor selection",
      targets.map(object => ({ kind: "upsert", object: { ...object, color } })),
      targets.map(object => ({ kind: "upsert", object })),
    );
  }, [commitOperations, isPast, selectedObjects]);

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
    const created: BoardObj[] = [];
    insights.forEach((insight, index) => {
      const id = crypto.randomUUID();
      created.push({
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
      insight.sourceIds.slice(0, 12).forEach(sourceId => created.push({
        id: crypto.randomUUID(),
        type: "connector",
        x: 0,
        y: 0,
        sourceId,
        targetId: id,
        label: "synthesized into",
      }));
    });
    commitOperations(
      "Place synthesis",
      created.map(object => ({ kind: "upsert", object })),
      created.map(object => ({ kind: "delete", id: object.id })),
    );
    setSynthesisOpen(false);
    setNotice(`${insights.length} synthesis cards placed with source links.`);
    window.setTimeout(() => flow.fitView({ padding: 0.18, duration: 420 }), 100);
  }

  const moveNode = useCallback((id: string, to: { x: number; y: number }) => {
    const before = objectById.get(id);
    if (!before || isPast || isLocked(before)) return;
    const after = withPosition(before, to);
    commitOperations("Move object", [{ kind: "upsert", object: after }], [{ kind: "upsert", object: before }]);
  }, [commitOperations, isPast, objectById]);

  const copySelection = useCallback(() => {
    if (!selectedObjects.length) return;
    setClipboardObjects(selectedObjects.map(object => ({ ...object })));
    setNotice(`${selectedObjects.length} object${selectedObjects.length === 1 ? "" : "s"} copied.`);
  }, [selectedObjects]);

  const pasteClipboard = useCallback(() => {
    if (isPast || !clipboardObjects.length) return;
    const idMap = new Map<string, string>();
    const pasted = clipboardObjects.map(object => {
      const id = crypto.randomUUID();
      idMap.set(object.id, id);
      const position = positionOf(object);
      return {
        ...object,
        id,
        x: position.x + 44,
        y: position.y + 44,
        position: { x: position.x + 44, y: position.y + 44 },
        sourceId: typeof object.sourceId === "string" ? idMap.get(object.sourceId) ?? object.sourceId : object.sourceId,
        targetId: typeof object.targetId === "string" ? idMap.get(object.targetId) ?? object.targetId : object.targetId,
        promotedClaimId: undefined,
        promotedAt: undefined,
      };
    });
    commitOperations(
      "Paste objects",
      pasted.map(object => ({ kind: "upsert", object })),
      pasted.map(object => ({ kind: "delete", id: object.id })),
    );
    setSelection(pasted.filter(object => String(object.type) !== "connector").map(object => object.id));
  }, [clipboardObjects, commitOperations, isPast]);

  const revealPrivateDrafts = useCallback(() => {
    if (isPast || !privateDrafts.length) return;
    const revealed = privateDrafts.map(object => {
      const rest: BoardObj = { ...object };
      delete rest.privateDraft;
      return { ...rest, id: crypto.randomUUID(), revealedAt: new Date().toISOString() } as BoardObj;
    });
    commitOperations(
      "Reveal private notes",
      revealed.map(object => ({ kind: "upsert", object })),
      revealed.map(object => ({ kind: "delete", id: object.id })),
    );
    setPrivateDrafts([]);
    setSelection(revealed.map(object => object.id));
    setNotice(`${revealed.length} private note${revealed.length === 1 ? "" : "s"} revealed to the board.`);
  }, [commitOperations, isPast, privateDrafts]);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    if (isPast) return;
    const list = Array.from(files).slice(0, 8);
    const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const created: BoardObj[] = [];
    for (const [index, file] of list.entries()) {
      const id = crypto.randomUUID();
      const x = Math.round(center.x + (index % 3) * 300 - 150);
      const y = Math.round(center.y + Math.floor(index / 3) * 220 - 90);
      if (file.type.startsWith("image/") && file.size <= 1_500_000) {
        const dataUrl = await readFileAsDataUrl(file);
        created.push({ id, type: "image", x, y, text: file.name, fileName: file.name, fileType: file.type, fileSize: file.size, dataUrl, width: 280, height: 190 });
      } else {
        created.push({ id, type: "file", x, y, text: file.name, fileName: file.name, fileType: file.type || "application/octet-stream", fileSize: file.size, width: 260, height: 118 });
      }
    }
    commitOperations(
      "Add files",
      created.map(object => ({ kind: "upsert", object })),
      created.map(object => ({ kind: "delete", id: object.id })),
    );
    setSelection(created.map(object => object.id));
  }, [commitOperations, flow, isPast]);

  const exportBoard = useCallback((format: "json" | "svg" | "print") => {
    const exportObjects = baseShown.filter(object => String(object.type) !== "connector");
    if (format === "json") {
      downloadText(`idea-board-${boardId}.json`, JSON.stringify({ boardId, exportedAt: new Date().toISOString(), objects: baseShown }, null, 2), "application/json");
      return;
    }
    const svg = boardToSvg(exportObjects, baseShown.filter(object => String(object.type) === "connector"));
    if (format === "svg") {
      downloadText(`idea-board-${boardId}.svg`, svg, "image/svg+xml");
      return;
    }
    const win = window.open("", "_blank", "noopener,noreferrer");
    if (!win) {
      setError("Popup blocked. Use SVG export, or allow popups for printable PDF export.");
      return;
    }
    win.document.write(`<!doctype html><html><head><title>Idea Board Export</title><style>body{margin:0;background:#f8fafc;font-family:Inter,system-ui,sans-serif}.wrap{padding:24px}button{position:fixed;right:20px;top:20px;padding:10px 14px;border:1px solid #cbd5e1;border-radius:8px;background:white;font-weight:700}@media print{button{display:none}.wrap{padding:0}}</style></head><body><button onclick="window.print()">Print / Save PDF</button><div class="wrap">${svg}</div></body></html>`);
    win.document.close();
  }, [baseShown, boardId]);

  const toggleLockSelected = useCallback(() => {
    if (isPast || !selectedObjects.length) return;
    const shouldLock = selectedObjects.some(object => !isLocked(object));
    const targets = selectedObjects.filter(object => String(object.type) !== "connector");
    commitOperations(
      shouldLock ? "Lock objects" : "Unlock objects",
      targets.map(object => ({ kind: "upsert", object: { ...object, locked: shouldLock } })),
      targets.map(object => ({ kind: "upsert", object })),
    );
  }, [commitOperations, isPast, selectedObjects]);

  const alignSelected = useCallback((axis: "x" | "y") => {
    const targets = selectedObjects.filter(object => String(object.type) !== "connector" && !isLocked(object));
    if (isPast || targets.length < 2) return;
    const anchor = axis === "x"
      ? Math.min(...targets.map(object => positionOf(object).x))
      : Math.min(...targets.map(object => positionOf(object).y));
    const redo = targets.map(object => {
      const position = positionOf(object);
      return { kind: "upsert" as const, object: withPosition(object, axis === "x" ? { x: anchor, y: position.y } : { x: position.x, y: anchor }) };
    });
    commitOperations("Align selection", redo, targets.map(object => ({ kind: "upsert", object })));
  }, [commitOperations, isPast, selectedObjects]);

  const addVoteToSelection = useCallback(() => {
    const targets = selectedObjects.filter(object => String(object.type) !== "connector" && String(object.type) !== "frame" && !isLocked(object));
    if (isPast || !targets.length) return;
    commitOperations(
      "Add vote",
      targets.map(object => ({ kind: "upsert", object: { ...object, votes: numberOf(object.votes, 0) + 1 } })),
      targets.map(object => ({ kind: "upsert", object })),
    );
  }, [commitOperations, isPast, selectedObjects]);

  const clearVotes = useCallback(() => {
    const targets = shown.filter(object => numberOf(object.votes, 0) > 0 && !isLocked(object));
    if (isPast || !targets.length) return;
    commitOperations(
      "Clear votes",
      targets.map(object => ({ kind: "upsert", object: { ...object, votes: 0 } })),
      targets.map(object => ({ kind: "upsert", object })),
    );
  }, [commitOperations, isPast, shown]);

  const placeTemplate = useCallback((template: BoardTemplate) => {
    if (isPast) return;
    const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const frame = template.objects.find(object => object.id === "frame") ?? template.objects[0];
    const offsetX = Math.round(center.x - numberOf(frame?.width, 600) / 2);
    const offsetY = Math.round(center.y - numberOf(frame?.height, 420) / 2);
    const objects = template.objects.map(object => {
      const id = crypto.randomUUID();
      return {
        ...object,
        id,
        type: String(object.type ?? "sticky"),
        x: offsetX + numberOf(object.x, 0),
        y: offsetY + numberOf(object.y, 0),
        position: { x: offsetX + numberOf(object.x, 0), y: offsetY + numberOf(object.y, 0) },
        templateId: template.id,
      } as BoardObj;
    });
    commitOperations(
      `Place ${template.title}`,
      objects.map(object => ({ kind: "upsert", object })),
      objects.map(object => ({ kind: "delete", id: object.id })),
    );
    setSelection(objects.filter(object => String(object.type) !== "connector").map(object => object.id));
    setTemplateOpen(false);
    window.setTimeout(() => flow.fitView({ padding: 0.18, duration: 360 }), 80);
  }, [commitOperations, flow, isPast]);

  const jumpToObject = useCallback((id: string) => {
    const object = objectById.get(id);
    if (!object) return;
    const position = positionOf(object);
    flow.setCenter(position.x + numberOf(object.width, 220) / 2, position.y + numberOf(object.height, 140) / 2, { zoom: 1.1, duration: 320 });
    setSelection([id]);
  }, [flow, objectById]);

  const searchMatches = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [];
    return visibleObjects
      .filter(object => [objectText(object), object.category, object.title, object.text].some(value => String(value ?? "").toLowerCase().includes(query)))
      .slice(0, 8);
  }, [search, visibleObjects]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === "z" && event.shiftKey) {
        event.preventDefault();
        redo();
      } else if (mod && key === "z") {
        event.preventDefault();
        undo();
      } else if (mod && key === "c") {
        event.preventDefault();
        copySelection();
      } else if (mod && key === "v") {
        event.preventDefault();
        pasteClipboard();
      } else if ((event.key === "Delete" || event.key === "Backspace") && selection.length) {
        event.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [copySelection, deleteSelected, pasteClipboard, redo, selection.length, undo]);

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

  const selectedLocked = selectedObjects.some(object => isLocked(object));
  const selectedCommentCount = selectedObjects.reduce((sum, object) => sum + commentsOf(object).length, 0);

  return (
    <section className="syn-board relative flex h-full min-h-[520px] flex-col overflow-hidden border border-outline-variant bg-surface-container-lowest shadow-sm">
      <div className="flex min-h-12 flex-nowrap items-center gap-1.5 overflow-x-auto border-b border-outline-variant bg-surface-container-lowest px-2 py-1.5">
        <div className="mr-1 flex shrink-0 items-center gap-2 px-1">
          <span className={`h-2 w-2 rounded-full ${ready ? "bg-secondary" : "bg-outline"}`} />
          <span className="font-display text-sm font-semibold text-on-surface">{mode === "ideas" ? "Idea Board" : "Board"}</span>
          <span className="font-mono text-[10px] uppercase text-on-surface-variant">{shown.length} objects</span>
        </div>
        <ToolButton icon={Undo2} label="Undo" onClick={undo} disabled={isPast || undoStack.length === 0} />
        <ToolButton icon={Redo2} label="Redo" onClick={redo} disabled={isPast || redoStack.length === 0} />
        <span className="mx-1 h-6 w-px shrink-0 bg-outline-variant" />
        <ToolButton icon={MousePointer2} label="Select" active />
        <ToolButton icon={StickyNote} label="Sticky" onClick={() => addObject("sticky")} disabled={isPast} />
        <ToolButton icon={MessageSquarePlus} label="Text" onClick={() => addObject("text")} disabled={isPast} />
        <ToolButton icon={Shapes} label="Shape" onClick={() => addObject("shape")} disabled={isPast} />
        <ToolButton icon={Frame} label="Frame" onClick={() => addObject("frame")} disabled={isPast} />
        <ToolButton icon={Shapes} label="Templates" onClick={() => setTemplateOpen(true)} disabled={isPast} />
        <ToolButton icon={FileUp} label="Upload" onClick={() => fileInputRef.current?.click()} disabled={isPast} />
        <span className="mx-1 h-6 w-px shrink-0 bg-outline-variant" />
        <ToolButton icon={Link2} label="Connect" onClick={connectSelected} disabled={isPast || selection.length !== 2} />
        <ToolButton icon={Copy} label="Copy" onClick={copySelection} disabled={!selection.length} />
        <ToolButton icon={Copy} label="Paste" onClick={pasteClipboard} disabled={isPast || clipboardObjects.length === 0} />
        <ToolButton icon={Copy} label="Duplicate" onClick={duplicateSelected} disabled={isPast || !selectedObjects.length} />
        <ToolButton icon={selectedLocked ? Unlock : Lock} label={selectedLocked ? "Unlock" : "Lock"} onClick={toggleLockSelected} disabled={isPast || !selectedObjects.length} />
        <ToolButton icon={Trash2} label="Delete" onClick={deleteSelected} disabled={isPast || !selection.length} danger />
        {selection.length > 0 ? (
          <div className="ml-1 hidden shrink-0 items-center gap-1 rounded-md border border-outline-variant bg-surface px-1.5 py-1 lg:flex" aria-label="Card color">
            {COLORS.map(color => <button key={color} type="button" onClick={() => recolorSelected(color)} className="h-4 w-4 rounded-sm border border-black/10" style={{ background: color }} title={`Set color ${color}`} />)}
          </div>
        ) : null}
        {selection.length > 1 ? (
          <div className="hidden shrink-0 items-center gap-1 rounded-md border border-outline-variant bg-surface px-1.5 py-1 xl:flex">
            <button type="button" className="h-7 rounded px-2 text-[11px] font-semibold text-on-surface-variant hover:bg-surface-container-high" onClick={() => alignSelected("x")} disabled={isPast}>Align X</button>
            <button type="button" className="h-7 rounded px-2 text-[11px] font-semibold text-on-surface-variant hover:bg-surface-container-high" onClick={() => alignSelected("y")} disabled={isPast}>Align Y</button>
          </div>
        ) : null}
        <div className="relative ml-1 flex h-8 w-44 shrink-0 items-center rounded-md border border-outline-variant bg-surface px-2 md:w-56">
          <Search size={14} className="shrink-0 text-on-surface-variant" />
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && searchMatches[0]) jumpToObject(searchMatches[0].id);
            }}
            placeholder="Find on board"
            className="min-w-0 flex-1 border-0 bg-transparent px-2 text-xs text-on-surface outline-none placeholder:text-on-surface-variant"
          />
          {searchMatches.length ? (
            <div className="absolute left-0 top-10 z-30 w-72 overflow-hidden rounded-md border border-outline-variant bg-surface shadow-xl">
              {searchMatches.map(match => (
                <button key={match.id} type="button" onClick={() => { jumpToObject(match.id); setSearch(""); }} className="block w-full border-b border-outline-variant px-3 py-2 text-left text-xs text-on-surface last:border-b-0 hover:bg-surface-container-high">
                  <span className="block truncate font-semibold">{objectText(match) || String(match.type)}</span>
                  <span className="text-[10px] uppercase text-on-surface-variant">{String(match.type)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {mode === "ideas" ? (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <button type="button" className={`btn-secondary h-8 px-2 text-xs ${privateMode ? "border-amber-300 bg-amber-50 text-amber-900" : ""}`} onClick={() => setPrivateMode(value => !value)} title="Private notes stay local until you reveal them">
              {privateMode ? <EyeOff size={14} /> : <Eye size={14} />} Private{privateDrafts.length ? ` ${privateDrafts.length}` : ""}
            </button>
            {privateDrafts.length ? <button type="button" className="btn-secondary h-8 px-2 text-xs" onClick={revealPrivateDrafts} disabled={isPast}><Eye size={14} /> Reveal</button> : null}
            <button type="button" className="btn-secondary h-8 px-2 text-xs" onClick={() => setCollaborationOpen(true)} title="Live cursors and follow mode"><Users size={14} /><span className="hidden 2xl:inline">Collaborate</span></button>
            <button type="button" className={`btn-secondary h-8 px-2 text-xs ${voteMode ? "border-secondary bg-secondary-container text-on-secondary-container" : ""}`} onClick={() => setVoteMode(value => !value)} title="Start a lightweight dot-voting session">
              <Vote size={14} /> Vote
            </button>
            {voteMode ? <button type="button" className="btn-secondary h-8 px-2 text-xs" onClick={addVoteToSelection} disabled={!selectedContent.length || isPast}>+1</button> : null}
            <button type="button" className="btn-secondary h-8 px-2 text-xs" onClick={() => setFacilitationOpen(true)} title="Timer, voting, and workshop tools"><Timer size={14} /><span className="hidden 2xl:inline">Facilitate</span></button>
            <button type="button" className="btn-secondary h-8 px-2 text-xs" onClick={() => setInspectorOpen(value => !value)} disabled={!selectedObjects.length} title="Comments and object details">
              <PanelRightOpen size={14} /> {selectedCommentCount ? selectedCommentCount : <span className="hidden 2xl:inline">Details</span>}
            </button>
            <ToolButton icon={FileImage} label="SVG export" onClick={() => exportBoard("svg")} />
            <ToolButton icon={FileText} label="PDF export" onClick={() => exportBoard("print")} />
            <ToolButton icon={Braces} label="JSON export" onClick={() => exportBoard("json")} />
            <ToolButton icon={promoting ? Loader2 : Send} label="Promote" onClick={promoteToClaims} disabled={!selectedContent.length || promoting || isPast} />
            <button type="button" className="btn-primary h-8 px-3 text-xs" onClick={runSynthesis} disabled={!contentObjects.length || synthesizing}>
              {synthesizing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Synthesize
            </button>
          </div>
        ) : <div className="ml-auto"><PresenceBar present={present} /></div>}
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={event => { if (event.currentTarget.files?.length) void handleFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
      </div>

      {isPast ? <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">Viewing event {atSeq} of {head}. This state is read-only.</div> : null}

      <div
        className="relative min-h-0 flex-1 bg-white"
        onPointerMove={event => {
          const now = Date.now();
          if (now - cursorThrottleRef.current < 120) return;
          cursorThrottleRef.current = now;
          setCursor(flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
        }}
        onDragOver={event => {
          if (!isPast && Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault();
        }}
        onDrop={event => {
          if (isPast || !event.dataTransfer.files.length) return;
          event.preventDefault();
          void handleFiles(event.dataTransfer.files);
        }}
      >
        {error ? (
          <div className="absolute left-1/2 top-2 z-30 flex max-w-[min(720px,calc(100%-24px))] -translate-x-1/2 items-center gap-2 rounded-full border border-red-200 bg-red-50/95 px-3 py-2 text-xs font-semibold text-red-800 shadow-lg backdrop-blur">
            <X size={13} /> <span className="truncate">{error}</span><button className="ml-1" onClick={() => setError(null)} aria-label="Dismiss error"><X size={13} /></button>
          </div>
        ) : null}
        {notice ? (
          <div className="absolute left-1/2 top-2 z-30 flex max-w-[min(720px,calc(100%-24px))] -translate-x-1/2 items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50/95 px-3 py-2 text-xs font-semibold text-emerald-800 shadow-lg backdrop-blur">
            <Check size={13} /> <span className="truncate">{notice}</span><button className="ml-1" onClick={() => setNotice(null)} aria-label="Dismiss message"><X size={13} /></button>
          </div>
        ) : null}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onMove={(_, nextViewport) => updateViewport(nextViewport)}
          onNodeDragStop={(_, node) => moveNode(node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) })}
          onSelectionChange={onSelectionChange}
          onEdgeClick={(_, edge) => {
            setSelection([edge.id]);
            setInspectorOpen(true);
          }}
          onDoubleClick={event => {
            if (isPast || (event.target as HTMLElement).closest(".react-flow__node")) return;
            const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
            createBoardObject({
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
          style={{ backgroundColor: "#ffffff" }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1.1} color="rgba(15,23,42,0.14)" />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeColor={node => colorOf(node.data?.object as BoardObj | undefined)}
            maskColor="rgba(255,255,255,0.78)"
          />
          {mode === "ideas" ? (
            <Panel position="top-right">
              <PresenceBar present={present} />
            </Panel>
          ) : null}
          {frames.length ? (
            <Panel position="top-left">
              <div className="max-w-60 rounded-lg border border-outline-variant bg-surface/95 p-2 shadow-sm backdrop-blur">
                <div className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-bold uppercase tracking-wide text-on-surface-variant">
                  <Frame size={12} /> Frames
                </div>
                <div className="grid gap-1">
                  {frames.slice(0, 8).map(frame => (
                    <button key={frame.id} type="button" onClick={() => jumpToObject(frame.id)} className="truncate rounded px-2 py-1 text-left text-xs font-semibold text-on-surface hover:bg-surface-container-high">
                      {objectText(frame) || "Untitled frame"}
                    </button>
                  ))}
                </div>
              </div>
            </Panel>
          ) : null}
        </ReactFlow>
        <RemoteCursorLayer present={present} viewport={viewport} />

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
        {templateOpen ? (
          <TemplateDrawer templates={BOARD_TEMPLATES} onClose={() => setTemplateOpen(false)} onPlace={placeTemplate} />
        ) : null}
        {facilitationOpen ? (
          <FacilitationDrawer
            timerSeconds={timerSeconds}
            timerRunning={timerRunning}
            voteMode={voteMode}
            onClose={() => setFacilitationOpen(false)}
            onSetTimer={setTimerSeconds}
            onToggleTimer={() => setTimerRunning(value => !value)}
            onResetTimer={() => { setTimerRunning(false); setTimerSeconds(5 * 60); }}
            onToggleVote={() => setVoteMode(value => !value)}
            onClearVotes={clearVotes}
          />
        ) : null}
        {collaborationOpen ? (
          <CollaborationDrawer
            present={present}
            followUserId={followUserId}
            onClose={() => setCollaborationOpen(false)}
            onFollow={setFollowUserId}
          />
        ) : null}
        {inspectorOpen && selectedObjects[0] ? (
          <ObjectInspector
            object={selectedObjects[0]}
            selectionCount={selectedObjects.length}
            onClose={() => setInspectorOpen(false)}
            onEdit={edit}
            onJump={jumpToObject}
          />
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
  const votes = numberOf(object.votes, 0);
  const commentCount = commentsOf(object).length;
  return (
    <div className={`h-full w-full border p-3 shadow-sm transition-all ${selected ? "border-blue-500 ring-2 ring-blue-500/25 shadow-md" : "border-black/10"} ${data.readOnly ? "cursor-default" : ""}`} style={{ background: colorOf(object) }}>
      <NodeResizer
        isVisible={selected && !data.readOnly}
        minWidth={150}
        minHeight={96}
        onResizeEnd={(_, params) => data.onEdit(object.id, { width: Math.round(params.width), height: Math.round(params.height) })}
        lineClassName="!border-blue-500"
        handleClassName="!h-2 !w-2 !border-blue-500 !bg-white"
      />
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
        <span className="flex items-center gap-2">
          {votes > 0 ? <span className="inline-flex items-center gap-1 text-violet-700"><Vote size={10} /> {votes}</span> : null}
          {commentCount > 0 ? <span className="inline-flex items-center gap-1 text-sky-700"><MessageSquarePlus size={10} /> {commentCount}</span> : null}
          {isLocked(object) ? <span className="inline-flex items-center gap-1 text-slate-700"><Lock size={10} /> Locked</span> : null}
          {promoted ? <span className="inline-flex items-center gap-1 text-emerald-700"><Check size={10} /> Claim</span> : null}
        </span>
      </div>
    </div>
  );
}

function SynthesisNode({ data, selected }: NodeProps<CanvasNodeData>) {
  const object = data.object;
  return (
    <div className={`h-full w-full rounded-lg border bg-white p-4 shadow-md ${selected ? "border-secondary ring-2 ring-secondary/25" : "border-slate-200"}`}>
      <NodeResizer
        isVisible={selected && !data.readOnly}
        minWidth={220}
        minHeight={128}
        onResizeEnd={(_, params) => data.onEdit(object.id, { width: Math.round(params.width), height: Math.round(params.height) })}
        lineClassName="!border-secondary"
        handleClassName="!h-2 !w-2 !border-secondary !bg-white"
      />
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
      <NodeResizer
        isVisible={selected && !data.readOnly}
        minWidth={280}
        minHeight={180}
        onResizeEnd={(_, params) => data.onEdit(object.id, { width: Math.round(params.width), height: Math.round(params.height) })}
        lineClassName="!border-secondary"
        handleClassName="!h-2 !w-2 !border-secondary !bg-white"
      />
      <input value={title} readOnly={data.readOnly} onChange={event => setTitle(event.target.value)} onBlur={() => data.onEdit(object.id, { text: title })} className="nodrag w-full border-0 bg-transparent text-xs font-bold uppercase tracking-wide text-slate-500 outline-none" />
    </div>
  );
}

function ShapeNode({ data, selected }: NodeProps<CanvasNodeData>) {
  const object = data.object;
  const [text, setText] = useState(objectText(object));
  const shapeKind = String(object.shapeKind ?? "rounded");
  useEffect(() => setText(objectText(object)), [object]);
  return (
    <div className="h-full w-full">
      <NodeResizer
        isVisible={selected && !data.readOnly}
        minWidth={96}
        minHeight={72}
        onResizeEnd={(_, params) => data.onEdit(object.id, { width: Math.round(params.width), height: Math.round(params.height) })}
        lineClassName="!border-secondary"
        handleClassName="!h-2 !w-2 !border-secondary !bg-white"
      />
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-outline" />
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-outline" />
      <div
        className={`flex h-full w-full items-center justify-center border-2 border-slate-400 bg-white/80 p-3 text-center shadow-sm ${selected ? "ring-2 ring-secondary/30" : ""}`}
        style={{ borderRadius: shapeKind === "circle" ? "999px" : shapeKind === "diamond" ? 0 : 12, transform: shapeKind === "diamond" ? "rotate(45deg) scale(0.78)" : undefined }}
      >
        <textarea
          value={text}
          readOnly={data.readOnly}
          onChange={event => setText(event.target.value)}
          onBlur={() => { if (!data.readOnly && text !== objectText(object)) data.onEdit(object.id, { text }); }}
          className="nodrag nowheel h-20 w-full resize-none border-0 bg-transparent text-center text-xs font-semibold text-slate-800 outline-none"
          style={{ transform: shapeKind === "diamond" ? "rotate(-45deg) scale(1.2)" : undefined }}
          placeholder="Shape"
        />
      </div>
    </div>
  );
}

function ImageNode({ data, selected }: NodeProps<CanvasNodeData>) {
  const object = data.object;
  return (
    <div className={`h-full w-full overflow-hidden rounded-lg border bg-white shadow-sm ${selected ? "border-secondary ring-2 ring-secondary/25" : "border-slate-200"}`}>
      <NodeResizer
        isVisible={selected && !data.readOnly}
        minWidth={160}
        minHeight={110}
        onResizeEnd={(_, params) => data.onEdit(object.id, { width: Math.round(params.width), height: Math.round(params.height) })}
        lineClassName="!border-secondary"
        handleClassName="!h-2 !w-2 !border-secondary !bg-white"
      />
      {typeof object.dataUrl === "string" ? <img src={object.dataUrl} alt={String(object.fileName ?? "Board image")} className="h-[calc(100%-34px)] w-full object-cover" /> : <div className="grid h-[calc(100%-34px)] place-items-center bg-slate-100 text-slate-500"><ImageIcon size={26} /></div>}
      <div className="flex h-8 items-center gap-2 border-t border-slate-200 px-2 text-[10px] font-semibold text-slate-600">
        <ImageIcon size={12} />
        <span className="truncate">{String(object.fileName ?? object.text ?? "Image")}</span>
      </div>
    </div>
  );
}

function FileNode({ data, selected }: NodeProps<CanvasNodeData>) {
  const object = data.object;
  return (
    <div className={`h-full w-full rounded-lg border bg-white p-4 shadow-sm ${selected ? "border-secondary ring-2 ring-secondary/25" : "border-slate-200"}`}>
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-outline" />
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-outline" />
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-slate-100 text-slate-600"><FileText size={18} /></div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-900">{String(object.fileName ?? object.text ?? "File")}</div>
          <div className="mt-1 text-[10px] uppercase text-slate-500">{String(object.fileType ?? "file")} · {formatBytes(numberOf(object.fileSize, 0))}</div>
        </div>
      </div>
      <p className="mt-3 line-clamp-2 text-xs text-slate-500">File metadata is attached to the board. Image previews are embedded when the file is small enough.</p>
    </div>
  );
}

const NODE_TYPES = { idea: IdeaNode, synthesis: SynthesisNode, ideaFrame: IdeaFrame, shape: ShapeNode, boardImage: ImageNode, boardFile: FileNode };

function ToolButton({ icon: Icon, label, onClick, disabled, active, danger }: { icon: typeof MousePointer2; label: string; onClick?: () => void; disabled?: boolean; active?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${active ? "bg-secondary-container text-on-secondary-container" : danger ? "text-red-700 hover:bg-red-50" : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"}`}
    >
      <Icon size={15} className={Icon === Loader2 ? "animate-spin" : undefined} />
    </button>
  );
}

function SynthesisDrawer({ result, onClose, onPlace, projectId }: { result: BoardSynthesisResult; onClose: () => void; onPlace: () => void; projectId: string }) {
  return (
    <aside className="absolute bottom-2 right-2 top-2 z-20 flex w-[min(340px,calc(100%-16px))] flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface shadow-xl">
      <div className="flex items-start gap-3 border-b border-outline-variant px-3 py-3">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-secondary-container text-on-secondary-container"><Sparkles size={16} /></div>
        <div className="min-w-0 flex-1"><h3 className="font-display text-sm font-semibold text-on-surface">Board synthesis</h3><p className="mt-0.5 text-xs text-on-surface-variant">{result.coveredSourceCount}/{result.sourceCount} ideas covered</p></div>
        <button type="button" onClick={onClose} className="icon-button" aria-label="Close synthesis"><X size={16} /></button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        <InsightGroup title="Themes" items={result.themes} />
        <InsightGroup title="Tensions" items={result.tensions} />
        <InsightGroup title="Opportunities" items={result.opportunities} />
        {result.warnings.map(warning => <div key={warning} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{warning}</div>)}
      </div>
      <div className="grid gap-2 border-t border-outline-variant p-3">
        <button type="button" className="btn-primary w-full text-xs" onClick={onPlace}><Sparkles size={14} /> Place synthesis on board</button>
        <Link href={`/synthesis/spec?project=${encodeURIComponent(projectId)}`} className="btn-secondary w-full justify-center text-xs"><FileText size={14} /> Continue to specification</Link>
      </div>
    </aside>
  );
}

function TemplateDrawer({ templates, onClose, onPlace }: { templates: BoardTemplate[]; onClose: () => void; onPlace: (template: BoardTemplate) => void }) {
  return (
    <aside className="absolute bottom-2 right-2 top-2 z-20 flex w-[min(340px,calc(100%-16px))] flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface shadow-xl">
      <div className="flex items-start gap-3 border-b border-outline-variant px-3 py-3">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-secondary-container text-on-secondary-container"><Shapes size={16} /></div>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-sm font-semibold text-on-surface">Board templates</h3>
          <p className="mt-0.5 text-xs text-on-surface-variant">Drop a workshop structure onto the canvas.</p>
        </div>
        <button type="button" onClick={onClose} className="icon-button" aria-label="Close templates"><X size={16} /></button>
      </div>
      <div className="grid gap-2 overflow-y-auto p-3">
        {templates.map(template => (
          <button key={template.id} type="button" onClick={() => onPlace(template)} className="rounded-lg border border-outline-variant bg-surface-container-lowest p-3 text-left transition hover:border-secondary hover:bg-secondary-container/25">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-on-surface">{template.title}</h4>
              <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-[10px] font-bold uppercase text-on-surface-variant">{template.objects.length} items</span>
            </div>
            <p className="mt-2 text-xs leading-5 text-on-surface-variant">{template.description}</p>
          </button>
        ))}
      </div>
    </aside>
  );
}

function FacilitationDrawer({
  timerSeconds,
  timerRunning,
  voteMode,
  onClose,
  onSetTimer,
  onToggleTimer,
  onResetTimer,
  onToggleVote,
  onClearVotes,
}: {
  timerSeconds: number;
  timerRunning: boolean;
  voteMode: boolean;
  onClose: () => void;
  onSetTimer: (seconds: number) => void;
  onToggleTimer: () => void;
  onResetTimer: () => void;
  onToggleVote: () => void;
  onClearVotes: () => void;
}) {
  return (
    <aside className="absolute bottom-2 right-2 top-2 z-20 flex w-[min(320px,calc(100%-16px))] flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface shadow-xl">
      <div className="flex items-start gap-3 border-b border-outline-variant px-3 py-3">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-secondary-container text-on-secondary-container"><Timer size={16} /></div>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-sm font-semibold text-on-surface">Facilitation</h3>
          <p className="mt-0.5 text-xs text-on-surface-variant">Timer and lightweight dot voting.</p>
        </div>
        <button type="button" onClick={onClose} className="icon-button" aria-label="Close facilitation"><X size={16} /></button>
      </div>
      <div className="space-y-3 overflow-y-auto p-3">
        <section className="rounded-lg border border-outline-variant bg-surface-container-lowest p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-on-surface">Workshop timer</h4>
              <p className="mt-1 text-xs text-on-surface-variant">Use it for silent ideation, review, or voting rounds.</p>
            </div>
            <div className="font-mono text-xl font-bold text-on-surface">{formatTimer(timerSeconds)}</div>
          </div>
          <input
            type="range"
            min={60}
            max={30 * 60}
            step={60}
            value={Math.max(60, timerSeconds)}
            onChange={event => onSetTimer(Number(event.target.value))}
            className="mt-4 w-full accent-[var(--secondary)]"
            disabled={timerRunning}
          />
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn-primary h-9 flex-1 text-xs" onClick={onToggleTimer}>{timerRunning ? "Pause" : "Start"}</button>
            <button type="button" className="btn-secondary h-9 text-xs" onClick={onResetTimer}>Reset</button>
          </div>
        </section>
        <section className="rounded-lg border border-outline-variant bg-surface-container-lowest p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-on-surface">Dot voting</h4>
              <p className="mt-1 text-xs text-on-surface-variant">Select cards and press +1 from the top rail.</p>
            </div>
            <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${voteMode ? "bg-secondary-container text-on-secondary-container" : "bg-surface-container-high text-on-surface-variant"}`}>{voteMode ? "Active" : "Off"}</span>
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn-primary h-9 flex-1 text-xs" onClick={onToggleVote}>{voteMode ? "End voting" : "Start voting"}</button>
            <button type="button" className="btn-secondary h-9 text-xs" onClick={onClearVotes}>Clear votes</button>
          </div>
        </section>
      </div>
    </aside>
  );
}

function RemoteCursorLayer({ present, viewport }: { present: Array<{ userId: string; displayName?: string; cursor?: { x: number; y: number } }>; viewport?: { x: number; y: number; zoom: number } }) {
  if (!viewport) return null;
  const cursors = present.filter(user => user.cursor).slice(0, 12);
  if (!cursors.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {cursors.map((user, index) => {
        const cursor = user.cursor!;
        const left = cursor.x * viewport.zoom + viewport.x;
        const top = cursor.y * viewport.zoom + viewport.y;
        return (
          <div key={user.userId} className="absolute flex items-start gap-1.5" style={{ left, top, transform: "translate(2px, 2px)" }}>
            <MousePointer2 size={18} style={{ color: collaborationColor(user.userId, index), filter: "drop-shadow(0 1px 2px rgba(15,23,42,0.25))" }} />
            <span className="rounded-full px-2 py-0.5 text-[10px] font-bold text-white shadow-sm" style={{ background: collaborationColor(user.userId, index) }}>
              {user.displayName || user.userId.slice(0, 8)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function CollaborationDrawer({
  present,
  followUserId,
  onClose,
  onFollow,
}: {
  present: Array<{ userId: string; displayName?: string; surface?: string; cursor?: { x: number; y: number }; viewport?: { x: number; y: number; zoom: number }; at: number }>;
  followUserId: string | null;
  onClose: () => void;
  onFollow: (userId: string | null) => void;
}) {
  return (
    <aside className="absolute bottom-2 right-2 top-2 z-20 flex w-[min(330px,calc(100%-16px))] flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface shadow-xl">
      <div className="flex items-start gap-3 border-b border-outline-variant px-3 py-3">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-secondary-container text-on-secondary-container"><Users size={16} /></div>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-sm font-semibold text-on-surface">Collaboration</h3>
          <p className="mt-0.5 text-xs text-on-surface-variant">Live cursors and follow mode for facilitation.</p>
        </div>
        <button type="button" onClick={onClose} className="icon-button" aria-label="Close collaboration"><X size={16} /></button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {!present.length ? <p className="text-sm text-on-surface-variant">No collaborators are currently present.</p> : present.map((user, index) => {
          const label = user.displayName || user.userId;
          const following = followUserId === user.userId;
          return (
            <div key={user.userId} className="flex items-center gap-3 rounded-lg border border-outline-variant bg-surface-container-lowest p-2.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-black text-white" style={{ background: collaborationColor(user.userId, index) }}>{initialsFrom(label)}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-on-surface">{label}</div>
                <div className="mt-0.5 text-[10px] uppercase text-on-surface-variant">{user.surface ?? "on board"} · {user.cursor ? "cursor live" : "heartbeat only"}</div>
              </div>
              <button type="button" className="btn-secondary h-8 text-xs" disabled={!user.viewport} onClick={() => onFollow(following ? null : user.userId)}>
                <Presentation size={13} /> {following ? "Stop" : "Follow"}
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function ObjectInspector({
  object,
  selectionCount,
  onClose,
  onEdit,
  onJump,
}: {
  object: BoardObj;
  selectionCount: number;
  onClose: () => void;
  onEdit: (id: string, patch: Record<string, unknown>) => void;
  onJump: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const comments = commentsOf(object);
  const locked = isLocked(object);
  return (
    <aside className="absolute bottom-2 right-2 top-2 z-20 flex w-[min(330px,calc(100%-16px))] flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface shadow-xl">
      <div className="flex items-start gap-3 border-b border-outline-variant px-3 py-3">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-secondary-container text-on-secondary-container"><PanelRightOpen size={16} /></div>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-sm font-semibold text-on-surface">Object details</h3>
          <p className="mt-0.5 text-xs text-on-surface-variant">{selectionCount > 1 ? `${selectionCount} selected · showing first` : objectText(object) || String(object.type)}</p>
        </div>
        <button type="button" onClick={onClose} className="icon-button" aria-label="Close details"><X size={16} /></button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        <section className="rounded-lg border border-outline-variant bg-surface-container-lowest p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wide text-on-surface-variant">Selected object</div>
              <div className="mt-1 text-sm font-semibold text-on-surface">{String(object.type ?? "object")}</div>
            </div>
            <button type="button" className="btn-secondary h-8 text-xs" onClick={() => onJump(object.id)}><Maximize2 size={13} /> Jump</button>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
            <Metric label="Votes" value={String(numberOf(object.votes, 0))} />
            <Metric label="Comments" value={String(comments.length)} />
            <Metric label="State" value={locked ? "Locked" : "Open"} />
          </div>
        </section>
        {String(object.type) === "connector" ? (
          <section className="rounded-lg border border-outline-variant bg-surface-container-lowest p-3">
            <div className="mb-3 flex items-center gap-2"><Link2 size={15} className="text-secondary" /><h4 className="text-sm font-semibold text-on-surface">Connector style</h4></div>
            <label className="grid gap-1 text-xs font-bold text-on-surface-variant">
              Label
              <input value={String(object.label ?? "")} onChange={event => onEdit(object.id, { label: event.target.value })} className="h-9 rounded-md border border-outline-variant bg-surface px-3 text-xs text-on-surface outline-none focus:border-secondary" />
            </label>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-xs font-bold text-on-surface-variant">
                Line
                <select value={String(object.lineStyle ?? "solid")} onChange={event => onEdit(object.id, { lineStyle: event.target.value })} className="h-9 rounded-md border border-outline-variant bg-surface px-2 text-xs text-on-surface">
                  <option value="solid">Solid</option>
                  <option value="dashed">Dashed</option>
                  <option value="dotted">Dotted</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs font-bold text-on-surface-variant">
                Width
                <input type="number" min="1" max="8" value={numberOf(object.strokeWidth, 2)} onChange={event => onEdit(object.id, { strokeWidth: Number(event.target.value) })} className="h-9 rounded-md border border-outline-variant bg-surface px-2 text-xs text-on-surface" />
              </label>
            </div>
            <div className="mt-3 flex items-center gap-1">
              {["#64748b", "#2563eb", "#16a34a", "#dc2626", "#7c3aed"].map(color => (
                <button key={color} type="button" className="h-6 w-6 rounded border border-black/10" style={{ background: color }} title={`Set connector color ${color}`} onClick={() => onEdit(object.id, { strokeColor: color })} />
              ))}
            </div>
          </section>
        ) : null}
        {String(object.type) === "shape" ? (
          <section className="rounded-lg border border-outline-variant bg-surface-container-lowest p-3">
            <div className="mb-3 flex items-center gap-2"><Shapes size={15} className="text-secondary" /><h4 className="text-sm font-semibold text-on-surface">Shape style</h4></div>
            <div className="grid grid-cols-3 gap-2">
              {["rounded", "circle", "diamond"].map(kind => (
                <button key={kind} type="button" className={`rounded-md border px-2 py-2 text-xs font-semibold capitalize ${String(object.shapeKind ?? "rounded") === kind ? "border-secondary bg-secondary-container text-on-secondary-container" : "border-outline-variant bg-surface text-on-surface-variant"}`} onClick={() => onEdit(object.id, { shapeKind: kind })}>
                  {kind}
                </button>
              ))}
            </div>
          </section>
        ) : null}
        <section className="rounded-lg border border-outline-variant bg-surface-container-lowest p-3">
          <div className="mb-3 flex items-center gap-2"><MessageSquarePlus size={15} className="text-secondary" /><h4 className="text-sm font-semibold text-on-surface">Comments</h4></div>
          <div className="space-y-2">
            {comments.length ? comments.map(comment => (
              <div key={comment.id} className="rounded-md border border-outline-variant bg-surface px-3 py-2">
                <p className="text-xs leading-5 text-on-surface">{comment.text}</p>
                <div className="mt-1 text-[10px] text-on-surface-variant">{comment.author} · {new Date(comment.createdAt).toLocaleString()}</div>
                {comment.replies?.length ? (
                  <div className="mt-2 space-y-1.5 border-l border-outline-variant pl-3">
                    {comment.replies.map(reply => (
                      <div key={reply.id} className="rounded bg-surface-container-low px-2 py-1.5">
                        <p className="text-[11px] leading-4 text-on-surface">{reply.text}</p>
                        <div className="mt-0.5 text-[9px] text-on-surface-variant">{reply.author} · {new Date(reply.createdAt).toLocaleString()}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="mt-2 flex gap-2">
                  <input
                    value={replyDrafts[comment.id] ?? ""}
                    onChange={event => setReplyDrafts(current => ({ ...current, [comment.id]: event.target.value }))}
                    placeholder="Reply or @mention…"
                    className="h-8 min-w-0 flex-1 rounded-md border border-outline-variant bg-surface-container-lowest px-2 text-[11px] outline-none focus:border-secondary"
                    disabled={locked}
                  />
                  <button
                    type="button"
                    className="btn-secondary h-8 text-[11px]"
                    disabled={locked || !(replyDrafts[comment.id] ?? "").trim()}
                    onClick={() => {
                      const text = (replyDrafts[comment.id] ?? "").trim();
                      if (!text) return;
                      const next = comments.map(item => item.id === comment.id
                        ? { ...item, replies: [...(item.replies ?? []), { id: crypto.randomUUID(), text, author: "You", createdAt: new Date().toISOString() }] }
                        : item);
                      onEdit(object.id, { comments: next });
                      setReplyDrafts(current => ({ ...current, [comment.id]: "" }));
                    }}
                  >
                    Reply
                  </button>
                </div>
              </div>
            )) : <p className="text-xs text-on-surface-variant">No comments yet.</p>}
          </div>
          <textarea
            value={draft}
            onChange={event => setDraft(event.target.value)}
            placeholder="Add a comment…"
            className="mt-3 min-h-16 w-full resize-none rounded-md border border-outline-variant bg-surface px-3 py-2 text-xs text-on-surface outline-none focus:border-secondary"
          />
          <button
            type="button"
            className="btn-primary mt-2 h-9 w-full text-xs"
            disabled={!draft.trim() || locked}
            onClick={() => {
              const next = [...comments, { id: crypto.randomUUID(), text: draft.trim(), author: "You", createdAt: new Date().toISOString() }];
              onEdit(object.id, { comments: next });
              setDraft("");
            }}
          >
            <MessageSquarePlus size={14} /> Add comment
          </button>
        </section>
      </div>
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-outline-variant bg-surface px-2 py-2">
      <div className="text-sm font-bold text-on-surface">{value}</div>
      <div className="text-[9px] font-bold uppercase text-on-surface-variant">{label}</div>
    </div>
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

function withPosition(object: BoardObj, position: { x: number; y: number }): BoardObj {
  return { ...object, x: Math.round(position.x), y: Math.round(position.y), position: { x: Math.round(position.x), y: Math.round(position.y) } };
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function commentsOf(object: BoardObj): BoardComment[] {
  return Array.isArray(object.comments)
    ? object.comments
      .filter((comment): comment is BoardComment => Boolean(comment) && typeof comment === "object" && typeof (comment as BoardComment).id === "string" && typeof (comment as BoardComment).text === "string")
      .map(comment => ({ ...comment, replies: Array.isArray(comment.replies) ? comment.replies.filter((reply): reply is BoardComment => Boolean(reply) && typeof reply === "object" && typeof (reply as BoardComment).id === "string" && typeof (reply as BoardComment).text === "string") : [] }))
    : [];
}

function isLocked(object: BoardObj): boolean {
  return object.locked === true;
}

function formatTimer(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable;
}

function connectorColor(object: BoardObj): string {
  return typeof object.strokeColor === "string" ? object.strokeColor : "#64748b";
}

function collaborationColor(id: string, index = 0): string {
  const colors = ["#2563eb", "#7c3aed", "#059669", "#dc2626", "#d97706", "#0891b2"];
  let hash = index;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return colors[hash % colors.length]!;
}

function initialsFrom(label: string): string {
  const parts = label.trim().split(/[\s@._-]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : label.slice(0, 2)).toUpperCase();
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

function downloadText(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatBytes(value: number): string {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function boardToSvg(objects: BoardObj[], connectors: BoardObj[]): string {
  const bounds = boardBounds(objects);
  const pad = 80;
  const minX = bounds.minX - pad;
  const minY = bounds.minY - pad;
  const width = Math.max(900, bounds.maxX - bounds.minX + pad * 2);
  const height = Math.max(640, bounds.maxY - bounds.minY + pad * 2);
  const byId = new Map(objects.map(object => [object.id, object]));
  const connectorSvg = connectors.map(connector => {
    const source = byId.get(String(connector.sourceId));
    const target = byId.get(String(connector.targetId));
    if (!source || !target) return "";
    const sp = centerOf(source, minX, minY);
    const tp = centerOf(target, minX, minY);
    return `<line x1="${sp.x}" y1="${sp.y}" x2="${tp.x}" y2="${tp.y}" stroke="${escapeXml(connectorColor(connector))}" stroke-width="${numberOf(connector.strokeWidth, 1.7)}" ${String(connector.lineStyle) === "dashed" ? 'stroke-dasharray="8 6"' : ""} marker-end="url(#arrow)" />`;
  }).join("");
  const objectSvg = objects.map(object => objectToSvg(object, minX, minY)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#64748b"/></marker></defs><rect width="100%" height="100%" fill="#f8fafc"/><g>${connectorSvg}${objectSvg}</g></svg>`;
}

function boardBounds(objects: BoardObj[]) {
  if (!objects.length) return { minX: 0, minY: 0, maxX: 900, maxY: 640 };
  return objects.reduce((acc, object) => {
    const position = positionOf(object);
    const width = numberOf(object.width, 220);
    const height = numberOf(object.height, 148);
    return {
      minX: Math.min(acc.minX, position.x),
      minY: Math.min(acc.minY, position.y),
      maxX: Math.max(acc.maxX, position.x + width),
      maxY: Math.max(acc.maxY, position.y + height),
    };
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function centerOf(object: BoardObj, minX: number, minY: number) {
  const position = positionOf(object);
  return { x: position.x - minX + numberOf(object.width, 220) / 2, y: position.y - minY + numberOf(object.height, 148) / 2 };
}

function objectToSvg(object: BoardObj, minX: number, minY: number): string {
  const position = positionOf(object);
  const x = position.x - minX;
  const y = position.y - minY;
  const width = numberOf(object.width, 220);
  const height = numberOf(object.height, 148);
  const text = escapeXml(objectText(object) || String(object.fileName ?? object.type ?? ""));
  const fill = escapeXml(colorOf(object));
  if (String(object.type) === "frame") {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" fill="rgba(255,255,255,0.3)" stroke="#94a3b8" stroke-dasharray="8 6" stroke-width="2"/><text x="${x + 18}" y="${y + 28}" font-size="14" font-weight="700" fill="#475569">${text}</text>`;
  }
  if (String(object.type) === "image" && typeof object.dataUrl === "string") {
    return `<image href="${escapeXml(object.dataUrl)}" x="${x}" y="${y}" width="${width}" height="${Math.max(40, height - 30)}" preserveAspectRatio="xMidYMid slice"/><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="none" stroke="#cbd5e1"/><text x="${x + 12}" y="${y + height - 10}" font-size="11" fill="#475569">${text}</text>`;
  }
  if (String(object.type) === "file") {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="#ffffff" stroke="#cbd5e1"/><text x="${x + 18}" y="${y + 34}" font-size="14" font-weight="700" fill="#0f172a">${text}</text><text x="${x + 18}" y="${y + 58}" font-size="11" fill="#64748b">${escapeXml(formatBytes(numberOf(object.fileSize, 0)))}</text>`;
  }
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${String(object.shapeKind) === "circle" ? Math.min(width, height) / 2 : 10}" fill="${fill}" stroke="#cbd5e1"/><foreignObject x="${x + 12}" y="${y + 14}" width="${Math.max(20, width - 24)}" height="${Math.max(20, height - 28)}"><div xmlns="http://www.w3.org/1999/xhtml" style="font: 13px system-ui; color:#0f172a; line-height:1.35; white-space:pre-wrap; overflow:hidden;">${text}</div></foreignObject>`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;" }[char]!));
}

function objectText(object: BoardObj): string {
  return [object.title, object.text, object.summary, object.body].filter(value => typeof value === "string" && value.trim()).join(" — ");
}

function colorOf(object?: BoardObj): string {
  return object && typeof object.color === "string" ? object.color : "#fef3c7";
}
