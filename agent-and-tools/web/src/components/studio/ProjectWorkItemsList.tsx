"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { workgraphFetch } from "@/lib/workgraph";

/**
 * Work Items belonging to a project — the downstream artifacts generated from its spec.
 * SPEC_GENERATED items carry a specSourceRef back to the locked requirement slice; AD_HOC/
 * delegated items are shown too. The generation authoring flow (compose → validate → apply)
 * lands in a follow-up; this is where the results appear.
 */
interface WorkItem { id: string; workCode?: string; title: string; status?: string; originType?: string }

export function ProjectWorkItemsList({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<WorkItem[] | null>(null);

  useEffect(() => {
    let active = true;
    workgraphFetch<{ items: WorkItem[] }>(`/studio/projects/${projectId}/work-items`)
      .then((r) => { if (active) setItems(r.items ?? []); })
      .catch(() => { if (active) setItems([]); });
    return () => { active = false; };
  }, [projectId]);

  if (items === null) return <div style={{ fontSize: 12.5, color: "var(--color-outline)" }}>Loading work items…</div>;
  if (items.length === 0) {
    return (
      <div className="card" style={{ padding: 24, maxWidth: 640 }}>
        <b style={{ fontSize: 13 }}>No work items yet</b>
        <p style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--color-outline)", lineHeight: 1.5 }}>
          Work items are generated from this project&apos;s locked specification — each becomes one execution item with a scoped requirement slice. Once the generation flow is wired here, applying a plan will populate this list.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 820 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.04em", color: "var(--color-outline)", textTransform: "uppercase" }}>
        {items.length} work item{items.length === 1 ? "" : "s"}
      </div>
      {items.map((wi) => (
        <a key={wi.id} href={`/work-items/${wi.id}`} style={rowStyle}>
          {wi.workCode && <span style={codeChip}>{wi.workCode}</span>}
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 550, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{wi.title}</span>
          {wi.originType === "SPEC_GENERATED" && <span style={genChip}>generated</span>}
          {wi.status && <span style={statusChip}>{wi.status}</span>}
        </a>
      ))}
    </div>
  );
}

const rowStyle: CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 9, textDecoration: "none",
  border: "1px solid var(--color-outline-variant)", background: "var(--color-surface)", color: "var(--color-on-surface)",
};
const codeChip: CSSProperties = { fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 5, fontVariantNumeric: "tabular-nums", background: "var(--color-surface-container-high, rgba(15,23,42,0.06))", color: "var(--color-outline)", flexShrink: 0 };
const genChip: CSSProperties = { fontSize: 9.5, fontWeight: 700, padding: "2px 7px", borderRadius: 999, background: "rgba(99,102,241,0.14)", color: "#6366f1", flexShrink: 0, letterSpacing: "0.03em", textTransform: "uppercase" };
const statusChip: CSSProperties = { fontSize: 9.5, fontWeight: 700, padding: "2px 7px", borderRadius: 999, background: "var(--color-surface-container-high, rgba(15,23,42,0.06))", color: "var(--color-outline)", flexShrink: 0, letterSpacing: "0.03em", textTransform: "uppercase" };
