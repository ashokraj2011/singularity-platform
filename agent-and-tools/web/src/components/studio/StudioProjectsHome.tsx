"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { workgraphFetch } from "@/lib/workgraph";

/**
 * Studio home: the portfolio of Specification Projects. A project is the top-level unit —
 * open one to work its analysis / requirements / design / rooms / board, then generate the
 * work items from it. (Projects were previously reachable only by burrowing into a Work Item;
 * this is the front door.)
 */
interface ProjectItem { id: string; code: string; name: string; mission?: string | null; workItemCount?: number }

export function StudioProjectsHome() {
  const [projects, setProjects] = useState<ProjectItem[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await workgraphFetch<{ items: ProjectItem[] }>(`/studio/projects`);
      setProjects(r.items ?? []);
    } catch { setProjects([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = useCallback(async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await workgraphFetch<ProjectItem>(`/studio/projects`, { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      setName("");
      await load();
    } catch { /* ignore */ } finally { setBusy(false); }
  }, [name, load]);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 20px" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em" }}>Studio</h1>
          <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--color-outline)" }}>Specification projects — the shared upstream. Work items are generated from here.</p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name" onKeyDown={(e) => { if (e.key === "Enter") void create(); }} style={inputStyle} />
          <button onClick={() => void create()} disabled={busy} style={primaryBtn}>{busy ? "Creating…" : "New project"}</button>
        </div>
      </div>

      {projects === null ? (
        <div style={{ fontSize: 12.5, color: "var(--color-outline)" }}>Loading…</div>
      ) : projects.length === 0 ? (
        <div className="card" style={{ padding: 28, textAlign: "center", color: "var(--color-outline)", fontSize: 12.5 }}>No projects yet — create one to start.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
          {projects.map((p) => (
            <Link key={p.id} href={`/studio/${p.id}`} className="card" style={cardStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={codeChip}>{p.code}</span>
                <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--color-outline)" }}>{p.workItemCount ?? 0} items</span>
              </div>
              <div style={{ marginTop: 8, fontSize: 14, fontWeight: 650 }}>{p.name}</div>
              {p.mission && <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--color-outline)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{p.mission}</div>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

const inputStyle: CSSProperties = { fontSize: 12.5, padding: "7px 11px", borderRadius: 8, border: "1px solid var(--color-outline-variant)", background: "var(--color-surface)", color: "var(--color-on-surface)", minWidth: 180 };
const primaryBtn: CSSProperties = { fontSize: 12.5, fontWeight: 650, padding: "7px 14px", borderRadius: 8, border: "none", background: "var(--color-primary, #6366f1)", color: "#fff", cursor: "pointer" };
const cardStyle: CSSProperties = { display: "block", padding: 14, textDecoration: "none", color: "var(--color-on-surface)", cursor: "pointer" };
const codeChip: CSSProperties = { fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 5, fontVariantNumeric: "tabular-nums", background: "var(--color-surface-container-high, rgba(15,23,42,0.06))", color: "var(--color-outline)" };
