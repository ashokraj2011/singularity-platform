"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, RefreshCw, ShieldCheck, XCircle } from "lucide-react";

type GatewayResult = {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
};

type LlmSettings = {
  generatedAt: string;
  gatewayUrl: string;
  authMode: string;
  configuredPaths: {
    providerConfigPath: string;
    modelCatalogPath: string;
  };
  consumers: Record<string, string | null>;
  health: GatewayResult;
  providers: GatewayResult;
  models: GatewayResult;
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function statusClass(ok?: boolean) {
  return ok ? "badge-active" : "badge-critical";
}

export default function LlmSettingsPage() {
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/llm-settings", { cache: "no-store" });
      const data = await res.json() as LlmSettings;
      if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 400));
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
  const gatewayConfig = asRecord(providerData.config);
  const providers = Array.isArray(providerData.providers) ? providerData.providers as ProviderRow[] : [];
  const models = Array.isArray(modelData.models) ? modelData.models as ModelRow[] : [];
  const defaultProvider = String(providerData.default_provider ?? "unknown");
  const defaultModelAlias = String(providerData.default_model_alias ?? modelData.default_model_alias ?? "none");
  const warnings = useMemo(() => [
    ...asStringArray(providerData.warnings),
    ...asStringArray(modelData.warnings),
    ...(settings?.health.ok ? [] : [`Gateway health failed: ${settings?.health.error ?? settings?.health.status ?? "unknown"}`]),
    ...(settings?.providers.ok ? [] : [`Provider status failed: ${settings?.providers.error ?? settings?.providers.status ?? "unknown"}`]),
    ...(settings?.models.ok ? [] : [`Model catalog failed: ${settings?.models.error ?? settings?.models.status ?? "unknown"}`]),
  ], [modelData, providerData, settings]);

  const readyModels = models.filter(model => model.ready).length;
  const readyProviders = providers.filter(provider => provider.ready).length;

  return (
    <div style={{ maxWidth: 1240 }}>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-header">Active LLM Settings</h1>
          <p className="text-sm text-slate-500 mt-1">
            The central gateway is the only allowed provider-calling surface. This page shows the live gateway, provider readiness, and approved model aliases.
          </p>
        </div>
        <button className="btn-secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="card border-red-200 bg-red-50 p-4 mb-6 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
        <SummaryTile icon={settings?.health.ok ? CheckCircle2 : XCircle} label="Gateway" value={settings?.health.ok ? "Online" : "Offline"} tone={settings?.health.ok ? "ok" : "bad"} />
        <SummaryTile icon={Cpu} label="Default provider" value={defaultProvider} />
        <SummaryTile icon={ShieldCheck} label="Default alias" value={defaultModelAlias} />
        <SummaryTile icon={Cpu} label="Ready models" value={`${readyModels}/${models.length || 0}`} />
      </div>

      <section className="card p-5 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Gateway Control Plane</h2>
            <p className="text-sm text-slate-500">These values come from the running agent-and-tools web container and live gateway responses.</p>
          </div>
          <span className={`badge ${statusClass(settings?.health.ok)}`}>{settings?.health.ok ? "healthy" : "unhealthy"}</span>
        </div>
        <div className="grid md:grid-cols-2 gap-3 text-sm">
          <Field label="LLM_GATEWAY_URL" value={settings?.gatewayUrl ?? "loading"} mono />
          <Field label="Gateway auth" value={settings?.authMode ?? "unknown"} />
          <Field label="Provider config" value={String(gatewayConfig.provider_config_path ?? settings?.configuredPaths.providerConfigPath ?? "unknown")} mono />
          <Field label="Model catalog" value={String(gatewayConfig.model_catalog_path ?? settings?.configuredPaths.modelCatalogPath ?? "unknown")} mono />
          <Field label="Caller provider override" value={String(gatewayConfig.allow_caller_provider_override ?? "unknown")} />
          <Field label="Timeout seconds" value={String(gatewayConfig.upstream_timeout_sec ?? "unknown")} />
        </div>
      </section>

      {warnings.length > 0 && (
        <section className="card border-amber-200 bg-amber-50 p-4 mb-6">
          <div className="flex items-center gap-2 text-amber-800 font-semibold mb-2">
            <AlertTriangle size={16} /> Gateway warnings
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
        <div className="grid md:grid-cols-2 gap-3 text-sm">
          {Object.entries(settings?.consumers ?? {}).map(([key, value]) => (
            <Field key={key} label={key} value={value ?? "-"} mono={key.toLowerCase().includes("url")} />
          ))}
        </div>
        {(settings?.consumers.eventHorizonProvider || settings?.consumers.eventHorizonModel) && (
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
