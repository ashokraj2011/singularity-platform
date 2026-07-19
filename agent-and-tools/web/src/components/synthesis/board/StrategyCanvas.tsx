"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  History,
  Image as ImageIcon,
  Lightbulb,
  Loader2,
  Lock,
  Maximize,
  Maximize2,
  Minus,
  MousePointer2,
  Pencil,
  Plus,
  Redo2,
  Search,
  Shapes,
  Share2,
  StickyNote,
  Table,
  Trash2,
  Type,
  Undo2,
  Unlock,
  Upload,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  useRooms,
  useClaims,
  useProjectProbes,
  useCanvasLayout,
  saveCanvasLayout,
  uploadCanvasImage,
  createRoom,
  createClaim,
} from "@/components/synthesis/hooks/useSynthesis";
import { SynSkeleton, SynError } from "@/components/synthesis/ui/kit";
import type { ClaimType } from "@/components/synthesis/types";
import {
  KIND_META,
  NOTE_H,
  NOTE_W,
  buildBoardModel,
  type BoardModel,
  type StickyKind,
} from "./boardModel";
import {
  EMPTY_DOC,
  canRedo,
  canUndo,
  initHistory,
  mergeNotePositions,
  pushHistory,
  redo,
  toSavePayload,
  undo,
  type CanvasDoc,
  type CanvasObject,
  type CanvasViewport,
  type History as CanvasHistory,
  type Positions,
} from "./canvasLayout";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;

const KIND_ICON: Record<StickyKind, LucideIcon> = {
  KNOWN_FACT: CheckCircle2,
  RISKY_ASSUMPTION: AlertTriangle,
  VALIDATION_PROBE: FlaskConical,
  OPEN_QUESTION: Lightbulb,
};

const CLAIM_TYPES: { key: ClaimType; label: string }[] = [
  { key: "MARKET", label: "Market" },
  { key: "USER", label: "User" },
  { key: "OPERATIONAL", label: "Operational" },
  { key: "TECHNICAL", label: "Technical" },
];

/** Interactive tools. Note-composer aside, each maps to a real edit or gesture. */
type Tool = "pointer" | "note" | "text" | "shape" | "pen" | "image";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const uid = () => Math.random().toString(36).slice(2, 10);

const DEFAULT_OBJECT_W = 200;
const DEFAULT_OBJECT_H = 120;

/**
 * Freeform sticky-note whiteboard over the initiative's existing claims/probes, with a persistent
 * per-user layer on top: sticky positions, free-form annotations (text / shape / pen / image) and the
 * last viewport are saved server-side and reloaded on the user's next visit (see canvasLayout.ts +
 * useCanvasLayout / saveCanvasLayout). Rearranging your board never moves anyone else's.
 */
export function StrategyCanvas({ projectId }: { projectId: string }) {
  const roomsQ = useRooms(projectId);
  const claimsQ = useClaims(projectId, {}, { refreshInterval: 20000 });
  const claims = useMemo(() => claimsQ.data?.items ?? [], [claimsQ.data]);
  const rooms = useMemo(() => roomsQ.data?.items ?? [], [roomsQ.data]);
  const claimIds = useMemo(() => claims.map((c) => c.id), [claims]);
  const probesQ = useProjectProbes(claimIds);
  const probes = useMemo(() => probesQ.data ?? [], [probesQ.data]);
  const layoutQ = useCanvasLayout(projectId);

  const model: BoardModel = useMemo(
    () => buildBoardModel({ rooms, claims, probes }),
    [rooms, claims, probes],
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const [viewport, setViewport] = useState<CanvasViewport>({ x: 0, y: 0, z: 1 });
  const [history, setHistory] = useState<CanvasHistory<CanvasDoc>>(() => initHistory(EMPTY_DOC));
  const doc = history.present;
  const [search, setSearch] = useState("");
  const [tool, setTool] = useState<Tool>("pointer");
  const [composerOpen, setComposerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const didFit = useRef(false);
  const hydrated = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Commit a new document into history (drives undo/redo + triggers a debounced save).
  const commit = useCallback((next: CanvasDoc) => {
    setHistory((h) => pushHistory(h, next));
  }, []);

  // Live-update the present without creating a history entry (used during a drag; the drag-end
  // commits once so undo rolls back a whole gesture rather than every pixel).
  const patchPresent = useCallback((updater: (doc: CanvasDoc) => CanvasDoc) => {
    setHistory((h) => ({ ...h, present: updater(h.present) }));
  }, []);

  // Hydrate the persisted per-user layout once it arrives (or fall back to an empty doc).
  useEffect(() => {
    if (hydrated.current || layoutQ.isLoading) return;
    const data = layoutQ.data;
    const objects = Array.isArray(data?.objects) ? (data!.objects as CanvasObject[]) : [];
    const positions = (data?.positions as Positions) ?? {};
    setHistory(initHistory({ positions, objects }));
    if (data?.viewport) setViewport(data.viewport);
    hydrated.current = true;
  }, [layoutQ.isLoading, layoutQ.data]);

  // Reconcile saved sticky positions with the notes that currently exist: keep overrides for live
  // notes, drop stale ones, seed new notes from the deterministic layout.
  useEffect(() => {
    if (!hydrated.current || !model.notes.length) return;
    setHistory((h) => {
      const merged = mergeNotePositions(model.notes, h.present.positions);
      const same =
        Object.keys(merged).length === Object.keys(h.present.positions).length &&
        model.notes.every((n) => {
          const a = merged[n.id];
          const b = h.present.positions[n.id];
          return b && a.x === b.x && a.y === b.y;
        });
      if (same) return h;
      return { ...h, present: { ...h.present, positions: merged } };
    });
  }, [model.notes]);

  // Debounced persistence: whenever the committed doc or viewport changes post-hydration, save.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef<string>("");
  useEffect(() => {
    if (!hydrated.current) return;
    const payload = toSavePayload(doc, viewport);
    const serialized = JSON.stringify(payload);
    if (serialized === lastSaved.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveState("saving");
      try {
        await saveCanvasLayout(projectId, payload);
        lastSaved.current = serialized;
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
    }, 700);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [doc, viewport, projectId]);

  // Track the viewport element size for fit + minimap projection.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sync = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const positions = doc.positions;

  const fit = useCallback(() => {
    const { w: bw, h: bh } = model.bounds;
    if (!bw || !bh) return;
    const pad = 48;
    const z = clamp(Math.min((size.w - pad * 2) / bw, (size.h - pad * 2) / bh), MIN_ZOOM, MAX_ZOOM);
    setViewport({ z, x: (size.w - bw * z) / 2, y: (size.h - bh * z) / 2 });
  }, [model.bounds, size.w, size.h]);

  // One-time fit once geometry and size are known — unless the user has a saved viewport.
  useEffect(() => {
    if (didFit.current) return;
    if (layoutQ.isLoading) return;
    if (layoutQ.data?.viewport) {
      didFit.current = true;
      return;
    }
    if (model.notes.length && size.w > 1) {
      fit();
      didFit.current = true;
    }
  }, [model.notes.length, size.w, fit, layoutQ.isLoading, layoutQ.data]);

  const zoomAt = useCallback((clientX: number, clientY: number, nextZ: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    setViewport((v) => {
      const z = clamp(nextZ, MIN_ZOOM, MAX_ZOOM);
      const wx = (cx - v.x) / v.z;
      const wy = (cy - v.y) / v.z;
      return { z, x: cx - wx * z, y: cy - wy * z };
    });
  }, []);

  const onWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      if (!e.ctrlKey && !e.metaKey && e.deltaMode === 0 && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        setViewport((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
        return;
      }
      zoomAt(e.clientX, e.clientY, viewport.z * (1 - e.deltaY * 0.0015));
    },
    [zoomAt, viewport.z],
  );

  // Convert a client point to board coordinates under the current viewport transform.
  const toBoard = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - viewport.x) / viewport.z,
        y: (clientY - rect.top - viewport.y) / viewport.z,
      };
    },
    [viewport],
  );

  // Unified pointer drag: pan the board, move a note, move an object, or draw a pen stroke.
  const drag = useRef<
    | { type: "pan"; sx: number; sy: number; ox: number; oy: number }
    | { type: "note"; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean }
    | { type: "object"; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean }
    | { type: "pen"; id: string }
    | null
  >(null);

  const beginCanvasPointer = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      setSelectedId(null);
      const p = toBoard(e.clientX, e.clientY);
      if (tool === "note") {
        setComposerOpen(true);
        return;
      }
      if (tool === "text") {
        const obj: CanvasObject = { id: uid(), type: "text", x: p.x, y: p.y, w: DEFAULT_OBJECT_W, h: 56, text: "" };
        commit({ ...doc, objects: [...doc.objects, obj] });
        setSelectedId(obj.id);
        setTool("pointer");
        return;
      }
      if (tool === "shape") {
        const obj: CanvasObject = {
          id: uid(),
          type: "shape",
          shape: "rect",
          x: p.x,
          y: p.y,
          w: DEFAULT_OBJECT_W,
          h: DEFAULT_OBJECT_H,
        };
        commit({ ...doc, objects: [...doc.objects, obj] });
        setSelectedId(obj.id);
        setTool("pointer");
        return;
      }
      if (tool === "image") {
        fileInputRef.current?.click();
        return;
      }
      if (tool === "pen") {
        const id = uid();
        const obj: CanvasObject = { id, type: "pen", x: 0, y: 0, points: [p.x, p.y], strokeWidth: 3 };
        patchPresent((d) => ({ ...d, objects: [...d.objects, obj] }));
        drag.current = { type: "pen", id };
        containerRef.current?.setPointerCapture(e.pointerId);
        return;
      }
      // pointer tool → pan
      if (locked) return;
      drag.current = { type: "pan", sx: e.clientX, sy: e.clientY, ox: viewport.x, oy: viewport.y };
      containerRef.current?.setPointerCapture(e.pointerId);
    },
    [tool, toBoard, doc, commit, patchPresent, locked, viewport.x, viewport.y],
  );

  const beginNoteDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, id: string) => {
      e.stopPropagation();
      setSelectedId(id);
      if (locked) return;
      const pos = positions[id];
      if (!pos) return;
      drag.current = { type: "note", id, sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false };
      containerRef.current?.setPointerCapture(e.pointerId);
    },
    [positions, locked],
  );

  const beginObjectDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, id: string) => {
      e.stopPropagation();
      setSelectedId(id);
      if (locked) return;
      const obj = doc.objects.find((o) => o.id === id);
      if (!obj) return;
      drag.current = { type: "object", id, sx: e.clientX, sy: e.clientY, ox: obj.x, oy: obj.y, moved: false };
      containerRef.current?.setPointerCapture(e.pointerId);
    },
    [doc.objects, locked],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      if (d.type === "pan") {
        const dx = e.clientX - d.sx;
        const dy = e.clientY - d.sy;
        setViewport((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
        return;
      }
      if (d.type === "pen") {
        const p = toBoard(e.clientX, e.clientY);
        patchPresent((doc) => ({
          ...doc,
          objects: doc.objects.map((o) =>
            o.id === d.id && o.type === "pen" ? { ...o, points: [...o.points, p.x, p.y] } : o,
          ),
        }));
        return;
      }
      const dx = (e.clientX - d.sx) / viewport.z;
      const dy = (e.clientY - d.sy) / viewport.z;
      d.moved = true;
      if (d.type === "note") {
        patchPresent((doc) => ({
          ...doc,
          positions: { ...doc.positions, [d.id]: { x: d.ox + dx, y: d.oy + dy } },
        }));
      } else {
        patchPresent((doc) => ({
          ...doc,
          objects: doc.objects.map((o) => (o.id === d.id ? { ...o, x: d.ox + dx, y: d.oy + dy } : o)),
        }));
      }
    },
    [toBoard, patchPresent, viewport.z],
  );

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      drag.current = null;
      if (containerRef.current?.hasPointerCapture(e.pointerId)) {
        containerRef.current.releasePointerCapture(e.pointerId);
      }
      // Commit the finished gesture as a single history entry so undo rolls back the whole move/stroke.
      if (d && (d.type === "pen" || ((d.type === "note" || d.type === "object") && d.moved))) {
        setHistory((h) => pushHistory({ ...h }, h.present));
      }
      if (tool === "pen") {
        // stay in pen mode for repeated strokes
      }
    },
    [tool],
  );

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    if (doc.objects.some((o) => o.id === selectedId)) {
      commit({ ...doc, objects: doc.objects.filter((o) => o.id !== selectedId) });
      setSelectedId(null);
    }
  }, [selectedId, doc, commit]);

  const updateObject = useCallback(
    (id: string, patch: Partial<CanvasObject>) => {
      commit({
        ...doc,
        objects: doc.objects.map((o) => (o.id === id ? ({ ...o, ...patch } as CanvasObject) : o)),
      });
    },
    [doc, commit],
  );

  // Keyboard: undo/redo + delete selected object.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        setHistory((h) => redo(h));
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, deleteSelected]);

  const onUploadFile = useCallback(
    async (file: File) => {
      try {
        const p = toBoard(size.w / 2, size.h / 2);
        const uploaded = await uploadCanvasImage(projectId, file);
        const obj: CanvasObject = {
          id: uid(),
          type: "image",
          x: p.x - 120,
          y: p.y - 90,
          w: 240,
          h: 180,
          storageKey: uploaded.storageKey,
          bucket: uploaded.bucket,
          mimeType: uploaded.mimeType,
          url: uploaded.url,
        };
        commit({ ...doc, objects: [...doc.objects, obj] });
        setSelectedId(obj.id);
      } catch {
        setSaveState("error");
      } finally {
        setTool("pointer");
      }
    },
    [projectId, toBoard, size.w, size.h, doc, commit],
  );

  const query = search.trim().toLowerCase();
  const matches = useCallback(
    (text: string, kind: StickyKind) =>
      !query ||
      text.toLowerCase().includes(query) ||
      KIND_META[kind].label.toLowerCase().includes(query) ||
      KIND_META[kind].tag.toLowerCase().includes(query),
    [query],
  );

  const activeRoomTitle = rooms[0]?.title ?? "Idea Board 01";
  const loading = claimsQ.isLoading || roomsQ.isLoading || layoutQ.isLoading;

  const cursor =
    tool === "note" || tool === "text" || tool === "shape"
      ? "copy"
      : tool === "pen"
        ? "crosshair"
        : tool === "image"
          ? "copy"
          : drag.current?.type === "pan"
            ? "grabbing"
            : locked
              ? "default"
              : "grab";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest">
      <TopStrip
        boardTitle={activeRoomTitle}
        search={search}
        onSearch={setSearch}
        count={model.notes.length}
        saveState={saveState}
      />

      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          className="syn-dot-grid absolute inset-0 overflow-hidden"
          style={{ cursor, touchAction: "none" }}
          onWheel={onWheel}
          onPointerDown={beginCanvasPointer}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {claimsQ.error ? (
            <div className="absolute left-1/2 top-24 w-[min(520px,90%)] -translate-x-1/2">
              <SynError message={`Could not load claims: ${(claimsQ.error as Error).message}`} />
            </div>
          ) : loading ? (
            <div className="absolute left-1/2 top-24 w-[min(520px,90%)] -translate-x-1/2">
              <SynSkeleton rows={4} />
            </div>
          ) : model.notes.length === 0 && doc.objects.length === 0 ? (
            <EmptyCanvas onAdd={() => setComposerOpen(true)} />
          ) : (
            <div
              className="absolute left-0 top-0 origin-top-left"
              style={{
                transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.z})`,
                width: model.bounds.w,
                height: model.bounds.h,
              }}
            >
              <BoardSvg model={model} positions={positions} objects={doc.objects} />
              {doc.objects.map((obj) => (
                <CanvasObjectView
                  key={obj.id}
                  obj={obj}
                  selected={selectedId === obj.id}
                  locked={locked}
                  onPointerDown={(e) => beginObjectDrag(e, obj.id)}
                  onChangeText={(text) => updateObject(obj.id, { text } as Partial<CanvasObject>)}
                />
              ))}
              {model.notes.map((note) => {
                const pos = positions[note.id] ?? { x: note.x, y: note.y };
                return (
                  <StickyNoteView
                    key={note.id}
                    kind={note.kind}
                    body={note.body}
                    x={pos.x}
                    y={pos.y}
                    dim={!matches(note.body, note.kind)}
                    selected={selectedId === note.id}
                    onPointerDown={(e) => beginNoteDrag(e, note.id)}
                  />
                );
              })}
            </div>
          )}

          <RightRail
            locked={locked}
            penActive={tool === "pen"}
            onPen={() => setTool((t) => (t === "pen" ? "pointer" : "pen"))}
            onToggleLock={() => setLocked((l) => !l)}
          />
          <BottomToolbar
            tool={tool}
            onTool={setTool}
            onAddNote={() => {
              setTool("note");
              setComposerOpen(true);
            }}
            onImage={() => fileInputRef.current?.click()}
            onFullscreen={() => containerRef.current?.requestFullscreen?.()}
          />
          <HistoryControls
            canUndo={canUndo(history)}
            canRedo={canRedo(history)}
            canDelete={!!selectedId && doc.objects.some((o) => o.id === selectedId)}
            onUndo={() => setHistory((h) => undo(h))}
            onRedo={() => setHistory((h) => redo(h))}
            onDelete={deleteSelected}
          />
          <ZoomControls
            zoom={viewport.z}
            onZoomIn={() => zoomAt(size.w / 2, size.h / 2, viewport.z + 0.15)}
            onZoomOut={() => zoomAt(size.w / 2, size.h / 2, viewport.z - 0.15)}
            onFit={fit}
          />
          <Minimap model={model} positions={positions} viewport={viewport} size={size} />
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onUploadFile(file);
            e.target.value = "";
          }}
        />

        {composerOpen ? (
          <AddNoteComposer
            projectId={projectId}
            rooms={rooms}
            onClose={() => {
              setComposerOpen(false);
              setTool("pointer");
            }}
            onCreated={async () => {
              await Promise.all([claimsQ.mutate(), roomsQ.mutate()]);
            }}
            onRoomCreated={() => roomsQ.mutate()}
          />
        ) : null}
      </div>
    </div>
  );
}

/* ─── Top strip ─────────────────────────────────────────────────────────── */

function SaveIndicator({ state }: { state: "idle" | "saving" | "saved" | "error" }) {
  if (state === "idle") return null;
  const map = {
    saving: { text: "Saving…", cls: "text-on-surface-variant" },
    saved: { text: "Saved", cls: "text-on-surface-variant" },
    error: { text: "Save failed", cls: "text-error" },
  } as const;
  const { text, cls } = map[state];
  return (
    <span className={`hidden items-center gap-1 font-mono text-[11px] md:inline-flex ${cls}`} aria-live="polite">
      {state === "saving" ? <Loader2 size={12} className="animate-spin" /> : null}
      {text}
    </span>
  );
}

function TopStrip({
  boardTitle,
  search,
  onSearch,
  count,
  saveState,
}: {
  boardTitle: string;
  search: string;
  onSearch: (value: string) => void;
  count: number;
  saveState: "idle" | "saving" | "saved" | "error";
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-outline-variant bg-surface-container-lowest px-4 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-on-surface-variant">
          <span>Workspace</span>
          <span aria-hidden>/</span>
          <span>Synthesis</span>
          <span aria-hidden>/</span>
          <span className="text-secondary">Idea Board</span>
        </div>
        <h2 className="truncate text-sm font-black text-on-surface">
          Strategy Canvas: {boardTitle}
        </h2>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <SaveIndicator state={saveState} />
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant"
          />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search board…"
            className="h-9 w-[180px] rounded-lg border border-outline-variant bg-surface-container-low pl-8 pr-3 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-secondary focus:outline-none"
          />
        </div>
        <div className="hidden items-center -space-x-2 sm:flex" aria-hidden>
          {["A", "R", "K"].map((initial, i) => (
            <span
              key={initial}
              className={`grid h-7 w-7 place-items-center rounded-full border-2 border-surface-container-lowest text-[10px] font-bold text-on-secondary-container ${
                i === 0 ? "bg-secondary-container" : i === 1 ? "bg-tertiary-container/40" : "bg-surface-container-high"
              }`}
            >
              {initial}
            </span>
          ))}
        </div>
        <button
          type="button"
          title="Sharing is a placeholder in this preview"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-secondary px-3 text-sm font-semibold text-on-secondary"
        >
          <Share2 size={15} /> Share
        </button>
        <span className="hidden font-mono text-[11px] text-on-surface-variant md:inline">{count} notes</span>
      </div>
    </div>
  );
}

/* ─── SVG frames + connectors + pen strokes ─────────────────────────────── */

function BoardSvg({
  model,
  positions,
  objects,
}: {
  model: BoardModel;
  positions: Positions;
  objects: CanvasObject[];
}) {
  const center = (id: string) => {
    const p = positions[id];
    if (!p) return null;
    return { x: p.x + NOTE_W / 2, y: p.y + NOTE_H / 2 };
  };
  const pens = objects.filter((o): o is Extract<CanvasObject, { type: "pen" }> => o.type === "pen");
  return (
    <svg
      className="pointer-events-none absolute left-0 top-0"
      width={model.bounds.w}
      height={model.bounds.h}
      aria-hidden
    >
      {model.frames.map((f) => (
        <g key={f.roomId}>
          <rect
            x={f.x}
            y={f.y}
            width={f.w}
            height={f.h}
            rx={18}
            fill="transparent"
            stroke="var(--syn-sticky-frame)"
            strokeWidth={1.5}
            strokeDasharray="8 7"
          />
          <text
            x={f.x + 18}
            y={f.y + 27}
            fill="var(--color-on-surface-variant)"
            style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.14em" }}
          >
            {f.label}
          </text>
        </g>
      ))}
      {model.connectors.map((c) => {
        const from = center(c.fromId);
        const to = center(c.toId);
        if (!from || !to) return null;
        const midX = (from.x + to.x) / 2;
        return (
          <path
            key={c.id}
            d={`M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`}
            fill="none"
            stroke="var(--syn-sticky-blue-edge)"
            strokeWidth={1.75}
            strokeDasharray="6 6"
          />
        );
      })}
      {pens.map((pen) => (
        <polyline
          key={pen.id}
          points={pointsToStr(pen.points)}
          fill="none"
          stroke={pen.color ?? "var(--color-on-surface)"}
          strokeWidth={pen.strokeWidth ?? 3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

function pointsToStr(flat: number[]): string {
  let out = "";
  for (let i = 0; i + 1 < flat.length; i += 2) out += `${flat[i]},${flat[i + 1]} `;
  return out.trim();
}

/* ─── Free-form objects (text / shape / image) ──────────────────────────── */

function CanvasObjectView({
  obj,
  selected,
  locked,
  onPointerDown,
  onChangeText,
}: {
  obj: CanvasObject;
  selected: boolean;
  locked: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onChangeText: (text: string) => void;
}) {
  if (obj.type === "pen") return null; // drawn on the SVG layer
  const ring = selected ? "outline outline-2 outline-secondary" : "";
  const base: CSSProperties = {
    left: obj.x,
    top: obj.y,
    width: obj.w ?? DEFAULT_OBJECT_W,
    height: obj.h ?? DEFAULT_OBJECT_H,
    cursor: locked ? "default" : "grab",
  };

  if (obj.type === "text") {
    return (
      <div className={`absolute ${ring} rounded`} style={base} onPointerDown={onPointerDown}>
        <textarea
          value={obj.text}
          onChange={(e) => onChangeText(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder="Type…"
          className="h-full w-full resize-none rounded bg-transparent p-1.5 text-[13px] font-medium leading-snug text-on-surface placeholder:text-on-surface-variant focus:outline-none"
          style={{ color: obj.color ?? "var(--color-on-surface)" }}
        />
      </div>
    );
  }

  if (obj.type === "shape") {
    return (
      <div
        className={`absolute ${ring}`}
        style={{
          ...base,
          border: `2px solid ${obj.color ?? "var(--color-outline)"}`,
          borderRadius: obj.shape === "ellipse" ? "50%" : 10,
          background: "transparent",
        }}
        onPointerDown={onPointerDown}
      />
    );
  }

  // image
  return (
    <div className={`absolute overflow-hidden rounded ${ring}`} style={base} onPointerDown={onPointerDown}>
      {obj.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={obj.url} alt="" draggable={false} className="h-full w-full select-none object-cover" />
      ) : (
        <div className="grid h-full w-full place-items-center bg-surface-container text-on-surface-variant">
          <ImageIcon size={20} />
        </div>
      )}
    </div>
  );
}

/* ─── Sticky note ───────────────────────────────────────────────────────── */

function StickyNoteView({
  kind,
  body,
  x,
  y,
  dim,
  selected,
  onPointerDown,
}: {
  kind: StickyKind;
  body: string;
  x: number;
  y: number;
  dim: boolean;
  selected: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const meta = KIND_META[kind];
  const Icon = KIND_ICON[kind];
  const style: CSSProperties = {
    left: x,
    top: y,
    width: NOTE_W,
    height: NOTE_H,
    background: `var(--syn-sticky-${meta.palette}-bg)`,
    borderColor: `var(--syn-sticky-${meta.palette}-edge)`,
    color: "var(--syn-sticky-ink)",
    opacity: dim ? 0.32 : 1,
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onPointerDown={onPointerDown}
      className={`absolute flex cursor-grab select-none flex-col rounded-xl border p-3 shadow-[0_6px_16px_rgba(15,23,42,0.12)] transition-shadow active:cursor-grabbing ${
        selected ? "outline outline-2 outline-secondary" : ""
      }`}
      style={style}
    >
      <div className="text-[10px] font-black uppercase tracking-[0.12em] opacity-80">{meta.label}</div>
      <p className="mt-1.5 line-clamp-4 flex-1 text-[13px] font-medium leading-snug">{body}</p>
      <div className="mt-1 flex items-center justify-between">
        <Icon size={15} strokeWidth={2} className="opacity-75" />
        <span className="font-mono text-[10px] font-bold tracking-wide opacity-70">{meta.tag}</span>
      </div>
    </div>
  );
}

/* ─── Overlays: rails, toolbar, zoom, minimap ───────────────────────────── */

function PlaceholderButton({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <button
      type="button"
      title={`${label} (preview placeholder)`}
      aria-label={label}
      className="grid h-9 w-9 place-items-center rounded-lg text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
    >
      <Icon size={17} />
    </button>
  );
}

function ToolButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`grid h-9 w-9 place-items-center rounded-lg ${
        active
          ? "bg-secondary-container text-on-secondary-container"
          : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
      }`}
    >
      <Icon size={17} />
    </button>
  );
}

function RightRail({
  locked,
  penActive,
  onPen,
  onToggleLock,
}: {
  locked: boolean;
  penActive: boolean;
  onPen: () => void;
  onToggleLock: () => void;
}) {
  return (
    <div className="absolute right-3 top-1/2 flex -translate-y-1/2 flex-col gap-1 rounded-xl border border-outline-variant bg-surface-container-lowest p-1 shadow-md">
      <ToolButton icon={Pencil} label="Pen" active={penActive} onClick={onPen} />
      <ToolButton
        icon={locked ? Lock : Unlock}
        label={locked ? "Board locked — click to unlock" : "Lock board (disable pan / move)"}
        active={locked}
        onClick={onToggleLock}
      />
      <PlaceholderButton icon={History} label="Version history" />
    </div>
  );
}

function BottomToolbar({
  tool,
  onTool,
  onAddNote,
  onImage,
  onFullscreen,
}: {
  tool: Tool;
  onTool: (t: Tool) => void;
  onAddNote: () => void;
  onImage: () => void;
  onFullscreen: () => void;
}) {
  return (
    <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-outline-variant bg-surface-container-lowest p-1.5 shadow-lg">
      <ToolButton icon={MousePointer2} label="Select / pan" active={tool === "pointer"} onClick={() => onTool("pointer")} />
      <ToolButton icon={StickyNote} label="Add sticky note" active={tool === "note"} onClick={onAddNote} />
      <span className="mx-1 h-6 w-px bg-outline-variant" aria-hidden />
      <ToolButton icon={Type} label="Text — click to place" active={tool === "text"} onClick={() => onTool("text")} />
      <ToolButton icon={ImageIcon} label="Image — upload & place" active={tool === "image"} onClick={onImage} />
      <ToolButton icon={Shapes} label="Shape — click to place" active={tool === "shape"} onClick={() => onTool("shape")} />
      <PlaceholderButton icon={Table} label="Table" />
      <ToolButton icon={Upload} label="Upload image" active={false} onClick={onImage} />
      <span className="mx-1 h-6 w-px bg-outline-variant" aria-hidden />
      <button
        type="button"
        title="Fullscreen"
        aria-label="Fullscreen"
        onClick={onFullscreen}
        className="grid h-9 w-9 place-items-center rounded-lg text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
      >
        <Maximize2 size={17} />
      </button>
    </div>
  );
}

function HistoryControls({
  canUndo,
  canRedo,
  canDelete,
  onUndo,
  onRedo,
  onDelete,
}: {
  canUndo: boolean;
  canRedo: boolean;
  canDelete: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
}) {
  const cls = (enabled: boolean) =>
    `grid h-8 w-8 place-items-center rounded-lg ${
      enabled ? "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface" : "text-on-surface-variant/30"
    }`;
  return (
    <div className="absolute left-3 top-3 flex items-center gap-1 rounded-xl border border-outline-variant bg-surface-container-lowest p-1 shadow-md">
      <button type="button" title="Undo (⌘/Ctrl+Z)" aria-label="Undo" disabled={!canUndo} onClick={onUndo} className={cls(canUndo)}>
        <Undo2 size={16} />
      </button>
      <button type="button" title="Redo (⌘/Ctrl+Shift+Z)" aria-label="Redo" disabled={!canRedo} onClick={onRedo} className={cls(canRedo)}>
        <Redo2 size={16} />
      </button>
      <span className="mx-0.5 h-5 w-px bg-outline-variant" aria-hidden />
      <button type="button" title="Delete selected (Del)" aria-label="Delete selected" disabled={!canDelete} onClick={onDelete} className={cls(canDelete)}>
        <Trash2 size={16} />
      </button>
    </div>
  );
}

function ZoomControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onFit,
}: {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}) {
  return (
    <div className="absolute bottom-4 left-3 flex items-center gap-1 rounded-xl border border-outline-variant bg-surface-container-lowest p-1 shadow-md">
      <button type="button" title="Zoom out" aria-label="Zoom out" onClick={onZoomOut} className="grid h-8 w-8 place-items-center rounded-lg text-on-surface-variant hover:bg-surface-container-high">
        <Minus size={16} />
      </button>
      <span className="w-11 text-center font-mono text-[11px] font-semibold text-on-surface tabular-nums">
        {Math.round(zoom * 100)}%
      </span>
      <button type="button" title="Zoom in" aria-label="Zoom in" onClick={onZoomIn} className="grid h-8 w-8 place-items-center rounded-lg text-on-surface-variant hover:bg-surface-container-high">
        <Plus size={16} />
      </button>
      <button type="button" title="Fit to board" aria-label="Fit to board" onClick={onFit} className="grid h-8 w-8 place-items-center rounded-lg text-on-surface-variant hover:bg-surface-container-high">
        <Maximize size={15} />
      </button>
    </div>
  );
}

function Minimap({
  model,
  positions,
  viewport,
  size,
}: {
  model: BoardModel;
  positions: Positions;
  viewport: CanvasViewport;
  size: { w: number; h: number };
}) {
  const mmW = 168;
  const mmH = 112;
  const { w: bw, h: bh } = model.bounds;
  if (!bw || !bh || !model.notes.length) return null;
  const scale = Math.min(mmW / bw, mmH / bh);
  const viewW = (size.w / viewport.z) * scale;
  const viewH = (size.h / viewport.z) * scale;
  const viewX = (-viewport.x / viewport.z) * scale;
  const viewY = (-viewport.y / viewport.z) * scale;
  return (
    <div className="absolute bottom-4 right-3 overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest shadow-md" style={{ width: mmW, height: mmH }}>
      <svg width={mmW} height={mmH} aria-hidden>
        {model.notes.map((n) => {
          const p = positions[n.id] ?? { x: n.x, y: n.y };
          return (
            <rect
              key={n.id}
              x={p.x * scale}
              y={p.y * scale}
              width={Math.max(2, NOTE_W * scale)}
              height={Math.max(2, NOTE_H * scale)}
              rx={1}
              fill={`var(--syn-sticky-${KIND_META[n.kind].palette}-edge)`}
            />
          );
        })}
        <rect
          x={clamp(viewX, 0, mmW)}
          y={clamp(viewY, 0, mmH)}
          width={clamp(viewW, 4, mmW)}
          height={clamp(viewH, 4, mmH)}
          fill="none"
          stroke="var(--color-secondary)"
          strokeWidth={1.5}
        />
      </svg>
    </div>
  );
}

/* ─── Empty state + add-note composer ───────────────────────────────────── */

function EmptyCanvas({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center">
      <div className="mb-4 grid h-12 w-12 place-items-center rounded-lg bg-surface-container text-on-surface-variant">
        <StickyNote size={24} />
      </div>
      <h3 className="text-lg font-black text-on-surface">The canvas is empty</h3>
      <p className="mt-2 max-w-sm text-sm text-on-surface-variant">
        Add a sticky note to capture your first claim. Notes are colour-coded by confidence and risk as
        the team estimates them.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-lg bg-secondary px-4 text-sm font-semibold text-on-secondary"
      >
        <Plus size={16} /> Add note
      </button>
    </div>
  );
}

function AddNoteComposer({
  projectId,
  rooms,
  onClose,
  onCreated,
  onRoomCreated,
}: {
  projectId: string;
  rooms: { id: string; title: string }[];
  onClose: () => void;
  onCreated: () => Promise<void>;
  onRoomCreated: () => void;
}) {
  const [statement, setStatement] = useState("");
  const [claimType, setClaimType] = useState<ClaimType>("MARKET");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function ensureRoom(): Promise<string> {
    if (rooms[0]) return rooms[0].id;
    const room = await createRoom(projectId, "Idea Board");
    onRoomCreated();
    return room.id;
  }

  async function submit() {
    if (!statement.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const roomId = await ensureRoom();
      await createClaim(projectId, {
        roomId,
        statement: statement.trim(),
        claimType,
        initialEstimate: 0.5,
      });
      await onCreated();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="absolute right-3 top-3 w-[320px] rounded-xl border border-outline-variant bg-surface-container-lowest p-4 shadow-xl">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-black text-on-surface">Add a note</h3>
        <button type="button" onClick={onClose} className="icon-button" aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <textarea
        value={statement}
        onChange={(e) => setStatement(e.target.value)}
        rows={3}
        autoFocus
        placeholder="Capture a claim or assumption…"
        className="w-full resize-none rounded-lg border border-outline-variant bg-surface-container-low p-2.5 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-secondary focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {CLAIM_TYPES.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setClaimType(t.key)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
              claimType === t.key ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-surface-container-high"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {err ? <p className="mt-2 text-xs text-error">{err}</p> : null}
      <button
        type="button"
        onClick={submit}
        disabled={!statement.trim() || busy}
        className="mt-3 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-secondary text-sm font-semibold text-on-secondary disabled:opacity-45"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
        {busy ? "Adding…" : "Add note"}
      </button>
      <p className="mt-2 text-[11px] leading-4 text-on-surface-variant">
        New notes start as open questions; their colour updates as the team adds estimates.
      </p>
    </div>
  );
}
