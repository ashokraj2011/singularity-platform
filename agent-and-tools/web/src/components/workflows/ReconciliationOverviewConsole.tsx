"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import useSWR from "swr";
import { RefreshCw, ClipboardCheck, GitPullRequest } from "lucide-react";
import { formatDate, shortId, workgraphFetch } from "@/lib/workgraph";

/**
 * Reconciliation overview — a cross-Work-Item operator cockpit. Lists recent reconciliation runs
 * and implementation submissions across every Work Item, with status tallies, and deep-links each
 * row into the Work Item workspace. Reads GET /reconciliation-overview (via the workgraph proxy).
 */

interface Overview {
  summary: {
    reconciliations: { total: number; byStatus: Record<string, number> };
    submissions: { total: number; byStatus: Record<string, number> };
  };
  recentReconciliations: Array<{
    id: string; workItemId: string; workCode: string | null; title: string | null;
    status: string; mode: string; summary: { pass?: number; partial?: number; fail?: number } | null; createdAt: string;
  }>;
  recentSubmissions: Array<{
    id: string; workItemId: string; workCode: string | null; title: string | null;
    repository: string; headCommitSha: string; pullRequestNumber: number | null; status: string; source: string; createdAt: string;
  }>;
}

const TONE: Record<string, string> = {
  PASSED: "#15803d", FAILED: "#b91c1c", PARTIAL: "#b45309", RUNNING: "#2563eb", ERROR: "#b91c1c", PENDING: "#64748b",
  RECEIVED: "#2563eb", REJECTED: "#b91c1c", DISCOVERED: "#64748b", ACCEPTED: "#15803d",
};

function badge(status: string): CSSProperties {
  const tone = TONE[status] ?? "#64748b";
  return { display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 800, color: tone, background: `${tone}1a` };
}

const th: CSSProperties = { textAlign: "left", padding: "6px 10px", fontSize: 11, fontWeight: 800, color: "var(--color-outline)", whiteSpace: "nowrap" };
const td: CSSProperties = { padding: "7px 10px", fontSize: 12, borderTop: "1px solid var(--color-outline-variant)", verticalAlign: "top" };

export function ReconciliationOverviewConsole() {
  const { data, isLoading, mutate } = useSWR<Overview>(
    "/reconciliation-overview",
    (url: string) => workgraphFetch<Overview>(url),
    { refreshInterval: 15000 },
  );

  const recon = data?.summary.reconciliations;
  const subs = data?.summary.submissions;

  return (
    <div style={{ maxWidth: 1360 }}>
      <section className="card" style={{ padding: 22, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 8 }}>Workgraph</div>
            <h1 className="page-header" style={{ marginBottom: 8 }}>Reconciliation</h1>
            <p style={{ margin: 0, maxWidth: 760, color: "var(--color-outline)", fontSize: 14, lineHeight: 1.55 }}>
              Every implementation submission and reconciliation run across your Work Items. Open a row to jump into its workspace.
            </p>
          </div>
          <button className="btn-secondary" type="button" onClick={() => void mutate()}><RefreshCw size={15} /> Refresh</button>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 16 }}>
        <Metric label="Reconciliations" value={recon?.total ?? 0} />
        <Metric label="Passed" value={recon?.byStatus.PASSED ?? 0} tone={TONE.PASSED} />
        <Metric label="Failed" value={recon?.byStatus.FAILED ?? 0} tone={TONE.FAILED} />
        <Metric label="Running" value={recon?.byStatus.RUNNING ?? 0} tone={TONE.RUNNING} />
        <Metric label="Submissions" value={subs?.total ?? 0} />
        <Metric label="Rejected" value={subs?.byStatus.REJECTED ?? 0} tone={TONE.REJECTED} />
      </section>

      <section className="card" style={{ padding: 18, marginBottom: 16 }}>
        <h2 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, margin: "0 0 12px" }}><ClipboardCheck size={16} /> Recent reconciliations</h2>
        {isLoading ? <Muted>Loading…</Muted> : (data?.recentReconciliations.length ?? 0) === 0 ? <Muted>No reconciliation runs yet.</Muted> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["Work Item", "Status", "Mode", "Pass / Partial / Fail", "When", ""].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {data!.recentReconciliations.map((r) => (
                  <tr key={r.id}>
                    <td style={td}><strong>{r.workCode ?? shortId(r.workItemId)}</strong>{r.title ? <span style={{ color: "var(--color-outline)" }}> · {r.title}</span> : null}</td>
                    <td style={td}><span style={badge(r.status)}>{r.status}</span></td>
                    <td style={td}>{r.mode}</td>
                    <td style={td}>{(r.summary?.pass ?? 0)} / {(r.summary?.partial ?? 0)} / {(r.summary?.fail ?? 0)}</td>
                    <td style={td}>{formatDate(r.createdAt)}</td>
                    <td style={td}><Link className="btn-secondary text-xs" href={`/workflows/work/workitem/${r.workItemId}?tab=reconciliation`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, margin: "0 0 12px" }}><GitPullRequest size={16} /> Recent submissions</h2>
        {isLoading ? <Muted>Loading…</Muted> : (data?.recentSubmissions.length ?? 0) === 0 ? <Muted>No submissions yet.</Muted> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["Work Item", "Repository", "PR", "Head", "Status", "Source", "When", ""].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {data!.recentSubmissions.map((s) => (
                  <tr key={s.id}>
                    <td style={td}><strong>{s.workCode ?? shortId(s.workItemId)}</strong></td>
                    <td style={td}>{s.repository}</td>
                    <td style={td}>{s.pullRequestNumber ?? "—"}</td>
                    <td style={td}><code>{s.headCommitSha?.slice(0, 10)}</code></td>
                    <td style={td}><span style={badge(s.status)}>{s.status}</span></td>
                    <td style={td}>{s.source}</td>
                    <td style={td}>{formatDate(s.createdAt)}</td>
                    <td style={td}><Link className="btn-secondary text-xs" href={`/workflows/work/workitem/${s.workItemId}?tab=submissions`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="label-xs" style={{ color: "var(--color-outline)", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: tone ?? "var(--color-on-surface)" }}>{value}</div>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: 0, fontSize: 13, color: "var(--color-outline)" }}>{children}</p>;
}
