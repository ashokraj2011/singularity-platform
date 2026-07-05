import { LegacyWorkflowsRoute } from "@/components/workflows/LegacyWorkgraphAdminRoute";
import Link from "next/link";
import { Activity, ClipboardList, Code2, FileCheck2, GitCompare, Play, Route, ScrollText, ShieldCheck, TestTube2, Workflow } from "lucide-react";

export default function WorkflowsDomainPage() {
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <section className="page-hero">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 18, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--accent-workflow)", fontSize: 12, fontWeight: 850, textTransform: "uppercase", marginBottom: 10 }}>
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
                <span style={{ width: 32, height: 32, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--accent-workflow-soft)", color: "var(--accent-workflow)" }}>
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
      <section className="data-panel">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 14 }}>
          <div>
            <div className="label-xs" style={{ color: "var(--color-outline)", marginBottom: 5 }}>Creation modes</div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 900 }}>Start simple, go deep when needed.</h2>
            <p style={{ margin: "5px 0 0", color: "var(--color-outline)", fontSize: 13, lineHeight: 1.5 }}>
              Beginner mode launches tested SDLC templates. Advanced mode keeps the full React Flow designer and node palette.
            </p>
          </div>
          <Link className="btn-secondary" href="/workflows/templates/gallery"><Workflow size={15} /> Template gallery</Link>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 12 }}>
          <ModeCard icon={Play} title="Beginner: Guided SDLC Launch" detail="Choose Build Feature, Fix Bug, Refactor, Add Tests, Security Review, or Release Evidence. The launcher validates runtime, LLM, agents, and templates before starting." href="/start" primary />
          <ModeCard icon={Workflow} title="Advanced: Workflow Designer" detail="Open the full workflow manager and React Flow designer for node-level orchestration, custom gates, branches, and manual execution controls." href="/workflows/templates" />
          <ModeCard icon={ShieldCheck} title="Governance Gates" detail="Use reusable hard, soft, or automatic gates for design documents, standards, git diffs, tests, approvals, and release evidence." href="/workflows/node-types" />
        </div>
      </section>
      <section className="data-panel">
        <div style={{ marginBottom: 14 }}>
          <div className="label-xs" style={{ color: "var(--color-outline)", marginBottom: 5 }}>Gate presets</div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 900 }}>Reusable SDLC governance checks</h2>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
          <GateCard icon={FileCheck2} title="Design Review" detail="Compare implementation plan with architecture/design docs." />
          <GateCard icon={GitCompare} title="Git Diff Check" detail="Validate changed files against the previous design artifact." />
          <GateCard icon={ShieldCheck} title="Standards Check" detail="Enforce coding, security, API, and tenant-boundary standards." />
          <GateCard icon={TestTube2} title="Test Evidence" detail="Require test output, coverage, and regression proof." />
          <GateCard icon={Code2} title="Release Approval" detail="Emit evidence and block release until required receipts exist." />
        </div>
      </section>
      <LegacyWorkflowsRoute />
    </div>
  );
}

function ModeCard({ icon: Icon, title, detail, href, primary = false }: { icon: typeof Play; title: string; detail: string; href: string; primary?: boolean }) {
  return (
    <Link href={href} style={{ textDecoration: "none" }}>
      <article className="card card-hover" style={{ minHeight: 170, padding: 16, borderRadius: 8, boxShadow: "none", borderColor: primary ? "rgba(37,99,235,0.32)" : "var(--color-outline-variant)" }}>
        <span style={{ width: 38, height: 38, borderRadius: 8, display: "grid", placeItems: "center", color: primary ? "var(--accent-workflow)" : "#475569", background: primary ? "var(--accent-workflow-soft)" : "#f1f5f9", marginBottom: 12 }}>
          <Icon size={18} />
        </span>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 900, color: "var(--color-on-surface)" }}>{title}</h3>
        <p style={{ margin: "7px 0 0", color: "var(--color-outline)", fontSize: 12, lineHeight: 1.5 }}>{detail}</p>
      </article>
    </Link>
  );
}

function GateCard({ icon: Icon, title, detail }: { icon: typeof Play; title: string; detail: string }) {
  return (
    <article style={{ border: "1px solid var(--color-outline-variant)", background: "#fff", borderRadius: 8, padding: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9 }}>
        <span style={{ width: 32, height: 32, borderRadius: 8, display: "grid", placeItems: "center", color: "var(--accent-evidence)", background: "var(--accent-evidence-soft)" }}>
          <Icon size={16} />
        </span>
        <strong style={{ color: "var(--color-on-surface)", fontSize: 13 }}>{title}</strong>
      </div>
      <p style={{ margin: 0, color: "var(--color-outline)", fontSize: 12, lineHeight: 1.45 }}>{detail}</p>
    </article>
  );
}
