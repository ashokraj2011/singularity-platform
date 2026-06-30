"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import {
  AlertTriangle, BarChart3, CheckCircle2, Eye, RefreshCw, Search,
  ShieldCheck, XCircle, Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ApiError, auditGovApi } from "@/lib/api";
import {
  EmptyState, ErrorState, JsonPreview, MetricTile, PageHeader, StatusChip, type UiState,
} from "@/components/ui/primitives";

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

// Tailwind tints for icon badges, keyed by the shared UiState.
const TINT: Record<UiState, string> = {
  ready: "bg-emerald-50 text-emerald-700",
  waiting: "bg-amber-50 text-amber-700",
  blocked: "bg-red-50 text-red-700",
  offline: "bg-slate-100 text-slate-500",
  guarded: "bg-blue-50 text-blue-700",
  optional: "bg-slate-50 text-slate-500",
};

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

function statusIcon(status?: string | null): LucideIcon {
  if (status === "resolved") return CheckCircle2;
  if (status === "dismissed") return XCircle;
  if (status === "fix_proposed") return Zap;
  return AlertTriangle;
}

// Maps issue severity onto the shared StatusChip vocabulary.
function severityState(severity?: string | null): UiState {
  if (severity === "critical") return "blocked";
  if (severity === "high" || severity === "medium") return "waiting";
  return "offline";
}

function engineErrorMessage(error: unknown): string | null {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const apiError = error instanceof ApiError ? error : null;
  if (apiError?.code === "AUTH_REQUIRED" || apiError?.code === "AUTH_INVALID" || apiError?.status === 401) {
    return "Sign in again so Platform Web can verify your session before proxying Audit Governance.";
  }
  if (
    apiError?.code === "UPSTREAM_UNREACHABLE"
    || /fetch failed|failed to fetch|ECONNREFUSED|connection refused/i.test(message)
  ) {
    return "Audit Governance is not connected. Start it with `./singularity.sh up --profile audit`, or use `./singularity.sh up --full` when you want the governance engine locally.";
  }
  return message;
}

function JsonBlock({ value }: { value: unknown }) {
  if (!value || (typeof value === "object" && Object.keys(value as Record<string, unknown>).length === 0)) {
    return <p className="text-[13px] text-slate-500">No details recorded.</p>;
  }
  return <JsonPreview value={value} maxHeight={260} />;
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
  const engineError = useMemo(
    () => engineErrorMessage(stats.error ?? issues.error ?? evaluators.error),
    [stats.error, issues.error, evaluators.error],
  );

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
    <div className="max-w-[1320px]">
      <div className="mb-5">
        <PageHeader
          eyebrow="Governance"
          icon={Zap}
          title="Singularity Engine"
          description="Failure triage, root-cause diagnosis, evaluator creation, and sweep control from the legacy Portal surface."
          actions={
            <button
              className="btn-primary"
              type="button"
              disabled={busy !== null}
              onClick={() => void runAction("sweep", () => auditGovApi.engineSweep())}
            >
              <RefreshCw size={15} />
              {busy === "sweep" ? "Scanning..." : "Run Sweep"}
            </button>
          }
        />
      </div>

      {actionError && <div className="mb-4"><ErrorState error={actionError} /></div>}

      {engineError && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-5 text-amber-800">
          {engineError}
        </div>
      )}

      <section className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
        {STAT_LABELS.map(([key, label]) => (
          <MetricTile key={key} label={label} value={stats.isLoading ? "..." : String(stats.data?.[key] ?? 0)} tone="slate" />
        ))}
      </section>

      <section className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(320px,0.95fr)_minmax(420px,1.35fr)]">
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 p-4">
            <div>
              <h2 className="text-base font-bold text-slate-900">Issues</h2>
              <p className="mt-1 text-xs text-slate-500">Clustered runtime failures and evaluator findings.</p>
            </div>
            <Search size={17} className="text-slate-400" />
          </div>
          <div className="flex flex-wrap gap-2 border-b border-slate-200 p-3">
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
          <div className="max-h-[620px] overflow-auto">
            {issues.error && <div className="p-4 text-sm text-red-700">{engineErrorMessage(issues.error)}</div>}
            {issues.isLoading && <div className="p-4 text-sm text-slate-500">Loading issues...</div>}
            {!issues.isLoading && issueItems.length === 0 && (
              <div className="p-4"><EmptyState icon={Search} title="No issues" hint="No issues found for this filter." /></div>
            )}
            {issueItems.map((issue) => {
              const Icon = statusIcon(issue.status);
              const sevState = severityState(issue.severity);
              const active = selectedId === issue.id;
              return (
                <button
                  key={issue.id}
                  type="button"
                  onClick={() => setSelectedId(issue.id)}
                  className={`flex w-full items-start gap-2.5 border-b border-slate-200 p-3.5 text-left transition ${active ? "bg-emerald-50" : "hover:bg-slate-50"}`}
                >
                  <IconBadge icon={Icon} state={sevState} size={16} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-bold text-slate-900">{issue.title ?? issue.error_pattern ?? issue.id}</span>
                    <span className="mt-1 block text-xs text-slate-500">
                      {issue.severity ?? "unknown"} · {issue.status ?? "open"} · {issue.trace_count ?? 0} traces · {fmtTime(issue.last_seen_at)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            {!selectedId && (
              <div className="grid min-h-[220px] place-items-center">
                <EmptyState icon={Eye} title="No issue selected" hint="Select an issue to inspect root cause, proposed fix, traces, and actions." />
              </div>
            )}
            {selectedId && detail.isLoading && <div className="text-sm text-slate-500">Loading issue...</div>}
            {selectedId && detail.error && <ErrorState error={engineErrorMessage(detail.error) ?? "Failed to load issue"} compact />}
            {selected && (
              <div>
                <div className="mb-3.5 flex items-start justify-between gap-3">
                  <div>
                    <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-700">{selected.category ?? "issue"}</div>
                    <h2 className="text-xl font-bold text-slate-900">{selected.title ?? selected.error_pattern ?? selected.id}</h2>
                    <p className="mt-2 text-[13px] leading-5 text-slate-500">{selected.description ?? selected.error_pattern ?? "No description recorded."}</p>
                  </div>
                  <StatusChip state={severityState(selected.severity)} label={selected.severity ?? "unknown"} />
                </div>

                <div className="mb-4 flex flex-wrap gap-2">
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

                <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2.5">
                  <MiniStat icon={BarChart3} label="Trace count" value={String(selected.trace_count ?? 0)} />
                  <MiniStat icon={ShieldCheck} label="Capability" value={selected.capability_id ?? "none"} />
                  <MiniStat icon={RefreshCw} label="Last seen" value={fmtTime(selected.last_seen_at)} />
                </div>

                <h3 className="mb-2 text-sm font-bold text-slate-900">Root Cause</h3>
                <JsonBlock value={selected.root_cause} />
                <h3 className="mb-2 mt-4 text-sm font-bold text-slate-900">Proposed Fix</h3>
                <JsonBlock value={selected.proposed_fix} />
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-base font-bold text-slate-900">Active Evaluators</h2>
            <p className="mb-3.5 mt-1 text-xs text-slate-500">Auto-created and built-in evaluators available to catch regressions.</p>
            {evaluators.error && <ErrorState error={engineErrorMessage(evaluators.error) ?? "Failed to load evaluators"} compact />}
            <div className="grid gap-2.5">
              {((evaluators.data?.items ?? []) as Evaluator[]).slice(0, 8).map((ev) => (
                <div key={ev.id} className="flex justify-between gap-3 rounded-lg border border-slate-200 p-3">
                  <div>
                    <div className="text-[13px] font-bold text-slate-900">{ev.name ?? ev.id}</div>
                    <div className="mt-0.5 text-xs text-slate-500">{ev.evaluator_type ?? "evaluator"}</div>
                  </div>
                  <div className="text-right text-xs text-slate-500">
                    <div>{ev.fire_count ?? 0} runs</div>
                    <div>{ev.fail_count ?? 0} failures</div>
                  </div>
                </div>
              ))}
              {!evaluators.isLoading && (evaluators.data?.items ?? []).length === 0 && (
                <div className="text-[13px] text-slate-500">No active evaluators yet.</div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function MiniStat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase text-slate-500">
        <Icon size={13} />
        {label}
      </div>
      <div className="mt-2 truncate text-[13px] font-bold text-slate-800" title={value}>
        {value}
      </div>
    </div>
  );
}

function IconBadge({ icon: Icon, state, size = 17 }: { icon: LucideIcon; state: UiState; size?: number }) {
  return (
    <span className={`inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg ${TINT[state]}`}>
      <Icon size={size} />
    </span>
  );
}
