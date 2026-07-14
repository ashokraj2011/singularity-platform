"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/ui/Sidebar";
import { EventHorizonChat } from "@/components/EventHorizonChat";
import { AppSwitcher } from "@/components/AppSwitcher";
import { LogoutButton } from "@/components/LogoutButton";
import { RequireSession } from "@/components/RequireSession";
import { useEffect, useState } from "react";
import { Play, RadioTower, Search, Settings } from "lucide-react";
import { CommandPalette } from "@/components/CommandPalette";
import { NotificationCenter } from "@/components/NotificationCenter";
import { apiPath, assertValidApiResponse, authHeaders, readResponseBody } from "@/lib/api";
import { StatusPill, type UiState } from "@/components/ui/primitives";
import { ThemeSwitcher } from "@/components/ui/ThemeSwitcher";

// Routes that render their own full-viewport UX (the Blueprint Workbench and
// the live RunGraph cockpit) must NOT be boxed inside the platform-web
// sidebar/topbar/padded-main chrome. Keep run artifacts/insights in the normal
// shell; only the detail cockpit needs its own viewport so its header and
// action controls cannot sit underneath the platform chrome.
const FULL_BLEED_PREFIXES = ["/workbench", "/studio"];

function isRunDetailPath(pathname: string): boolean {
  return /^\/runs\/[^/]+$/.test(pathname);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const fullBleed = FULL_BLEED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  ) || isRunDetailPath(pathname);

  // ⌘K / Ctrl-K toggles the command palette (sourced from the route registry).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [runtimeState, setRuntimeState] = useState<{ state: UiState; label: string }>({ state: "waiting", label: "Checking runtime" });
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadRuntimeState() {
      try {
        const res = await fetch(apiPath("/api/runtime-infrastructure"), { cache: "no-store", headers: authHeaders() });
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) {
          setRuntimeState({ state: "needs-auth", label: "Sign in required" });
          return;
        }
        if (!res.ok) {
          setRuntimeState({ state: "degraded", label: "Runtime check failed" });
          return;
        }
        const { raw, parsed, parseError } = await readResponseBody(res);
        assertValidApiResponse("/api/runtime-infrastructure", raw, parseError);
        const data = parsed && typeof parsed === "object"
          ? parsed as { summary?: { requiredHealthy?: boolean; optionalHealthy?: number; optionalConfigured?: number } }
          : {};
        const optionalHealthy = data.summary?.optionalHealthy ?? 0;
        const optionalConfigured = data.summary?.optionalConfigured ?? 0;
        if (data.summary?.requiredHealthy && optionalHealthy > 0) {
          setRuntimeState({ state: "ready", label: `${optionalHealthy} runtime online` });
        } else if (data.summary?.requiredHealthy) {
          setRuntimeState({ state: "needs-runtime", label: "Runtime not connected" });
        } else {
          setRuntimeState({ state: "degraded", label: optionalConfigured ? "Runtime degraded" : "Runtime setup needed" });
        }
      } catch {
        if (!cancelled) setRuntimeState({ state: "offline", label: "Runtime unknown" });
      }
    }
    void loadRuntimeState();
    const timer = window.setInterval(loadRuntimeState, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (fullBleed) {
    return (
      <RequireSession pathname={pathname}>
        <div style={{ height: "100vh", overflow: "hidden" }}>{children}</div>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </RequireSession>
    );
  }

  return (
    <RequireSession pathname={pathname}>
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>

      {/* Sidebar — sticky, participates in flex flow */}
      <Sidebar />

      {/* Right column */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

        {/* ── Topbar ── */}
        <header
          className="shell-topbar"
          style={{
            height: 52,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 20px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "4px 10px",
                borderRadius: 20,
                border: "1px solid var(--color-primary-hover-border)",
                background: "var(--color-primary-dim)",
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                color: "var(--color-primary)",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--color-primary)",
                  flexShrink: 0,
                }}
              />
              Unified Platform
            </span>
            <Link href="/llm-settings" style={{ textDecoration: "none" }}>
              <StatusPill state={runtimeState.state} label={runtimeState.label} icon={RadioTower} />
            </Link>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Link className="btn-primary" href="/workflows/start" style={{ height: 32, padding: "0 10px", fontSize: 12 }}>
              <Play size={14} />
              Launch
            </Link>
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Search pages (Command/Ctrl + K)"
              title="Search pages (⌘K)"
              style={{
                display: "flex", alignItems: "center", gap: 6,
                height: 32, padding: "0 10px", borderRadius: 8,
                border: "1px solid var(--color-outline-variant)",
                background: "var(--color-surface-low)", cursor: "pointer",
                color: "var(--color-outline)", fontSize: 12, transition: "all 0.15s",
              }}
            >
              <Search size={15} />
              <span style={{ fontWeight: 600 }}>Search</span>
              <kbd style={{
                fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 5,
                border: "1px solid var(--color-outline-variant)", color: "var(--color-outline)",
              }}>⌘K</kbd>
            </button>
            <AppSwitcher />
            <NotificationCenter />
            <ThemeSwitcher compact />
            <Link
              href="/settings"
              style={{
                width: 32, height: 32, borderRadius: 8,
                border: "1px solid var(--color-outline-variant)",
                background: "var(--color-surface-low)", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                textDecoration: "none",
                color: "var(--color-outline)", transition: "all 0.15s",
              }}
              aria-label="Settings"
              title="Settings"
            >
              <Settings size={15} />
            </Link>
            <LogoutButton />
          </div>
        </header>

        {/* ── Page content ── */}
        <main
          style={{
            flex: 1,
            overflow: "auto",
            padding: "2rem",
            background: "var(--color-surface)",
          }}
        >
          {children}
        </main>
      </div>
      <EventHorizonChat />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
    </RequireSession>
  );
}
