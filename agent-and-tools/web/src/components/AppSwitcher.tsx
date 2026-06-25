"use client";

import { useMemo, useState } from "react";
import type { FocusEvent } from "react";
import { usePathname } from "next/navigation";
import { ExternalLink, Grid3X3 } from "lucide-react";
import { controlPlaneApps } from "@/lib/controlPlaneApps";

function inferCurrentApp(pathname: string | null | undefined): string {
  if (!pathname) return "agent-studio";
  if (pathname.startsWith("/control-plane")) return "control-plane";
  if (pathname.startsWith("/workflows")) return "workflows";
  if (pathname.startsWith("/runs")) return "runs";
  if (pathname.startsWith("/work-items")) return "work-items";
  if (pathname.startsWith("/workbench")) return "workbench";
  if (pathname.startsWith("/identity")) return "identity";
  if (pathname.startsWith("/operations")) return "operations";
  return "agent-studio";
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
        title="Switch Singularity app"
        style={{
          height: 32,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          borderRadius: 10,
          border: "1px solid var(--color-outline-variant)",
          background: open ? "var(--color-surface-container)" : "transparent",
          color: "var(--color-on-surface)",
          cursor: "pointer",
          padding: "0 10px",
          fontSize: 12,
          fontWeight: 700,
          transition: "all 0.15s",
        }}
      >
        <Grid3X3 size={14} style={{ color: "var(--color-primary)" }} />
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
            Singularity Apps
          </div>
          {links.map(item => {
            const Icon = item.icon;
            const active = item.id === resolvedCurrentApp;
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
                  background: active ? "var(--color-primary-dim)" : "transparent",
                  textDecoration: "none",
                }}
              >
                <span style={{
                  width: 32,
                  height: 32,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: 9,
                  background: active ? "var(--color-primary)" : "var(--color-surface-container)",
                  color: active ? "#fff" : "var(--color-primary)",
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
                <ExternalLink size={13} style={{ color: "var(--color-outline)" }} />
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
