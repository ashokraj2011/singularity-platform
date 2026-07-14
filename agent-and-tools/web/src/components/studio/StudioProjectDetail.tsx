"use client";

import Link from "next/link";
import { useState, type CSSProperties } from "react";
import useSWR from "swr";
import { ArrowLeft, FolderGit2, FileText, Archive, Unlink, Lightbulb, ClipboardList, PenTool, GitPullRequest, CheckCircle2, LayoutDashboard } from "lucide-react";
import { workgraphFetch } from "@/lib/workgraph";
import { ProjectAnalysisSurface } from "./ProjectAnalysisSurface";
import { ProjectRequirementsSurface } from "./ProjectRequirementsSurface";
import { ProjectDesignSurface } from "./ProjectDesignSurface";
import { ProjectReconciliationReport } from "./ProjectReconciliationReport";

/**
 * A Specification Project's workspace: its mission, the shared lifecycle spine, and the work items
 * drawing on it. This is the project-rooted view behind /studio/[projectId]. Work items remain
 * standalone-capable — detaching here returns an item to a solo spec.
 */

type Project = { id: string; code: string; name: string; mission?: string | null; status?: string | null; workItemCount: number };
type WorkItemCard = { id: string; workCode?: string | null; title?: string | null; status?: string | null; urgency?: string | null };

const muted: CSSProperties = { color: "var(--color-on-surface-variant)" };
const PHASES = [
  { key: "analysis", label: "Analysis", Icon: Lightbulb },
  { key: "requirements", label: "Requirements", Icon: ClipboardList },
  { key: "design", label: "Design", Icon: PenTool },
  { key: "handoff", label: "Handoff", Icon: GitPullRequest },
  { key: "reconciliation", label: "Reconciliation", Icon: CheckCircle2 },
];

type Tab = "overview" | "analysis" | "requirements" | "design" | "reconciliation";
const TABS = [
  { key: "overview" as const, label: "Overview", Icon: LayoutDashboard },
  { key: "analysis" as const, label: "Analysis", Icon: Lightbulb },
  { key: "requirements" as const, label: "Requirements", Icon: ClipboardList },
  { key: "design" as const, label: "Design", Icon: PenTool },
  { key: "reconciliation" as const, label: "Reconciliation", Icon: CheckCircle2 },
];
function tabStyle(active: boolean): CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 13px", fontSize: 13, fontWeight: 650,
    border: "none", background: "none", cursor: "pointer", marginBottom: -1,
    color: active ? "var(--color-primary)" : "var(--color-on-surface-variant)",
    borderBottom: active ? "2px solid var(--color-primary)" : "2px solid transparent",
  };
}

export function StudioProjectDetail({ projectId }: { projectId: string }) {
  const projectSWR = useSWR<Project>(`/studio/projects/${projectId}`, (url: string) => workgraphFetch<Project>(url));
  const itemsSWR = useSWR<{ items: WorkItemCard[] }>(`/studio/projects/${projectId}/work-items`, (url: string) => workgraphFetch<{ items: WorkItemCard[] }>(url), { refreshInterval: 15000 });
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  const project = projectSWR.data;
  const items = itemsSWR.data?.items ?? [];

  async function detach(workItemId: string) {
    setActionError(null);
    try {
      await workgraphFetch(`/studio/projects/${projectId}/work-items/${workItemId}`, { method: "DELETE" });
      await itemsSWR.mutate(); await projectSWR.mutate();
    } catch (err) { setActionError(err instanceof Error ? err.message : "Could not detach the work item."); }
  }
  async function archive() {
    setActionError(null);
    try {
      await workgraphFetch(`/studio/projects/${projectId}/archive`, { method: "POST", body: JSON.stringify({ archived: true }) });
      await projectSWR.mutate();
    } catch (err) { setActionError(err instanceof Error ? err.message : "Could not archive the project."); }
  }

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: "8px 4px 40px" }}>
      <Link href="/studio" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, textDecoration: "none", ...muted }}>
        <ArrowLeft size={14} /> All projects
      </Link>

      {projectSWR.isLoading ? (
        <p style={{ ...muted, marginTop: 16 }}>Loading…</p>
      ) : projectSWR.error || !project ? (
        <div className="card" style={{ marginTop: 16, padding: 16, ...muted }}>Couldn&apos;t load this project. <Link href="/studio" className="btn-secondary text-xs" style={{ marginLeft: 8 }}>Back to Studio</Link></div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginTop: 12, flexWrap: "wrap" }}>
            <div style={{ width: 40, height: 40, borderRadius: 11, display: "grid", placeItems: "center", background: "var(--color-surface-low)", color: "var(--color-primary)", flex: "none" }}>
              <FolderGit2 size={21} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>{project.name}</h1>
                <span className="badge badge-draft" style={{ fontFamily: "var(--font-mono, monospace)" }}>{project.code}</span>
                {project.status === "ARCHIVED" && <span className="badge badge-inactive">archived</span>}
              </div>
              <p style={{ margin: "6px 0 0", fontSize: 13.5, maxWidth: "62ch", ...muted }}>{project.mission || "No mission set yet."}</p>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              {project.status !== "ARCHIVED" && <button className="btn-secondary text-xs" type="button" onClick={archive}><Archive size={13} /> Archive</button>}
            </div>
          </div>

          {actionError && <div className="card" style={{ marginTop: 14, padding: "10px 14px", fontSize: 12.5, color: "#991b1b", background: "#fef2f2", borderColor: "#fecaca" }}>{actionError}</div>}

          {/* Tabs */}
          <div style={{ display: "flex", gap: 4, marginTop: 20, borderBottom: "1px solid var(--color-outline-variant)" }}>
            {TABS.map((t) => (
              <button key={t.key} type="button" onClick={() => setTab(t.key)} style={tabStyle(tab === t.key)}><t.Icon size={14} /> {t.label}</button>
            ))}
          </div>

          {tab === "overview" && (<>
          {/* Lifecycle spine (project-level shared upstream) */}
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${PHASES.length}, 1fr)`, gap: 10, marginTop: 22 }}>
            {PHASES.map(({ key, label, Icon }) => (
              <div key={key} className="card" style={{ padding: "12px 12px 14px" }}>
                <div style={{ width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--color-surface-low)", color: "var(--color-on-surface-variant)", marginBottom: 8 }}>
                  <Icon size={16} />
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>{label}</div>
                <div style={{ fontSize: 11, ...muted }}>shared</div>
              </div>
            ))}
          </div>
          <p style={{ margin: "8px 2px 0", fontSize: 11.5, ...muted }}>The shared upstream lives at the project. Work items below inherit it and reconcile back to their own frozen specs.</p>

          {/* Work items */}
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase", ...muted, margin: "26px 0 12px" }}>
            Work items {items.length > 0 && <span style={{ color: "var(--color-outline)" }}>· {items.length}</span>}
          </div>
          {itemsSWR.isLoading ? (
            <p style={muted}>Loading…</p>
          ) : items.length === 0 ? (
            <div className="card" style={{ padding: 20, textAlign: "center", ...muted }}>
              <FileText size={22} style={{ opacity: 0.6 }} />
              <p style={{ margin: "8px 0 0", fontSize: 12.5 }}>No work items yet. Attach standalone items from the <Link href="/studio" style={{ color: "var(--color-primary)" }}>Studio portfolio</Link>.</p>
            </div>
          ) : (
            <div className="card" style={{ overflow: "hidden" }}>
              {items.map((w, i) => (
                <div key={w.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", borderTop: i === 0 ? "none" : "1px solid var(--color-outline-variant)", flexWrap: "wrap" }}>
                  <FileText size={15} style={muted} />
                  <Link href={`/workflows/work/workitem/${w.id}`} style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12, color: "var(--color-primary)", fontWeight: 600, textDecoration: "none" }}>{w.workCode || w.id.slice(0, 8)}</Link>
                  <span style={{ fontWeight: 600 }}>{w.title || "Untitled"}</span>
                  <span className="badge badge-draft" style={{ textTransform: "none" }}>{String(w.status ?? "").toLowerCase() || "queued"}</span>
                  <button className="btn-secondary text-xs" type="button" style={{ marginLeft: "auto" }} onClick={() => detach(w.id)} title="Return to standalone"><Unlink size={12} /> Detach</button>
                </div>
              ))}
            </div>
          )}
          </>)}

          {tab === "analysis" && <div style={{ marginTop: 22 }}><ProjectAnalysisSurface projectId={projectId} /></div>}
          {tab === "requirements" && <div style={{ marginTop: 22 }}><ProjectRequirementsSurface projectId={projectId} /></div>}
          {tab === "design" && <div style={{ marginTop: 22 }}><ProjectDesignSurface projectId={projectId} /></div>}
          {tab === "reconciliation" && <div style={{ marginTop: 22 }}><ProjectReconciliationReport projectId={projectId} /></div>}
        </>
      )}
    </div>
  );
}
