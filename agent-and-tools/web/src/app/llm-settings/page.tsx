"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, RadioTower, RefreshCw, ShieldCheck, WandSparkles, XCircle } from "lucide-react";
import { apiPath, authHeaders, readResponseBody, responseMessage } from "@/lib/api";

type GatewayResult = {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
};

type LlmSettings = {
  generatedAt: string;
  gatewayUrl: string;
  llmGatewayUrl?: string;
  mcpUrl: string;
  contextFabricUrl: string;
  authMode: string;
  mcpAuthMode: string;
  topology?: {
    mode: string;
    hub: string;
    llmGateway: string;
    mcpRuntime: string;
    httpFallback?: string;
  };
  configuredPaths: {
    providerConfigPath: string;
    modelCatalogPath: string;
  };
  consumers: Record<string, string | null>;
  health: GatewayResult;
  gatewayHealth?: GatewayResult;
  mcpHealth?: GatewayResult;
  contextFabricHealth?: GatewayResult;
  runtimeBridgeStatus?: GatewayResult;
  providers: GatewayResult;
  models: GatewayResult;
  workspaceStats?: GatewayResult;
};

type ProviderRow = {
  name: string;
  ready?: boolean;
  allowed?: boolean;
  default_model?: string | null;
  warnings?: string[];
};

type ModelRow = {
  id?: string;
  label?: string;
  provider?: string;
  model?: string;
  ready?: boolean;
  default?: boolean;
  supportsTools?: boolean;
  costTier?: string;
  description?: string;
  warnings?: string[];
};

const consumerLabels: Record<string, string> = {
  agentRuntimeUrl: "Agent Runtime URL",
  promptComposerUrl: "Prompt Composer URL",
  contextFabricUrl: "Context Fabric URL",
  eventHorizonModelAlias: "Event Horizon Model Alias",
  legacyEventHorizonProvider: "Legacy Event Horizon Provider",
  legacyEventHorizonModel: "Legacy Event Horizon Model",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function statusClass(ok?: boolean) {
  return ok ? "badge-active" : "badge-critical";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatBytes(value: unknown): string {
  const bytes = numberValue(value);
  if (bytes == null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let next = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && next >= 1024; i += 1) {
    next /= 1024;
    unit = units[i];
  }
  return `${next.toFixed(next >= 10 ? 1 : 2)} ${unit}`;
}

function formatPercent(value: unknown): string {
  const pct = numberValue(value);
  return pct == null ? "No quota" : `${pct.toFixed(1)}%`;
}

function formatTimestamp(value: unknown): string {
  if (typeof value !== "number") return "-";
  return new Date(value * 1000).toLocaleString();
}

export default function LlmSettingsPage() {
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiPath("/api/llm-settings"), { cache: "no-store", headers: authHeaders() });
      const { raw, parsed } = await readResponseBody(res);
      if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
      if (!parsed || typeof parsed !== "object") throw new Error(raw ? raw.slice(0, 400) : "Empty LLM settings response");
      const data = parsed as LlmSettings;
      setSettings(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load LLM settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // ── Add / remove models (writes persist to .singularity/llm-models.json) ──
  const blankForm = { id: "", provider: "anthropic", model: "", label: "", maxOutputTokens: "", costTier: "medium", supportsTools: true, isDefault: false, description: "", inputPricePerMtok: "", outputPricePerMtok: "" };
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ ...blankForm });
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function submitModel() {
    setSaveBusy(true);
    setSaveError(null);
    try {
      const num = (v: string) => (v.trim() ? Number(v) : undefined);
      const payload: Record<string, unknown> = {
        id: form.id.trim(),
        provider: form.provider,
        model: form.model.trim(),
        label: form.label.trim() || undefined,
        maxOutputTokens: num(form.maxOutputTokens),
        costTier: form.costTier || undefined,
        supportsTools: form.supportsTools,
        default: form.isDefault || undefined,
        description: form.description.trim() || undefined,
        inputPricePerMtok: num(form.inputPricePerMtok),
        outputPricePerMtok: num(form.outputPricePerMtok),
      };
      const res = await fetch(apiPath("/api/llm-settings/models"), {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify(payload),
      });
      const { raw, parsed } = await readResponseBody(res);
      if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
      setForm({ ...blankForm, provider: form.provider });
      setAdding(false);
      await load();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to add model");
    } finally {
      setSaveBusy(false);
    }
  }

  async function deleteModel(id: string) {
    if (!window.confirm(`Remove model "${id}" from the catalog?`)) return;
    setSaveError(null);
    try {
      const res = await fetch(apiPath(`/api/llm-settings/models?id=${encodeURIComponent(id)}`), { method: "DELETE", headers: authHeaders() });
      const { raw, parsed } = await readResponseBody(res);
      if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
      await load();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to delete model");
    }
  }

  const providerData = asRecord(settings?.providers.data);
  const modelData = asRecord(settings?.models.data);
  const workspaceEnvelope = asRecord(settings?.workspaceStats?.data);
  const workspaceData = asRecord(workspaceEnvelope.data ?? settings?.workspaceStats?.data);
  const workspaceGc = asRecord(workspaceData.gc);
  const runtimeBridgeEnvelope = asRecord(settings?.runtimeBridgeStatus?.data);
  const connectedRuntimes = Array.isArray(runtimeBridgeEnvelope.connected)
    ? runtimeBridgeEnvelope.connected as Record<string, unknown>[]
    : [];
  const runtimeConnected = connectedRuntimes.length > 0;
  const gatewayConfig = asRecord(providerData.config);
  const providers = Array.isArray(providerData.providers) ? providerData.providers as ProviderRow[] : [];
  const models = Array.isArray(modelData.models) ? modelData.models as ModelRow[] : [];
  const defaultProvider = String(providerData.default_provider ?? "unknown");
  const defaultModelAlias = String(providerData.default_model_alias ?? modelData.default_model_alias ?? "none");
  const warnings = useMemo(() => [
    ...asStringArray(providerData.warnings),
    ...asStringArray(modelData.warnings),
    ...(settings?.contextFabricHealth?.ok ? [] : [`Context Fabric health failed: ${settings?.contextFabricHealth?.error ?? settings?.contextFabricHealth?.status ?? "unknown"}`]),
    ...(settings?.runtimeBridgeStatus?.ok ? [] : [`Runtime Bridge status failed: ${settings?.runtimeBridgeStatus?.error ?? settings?.runtimeBridgeStatus?.status ?? "unknown"}`]),
    ...(runtimeConnected ? [] : ["No MCP runtime is currently connected through the Runtime Bridge."]),
    ...(settings?.topology?.httpFallback === "enabled" && !(settings?.mcpHealth?.ok) ? [`MCP HTTP debug probe failed: ${settings?.mcpHealth?.error ?? settings?.mcpHealth?.status ?? "unknown"}`] : []),
    ...(settings?.topology?.httpFallback === "enabled" && !(settings?.gatewayHealth?.ok ?? settings?.health.ok) ? [`LLM Gateway debug probe failed: ${settings?.gatewayHealth?.error ?? settings?.health.error ?? settings?.gatewayHealth?.status ?? settings?.health.status ?? "unknown"}`] : []),
    ...(settings?.providers.ok ? [] : [`Provider status failed: ${settings?.providers.error ?? settings?.providers.status ?? "unknown"}`]),
    ...(settings?.models.ok ? [] : [`Model catalog failed: ${settings?.models.error ?? settings?.models.status ?? "unknown"}`]),
    ...(settings?.workspaceStats?.ok === false ? [`Workspace stats failed: ${settings.workspaceStats.error ?? settings.workspaceStats.status ?? "unknown"}`] : []),
  ], [modelData, providerData, runtimeConnected, settings]);

  const readyModels = models.filter(model => model.ready).length;
  const readyProviders = providers.filter(provider => provider.ready).length;

  return (
    <div style={{ maxWidth: 1240 }}>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-header">Active LLM Settings</h1>
          <p className="text-sm text-slate-500 mt-1">
            MCP runtimes dial into Context Fabric over the Runtime Bridge. Model calls run as `model-run` frames through MCP, which forwards to its local or colocated LLM Gateway.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="btn-primary" href="/prompt-workbench">
            <WandSparkles size={15} />
            Test model in Prompt Workbench
          </Link>
          <button className="btn-secondary" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="card border-red-200 bg-red-50 p-4 mb-6 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-6">
        <SummaryTile icon={settings?.contextFabricHealth?.ok ? CheckCircle2 : XCircle} label="Context Fabric" value={settings?.contextFabricHealth?.ok ? "Online" : "Check"} tone={settings?.contextFabricHealth?.ok ? "ok" : "bad"} />
        <SummaryTile icon={runtimeConnected ? RadioTower : XCircle} label="Runtime Bridge" value={runtimeConnected ? `${connectedRuntimes.length} connected` : "No runtime"} tone={runtimeConnected ? "ok" : "bad"} />
        <SummaryTile icon={Cpu} label="LLM path" value="MCP model-run" />
        <SummaryTile icon={ShieldCheck} label="HTTP fallback" value={settings?.topology?.httpFallback ?? "disabled"} tone={settings?.topology?.httpFallback === "enabled" ? "warn" : "ok"} />
        <SummaryTile icon={Cpu} label="Default provider" value={defaultProvider} />
        <SummaryTile icon={ShieldCheck} label="Default alias" value={defaultModelAlias} />
        <SummaryTile icon={Cpu} label="Ready models" value={`${readyModels}/${models.length || 0}`} />
      </div>

      <section className="card overflow-hidden mb-6">
        <div className="p-4 border-b border-slate-200 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Runtime Bridge</h2>
            <p className="text-sm text-slate-500">Connected MCP runtimes and the frames Context Fabric can dispatch to them.</p>
          </div>
          <span className={`badge ${statusClass(runtimeConnected)}`}>{runtimeConnected ? "connected" : "waiting"}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-2 text-left">Runtime</th>
                <th className="px-4 py-2 text-left">Owner</th>
                <th className="px-4 py-2 text-left">Frames</th>
                <th className="px-4 py-2 text-left">LLM</th>
                <th className="px-4 py-2 text-left">Last heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {connectedRuntimes.map((runtime, index) => {
                const health = asRecord(runtime.health);
                const frames = Array.isArray(runtime.supported_frame_types) ? runtime.supported_frame_types.map(String).join(", ") : "-";
                return (
                  <tr key={`${runtime.runtime_id ?? runtime.device_id ?? index}`} className="border-b border-slate-100 last:border-b-0">
                    <td className="px-4 py-2">
                      <div className="font-mono text-xs text-slate-900">{String(runtime.runtime_id ?? runtime.device_id ?? "-")}</div>
                      <div className="text-xs text-slate-500">{String(runtime.runtime_type ?? "mcp")} · {String(runtime.device_name ?? "-")}</div>
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <div>tenant: <span className="font-mono">{String(runtime.tenant_id ?? "-")}</span></div>
                      <div>user: <span className="font-mono">{String(runtime.user_id ?? "-")}</span></div>
                    </td>
                    <td className="px-4 py-2 text-xs font-mono">{frames}</td>
                    <td className="px-4 py-2 text-xs">
                      {health.llm_gateway_url_configured ? "local gateway configured" : "gateway not reported"}
                    </td>
                    <td className="px-4 py-2 text-xs">{formatTimestamp(runtime.last_seen_at)}</td>
                  </tr>
                );
              })}
              {connectedRuntimes.length === 0 && (
                <tr><td className="px-4 py-4 text-slate-400" colSpan={5}>No MCP runtime has dialed in yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-5 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Runtime Setup Commands</h2>
            <p className="text-sm text-slate-500">Use this split when Platform runs on a server and MCP plus the local LLM Gateway run from a laptop or remote worker.</p>
          </div>
          <span className="badge badge-pending_approval">copy commands</span>
        </div>
        <div className="grid md:grid-cols-2 gap-3 text-sm">
          <CommandBlock
            label="Terminal 1: platform services"
            command={"git pull --ff-only\nbin/setup.sh --yes\nbin/bare-metal-apps.sh smoke"}
          />
          <CommandBlock
            label="Terminal 2: MCP + LLM runtime"
            command={"bin/mcp-runtime-setup.sh\n# choose copilot, anthropic, openai-compatible, mock, or disabled\ncurl -s http://localhost:8000/api/runtime-bridge/status | jq"}
          />
          <CommandBlock
            label="Copilot runtime mode"
            command={"export LLM_PROVIDER=copilot\nexport GITHUB_TOKEN=<github_pat_or_copilot_ready_token>\nbin/bare-metal-runtime.sh up"}
          />
          <CommandBlock
            label="OpenAI-compatible or Anthropic"
            command={"export LLM_PROVIDER=openai\nexport OPENAI_API_KEY=<key>\nexport OPENAI_BASE_URL=https://api.openai.com/v1\n# or: export LLM_PROVIDER=anthropic && export ANTHROPIC_API_KEY=<key>\nbin/bare-metal-runtime.sh up"}
          />
        </div>
      </section>

      <section className="card p-5 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Dial-in Runtime Topology</h2>
            <p className="text-sm text-slate-500">Context Fabric routes governed execution through connected MCP runtimes. Direct URLs below are diagnostic/debug fallback surfaces.</p>
          </div>
          <span className={`badge ${statusClass(Boolean(settings?.contextFabricHealth?.ok && runtimeConnected))}`}>
            {settings?.topology?.mode ?? "dial-in-runtime"}
          </span>
        </div>
        <div className="grid md:grid-cols-3 gap-3 text-sm mb-4">
          <Field label="Context Fabric hub" value={settings?.contextFabricUrl ?? "loading"} mono />
          <Field label="Runtime bridge" value="/api/runtime-bridge/connect" mono />
          <Field label="LLM serving" value={settings?.topology?.llmGateway ?? "served-through-mcp-runtime"} />
          <Field label="LLM debug URL" value={settings?.llmGatewayUrl ?? settings?.gatewayUrl ?? "loading"} mono />
          <Field label="MCP debug URL" value={settings?.mcpUrl ?? "loading"} mono />
          <Field label="Debug auth" value={`LLM ${settings?.authMode ?? "unknown"} · MCP ${settings?.mcpAuthMode ?? "unknown"}`} />
          <Field label="Runtime mode" value={settings?.topology?.mode ?? "dial-in-runtime"} />
        </div>
        <div className="grid md:grid-cols-2 gap-3 text-sm">
          <Field label="Provider config" value={String(gatewayConfig.provider_config_path ?? settings?.configuredPaths.providerConfigPath ?? "unknown")} mono />
          <Field label="Model catalog" value={String(gatewayConfig.model_catalog_path ?? settings?.configuredPaths.modelCatalogPath ?? "unknown")} mono />
          <Field label="Caller provider override" value={String(gatewayConfig.allow_caller_provider_override ?? "unknown")} />
          <Field label="Timeout seconds" value={String(gatewayConfig.upstream_timeout_sec ?? "unknown")} />
        </div>
      </section>

      <section className="card p-5 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">MCP Workspace Storage</h2>
            <p className="text-sm text-slate-500">Managed work-item workspaces and source-cache usage reported by MCP.</p>
          </div>
          <span className={`badge ${statusClass(settings?.workspaceStats?.ok !== false)}`}>{settings?.workspaceStats?.ok === false ? "unavailable" : "reported"}</span>
        </div>
        <div className="grid md:grid-cols-4 gap-3 text-sm mb-4">
          <Field label="Managed bytes" value={formatBytes(workspaceData.totalManagedBytes)} />
          <Field label="Workspaces" value={String(workspaceData.workItemWorkspaceCount ?? "-")} />
          <Field label="Quota used" value={formatPercent(workspaceData.quotaUsedPercent)} />
          <Field label="GC" value={workspaceGc.enabled === true ? "enabled" : workspaceGc.enabled === false ? "disabled" : "unknown"} />
        </div>
        <div className="grid md:grid-cols-2 gap-3 text-sm">
          <Field label="Work item root" value={String(workspaceData.workItemWorkspacesRoot ?? "-")} mono />
          <Field label="Source cache root" value={String(workspaceData.sourceCacheRoot ?? "-")} mono />
          <Field label="Work item bytes" value={formatBytes(workspaceData.workItemBytes)} />
          <Field label="Source cache bytes" value={formatBytes(workspaceData.sourceCacheBytes)} />
        </div>
        {numberValue(workspaceData.quotaUsedPercent) != null && numberValue(workspaceData.quotaUsedPercent)! >= 80 && (
          <p className="mt-4 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
            MCP workspace storage is above 80% of the configured quota. Shorten the GC age or increase `MCP_WORKSPACE_DISK_QUOTA_BYTES`.
          </p>
        )}
      </section>

      {warnings.length > 0 && (
        <section className="card border-amber-200 bg-amber-50 p-4 mb-6">
          <div className="flex items-center gap-2 text-amber-800 font-semibold mb-2">
            <AlertTriangle size={16} /> Runtime warnings
          </div>
          <ul className="list-disc pl-5 text-sm text-amber-800 space-y-1">
            {warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
          </ul>
        </section>
      )}

      <section className="card overflow-hidden mb-6">
        <div className="p-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900">Providers</h2>
          <p className="text-sm text-slate-500">Non-mock providers are ready only when explicitly allowed, configured with a base URL, and backed by a credential.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-2 text-left">Provider</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Allowed</th>
                <th className="px-4 py-2 text-left">Default model</th>
                <th className="px-4 py-2 text-left">Warnings</th>
              </tr>
            </thead>
            <tbody>
              {providers.map(provider => (
                <tr key={provider.name} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-4 py-2 font-mono">{provider.name}</td>
                  <td className="px-4 py-2"><span className={`badge ${statusClass(provider.ready)}`}>{provider.ready ? "ready" : "not ready"}</span></td>
                  <td className="px-4 py-2">{provider.allowed ? "Yes" : "No"}</td>
                  <td className="px-4 py-2 font-mono text-xs">{provider.default_model ?? "-"}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{(provider.warnings ?? []).join("; ") || "-"}</td>
                </tr>
              ))}
              {providers.length === 0 && (
                <tr><td className="px-4 py-4 text-slate-400" colSpan={5}>No provider status returned.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card overflow-hidden mb-6">
        <div className="p-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900">Approved Model Aliases</h2>
          <p className="text-sm text-slate-500">Workflows and agents should pass aliases. Raw provider/model overrides stay out of normal execution.</p>
        </div>
        <div className="mb-4 flex items-center justify-between gap-3">
          <span className="text-xs text-slate-500">New models persist to <code className="font-mono">.singularity/llm-models.json</code> and reload live.</span>
          <button className="btn-secondary" onClick={() => { setSaveError(null); setAdding(a => !a); }}>{adding ? "Cancel" : "+ Add model"}</button>
        </div>
        {adding && (
          <div className="mb-4 rounded border border-slate-200 bg-slate-50 p-4">
            <div className="grid md:grid-cols-3 gap-3 text-sm">
              <label className="flex flex-col gap-1"><span className="text-xs text-slate-500">Alias (id) *</span>
                <input className="border rounded px-2 py-1 font-mono" value={form.id} onChange={e => setForm(f => ({ ...f, id: e.target.value }))} placeholder="claude-sonnet-4-6" /></label>
              <label className="flex flex-col gap-1"><span className="text-xs text-slate-500">Provider *</span>
                <select className="border rounded px-2 py-1" value={form.provider} onChange={e => setForm(f => ({ ...f, provider: e.target.value }))}>
                  {(providers.length ? providers.map(p => p.name) : ["anthropic", "openai", "openrouter", "copilot", "mock"]).map(n => <option key={n} value={n}>{n}</option>)}
                </select></label>
              <label className="flex flex-col gap-1"><span className="text-xs text-slate-500">Provider model id *</span>
                <input className="border rounded px-2 py-1 font-mono" value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} placeholder="claude-sonnet-4-6-20250930" /></label>
              <label className="flex flex-col gap-1"><span className="text-xs text-slate-500">Label</span>
                <input className="border rounded px-2 py-1" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="Claude Sonnet 4.6" /></label>
              <label className="flex flex-col gap-1"><span className="text-xs text-slate-500">Max output tokens</span>
                <input className="border rounded px-2 py-1" type="number" value={form.maxOutputTokens} onChange={e => setForm(f => ({ ...f, maxOutputTokens: e.target.value }))} placeholder="8000" /></label>
              <label className="flex flex-col gap-1"><span className="text-xs text-slate-500">Cost tier</span>
                <select className="border rounded px-2 py-1" value={form.costTier} onChange={e => setForm(f => ({ ...f, costTier: e.target.value }))}>
                  {["low", "medium", "high", "free"].map(t => <option key={t} value={t}>{t}</option>)}
                </select></label>
              <label className="flex flex-col gap-1"><span className="text-xs text-slate-500">Input $/Mtok</span>
                <input className="border rounded px-2 py-1" type="number" step="0.01" value={form.inputPricePerMtok} onChange={e => setForm(f => ({ ...f, inputPricePerMtok: e.target.value }))} placeholder="3.0" /></label>
              <label className="flex flex-col gap-1"><span className="text-xs text-slate-500">Output $/Mtok</span>
                <input className="border rounded px-2 py-1" type="number" step="0.01" value={form.outputPricePerMtok} onChange={e => setForm(f => ({ ...f, outputPricePerMtok: e.target.value }))} placeholder="15.0" /></label>
              <label className="flex flex-col gap-1 md:col-span-3"><span className="text-xs text-slate-500">Description</span>
                <input className="border rounded px-2 py-1" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></label>
            </div>
            <div className="mt-3 flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.supportsTools} onChange={e => setForm(f => ({ ...f, supportsTools: e.target.checked }))} /> Supports tools</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isDefault} onChange={e => setForm(f => ({ ...f, isDefault: e.target.checked }))} /> Set as default</label>
              <button className="btn-primary ml-auto" disabled={saveBusy || !form.id.trim() || !form.model.trim()} onClick={() => void submitModel()}>{saveBusy ? "Saving…" : "Add model"}</button>
            </div>
          </div>
        )}
        {saveError && <p className="mb-3 text-sm text-red-600">{saveError}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-2 text-left">Alias</th>
                <th className="px-4 py-2 text-left">Provider</th>
                <th className="px-4 py-2 text-left">Model</th>
                <th className="px-4 py-2 text-left">Ready</th>
                <th className="px-4 py-2 text-left">Tools</th>
                <th className="px-4 py-2 text-left">Cost tier</th>
                <th className="px-4 py-2 text-left">Warnings</th>
                <th className="px-4 py-2 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {models.map(model => (
                <tr key={model.id ?? `${model.provider}-${model.model}`} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-4 py-2">
                    <div className="font-mono text-xs text-slate-900">{model.id ?? "-"}</div>
                    <div className="text-xs text-slate-500">{model.label ?? ""}{model.default ? " · default" : ""}</div>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{model.provider ?? "-"}</td>
                  <td className="px-4 py-2 font-mono text-xs">{model.model ?? "-"}</td>
                  <td className="px-4 py-2"><span className={`badge ${statusClass(model.ready)}`}>{model.ready ? "ready" : "blocked"}</span></td>
                  <td className="px-4 py-2">{model.supportsTools ? "Yes" : "No"}</td>
                  <td className="px-4 py-2">{model.costTier ?? "-"}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{(model.warnings ?? []).join("; ") || "-"}</td>
                  <td className="px-4 py-2">{model.id && <button className="text-xs text-red-600 hover:underline" onClick={() => void deleteModel(model.id!)}>Remove</button>}</td>
                </tr>
              ))}
              {models.length === 0 && (
                <tr><td className="px-4 py-4 text-slate-400" colSpan={8}>No model aliases returned. Gateway will only allow mock fallback if configured that way.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="text-lg font-semibold text-slate-900 mb-3">Consumers</h2>
        <div className="grid md:grid-cols-3 gap-3 text-sm mb-4">
          <Field label="Hub" value="Context Fabric governs calls" />
          <Field label="Model path" value="Context Fabric -> Runtime Bridge -> MCP -> LLM Gateway" />
          <Field label="Tool path" value="Context Fabric -> Runtime Bridge -> MCP Runtime" />
        </div>
        <div className="grid md:grid-cols-2 gap-3 text-sm">
          {Object.entries(settings?.consumers ?? {}).map(([key, value]) => (
            <Field key={key} label={consumerLabels[key] ?? key} value={value ?? "-"} mono={key.toLowerCase().includes("url")} />
          ))}
        </div>
        {(settings?.consumers.legacyEventHorizonProvider || settings?.consumers.legacyEventHorizonModel) && (
          <p className="mt-4 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
            Event Horizon raw provider/model env vars are set. For the hardened single-gateway posture, keep these empty and route through Context Fabric / LLM Gateway aliases.
          </p>
        )}
      </section>
    </div>
  );
}

function SummaryTile({ icon: Icon, label, value, tone = "neutral" }: { icon: React.ElementType; label: string; value: string; tone?: "ok" | "bad" | "warn" | "neutral" }) {
  const color = tone === "ok" ? "text-emerald-700" : tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : "text-slate-900";
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-slate-500">
        <Icon size={13} /> {label}
      </div>
      <div className={`mt-2 text-lg font-bold ${color}`}>{value}</div>
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{label}</div>
      <div className={`${mono ? "font-mono text-xs" : "text-sm"} text-slate-800 break-all`}>{value}</div>
    </div>
  );
}

function CommandBlock({ label, command }: { label: string; command: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">{label}</div>
      <pre className="overflow-x-auto rounded-md border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-800"><code>{command}</code></pre>
    </div>
  );
}
