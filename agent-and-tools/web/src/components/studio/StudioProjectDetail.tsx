"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type CSSProperties } from "react";
import useSWR from "swr";
import { FolderGit2, FileText, Archive, Unlink, Lightbulb, ClipboardList, PenTool, CheckCircle2, LayoutDashboard, Users, FlaskConical, GitPullRequest } from "lucide-react";
import { workgraphFetch } from "@/lib/workgraph";
import { IdeShell, IdeStatusSeg, type IdeShellView } from "workgraph-web/features/runtime/workitem/IdeShell";
import type { IdeTheme } from "workgraph-web/features/runtime/workitem/ideTheme";
import { ProjectAnalysisSurface } from "./ProjectAnalysisSurface";
import { ProjectRequirementsSurface } from "./ProjectRequirementsSurface";
import { ProjectDesignSurface } from "./ProjectDesignSurface";
import { ProjectReconciliationReport } from "./ProjectReconciliationReport";
import { ProjectRoomsSurface } from "./ProjectRoomsSurface";
import { usePresence } from "./usePresence";
import { PresenceBar } from "./PresenceBar";
import { CoeditCanvas } from "./CoeditCanvas";
import { projectIdeTokens } from "./projectIdeTokens";

/**
 * A Specification Project's workspace, now in the shared Work Item IDE shell (IdeShell): the same
 * activity bar, breadcrumb, theme toggle and status bar as an item — so project and item feel like
 * one product. Project = shared baseline; work items below inherit it and reconcile back. Behind
 * /studio/[projectId]. Work items remain standalone-capable — detaching returns an item to a solo spec.
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
type View = "overview" | "rooms" | "analysis" | "requirements" | "design" | "reconciliation" | "coedit";
const VIEWS: IdeShellView<View>[] = [
  { key: "overview", label: "Overview", Icon: LayoutDashboard },
  { key: "rooms", label: "Rooms", Icon: FlaskConical },
  { key: "analysis", label: "Analysis", Icon: Lightbulb },
  { key: "requirements", label: "Requirements", Icon: ClipboardList },
  { key: "design", label: "Design", Icon: PenTool },
  { key: "reconciliation", label: "Reconciliation", Icon: CheckCircle2 },
  { key: "coedit", label: "Co-edit", Icon: Users },
];

export function StudioProjectDetail({ projectId }: { projectId: string }) {
  const router = useRouter();
  const projectSWR = useSWR<Project>(`/studio/projects/${projectId}`, (url: string) => workgraphFetch<Project>(url));
  const itemsSWR = useSWR<{ items: WorkItemCard[] }>(`/studio/projects/${projectId}/work-items`, (url: string) => workgraphFetch<{ items: WorkItemCard[] }>(url), { refreshInterval: 15000 });
  const [actionError, setActionError] = useState<string | null>(null);
  const [view, setView] = useState<View>("overview");
  const [theme, setTheme] = useState<IdeTheme>("dark");
  const present = usePresence(projectId, view);

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

  const activeLabel = VIEWS.find((v) => v.key === view)?.label;
  const breadcrumb = (
    <>
      <Link href="/studio" style={{ fontSize: 11.5, fontWeight: 700, color: "var(--ide-ink-dim)", textDecoration: "none", whiteSpace: "nowrap" }}>Studio</Link>
      <span style={{ fontSize: 11, color: "var(--ide-muted)" }}>›</span>
      <span style={{ fontFamily: "var(--mono, ui-monospace)", fontSize: 11.5, color: "var(--ide-accent)", fontWeight: 600 }}>{project?.code ?? "…"}</span>
      <span style={{ fontSize: 13.5, fontWeight: 700, letterSpacing: "-.01em", color: "var(--ide-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{project?.name ?? ""}</span>
      <span style={{ fontSize: 11, color: "var(--ide-muted)" }}>›</span>
      <span style={{ fontSize: 12.5, color: "var(--ide-ink-dim)", fontWeight: 600 }}>{activeLabel}</span>
    </>
  );

  return (
    <div style={{ ...(projectIdeTokens(theme) as CSSProperties) }}>
      <IdeShell<View>
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        views={VIEWS}
        view={view}
        onSelectView={setView}
        onBack={() => router.push("/studio")}
        backLabel="Back to portfolio"
        breadcrumb={breadcrumb}
        height="100vh"
        chromeless
        statusBadge={project?.status === "ARCHIVED" ? "ARCHIVED" : "PROJECT"}
        topBarExtra={<div style={{ marginLeft: 8 }}><PresenceBar present={present} /></div>}
        statusItems={<>
          <IdeStatusSeg><FolderGit2 size={12} /> {project?.code ?? "…"}</IdeStatusSeg>
          <IdeStatusSeg>shared baseline</IdeStatusSeg>
        </>}
        statusRight={<IdeStatusSeg>{items.length} work item{items.length === 1 ? "" : "s"}</IdeStatusSeg>}
      >
        {projectSWR.isLoading ? (
          <p style={{ ...muted, marginTop: 8 }}>Loading…</p>
        ) : projectSWR.error || !project ? (
          <div style={{ ...panel, padding: 16, ...muted }}>Couldn&apos;t load this project. <Link href="/studio" style={{ ...ghostBtn, marginLeft: 8 }}>Back to Studio</Link></div>
        ) : (
          <div style={{ maxWidth: 1040 }}>
            {actionError && <div style={errorBanner}>{actionError}</div>}

            {view === "overview" && (<>
              {/* Mission + archive */}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: 13.5, maxWidth: "62ch", ...muted }}>{project.mission || "No mission set yet."}</p>
                </div>
                {project.status !== "ARCHIVED" && (
                  <button style={{ ...ghostBtn, marginLeft: "auto" }} type="button" onClick={archive}><Archive size={13} /> Archive</button>
                )}
              </div>

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

            {view === "analysis" && <ProjectAnalysisSurface projectId={projectId} />}
            {view === "requirements" && <ProjectRequirementsSurface projectId={projectId} />}
            {view === "design" && <ProjectDesignSurface projectId={projectId} />}
            {view === "reconciliation" && <ProjectReconciliationReport projectId={projectId} />}
            {view === "rooms" && <ProjectRoomsSurface projectId={projectId} />}
            {view === "coedit" && <CoeditCanvas projectId={projectId} docKey="canvas" surface="coedit" title="Project canvas — live" placeholder="Draft the spec together — problem statements, open questions, sketches. Edits merge live." />}
          </div>
        )}
      </IdeShell>
    </div>
  );
}

const muted: CSSProperties = { color: "var(--studio-ink-dim)" };
const sectionLabel: CSSProperties = { fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--studio-muted)", margin: "24px 0 13px" };
const panel: CSSProperties = { background: "var(--studio-panel)", border: "1px solid var(--studio-line)", borderRadius: 12 };
const statusChip: CSSProperties = { fontSize: 10.5, fontWeight: 700, color: "var(--studio-ink-dim)", background: "var(--studio-panel-2)", border: "1px solid var(--studio-line)", borderRadius: 6, padding: "2px 8px" };
const mono: CSSProperties = { fontFamily: "var(--studio-mono)", fontSize: 12, color: "var(--studio-accent-2)", fontWeight: 600, textDecoration: "none" };
const ghostBtn: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 7, background: "var(--studio-panel-2)", color: "var(--studio-ink)", border: "1px solid var(--studio-line)", borderRadius: 9, padding: "7px 13px", fontSize: 12.5, fontWeight: 650, cursor: "pointer", textDecoration: "none" };
const errorBanner: CSSProperties = { marginBottom: 14, padding: "10px 14px", fontSize: 12.5, color: "var(--studio-bad)", background: "var(--studio-bad-soft)", border: "1px solid var(--studio-bad)", borderRadius: 10 };
