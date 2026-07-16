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

type PendingEvent = {
  eventType: string;
  objectIds: string[];
  payload: Record<string, unknown>;
  coalesceKey?: string;
};

export function useBoardProducer(boardId: string): BoardProducer {
  const pendingMove = useRef<Map<string, { x: number; y: number }>>(new Map());
  const pendingEdit = useRef<Map<string, Record<string, unknown>>>(new Map());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const queue = useRef<PendingEvent[]>([]);
  const flushing = useRef(false);
  const storageKey = `singularity:studio-board-events:${boardId}`;

  const persist = useCallback(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(storageKey, JSON.stringify(queue.current)); } catch { /* quota errors leave the in-memory queue active */ }
  }, [storageKey]);

  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      while (queue.current.length) {
        const event = queue.current[0];
        try {
          await workgraphFetch(`/studio/boards/${boardId}/events`, {
            method: "POST",
            body: JSON.stringify(event),
          });
          queue.current.shift();
          persist();
        } catch {
          // Keep the event in the durable browser outbox. A later interval or
          // a reconnect retries it; the live CRDT is never the only copy.
          break;
        }
      }
    } finally {
      flushing.current = false;
    }
  }, [boardId, persist]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(storageKey);
        const parsed = raw ? JSON.parse(raw) as unknown : [];
        if (Array.isArray(parsed)) queue.current = parsed.filter((item): item is PendingEvent => Boolean(item && typeof item === "object" && typeof (item as PendingEvent).eventType === "string"));
      } catch { queue.current = []; }
    }
    void flush();
    const timer = window.setInterval(() => { void flush(); }, 2500);
    return () => window.clearInterval(timer);
  }, [flush, storageKey]);

  const post = useCallback((eventType: string, objectIds: string[], payload: Record<string, unknown>, coalesceKey?: string) => {
    queue.current.push({ eventType, objectIds, payload, ...(coalesceKey ? { coalesceKey } : {}) });
    persist();
    void flush();
  }, [flush, persist]);

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
        post("OBJECT_CREATED", [m.obj.id], { object: m.obj }, `create:${m.obj.id}`);
        break;
      case "delete":
        pendingMove.current.delete(m.id);
        pendingEdit.current.delete(m.id);
        post("OBJECT_DELETED", [m.id], {}, `delete:${m.id}`);
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
