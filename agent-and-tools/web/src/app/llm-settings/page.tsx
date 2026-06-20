"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, RefreshCw, ShieldCheck, WandSparkles, XCircle } from "lucide-react";
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

  const providerData = asRecord(settings?.providers.data);
  const modelData = asRecord(settings?.models.data);
  const workspaceEnvelope = asRecord(settings?.workspaceStats?.data);
  const workspaceData = asRecord(workspaceEnvelope.data ?? settings?.workspaceStats?.data);
  const workspaceGc = asRecord(workspaceData.gc);
  const gatewayConfig = asRecord(providerData.config);
  const providers = Array.isArray(providerData.providers) ? providerData.providers as ProviderRow[] : [];
  const models = Array.isArray(modelData.models) ? modelData.models as ModelRow[] : [];
  const defaultProvider = String(providerData.default_provider ?? "unknown");
  const defaultModelAlias = String(providerData.default_model_alias ?? modelData.default_model_alias ?? "none");
  const warnings = useMemo(() => [
    ...asStringArray(providerData.warnings),
    ...asStringArray(modelData.warnings),
    ...(settings?.gatewayHealth?.ok ?? settings?.health.ok ? [] : [`LLM Gateway health failed: ${settings?.gatewayHealth?.error ?? settings?.health.error ?? settings?.gatewayHealth?.status ?? settings?.health.status ?? "unknown"}`]),
    ...(settings?.mcpHealth?.ok ? [] : [`MCP runtime health failed: ${settings?.mcpHealth?.error ?? settings?.mcpHealth?.status ?? "unknown"}`]),
    ...(settings?.contextFabricHealth?.ok ? [] : [`Context Fabric health failed: ${settings?.contextFabricHealth?.error ?? settings?.contextFabricHealth?.status ?? "unknown"}`]),
    ...(settings?.providers.ok ? [] : [`Provider status failed: ${settings?.providers.error ?? settings?.providers.status ?? "unknown"}`]),
    ...(settings?.models.ok ? [] : [`Model catalog failed: ${settings?.models.error ?? settings?.models.status ?? "unknown"}`]),
    ...(settings?.workspaceStats?.ok === false ? [`Workspace stats failed: ${settings.workspaceStats.error ?? settings.workspaceStats.status ?? "unknown"}`] : []),
  ], [modelData, providerData, settings]);

  const readyModels = models.filter(model => model.ready).length;
  const readyProviders = providers.filter(provider => provider.ready).length;

  return (
    <div style={{ maxWidth: 1240 }}>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-header">Active LLM Settings</h1>
          <p className="text-sm text-slate-500 mt-1">
            LLM Gateway and MCP are independent runtime containers or remote services. Context Fabric is the governed hub that routes model calls through the gateway and tool/workspace calls through MCP.
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
        <SummaryTile icon={(settings?.gatewayHealth?.ok ?? settings?.health.ok) ? CheckCircle2 : XCircle} label="LLM Gateway" value={(settings?.gatewayHealth?.ok ?? settings?.health.ok) ? "Online" : "Offline"} tone={(settings?.gatewayHealth?.ok ?? settings?.health.ok) ? "ok" : "bad"} />
        <SummaryTile icon={settings?.mcpHealth?.ok ? CheckCircle2 : XCircle} label="MCP Runtime" value={settings?.mcpHealth?.ok ? "Online" : "Offline"} tone={settings?.mcpHealth?.ok ? "ok" : "bad"} />
        <SummaryTile icon={Cpu} label="Default provider" value={defaultProvider} />
        <SummaryTile icon={ShieldCheck} label="Default alias" value={defaultModelAlias} />
        <SummaryTile icon={Cpu} label="Ready models" value={`${readyModels}/${models.length || 0}`} />
      </div>

      <section className="card p-5 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Dial-in Runtime Topology</h2>
            <p className="text-sm text-slate-500">Provider calls, workspace tools, and governed orchestration stay on separate runtime boundaries.</p>
          </div>
          <span className={`badge ${statusClass(Boolean(settings?.contextFabricHealth?.ok && (settings?.gatewayHealth?.ok ?? settings?.health.ok) && settings?.mcpHealth?.ok))}`}>
            {settings?.topology?.mode ?? "dial-in-runtime"}
          </span>
        </div>
        <div className="grid md:grid-cols-3 gap-3 text-sm mb-4">
          <Field label="Context Fabric hub" value={settings?.contextFabricUrl ?? "loading"} mono />
          <Field label="LLM_GATEWAY_URL" value={settings?.llmGatewayUrl ?? settings?.gatewayUrl ?? "loading"} mono />
          <Field label="MCP_SERVER_URL" value={settings?.mcpUrl ?? "loading"} mono />
          <Field label="LLM Gateway auth" value={settings?.authMode ?? "unknown"} />
          <Field label="MCP auth" value={settings?.mcpAuthMode ?? "unknown"} />
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
                </tr>
              ))}
              {models.length === 0 && (
                <tr><td className="px-4 py-4 text-slate-400" colSpan={7}>No model aliases returned. Gateway will only allow mock fallback if configured that way.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="text-lg font-semibold text-slate-900 mb-3">Consumers</h2>
        <div className="grid md:grid-cols-3 gap-3 text-sm mb-4">
          <Field label="Hub" value="Context Fabric governs calls" />
          <Field label="Model path" value="Context Fabric -> LLM Gateway" />
          <Field label="Tool path" value="Context Fabric -> MCP Runtime" />
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

function SummaryTile({ icon: Icon, label, value, tone = "neutral" }: { icon: React.ElementType; label: string; value: string; tone?: "ok" | "bad" | "neutral" }) {
  const color = tone === "ok" ? "text-emerald-700" : tone === "bad" ? "text-red-700" : "text-slate-900";
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
