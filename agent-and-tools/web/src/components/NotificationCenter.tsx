"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock3,
  ShieldCheck,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { apiPath, assertValidApiResponse, authHeaders, readResponseBody } from "@/lib/api";
import {
  applyNotificationState,
  derivePlatformNotifications,
  loadNotificationPreferences,
  loadNotificationState,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationLocalState,
  type NotificationPreferences,
  type NotificationSeverity,
  saveNotificationState,
  unresolvedNotificationCount,
} from "@/lib/platformNotifications";
import type { PlatformNotification } from "@/lib/platformNotifications";

const categoryLabels = Object.fromEntries(NOTIFICATION_CATEGORIES.map((item) => [item.id, item.label])) as Record<NotificationCategory, string>;
const tabOrder: Array<"action" | NotificationCategory | "all"> = ["action", "workflow", "runtime", "security", "governance", "all"];

function severityIcon(severity: NotificationSeverity): LucideIcon {
  if (severity === "blocked") return AlertTriangle;
  if (severity === "warning") return Clock3;
  if (severity === "success") return CheckCircle2;
  return ShieldCheck;
}

function severityStyle(severity: NotificationSeverity): { box: string; icon: string; label: string } {
  if (severity === "blocked") return { box: "#fef2f2", icon: "#b91c1c", label: "Blocked" };
  if (severity === "warning") return { box: "#fffbeb", icon: "#b45309", label: "Needs setup" };
  if (severity === "success") return { box: "#ecfdf5", icon: "#047857", label: "Clear" };
  return { box: "#eff6ff", icon: "#1d4ed8", label: "Info" };
}

function relativeTime(value?: string): string {
  if (!value) return "just now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "just now";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function TopbarIconButton({
  onClick,
  open,
  count,
}: {
  onClick: () => void;
  open: boolean;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={count > 0 ? `${count} notifications need attention` : "Notifications"}
      aria-expanded={open}
      title={count > 0 ? `${count} platform notification(s)` : "Notifications"}
      style={{
        width: 32,
        height: 32,
        borderRadius: 10,
        border: "1px solid var(--color-outline-variant)",
        background: open ? "var(--color-surface-container)" : "transparent",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: count > 0 ? "#b45309" : "var(--color-outline)",
        transition: "all 0.15s",
        position: "relative",
      }}
    >
      <Bell size={15} />
      {count > 0 && (
        <span
          style={{
            position: "absolute",
            top: -5,
            right: -5,
            minWidth: 16,
            height: 16,
            borderRadius: 999,
            border: "2px solid #fff",
            background: "#b91c1c",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            fontSize: 10,
            fontWeight: 900,
            lineHeight: 1,
          }}
        >
          {count > 9 ? "9+" : count}
        </span>
      )}
    </button>
  );
}

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PlatformNotification[]>([]);
  const [state, setState] = useState<NotificationLocalState>({});
  const [prefs, setPrefs] = useState<NotificationPreferences>(() => loadNotificationPreferences());
  const [activeTab, setActiveTab] = useState<(typeof tabOrder)[number]>("action");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setState(loadNotificationState());
    setPrefs(loadNotificationPreferences());
    const syncState = () => setState(loadNotificationState());
    const syncPrefs = () => setPrefs(loadNotificationPreferences());
    window.addEventListener("singularity-notification-state-changed", syncState);
    window.addEventListener("singularity-notification-preferences-changed", syncPrefs);
    return () => {
      window.removeEventListener("singularity-notification-state-changed", syncState);
      window.removeEventListener("singularity-notification-preferences-changed", syncPrefs);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(apiPath("/api/adoption/health"), { cache: "no-store", headers: authHeaders() });
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) {
          setItems([{
            id: "auth:sign-in-required",
            title: "Sign in required",
            message: "Notifications need an IAM session before platform health can be checked.",
            severity: "blocked",
            category: "security",
            source: "identity",
            href: "/identity/login",
            actionLabel: "Sign in",
          }]);
          setError(null);
          return;
        }
        const { raw, parsed, parseError } = await readResponseBody(res);
        assertValidApiResponse("/api/adoption/health", raw, parseError);
        if (!res.ok) throw new Error("Adoption health failed to load.");
        setItems(derivePlatformNotifications(parsed));
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setItems([{
            id: "health:notification-load-failed",
            title: "Notification source failed",
            message: err instanceof Error ? err.message : "Could not load platform health.",
            severity: "warning",
            category: "setup",
            source: "platform",
            href: "/operations/readiness",
            actionLabel: "Open Readiness",
          }]);
          setError(err instanceof Error ? err.message : "Could not load notifications.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(load, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const visibleItems = useMemo(() => applyNotificationState(items, state, prefs), [items, prefs, state]);
  const count = unresolvedNotificationCount(visibleItems, state);
  const filteredItems = useMemo(() => {
    if (activeTab === "all") return visibleItems;
    if (activeTab === "action") return visibleItems.filter((item) => item.severity === "blocked" || item.severity === "warning");
    return visibleItems.filter((item) => item.category === activeTab);
  }, [activeTab, visibleItems]);

  function updateLocalState(id: string, patch: NotificationLocalState[string]) {
    const next = { ...state, [id]: { ...(state[id] ?? {}), ...patch } };
    setState(next);
    saveNotificationState(next);
  }

  function markAllRead() {
    const next = { ...state };
    for (const item of visibleItems) next[item.id] = { ...(next[item.id] ?? {}), read: true };
    setState(next);
    saveNotificationState(next);
  }

  return (
    <div style={{ position: "relative" }}>
      <TopbarIconButton open={open} count={count} onClick={() => setOpen((value) => !value)} />
      {open && (
        <div
          role="dialog"
          aria-label="Notification center"
          style={{
            position: "absolute",
            right: 0,
            top: 40,
            width: 430,
            maxWidth: "calc(100vw - 24px)",
            maxHeight: "calc(100vh - 72px)",
            zIndex: 90,
            border: "1px solid var(--color-outline-variant)",
            borderRadius: 14,
            background: "#fff",
            boxShadow: "0 22px 56px rgba(12,23,39,0.20)",
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: 14, borderBottom: "1px solid var(--color-outline-variant)" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 900, color: "var(--color-on-surface)" }}>
                <Bell size={16} style={{ color: "var(--color-primary)" }} />
                Platform Notifications
              </div>
              <p style={{ margin: "4px 0 0", fontSize: 12, lineHeight: 1.45, color: "var(--color-outline)" }}>
                Actionable SDLC, runtime, security, and setup signals.
              </p>
            </div>
            <button type="button" className="btn-secondary" style={{ width: 30, height: 30, padding: 0, justifyContent: "center" }} onClick={() => setOpen(false)} aria-label="Close notifications">
              <X size={14} />
            </button>
          </div>

          <div style={{ display: "flex", gap: 6, overflowX: "auto", padding: "10px 12px", borderBottom: "1px solid rgba(207,216,222,0.6)" }}>
            {tabOrder.map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                style={{
                  border: "1px solid var(--color-outline-variant)",
                  borderRadius: 999,
                  background: activeTab === tab ? "var(--color-primary)" : "#fff",
                  color: activeTab === tab ? "#fff" : "var(--color-on-surface-variant)",
                  padding: "5px 9px",
                  fontSize: 11,
                  fontWeight: 800,
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                }}
              >
                {tab === "action" ? "Action required" : tab === "all" ? "All" : categoryLabels[tab]}
              </button>
            ))}
          </div>

          <div style={{ maxHeight: 420, overflow: "auto", padding: 12 }}>
            {loading && filteredItems.length === 0 && (
              <div style={{ padding: 18, color: "var(--color-outline)", fontSize: 13, fontWeight: 700 }}>Checking platform signals...</div>
            )}
            {error && (
              <div style={{ marginBottom: 10, border: "1px solid #fde68a", background: "#fffbeb", color: "#92400e", borderRadius: 8, padding: 10, fontSize: 12, fontWeight: 700 }}>
                {error}
              </div>
            )}
            {filteredItems.length === 0 ? (
              <div style={{ display: "grid", placeItems: "center", gap: 8, minHeight: 150, textAlign: "center", color: "var(--color-outline)" }}>
                <CheckCircle2 size={28} style={{ color: "var(--color-success)" }} />
                <div style={{ fontSize: 13, fontWeight: 900, color: "var(--color-on-surface)" }}>No unresolved items here</div>
                <div style={{ fontSize: 12 }}>Preferences and resolved items are managed in Settings.</div>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {filteredItems.map((item) => {
                  const Icon = severityIcon(item.severity);
                  const style = severityStyle(item.severity);
                  const isRead = state[item.id]?.read === true;
                  return (
                    <article key={item.id} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 10, padding: 11, background: isRead ? "#fff" : "#f8fafc" }}>
                      <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr)", gap: 10 }}>
                        <span style={{ width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center", background: style.box, color: style.icon }}>
                          <Icon size={17} />
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                            <h3 style={{ margin: 0, fontSize: 13, fontWeight: 900, color: "var(--color-on-surface)" }}>{item.title}</h3>
                            <span className={`badge badge-${item.severity === "success" ? "success" : item.severity === "blocked" ? "blocked" : "medium"}`}>{style.label}</span>
                          </div>
                          <p style={{ margin: "5px 0 0", fontSize: 12, lineHeight: 1.45, color: "var(--color-on-surface-variant)" }}>{item.message}</p>
                          <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, color: "var(--color-outline)", fontSize: 11, fontWeight: 700 }}>
                            <span>{categoryLabels[item.category]}</span>
                            <span>·</span>
                            <span>{item.source}</span>
                            <span>·</span>
                            <span>{relativeTime(item.generatedAt)}</span>
                          </div>
                          {item.fixCommand && (
                            <code style={{ marginTop: 8, display: "block", borderRadius: 7, background: "#0f172a", color: "#e2e8f0", padding: "7px 8px", fontSize: 11, overflowX: "auto" }}>
                              {item.fixCommand}
                            </code>
                          )}
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                            <Link className="btn-primary" href={item.href} style={{ height: 28, padding: "0 9px", fontSize: 11 }} onClick={() => updateLocalState(item.id, { read: true })}>
                              {item.actionLabel}
                            </Link>
                            <button type="button" className="btn-secondary" style={{ height: 28, padding: "0 9px", fontSize: 11 }} onClick={() => updateLocalState(item.id, { read: true })}>
                              Mark read
                            </button>
                            <button type="button" className="btn-secondary" style={{ height: 28, padding: "0 9px", fontSize: 11 }} onClick={() => updateLocalState(item.id, { snoozedUntil: Date.now() + 4 * 60 * 60 * 1000, read: true })}>
                              Snooze 4h
                            </button>
                            <button type="button" className="btn-secondary" style={{ height: 28, padding: "0 9px", fontSize: 11 }} onClick={() => updateLocalState(item.id, { resolved: true, read: true })}>
                              Resolve
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: 12, borderTop: "1px solid var(--color-outline-variant)", background: "#f8fafc" }}>
            <button type="button" className="btn-secondary" style={{ height: 30, padding: "0 9px", fontSize: 11 }} onClick={markAllRead}>
              Mark all read
            </button>
            <Link href="/settings?section=notifications" className="btn-secondary" style={{ height: 30, padding: "0 9px", fontSize: 11 }} onClick={() => setOpen(false)}>
              <Wrench size={13} />
              Notification settings
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
