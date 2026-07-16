"use client";

import { useCallback, useEffect, useRef } from "react";
import { workgraphFetch } from "@/lib/workgraph";
import type { LocalMutation } from "./useBoardDoc";

/**
 * The Yjs → semantic-event producer. One event per SEMANTIC action, not per pixel: a
 * drag becomes ONE OBJECT_MOVED (coalesced on 2s of pointer quiet), a text edit ONE
 * OBJECT_EDITED per 5s; create/delete emit immediately. The server coalesces again with
 * the same keys, so a lost timer never doubles the log. Best-effort — a failed post never
 * blocks the live CRDT (the log reconciles at snapshot time).
 */
const MOVE_WINDOW_MS = 2000;
const EDIT_WINDOW_MS = 5000;

export interface BoardProducer {
  emit: (m: LocalMutation) => void;
}

export function useBoardProducer(boardId: string): BoardProducer {
  const pendingMove = useRef<Map<string, { x: number; y: number }>>(new Map());
  const pendingEdit = useRef<Map<string, Record<string, unknown>>>(new Map());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const post = useCallback((eventType: string, objectIds: string[], payload: Record<string, unknown>, coalesceKey?: string) => {
    void workgraphFetch(`/studio/boards/${boardId}/events`, {
      method: "POST",
      body: JSON.stringify({ eventType, objectIds, payload, ...(coalesceKey ? { coalesceKey } : {}) }),
    }).catch(() => { /* best-effort: the CRDT is the live wire; the log reconciles at snapshot time */ });
  }, [boardId]);

  const flushMove = useCallback((id: string) => {
    const to = pendingMove.current.get(id);
    if (!to) return;
    pendingMove.current.delete(id);
    post("OBJECT_MOVED", [id], { to }, `move:${id}`);
  }, [post]);

  const flushEdit = useCallback((id: string) => {
    const patch = pendingEdit.current.get(id);
    if (!patch) return;
    pendingEdit.current.delete(id);
    post("OBJECT_EDITED", [id], { patch }, `edit:${id}`);
  }, [post]);

  const debounce = useCallback((key: string, delay: number, run: () => void) => {
    const prev = timers.current.get(key);
    if (prev) clearTimeout(prev);
    timers.current.set(key, setTimeout(() => { timers.current.delete(key); run(); }, delay));
  }, []);

  const emit = useCallback((m: LocalMutation) => {
    switch (m.kind) {
      case "create":
        post("OBJECT_CREATED", [m.obj.id], { object: m.obj });
        break;
      case "delete":
        pendingMove.current.delete(m.id);
        pendingEdit.current.delete(m.id);
        post("OBJECT_DELETED", [m.id], {});
        break;
      case "move":
        pendingMove.current.set(m.id, m.to);
        debounce(`move:${m.id}`, MOVE_WINDOW_MS, () => flushMove(m.id));
        break;
      case "edit":
        pendingEdit.current.set(m.id, { ...(pendingEdit.current.get(m.id) ?? {}), ...m.patch });
        debounce(`edit:${m.id}`, EDIT_WINDOW_MS, () => flushEdit(m.id));
        break;
    }
  }, [post, debounce, flushMove, flushEdit]);

  // Flush anything still pending on unmount so the last drag/edit isn't lost.
  useEffect(() => {
    const moves = pendingMove.current;
    const edits = pendingEdit.current;
    const ts = timers.current;
    return () => {
      ts.forEach((t) => clearTimeout(t));
      ts.clear();
      moves.forEach((to, id) => post("OBJECT_MOVED", [id], { to }, `move:${id}`));
      edits.forEach((patch, id) => post("OBJECT_EDITED", [id], { patch }, `edit:${id}`));
      moves.clear();
      edits.clear();
    };
  }, [post]);

  return { emit };
}
