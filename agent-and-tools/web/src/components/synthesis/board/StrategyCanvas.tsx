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
  Search,
  Shapes,
  Share2,
  StickyNote,
  Table,
  Type,
  Upload,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  useRooms,
  useClaims,
  useProjectProbes,
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

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

interface Viewport {
  x: number;
  y: number;
  z: number;
}
type Positions = Record<string, { x: number; y: number }>;

/** Freeform sticky-note whiteboard over the initiative's existing claims/probes. */
export function StrategyCanvas({ projectId }: { projectId: string }) {
  const roomsQ = useRooms(projectId);
  const claimsQ = useClaims(projectId, {}, { refreshInterval: 20000 });
  const claims = useMemo(() => claimsQ.data?.items ?? [], [claimsQ.data]);
  const rooms = useMemo(() => roomsQ.data?.items ?? [], [roomsQ.data]);
  const claimIds = useMemo(() => claims.map((c) => c.id), [claims]);
  const probesQ = useProjectProbes(claimIds);
  const probes = useMemo(() => probesQ.data ?? [], [probesQ.data]);

  const model: BoardModel = useMemo(
    () => buildBoardModel({ rooms, claims, probes }),
    [rooms, claims, probes],
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, z: 1 });
  const [positions, setPositions] = useState<Positions>({});
  const [search, setSearch] = useState("");
  const [tool, setTool] = useState<"pointer" | "note">("pointer");
  const [composerOpen, setComposerOpen] = useState(false);
  const didFit = useRef(false);

  // Keep local note positions seeded from the deterministic model, preserving
  // any in-session drags for notes that still exist.
  useEffect(() => {
    setPositions((prev) => {
      const next: Positions = {};
      for (const note of model.notes) next[note.id] = prev[note.id] ?? { x: note.x, y: note.y };
      return next;
    });
  }, [model.notes]);

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

  const fit = useCallback(() => {
    const { w: bw, h: bh } = model.bounds;
    if (!bw || !bh) return;
    const pad = 48;
    const z = clamp(Math.min((size.w - pad * 2) / bw, (size.h - pad * 2) / bh), MIN_ZOOM, MAX_ZOOM);
    setViewport({ z, x: (size.w - bw * z) / 2, y: (size.h - bh * z) / 2 });
  }, [model.bounds, size.w, size.h]);

  // One-time fit once geometry and size are known.
  useEffect(() => {
    if (didFit.current) return;
    if (model.notes.length && size.w > 1) {
      fit();
      didFit.current = true;
    }
  }, [model.notes.length, size.w, fit]);

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

  // Unified pointer drag: pan the board, or move a single note.
  const drag = useRef<
    | { type: "pan"; sx: number; sy: number; ox: number; oy: number }
    | { type: "note"; id: string; sx: number; sy: number; ox: number; oy: number }
    | null
  >(null);

  const beginPan = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (tool === "note") {
        setComposerOpen(true);
        return;
      }
      drag.current = { type: "pan", sx: e.clientX, sy: e.clientY, ox: viewport.x, oy: viewport.y };
      containerRef.current?.setPointerCapture(e.pointerId);
    },
    [tool, viewport.x, viewport.y],
  );

  const beginNoteDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, id: string) => {
      e.stopPropagation();
      const pos = positions[id];
      if (!pos) return;
      drag.current = { type: "note", id, sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
      containerRef.current?.setPointerCapture(e.pointerId);
    },
    [positions],
  );

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.type === "pan") {
      setViewport((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
    } else {
      setViewport((v) => {
        setPositions((prev) => ({ ...prev, [d.id]: { x: d.ox + dx / v.z, y: d.oy + dy / v.z } }));
        return v;
      });
    }
  }, []);

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (containerRef.current?.hasPointerCapture(e.pointerId)) {
      containerRef.current.releasePointerCapture(e.pointerId);
    }
  }, []);

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
  const loading = claimsQ.isLoading || roomsQ.isLoading;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest">
      <TopStrip
        boardTitle={activeRoomTitle}
        search={search}
        onSearch={setSearch}
        count={model.notes.length}
      />

      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          className="syn-dot-grid absolute inset-0 overflow-hidden"
          style={{
            cursor: tool === "note" ? "copy" : drag.current?.type === "pan" ? "grabbing" : "grab",
            touchAction: "none",
          }}
          onWheel={onWheel}
          onPointerDown={beginPan}
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
          ) : model.notes.length === 0 ? (
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
              <BoardSvg model={model} positions={positions} />
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
                    onPointerDown={(e) => beginNoteDrag(e, note.id)}
                  />
                );
              })}
            </div>
          )}

          <RightRail />
          <BottomToolbar
            tool={tool}
            onTool={setTool}
            onAddNote={() => {
              setTool("note");
              setComposerOpen(true);
            }}
            onFullscreen={() => containerRef.current?.requestFullscreen?.()}
          />
          <ZoomControls
            zoom={viewport.z}
            onZoomIn={() => zoomAt(size.w / 2, size.h / 2, viewport.z + 0.15)}
            onZoomOut={() => zoomAt(size.w / 2, size.h / 2, viewport.z - 0.15)}
            onFit={fit}
          />
          <Minimap model={model} positions={positions} viewport={viewport} size={size} />
        </div>

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

function TopStrip({
  boardTitle,
  search,
  onSearch,
  count,
}: {
  boardTitle: string;
  search: string;
  onSearch: (value: string) => void;
  count: number;
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

/* ─── SVG frames + connectors ───────────────────────────────────────────── */

function BoardSvg({ model, positions }: { model: BoardModel; positions: Positions }) {
  const center = (id: string) => {
    const p = positions[id];
    if (!p) return null;
    return { x: p.x + NOTE_W / 2, y: p.y + NOTE_H / 2 };
  };
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
    </svg>
  );
}

/* ─── Sticky note ───────────────────────────────────────────────────────── */

function StickyNoteView({
  kind,
  body,
  x,
  y,
  dim,
  onPointerDown,
}: {
  kind: StickyKind;
  body: string;
  x: number;
  y: number;
  dim: boolean;
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
      className="absolute flex cursor-grab select-none flex-col rounded-xl border p-3 shadow-[0_6px_16px_rgba(15,23,42,0.12)] transition-shadow active:cursor-grabbing"
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

function RailButton({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
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

function RightRail() {
  return (
    <div className="absolute right-3 top-1/2 flex -translate-y-1/2 flex-col gap-1 rounded-xl border border-outline-variant bg-surface-container-lowest p-1 shadow-md">
      <RailButton icon={Pencil} label="Pen / eraser" />
      <RailButton icon={Lock} label="Lock board" />
      <RailButton icon={History} label="History" />
    </div>
  );
}

function BottomToolbar({
  tool,
  onTool,
  onAddNote,
  onFullscreen,
}: {
  tool: "pointer" | "note";
  onTool: (t: "pointer" | "note") => void;
  onAddNote: () => void;
  onFullscreen: () => void;
}) {
  return (
    <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-outline-variant bg-surface-container-lowest p-1.5 shadow-lg">
      <button
        type="button"
        title="Select / pan"
        aria-label="Select / pan"
        onClick={() => onTool("pointer")}
        className={`grid h-9 w-9 place-items-center rounded-lg ${
          tool === "pointer" ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-surface-container-high"
        }`}
      >
        <MousePointer2 size={17} />
      </button>
      <button
        type="button"
        title="Add sticky note"
        aria-label="Add sticky note"
        onClick={onAddNote}
        className={`grid h-9 w-9 place-items-center rounded-lg ${
          tool === "note" ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-surface-container-high"
        }`}
      >
        <StickyNote size={17} />
      </button>
      <span className="mx-1 h-6 w-px bg-outline-variant" aria-hidden />
      <RailButton icon={Type} label="Text" />
      <RailButton icon={ImageIcon} label="Image" />
      <RailButton icon={Shapes} label="Shapes" />
      <RailButton icon={Table} label="Table" />
      <RailButton icon={Upload} label="Upload" />
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
  viewport: Viewport;
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
