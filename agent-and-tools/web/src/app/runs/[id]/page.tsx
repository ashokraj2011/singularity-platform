"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Activity, Download, FileCheck2, GitBranch, Package, ShieldCheck, Workflow } from "lucide-react";
import { workbenchNeoUrl } from "@/lib/workbenchLaunch";

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
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--color-primary)", fontSize: 12, fontWeight: 850, textTransform: "uppercase", marginBottom: 8 }}>
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
              <span style={{ width: 32, height: 32, borderRadius: 8, display: "grid", placeItems: "center", background: "rgba(54,135,39,0.11)", color: "var(--color-primary)" }}>
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
      <RunSurfaceRoute />
    </div>
  );
}
