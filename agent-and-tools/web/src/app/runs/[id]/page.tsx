"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Download, FileCheck2, GitBranch, Package, ShieldCheck, Workflow } from "lucide-react";
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
      <section className="card" style={{ padding: 14, display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 5 }}>Run Cockpit</div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 850 }}>Delivery Evidence and Copilot Handoff</h1>
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
      </section>
      <RunSurfaceRoute />
    </div>
  );
}
