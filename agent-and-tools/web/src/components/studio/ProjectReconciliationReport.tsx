"use client";

import Link from "next/link";
import useSWR from "swr";
import { CheckCircle2, FileText } from "lucide-react";
import { workgraphFetch } from "@/lib/workgraph";
import { reconKey, type ProjectReconciliation } from "./projectSpec";
import { muted } from "./ProjectAnalysisSurface";

/**
 * Project-level reconciliation — the walkthrough's Reconcile screen aggregated across the project's
 * work items. Read-only: a project roll-up (pass/partial/fail + how many items are reconciled) over
 * the latest run per work item, each row deep-linking into that item's reconciliation.
 */
const GOOD = "#15803d";
const WARN = "#b45309";
const BAD = "#b91c1c";

export function ProjectReconciliationReport({ projectId }: { projectId: string }) {
  const { data, error, isLoading, mutate } = useSWR<ProjectReconciliation>(
    reconKey(projectId),
    (url: string) => workgraphFetch<ProjectReconciliation>(url),
    { refreshInterval: 20000 },
  );

  if (isLoading) return <p style={muted}>Loading…</p>;
  if (error || !data) return <div className="card" style={{ padding: 16, ...muted }}>Couldn&apos;t load the reconciliation roll-up. <button className="btn-secondary text-xs" onClick={() => mutate()} style={{ marginLeft: 8 }}>Retry</button></div>;

  const { items, rollup } = data;
  const totalCells = rollup.pass + rollup.partial + rollup.fail;

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 900 }}>
      {/* Roll-up */}
      <div className="card" style={{ padding: 16, display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
        <div style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 24, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
          <span style={{ color: GOOD }}>{rollup.pass}✓</span>{" "}
          <span style={{ color: WARN }}>{rollup.partial}~</span>{" "}
          <span style={{ color: BAD }}>{rollup.fail}✕</span>
        </div>
        <div style={{ fontSize: 12.5, ...muted }}>
          <b style={{ color: "var(--color-on-surface)" }}>{rollup.itemsReconciled}</b> of <b style={{ color: "var(--color-on-surface)" }}>{rollup.itemsTotal}</b> work item{rollup.itemsTotal === 1 ? "" : "s"} reconciled
          <br />across the project&apos;s frozen specs
        </div>
        {totalCells > 0 && (
          <div style={{ display: "flex", height: 9, borderRadius: 999, overflow: "hidden", flex: 1, minWidth: 160 }}>
            {rollup.pass > 0 && <span style={{ flex: rollup.pass, background: GOOD }} />}
            {rollup.partial > 0 && <span style={{ flex: rollup.partial, background: WARN }} />}
            {rollup.fail > 0 && <span style={{ flex: rollup.fail, background: BAD }} />}
          </div>
        )}
      </div>

      {/* Per work item */}
      {items.length === 0 ? (
        <div className="card" style={{ padding: 20, textAlign: "center", ...muted }}>
          <CheckCircle2 size={22} style={{ opacity: 0.6 }} />
          <p style={{ margin: "8px 0 0", fontSize: 12.5 }}>No work items in this project yet. Attach items from the <Link href="/studio" style={{ color: "var(--color-primary)" }}>portfolio</Link> to see their reconciliation here.</p>
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          {items.map(({ workItem: w, latestRun }, i) => (
            <div key={w.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderTop: i === 0 ? "none" : "1px solid var(--color-outline-variant)", flexWrap: "wrap" }}>
              <FileText size={15} style={muted} />
              <Link href={`/workflows/work/workitem/${w.id}?tab=reconciliation`} style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12, color: "var(--color-primary)", fontWeight: 600, textDecoration: "none" }}>{w.workCode || w.id.slice(0, 8)}</Link>
              <span style={{ fontWeight: 600 }}>{w.title || "Untitled"}</span>
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
                {latestRun ? (
                  <>
                    <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
                      <span style={{ color: GOOD }}>{latestRun.counts.pass}✓</span>{" "}
                      <span style={{ color: WARN }}>{latestRun.counts.partial}~</span>{" "}
                      <span style={{ color: BAD }}>{latestRun.counts.fail}✕</span>
                    </span>
                    <span className="badge badge-draft" style={{ textTransform: "none" }}>{String(latestRun.status).toLowerCase()}</span>
                  </>
                ) : (
                  <span style={{ fontSize: 11.5, color: "var(--color-outline)" }}>not reconciled yet</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <p style={{ margin: "2px", fontSize: 11.5, ...muted }}>Each work item reconciles its own frozen spec against what was built; this rolls those verdicts up to the project.</p>
    </div>
  );
}
