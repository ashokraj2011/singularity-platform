"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { workgraphFetch } from "@/lib/workgraph";
import { usePresence } from "./usePresence";
import { PresenceBar } from "./PresenceBar";
import { useBoardDoc, type BoardObj } from "./useBoardDoc";
import { useBoardProducer } from "./useBoardProducer";

/**
 * The freeform board canvas. Objects live in a shared Yjs Map (live collaboration); every
 * local create/move/edit/delete is coalesced by the producer into the semantic event log.
 * A scrubber reads real snapshots from the backend — the past is read-only ("fork to edit"),
 * enforced server-side, so this is honest time travel, not a replay animation.
 */
const COLORS = ["#fde68a", "#bae6fd", "#bbf7d0", "#fecdd3", "#ddd6fe"];

export function BoardCanvas({ projectId, boardId }: { projectId: string; boardId: string }) {
  const producer = useBoardProducer(boardId);
  const { ready, objects, createObject, moveObject, editObject, deleteObject } = useBoardDoc(projectId, boardId, producer.emit);
  const present = usePresence(projectId, `board:${boardId}`);

  const [head, setHead] = useState(0);
  const [atSeq, setAtSeq] = useState<number | null>(null); // null = live head
  const [pastObjects, setPastObjects] = useState<BoardObj[]>([]);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const isPast = atSeq !== null && atSeq < head;

  // Keep the head cursor fresh (also the scrubber's max).
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const s = await workgraphFetch<{ headEventSeq: number }>(`/studio/boards/${boardId}/state`);
        if (active && typeof s.headEventSeq === "number") setHead(s.headEventSeq);
      } catch { /* ignore */ }
      if (active) setTimeout(poll, 3000);
    };
    poll();
    return () => { active = false; };
  }, [boardId]);

  // When scrubbed into the past, materialize that state from the backend (read-only).
  useEffect(() => {
    if (atSeq === null) return;
    let active = true;
    workgraphFetch<{ objects: BoardObj[] }>(`/studio/boards/${boardId}/state?at=${atSeq}`)
      .then((s) => { if (active) setPastObjects(s.objects ?? []); })
      .catch(() => { /* ignore */ });
    return () => { active = false; };
  }, [boardId, atSeq]);

  const shown = isPast ? pastObjects : objects;

  const addSticky = useCallback(() => {
    if (isPast) return;
    const id = crypto.randomUUID();
    createObject({ id, type: "sticky", x: 40 + Math.round(Math.random() * 240), y: 40 + Math.round(Math.random() * 160), text: "", color: COLORS[Math.floor(Math.random() * COLORS.length)]! });
  }, [createObject, isPast]);

  const onPointerDownCard = (e: ReactPointerEvent, o: BoardObj) => {
    if (isPast) return;
    const rect = surfaceRef.current?.getBoundingClientRect();
    drag.current = { id: o.id, dx: e.clientX - (rect?.left ?? 0) - o.x, dy: e.clientY - (rect?.top ?? 0) - o.y };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag.current || isPast) return;
    const rect = surfaceRef.current?.getBoundingClientRect();
    const x = Math.max(0, Math.round(e.clientX - (rect?.left ?? 0) - drag.current.dx));
    const y = Math.max(0, Math.round(e.clientY - (rect?.top ?? 0) - drag.current.dy));
    moveObject(drag.current.id, { x, y });
  };
  const onPointerUp = () => { drag.current = null; };

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--color-outline-variant)" }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: ready ? "#38d2f0" : "var(--color-outline)" }} />
        <b style={{ fontSize: 13 }}>Board</b>
        <span style={{ fontSize: 11, color: "var(--color-outline)" }}>{ready ? "live" : "connecting…"} · {shown.length} objects</span>
        <button onClick={addSticky} disabled={isPast} style={btn(isPast)}>+ Sticky</button>
        <div style={{ marginLeft: "auto" }}><PresenceBar present={present} /></div>
      </div>

      {isPast && (
        <div style={{ padding: "6px 14px", fontSize: 11.5, background: "rgba(245,196,81,0.12)", color: "#92400e", borderBottom: "1px solid var(--color-outline-variant)" }}>
          Read-only past (event {atSeq} of {head}) — the past can't be edited. Fork from here to explore an alternative.
        </div>
      )}

      <div
        ref={surfaceRef}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={addSticky}
        style={{ position: "relative", height: 460, background: "var(--color-surface-container-low, #f6f7f9)", overflow: "hidden", cursor: isPast ? "default" : "crosshair" }}
      >
        {shown.map((o) => (
          <div
            key={o.id}
            onPointerDown={(e) => onPointerDownCard(e, o)}
            style={stickyStyle(o, isPast)}
          >
            {!isPast && (
              <button onClick={() => deleteObject(o.id)} title="Delete" style={delBtn}>×</button>
            )}
            <textarea
              defaultValue={o.text ?? ""}
              readOnly={isPast}
              onBlur={(e) => { if (!isPast && e.target.value !== (o.text ?? "")) editObject(o.id, { text: e.target.value }); }}
              onPointerDown={(e) => e.stopPropagation()}
              placeholder="…"
              style={stickyText}
            />
          </div>
        ))}
        {shown.length === 0 && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 12.5, color: "var(--color-outline)" }}>
            Double-click to drop a sticky. Everyone here sees it live.
          </div>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderTop: "1px solid var(--color-outline-variant)" }}>
        <span style={{ fontSize: 11, color: "var(--color-outline)", minWidth: 70 }}>Time travel</span>
        <input
          type="range" min={0} max={head} value={atSeq ?? head}
          onChange={(e) => { const v = Number(e.target.value); setAtSeq(v >= head ? null : v); }}
          style={{ flex: 1 }} disabled={head === 0}
        />
        <span style={{ fontSize: 11, color: "var(--color-outline)", minWidth: 96, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {isPast ? `${atSeq} / ${head}` : `live · ${head}`}
        </span>
        {isPast && <button onClick={() => setAtSeq(null)} style={btn(false)}>Back to live</button>}
      </div>
    </div>
  );
}

function stickyStyle(o: BoardObj, isPast: boolean): CSSProperties {
  return {
    position: "absolute", left: o.x, top: o.y, width: 150, minHeight: 92, padding: 8,
    background: typeof o.color === "string" ? o.color : "#fde68a", borderRadius: 8,
    boxShadow: "0 2px 6px rgba(15,23,42,0.15)", cursor: isPast ? "default" : "grab",
    opacity: isPast ? 0.9 : 1, touchAction: "none",
  };
}
const stickyText: CSSProperties = { width: "100%", height: 72, border: "none", background: "transparent", resize: "none", outline: "none", fontSize: 12.5, lineHeight: 1.4, color: "#1f2937" };
const delBtn: CSSProperties = { position: "absolute", top: 2, right: 4, border: "none", background: "transparent", cursor: "pointer", fontSize: 15, lineHeight: 1, color: "rgba(15,23,42,0.45)" };
function btn(disabled: boolean): CSSProperties {
  return { fontSize: 11.5, fontWeight: 600, padding: "4px 10px", borderRadius: 6, border: "1px solid var(--color-outline-variant)", background: "var(--color-surface)", color: "var(--color-on-surface)", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 };
}
