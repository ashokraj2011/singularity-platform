"use client";

import Link from "next/link";
import { useState, type CSSProperties } from "react";
import useSWR from "swr";
import { Plus, FolderGit2, FileText, Link2, RefreshCw, ArrowRight } from "lucide-react";
import { workgraphFetch } from "@/lib/workgraph";
import { StudioShell } from "./StudioShell";

/**
 * Studio — the top-level, project-rooted front door, in the dark ELM Studio look. Lists Specification
 * Projects (the optional project-level root that groups the shared upstream) and the standalone work
 * items that haven't joined one. A project is opt-in: a solo item keeps its own spec; attaching lets
 * it draw a project's shared analysis/design. Backed by /api/studio (workgraph-api).
 */

type Project = { id: string; code: string; name: string; mission?: string | null; status?: string | null; workItemCount: number };
type StandaloneItem = { id: string; workCode?: string | null; title?: string | null; status?: string | null; urgency?: string | null };
type Portfolio = { projects: Project[]; standaloneWorkItems: StandaloneItem[] };

export function StudioPortfolioConsole() {
  const { data, error, isLoading, mutate } = useSWR<Portfolio>(
    "/studio/portfolio",
    (url: string) => workgraphFetch<Portfolio>(url),
    { refreshInterval: 15000 },
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [mission, setMission] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const projects = data?.projects ?? [];
  const standalone = data?.standaloneWorkItems ?? [];

  async function createProject() {
    if (!name.trim()) return;
    setBusy(true); setActionError(null);
    try {
      await workgraphFetch("/studio/projects", { method: "POST", body: JSON.stringify({ name: name.trim(), mission: mission.trim() || undefined }) });
      setName(""); setMission(""); setCreateOpen(false); await mutate();
    } catch (err) { setActionError(err instanceof Error ? err.message : "Could not create the project."); }
    finally { setBusy(false); }
  }

  async function attach(workItemId: string, projectId: string) {
    if (!projectId) return;
    setActionError(null);
    try {
      await workgraphFetch(`/studio/projects/${projectId}/work-items/${workItemId}`, { method: "POST", body: "{}" });
      await mutate();
    } catch (err) { setActionError(err instanceof Error ? err.message : "Could not attach the work item."); }
  }

  const actions = (
    <>
      <button style={ghostBtn} type="button" onClick={() => mutate()} title="Refresh"><RefreshCw size={13} /> Refresh</button>
      <button style={primaryBtn} type="button" onClick={() => setCreateOpen((v) => !v)}><Plus size={14} /> New project</button>
    </>
  );

  return (
    <StudioShell actions={actions}>
      <div style={{ maxWidth: 1120, margin: "0 auto" }}>
        {actionError && <div style={errorBanner}>{actionError}</div>}

        {createOpen && (
          <div style={{ ...panel, padding: 16, display: "grid", gap: 10, marginBottom: 18 }}>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name — e.g. Payments Reliability" style={input} />
            <input value={mission} onChange={(e) => setMission(e.target.value)} placeholder="Mission (optional) — the one-line goal this project drives" style={input} />
            <div style={{ display: "flex", gap: 8 }}>
              <button style={primaryBtn} type="button" disabled={!name.trim() || busy} onClick={createProject}>{busy ? "Creating…" : "Create project"}</button>
              <button style={ghostBtn} type="button" onClick={() => setCreateOpen(false)}>Cancel</button>
            </div>
          </div>
        )}

        {/* Projects */}
        <div style={sectionLabel}>Projects {projects.length > 0 && <span style={{ color: "var(--studio-faint)" }}>· {projects.length}</span>}</div>
        {isLoading ? (
          <p style={muted}>Loading…</p>
        ) : error ? (
          <div style={{ ...panel, padding: 16, ...muted }}>Couldn&apos;t load the studio. <button style={{ ...ghostBtn, marginLeft: 8 }} onClick={() => mutate()}>Retry</button></div>
        ) : projects.length === 0 ? (
          <div style={{ ...panel, padding: 30, textAlign: "center" }}>
            <FolderGit2 size={28} style={{ color: "var(--studio-accent-2)", opacity: 0.9 }} />
            <p style={{ margin: "10px 0 0", fontWeight: 700, fontSize: 15 }}>No projects yet</p>
            <p style={{ margin: "5px 0 0", fontSize: 12.5, ...muted }}>Create a project to gather the shared analysis, requirements, and design that many work items build on.</p>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
            {projects.map((p) => <ProjectCard key={p.id} p={p} />)}
          </div>
        )}

        {/* Standalone work items */}
        <div style={sectionLabel}>Standalone work items {standalone.length > 0 && <span style={{ color: "var(--studio-faint)" }}>· not in a project</span>}</div>
        {standalone.length === 0 ? (
          <div style={{ ...panel, padding: 16, fontSize: 12.5, ...muted }}>Every work item is attached to a project — nothing standalone right now.</div>
        ) : (
          <div style={{ ...panel, overflow: "hidden", padding: 0 }}>
            {standalone.map((w, i) => (
              <div key={w.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 15px", borderTop: i === 0 ? "none" : "1px solid var(--studio-line-soft)", flexWrap: "wrap" }}>
                <FileText size={15} style={muted} />
                <Link href={`/workflows/work/workitem/${w.id}`} style={mono}>{w.workCode || w.id.slice(0, 8)}</Link>
                <span style={{ fontWeight: 600 }}>{w.title || "Untitled"}</span>
                <span style={soloTag}>solo</span>
                <span style={statusChip}>{String(w.status ?? "").toLowerCase() || "queued"}</span>
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                  <Link2 size={13} style={muted} />
                  <AttachControl projects={projects} onAttach={(pid) => attach(w.id, pid)} />
                </div>
              </div>
            ))}
          </div>
        )}
        <p style={{ marginTop: 10, fontSize: 11.5, ...muted }}>Attaching a work item lets it draw the project&apos;s shared analysis and design. It stays reconcilable on its own.</p>
      </div>
    </StudioShell>
  );
}

function ProjectCard({ p }: { p: Project }) {
  return (
    <Link href={`/studio/${p.id}`} style={pcard} className="studio-pcard">
      <span style={{ position: "absolute", inset: "0 0 auto 0", height: 3, background: "linear-gradient(90deg, var(--studio-accent), transparent)" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ width: 9, height: 9, borderRadius: 3, background: "var(--studio-accent)", flex: "none" }} />
        <span style={{ fontSize: 15, fontWeight: 750, letterSpacing: "-0.01em" }}>{p.name}</span>
        <ArrowRight size={14} style={{ marginLeft: "auto", color: "var(--studio-muted)" }} />
      </div>
      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, minHeight: 36, color: "var(--studio-ink-dim)" }}>{p.mission || "No mission set yet."}</p>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
        <span style={codeChip}>{p.code}</span>
        <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--studio-muted)", fontVariantNumeric: "tabular-nums" }}>{p.workItemCount} work item{p.workItemCount === 1 ? "" : "s"}</span>
      </div>
    </Link>
  );
}

function AttachControl({ projects, onAttach }: { projects: Project[]; onAttach: (projectId: string) => void }) {
  const [value, setValue] = useState("");
  if (projects.length === 0) return <span style={{ fontSize: 11.5, color: "var(--studio-faint)" }}>create a project first</span>;
  return (
    <select value={value} onChange={(e) => { const v = e.target.value; setValue(""); if (v) onAttach(v); }} style={select} aria-label="Attach to project">
      <option value="">Attach to…</option>
      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
}

const muted: CSSProperties = { color: "var(--studio-ink-dim)" };
const sectionLabel: CSSProperties = { fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--studio-muted)", margin: "26px 0 13px" };
const panel: CSSProperties = { background: "var(--studio-panel)", border: "1px solid var(--studio-line)", borderRadius: 12 };
const pcard: CSSProperties = {
  position: "relative", padding: 16, display: "flex", flexDirection: "column", gap: 10,
  textDecoration: "none", color: "var(--studio-ink)",
  background: "var(--studio-panel-2)", border: "1px solid var(--studio-line)", borderRadius: 12, overflow: "hidden",
};
const codeChip: CSSProperties = { fontFamily: "var(--studio-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--studio-accent-2)", background: "var(--studio-accent-soft)", borderRadius: 6, padding: "3px 8px" };
const statusChip: CSSProperties = { fontSize: 10.5, fontWeight: 700, color: "var(--studio-ink-dim)", background: "var(--studio-panel)", border: "1px solid var(--studio-line)", borderRadius: 6, padding: "2px 8px" };
const soloTag: CSSProperties = { fontSize: 9.5, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--studio-muted)", border: "1px dashed var(--studio-line)", borderRadius: 5, padding: "2px 7px" };
const mono: CSSProperties = { fontFamily: "var(--studio-mono)", fontSize: 12, color: "var(--studio-accent-2)", fontWeight: 600, textDecoration: "none" };
const input: CSSProperties = { width: "100%", padding: "9px 12px", borderRadius: 9, fontSize: 13, border: "1px solid var(--studio-line)", background: "var(--studio-chrome)", color: "var(--studio-ink)" };
const select: CSSProperties = { fontSize: 12, padding: "5px 8px", borderRadius: 8, border: "1px solid var(--studio-line)", background: "var(--studio-chrome)", color: "var(--studio-ink)" };
const primaryBtn: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 7, background: "var(--studio-accent)", color: "#fff", border: "none", borderRadius: 9, padding: "8px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" };
const ghostBtn: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 7, background: "var(--studio-panel-2)", color: "var(--studio-ink)", border: "1px solid var(--studio-line)", borderRadius: 9, padding: "7px 13px", fontSize: 12.5, fontWeight: 650, cursor: "pointer" };
const errorBanner: CSSProperties = { marginBottom: 16, padding: "10px 14px", fontSize: 12.5, color: "#fecaca", background: "rgba(242,104,138,0.12)", border: "1px solid var(--studio-bad)", borderRadius: 10 };
