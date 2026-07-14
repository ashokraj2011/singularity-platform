"use client";

import type { CSSProperties } from "react";
import type { Present } from "./usePresence";

/**
 * The live-presence face pile: who's in the project right now and (on hover) which surface they're
 * on. Fed by usePresence. Renders nothing when no one is present.
 */
const PALETTE = ["#7c6cff", "#ef8f5b", "#3ecf8e", "#f2688a", "#38bdf8", "#d8a24a"];

function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function initials(p: Present): string {
  const s = (p.displayName || p.userId || "?").trim();
  const parts = s.split(/[\s@._-]+/).filter(Boolean);
  const ini = parts.length >= 2 ? parts[0][0] + parts[1][0] : s.slice(0, 2);
  return ini.toUpperCase();
}
function surfaceLabel(surface?: string): string {
  return surface ? surface.charAt(0).toUpperCase() + surface.slice(1) : "here";
}

const avatar: CSSProperties = {
  width: 26, height: 26, borderRadius: "50%", color: "#fff",
  display: "grid", placeItems: "center", fontSize: 10, fontWeight: 800,
  boxShadow: "0 0 0 2px var(--color-card)",
};

export function PresenceBar({ present }: { present: Present[] }) {
  if (!present.length) return null;
  const shown = present.slice(0, 6);
  const extra = present.length - shown.length;
  const tip = present.map((p) => `${p.displayName || p.userId} · ${surfaceLabel(p.surface)}`).join("\n");

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }} title={tip}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#38d2f0", boxShadow: "0 0 0 3px rgba(56,210,240,0.18)" }} />
      <div style={{ display: "flex" }}>
        {shown.map((p, i) => (
          <span key={p.userId} style={{ ...avatar, background: colorFor(p.userId), marginLeft: i ? -7 : 0 }}>{initials(p)}</span>
        ))}
        {extra > 0 && <span style={{ ...avatar, marginLeft: -7, background: "var(--color-surface-low)", color: "var(--color-on-surface-variant)" }}>+{extra}</span>}
      </div>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--color-on-surface-variant)" }}>{present.length} here</span>
    </div>
  );
}
