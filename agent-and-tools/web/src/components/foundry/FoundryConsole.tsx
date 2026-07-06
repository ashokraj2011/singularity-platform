"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { ArrowLeft, CheckCircle2, CircleAlert, Copy, FileCode2, GitBranch, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import {
  FoundryError,
  foundryApi,
  type ArtifactRow,
  type ChangePlanSummary,
  type FoundryMode,
  type GapRow,
  type LlmTaskRow,
  type RepoModelSummary,
  type RunDetail,
  type RunSummary,
  type SpecLifecycleEvent,
} from "@/lib/foundry/api";
import { formatDate, shortId, valueText } from "@/lib/workgraph";

type FoundryView = "runs" | "artifacts" | "gaps" | "tasks" | "receipts" | "repos" | "plans" | "verification" | "history";
type DetailTab = "overview" | "files" | "gaps" | "tasks" | "receipt";

const foundryViews: Array<{ view: FoundryView; href: string; label: string; summary: string; scope: "setup" | "run" }> = [
  { view: "repos", href: "/foundry/repos", label: "Repositories", summary: "Scanned source context", scope: "setup" },
  { view: "plans", href: "/foundry/change-plans", label: "Change Plans", summary: "Brownfield patch plans", scope: "setup" },
  { view: "runs", href: "/foundry/runs", label: "Run Cockpit", summary: "Pick a generation run", scope: "run" },
  { view: "artifacts", href: "/foundry/artifacts", label: "Generated Files", summary: "Output file preview", scope: "run" },
  { view: "gaps", href: "/foundry/gaps", label: "Gaps to Fix", summary: "Unresolved work", scope: "run" },
  { view: "tasks", href: "/foundry/llm-tasks", label: "Patch Tasks", summary: "Guarded LLM fixes", scope: "run" },
  { view: "verification", href: "/foundry/verification", label: "Verify Output", summary: "Accept readiness", scope: "run" },
  { view: "receipts", href: "/foundry/receipts", label: "Receipts", summary: "Evidence hashes", scope: "run" },
  { view: "history", href: "/foundry/history", label: "Run History", summary: "Past runs and lifecycle", scope: "run" },
];

const viewCopy: Record<FoundryView, { title: string; description: string }> = {
  runs: {
    title: "Generation Cockpit",
    description: "Start with a greenfield or brownfield run, then inspect files, gaps, patch tasks, verification, and receipts from one place.",
  },
  artifacts: {
    title: "Generated Files",
    description: "Browse output files, protected regions, artifact hashes, and read-only previews for the selected generation run.",
  },
  gaps: {
    title: "Gaps to Fix",
    description: "Review unresolved generation gaps, severity, editable regions, and patch-task eligibility for the selected run.",
  },
  tasks: {
    title: "Guarded Patch Tasks",
    description: "Dispatch guarded LLM patch tasks, review proposed diffs, and apply accepted changes through the Foundry API.",
  },
  receipts: {
    title: "Run Receipts",
    description: "Inspect immutable generation receipts and hashes used for audit, reproducibility, and acceptance evidence.",
  },
  repos: {
    title: "Repository Inventory",
    description: "Inspect scanned source repositories and model hashes used by brownfield generation and change planning. This is setup context, not a single run detail.",
  },
  plans: {
    title: "Brownfield Change Plans",
    description: "Review patch plans created from repository scans, including repo model links, plan hashes, and execution status.",
  },
  verification: {
    title: "Verify Output",
    description: "Check run status, open gaps, patch tasks, and receipt evidence before accepting generated or patched code.",
  },
  history: {
    title: "Run History",
    description: "Scan recent greenfield and brownfield generation runs with status, timestamps, and evidence counts.",
  },
};

const statusTone: Record<string, string> = {
  COMPLETED: "#15803d",
  CERTIFIED: "#15803d",
  VERIFIED: "#15803d",
  PATCHED: "#15803d",
  FAILED: "#b91c1c",
  GUARD_REJECTED: "#b91c1c",
  GAPS_DETECTED: "#b45309",
  STARTED: "#4b6ba8",
  GENERATED: "#4b6ba8",
  DISPATCHED: "#4b6ba8",
  PENDING: "#8a857a",
};

function tabForView(view: FoundryView): DetailTab {
  if (view === "artifacts") return "files";
  if (view === "gaps" || view === "verification") return "gaps";
  if (view === "tasks") return "tasks";
  if (view === "receipts") return "receipt";
  return "overview";
}

export function FoundryConsole({ view = "runs" }: { view?: FoundryView }) {
  const router = useRouter();
  const search = useSearchParams();
  const copy = viewCopy[view];
  const globalView = view === "repos" || view === "plans";
  const [filter, setFilter] = useState<FoundryMode>((search.get("mode") as FoundryMode | null) ?? "ALL");
  const selectedRunId = search.get("runId") ?? undefined;
  const [tab, setTab] = useState<DetailTab>(tabForView(view));
  const { data: runPage, error: runsError, isLoading: loadingRuns, mutate: reloadRuns } = useSWR(["foundry-runs", filter], () => foundryApi.listRuns({ take: 80, mode: filter }), { refreshInterval: 12000 });
  const runs = runPage?.items ?? [];
  const activeId = selectedRunId ?? runs[0]?.id;
  const { data: run, error: runError, isLoading: loadingRun, mutate: reloadRun } = useSWR(activeId ? ["foundry-run", activeId] : null, () => foundryApi.getRun(activeId as string), { refreshInterval: 10000 });

  useEffect(() => {
    setTab(tabForView(view));
  }, [view]);

  function selectRun(id: string) {
    const next = new URLSearchParams(search.toString());
    next.set("runId", id);
    router.push(`?${next.toString()}`);
  }

  function changeFilter(nextFilter: FoundryMode) {
    setFilter(nextFilter);
    const next = new URLSearchParams(search.toString());
    if (nextFilter === "ALL") next.delete("mode");
    else next.set("mode", nextFilter);
    next.delete("runId");
    router.push(`?${next.toString()}`);
  }

  const error = runsError ?? runError;

  return (
    <div style={{ maxWidth: 1440 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
        <Link href="/foundry" className="btn-secondary">
          <ArrowLeft size={15} />
          Code Foundry
        </Link>
        <button type="button" className="btn-secondary" onClick={() => void Promise.all([reloadRuns(), reloadRun()])}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>

      <section className="card" style={{ padding: 22, marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 18, flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--color-primary)", fontSize: 12, fontWeight: 850, textTransform: "uppercase", marginBottom: 10 }}>
              <Sparkles size={15} />
              Code Foundry · SDLC Code Generation
            </div>
            <h1 className="page-header" style={{ margin: 0 }}>{copy.title}</h1>
            <p style={{ margin: "10px 0 0", maxWidth: 780, color: "var(--color-outline)", fontSize: 14, lineHeight: 1.55 }}>
              {copy.description}
            </p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(100px, 1fr))", gap: 8, minWidth: 320 }}>
            <Metric label="Runs" value={runPage?.total ?? runs.length ?? 0} />
            <Metric label="Open Gaps" value={run?.counts.openGaps ?? "-"} tone="#b45309" />
            <Metric label="LLM Tasks" value={run?.counts.openLlmTasks ?? "-"} tone="#4b6ba8" />
          </div>
        </div>
      </section>

      {error ? <ErrorBanner error={error} /> : null}

      <FoundryFlow activeView={view} />
      <FoundryNav activeView={view} />

      {globalView ? (
        <main style={{ display: "grid", gap: 16, minWidth: 0 }}>
          {view === "repos" ? <ReposPanel /> : <ChangePlansPanel />}
        </main>
      ) : (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 340px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <aside className="card" style={{ padding: 14 }}>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 850, fontSize: 13 }}>Select generation run</div>
            <p style={{ color: "var(--color-outline)", fontSize: 12, lineHeight: 1.45, margin: "4px 0 0" }}>
              Run-scoped views use this selected run for files, gaps, patch tasks, verification, and receipts.
            </p>
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
            {(["ALL", "GREENFIELD", "BROWNFIELD"] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => changeFilter(item)}
                style={{
                  border: filter === item ? "1px solid rgba(54,135,39,0.42)" : "1px solid var(--color-outline-variant)",
                  background: filter === item ? "rgba(240,253,244,0.86)" : "#fff",
                  borderRadius: 999,
                  padding: "6px 10px",
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                {item.toLowerCase()}
              </button>
            ))}
          </div>
          <div style={{ display: "grid", gap: 8, maxHeight: 650, overflow: "auto", paddingRight: 4 }}>
            {runs.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => selectRun(item.id)}
                style={{
                  textAlign: "left",
                  border: item.id === activeId ? "1px solid rgba(54,135,39,0.42)" : "1px solid var(--color-outline-variant)",
                  background: item.id === activeId ? "rgba(240,253,244,0.86)" : "#fff",
                  borderRadius: 8,
                  padding: 12,
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <strong style={{ fontSize: 13, lineHeight: 1.35 }}>{item.specName ?? shortId(item.specId)}</strong>
                  <span style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 999, padding: "2px 7px", fontSize: 11, fontWeight: 850 }}>{item.mode === "GREENFIELD" ? "G" : "B"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "var(--color-outline)", fontSize: 12 }}>
                  <StatusPill value={item.status} />
                  <span>{formatDate(item.startedAt)}</span>
                </div>
              </button>
            ))}
            {loadingRuns && <EmptyPanel label="Loading generation runs..." />}
            {!loadingRuns && runs.length === 0 && <EmptyPanel label="No Code Foundry runs found." />}
          </div>
        </aside>

        <main style={{ display: "grid", gap: 16, minWidth: 0 }}>
          {view === "history" ? <HistoryPanel runs={runs} selectedRun={run ?? runs.find((item) => item.id === activeId)} selectedId={activeId} onSelect={selectRun} loading={loadingRuns} /> : loadingRun && !run ? <EmptyPanel label="Loading run..." /> : run ? (
            <>
              <RunHeader run={run} />
              {view === "verification" ? (
                <VerificationPanel run={run} onChanged={() => void Promise.all([reloadRuns(), reloadRun()])} />
              ) : (
                <>
                  <DetailTabs run={run} tab={tab} setTab={setTab} />
                  {tab === "overview" && <OverviewPanel run={run} />}
                  {tab === "files" && <FilesPanel runId={run.id} />}
                  {tab === "gaps" && <GapsPanel runId={run.id} />}
                  {tab === "tasks" && <TasksPanel runId={run.id} onChanged={() => void Promise.all([reloadRuns(), reloadRun()])} />}
                  {tab === "receipt" && <ReceiptPanel runId={run.id} receiptHash={run.receipt?.receiptHash} />}
                </>
              )}
            </>
          ) : (
            <EmptyPanel label="Pick a generation run to inspect it." />
          )}
        </main>
      </div>
      )}
    </div>
  );
}

function FoundryFlow({ activeView }: { activeView: FoundryView }) {
  const steps = [
    {
      href: "/foundry/repos",
      views: ["repos"] as FoundryView[],
      icon: GitBranch,
      label: "1. Source context",
      title: "Scan repositories",
      body: "Repository models feed brownfield change planning.",
    },
    {
      href: "/foundry/runs",
      views: ["runs", "history"] as FoundryView[],
      icon: Sparkles,
      label: "2. Generate",
      title: "Run greenfield or brownfield",
      body: "Each run produces files, gaps, tasks, and evidence.",
    },
    {
      href: "/foundry/gaps",
      views: ["artifacts", "gaps", "tasks", "plans"] as FoundryView[],
      icon: FileCode2,
      label: "3. Fix",
      title: "Review gaps and patches",
      body: "Use guarded patch tasks or change plans to resolve work.",
    },
    {
      href: "/foundry/verification",
      views: ["verification", "receipts"] as FoundryView[],
      icon: CheckCircle2,
      label: "4. Accept",
      title: "Verify and capture receipts",
      body: "Accept only when gaps, tasks, and evidence are clean.",
    },
  ];

  return (
    <section className="card" style={{ padding: 14, marginBottom: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10 }}>
        {steps.map((step) => {
          const active = step.views.includes(activeView);
          const Icon = step.icon;
          return (
            <Link
              key={step.label}
              href={step.href}
              style={{
                border: active ? "1px solid rgba(54,135,39,0.42)" : "1px solid var(--color-outline-variant)",
                background: active ? "rgba(240,253,244,0.88)" : "#fff",
                borderRadius: 8,
                padding: 12,
                color: "inherit",
                textDecoration: "none",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ display: "inline-flex", width: 30, height: 30, alignItems: "center", justifyContent: "center", borderRadius: 8, background: active ? "rgba(54,135,39,0.12)" : "var(--color-surface-low)", color: active ? "var(--color-primary)" : "var(--color-outline)" }}>
                  <Icon size={15} />
                </span>
                <span style={{ color: active ? "var(--color-primary)" : "var(--color-outline)", fontSize: 11, fontWeight: 850, textTransform: "uppercase" }}>{step.label}</span>
              </div>
              <div style={{ fontWeight: 850, fontSize: 13 }}>{step.title}</div>
              <p style={{ color: "var(--color-outline)", fontSize: 12, lineHeight: 1.45, margin: "4px 0 0" }}>{step.body}</p>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function FoundryNav({ activeView }: { activeView: FoundryView }) {
  const setupViews = foundryViews.filter((item) => item.scope === "setup");
  const runViews = foundryViews.filter((item) => item.scope === "run");
  return (
    <nav className="card" style={{ padding: 12, marginBottom: 18, display: "grid", gap: 12 }} aria-label="Foundry sections">
      <FoundryNavGroup title="Setup" description="Inputs and plans shared across runs" items={setupViews} activeView={activeView} />
      <FoundryNavGroup title="Run Review" description="Run-scoped files, gaps, fixes, verification, and evidence" items={runViews} activeView={activeView} />
    </nav>
  );
}

function FoundryNavGroup({
  title,
  description,
  items,
  activeView,
}: {
  title: string;
  description: string;
  items: typeof foundryViews;
  activeView: FoundryView;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 7, flexWrap: "wrap" }}>
        <span className="label-xs" style={{ color: "var(--color-outline)" }}>{title}</span>
        <span style={{ color: "var(--color-outline)", fontSize: 12 }}>{description}</span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {items.map((item) => {
        const active = item.view === activeView;
        return (
          <Link
            key={item.view}
            href={item.href}
            title={item.summary}
            style={{
              border: active ? "1px solid rgba(54,135,39,0.42)" : "1px solid transparent",
              background: active ? "rgba(240,253,244,0.88)" : "transparent",
              color: active ? "var(--color-primary)" : "var(--color-outline)",
              borderRadius: 8,
              padding: "7px 10px",
              fontWeight: 850,
              fontSize: 12,
              textDecoration: "none",
            }}
          >
            {item.label}
          </Link>
        );
        })}
      </div>
    </div>
  );
}

function DetailTabs({ run, tab, setTab }: { run: RunDetail; tab: DetailTab; setTab: (tab: DetailTab) => void }) {
  return (
    <div className="card" style={{ padding: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
      {(["overview", "files", "gaps", "tasks", "receipt"] as const).map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => setTab(item)}
          style={{
            border: tab === item ? "1px solid rgba(54,135,39,0.42)" : "1px solid transparent",
            background: tab === item ? "rgba(240,253,244,0.88)" : "transparent",
            color: tab === item ? "var(--color-primary)" : "var(--color-outline)",
            borderRadius: 8,
            padding: "8px 12px",
            fontWeight: 850,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          {labelForTab(item)}
          {item === "gaps" && run.counts.openGaps > 0 ? ` (${run.counts.openGaps})` : ""}
          {item === "tasks" && run.counts.openLlmTasks > 0 ? ` (${run.counts.openLlmTasks})` : ""}
        </button>
      ))}
    </div>
  );
}

function RunHeader({ run }: { run: RunDetail }) {
  return (
    <section className="card" style={{ padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <StatusPill value={run.mode} />
            <StatusPill value={run.status} />
            <span style={{ color: "var(--color-outline)", fontSize: 12 }}>{shortId(run.id)}</span>
          </div>
          <h2 style={{ margin: 0, fontSize: 22 }}>{run.specName ?? run.specId}</h2>
          <p style={{ margin: "8px 0 0", color: "var(--color-outline)", fontSize: 13 }}>
            {run.specVersion ? `Version ${run.specVersion}` : "No spec version"} · {run.generatorVersion} · {run.outputPath ?? "no output path"}
          </p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(100px, 1fr))", gap: 8, minWidth: 320 }}>
          <Metric label="Artifacts" value={run.counts.artifacts} />
          <Metric label="Gaps" value={`${run.counts.openGaps}/${run.counts.gaps}`} tone={run.counts.openGaps > 0 ? "#b45309" : "#15803d"} />
          <Metric label="Tasks" value={`${run.counts.openLlmTasks}/${run.counts.llmTasks}`} tone={run.counts.openLlmTasks > 0 ? "#4b6ba8" : "#15803d"} />
        </div>
      </div>
    </section>
  );
}

function VerificationPanel({ run, onChanged }: { run: RunDetail; onChanged: () => void }) {
  return (
    <>
      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Verification Summary</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <Metric label="Run status" value={run.status} tone={statusTone[run.status]} />
          <Metric label="Open gaps" value={`${run.counts.openGaps}/${run.counts.gaps}`} tone={run.counts.openGaps > 0 ? "#b45309" : "#15803d"} />
          <Metric label="Open LLM tasks" value={`${run.counts.openLlmTasks}/${run.counts.llmTasks}`} tone={run.counts.openLlmTasks > 0 ? "#4b6ba8" : "#15803d"} />
          <Metric label="Receipt" value={run.receipt?.receiptHash ? shortId(run.receipt.receiptHash) : "missing"} tone={run.receipt?.receiptHash ? "#15803d" : "#b45309"} />
        </div>
      </section>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16 }}>
        <GapsPanel runId={run.id} />
        <TasksPanel runId={run.id} onChanged={onChanged} />
        <ReceiptPanel runId={run.id} receiptHash={run.receipt?.receiptHash} />
      </div>
    </>
  );
}

function OverviewPanel({ run }: { run: RunDetail }) {
  return (
    <section className="card" style={{ padding: 18 }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Overview</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <Fact label="Template" value={run.templateVersion} />
        <Fact label="Generator" value={run.generatorVersion} />
        <Fact label="Started" value={formatDate(run.startedAt)} />
        <Fact label="Completed" value={formatDate(run.completedAt)} />
        <Fact label="Spec hash" value={run.spec?.specHash} />
        <Fact label="IR hash" value={run.spec?.irHash} />
        <Fact label="Receipt hash" value={run.receipt?.receiptHash} />
        <Fact label="Output path" value={run.outputPath} />
      </div>
      {run.mode === "BROWNFIELD" && run.changePlan ? (
        <div style={{ borderTop: "1px solid var(--color-outline-variant)", marginTop: 16, paddingTop: 16 }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Brownfield Change Plan</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <Fact label="Plan" value={run.changePlan.id} />
            <Fact label="Status" value={run.changePlan.status} />
            <Fact label="Plan hash" value={run.changePlan.planHash} />
            <Fact label="Repo model" value={run.changePlan.repoModelId} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function HistoryPanel({ runs, selectedRun, selectedId, onSelect, loading }: { runs: RunSummary[]; selectedRun?: RunSummary | RunDetail; selectedId?: string; onSelect: (id: string) => void; loading: boolean }) {
  const specId = selectedRun?.specId;
  const { data: history, error: historyError, isLoading: loadingHistory } = useSWR(specId ? ["foundry-spec-history", specId] : null, () => foundryApi.listSpecHistory(specId as string));
  const events = history?.items ?? [];

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section className="card" style={{ padding: 18, overflow: "hidden" }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Generation History</h2>
        <div style={{ overflowX: "auto" }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="text-left px-3 py-2">Run</th>
                <th className="text-left px-3 py-2">Mode</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Output</th>
                <th className="text-left px-3 py-2">Started</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {runs.map((run) => (
                <tr key={run.id} style={{ background: run.id === selectedId ? "rgba(240,253,244,0.72)" : undefined }}>
                  <td className="px-3 py-2">
                    <button type="button" onClick={() => onSelect(run.id)} style={{ color: "var(--color-primary)", fontWeight: 800 }}>
                      {run.specName ?? shortId(run.specId)}
                    </button>
                    <div style={{ color: "var(--color-outline)", fontSize: 11 }}>{shortId(run.id)}</div>
                  </td>
                  <td className="px-3 py-2">{run.mode}</td>
                  <td className="px-3 py-2"><StatusPill value={run.status} /></td>
                  <td className="px-3 py-2">
                    <div>{run.outputPath ?? "no output path"}</div>
                    <div style={{ color: "var(--color-outline)", fontSize: 11 }}>{run.completedAt ? `completed ${formatDate(run.completedAt)}` : "not completed"}</div>
                  </td>
                  <td className="px-3 py-2">{formatDate(run.startedAt)}</td>
                </tr>
              ))}
              {loading && <tr><td className="px-3 py-10 text-center text-slate-400" colSpan={5}>Loading generation history...</td></tr>}
              {!loading && runs.length === 0 && <tr><td className="px-3 py-10 text-center text-slate-400" colSpan={5}>No generation runs found.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" style={{ padding: 18 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>Spec Lifecycle</h2>
            <p style={{ margin: "5px 0 0", color: "var(--color-outline)", fontSize: 12 }}>
              {selectedRun ? `${selectedRun.specName ?? shortId(selectedRun.specId)} · ${shortId(selectedRun.specId)}` : "Select a run to inspect its spec state transitions."}
            </p>
          </div>
          {selectedRun ? <StatusPill value={selectedRun.status} /> : null}
        </div>
        {historyError ? <SmallError error={historyError} /> : null}
        <div style={{ display: "grid", gap: 10 }}>
          {events.map((event) => <LifecycleEventRow key={event.id} event={event} />)}
          {loadingHistory && <EmptyPanel label="Loading spec lifecycle..." />}
          {!loadingHistory && !historyError && selectedRun && events.length === 0 && <EmptyPanel label="No spec lifecycle events recorded for this run's spec." />}
          {!selectedRun && <EmptyPanel label="Pick a generation run to inspect its spec lifecycle." />}
        </div>
      </section>
    </div>
  );
}

function LifecycleEventRow({ event }: { event: SpecLifecycleEvent }) {
  const fromState = event.fromState ?? "created";
  return (
    <article style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <StatusPill value={fromState} />
          <span style={{ color: "var(--color-outline)", fontWeight: 800 }}>to</span>
          <StatusPill value={event.toState} />
        </div>
        <span style={{ color: "var(--color-outline)", fontSize: 12 }}>{formatDate(event.occurredAt)}</span>
      </div>
      <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
        <Fact label="Actor" value={event.actorId ?? "-"} />
        <Fact label="Reason" value={event.reason ?? "-"} />
        <Fact label="Event" value={shortId(event.id)} />
      </div>
    </article>
  );
}

function FilesPanel({ runId }: { runId: string }) {
  const { data, error } = useSWR(["foundry-artifacts", runId], () => foundryApi.listArtifacts(runId));
  const artifacts = data?.items ?? [];
  const [activePath, setActivePath] = useState<string | null>(null);
  const effectivePath = activePath ?? artifacts[0]?.path ?? null;
  const { data: file, error: fileError } = useSWR(effectivePath ? ["foundry-file", runId, effectivePath] : null, () => foundryApi.fileContent(runId, effectivePath as string));

  return (
    <section className="card" style={{ padding: 18 }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Files</h2>
      {error ? <SmallError error={error} /> : null}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 0.35fr) minmax(0, 1fr)", gap: 14 }}>
        <div style={{ display: "grid", gap: 6, maxHeight: 560, overflow: "auto", paddingRight: 4 }}>
          {artifacts.map((artifact: ArtifactRow) => (
            <button
              key={artifact.id}
              type="button"
              onClick={() => setActivePath(artifact.path)}
              style={{
                textAlign: "left",
                border: effectivePath === artifact.path ? "1px solid rgba(54,135,39,0.42)" : "1px solid var(--color-outline-variant)",
                background: effectivePath === artifact.path ? "rgba(240,253,244,0.86)" : "#fff",
                borderRadius: 8,
                padding: 10,
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
                <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{artifact.path.split("/").pop()}</strong>
                <span>{artifact.fileType}</span>
              </div>
              <div style={{ color: "var(--color-outline)", fontSize: 11, marginTop: 4 }}>{artifact.protected ? "protected" : "editable"} · {shortId(artifact.contentHash)}</div>
            </button>
          ))}
          {artifacts.length === 0 && <EmptyPanel label="No artifacts recorded for this run." />}
        </div>
        <div style={{ minWidth: 0, border: "1px solid var(--color-outline-variant)", borderRadius: 8, overflow: "hidden", background: "#0f172a" }}>
          {fileError ? <SmallError error={fileError} /> : file ? (
            <>
              <div style={{ background: "#111827", color: "#d1d5db", fontSize: 12, padding: "9px 12px", display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ overflowWrap: "anywhere" }}>{file.path}</span>
                <span>{file.bytes} bytes</span>
              </div>
              <pre style={{ margin: 0, padding: 14, maxHeight: 520, overflow: "auto", color: "#e5e7eb", fontSize: 12, lineHeight: 1.55 }}>{file.content}</pre>
            </>
          ) : (
            <div style={{ padding: 24, color: "#cbd5e1" }}>Select a file to preview it.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function GapsPanel({ runId }: { runId: string }) {
  const { data, error } = useSWR(["foundry-gaps", runId], () => foundryApi.listGaps(runId));
  const gaps = data?.items ?? [];
  return (
    <section className="card" style={{ padding: 18, overflow: "hidden" }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Gaps</h2>
      {error ? <SmallError error={error} /> : null}
      <div style={{ overflowX: "auto" }}>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-200 bg-slate-50"><th className="text-left px-3 py-2">Type</th><th className="text-left px-3 py-2">Severity</th><th className="text-left px-3 py-2">File</th><th className="text-left px-3 py-2">Region</th><th className="text-left px-3 py-2">LLM</th><th className="text-left px-3 py-2">Description</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {gaps.map((gap: GapRow) => (
              <tr key={gap.id}>
                <td className="px-3 py-2"><code>{gap.gapType}</code></td>
                <td className="px-3 py-2" style={{ color: severityColor(gap.severity), fontWeight: 800 }}>{gap.severity}</td>
                <td className="px-3 py-2"><code>{gap.filePath ?? "-"}</code></td>
                <td className="px-3 py-2">{gap.regionId ?? "-"}</td>
                <td className="px-3 py-2">{gap.llmEligible ? "yes" : "-"}</td>
                <td className="px-3 py-2">{gap.description}</td>
              </tr>
            ))}
            {gaps.length === 0 && <tr><td className="px-3 py-10 text-center text-slate-400" colSpan={6}>No gaps detected for this run.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TasksPanel({ runId, onChanged }: { runId: string; onChanged: () => void }) {
  const { data, error, mutate } = useSWR(["foundry-tasks", runId], () => foundryApi.listLlmTasks(runId));
  const tasks = data?.items ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = useMemo(() => tasks.find((task) => task.id === (activeId ?? tasks[0]?.id)) ?? null, [tasks, activeId]);
  return (
    <section className="card" style={{ padding: 18 }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>LLM Patch Tasks</h2>
      {error ? <SmallError error={error} /> : null}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 0.35fr) minmax(0, 1fr)", gap: 14 }}>
        <div style={{ display: "grid", gap: 8 }}>
          {tasks.map((task: LlmTaskRow) => (
            <button key={task.id} type="button" onClick={() => setActiveId(task.id)} style={{ textAlign: "left", border: active?.id === task.id ? "1px solid rgba(54,135,39,0.42)" : "1px solid var(--color-outline-variant)", background: active?.id === task.id ? "rgba(240,253,244,0.86)" : "#fff", borderRadius: 8, padding: 10, cursor: "pointer" }}>
              <strong style={{ fontSize: 13 }}>{task.taskType}</strong>
              <div style={{ color: "var(--color-outline)", fontSize: 12, marginTop: 4 }}>{task.targetFile.split("/").pop()} · {task.regionId}</div>
              <StatusPill value={task.status} />
            </button>
          ))}
          {tasks.length === 0 && <EmptyPanel label="No LLM patch tasks for this run." />}
        </div>
        {active ? <TaskPane task={active} onChanged={() => { void mutate(); onChanged(); }} /> : <EmptyPanel label="Select a task." />}
      </div>
    </section>
  );
}

function TaskPane({ task, onChanged }: { task: LlmTaskRow; onChanged: () => void }) {
  const [diff, setDiff] = useState("");
  const [busy, setBusy] = useState<"dispatch" | "apply" | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const resolved = task.status === "GUARD_PASSED";

  async function dispatch() {
    setBusy("dispatch");
    setResult(null);
    try {
      const response = await foundryApi.dispatchTask(task.id);
      if (response.diff) setDiff(response.diff);
      setResult(response.error ? `${response.status}: ${response.error}` : response.status);
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!diff.trim()) return;
    setBusy("apply");
    setResult(null);
    try {
      const response = await foundryApi.applyPatch(task.id, diff);
      setResult(response.status === "GUARD_PASSED" ? `Patch accepted: ${response.appliedFiles?.length ?? 0} file(s)` : `Rejected at ${response.stage}: ${response.reason}`);
      onChanged();
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 14, minWidth: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 12 }}>
        <Fact label="Target file" value={task.targetFile} />
        <Fact label="Region" value={task.regionId} />
        <Fact label="Class" value={task.targetClass} />
        <Fact label="Method" value={task.targetMethod} />
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <button type="button" className="btn-secondary" disabled={busy !== null || resolved} onClick={() => void dispatch()}>{busy === "dispatch" ? "Dispatching..." : "Dispatch LLM"}</button>
        <button type="button" className="btn-primary" disabled={busy !== null || resolved || !diff.trim()} onClick={() => void apply()}>{busy === "apply" ? "Applying..." : "Apply patch"}</button>
      </div>
      {result && <div style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 13 }}>{result}</div>}
      <textarea
        value={diff}
        onChange={(event) => setDiff(event.target.value)}
        rows={14}
        disabled={resolved}
        placeholder="Paste a unified diff here, or dispatch the LLM task."
        style={{ width: "100%", border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 12, fontFamily: "var(--font-mono)", fontSize: 12 }}
      />
    </div>
  );
}

function ReceiptPanel({ runId, receiptHash }: { runId: string; receiptHash?: string }) {
  const { data, error } = useSWR(["foundry-receipt", runId], () => foundryApi.receipt(runId));
  const hash = data?.receiptHash ?? receiptHash;
  return (
    <section className="card" style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Receipt</h2>
        {hash && <button type="button" className="btn-secondary" onClick={() => void navigator.clipboard.writeText(hash)}><Copy size={14} /> Copy hash</button>}
      </div>
      {error ? <SmallError error={error} /> : data ? (
        <pre style={{ margin: 0, padding: 14, maxHeight: 620, overflow: "auto", background: "#0f172a", color: "#e5e7eb", borderRadius: 8, fontSize: 12, lineHeight: 1.55 }}>{JSON.stringify(data.receiptJson, null, 2)}</pre>
      ) : <EmptyPanel label="Loading receipt..." />}
    </section>
  );
}

function ReposPanel() {
  const { data, error } = useSWR("foundry-repos", () => foundryApi.listRepos());
  return (
    <section className="card" style={{ padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>Repository Inventory</h2>
          <p style={{ color: "var(--color-outline)", fontSize: 13, lineHeight: 1.5, margin: "5px 0 0" }}>
            These are scanned source-code models. Brownfield generation and change plans use this inventory before creating patch work.
          </p>
        </div>
        <Link className="btn-secondary text-xs" href="/foundry/runs">
          <Sparkles size={13} />
          Open run cockpit
        </Link>
      </div>
      {error ? <SmallError error={error} /> : null}
      <div style={{ display: "grid", gap: 10 }}>
        {(data?.items ?? []).map((repo: RepoModelSummary) => (
          <article key={repo.id} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}><GitBranch size={15} color="var(--color-primary)" /><strong>{repo.repoPath}</strong></div>
            <div style={{ color: "var(--color-outline)", fontSize: 12 }}>{repo.language} · {repo.framework} · {shortId(repo.modelHash)} · {formatDate(repo.scannedAt)}</div>
          </article>
        ))}
        {data && data.items.length === 0 && (
          <EmptyPanel label="No scanned repositories found yet. Start or import a brownfield run to create repository context." />
        )}
      </div>
    </section>
  );
}

function ChangePlansPanel() {
  const { data, error } = useSWR("foundry-change-plans", () => foundryApi.listChangePlans());
  return (
    <section className="card" style={{ padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>Brownfield Change Plans</h2>
          <p style={{ color: "var(--color-outline)", fontSize: 13, lineHeight: 1.5, margin: "5px 0 0" }}>
            Change plans turn scanned repository context into proposed patch work. They sit between repository inventory and run verification.
          </p>
        </div>
        <Link className="btn-secondary text-xs" href="/foundry/repos">
          <GitBranch size={13} />
          Review repositories
        </Link>
      </div>
      {error ? <SmallError error={error} /> : null}
      <div style={{ display: "grid", gap: 10 }}>
        {(data?.items ?? []).map((plan: ChangePlanSummary) => (
          <article key={plan.id} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
              <strong>{shortId(plan.id)}</strong>
              <StatusPill value={plan.status} />
            </div>
            <div style={{ color: "var(--color-outline)", fontSize: 12 }}>{shortId(plan.repoModelId)} · {shortId(plan.planHash)} · {formatDate(plan.createdAt)}</div>
          </article>
        ))}
        {data && data.items.length === 0 && <EmptyPanel label="No change plans found yet. Brownfield runs create plans after repository context is available." />}
      </div>
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: unknown; tone?: string }) {
  return (
    <div style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 10, background: "#fff" }}>
      <div style={{ color: "var(--color-outline)", fontSize: 11, textTransform: "uppercase", fontWeight: 800 }}>{label}</div>
      <div style={{ marginTop: 4, color: tone ?? "var(--color-text)", fontWeight: 850, fontSize: 15 }}>{valueText(value)}</div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div style={{ color: "var(--color-outline)", fontSize: 11, textTransform: "uppercase", fontWeight: 800 }}>{label}</div>
      <div style={{ marginTop: 3, fontWeight: 750, fontSize: 13, overflowWrap: "anywhere" }}>{valueText(value)}</div>
    </div>
  );
}

function StatusPill({ value }: { value?: string }) {
  const tone = statusTone[value ?? ""] ?? "#8a857a";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, border: `1px solid ${tone}33`, color: tone, background: `${tone}12`, borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 850, textTransform: "uppercase" }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: tone }} />
      {value ?? "unknown"}
    </span>
  );
}

function ErrorBanner({ error }: { error: unknown }) {
  if (isFoundryUnavailable(error)) {
    return (
      <section className="card" style={{ padding: 18, marginBottom: 18, borderColor: "rgba(37,99,235,0.22)", background: "rgba(239,246,255,0.82)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#4b6ba8", fontWeight: 850 }}>
          <ShieldCheck size={16} />
          Workgraph code generation route is unavailable.
        </div>
        <p style={{ color: "#1e3a8a", fontSize: 13, margin: "7px 0 0", lineHeight: 1.5 }}>
          Foundry runs are now served by Workgraph. Check <code>workgraph-api</code> and Platform Web proxy health, then retry the generation cockpit.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          <Link href="/operations/readiness" className="btn-secondary text-xs">Open readiness</Link>
          <span style={{ color: "#1e3a8a", fontSize: 12, alignSelf: "center" }}>{error instanceof Error ? error.message : String(error)}</span>
        </div>
      </section>
    );
  }
  return (
    <section className="card" style={{ padding: 16, marginBottom: 18, borderColor: "rgba(185,28,28,0.28)", background: "rgba(254,242,242,0.82)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#991b1b", fontWeight: 850 }}>
        <CircleAlert size={16} />
        Could not load Foundry data.
      </div>
      <div style={{ color: "#7f1d1d", fontSize: 13, marginTop: 5 }}>{error instanceof Error ? error.message : String(error)}</div>
    </section>
  );
}

function isFoundryUnavailable(error: unknown): boolean {
  if (error instanceof FoundryError) {
    return error.status === 502 || error.code === "UPSTREAM_UNREACHABLE" || /workgraph-api|fetch failed|upstream/i.test(error.message);
  }
  return error instanceof Error && /workgraph-api|UPSTREAM_UNREACHABLE|fetch failed/i.test(error.message);
}

function SmallError({ error }: { error: unknown }) {
  return <div style={{ border: "1px solid rgba(185,28,28,0.24)", background: "rgba(254,242,242,0.72)", color: "#7f1d1d", borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 12 }}>{error instanceof Error ? error.message : String(error)}</div>;
}

function EmptyPanel({ label }: { label: string }) {
  return <div style={{ border: "1px dashed var(--color-outline-variant)", borderRadius: 8, padding: 18, color: "var(--color-outline)", fontSize: 13, textAlign: "center" }}>{label}</div>;
}

function severityColor(severity: GapRow["severity"]) {
  if (severity === "critical" || severity === "high") return "#b91c1c";
  if (severity === "medium") return "#b45309";
  return "#8a857a";
}

function labelForTab(tab: DetailTab) {
  if (tab === "overview") return "Overview";
  if (tab === "files") return "Files";
  if (tab === "gaps") return "Gaps";
  if (tab === "tasks") return "LLM Tasks";
  return "Receipt";
}
