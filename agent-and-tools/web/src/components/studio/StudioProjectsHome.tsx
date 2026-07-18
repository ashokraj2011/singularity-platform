"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { workgraphFetch, WorkgraphError } from "@/lib/workgraph";

/**
 * Specifications home: each initiative is the top-level contract unit —
 * open one to work its analysis / requirements / design / rooms / board, then generate the
 * work items from it. (Projects were previously reachable only by burrowing into a Work Item;
 * this is the front door.)
 */
interface ProjectItem { id: string; code: string; name: string; mission?: string | null; workItemCount?: number }

export function StudioProjectsHome() {
  const [projects, setProjects] = useState<ProjectItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await workgraphFetch<{ items: ProjectItem[] }>(`/studio/projects`);
      setProjects(r.items ?? []);
      setError(null);
    } catch (e) {
      setProjects([]);
      setError(e instanceof WorkgraphError ? e.message : "Could not load specifications.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 20px" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em" }}>Specifications</h1>
          <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--color-outline)" }}>Approved initiative contracts are the shared upstream for generated Work Items.</p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Link href="/synthesis/hub" style={primaryBtn}>New initiative</Link>
        </div>
      </div>

      {error && <div role="alert" style={errorBox}>
        <strong>Studio could not complete that request.</strong>
        <span>{error}</span>
        <button onClick={() => void load()} style={retryBtn}>Retry</button>
      </div>}

      {projects === null ? (
        <div style={{ fontSize: 12.5, color: "var(--color-outline)" }}>Loading…</div>
      ) : projects.length === 0 ? (
        <div className="card" style={{ padding: 28, textAlign: "center", color: "var(--color-outline)", fontSize: 12.5 }}>No initiatives yet — create one from Synthesis Hub to assign its capability and guardrails.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
          {projects.map((p) => (
            <Link key={p.id} href={`/synthesis/overview?project=${encodeURIComponent(p.id)}`} className="card" style={cardStyle}>
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

const primaryBtn: CSSProperties = { fontSize: 12.5, fontWeight: 650, padding: "7px 14px", borderRadius: 8, border: "none", background: "var(--color-primary, #6366f1)", color: "#fff", cursor: "pointer" };
const cardStyle: CSSProperties = { display: "block", padding: 14, textDecoration: "none", color: "var(--color-on-surface)", cursor: "pointer" };
const codeChip: CSSProperties = { fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 5, fontVariantNumeric: "tabular-nums", background: "var(--color-surface-container-high, rgba(15,23,42,0.06))", color: "var(--color-outline)" };
const errorBox: CSSProperties = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14, padding: "10px 12px", borderRadius: 8, border: "1px solid rgba(220,38,38,0.28)", background: "rgba(220,38,38,0.07)", color: "#991b1b", fontSize: 12 };
const retryBtn: CSSProperties = { marginLeft: "auto", border: "1px solid rgba(153,27,27,0.35)", borderRadius: 6, padding: "5px 9px", background: "transparent", color: "#991b1b", cursor: "pointer", fontWeight: 650 };
