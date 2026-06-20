"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import useSWR from "swr";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { apiPath, authHeaders, readResponseBody, responseMessage } from "@/lib/api";
import { PlatformTopologyMap } from "@/components/PlatformTopologyMap";

type Check = { label: string; path: string };
type RuntimeInfrastructure = {
  generatedAt: string;
  summary: {
    requiredHealthy: boolean;
    requiredCount: number;
    optionalConfigured: number;
    optionalHealthy: number;
  };
  services: RuntimeService[];
};

type RuntimeService = {
  id: string;
  label: string;
  description: string;
  category: "core" | "runtime" | "governance";
  envKey: string;
  url: string | null;
  required: boolean;
  remoteCapable: boolean;
  status: "healthy" | "unhealthy" | "unreachable" | "not_configured";
  ok: boolean | null;
  httpStatus: number | null;
  message: string;
};

const checks: Check[] = [
  { label: "IAM", path: "/ops-health/iam" },
  { label: "Workgraph API", path: "/ops-health/workgraph-api" },
  { label: "Agent Runtime", path: "/ops-health/agent-runtime" },
  { label: "Agent Service", path: "/ops-health/agent-service" },
  { label: "Tool Service", path: "/ops-health/tool-service" },
  { label: "Prompt Composer", path: "/ops-health/prompt-composer" },
  { label: "Context API", path: "/ops-health/context-api" },
];

async function check(path: string): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(path);
  const body = await res.text();
  return { ok: res.ok, status: res.status, body: body.slice(0, 180) };
}

async function runtimeInfrastructure(): Promise<RuntimeInfrastructure> {
  const res = await fetch(apiPath("/api/runtime-infrastructure"), { cache: "no-store", headers: authHeaders() });
  const { raw, parsed } = await readResponseBody(res);
  if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
  if (!parsed || typeof parsed !== "object") throw new Error(raw ? raw.slice(0, 300) : "Empty runtime infrastructure response");
  return parsed as RuntimeInfrastructure;
}

function runtimeBadge(service: RuntimeService): { label: string; className: string; style?: CSSProperties } {
  if (service.ok === true) return { label: "Healthy", className: "badge badge-active" };
  if (service.status === "not_configured" && !service.required) return { label: "Optional", className: "badge" };
  if (!service.required) {
    return {
      label: "Unavailable",
      className: "badge",
      style: { color: "#92400e", background: "rgba(254,243,199,0.85)" },
    };
  }
  return {
    label: service.status === "not_configured" ? "Missing" : "Down",
    className: "badge",
    style: { color: "#991b1b", background: "rgba(254,226,226,0.85)" },
  };
}

export function OperationsStatusPage({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  const { data, isLoading, mutate } = useSWR(
    "operations-status",
    async () => Promise.all(checks.map(async (item) => ({ ...item, result: await check(item.path).catch((err) => ({ ok: false, status: 0, body: (err as Error).message })) }))),
    { refreshInterval: 10000 },
  );
  const { data: runtime, isLoading: runtimeLoading, mutate: refreshRuntime } = useSWR(
    "runtime-infrastructure",
    runtimeInfrastructure,
    { refreshInterval: 10000 },
  );

  const refreshAll = () => {
    void mutate();
    void refreshRuntime();
  };

  return (
    <div style={{ maxWidth: 1180 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 18 }}>
        <Link href="/operations" className="btn-secondary">
          <ArrowLeft size={15} />
          Back to operations
        </Link>
        <button type="button" className="btn-secondary" onClick={refreshAll}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>

      <section className="card" style={{ padding: 24, marginBottom: 18 }}>
        <h1 className="page-header" style={{ marginBottom: 8 }}>{title}</h1>
        <p style={{ color: "var(--color-outline)", fontSize: 14, lineHeight: 1.6, margin: 0 }}>{description}</p>
      </section>

      <PlatformTopologyMap />

      <section style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>Core Platform Services</h2>
            <p style={{ color: "var(--color-outline)", fontSize: 13, lineHeight: 1.5, margin: "4px 0 0" }}>
              These services must be healthy for the unified web app to operate normally.
            </p>
          </div>
          <span className="badge badge-active">{checks.length} checks</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        {(data ?? checks.map((item) => ({ ...item, result: null }))).map((item) => {
          const result = item.result;
          const ok = result?.ok;
          return (
            <article key={item.path} className="card" style={{ padding: 16, boxShadow: "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontWeight: 800 }}>{item.label}</div>
                <span className={ok ? "badge badge-active" : "badge"} style={{ color: ok ? undefined : "#991b1b", background: ok ? undefined : "rgba(254,226,226,0.85)" }}>
                  {isLoading && !result ? "Checking" : ok ? "Healthy" : "Down"}
                </span>
              </div>
              <div style={{ color: "var(--color-outline)", fontSize: 12, marginBottom: 8 }}>{item.path}</div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11, maxHeight: 86, overflow: "auto" }}>
                {result ? `${result.status}\n${result.body}` : "Loading..."}
              </pre>
            </article>
          );
        })}
        </div>
      </section>

      <section>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>Runtime Infrastructure</h2>
            <p style={{ color: "var(--color-outline)", fontSize: 13, lineHeight: 1.5, margin: "4px 0 0" }}>
              MCP, LLM Gateway, verifier, foundry, and governance endpoints can be local containers or externally deployed services.
            </p>
          </div>
          <span className="badge">
            {runtimeLoading && !runtime ? "Checking" : `${runtime?.summary.optionalHealthy ?? 0}/${runtime?.summary.optionalConfigured ?? 0} optional healthy`}
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
          {(runtime?.services ?? []).map((service) => {
            const badge = runtimeBadge(service);
            return (
              <article key={service.id} className="card" style={{ padding: 16, boxShadow: "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 8 }}>
                  <div style={{ fontWeight: 800 }}>{service.label}</div>
                  <span className={badge.className} style={badge.style}>{badge.label}</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                  <span className="badge">{service.required ? "required" : "optional"}</span>
                  {service.remoteCapable && <span className="badge">remote capable</span>}
                  <span className="badge">{service.category}</span>
                </div>
                <p style={{ color: "var(--color-outline)", fontSize: 12, lineHeight: 1.5, margin: "0 0 10px" }}>{service.description}</p>
                <div style={{ color: "var(--color-outline)", fontSize: 12, marginBottom: 8 }}>
                  <div><strong>{service.envKey}</strong></div>
                  <div style={{ wordBreak: "break-word" }}>{service.url ?? "not configured"}</div>
                </div>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11, maxHeight: 86, overflow: "auto" }}>
                  {service.httpStatus ? `${service.httpStatus}\n` : ""}
                  {service.message}
                </pre>
              </article>
            );
          })}
          {!runtime?.services?.length && (
            <article className="card" style={{ padding: 16, boxShadow: "none", color: "var(--color-outline)" }}>
              {runtimeLoading ? "Loading runtime infrastructure..." : "Runtime infrastructure status is unavailable."}
            </article>
          )}
        </div>
      </section>
    </div>
  );
}
