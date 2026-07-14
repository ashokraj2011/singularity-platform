"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { studioTokens } from "./studioTheme";

/**
 * The ELM Studio shell — a dark, immersive island (its own environment inside the light platform,
 * the same register as the Work Item IDE). Applies the studio token overrides so everything inside
 * inherits the dark palette, and renders the branded top bar. Each /studio page renders its content
 * (and optional per-page header controls) inside.
 */
export function StudioShell({ crumb, actions, children }: { crumb?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div style={shell}>
      <header style={topbar}>
        <Link href="/studio" style={brand}>
          <span style={glyph}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round">
              <path d="M4 5h16M4 12h10M4 19h16" />
              <circle cx="18" cy="12" r="2.2" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <span style={{ display: "grid", lineHeight: 1.05 }}>
            <b style={{ fontSize: 14.5, fontWeight: 800, letterSpacing: "-0.02em" }}>ELM Studio</b>
            <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: "0.08em", color: "var(--studio-muted)" }}>SPEC · DESIGN · RECONCILE</span>
          </span>
        </Link>
        {crumb && <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, color: "var(--studio-ink-dim)", fontSize: 13 }}>{crumb}</div>}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>{actions}</div>
      </header>
      <div style={body}>{children}</div>
    </div>
  );
}

const shell: CSSProperties = {
  ...(studioTokens() as CSSProperties),
  background: "var(--studio-bg)",
  color: "var(--studio-ink)",
  overflow: "hidden",
  // /studio is a full-bleed route: the AppShell hands us the whole viewport (100vh, no sidebar),
  // so the studio IS the screen — fill it edge to edge rather than floating as an island.
  height: "100vh",
  display: "flex",
  flexDirection: "column",
  fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
};
const topbar: CSSProperties = {
  height: 54,
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: 16,
  padding: "0 18px",
  background: "var(--studio-chrome)",
  borderBottom: "1px solid var(--studio-line)",
};
const brand: CSSProperties = { display: "flex", alignItems: "center", gap: 11, textDecoration: "none", color: "var(--studio-ink)", flex: "none" };
const glyph: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 9,
  display: "grid",
  placeItems: "center",
  background: "linear-gradient(150deg, var(--studio-accent), #5b3ff0)",
  color: "#fff",
};
const body: CSSProperties = { flex: 1, overflowY: "auto", padding: "22px 24px 44px", minHeight: 0 };
