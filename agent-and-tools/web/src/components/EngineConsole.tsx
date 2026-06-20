"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import {
  AlertTriangle, BarChart3, CheckCircle2, Eye, RefreshCw, Search,
  ShieldCheck, XCircle, Zap,
} from "lucide-react";
import { auditGovApi } from "@/lib/api";

type EngineIssue = {
  id: string;
  title?: string | null;
  severity?: string | null;
  status?: string | null;
  category?: string | null;
  capability_id?: string | null;
  trace_count?: number | null;
  affected_pct?: number | null;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  error_pattern?: string | null;
  description?: string | null;
  root_cause?: Record<string, unknown> | null;
  proposed_fix?: Record<string, unknown> | null;
  sample_trace_ids?: string[];
};

type Evaluator = {
  id: string;
  name?: string | null;
  evaluator_type?: string | null;
  enabled?: boolean | null;
  fire_count?: number | null;
  pass_count?: number | null;
  fail_count?: number | null;
};

const STAT_LABELS: Array<[string, string]> = [
  ["open_issues", "Open issues"],
  ["critical_open", "Critical open"],
  ["high_open", "High open"],
  ["resolved_this_week", "Resolved this week"],
  ["active_evaluators", "Active evaluators"],
  ["total_eval_failures", "Eval failures"],
];

const FILTERS = ["open", "fix_proposed", "resolved", "dismissed", "all"];

function asIssue(value: Record<string, unknown>): EngineIssue {
  return value as EngineIssue;
}

function fmtTime(value?: string | null): string {
  if (!value) return "unknown";
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return value;
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function statusIcon(status?: string | null) {
  if (status === "resolved") return CheckCircle2;
  if (status === "dismissed") return XCircle;
  if (status === "fix_proposed") return Zap;
  return AlertTriangle;
}

function severityTone(severity?: string | null) {
  if (severity === "critical") return { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" };
  if (severity === "high") return { bg: "#fff7ed", fg: "#9a3412", border: "#fed7aa" };
  if (severity === "medium") return { bg: "#fffbeb", fg: "#92400e", border: "#fde68a" };
  return { bg: "rgba(70,80,99,0.08)", fg: "var(--color-outline)", border: "var(--color-outline-variant)" };
}

function JsonBlock({ value }: { value: unknown }) {
  if (!value || (typeof value === "object" && Object.keys(value as Record<string, unknown>).length === 0)) {
    return <p style={{ color: "var(--color-outline)", fontSize: 13 }}>No details recorded.</p>;
  }
  return (
    <pre style={{
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      background: "var(--color-surface-container)",
      border: "1px solid var(--color-outline-variant)",
      borderRadius: 8,
      padding: 12,
      fontSize: 12,
      color: "var(--color-on-surface)",
      maxHeight: 260,
      overflow: "auto",
    }}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function EngineConsole() {
  const [status, setStatus] = useState("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const stats = useSWR("engine-stats", () => auditGovApi.engineStats(), { refreshInterval: 30_000 });
  const issues = useSWR(["engine-issues", status], () => auditGovApi.engineIssues({ status, limit: 50 }), { refreshInterval: 30_000 });
  const detail = useSWR(selectedId ? ["engine-issue", selectedId] : null, () => auditGovApi.engineIssue(selectedId as string));
  const evaluators = useSWR("engine-evaluators", () => auditGovApi.engineEvaluators({ enabled: true }), { refreshInterval: 60_000 });

  const issueItems = useMemo(() => (issues.data?.items ?? []).map(asIssue), [issues.data]);
  const selected = detail.data as EngineIssue | undefined;

  async function mutateAll() {
    await Promise.all([stats.mutate(), issues.mutate(), detail.mutate(), evaluators.mutate()]);
  }

  async function runAction(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setActionError(null);
    try {
      await fn();
      await mutateAll();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ maxWidth: 1320 }}>
      <section style={{ marginBottom: 20 }}>
        <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 10 }}>Governance</div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <h1 className="page-header" style={{ fontSize: "2rem", marginBottom: 8 }}>Singularity Engine</h1>
            <p style={{ maxWidth: 760, color: "var(--color-outline)", lineHeight: 1.6, fontSize: 14 }}>
              Failure triage, root-cause diagnosis, evaluator creation, and sweep control from the legacy Portal surface.
            </p>
          </div>
          <button
            className="btn-primary"
            type="button"
            disabled={busy !== null}
            onClick={() => void runAction("sweep", () => auditGovApi.engineSweep())}
          >
            <RefreshCw size={15} />
            {busy === "sweep" ? "Scanning..." : "Run Sweep"}
          </button>
        </div>
      </section>

      {actionError && (
        <div className="card" style={{ padding: 14, borderColor: "#fecaca", background: "#fef2f2", color: "#991b1b", marginBottom: 16 }}>
          {actionError}
        </div>
      )}

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 18 }}>
        {STAT_LABELS.map(([key, label]) => (
          <div className="card" key={key} style={{ padding: 16 }}>
            <div className="label-xs" style={{ color: "var(--color-outline)", marginBottom: 8 }}>{label}</div>
            <div style={{ fontSize: 24, fontWeight: 850, color: "var(--color-on-surface)" }}>
              {stats.isLoading ? "..." : String(stats.data?.[key] ?? 0)}
            </div>
          </div>
        ))}
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "minmax(320px, 0.95fr) minmax(420px, 1.35fr)", gap: 16, alignItems: "start" }}>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: 16, borderBottom: "1px solid var(--color-outline-variant)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 850, color: "var(--color-on-surface)" }}>Issues</h2>
              <p style={{ margin: "4px 0 0", color: "var(--color-outline)", fontSize: 12 }}>Clustered runtime failures and evaluator findings.</p>
            </div>
            <Search size={17} style={{ color: "var(--color-outline)" }} />
          </div>
          <div style={{ padding: 12, display: "flex", gap: 8, flexWrap: "wrap", borderBottom: "1px solid var(--color-outline-variant)" }}>
            {FILTERS.map((item) => (
              <button
                key={item}
                className={status === item ? "btn-primary" : "btn-secondary"}
                type="button"
                style={{ minHeight: 32, padding: "6px 10px", fontSize: 12 }}
                onClick={() => { setStatus(item); setSelectedId(null); }}
              >
                {item.replace("_", " ")}
              </button>
            ))}
          </div>
          <div style={{ maxHeight: 620, overflow: "auto" }}>
            {issues.error && <div style={{ padding: 16, color: "#991b1b" }}>{issues.error.message}</div>}
            {issues.isLoading && <div style={{ padding: 16, color: "var(--color-outline)" }}>Loading issues...</div>}
            {!issues.isLoading && issueItems.length === 0 && (
              <div style={{ padding: 18, color: "var(--color-outline)" }}>No issues found for this filter.</div>
            )}
            {issueItems.map((issue) => {
              const Icon = statusIcon(issue.status);
              const tone = severityTone(issue.severity);
              const active = selectedId === issue.id;
              return (
                <button
                  key={issue.id}
                  type="button"
                  onClick={() => setSelectedId(issue.id)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    border: "none",
                    borderBottom: "1px solid var(--color-outline-variant)",
                    background: active ? "rgba(0,132,61,0.08)" : "transparent",
                    padding: 14,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{ width: 34, height: 34, borderRadius: 8, display: "grid", placeItems: "center", background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}` }}>
                      <Icon size={16} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", color: "var(--color-on-surface)", fontWeight: 800, fontSize: 13 }}>
                        {issue.title ?? issue.error_pattern ?? issue.id}
                      </span>
                      <span style={{ display: "block", marginTop: 4, color: "var(--color-outline)", fontSize: 12 }}>
                        {issue.severity ?? "unknown"} · {issue.status ?? "open"} · {issue.trace_count ?? 0} traces · {fmtTime(issue.last_seen_at)}
                      </span>
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <div className="card" style={{ padding: 18 }}>
            {!selectedId && (
              <div style={{ color: "var(--color-outline)", minHeight: 220, display: "grid", placeItems: "center", textAlign: "center" }}>
                Select an issue to inspect root cause, proposed fix, traces, and actions.
              </div>
            )}
            {selectedId && detail.isLoading && <div style={{ color: "var(--color-outline)" }}>Loading issue...</div>}
            {selectedId && detail.error && <div style={{ color: "#991b1b" }}>{detail.error.message}</div>}
            {selected && (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 14 }}>
                  <div>
                    <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 8 }}>{selected.category ?? "issue"}</div>
                    <h2 style={{ margin: 0, color: "var(--color-on-surface)", fontSize: 20, fontWeight: 850 }}>
                      {selected.title ?? selected.error_pattern ?? selected.id}
                    </h2>
                    <p style={{ marginTop: 8, color: "var(--color-outline)", fontSize: 13, lineHeight: 1.5 }}>
                      {selected.description ?? selected.error_pattern ?? "No description recorded."}
                    </p>
                  </div>
                  <span className="badge" style={{ background: severityTone(selected.severity).bg, color: severityTone(selected.severity).fg, borderColor: severityTone(selected.severity).border }}>
                    {selected.severity ?? "unknown"}
                  </span>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
                  <button className="btn-secondary" disabled={busy !== null} type="button" onClick={() => void runAction("diagnose", () => auditGovApi.engineDiagnose(selected.id))}>
                    <Eye size={14} />
                    {busy === "diagnose" ? "Analyzing..." : "Diagnose"}
                  </button>
                  {selected.status !== "resolved" && (
                    <button className="btn-primary" disabled={busy !== null} type="button" onClick={() => void runAction("resolve", () => auditGovApi.engineResolve(selected.id, { create_evaluator: true, create_dataset: true }))}>
                      <CheckCircle2 size={14} />
                      {busy === "resolve" ? "Resolving..." : "Resolve"}
                    </button>
                  )}
                  {selected.status !== "dismissed" && (
                    <button className="btn-secondary" disabled={busy !== null} type="button" onClick={() => void runAction("dismiss", () => auditGovApi.engineDismiss(selected.id))}>
                      <XCircle size={14} />
                      {busy === "dismiss" ? "Dismissing..." : "Dismiss"}
                    </button>
                  )}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginBottom: 18 }}>
                  <MiniStat icon={BarChart3} label="Trace count" value={String(selected.trace_count ?? 0)} />
                  <MiniStat icon={ShieldCheck} label="Capability" value={selected.capability_id ?? "none"} />
                  <MiniStat icon={RefreshCw} label="Last seen" value={fmtTime(selected.last_seen_at)} />
                </div>

                <h3 style={{ fontSize: 14, fontWeight: 850, color: "var(--color-on-surface)", marginBottom: 8 }}>Root Cause</h3>
                <JsonBlock value={selected.root_cause} />
                <h3 style={{ fontSize: 14, fontWeight: 850, color: "var(--color-on-surface)", margin: "16px 0 8px" }}>Proposed Fix</h3>
                <JsonBlock value={selected.proposed_fix} />
              </div>
            )}
          </div>

          <div className="card" style={{ padding: 18 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 850, color: "var(--color-on-surface)" }}>Active Evaluators</h2>
            <p style={{ margin: "5px 0 14px", color: "var(--color-outline)", fontSize: 12 }}>Auto-created and built-in evaluators available to catch regressions.</p>
            {evaluators.error && <div style={{ color: "#991b1b", fontSize: 13 }}>{evaluators.error.message}</div>}
            <div style={{ display: "grid", gap: 10 }}>
              {((evaluators.data?.items ?? []) as Evaluator[]).slice(0, 8).map((ev) => (
                <div key={ev.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 12 }}>
                  <div>
                    <div style={{ fontWeight: 800, color: "var(--color-on-surface)", fontSize: 13 }}>{ev.name ?? ev.id}</div>
                    <div style={{ color: "var(--color-outline)", fontSize: 12, marginTop: 3 }}>{ev.evaluator_type ?? "evaluator"}</div>
                  </div>
                  <div style={{ textAlign: "right", color: "var(--color-outline)", fontSize: 12 }}>
                    <div>{ev.fire_count ?? 0} runs</div>
                    <div>{ev.fail_count ?? 0} failures</div>
                  </div>
                </div>
              ))}
              {!evaluators.isLoading && (evaluators.data?.items ?? []).length === 0 && (
                <div style={{ color: "var(--color-outline)", fontSize: 13 }}>No active evaluators yet.</div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function MiniStat({ icon: Icon, label, value }: { icon: typeof BarChart3; label: string; value: string }) {
  return (
    <div style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 12, background: "var(--color-surface-container)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--color-outline)", fontSize: 11, fontWeight: 750, textTransform: "uppercase" }}>
        <Icon size={13} />
        {label}
      </div>
      <div style={{ marginTop: 8, color: "var(--color-on-surface)", fontSize: 13, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={value}>
        {value}
      </div>
    </div>
  );
}
