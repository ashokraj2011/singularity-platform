"use client";

import Link from "next/link";
import { useState, type CSSProperties } from "react";
import useSWR from "swr";
import { Boxes, Plus, FolderGit2, FileText, Link2, RefreshCw, ArrowRight } from "lucide-react";
import { workgraphFetch } from "@/lib/workgraph";

/**
 * Studio — the top-level, project-rooted front door. Lists Specification Projects (the optional
 * project-level root that groups the shared upstream) and the standalone work items that haven't
 * joined one. A project is opt-in: a solo item keeps its own spec; attaching lets it draw a
 * project's shared analysis/design. Backed by /api/studio (workgraph-api).
 */

type Project = {
  id: string;
  code: string;
  name: string;
  mission?: string | null;
  status?: string | null;
  workItemCount: number;
  createdAt?: string | null;
};
type StandaloneItem = {
  id: string;
  workCode?: string | null;
  title?: string | null;
  status?: string | null;
  urgency?: string | null;
};
type Portfolio = { projects: Project[]; standaloneWorkItems: StandaloneItem[] };

const muted: CSSProperties = { color: "var(--color-on-surface-variant)" };
const sectionLabel: CSSProperties = {
  fontSize: 11, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase",
  color: "var(--color-on-surface-variant)", margin: "28px 0 14px",
};

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

  return (
    <div style={{ maxWidth: 1120, margin: "0 auto", padding: "8px 4px 40px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 11, display: "grid", placeItems: "center", background: "var(--color-primary-container, var(--color-surface-low))", color: "var(--color-primary)" }}>
            <Boxes size={22} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>Studio</h1>
            <p style={{ margin: "3px 0 0", fontSize: 13, ...muted }}>Project-rooted specification studio — analysis, requirements, design, and reconciliation.</p>
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn-secondary text-xs" type="button" onClick={() => mutate()} title="Refresh"><RefreshCw size={13} /> Refresh</button>
          <button className="btn-primary text-xs" type="button" onClick={() => setCreateOpen((v) => !v)}><Plus size={14} /> New project</button>
        </div>
      </div>

      {actionError && <div className="card" style={{ marginTop: 14, padding: "10px 14px", fontSize: 12.5, color: "#991b1b", background: "#fef2f2", borderColor: "#fecaca" }}>{actionError}</div>}

      {createOpen && (
        <div className="card" style={{ marginTop: 14, padding: 16, display: "grid", gap: 10 }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name — e.g. Payments Reliability"
            style={inputStyle} />
          <input value={mission} onChange={(e) => setMission(e.target.value)} placeholder="Mission (optional) — the one-line goal this project drives"
            style={inputStyle} />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-primary text-xs" type="button" disabled={!name.trim() || busy} onClick={createProject}>{busy ? "Creating…" : "Create project"}</button>
            <button className="btn-secondary text-xs" type="button" onClick={() => setCreateOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Projects */}
      <div style={sectionLabel}>Projects {projects.length > 0 && <span style={{ color: "var(--color-outline)" }}>· {projects.length}</span>}</div>
      {isLoading ? (
        <p style={muted}>Loading…</p>
      ) : error ? (
        <div className="card" style={{ padding: 16, ...muted }}>Couldn&apos;t load the studio. <button className="btn-secondary text-xs" onClick={() => mutate()} style={{ marginLeft: 8 }}>Retry</button></div>
      ) : projects.length === 0 ? (
        <div className="card" style={{ padding: 24, textAlign: "center", ...muted }}>
          <FolderGit2 size={26} style={{ opacity: 0.6 }} />
          <p style={{ margin: "8px 0 0", fontWeight: 600, color: "var(--color-on-surface)" }}>No projects yet</p>
          <p style={{ margin: "4px 0 0", fontSize: 12.5 }}>Create a project to gather the shared analysis, requirements, and design that many work items build on.</p>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
          {projects.map((p) => (
            <Link key={p.id} href={`/studio/${p.id}`} className="card card-hover" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10, textDecoration: "none", color: "inherit" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <FolderGit2 size={16} style={{ color: "var(--color-primary)" }} />
                <span style={{ fontSize: 15, fontWeight: 750, letterSpacing: "-0.01em" }}>{p.name}</span>
                <ArrowRight size={14} style={{ marginLeft: "auto", ...muted }} />
              </div>
              <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, minHeight: 36, ...muted }}>{p.mission || "No mission set yet."}</p>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
                <span className="badge badge-draft" style={{ fontFamily: "var(--font-mono, monospace)" }}>{p.code}</span>
                <span style={{ marginLeft: "auto", fontSize: 11.5, ...muted }}>{p.workItemCount} work item{p.workItemCount === 1 ? "" : "s"}</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Standalone work items */}
      <div style={sectionLabel}>Standalone work items {standalone.length > 0 && <span style={{ color: "var(--color-outline)" }}>· not in a project</span>}</div>
      {standalone.length === 0 ? (
        <div className="card" style={{ padding: 16, fontSize: 12.5, ...muted }}>Every work item is attached to a project — nothing standalone right now.</div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          {standalone.map((w, i) => (
            <div key={w.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", borderTop: i === 0 ? "none" : "1px solid var(--color-outline-variant)", flexWrap: "wrap" }}>
              <FileText size={15} style={muted} />
              <Link href={`/workflows/work/workitem/${w.id}`} style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12, color: "var(--color-primary)", fontWeight: 600, textDecoration: "none" }}>{w.workCode || w.id.slice(0, 8)}</Link>
              <span style={{ fontWeight: 600 }}>{w.title || "Untitled"}</span>
              <span className="badge badge-draft" style={{ textTransform: "none" }}>{String(w.status ?? "").toLowerCase() || "queued"}</span>
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
  );
}

function AttachControl({ projects, onAttach }: { projects: Project[]; onAttach: (projectId: string) => void }) {
  const [value, setValue] = useState("");
  if (projects.length === 0) return <span style={{ fontSize: 11.5, color: "var(--color-outline)" }}>create a project first</span>;
  return (
    <select
      value={value}
      onChange={(e) => { const v = e.target.value; setValue(""); if (v) onAttach(v); }}
      style={{ fontSize: 12, padding: "5px 8px", borderRadius: 8, border: "1px solid var(--color-outline-variant)", background: "var(--color-surface)", color: "var(--color-on-surface)" }}
      aria-label="Attach to project"
    >
      <option value="">Attach to…</option>
      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
}

const inputStyle: CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 9, fontSize: 13,
  border: "1px solid var(--color-outline-variant)", background: "var(--color-surface)", color: "var(--color-on-surface)",
};
