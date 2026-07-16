"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { workgraphFetch } from "@/lib/workgraph";
import { BoardCanvas } from "./BoardCanvas";

/**
 * A project's freeform boards: pick or create a board, then drop and drag objects on a
 * live collaborative canvas whose every move is recorded in the semantic event log
 * (time travel, moments, branches, verdicts all read from that log). The demand-side
 * companion to the epistemic Rooms.
 */
interface BoardItem { id: string; name: string }

export function ProjectBoardSurface({ projectId }: { projectId: string }) {
  const [boards, setBoards] = useState<BoardItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await workgraphFetch<{ items: BoardItem[] }>(`/studio/projects/${projectId}/boards`);
      setBoards(res.items ?? []);
      setSelected((cur) => cur ?? res.items?.[0]?.id ?? null);
    } catch { /* ignore */ }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const create = useCallback(async () => {
    setBusy(true);
    try {
      const b = await workgraphFetch<BoardItem>(`/studio/projects/${projectId}/boards`, {
        method: "POST", body: JSON.stringify({ name: name.trim() || "Untitled board" }),
      });
      setName("");
      await load();
      setSelected(b.id);
    } catch { /* ignore */ } finally { setBusy(false); }
  }, [name, projectId, load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <b style={{ fontSize: 13 }}>Boards</b>
        {boards.map((b) => (
          <button key={b.id} onClick={() => setSelected(b.id)} style={chip(selected === b.id)}>{b.name}</button>
        ))}
        <input
          value={name} onChange={(e) => setName(e.target.value)} placeholder="New board name"
          onKeyDown={(e) => { if (e.key === "Enter") void create(); }} style={inputStyle}
        />
        <button onClick={() => void create()} disabled={busy} style={chip(false)}>{busy ? "Creating…" : "+ New board"}</button>
      </div>

      {selected ? (
        <BoardCanvas projectId={projectId} boardId={selected} />
      ) : (
        <div className="card" style={{ padding: 24, fontSize: 12.5, color: "var(--color-outline)" }}>
          No board yet — create one to start dropping stickies. They sync live across everyone here, and every change lands in the board&apos;s event log for time travel, moments, and branches.
        </div>
      )}
    </div>
  );
}

function chip(active: boolean): CSSProperties {
  return {
    fontSize: 12, fontWeight: 600, padding: "5px 11px", borderRadius: 999, cursor: "pointer",
    border: `1px solid ${active ? "var(--color-primary, #6366f1)" : "var(--color-outline-variant)"}`,
    background: active ? "var(--color-primary, #6366f1)" : "var(--color-surface)",
    color: active ? "#fff" : "var(--color-on-surface)",
  };
}
const inputStyle: CSSProperties = {
  fontSize: 12, padding: "5px 10px", borderRadius: 8, border: "1px solid var(--color-outline-variant)",
  background: "var(--color-surface)", color: "var(--color-on-surface)", minWidth: 160,
};
