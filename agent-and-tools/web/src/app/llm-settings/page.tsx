"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, RadioTower, RefreshCw, ShieldCheck, WandSparkles, XCircle } from "lucide-react";
import { apiPath, authHeaders, readResponseBody, responseMessage } from "@/lib/api";
import { asBoolean, asRow, asRowArray, asString, asStringArray } from "@/lib/row";
import { CopyButton } from "@/components/ui/CopyButton";

type GatewayResult = {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
  skipped?: boolean;
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
  enabled?: boolean;
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

type DefaultReadiness = {
  ready: boolean;
  label: string;
  warnings: string[];
};

type RuntimeRow = {
  runtime_id?: string;
  device_id?: string;
  runtime_type?: string;
  device_name?: string;
  tenant_id?: string;
  user_id?: string;
  supported_frame_types: string[];
  health: Record<string, unknown>;
  last_seen_at?: number | null;
};

const consumerLabels: Record<string, string> = {
  agentRuntimeUrl: "Agent Runtime URL",
  promptComposerUrl: "Prompt Composer URL",
  contextFabricUrl: "Context Fabric URL",
  eventHorizonModelAlias: "Event Horizon Model Alias",
  legacyEventHorizonProvider: "Legacy Event Horizon Provider",
  legacyEventHorizonModel: "Legacy Event Horizon Model",
};

function asProviderRows(value: unknown): ProviderRow[] {
  return asRowArray(value)
    .map(normalizeProviderRow)
    .filter((item): item is ProviderRow => item !== null);
}

function asModelRows(value: unknown): ModelRow[] {
  return asRowArray(value)
    .map(normalizeModelRow)
    .filter((item): item is ModelRow => item !== null);
}

function normalizeLlmSettings(value: unknown): LlmSettings {
  const row = asRow(value);
  const gatewayUrl = asString(row.gatewayUrl ?? row.gateway_url, "http://localhost:8001");
  const llmGatewayUrl = asString(row.llmGatewayUrl ?? row.llm_gateway_url, gatewayUrl);
  const mcpUrl = asString(row.mcpUrl ?? row.mcp_url, "http://localhost:8090");
  const contextFabricUrl = asString(row.contextFabricUrl ?? row.context_fabric_url, "http://localhost:8000");
  const topology = asRow(row.topology);
  const configuredPaths = asRow(row.configuredPaths ?? row.configured_paths);
  const consumers = asRow(row.consumers);
  return {
    generatedAt: asString(row.generatedAt ?? row.generated_at, new Date().toISOString()),
    gatewayUrl,
    llmGatewayUrl,
    mcpUrl,
    contextFabricUrl,
    authMode: asString(row.authMode ?? row.auth_mode, "unknown"),
    mcpAuthMode: asString(row.mcpAuthMode ?? row.mcp_auth_mode, "unknown"),
    topology: {
      mode: asString(topology.mode, "dial-in-runtime"),
      hub: asString(topology.hub, "context-fabric"),
      llmGateway: asString(topology.llmGateway ?? topology.llm_gateway, "served-through-mcp-runtime"),
      mcpRuntime: asString(topology.mcpRuntime ?? topology.mcp_runtime, "runtime-bridge-websocket"),
      httpFallback: asString(topology.httpFallback ?? topology.http_fallback, "disabled"),
    },
    configuredPaths: {
      providerConfigPath: asString(configuredPaths.providerConfigPath ?? configuredPaths.provider_config_path, "unknown"),
      modelCatalogPath: asString(configuredPaths.modelCatalogPath ?? configuredPaths.model_catalog_path, "unknown"),
    },
    consumers: Object.fromEntries(
      Object.entries(consumers)
        .filter(([key]) => key.length > 0)
        .map(([key, item]) => [key, asString(item) || null])
        .slice(0, 40),
    ),
    health: normalizeGatewayResult(row.health),
    gatewayHealth: normalizeGatewayResult(row.gatewayHealth ?? row.gateway_health),
    mcpHealth: normalizeGatewayResult(row.mcpHealth ?? row.mcp_health),
    contextFabricHealth: normalizeGatewayResult(row.contextFabricHealth ?? row.context_fabric_health),
    runtimeBridgeStatus: normalizeGatewayResult(row.runtimeBridgeStatus ?? row.runtime_bridge_status),
    providers: normalizeGatewayResult(row.providers),
    models: normalizeGatewayResult(row.models),
    workspaceStats: normalizeGatewayResult(row.workspaceStats ?? row.workspace_stats),
  };
}

function normalizeGatewayResult(value: unknown): GatewayResult {
  const row = asRow(value);
  return {
    ok: asBoolean(row.ok),
    status: normalizeOptionalNumber(row.status) ?? undefined,
    data: row.data,
    error: asString(row.error ?? row.message) || undefined,
    skipped: asBoolean(row.skipped),
  };
}

function normalizeProviderRow(value: unknown): ProviderRow | null {
  const row = asRow(value);
  const name = asString(row.name ?? row.provider);
  if (!name) return null;
  return {
    name,
    ready: asBoolean(row.ready),
    allowed: typeof row.allowed === "boolean" ? row.allowed : undefined,
    enabled: typeof row.enabled === "boolean" ? row.enabled : undefined,
    default_model: asString(row.default_model ?? row.defaultModel) || null,
    warnings: asStringArray(row.warnings, 20, 240),
  };
}

function normalizeModelRow(value: unknown): ModelRow | null {
  const row = asRow(value);
  const id = asString(row.id ?? row.alias);
  const provider = asString(row.provider);
  const model = asString(row.model);
  if (!id && !provider && !model) return null;
  return {
    id: id || undefined,
    label: asString(row.label ?? row.name) || undefined,
    provider: provider || undefined,
    model: model || undefined,
    ready: asBoolean(row.ready),
    default: asBoolean(row.default ?? row.isDefault ?? row.is_default),
    supportsTools: asBoolean(row.supportsTools ?? row.supports_tools),
    costTier: asString(row.costTier ?? row.cost_tier) || undefined,
    description: asString(row.description) || undefined,
    warnings: asStringArray(row.warnings, 20, 240),
  };
}

function normalizeRuntimeRows(value: unknown): RuntimeRow[] {
  return asRowArray(value)
    .map((runtime, index): RuntimeRow | null => {
      const runtimeId = asString(runtime.runtime_id ?? runtime.runtimeId ?? runtime.device_id ?? runtime.deviceId);
      const deviceId = asString(runtime.device_id ?? runtime.deviceId);
      if (!runtimeId && !deviceId) return null;
      return {
        runtime_id: runtimeId || undefined,
        device_id: deviceId || undefined,
        runtime_type: asString(runtime.runtime_type ?? runtime.runtimeType, "mcp"),
        device_name: asString(runtime.device_name ?? runtime.deviceName, `runtime-${index + 1}`),
        tenant_id: asString(runtime.tenant_id ?? runtime.tenantId) || undefined,
        user_id: asString(runtime.user_id ?? runtime.userId) || undefined,
        supported_frame_types: asStringArray(runtime.supported_frame_types ?? runtime.supportedFrameTypes, 20, 80),
        health: asRow(runtime.health),
        last_seen_at: normalizeOptionalNumber(runtime.last_seen_at ?? runtime.lastSeenAt),
      };
    })
    .filter((runtime): runtime is RuntimeRow => runtime !== null);
}

function defaultReadiness(
  runtimeHealth: Record<string, unknown>,
  models: ModelRow[],
  defaultAlias: string,
  defaultProvider: string,
  providers: ProviderRow[],
): DefaultReadiness {
  if (typeof runtimeHealth.llm_default_model_ready === "boolean") {
    const warnings = asStringArray(runtimeHealth.llm_default_model_warnings);
    return {
      ready: runtimeHealth.llm_default_model_ready,
      label: defaultAlias,
      warnings,
    };
  }
  const byAlias = models.find(model => model.id === defaultAlias);
  const byDefault = models.find(model => model.default);
  const model = byAlias ?? byDefault;
  if (model) {
    return {
      ready: model.ready !== false,
      label: model.id ?? defaultAlias,
      warnings: model.warnings ?? [],
    };
  }
  const provider = providers.find(row => row.name === defaultProvider);
  return {
    ready: provider?.ready ?? false,
    label: defaultAlias || defaultProvider || "default",
    warnings: provider?.warnings ?? ["Default model alias was not reported."],
  };
}

function statusClass(ok?: boolean) {
  return ok ? "badge-active" : "badge-critical";
}

function normalizeOptionalNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(asString(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function numberValue(value: unknown): number | null {
  return normalizeOptionalNumber(value);
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
  const timestamp = normalizeOptionalNumber(value);
  if (timestamp == null) return "-";
  return new Date(timestamp * 1000).toLocaleString();
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
      setSettings(normalizeLlmSettings(parsed));
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

  const providerData = asRow(settings?.providers.data);
  const modelData = asRow(settings?.models.data);
  const workspaceEnvelope = asRow(settings?.workspaceStats?.data);
  const workspaceData = asRow(workspaceEnvelope.data ?? settings?.workspaceStats?.data);
  const workspaceGc = asRow(workspaceData.gc);
  const runtimeBridgeEnvelope = asRow(settings?.runtimeBridgeStatus?.data);
  const connectedRuntimes = normalizeRuntimeRows(runtimeBridgeEnvelope.connected);
  const runtimeConnected = connectedRuntimes.length > 0;
  const runtimeHealthRows = connectedRuntimes.map(runtime => runtime.health);
  const runtimeProviderRows = runtimeHealthRows.flatMap(health => asProviderRows(health.llm_providers));
  const runtimeModelRows = runtimeHealthRows.flatMap(health => asModelRows(health.llm_models));
  const runtimeProviderHealth = runtimeHealthRows.find(health => asProviderRows(health.llm_providers).length > 0) ?? {};
  const gatewayConfig = asRow(providerData.config);
  const directProviders = asProviderRows(providerData.providers);
  const directModels = asModelRows(modelData.models);
  const providers = runtimeProviderRows.length > 0 ? runtimeProviderRows : directProviders;
  const models = runtimeModelRows.length > 0 ? runtimeModelRows : directModels;
  const providerStatusSource = runtimeProviderRows.length > 0 ? "Runtime Bridge" : "Platform debug gateway";
  const modelStatusSource = runtimeModelRows.length > 0 ? "Runtime Bridge" : "Platform debug gateway";
  const defaultProvider = String(runtimeProviderHealth.llm_default_provider ?? providerData.default_provider ?? "unknown");
  const defaultModelAlias = String(runtimeProviderHealth.llm_default_model_alias ?? modelData.default_model_alias ?? "none");
  const defaultModelReadiness = defaultReadiness(runtimeProviderHealth, models, defaultModelAlias, defaultProvider, providers);
  const readyAliases = asStringArray(runtimeProviderHealth.llm_ready_model_aliases).length
    ? asStringArray(runtimeProviderHealth.llm_ready_model_aliases)
    : models.filter(model => model.ready).map(model => String(model.id)).filter(Boolean);
  const warnings = useMemo(() => [
    ...asStringArray(providerData.warnings),
    ...asStringArray(modelData.warnings),
    ...(defaultModelReadiness.ready ? [] : [`Default model alias ${defaultModelReadiness.label} is not ready${defaultModelReadiness.warnings.length ? `: ${defaultModelReadiness.warnings.join("; ")}` : ""}`]),
    ...(settings?.contextFabricHealth?.ok ? [] : [`Context Fabric health failed: ${settings?.contextFabricHealth?.error ?? settings?.contextFabricHealth?.status ?? "unknown"}`]),
    ...(settings?.runtimeBridgeStatus?.ok ? [] : [`Runtime Bridge status failed: ${settings?.runtimeBridgeStatus?.error ?? settings?.runtimeBridgeStatus?.status ?? "unknown"}`]),
    ...(runtimeConnected ? [] : ["No MCP runtime is currently connected through the Runtime Bridge."]),
    ...(settings?.topology?.httpFallback === "enabled" && !(settings?.mcpHealth?.ok) ? [`MCP HTTP debug probe failed: ${settings?.mcpHealth?.error ?? settings?.mcpHealth?.status ?? "unknown"}`] : []),
    ...(settings?.topology?.httpFallback === "enabled" && !(settings?.gatewayHealth?.ok ?? settings?.health.ok) ? [`LLM Gateway debug probe failed: ${settings?.gatewayHealth?.error ?? settings?.health.error ?? settings?.gatewayHealth?.status ?? settings?.health.status ?? "unknown"}`] : []),
    ...(settings?.providers.ok || runtimeProviderRows.length > 0 ? [] : [`Provider status failed: ${settings?.providers.error ?? settings?.providers.status ?? "unknown"}`]),
    ...(settings?.models.ok || runtimeModelRows.length > 0 ? [] : [`Model catalog failed: ${settings?.models.error ?? settings?.models.status ?? "unknown"}`]),
    ...(settings?.workspaceStats?.ok === false && !settings.workspaceStats.skipped ? [`Workspace stats failed: ${settings.workspaceStats.error ?? settings.workspaceStats.status ?? "unknown"}`] : []),
  ], [defaultModelReadiness, modelData, providerData, runtimeConnected, runtimeModelRows.length, runtimeProviderRows.length, settings]);

  const readyModels = models.filter(model => model.ready).length;
  const readyProviders = providers.filter(provider => provider.ready).length;

  return (
    <div style={{ maxWidth: 1240 }}>
      <section className="page-hero mb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-3 inline-flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
            <RadioTower size={15} className="text-emerald-700" />
            Runtime + LLM Switchboard
          </div>
          <h1 className="page-header text-3xl font-black text-slate-950">Runtime Bridge and Model Routing</h1>
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
      <div className="evidence-rail mt-5">
        {[
          ["Context Fabric", settings?.contextFabricHealth?.ok ? "Online" : "Check"],
          ["Runtime Bridge", runtimeConnected ? `${connectedRuntimes.length} connected` : "No runtime"],
          ["MCP Runtime", "Tool + model relay"],
          ["LLM Gateway", `${readyProviders}/${providers.length || 0} providers`],
          ["Workflows", "model-run frames"],
        ].map(([label, detail]) => (
          <div key={label} className="evidence-step">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-50 text-emerald-700"><RadioTower size={15} /></span>
            <span>
              <strong className="block text-[13px] text-slate-900">{label}</strong>
              <span className="text-[11px] text-slate-500">{detail}</span>
            </span>
          </div>
        ))}
      </div>
      </section>

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
        <SummaryTile icon={Cpu} label="Provider source" value={providerStatusSource} />
        <SummaryTile icon={Cpu} label="Default provider" value={defaultProvider} />
        <SummaryTile icon={defaultModelReadiness.ready ? ShieldCheck : AlertTriangle} label="Default alias" value={defaultModelAlias} tone={defaultModelReadiness.ready ? "ok" : "bad"} />
        <SummaryTile icon={Cpu} label="Ready models" value={`${readyModels}/${models.length || 0}`} />
      </div>

      {!defaultModelReadiness.ready && (
        <section className="card border-red-200 bg-red-50 p-4 mb-6">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 text-red-700" />
            <div>
              <h2 className="text-sm font-bold text-red-900">Default model is not launch-ready</h2>
              <p className="mt-1 text-sm text-red-800">
                `{defaultModelReadiness.label}` is selected as the default, but its provider is not ready. Workflows that use the default alias will fail until the credential/provider is fixed or the default is moved to a ready alias.
              </p>
              {defaultModelReadiness.warnings.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-xs text-red-800">
                  {defaultModelReadiness.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
                </ul>
              )}
              <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
                <CommandBlock
                  label="Switch to a ready alias"
                  command={`bin/mcp-runtime-setup.sh connect --default-provider <ready-provider> --default-model ${readyAliases[0] ?? "mock-fast"}`}
                />
                <CommandBlock
                  label="Keep provider, add credential"
                  command={`bin/mcp-runtime-setup.sh connect --default-provider ${defaultProvider} --default-model ${defaultModelAlias} --${defaultProvider === "anthropic" ? "anthropic-api-key" : defaultProvider === "openai" ? "openai-api-key" : defaultProvider === "openrouter" ? "openrouter-api-key" : defaultProvider === "copilot" ? "copilot-token" : "openai-api-key"} <token>`}
                />
              </div>
              {readyAliases.length > 0 && (
                <p className="mt-2 text-xs text-red-700">Ready aliases now: {readyAliases.slice(0, 8).join(", ")}</p>
              )}
            </div>
          </div>
        </section>
      )}

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
                const health = runtime.health;
                const frames = runtime.supported_frame_types.length ? runtime.supported_frame_types.join(", ") : "-";
                return (
                  <tr key={`${runtime.runtime_id ?? runtime.device_id ?? index}`} className="border-b border-slate-100 last:border-b-0">
                    <td className="px-4 py-2">
                      <div className="font-mono text-xs text-slate-900">{runtime.runtime_id ?? runtime.device_id ?? "-"}</div>
                      <div className="text-xs text-slate-500">{runtime.runtime_type ?? "mcp"} · {runtime.device_name ?? "-"}</div>
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <div>tenant: <span className="font-mono">{runtime.tenant_id ?? "-"}</span></div>
                      <div>user: <span className="font-mono">{runtime.user_id ?? "-"}</span></div>
                    </td>
                    <td className="px-4 py-2 text-xs font-mono">{frames}</td>
                    <td className="px-4 py-2 text-xs">
                      <div>{health.llm_gateway_url_configured ? "local gateway configured" : "gateway not reported"}</div>
                      {Array.isArray(health.llm_providers) && (
                        <div className="text-slate-500">
                          {asProviderRows(health.llm_providers).filter(provider => provider.ready).length}/{asProviderRows(health.llm_providers).length} providers ready
                        </div>
                      )}
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
            command={"bin/mcp-runtime-setup.sh\n# choose copilot, anthropic, openai-compatible, mock, or disabled\nsource .env.local\ncurl -s -H \"X-Service-Token: $CONTEXT_FABRIC_SERVICE_TOKEN\" http://localhost:8000/api/runtime-bridge/status | jq"}
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
          <Field label="Provider status source" value={providerStatusSource} />
          <Field label="Model status source" value={modelStatusSource} />
        </div>
      </section>

      <section className="card p-5 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">MCP Workspace Storage</h2>
            <p className="text-sm text-slate-500">Managed work-item workspaces and source-cache usage reported by MCP.</p>
          </div>
          <span className={`badge ${statusClass(settings?.workspaceStats?.ok !== false)}`}>{settings?.workspaceStats?.skipped ? "bridge mode" : settings?.workspaceStats?.ok === false ? "unavailable" : "reported"}</span>
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
        {settings?.workspaceStats?.skipped && (
          <p className="mt-4 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3">
            Direct MCP HTTP diagnostics are disabled. Runtime health is shown through the Runtime Bridge; workspace storage stats become available when MCP HTTP debug probing is explicitly enabled.
          </p>
        )}
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
          <p className="text-sm text-slate-500">
            Showing {providerStatusSource}. Non-mock providers are ready only when explicitly allowed, configured with a base URL, and backed by a credential.
          </p>
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
                  <td className="px-4 py-2">{provider.allowed === undefined ? (provider.enabled === false ? "No" : "Yes") : provider.allowed ? "Yes" : "No"}</td>
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
          <p className="text-sm text-slate-500">Showing {modelStatusSource}. Workflows and agents should pass aliases. Raw provider/model overrides stay out of normal execution.</p>
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
                  {["free", "low", "medium", "standard", "high"].map(t => <option key={t} value={t}>{t}</option>)}
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
      <div className="rounded-md border border-slate-800 bg-slate-950 p-2 text-slate-50">
        <div className="flex items-start justify-between gap-2">
          <pre className="overflow-x-auto whitespace-pre-wrap text-xs leading-5"><code>{command}</code></pre>
          <CopyButton text={command} label={`Copy ${label}`} />
        </div>
      </div>
    </div>
  );
}
