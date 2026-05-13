"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { ApiError, hasAgentToolsToken, identityApi, runtimeApi, saveAgentToolsToken } from "@/lib/api";
import { AlertCircle, Bot, GitBranch, Layers, Lock, ShieldCheck, Sparkles, X } from "lucide-react";

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
  createdAt?: string;
  updatedAt?: string;
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

  useEffect(() => {
    setSignedIn(hasAgentToolsToken());
  }, []);

  const authNeeded = !signedIn || isUnauthorized(error) || isUnauthorized(capabilitiesError);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Agent Studio</h1>
        <p className="text-slate-500 mt-1">
          Common library baselines (locked) + capability-derived agents (editable).
        </p>
      </div>

      {authNeeded && (
        <AgentStudioAuthCard
          onAuthenticated={() => {
            setSignedIn(true);
            mutate();
          }}
        />
      )}

      {/* Capability selector */}
      <div className="card p-3 mb-6">
        <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">
          Capability
        </label>
        <select
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md bg-white"
          value={capabilityId}
          onChange={(e) => { setCapabilityId(e.target.value); setSelected(null); }}
          disabled={capabilitiesLoading}
        >
          <option value="">Common library only</option>
          {capabilities.map((cap) => (
            <option key={cap.id} value={cap.id}>
              {cap.name ?? cap.id}{cap.capabilityType ? ` · ${cap.capabilityType}` : ""}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-slate-400 mt-1">
          Pick a governed capability to see and derive capability-scoped agents. Leave blank to inspect only common baselines.
        </p>
        {selectedCapability && (
          <p className="text-[11px] text-slate-500 mt-1 font-mono">
            {selectedCapability.id}
          </p>
        )}
        {capabilitiesError && <ErrorBanner error={capabilitiesError} compact />}
      </div>

      {!validCapabilitySelected && <ErrorBanner error={new ApiError("Capability id is not a valid UUID.", 400, "INVALID_CAPABILITY")} />}
      {error && <ErrorBanner error={error} />}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: lists */}
        <div className="lg:col-span-2 space-y-8">
          <Section
            icon={GitBranch}
            title={`Capability Agents (${capability.length})`}
            empty={isLoading ? "Loading capability agents..." : capabilityId ? "No derived agents for this capability yet." : "Pick a capability to see derived agents."}
          >
            {!isLoading && capability.map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                selected={selected?.id === a.id}
                onSelect={() => setSelected(a)}
              />
            ))}
          </Section>

          <Section
            icon={ShieldCheck}
            title={`Common Library (${common.length})`}
            empty={isLoading ? "Loading common templates..." : "No common templates available."}
          >
            {!isLoading && common.map((a) => (
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
          <DetailPanel agent={selected} />
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
    <div className={`${compact ? "mt-2" : "mb-4"} p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800 flex gap-2`}>
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
  icon: Icon, title, empty, children,
}: { icon: React.ElementType; title: string; empty: string; children: React.ReactNode }) {
  const arr = Array.isArray(children) ? children : [children];
  return (
    <section>
      <h2 className="text-base font-semibold text-slate-900 mb-3 flex items-center gap-2">
        <Icon size={16} className="text-slate-500" /> {title}
      </h2>
      {arr.length === 0 || (Array.isArray(children) && children.length === 0) ? (
        <p className="text-sm text-slate-400">{empty}</p>
      ) : (
        <div className="space-y-2">{children}</div>
      )}
    </section>
  );
}

function AgentRow({
  agent, selected, onSelect, onDerive,
}: { agent: Agent; selected: boolean; onSelect: () => void; onDerive?: () => void }) {
  const isCommon = !agent.capabilityId;
  const editable = agent.editable ?? !isCommon;
  return (
    <div
      onClick={onSelect}
      className={`card p-3 cursor-pointer transition-colors ${selected ? "border-emerald-400 bg-emerald-50/30" : "hover:border-slate-300"}`}
    >
      <div className="flex items-start gap-3">
        <div className="p-2 bg-slate-50 rounded-lg shrink-0">
          <Bot size={16} className="text-slate-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-slate-900">{agent.name}</span>
            {agent.roleType && (
              <span className="text-[10px] uppercase tracking-wider bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-semibold">
                {agent.roleType}
              </span>
            )}
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
            <p className="text-xs text-slate-500 mt-1 line-clamp-2">{agent.description}</p>
          )}
          <div className="text-[10px] font-mono text-slate-400 mt-1">{agent.id.slice(0, 18)}…</div>
        </div>
        {onDerive && (
          <button
            onClick={(e) => { e.stopPropagation(); onDerive(); }}
            className="btn-secondary text-xs shrink-0"
          >
            Derive →
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
      className={`text-[10px] inline-flex items-center gap-1 border px-1.5 py-0.5 rounded font-semibold ${palette[color]}`}
    >
      {icon}{label}
    </span>
  );
}

function DetailPanel({ agent }: { agent: Agent | null }) {
  const { data: profile, error: profileError, isLoading: profileLoading } = useSWR(
    agent?.basePromptProfileId ? `prompt-profile-${agent.basePromptProfileId}` : null,
    () => runtimeApi.getProfile(agent!.basePromptProfileId!) as Promise<PromptProfile>,
  );

  if (!agent) {
    return (
      <div className="card p-6 text-sm text-slate-400">
        Select an agent to see its lineage, prompt profile, and runtime evidence.
      </div>
    );
  }
  const isCommon = !agent.capabilityId;
  const isLocked = isCommon || Boolean(agent.lockedReason);
  const editable = agent.editable ?? !isCommon;
  return (
    <div className="card p-4 space-y-4 sticky top-4">
      <div>
        <h3 className="text-base font-semibold text-slate-900">{agent.name}</h3>
        <p className="text-xs text-slate-500 mt-1 break-all font-mono">{agent.id}</p>
      </div>

      <Field label="Role">{agent.roleType ?? "—"}</Field>
      <Field label="Status">{agent.status ?? "—"}</Field>
      <Field label="Capability">
        {agent.capabilityId ? (
          <code className="text-xs">{agent.capabilityId}</code>
        ) : (
          <span className="text-amber-700">cross-capability (common library)</span>
        )}
      </Field>
      <Field label="Lineage">
        {agent.baseTemplateId ? (
          <span className="text-blue-700 break-all">derived from <code>{agent.baseTemplateId}</code></span>
        ) : (
          <span className="text-slate-500">root template (no base)</span>
        )}
      </Field>
      <Field label="Prompt profile">
        {agent.basePromptProfileId ? (
          <code className="text-xs break-all">{agent.basePromptProfileId}</code>
        ) : (
          <span className="text-red-700">none</span>
        )}
      </Field>
      <Field label="Lock">
        {isLocked ? (
          <span className="text-amber-700 inline-flex items-center gap-1"><Lock size={11}/> {agent.lockedReason ?? "common platform baseline"}</span>
        ) : (
          <span className="text-emerald-700 inline-flex items-center gap-1"><Sparkles size={11}/> {editable ? "editable by capability owner" : "read-only"}</span>
        )}
      </Field>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1 flex items-center gap-1">
          <Layers size={11} /> Prompt layers
        </div>
        {!agent.basePromptProfileId ? (
          <p className="text-xs text-red-700">No base prompt profile is configured.</p>
        ) : profileLoading ? (
          <p className="text-xs text-slate-400">Loading prompt profile...</p>
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
                  <div key={l.id} className="rounded border border-slate-100 bg-slate-50 px-2 py-1">
                    <div className="text-[11px] font-semibold text-slate-700">
                      {l.priority ?? "—"} · {l.promptLayer?.name ?? l.promptLayer?.id ?? l.id}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {l.promptLayer?.layerType ?? "layer"} · {l.promptLayer?.scopeType ?? "scope"}
                    </div>
                  </div>
                ))
            )}
          </div>
        )}
      </div>

      <Field label="Runtime evidence">
        <span className="text-slate-500">No recent execution evidence is attached to this template yet.</span>
      </Field>

      {agent.description && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Description</div>
          <p className="text-xs text-slate-700 leading-relaxed">{agent.description}</p>
        </div>
      )}

      <div className="text-[11px] text-slate-400 pt-2 border-t border-slate-100">
        created {agent.createdAt ? new Date(agent.createdAt).toLocaleString() : "—"} · updated {agent.updatedAt ? new Date(agent.updatedAt).toLocaleString() : "—"}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">{label}</div>
      <div className="text-sm text-slate-800">{children}</div>
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
