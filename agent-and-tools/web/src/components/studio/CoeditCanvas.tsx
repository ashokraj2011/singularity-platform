"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { useCoedit } from "./useCoedit";
import { usePresence } from "./usePresence";
import { PresenceBar } from "./PresenceBar";
import { diffToOps, remapCaret } from "./coeditDiff";
import { muted } from "./ProjectAnalysisSurface";

/**
 * The live co-edit surface: a plain textarea bound to a shared Yjs CRDT document (via useCoedit).
 * Everyone in the project edits the same text; concurrent edits merge without loss. Uncontrolled
 * textarea so remote merges can update the DOM and remap the local caret without React fighting it.
 */
export function CoeditCanvas({
  projectId,
  docKey = "canvas",
  surface = "coedit",
  title = "Shared canvas",
  placeholder,
}: {
  projectId: string;
  docKey?: string;
  surface?: string;
  title?: string;
  placeholder?: string;
}) {
  const { ready, getValue, applyLocal, onRemote } = useCoedit(projectId, docKey);
  const present = usePresence(projectId, surface);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!ready) return;
    const el = taRef.current;
    if (el && el.value !== getValue()) el.value = getValue();
    const off = onRemote((value, delta) => {
      const node = taRef.current;
      if (!node) return;
      const s = remapCaret(delta, node.selectionStart);
      const e = remapCaret(delta, node.selectionEnd);
      node.value = value;
      try { node.setSelectionRange(s, e); } catch { /* detached */ }
    });
    return off;
  }, [ready, getValue, onRemote]);

  function onInput() {
    const el = taRef.current;
    if (!el) return;
    const op = diffToOps(getValue(), el.value);
    if (op) applyLocal(op);
  }

  return (
    <div style={{ maxWidth: 860 }}>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderBottom: "1px solid var(--color-outline-variant)" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: ready ? "#38d2f0" : "var(--color-outline)", boxShadow: ready ? "0 0 0 3px rgba(56,210,240,0.18)" : "none" }} />
          <b style={{ fontSize: 13 }}>{title}</b>
          <span style={{ fontSize: 11, ...muted }}>{ready ? "live" : "connecting…"}</span>
          <div style={{ marginLeft: "auto" }}><PresenceBar present={present} /></div>
        </div>
        <textarea
          ref={taRef}
          onInput={onInput}
          readOnly={!ready}
          placeholder={placeholder ?? "Draft together — edits merge live across everyone here."}
          spellCheck={false}
          style={editorStyle}
        />
      </div>
      <p style={{ fontSize: 11.5, ...muted, marginTop: 8 }}>
        Live co-edit — a Yjs CRDT synced over an authenticated relay (not a WebSocket). Everyone here edits the same text; concurrent changes merge without conflicts.
      </p>
    </div>
  );
}

const editorStyle: CSSProperties = {
  width: "100%",
  minHeight: 280,
  border: "none",
  outline: "none",
  resize: "vertical",
  padding: "14px 16px",
  fontSize: 14,
  lineHeight: 1.65,
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  background: "transparent",
  color: "var(--color-on-surface)",
};
