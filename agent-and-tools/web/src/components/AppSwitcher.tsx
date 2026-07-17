"use client";

import { useMemo, useState } from "react";
import type { FocusEvent } from "react";
import { usePathname } from "next/navigation";
import { ChevronRight, ExternalLink, Grid3X3 } from "lucide-react";
import { controlPlaneApps } from "@/lib/controlPlaneApps";

function inferCurrentApp(pathname: string | null | undefined): string {
  if (!pathname || pathname === "/" || pathname.startsWith("/start") || pathname.startsWith("/help")) return "command-center";
  if (pathname.startsWith("/synthesis") || pathname.startsWith("/concept-studio") || pathname.startsWith("/studio") || pathname.startsWith("/learning")) return "synthesis";
  if (pathname.startsWith("/work-items") || pathname.startsWith("/workflows/planner") || pathname.startsWith("/workflows/routing-policies")) return "work-management";
  if (pathname.startsWith("/agents") || pathname.startsWith("/agent-") || pathname.startsWith("/capabilities") || pathname.startsWith("/tools") || pathname.startsWith("/prompt-") || pathname.startsWith("/behavior-") || pathname.startsWith("/instruction-") || pathname.startsWith("/memory") || pathname.startsWith("/executions")) return "agent-studio";
  if (pathname.startsWith("/workflows") || pathname.startsWith("/runs") || pathname.startsWith("/workbench") || pathname.startsWith("/engine") || pathname.startsWith("/audit")) return "workflows";
  if (pathname.startsWith("/identity") || pathname.startsWith("/tool-grants")) return "identity";
  if (pathname.startsWith("/operations") || pathname.startsWith("/llm-settings") || pathname.startsWith("/control-plane") || pathname.startsWith("/runtime-") || pathname.startsWith("/cost") || pathname.startsWith("/settings")) return "operations";
  return "command-center";
}

export function AppSwitcher({ currentApp }: { currentApp?: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const links = useMemo(
    () => controlPlaneApps(),
    [],
  );
  const resolvedCurrentApp = currentApp ?? inferCurrentApp(pathname);
  const current = links.find(item => item.id === resolvedCurrentApp) ?? links[0];

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }

  return (
    <div style={{ position: "relative" }} onBlur={onBlur}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Switch workspace"
        style={{
          height: 32,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          borderRadius: 10,
          border: "1px solid var(--color-outline-variant)",
          background: open ? "var(--color-surface-container)" : "var(--color-surface-low)",
          color: "var(--color-on-surface)",
          cursor: "pointer",
          padding: "0 10px",
          fontSize: 12,
          fontWeight: 700,
          transition: "all 0.15s",
        }}
      >
        <Grid3X3 size={14} style={{ color: "var(--accent-identity)" }} />
        <span>{current.label}</span>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            top: 40,
            width: 300,
            zIndex: 80,
            border: "1px solid var(--color-outline-variant)",
            borderRadius: 14,
            background: "#fff",
            boxShadow: "0 18px 44px rgba(12,23,39,0.18)",
            padding: 8,
          }}
        >
          <div style={{ padding: "8px 10px 10px", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--color-outline)" }}>
            Platform Workspaces
          </div>
          {links.map(item => {
            const Icon = item.icon;
            const active = item.id === resolvedCurrentApp;
            const accent = appAccent(item.id);
            // Internal entries stay in this unified Next app. External
            // URLs are still supported for remote/developer surfaces.
            const isExternalApp = item.nativeHref.startsWith("http");
            const linkProps = isExternalApp
              ? { href: item.nativeHref, target: "_blank", rel: "noreferrer" }
              : { href: item.href };
            return (
              <a
                key={item.id}
                {...linkProps}
                role="menuitem"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  borderRadius: 10,
                  padding: "10px",
                  color: "var(--color-on-surface)",
                  background: active ? accent.bg : "transparent",
                  textDecoration: "none",
                }}
              >
                <span style={{
                  width: 32,
                  height: 32,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: 9,
                  background: active ? accent.fg : "var(--color-surface-container)",
                  color: active ? "#fff" : accent.fg,
                  flexShrink: 0,
                }}>
                  <Icon size={16} />
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 800 }}>{item.label}</span>
                  <span style={{ display: "block", marginTop: 1, fontSize: 11, color: "var(--color-outline)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {item.summary}
                  </span>
                </span>
                {isExternalApp
                  ? <ExternalLink size={13} style={{ color: "var(--color-outline)" }} />
                  : <ChevronRight size={14} style={{ color: "var(--color-outline)" }} />}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

function appAccent(id: string): { fg: string; bg: string } {
  if (id === "agent-studio") return { fg: "var(--accent-agent)", bg: "var(--accent-agent-soft)" };
  if (id === "synthesis") return { fg: "var(--accent-evidence)", bg: "var(--accent-evidence-soft)" };
  if (id === "identity") return { fg: "var(--accent-identity)", bg: "var(--accent-identity-soft)" };
  if (id === "operations") return { fg: "var(--accent-runtime)", bg: "var(--accent-runtime-soft)" };
  return { fg: "var(--accent-workflow)", bg: "var(--accent-workflow-soft)" };
}
