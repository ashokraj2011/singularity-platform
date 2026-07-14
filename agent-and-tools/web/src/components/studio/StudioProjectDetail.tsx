"use client";

import Link from "next/link";
import { useState, type CSSProperties } from "react";
import useSWR from "swr";
import { FolderGit2, FileText, Archive, Unlink, Lightbulb, ClipboardList, PenTool, GitPullRequest, CheckCircle2, LayoutDashboard, Users } from "lucide-react";
import { workgraphFetch } from "@/lib/workgraph";
import { ProjectAnalysisSurface } from "./ProjectAnalysisSurface";
import { ProjectRequirementsSurface } from "./ProjectRequirementsSurface";
import { ProjectDesignSurface } from "./ProjectDesignSurface";
import { ProjectReconciliationReport } from "./ProjectReconciliationReport";
import { usePresence } from "./usePresence";
import { PresenceBar } from "./PresenceBar";
import { CoeditCanvas } from "./CoeditCanvas";
import { StudioShell } from "./StudioShell";

/**
 * A Specification Project's workspace in the dark ELM Studio look: mission, the shared lifecycle
 * spine, the tab rail, and the work items drawing on it. Behind /studio/[projectId]. Work items
 * remain standalone-capable — detaching returns an item to a solo spec.
 */

type Project = { id: string; code: string; name: string; mission?: string | null; status?: string | null; workItemCount: number };
type WorkItemCard = { id: string; workCode?: string | null; title?: string | null; status?: string | null; urgency?: string | null };

const PHASES = [
  { key: "analysis", label: "Analysis", Icon: Lightbulb },
  { key: "requirements", label: "Requirements", Icon: ClipboardList },
  { key: "design", label: "Design", Icon: PenTool },
  { key: "handoff", label: "Handoff", Icon: GitPullRequest },
  { key: "reconciliation", label: "Reconciliation", Icon: CheckCircle2 },
];
type Tab = "overview" | "analysis" | "requirements" | "design" | "reconciliation" | "coedit";
const TABS = [
  { key: "overview" as const, label: "Overview", Icon: LayoutDashboard },
  { key: "analysis" as const, label: "Analysis", Icon: Lightbulb },
  { key: "requirements" as const, label: "Requirements", Icon: ClipboardList },
  { key: "design" as const, label: "Design", Icon: PenTool },
  { key: "reconciliation" as const, label: "Reconciliation", Icon: CheckCircle2 },
  { key: "coedit" as const, label: "Co-edit", Icon: Users },
];

export function StudioProjectDetail({ projectId }: { projectId: string }) {
  const projectSWR = useSWR<Project>(`/studio/projects/${projectId}`, (url: string) => workgraphFetch<Project>(url));
  const itemsSWR = useSWR<{ items: WorkItemCard[] }>(`/studio/projects/${projectId}/work-items`, (url: string) => workgraphFetch<{ items: WorkItemCard[] }>(url), { refreshInterval: 15000 });
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const present = usePresence(projectId, tab);

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

  const crumb = <><Link href="/studio" style={{ color: "var(--studio-ink-dim)", textDecoration: "none" }}>Projects</Link><span style={{ color: "var(--studio-faint)" }}>›</span><span style={{ color: "var(--studio-ink)", fontWeight: 600 }}>{project?.name ?? "…"}</span></>;

  return (
    <StudioShell crumb={crumb} actions={<PresenceBar present={present} />}>
      <div style={{ maxWidth: 1040, margin: "0 auto" }}>
        {projectSWR.isLoading ? (
          <p style={{ ...muted, marginTop: 8 }}>Loading…</p>
        ) : projectSWR.error || !project ? (
          <div style={{ ...panel, padding: 16, ...muted }}>Couldn&apos;t load this project. <Link href="/studio" style={{ ...ghostBtn, marginLeft: 8 }}>Back to Studio</Link></div>
        ) : (
          <>
            {/* Header */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
              <div style={{ width: 42, height: 42, borderRadius: 12, display: "grid", placeItems: "center", background: "var(--studio-accent-soft)", color: "var(--studio-accent-2)", flex: "none", border: "1px solid var(--studio-line)" }}>
                <FolderGit2 size={22} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>{project.name}</h1>
                  <span style={codeChip}>{project.code}</span>
                  {project.status === "ARCHIVED" && <span style={{ ...statusChip, color: "var(--studio-muted)" }}>archived</span>}
                </div>
                <p style={{ margin: "6px 0 0", fontSize: 13.5, maxWidth: "62ch", ...muted }}>{project.mission || "No mission set yet."}</p>
              </div>
              {project.status !== "ARCHIVED" && (
                <button style={{ ...ghostBtn, marginLeft: "auto" }} type="button" onClick={archive}><Archive size={13} /> Archive</button>
              )}
            </div>

            {actionError && <div style={errorBanner}>{actionError}</div>}

            {/* Tab rail */}
            <div style={{ display: "flex", gap: 2, marginTop: 20, borderBottom: "1px solid var(--studio-line)", flexWrap: "wrap" }}>
              {TABS.map((t) => {
                const on = tab === t.key;
                return (
                  <button key={t.key} type="button" onClick={() => setTab(t.key)} style={{
                    display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 14px", fontSize: 13, fontWeight: 650,
                    border: "none", background: "none", cursor: "pointer", marginBottom: -1,
                    color: on ? "var(--studio-accent-2)" : "var(--studio-ink-dim)",
                    borderBottom: on ? "2px solid var(--studio-accent)" : "2px solid transparent",
                  }}><t.Icon size={14} /> {t.label}</button>
                );
              })}
            </div>

            {tab === "overview" && (<>
              {/* Lifecycle spine */}
              <div style={sectionLabel}>Lifecycle</div>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${PHASES.length}, 1fr)`, gap: 10 }}>
                {PHASES.map(({ key, label, Icon }) => (
                  <div key={key} style={{ ...panel, background: "var(--studio-panel-2)", padding: "13px 13px 15px" }}>
                    <div style={{ width: 32, height: 32, borderRadius: 9, display: "grid", placeItems: "center", background: "var(--studio-panel)", border: "1px solid var(--studio-line)", color: "var(--studio-muted)", marginBottom: 9 }}>
                      <Icon size={16} />
                    </div>
                    <div style={{ fontSize: 12.5, fontWeight: 700 }}>{label}</div>
                    <div style={{ fontSize: 11, ...muted }}>shared</div>
                  </div>
                ))}
              </div>
              <p style={{ margin: "9px 2px 0", fontSize: 11.5, ...muted }}>The shared upstream lives at the project. Work items below inherit it and reconcile back to their own frozen specs.</p>

              {/* Work items */}
              <div style={sectionLabel}>Work items {items.length > 0 && <span style={{ color: "var(--studio-faint)" }}>· {items.length}</span>}</div>
              {itemsSWR.isLoading ? (
                <p style={muted}>Loading…</p>
              ) : items.length === 0 ? (
                <div style={{ ...panel, padding: 22, textAlign: "center" }}>
                  <FileText size={22} style={{ color: "var(--studio-accent-2)", opacity: 0.85 }} />
                  <p style={{ margin: "9px 0 0", fontSize: 12.5, ...muted }}>No work items yet. Attach standalone items from the <Link href="/studio" style={{ color: "var(--studio-accent-2)" }}>Studio portfolio</Link>.</p>
                </div>
              ) : (
                <div style={{ ...panel, overflow: "hidden", padding: 0 }}>
                  {items.map((w, i) => (
                    <div key={w.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 15px", borderTop: i === 0 ? "none" : "1px solid var(--studio-line-soft)", flexWrap: "wrap" }}>
                      <FileText size={15} style={muted} />
                      <Link href={`/workflows/work/workitem/${w.id}`} style={mono}>{w.workCode || w.id.slice(0, 8)}</Link>
                      <span style={{ fontWeight: 600 }}>{w.title || "Untitled"}</span>
                      <span style={statusChip}>{String(w.status ?? "").toLowerCase() || "queued"}</span>
                      <button style={{ ...ghostBtn, marginLeft: "auto", padding: "5px 11px" }} type="button" onClick={() => detach(w.id)} title="Return to standalone"><Unlink size={12} /> Detach</button>
                    </div>
                  ))}
                </div>
              )}
            </>)}

            {tab === "analysis" && <div style={{ marginTop: 22 }}><ProjectAnalysisSurface projectId={projectId} /></div>}
            {tab === "requirements" && <div style={{ marginTop: 22 }}><ProjectRequirementsSurface projectId={projectId} /></div>}
            {tab === "design" && <div style={{ marginTop: 22 }}><ProjectDesignSurface projectId={projectId} /></div>}
            {tab === "reconciliation" && <div style={{ marginTop: 22 }}><ProjectReconciliationReport projectId={projectId} /></div>}
            {tab === "coedit" && <div style={{ marginTop: 22 }}><CoeditCanvas projectId={projectId} docKey="canvas" surface="coedit" title="Project canvas — live" placeholder="Draft the spec together — problem statements, open questions, sketches. Edits merge live." /></div>}
          </>
        )}
      </div>
    </StudioShell>
  );
}

const muted: CSSProperties = { color: "var(--studio-ink-dim)" };
const sectionLabel: CSSProperties = { fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--studio-muted)", margin: "24px 0 13px" };
const panel: CSSProperties = { background: "var(--studio-panel)", border: "1px solid var(--studio-line)", borderRadius: 12 };
const codeChip: CSSProperties = { fontFamily: "var(--studio-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--studio-accent-2)", background: "var(--studio-accent-soft)", borderRadius: 6, padding: "3px 8px" };
const statusChip: CSSProperties = { fontSize: 10.5, fontWeight: 700, color: "var(--studio-ink-dim)", background: "var(--studio-panel-2)", border: "1px solid var(--studio-line)", borderRadius: 6, padding: "2px 8px" };
const mono: CSSProperties = { fontFamily: "var(--studio-mono)", fontSize: 12, color: "var(--studio-accent-2)", fontWeight: 600, textDecoration: "none" };
const ghostBtn: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 7, background: "var(--studio-panel-2)", color: "var(--studio-ink)", border: "1px solid var(--studio-line)", borderRadius: 9, padding: "7px 13px", fontSize: 12.5, fontWeight: 650, cursor: "pointer", textDecoration: "none" };
const errorBanner: CSSProperties = { marginTop: 14, padding: "10px 14px", fontSize: 12.5, color: "#fecaca", background: "rgba(242,104,138,0.12)", border: "1px solid var(--studio-bad)", borderRadius: 10 };
