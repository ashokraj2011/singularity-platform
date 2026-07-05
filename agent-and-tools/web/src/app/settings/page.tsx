"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Bell,
  Bot,
  Cpu,
  GitBranch,
  KeyRound,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  User,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { apiPath, assertValidApiResponse, authHeaders, readResponseBody } from "@/lib/api";
import { getIdentityUser, type LoginUser } from "@/lib/identity/session";
import { asRow, asString } from "@/lib/row";
import { CopyButton } from "@/components/ui/CopyButton";
import { DataPanel, MetricStrip, PageHero, PageShell, StatusPill, type UiState } from "@/components/ui/primitives";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  loadNotificationPreferences,
  loadNotificationState,
  NOTIFICATION_CATEGORIES,
  saveNotificationPreferences,
  saveNotificationState,
  type NotificationCategory,
  type NotificationPreferences,
} from "@/lib/platformNotifications";

type SettingsSection = "profile" | "runtime" | "source" | "notifications" | "workflows" | "security";

type LocalSettings = {
  deploymentMode: "docker" | "bare-metal" | "split-runtime";
  defaultStartRoute: "/start" | "/workflows/planner" | "/workflows/start";
  evidenceMode: "standard" | "strict";
};

type HealthSummary = {
  score: number;
  ready: number;
  warning: number;
  blocked: number;
  connectedRuntimeCount: number;
  readyProviderCount: number;
  readyModelAliasCount: number;
  defaultModelAlias: string;
  defaultModelReady: boolean;
};

const SETTINGS_KEY = "singularity.platform.settings.v1";

const sections: Array<{ id: SettingsSection; label: string; description: string; icon: LucideIcon }> = [
  { id: "profile", label: "Profile", description: "Signed-in user, shell defaults, and local mode.", icon: User },
  { id: "runtime", label: "Runtime + LLM", description: "MCP dial-in, model provider readiness, and setup commands.", icon: Cpu },
  { id: "source", label: "Git + Source", description: "Repository broker, GitHub connections, and push identity.", icon: GitBranch },
  { id: "notifications", label: "Notifications", description: "Choose which platform signals appear in the bell.", icon: Bell },
  { id: "workflows", label: "Workflow Defaults", description: "Start route, evidence mode, and SDLC launch preferences.", icon: Workflow },
  { id: "security", label: "Security", description: "Access keys, roles, runtime tokens, and admin controls.", icon: ShieldCheck },
];

const defaultSettings: LocalSettings = {
  deploymentMode: "split-runtime",
  defaultStartRoute: "/start",
  evidenceMode: "standard",
};

function loadSettings(): LocalSettings {
  if (typeof window === "undefined") return defaultSettings;
  try {
    const row = asRow(JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "{}") as unknown);
    const deploymentMode = asString(row.deploymentMode);
    const defaultStartRoute = asString(row.defaultStartRoute);
    const evidenceMode = asString(row.evidenceMode);
    return {
      deploymentMode: deploymentMode === "docker" || deploymentMode === "bare-metal" || deploymentMode === "split-runtime"
        ? deploymentMode
        : defaultSettings.deploymentMode,
      defaultStartRoute: defaultStartRoute === "/workflows/planner" || defaultStartRoute === "/workflows/start" || defaultStartRoute === "/start"
        ? defaultStartRoute
        : defaultSettings.defaultStartRoute,
      evidenceMode: evidenceMode === "strict" ? "strict" : "standard",
    };
  } catch {
    return defaultSettings;
  }
}

function saveSettings(settings: LocalSettings): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function healthState(summary: HealthSummary | null): UiState {
  if (!summary) return "waiting";
  if (summary.blocked > 0) return "blocked";
  if (summary.warning > 0) return "degraded";
  return "ready";
}

function normalizeHealthSummary(value: unknown): HealthSummary {
  const row = asRow(value);
  const summary = asRow(row.summary);
  return {
    score: asNumber(row.score),
    ready: asNumber(summary.ready),
    warning: asNumber(summary.warning),
    blocked: asNumber(summary.blocked),
    connectedRuntimeCount: asNumber(summary.connectedRuntimeCount),
    readyProviderCount: asNumber(summary.readyProviderCount),
    readyModelAliasCount: asNumber(summary.readyModelAliasCount),
    defaultModelAlias: asString(summary.defaultModelAlias, "unknown"),
    defaultModelReady: summary.defaultModelReady === true,
  };
}

function CommandLine({ label, command }: { label: string; command: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-950 p-3 text-slate-100">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-400">{label}</span>
        <CopyButton text={command} />
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap text-xs leading-5">{command}</pre>
    </div>
  );
}

export default function SettingsPage() {
  const [section, setSection] = useState<SettingsSection>("profile");
  const [prefs, setPrefs] = useState<NotificationPreferences>(() => ({ ...DEFAULT_NOTIFICATION_PREFERENCES }));
  const [settings, setSettings] = useState<LocalSettings>(defaultSettings);
  const [user, setUser] = useState<LoginUser | null>(null);
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resolvedCount, setResolvedCount] = useState(0);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const requested = query.get("section");
    if (sections.some((item) => item.id === requested)) setSection(requested as SettingsSection);
    setPrefs(loadNotificationPreferences());
    setSettings(loadSettings());
    setUser(getIdentityUser());
    setResolvedCount(Object.values(loadNotificationState()).filter((item) => item.resolved || item.snoozedUntil || item.read).length);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadHealth() {
      try {
        const res = await fetch(apiPath("/api/adoption/health"), { cache: "no-store", headers: authHeaders() });
        const { raw, parsed, parseError } = await readResponseBody(res);
        assertValidApiResponse("/api/adoption/health", raw, parseError);
        if (!res.ok) throw new Error("Adoption health failed to load.");
        if (!cancelled) {
          setHealth(normalizeHealthSummary(parsed));
          setLoadError(null);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Unable to load health summary.");
      }
    }
    void loadHealth();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeSection = useMemo(() => sections.find((item) => item.id === section) ?? sections[0], [section]);

  function updatePrefs(category: NotificationCategory, enabled: boolean) {
    const next = { ...prefs, [category]: enabled };
    setPrefs(next);
    saveNotificationPreferences(next);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }

  function updateLocalSettings(next: LocalSettings) {
    setSettings(next);
    saveSettings(next);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }

  function resetNotificationState() {
    saveNotificationState({});
    setResolvedCount(0);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }

  return (
    <PageShell>
      <div className="space-y-5">
        <PageHero
          eyebrow="Settings"
          title="Platform Settings"
          icon={Settings}
          description="One place for runtime setup, source control, notification preferences, workflow defaults, and security routes."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill state={healthState(health)} label={health ? `${health.score}% health` : "Checking"} />
              {saved && <StatusPill state="ready" label="Saved" icon={Save} />}
            </div>
          }
        />

        <MetricStrip
          items={[
            { label: "Blocked", value: health?.blocked ?? "-", icon: ShieldCheck, state: health?.blocked ? "blocked" : "ready" },
            { label: "Warnings", value: health?.warning ?? "-", icon: Bell, state: health?.warning ? "degraded" : "ready" },
            { label: "Runtimes", value: health?.connectedRuntimeCount ?? "-", icon: Cpu, state: health?.connectedRuntimeCount ? "ready" : "needs-runtime" },
            { label: "Models", value: health?.readyModelAliasCount ?? "-", icon: Bot, state: health?.defaultModelReady ? "ready" : "degraded", hint: health?.defaultModelAlias },
          ]}
        />

        {loadError && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-900">
            {loadError}
          </div>
        )}

        <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
          <nav className="data-panel p-2">
            {sections.map((item) => {
              const Icon = item.icon;
              const active = item.id === section;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSection(item.id)}
                  className="w-full rounded-lg px-3 py-3 text-left transition"
                  style={{
                    background: active ? "var(--color-primary-dim)" : "transparent",
                    color: active ? "var(--color-on-surface)" : "var(--color-on-surface-variant)",
                  }}
                >
                  <span className="flex items-center gap-2 text-sm font-black">
                    <Icon size={16} style={{ color: active ? "var(--color-primary)" : "var(--color-outline)" }} />
                    {item.label}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-slate-500">{item.description}</span>
                </button>
              );
            })}
          </nav>

          <div className="space-y-4">
            <DataPanel title={activeSection.label} description={activeSection.description} icon={activeSection.icon}>
              {section === "profile" && (
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border border-slate-200 p-4">
                    <div className="label-xs">Signed-in user</div>
                    <div className="mt-2 text-lg font-black text-slate-950">{user?.display_name || user?.email || "Not signed in"}</div>
                    <p className="mt-1 text-sm text-slate-500">{user?.id ?? "Open Identity to sign in or inspect session state."}</p>
                    <Link href="/identity/dashboard" className="btn-secondary mt-3">Open Identity</Link>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-4">
                    <label className="label-xs" htmlFor="deployment-mode">Deployment mode</label>
                    <select
                      id="deployment-mode"
                      className="control mt-2"
                      value={settings.deploymentMode}
                      onChange={(event) => updateLocalSettings({ ...settings, deploymentMode: event.target.value as LocalSettings["deploymentMode"] })}
                    >
                      <option value="split-runtime">Split runtime: apps here, MCP+LLM elsewhere</option>
                      <option value="bare-metal">Bare metal apps</option>
                      <option value="docker">Docker compose</option>
                    </select>
                    <p className="mt-2 text-xs leading-5 text-slate-500">Used by setup copy and onboarding hints in this browser.</p>
                  </div>
                </div>
              )}

              {section === "runtime" && (
                <div className="space-y-4">
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-lg border border-slate-200 p-4">
                      <div className="label-xs">Runtime clients</div>
                      <div className="mt-2 text-2xl font-black text-slate-950">{health?.connectedRuntimeCount ?? "-"}</div>
                    </div>
                    <div className="rounded-lg border border-slate-200 p-4">
                      <div className="label-xs">Providers</div>
                      <div className="mt-2 text-2xl font-black text-slate-950">{health?.readyProviderCount ?? "-"}</div>
                    </div>
                    <div className="rounded-lg border border-slate-200 p-4">
                      <div className="label-xs">Default model</div>
                      <div className="mt-2 text-sm font-black text-slate-950">{health?.defaultModelAlias ?? "unknown"}</div>
                      <StatusPill state={health?.defaultModelReady ? "ready" : "degraded"} label={health?.defaultModelReady ? "Ready" : "Needs setup"} />
                    </div>
                  </div>
                  <CommandLine label="Laptop / remote runtime setup" command="bin/mcp-runtime-setup.sh" />
                  <CommandLine label="Two terminal split-runtime test" command={"# terminal 1\nbin/bare-metal-apps.sh up\n\n# terminal 2, laptop or runtime host\nbin/mcp-runtime-setup.sh"} />
                  <div className="flex flex-wrap gap-2">
                    <Link href="/llm-settings" className="btn-primary">Open Runtime + LLM</Link>
                    <Link href="/operations/readiness" className="btn-secondary">Open Readiness</Link>
                  </div>
                </div>
              )}

              {section === "source" && (
                <div className="space-y-4">
                  <p className="text-sm leading-6 text-slate-600">
                    Source control should flow through IAM-brokered repository grants for shared runtimes, while personal laptop runtimes use their local Git credentials.
                  </p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <Link href="/identity/git-connections" className="rounded-lg border border-slate-200 p-4 text-slate-900 no-underline hover:border-emerald-300">
                      <GitBranch size={18} className="text-emerald-700" />
                      <div className="mt-2 font-black">GitHub Connections</div>
                      <p className="mt-1 text-sm text-slate-500">Tenant GitHub App installations and broker setup.</p>
                    </Link>
                    <Link href="/identity/repository-grants" className="rounded-lg border border-slate-200 p-4 text-slate-900 no-underline hover:border-emerald-300">
                      <ShieldCheck size={18} className="text-emerald-700" />
                      <div className="mt-2 font-black">Repository Grants</div>
                      <p className="mt-1 text-sm text-slate-500">Authorize clone, diff, branch, and push actions.</p>
                    </Link>
                  </div>
                  <CommandLine label="Runtime with Git token" command="GITHUB_TOKEN=github_pat_... bin/mcp-runtime-setup.sh" />
                </div>
              )}

              {section === "notifications" && (
                <div className="space-y-4">
                  <div className="grid gap-2">
                    {NOTIFICATION_CATEGORIES.map((category) => (
                      <label key={category.id} className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 p-3">
                        <span>
                          <span className="block text-sm font-black text-slate-950">{category.label}</span>
                          <span className="block text-xs leading-5 text-slate-500">{category.description}</span>
                        </span>
                        <input
                          type="checkbox"
                          checked={prefs[category.id]}
                          onChange={(event) => updatePrefs(category.id, event.target.checked)}
                          className="h-5 w-5 accent-emerald-700"
                        />
                      </label>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div>
                      <div className="text-sm font-black text-slate-950">Local notification state</div>
                      <p className="mt-1 text-xs text-slate-500">{resolvedCount} read, snoozed, or resolved item(s) stored in this browser.</p>
                    </div>
                    <button type="button" className="btn-secondary" onClick={resetNotificationState}>
                      <RotateCcw size={14} />
                      Reset local state
                    </button>
                  </div>
                </div>
              )}

              {section === "workflows" && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-lg border border-slate-200 p-4">
                    <label className="label-xs" htmlFor="start-route">Default start route</label>
                    <select
                      id="start-route"
                      className="control mt-2"
                      value={settings.defaultStartRoute}
                      onChange={(event) => updateLocalSettings({ ...settings, defaultStartRoute: event.target.value as LocalSettings["defaultStartRoute"] })}
                    >
                      <option value="/start">Start SDLC Work</option>
                      <option value="/workflows/planner">Story Planner</option>
                      <option value="/workflows/start">Guided Launch</option>
                    </select>
                    <Link href={settings.defaultStartRoute} className="btn-secondary mt-3">Open default start</Link>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-4">
                    <label className="label-xs" htmlFor="evidence-mode">Evidence mode</label>
                    <select
                      id="evidence-mode"
                      className="control mt-2"
                      value={settings.evidenceMode}
                      onChange={(event) => updateLocalSettings({ ...settings, evidenceMode: event.target.value as LocalSettings["evidenceMode"] })}
                    >
                      <option value="standard">Standard evidence</option>
                      <option value="strict">Strict governance evidence</option>
                    </select>
                    <p className="mt-2 text-xs leading-5 text-slate-500">Stored locally for launch defaults while backend workflow preferences are introduced.</p>
                  </div>
                </div>
              )}

              {section === "security" && (
                <div className="grid gap-3 md:grid-cols-2">
                  <Link href="/operations/access-keys" className="rounded-lg border border-slate-200 p-4 text-slate-900 no-underline hover:border-emerald-300">
                    <KeyRound size={18} className="text-emerald-700" />
                    <div className="mt-2 font-black">Access Keys</div>
                    <p className="mt-1 text-sm text-slate-500">Runtime/device tokens, service access, and key hygiene.</p>
                  </Link>
                  <Link href="/identity/roles" className="rounded-lg border border-slate-200 p-4 text-slate-900 no-underline hover:border-emerald-300">
                    <ShieldCheck size={18} className="text-emerald-700" />
                    <div className="mt-2 font-black">Roles and permissions</div>
                    <p className="mt-1 text-sm text-slate-500">IAM roles, capability access, and authorization checks.</p>
                  </Link>
                </div>
              )}
            </DataPanel>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
