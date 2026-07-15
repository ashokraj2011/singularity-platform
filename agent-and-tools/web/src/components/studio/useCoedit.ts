"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { workgraphFetch } from "@/lib/workgraph";

/**
 * Live co-edit over a Yjs CRDT, synced through an authenticated HTTP relay (the /api/studio/.../coedit
 * endpoint) rather than a WebSocket — same-origin, authed, and proxy-friendly. The CRDT is the real
 * thing: concurrent edits merge without loss. Each poll sends our pending local updates and applies
 * the ones we haven't seen. Transport is isolated here, so a WebSocket provider could replace it.
 */
type RemoteDelta = Array<{ retain?: number; insert?: string | object; delete?: number }>;
type RemoteListener = (value: string, delta: RemoteDelta) => void;

export interface CoeditHandle {
  ready: boolean;
  getValue: () => string;
  applyLocal: (op: { index: number; delete: number; insert: string }) => void;
  onRemote: (cb: RemoteListener) => () => void;
}

const POLL_MS = 1200;
const REMOTE = "remote";

function toB64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
function fromB64(b: string): Uint8Array {
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

export function useCoedit(projectId: string, docKey: string): CoeditHandle {
  const [ready, setReady] = useState(false);
  const docRef = useRef<Y.Doc | null>(null);
  const ytextRef = useRef<Y.Text | null>(null);
  const pendingRef = useRef<string[]>([]);
  const sinceRef = useRef(0);
  const listenersRef = useRef<Set<RemoteListener>>(new Set());

  useEffect(() => {
    const doc = new Y.Doc();
    const ytext = doc.getText("t");
    docRef.current = doc;
    ytextRef.current = ytext;
    pendingRef.current = [];
    sinceRef.current = 0;
    setReady(false);

    // Relay only genuinely-local updates (remote applies carry origin === REMOTE).
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE) pendingRef.current.push(toB64(update));
    };
    doc.on("update", onUpdate);

    // Notify subscribers of remote-origin changes so the DOM + caret can follow.
    const onObserve = (event: Y.YTextEvent, tr: Y.Transaction) => {
      if (tr.origin === REMOTE) {
        const value = ytext.toString();
        listenersRef.current.forEach((cb) => cb(value, event.delta as RemoteDelta));
      }
    };
    ytext.observe(onObserve);

    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function sync() {
      const sending = pendingRef.current;
      pendingRef.current = [];
      try {
        const res = await workgraphFetch<{ updates: { seq: number; update: string }[]; head: number }>(
          `/studio/projects/${projectId}/coedit`,
          { method: "POST", body: JSON.stringify({ docKey, updates: sending, sinceSeq: sinceRef.current }) },
        );
        if (!active) return;
        for (const e of res.updates ?? []) Y.applyUpdate(doc, fromB64(e.update), REMOTE);
        if (typeof res.head === "number") sinceRef.current = res.head;
        setReady(true);
      } catch {
        // best-effort: requeue unsent updates so a blip doesn't lose edits
        pendingRef.current = [...sending, ...pendingRef.current];
      }
      if (active) timer = setTimeout(sync, POLL_MS);
    }
    sync();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      ytext.unobserve(onObserve);
      doc.off("update", onUpdate);
      doc.destroy();
      docRef.current = null;
      ytextRef.current = null;
    };
  }, [projectId, docKey]);

  const getValue = useCallback(() => ytextRef.current?.toString() ?? "", []);
  const applyLocal = useCallback((op: { index: number; delete: number; insert: string }) => {
    const yt = ytextRef.current;
    const doc = docRef.current;
    if (!yt || !doc) return;
    doc.transact(() => {
      if (op.delete) yt.delete(op.index, op.delete);
      if (op.insert) yt.insert(op.index, op.insert);
    }, "local");
  }, []);
  const onRemote = useCallback((cb: RemoteListener) => {
    listenersRef.current.add(cb);
    return () => { listenersRef.current.delete(cb); };
  }, []);

  return { ready, getValue, applyLocal, onRemote };
}
