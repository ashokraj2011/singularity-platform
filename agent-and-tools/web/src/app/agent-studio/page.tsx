"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { ApiError, hasAgentToolsToken, identityApi, runtimeApi, saveAgentToolsToken } from "@/lib/api";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  CircleAlert,
  GitBranch,
  History,
  Layers,
  Library,
  Lock,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

/**
 * M23 — /agent-studio
 *
 * Single workbench surface that replaces the legacy /agents and
 * /agent-templates flat lists. Renders:
 *   - Capability Agents  (capabilityId === selected, editable, lineage badge)
 *   - Common Library     (capabilityId NULL, lockedReason badge)
 *   - Detail panel for the selected agent
 *   - Derive dialog from any common agent into the selected capability
 */

type Agent = {
  id: string;
  name: string;
  description?: string;
  roleType?: string;
  capabilityId?: string | null;
  baseTemplateId?: string | null;
  lockedReason?: string | null;
  basePromptProfileId?: string | null;
  editable?: boolean;
  status?: string;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
};

type AgentVersion = {
  id: string;
  version: number;
  changeSummary?: string | null;
  snapshot?: Record<string, unknown>;
  createdBy?: string | null;
  createdAt?: string;
};

type Capability = {
  id: string;
  name?: string;
  capabilityType?: string | null;
  status?: string;
};

type PromptProfile = {
  id: string;
  name?: string;
  description?: string | null;
  layers?: Array<{
    id: string;
    priority?: number;
    isEnabled?: boolean;
    promptLayer?: {
      id: string;
      name?: string;
      layerType?: string;
      scopeType?: string;
      content?: string;
    };
  }>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function apiErrorSummary(error: unknown): { title: string; message: string; detail?: string } {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return {
        title: "Unauthorized",
        message: "Sign in or provide an agent-tools bearer token before changing governed agent templates.",
        detail: error.requestId ? `request ${error.requestId}` : undefined,
      };
    }
    const detail = [
      error.code,
      error.requestId ? `request ${error.requestId}` : null,
      error.details ? JSON.stringify(error.details) : null,
    ].filter(Boolean).join(" · ");
    return { title: error.code ?? `HTTP ${error.status ?? "error"}`, message: error.message, detail };
  }
  return { title: "Request failed", message: (error as Error)?.message ?? "Unknown error" };
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export default function AgentStudioPage() {
  const [capabilityId, setCapabilityId] = useState("");
  const [selected, setSelected] = useState<Agent | null>(null);
  const [deriveTarget, setDeriveTarget] = useState<Agent | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "editable" | "locked" | "missing-profile">("all");

  const { data: capabilities = [], error: capabilitiesError, isLoading: capabilitiesLoading } = useSWR(
    "runtime-capabilities-for-agent-studio",
    () => runtimeApi.listCapabilities() as Promise<Capability[]>,
  );

  const selectedCapability = capabilities.find((c) => c.id === capabilityId) ?? null;
  const validCapabilitySelected = !capabilityId || UUID_RE.test(capabilityId);

  // List (common ∪ capability) — when capabilityId is empty, only common rows render.
  const swrKey = capabilityId ? `studio-${capabilityId}` : "studio-common";
  const { data, mutate, error, isLoading } = useSWR(swrKey, async () => {
    if (capabilityId && !UUID_RE.test(capabilityId)) {
      throw new ApiError("Select a valid capability before loading capability agents.", 400, "INVALID_CAPABILITY");
    }
    if (!capabilityId) {
      return runtimeApi.listTemplatesScoped("common");
    }
    return runtimeApi.listTemplatesScoped("all", capabilityId);
  });

  const items = (data?.items ?? []) as Agent[];
  const common     = useMemo(() => items.filter((a) => !a.capabilityId), [items]);
  const capability = useMemo(
    () => items.filter((a) => a.capabilityId === capabilityId),
    [items, capabilityId],
  );
  const filteredCommon = useMemo(() => filterAgents(common, query, filter), [common, query, filter]);
  const filteredCapability = useMemo(() => filterAgents(capability, query, filter), [capability, query, filter]);
  const stats = useMemo(() => {
    const editable = items.filter((a) => a.editable ?? Boolean(a.capabilityId)).length;
    const missingProfiles = items.filter((a) => !a.basePromptProfileId).length;
    const locked = items.filter((a) => !a.capabilityId || Boolean(a.lockedReason)).length;
    return { editable, missingProfiles, locked };
  }, [items]);

  useEffect(() => {
    setSignedIn(hasAgentToolsToken());
  }, []);

  const authNeeded = !signedIn || isUnauthorized(error) || isUnauthorized(capabilitiesError);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-emerald-800">
              <ShieldCheck size={13} />
              Governed templates
            </div>
            <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">Agent Studio</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Manage common locked baselines, capability-derived agents, prompt bindings, and version history from one place.
            </p>
          </div>

          <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4 xl:min-w-[520px]">
            <MetricCard label="Capability" value={capability.length} tone="emerald" />
            <MetricCard label="Common" value={common.length} tone="blue" />
            <MetricCard label="Editable" value={stats.editable} tone="slate" />
            <MetricCard label="Needs profile" value={stats.missingProfiles} tone={stats.missingProfiles ? "amber" : "slate"} />
          </div>
        </div>
      </div>

      {authNeeded && (
        <AgentStudioAuthCard
          onAuthenticated={() => {
            setSignedIn(true);
            mutate();
          }}
        />
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 xl:grid-cols-[minmax(260px,1fr)_minmax(280px,0.9fr)_auto] xl:items-end">
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
              Capability scope
            </label>
            <select
              className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
              value={capabilityId}
              onChange={(e) => { setCapabilityId(e.target.value); setSelected(null); }}
              disabled={capabilitiesLoading}
            >
              <option value="">Common library only</option>
              {capabilities.map((cap) => (
                <option key={cap.id} value={cap.id}>
                  {cap.name ?? cap.id}{cap.capabilityType ? ` - ${cap.capabilityType}` : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
              Find agents
            </label>
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, role, description, id..."
                className="h-11 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => void mutate()}
            className="btn-secondary h-11 justify-center text-sm"
            disabled={isLoading}
          >
            <RefreshCw size={15} className={isLoading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>

        <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 text-xs text-slate-500">
            {selectedCapability ? (
              <span>
                <span className="font-semibold text-slate-700">{selectedCapability.name ?? "Selected capability"}</span>
                {selectedCapability.capabilityType ? ` - ${selectedCapability.capabilityType}` : ""}
                <span className="ml-2 font-mono text-slate-400">{selectedCapability.id}</span>
              </span>
            ) : (
              "Inspect common baselines, or choose a capability to derive and govern capability-scoped agents."
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              ["all", "All"],
              ["editable", "Editable"],
              ["locked", "Locked"],
              ["missing-profile", "Needs profile"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value as typeof filter)}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                  filter === value
                    ? "border-emerald-600 bg-emerald-50 text-emerald-800"
                    : "border-slate-200 bg-white text-slate-600 hover:border-emerald-300 hover:text-emerald-800"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {capabilitiesError && <ErrorBanner error={capabilitiesError} compact />}
      </div>

      {!validCapabilitySelected && <ErrorBanner error={new ApiError("Capability id is not a valid UUID.", 400, "INVALID_CAPABILITY")} />}
      {error && <ErrorBanner error={error} />}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        {/* Left: lists */}
        <div className="space-y-6">
          <Section
            icon={GitBranch}
            title="Capability Agents"
            subtitle="Editable children grounded to the selected capability."
            count={filteredCapability.length}
            total={capability.length}
            empty={isLoading ? "Loading capability agents..." : capabilityId ? "No matching derived agents for this capability." : "Pick a capability to see derived agents."}
          >
            {!isLoading && filteredCapability.map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                selected={selected?.id === a.id}
                onSelect={() => setSelected(a)}
              />
            ))}
          </Section>

          <Section
            icon={Library}
            title="Common Library"
            subtitle="Locked baselines operators can derive into a capability."
            count={filteredCommon.length}
            total={common.length}
            empty={isLoading ? "Loading common templates..." : "No matching common templates available."}
          >
            {!isLoading && filteredCommon.map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                selected={selected?.id === a.id}
                onSelect={() => setSelected(a)}
                onDerive={capabilityId && validCapabilitySelected ? () => setDeriveTarget(a) : undefined}
              />
            ))}
          </Section>
        </div>

        {/* Right: detail */}
        <div>
          <DetailPanel
            agent={selected}
            onChanged={(agent) => {
              setSelected(agent);
              mutate();
            }}
          />
        </div>
      </div>

      {deriveTarget && capabilityId && (
        <DeriveDialog
          base={deriveTarget}
          capabilityId={capabilityId}
          onAuthRequired={() => setSignedIn(false)}
          onClose={() => setDeriveTarget(null)}
          onDone={() => { setDeriveTarget(null); mutate(); }}
        />
      )}
    </div>
  );
}

function filterAgents(
  agents: Agent[],
  query: string,
  filter: "all" | "editable" | "locked" | "missing-profile",
) {
  const q = query.trim().toLowerCase();
  return agents.filter((agent) => {
    const isCommon = !agent.capabilityId;
    const editable = agent.editable ?? !isCommon;
    const locked = isCommon || Boolean(agent.lockedReason);
    if (filter === "editable" && !editable) return false;
    if (filter === "locked" && !locked) return false;
    if (filter === "missing-profile" && agent.basePromptProfileId) return false;
    if (!q) return true;
    return [
      agent.name,
      agent.description,
      agent.roleType,
      agent.status,
      agent.id,
      agent.baseTemplateId,
      agent.capabilityId,
    ].filter(Boolean).some((value) => String(value).toLowerCase().includes(q));
  });
}

function MetricCard({
  label,
  value,
  tone,
}: { label: string; value: number; tone: "emerald" | "blue" | "amber" | "slate" }) {
  const palette: Record<typeof tone, string> = {
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
    blue: "border-blue-200 bg-blue-50 text-blue-900",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    slate: "border-slate-200 bg-slate-50 text-slate-900",
  };
  return (
    <div className={`rounded-xl border px-3 py-2 ${palette[tone]}`}>
      <div className="text-[10px] font-bold uppercase tracking-[0.16em] opacity-70">{label}</div>
      <div className="mt-1 text-2xl font-bold leading-none">{value}</div>
    </div>
  );
}

function AgentStudioAuthCard({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [email, setEmail] = useState("admin@singularity.local");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await identityApi.login({ email, password });
      saveAgentToolsToken(res.access_token);
      onAuthenticated();
    } catch (e) {
      setError((e as Error).message ?? "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4 mb-6 border-emerald-200 bg-emerald-50/50">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <ShieldCheck size={16} className="text-emerald-700" />
            Sign in for governed agent changes
          </div>
          <p className="mt-1 text-xs text-slate-600">
            Agent Studio runs on port 3000, so it needs its own IAM bearer before creating or editing governed templates.
          </p>
        </div>
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-[1fr_180px_auto]">
          <input
            className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email"
            autoComplete="username"
          />
          <input
            className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="password"
            type="password"
            autoComplete="current-password"
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !email || !password}
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Signing in..." : "Sign in"}
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function ErrorBanner({ error, compact = false }: { error: unknown; compact?: boolean }) {
  const e = apiErrorSummary(error);
  return (
    <div className={`${compact ? "mt-3" : "mb-4"} flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800`}>
      <AlertCircle size={15} className="shrink-0 mt-0.5" />
      <div>
        <div className="font-semibold">{e.title}</div>
        <div>{e.message}</div>
        {e.detail && <div className="text-[11px] text-red-600 mt-1 break-all">{e.detail}</div>}
      </div>
    </div>
  );
}

// ── components ────────────────────────────────────────────────────────────

function Section({
  icon: Icon, title, subtitle, count, total, empty, children,
}: {
  icon: React.ElementType;
  title: string;
  subtitle: string;
  count: number;
  total: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-2 border-b border-slate-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-950">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
              <Icon size={16} />
            </span>
            {title}
          </h2>
          <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
        </div>
        <div className="text-xs font-semibold text-slate-500">
          Showing <span className="text-slate-900">{count}</span> of <span className="text-slate-900">{total}</span>
        </div>
      </div>
      {count === 0 ? (
        <div className="px-4 py-8">
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center">
            <p className="text-sm font-semibold text-slate-700">{empty}</p>
            <p className="mt-1 text-xs text-slate-500">Try changing the capability, search text, or filter.</p>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-slate-100">{children}</div>
      )}
    </section>
  );
}

function AgentRow({
  agent, selected, onSelect, onDerive,
}: { agent: Agent; selected: boolean; onSelect: () => void; onDerive?: () => void }) {
  const isCommon = !agent.capabilityId;
  const editable = agent.editable ?? !isCommon;
  const locked = isCommon || Boolean(agent.lockedReason);
  return (
    <div
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`group cursor-pointer px-4 py-3 outline-none transition ${
        selected ? "bg-emerald-50/70" : "bg-white hover:bg-slate-50"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
          selected ? "border-emerald-200 bg-emerald-100 text-emerald-800" : "border-slate-200 bg-slate-50 text-slate-500"
        }`}>
          <Bot size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-950">{agent.name}</span>
            {agent.roleType && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-600">
                {agent.roleType}
              </span>
            )}
            <Badge color="slate" label={`v${agent.version ?? 1}`} />
            {isCommon ? (
              <Badge color="amber" icon={<Lock size={10} />} label="Locked" title={agent.lockedReason ?? "common platform baseline"} />
            ) : agent.baseTemplateId ? (
              <Badge color="blue" icon={<Sparkles size={10} />} label="Derived" />
            ) : (
              <Badge color="slate" label="Custom" />
            )}
            {editable && <Badge color="emerald" label="Editable" />}
            {!agent.basePromptProfileId && <Badge color="red" label="No prompt profile" />}
          </div>
          {agent.description && (
            <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">{agent.description}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
            <span className="font-mono">{agent.id.slice(0, 18)}...</span>
            <span className="inline-flex items-center gap-1">
              {locked ? <Lock size={11} /> : <CheckCircle2 size={11} />}
              {locked ? "governed baseline" : "capability scoped"}
            </span>
            <span>{agent.status ?? "status unknown"}</span>
          </div>
        </div>
        {onDerive && (
          <button
            onClick={(e) => { e.stopPropagation(); onDerive(); }}
            className="btn-secondary shrink-0 text-xs"
          >
            Derive
          </button>
        )}
      </div>
    </div>
  );
}

function Badge({
  color, label, icon, title,
}: { color: "amber" | "blue" | "emerald" | "slate" | "red"; label: string; icon?: React.ReactNode; title?: string }) {
  const palette: Record<string, string> = {
    amber:   "bg-amber-50 text-amber-700 border-amber-200",
    blue:    "bg-blue-50 text-blue-700 border-blue-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    slate:   "bg-slate-50 text-slate-700 border-slate-200",
    red:     "bg-red-50 text-red-700 border-red-200",
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${palette[color]}`}
    >
      {icon}{label}
    </span>
  );
}

function DetailPanel({ agent, onChanged }: { agent: Agent | null; onChanged: (agent: Agent) => void }) {
  const [editing, setEditing] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState<number | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const { data: profile, error: profileError, isLoading: profileLoading } = useSWR(
    agent?.basePromptProfileId ? `prompt-profile-${agent.basePromptProfileId}` : null,
    () => runtimeApi.getProfile(agent!.basePromptProfileId!) as Promise<PromptProfile>,
  );
  const {
    data: versions = [],
    error: versionsError,
    mutate: mutateVersions,
  } = useSWR(
    agent?.id ? `agent-template-versions-${agent.id}` : null,
    () => runtimeApi.listTemplateVersions(agent!.id) as Promise<AgentVersion[]>,
  );

  if (!agent) {
    return (
      <div className="sticky top-4 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
          <Bot size={22} />
        </div>
        <h3 className="mt-4 text-sm font-semibold text-slate-900">Select an agent</h3>
        <p className="mt-1 text-sm leading-6 text-slate-500">
          Lineage, prompt layers, version history, and governance state will appear here.
        </p>
      </div>
    );
  }
  const isCommon = !agent.capabilityId;
  const isLocked = isCommon || Boolean(agent.lockedReason);
  const editable = agent.editable ?? !isCommon;

  async function restore(version: number) {
    setRestoreBusy(version);
    setRestoreError(null);
    try {
      const restored = await runtimeApi.restoreTemplateVersion(agent!.id, version, {
        changeSummary: `Restored from version ${version}`,
      }) as Agent;
      onChanged(restored);
      await mutateVersions();
    } catch (e) {
      const formatted = apiErrorSummary(e);
      setRestoreError(`${formatted.title}: ${formatted.message}`);
    } finally {
      setRestoreBusy(null);
    }
  }

  return (
    <aside className="sticky top-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 bg-slate-50/70 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {isLocked ? (
                <Badge color="amber" icon={<Lock size={10} />} label="Locked" />
              ) : (
                <Badge color="emerald" icon={<Sparkles size={10} />} label="Editable" />
              )}
              {agent.roleType && <Badge color="slate" label={agent.roleType} />}
              <Badge color="blue" label={`v${agent.version ?? 1}`} />
            </div>
            <h3 className="mt-3 text-lg font-semibold leading-6 text-slate-950">{agent.name}</h3>
            <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{agent.id}</p>
          </div>
          {editable && (
            <button onClick={() => setEditing(true)} className="btn-secondary shrink-0 text-xs">
              <Save size={13} /> Edit
            </button>
          )}
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">{agent.status ?? "Unknown"}</Field>
          <Field label="Version">v{agent.version ?? 1}</Field>
          <Field label="Scope">
            {agent.capabilityId ? "Capability" : "Common"}
          </Field>
          <Field label="Prompt">
            {agent.basePromptProfileId ? "Bound" : <span className="text-red-700">Missing</span>}
          </Field>
        </div>

        <DetailBlock title="Lineage" icon={GitBranch}>
          {agent.baseTemplateId ? (
            <span className="break-all text-blue-700">Derived from <code>{agent.baseTemplateId}</code></span>
          ) : (
            <span className="text-slate-500">Root template with no base template.</span>
          )}
        </DetailBlock>

        <DetailBlock title="Capability" icon={ShieldCheck}>
          {agent.capabilityId ? (
            <code className="break-all text-xs">{agent.capabilityId}</code>
          ) : (
            <span className="text-amber-700">Cross-capability common library baseline.</span>
          )}
        </DetailBlock>

        <DetailBlock title="Prompt Layers" icon={Layers}>
        {!agent.basePromptProfileId ? (
          <p className="text-xs text-red-700">No base prompt profile is configured.</p>
        ) : profileLoading ? (
          <div className="space-y-2">
            <div className="h-8 rounded bg-slate-100" />
            <div className="h-8 rounded bg-slate-100" />
          </div>
        ) : profileError ? (
          <div className="text-xs text-red-700">{apiErrorSummary(profileError).message}</div>
        ) : (
          <div className="space-y-1">
            <p className="text-xs font-semibold text-slate-700">{profile?.name ?? agent.basePromptProfileId}</p>
            {(profile?.layers ?? []).length === 0 ? (
              <p className="text-xs text-amber-700">Profile has no enabled layers.</p>
            ) : (
              (profile?.layers ?? [])
                .filter((l) => l.isEnabled !== false)
                .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
                .map((l) => (
                  <div key={l.id} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5">
                    <div className="text-[11px] font-semibold text-slate-700">
                      {l.priority ?? "-"} - {l.promptLayer?.name ?? l.promptLayer?.id ?? l.id}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {l.promptLayer?.layerType ?? "layer"} - {l.promptLayer?.scopeType ?? "scope"}
                    </div>
                  </div>
                ))
            )}
          </div>
        )}
        </DetailBlock>

        <DetailBlock title="Runtime Evidence" icon={CircleAlert}>
          <span className="text-slate-500">No recent execution evidence is attached to this template yet.</span>
        </DetailBlock>

        <DetailBlock title="Version History" icon={History}>
        {versionsError ? (
          <p className="text-xs text-red-700">{apiErrorSummary(versionsError).message}</p>
        ) : versions.length === 0 ? (
          <p className="text-xs text-slate-400">No versions captured yet. Editing this agent will create the first immutable snapshot.</p>
        ) : (
          <div className="space-y-1">
            {versions.slice(0, 6).map((v) => {
              const current = v.version === (agent.version ?? 1);
              return (
                <div key={v.id} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold text-slate-700">
                        v{v.version}{current ? " - current" : ""}
                      </div>
                      <div className="text-[10px] text-slate-500 truncate">
                        {v.changeSummary ?? "Snapshot"} - {v.createdAt ? new Date(v.createdAt).toLocaleString() : "-"}
                      </div>
                    </div>
                    {editable && !current && (
                      <button
                        onClick={() => void restore(v.version)}
                        disabled={restoreBusy === v.version}
                        className="btn-secondary text-[11px] px-2 py-1"
                        title={`Restore version ${v.version}`}
                      >
                        <RotateCcw size={11} /> {restoreBusy === v.version ? "..." : "Restore"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {restoreError && <p className="mt-2 text-xs text-red-700">{restoreError}</p>}
        </DetailBlock>

      {agent.description && (
        <DetailBlock title="Description" icon={Bot}>
          <p className="text-xs text-slate-700 leading-relaxed">{agent.description}</p>
        </DetailBlock>
      )}

        <div className="border-t border-slate-100 pt-3 text-[11px] text-slate-400">
          created {agent.createdAt ? new Date(agent.createdAt).toLocaleString() : "-"} - updated {agent.updatedAt ? new Date(agent.updatedAt).toLocaleString() : "-"}
        </div>
      </div>

      {editing && (
        <EditAgentDialog
          agent={agent}
          onClose={() => setEditing(false)}
          onDone={(updated) => {
            setEditing(false);
            onChanged(updated);
            mutateVersions();
          }}
        />
      )}
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="mb-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className="text-sm font-semibold text-slate-900">{children}</div>
    </div>
  );
}

function DetailBlock({
  title,
  icon: Icon,
  children,
}: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
        <Icon size={12} />
        {title}
      </div>
      <div className="text-sm text-slate-800">{children}</div>
    </div>
  );
}

function EditAgentDialog({
  agent, onClose, onDone,
}: { agent: Agent; onClose: () => void; onDone: (agent: Agent) => void }) {
  const [form, setForm] = useState({
    name: agent.name,
    description: agent.description ?? "",
    basePromptProfileId: agent.basePromptProfileId ?? "",
    status: agent.status ?? "DRAFT",
    changeSummary: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const updated = await runtimeApi.patchTemplate(agent.id, {
        name: form.name,
        description: form.description || undefined,
        basePromptProfileId: form.basePromptProfileId || undefined,
        status: form.status,
        changeSummary: form.changeSummary || `Updated ${agent.name}`,
      }) as Agent;
      onDone(updated);
    } catch (e) {
      const formatted = apiErrorSummary(e);
      setErr(`${formatted.title}: ${formatted.message}${formatted.detail ? ` (${formatted.detail})` : ""}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-xl w-full p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Edit Agent Template</h3>
            <p className="text-xs text-slate-500 mt-1">Saving creates version v{(agent.version ?? 1) + 1} and keeps the previous snapshot restorable.</p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded"><X size={14} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Name</label>
            <input
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Description</label>
            <textarea
              rows={3}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Prompt profile id</label>
              <input
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md font-mono"
                value={form.basePromptProfileId}
                onChange={(e) => setForm((f) => ({ ...f, basePromptProfileId: e.target.value }))}
                placeholder="uuid"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Status</label>
              <select
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md bg-white"
                value={form.status}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
              >
                {["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Change summary</label>
            <input
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md"
              value={form.changeSummary}
              onChange={(e) => setForm((f) => ({ ...f, changeSummary: e.target.value }))}
              placeholder="What changed in this version"
            />
          </div>
        </div>

        {err && <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">{err}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary text-xs">Cancel</button>
          <button onClick={submit} disabled={submitting || !form.name.trim()} className="btn-primary text-xs">
            {submitting ? "Saving..." : "Save new version"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeriveDialog({
  base, capabilityId, onAuthRequired, onClose, onDone,
}: { base: Agent; capabilityId: string; onAuthRequired: () => void; onClose: () => void; onDone: () => void }) {
  const [name, setName]               = useState(`${base.name.split(" Agent")[0]}-${capabilityId.slice(0, 8)}`);
  const [description, setDescription] = useState(base.description ?? "");
  const [submitting, setSubmitting]   = useState(false);
  const [err, setErr]                 = useState<string | null>(null);

  async function submit() {
    if (!UUID_RE.test(capabilityId)) {
      setErr("Select a valid capability before deriving.");
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      await runtimeApi.deriveTemplate(base.id, { capabilityId, name, description });
      onDone();
    } catch (e) {
      if (isUnauthorized(e)) onAuthRequired();
      const formatted = apiErrorSummary(e);
      setErr(`${formatted.title}: ${formatted.message}${formatted.detail ? ` (${formatted.detail})` : ""}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-5">
        <div className="flex items-start justify-between mb-3">
          <h3 className="text-base font-semibold text-slate-900">Derive from {base.name}</h3>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded"><X size={14} /></button>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Creates a capability-scoped child template (<code className="font-mono">capabilityId={capabilityId.slice(0, 8)}…</code>) inheriting <code>roleType</code>, <code>basePromptProfileId</code>, and <code>defaultToolPolicyId</code> from the base.
        </p>

        <div className="space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Name</label>
            <input
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Description (optional)</label>
            <textarea
              rows={3}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        {err && <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">{err}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary text-xs">Cancel</button>
          <button onClick={submit} disabled={submitting || !name.trim()} className="btn-primary text-xs">
            {submitting ? "Deriving…" : "Derive"}
          </button>
        </div>
      </div>
    </div>
  );
}
