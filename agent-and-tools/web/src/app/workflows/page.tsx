import { LegacyWorkflowsRoute } from "@/components/workflows/LegacyWorkgraphAdminRoute";
import Link from "next/link";
import { Activity, ClipboardList, Play, Route, ScrollText, Workflow } from "lucide-react";

export default function WorkflowsDomainPage() {
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <section className="page-hero">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 18, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--color-primary)", fontSize: 12, fontWeight: 850, textTransform: "uppercase", marginBottom: 10 }}>
              <Workflow size={15} />
              Workflows
            </div>
            <h1 className="page-header" style={{ margin: 0, fontSize: 34 }}>Plan, launch, and watch governed SDLC runs.</h1>
            <p style={{ margin: "10px 0 0", maxWidth: 820, color: "var(--color-outline)", fontSize: 14, lineHeight: 1.6 }}>
              Start from a story, create WorkItems, launch a seeded workflow, then follow artifacts, approvals, and evidence in the run cockpit.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link className="btn-primary" href="/workflows/planner"><Route size={15} /> Story Planner</Link>
            <Link className="btn-secondary" href="/workflows/start"><Play size={15} /> Guided Launch</Link>
            <Link className="btn-secondary" href="/runs"><Activity size={15} /> Runs</Link>
          </div>
        </div>
        <div className="evidence-rail" style={{ marginTop: 18 }}>
          {[
            { label: "Story", detail: "Paste and refine", icon: ClipboardList },
            { label: "WorkItems", detail: "Scope and route", icon: Route },
            { label: "Workflow", detail: "Template and gates", icon: Workflow },
            { label: "Run", detail: "Live cockpit", icon: Activity },
            { label: "Evidence", detail: "Artifacts and receipts", icon: ScrollText },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.label} className="evidence-step">
                <span style={{ width: 32, height: 32, borderRadius: 8, display: "grid", placeItems: "center", background: "rgba(54,135,39,0.11)", color: "var(--color-primary)" }}>
                  <Icon size={16} />
                </span>
                <span>
                  <strong style={{ display: "block", color: "var(--color-on-surface)", fontSize: 13 }}>{item.label}</strong>
                  <span style={{ color: "var(--color-outline)", fontSize: 11 }}>{item.detail}</span>
                </span>
              </div>
            );
          })}
        </div>
      </section>
      <LegacyWorkflowsRoute />
    </div>
  );
}
