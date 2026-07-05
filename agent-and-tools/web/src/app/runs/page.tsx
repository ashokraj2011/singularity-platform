import { LegacyRunsDashboardRoute } from "@/components/workflows/LegacyWorkgraphAdminRoute";
import Link from "next/link";
import { Activity, Play, Route, ShieldCheck } from "lucide-react";

export default function RunsPage() {
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <section className="page-hero">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--accent-workflow)", fontSize: 12, fontWeight: 850, textTransform: "uppercase", marginBottom: 10 }}>
              <Activity size={15} />
              Runs
            </div>
            <h1 className="page-header" style={{ margin: 0, fontSize: 34 }}>Unified Run Cockpit</h1>
            <p style={{ margin: "10px 0 0", maxWidth: 820, color: "var(--color-outline)", fontSize: 14, lineHeight: 1.6 }}>
              Monitor active SDLC workflows, resume blocked gates, open artifacts, and export delivery evidence from one place.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link className="btn-primary" href="/workflows/start"><Play size={15} /> Launch workflow</Link>
            <Link className="btn-secondary" href="/workflows/planner"><Route size={15} /> Story planner</Link>
            <Link className="btn-secondary" href="/audit"><ShieldCheck size={15} /> Audit</Link>
          </div>
        </div>
      </section>
      <LegacyRunsDashboardRoute />
    </div>
  );
}
