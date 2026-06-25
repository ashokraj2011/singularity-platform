"use client";

import Link from "next/link";
import useSWR from "swr";
import { ArrowRight, Compass, RefreshCw, ServerCog } from "lucide-react";
import { controlPlaneApps } from "@/lib/controlPlaneApps";
import { apiPath, authHeaders, readResponseBody, responseMessage } from "@/lib/api";
import { valueText } from "@/lib/workgraph";

type RuntimeInfrastructure = {
  summary: { requiredHealthy: boolean; requiredCount: number; optionalConfigured: number; optionalHealthy: number };
  services: Array<{ id: string; label: string; category: string; required: boolean; remoteCapable: boolean; ok: boolean | null; status: string; message: string; url: string | null }>;
};

async function runtimeInfrastructure(): Promise<RuntimeInfrastructure> {
  const res = await fetch(apiPath("/api/runtime-infrastructure"), { cache: "no-store", headers: authHeaders() });
  const { raw, parsed } = await readResponseBody(res);
  if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
  return parsed as RuntimeInfrastructure;
}

export function ControlPlaneConsole() {
  const apps = controlPlaneApps();
  const { data, error, mutate } = useSWR("control-plane-runtime", runtimeInfrastructure, { refreshInterval: 12000 });
  const requiredDown = data?.services.filter((service) => service.required && service.ok !== true) ?? [];
  const remoteCapable = data?.services.filter((service) => service.remoteCapable) ?? [];

  return (
    <div style={{ maxWidth: 1240 }}>
      <section className="card" style={{ padding: 24, marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 8 }}>Unified Control Plane</div>
            <h1 className="page-header" style={{ marginBottom: 8 }}>Singularity Command Center</h1>
            <p style={{ margin: 0, maxWidth: 800, color: "var(--color-outline)", fontSize: 14, lineHeight: 1.6 }}>
              One native web app for agents, tools, workflows, WorkItems, Workbench, identity, and operations. External-capable services such as LLM Gateway and MCP remain deployable outside this UI container.
            </p>
          </div>
          <button className="btn-secondary" type="button" onClick={() => void mutate()}><RefreshCw size={15} /> Refresh</button>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginBottom: 18 }}>
        <Metric label="Native apps" value={apps.length} />
        <Metric label="Required healthy" value={data ? (data.summary.requiredHealthy ? "Yes" : "No") : "..."} tone={data?.summary.requiredHealthy ? "#15803d" : "#b91c1c"} />
        <Metric label="Optional healthy" value={data ? `${data.summary.optionalHealthy}/${data.summary.optionalConfigured}` : "..."} />
        <Metric label="Remote capable" value={remoteCapable.length || "..."} />
      </section>

      {error && <section className="card" style={{ padding: 14, marginBottom: 18, color: "#7f1d1d", borderColor: "rgba(185,28,28,0.28)", background: "rgba(254,242,242,0.82)" }}>{error.message}</section>}

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12, marginBottom: 18 }}>
        {apps.map((app, index) => {
          const Icon = index === 0 ? Compass : app.icon;
          return (
            <Link key={app.id} href={app.nativeHref} style={{ textDecoration: "none" }}>
              <article className="card card-hover" style={{ padding: 18, minHeight: 166, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                <div>
                  <span style={{ width: 40, height: 40, borderRadius: 8, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "rgba(54,135,39,0.1)", color: "var(--color-primary)", marginBottom: 12 }}>
                    <Icon size={19} />
                  </span>
                  <h2 style={{ margin: 0, fontSize: 16, color: "var(--color-text)" }}>{app.label}</h2>
                  <p style={{ margin: "7px 0 0", color: "var(--color-outline)", fontSize: 13, lineHeight: 1.5 }}>{app.summary}</p>
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14, color: "var(--color-primary)", fontSize: 12, fontWeight: 850 }}>
                  <span>{app.group}</span>
                  <ArrowRight size={14} />
                </div>
              </article>
            </Link>
          );
        })}
      </section>

      <section className="card" style={{ padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <ServerCog size={17} color="var(--color-primary)" />
          <h2 style={{ margin: 0, fontSize: 16 }}>Runtime Infrastructure</h2>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10 }}>
          {(data?.services ?? []).map((service) => (
            <article key={service.id} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                <strong style={{ fontSize: 13 }}>{service.label}</strong>
                <Status ok={service.ok} status={service.status} />
              </div>
              <div style={{ color: "var(--color-outline)", fontSize: 12, lineHeight: 1.5 }}>
                {service.category} · {service.required ? "required" : "optional"} · {service.remoteCapable ? "remote capable" : "local"}
                <br />
                {valueText(service.url)}
              </div>
            </article>
          ))}
          {!data && !error && <div style={{ color: "var(--color-outline)", fontSize: 13 }}>Loading infrastructure state...</div>}
        </div>
        {requiredDown.length > 0 && (
          <div style={{ marginTop: 12, color: "#7f1d1d", fontSize: 13 }}>
            Required services needing attention: {requiredDown.map((service) => service.label).join(", ")}
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: unknown; tone?: string }) {
  return <div className="card" style={{ padding: 16, boxShadow: "none" }}><div className="label-xs" style={{ color: "var(--color-outline)" }}>{label}</div><div style={{ marginTop: 5, fontWeight: 850, color: tone ?? "var(--color-text)", fontSize: 18 }}>{valueText(value)}</div></div>;
}

function Status({ ok, status }: { ok: boolean | null; status: string }) {
  const tone = ok === true ? "#15803d" : ok === false ? "#b91c1c" : "#64748b";
  return <span style={{ border: `1px solid ${tone}33`, color: tone, background: `${tone}12`, borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 850, textTransform: "uppercase" }}>{ok === true ? "Healthy" : status}</span>;
}
