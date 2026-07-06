"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { Activity, Download, FileCheck2, GitBranch, Network, Package, ShieldCheck, Workflow } from "lucide-react";
import { workbenchNeoUrl } from "@/lib/workbenchLaunch";
import { workgraphApi } from "@/lib/api";

const RunSurfaceRoute = dynamic(
  () => import("@/components/workflows/RunSurfaceRoute").then((module) => module.RunSurfaceRoute),
  {
    ssr: false,
    loading: () => <div className="card" style={{ padding: 24, color: "var(--color-outline)" }}>Loading run...</div>,
  },
);

export default function RunDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const encoded = encodeURIComponent(id);
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section className="page-hero" style={{ padding: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--accent-workflow)", fontSize: 12, fontWeight: 850, textTransform: "uppercase", marginBottom: 8 }}>
              <Activity size={15} />
              Run Cockpit
            </div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 900 }}>Delivery Evidence and Copilot Handoff</h1>
            <p style={{ margin: "7px 0 0", color: "var(--color-outline)", fontSize: 13, lineHeight: 1.5 }}>
              Follow the active workflow graph, review generated artifacts, and export a Copilot-ready handoff with runner script and evidence pack.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <a className="btn-secondary" href={`/api/workgraph/workflow-instances/${encoded}/export/copilot-yaml`}>
              <Download size={14} /> Copilot YAML
            </a>
            <a className="btn-secondary" href={`/api/workgraph/workflow-instances/${encoded}/export/copilot-runner.sh`}>
              <GitBranch size={14} /> Runner script
            </a>
            <a className="btn-secondary" href={`/api/workgraph/workflow-instances/${encoded}/delivery-receipt`}>
              <FileCheck2 size={14} /> Evidence pack
            </a>
            <Link className="btn-primary" href={workbenchNeoUrl({ workflowInstanceId: id, browserRunId: id })}>
              <Workflow size={14} /> Workbench Neo
            </Link>
            <Link className="btn-secondary" href={`/runs/${encoded}/artifacts`}>
              <Package size={14} /> Artifacts
            </Link>
            <Link className="btn-secondary" href={`/runs/${encoded}/insights`}>
              <ShieldCheck size={14} /> Insights
            </Link>
          </div>
        </div>
        <div className="evidence-rail" style={{ marginTop: 14 }}>
          {[
            ["Graph", "Active stage"],
            ["Artifacts", "Files and docs"],
            ["Approvals", "Human gates"],
            ["Receipts", "Audit proof"],
            ["Copilot", "YAML handoff"],
          ].map(([label, detail]) => (
            <div key={label} className="evidence-step">
              <span style={{ width: 32, height: 32, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--accent-workflow-soft)", color: "var(--accent-workflow)" }}>
                <Activity size={15} />
              </span>
              <span>
                <strong style={{ display: "block", color: "var(--color-on-surface)", fontSize: 13 }}>{label}</strong>
                <span style={{ color: "var(--color-outline)", fontSize: 11 }}>{detail}</span>
              </span>
            </div>
          ))}
        </div>
      </section>
      <section className="data-panel" style={{ padding: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10 }}>
          <ActionCard
            icon={Activity}
            label="Current action"
            value="Review active stage"
            detail="Use the graph below to see the running node, blocker, or next approval."
          />
          <ActionCard
            icon={ShieldCheck}
            label="Governance"
            value="Check approvals"
            detail="Open Insights when the run pauses for evidence, risk, or human approval."
            href={`/runs/${encoded}/insights`}
          />
          <ActionCard
            icon={Package}
            label="Artifacts"
            value="Inspect outputs"
            detail="Generated documents, code artifacts, and receipts stay attached to this run."
            href={`/runs/${encoded}/artifacts`}
          />
          <ActionCard
            icon={FileCheck2}
            label="Evidence"
            value="Export handoff"
            detail="Download delivery evidence, Copilot YAML, and runner script when ready."
            href={`/runs/${encoded}/insights`}
          />
        </div>
      </section>
      <RunTraceStrip runId={id} />
      <RunSurfaceRoute />
    </div>
  );
}

function RunTraceStrip({ runId }: { runId: string }) {
  const { data } = useSWR(
    runId ? ["run-trust-trace", runId] : null,
    () => workgraphApi.trustTrace(runId),
    { refreshInterval: 15000 },
  );
  const traceIds = Array.isArray(data?.traceIds) ? data.traceIds.filter(Boolean).slice(0, 8) : [];
  if (traceIds.length === 0) return null;
  return (
    <section className="data-panel" style={{ padding: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
          <span style={{ width: 34, height: 34, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--accent-evidence-soft)", color: "var(--accent-evidence)" }}>
            <Network size={16} />
          </span>
          <div>
            <div style={{ color: "var(--color-on-surface)", fontSize: 14, fontWeight: 800 }}>Platform trace cockpit</div>
            <div style={{ color: "var(--color-outline)", fontSize: 12 }}>Open the unified evidence timeline for node-level execution traces.</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {traceIds.map((traceId) => (
            <Link key={traceId} className="btn-secondary" href={`/audit/trace/${encodeURIComponent(traceId)}`}>
              <Network size={13} /> {traceId.length > 34 ? `${traceId.slice(0, 31)}...` : traceId}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function ActionCard({
  icon: Icon,
  label,
  value,
  detail,
  href,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  detail: string;
  href?: string;
}) {
  const body = (
    <article className="card-hover" style={{ minHeight: 126, border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 13, background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
        <span style={{ width: 34, height: 34, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--accent-evidence-soft)", color: "var(--accent-evidence)" }}>
          <Icon size={16} />
        </span>
        <span className="label-xs" style={{ color: "var(--color-outline)" }}>{label}</span>
      </div>
      <strong style={{ display: "block", color: "var(--color-on-surface)", fontSize: 14 }}>{value}</strong>
      <p style={{ margin: "6px 0 0", color: "var(--color-outline)", fontSize: 12, lineHeight: 1.5 }}>{detail}</p>
    </article>
  );
  return href ? <Link href={href} style={{ textDecoration: "none" }}>{body}</Link> : body;
}
