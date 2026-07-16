"use client";

import { useCallback, useEffect, useState } from "react";
import { LayoutGrid, Loader2, Plus, RefreshCw } from "lucide-react";
import { BoardCanvas } from "@/components/studio/BoardCanvas";
import { workgraphFetch, WorkgraphError } from "@/lib/workgraph";

interface BoardItem {
  id: string;
  name: string;
}

export function IdeaBoardWorkspace({ projectId }: { projectId: string }) {
  const [boards, setBoards] = useState<BoardItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await workgraphFetch<{ items: BoardItem[] }>(`/studio/projects/${projectId}/boards`);
      const items = response.items ?? [];
      setBoards(items);
      setSelectedId(current => items.some(board => board.id === current) ? current : items[0]?.id ?? null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof WorkgraphError ? cause.message : "Could not load the idea boards.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setSelectedId(null);
    void load();
  }, [load]);

  const create = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const board = await workgraphFetch<BoardItem>(`/studio/projects/${projectId}/boards`, {
        method: "POST",
        body: JSON.stringify({ name: boards.length ? `Idea Board ${boards.length + 1}` : "Idea Board" }),
      });
      setBoards(current => [...current, board]);
      setSelectedId(board.id);
    } catch (cause) {
      setError(cause instanceof WorkgraphError ? cause.message : "Could not create the idea board.");
    } finally {
      setCreating(false);
    }
  }, [boards.length, creating, projectId]);

  if (loading) {
    return (
      <div className="grid h-full min-h-[520px] place-items-center rounded-lg border border-outline-variant bg-surface-container-lowest">
        <div className="flex items-center gap-2 text-sm text-on-surface-variant"><Loader2 size={17} className="animate-spin" /> Loading idea board</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex min-h-10 flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          <LayoutGrid size={16} className="shrink-0 text-on-surface-variant" />
          {boards.map(board => (
            <button
              key={board.id}
              type="button"
              onClick={() => setSelectedId(board.id)}
              className={[
                "h-9 shrink-0 rounded-md border px-3 text-xs font-semibold transition-colors",
                selectedId === board.id
                  ? "border-secondary bg-secondary-container text-on-secondary-container"
                  : "border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container-high",
              ].join(" ")}
            >
              {board.name}
            </button>
          ))}
        </div>
        <button type="button" className="btn-secondary h-9 shrink-0 text-xs" onClick={create} disabled={creating}>
          {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          New board
        </button>
      </div>

      {error ? (
        <div role="alert" className="flex items-center gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={load} className="inline-flex shrink-0 items-center gap-1.5 font-semibold"><RefreshCw size={13} /> Retry</button>
        </div>
      ) : null}

      {selectedId ? (
        <div className="min-h-0 flex-1">
          <BoardCanvas projectId={projectId} boardId={selectedId} mode="ideas" />
        </div>
      ) : (
        <div className="grid min-h-[520px] flex-1 place-items-center rounded-lg border border-dashed border-outline-variant bg-surface-container-lowest px-6 text-center">
          <div className="max-w-sm">
            <div className="mx-auto grid h-10 w-10 place-items-center rounded-md bg-secondary-container text-on-secondary-container"><LayoutGrid size={19} /></div>
            <h2 className="mt-4 font-display text-base font-semibold text-on-surface">Create your first idea board</h2>
            <p className="mt-2 text-sm leading-6 text-on-surface-variant">Capture rough thoughts spatially, connect evidence, then synthesize the board into source-linked themes and governed claims.</p>
            <button type="button" className="btn-primary mt-5 text-xs" onClick={create} disabled={creating}>
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create Idea Board
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
