"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { workgraphFetch } from "@/lib/workgraph";

/**
 * The live board-object CRDT: a shared Y.Map of freeform objects synced over the same
 * authenticated HTTP relay as the text co-edit (docKey = `board:<id>`). The CRDT is the
 * live wire — concurrent create/move/edit/delete merge without loss. Every LOCAL mutation
 * is also handed to `onLocal` so the producer can coalesce it into the semantic event log
 * (the board's durable record). CRDT for real-time, event log for time travel; they
 * reconcile at snapshot time server-side.
 */
export interface BoardObj {
  id: string;
  type: string; // sticky | card | ...
  x: number;
  y: number;
  text?: string;
  color?: string;
  [k: string]: unknown;
}
export type LocalMutation =
  | { kind: "create"; obj: BoardObj }
  | { kind: "move"; id: string; to: { x: number; y: number } }
  | { kind: "edit"; id: string; patch: Record<string, unknown> }
  | { kind: "delete"; id: string };

export interface BoardDocHandle {
  ready: boolean;
  objects: BoardObj[];
  createObject: (obj: BoardObj) => void;
  moveObject: (id: string, to: { x: number; y: number }) => void;
  editObject: (id: string, patch: Record<string, unknown>) => void;
  deleteObject: (id: string) => void;
}

const POLL_MS = 1200;
const REMOTE = "remote";

function toB64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  return btoa(s);
}
function fromB64(b: string): Uint8Array {
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

export function useBoardDoc(projectId: string, boardId: string, onLocal: (m: LocalMutation) => void): BoardDocHandle {
  const [ready, setReady] = useState(false);
  const [objects, setObjects] = useState<BoardObj[]>([]);
  const docRef = useRef<Y.Doc | null>(null);
  const mapRef = useRef<Y.Map<BoardObj> | null>(null);
  const pendingRef = useRef<string[]>([]);
  const sinceRef = useRef(0);
  const onLocalRef = useRef(onLocal);
  onLocalRef.current = onLocal;

  useEffect(() => {
    const doc = new Y.Doc();
    const map = doc.getMap<BoardObj>("objects");
    docRef.current = doc;
    mapRef.current = map;
    pendingRef.current = [];
    sinceRef.current = 0;
    setReady(false);

    const snapshot = () => setObjects(Array.from(map.values()));
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE) pendingRef.current.push(toB64(update));
    };
    const onMap = () => snapshot();
    doc.on("update", onUpdate);
    map.observe(onMap);
    snapshot();

    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function hydrateDurableState() {
      try {
        const durable = await workgraphFetch<{ objects?: BoardObj[] }>(`/studio/boards/${boardId}/state?branch=main`);
        if (!active || !Array.isArray(durable.objects)) return;
        doc.transact(() => {
          for (const obj of durable.objects ?? []) map.set(obj.id, obj);
        }, REMOTE);
      } catch {
        // Co-edit can still connect when the durable board endpoint is temporarily
        // unavailable; the next reload will reconcile from the event log.
      }
    }
    async function sync() {
      const sending = pendingRef.current;
      pendingRef.current = [];
      try {
        const res = await workgraphFetch<{ updates: { seq: number; update: string }[]; head: number }>(
          `/studio/projects/${projectId}/coedit`,
          { method: "POST", body: JSON.stringify({ docKey: `board:${boardId}`, updates: sending, sinceSeq: sinceRef.current }) },
        );
        if (!active) return;
        for (const e of res.updates ?? []) Y.applyUpdate(doc, fromB64(e.update), REMOTE);
        if (typeof res.head === "number") sinceRef.current = res.head;
        setReady(true);
      } catch {
        pendingRef.current = [...sending, ...pendingRef.current];
      }
      if (active) timer = setTimeout(sync, POLL_MS);
    }
    void hydrateDurableState().finally(() => { if (active) void sync(); });

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      map.unobserve(onMap);
      doc.off("update", onUpdate);
      doc.destroy();
      docRef.current = null;
      mapRef.current = null;
    };
  }, [projectId, boardId]);

  const createObject = useCallback((obj: BoardObj) => {
    mapRef.current?.set(obj.id, obj);
    onLocalRef.current({ kind: "create", obj });
  }, []);
  const moveObject = useCallback((id: string, to: { x: number; y: number }) => {
    const cur = mapRef.current?.get(id);
    if (!cur) return;
    mapRef.current?.set(id, { ...cur, x: to.x, y: to.y });
    onLocalRef.current({ kind: "move", id, to });
  }, []);
  const editObject = useCallback((id: string, patch: Record<string, unknown>) => {
    const cur = mapRef.current?.get(id);
    if (!cur) return;
    mapRef.current?.set(id, { ...cur, ...patch });
    onLocalRef.current({ kind: "edit", id, patch });
  }, []);
  const deleteObject = useCallback((id: string) => {
    mapRef.current?.delete(id);
    onLocalRef.current({ kind: "delete", id });
  }, []);

  return { ready, objects, createObject, moveObject, editObject, deleteObject };
}
