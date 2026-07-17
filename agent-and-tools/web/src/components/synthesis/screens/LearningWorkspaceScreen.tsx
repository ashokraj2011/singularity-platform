"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowDownRight, ArrowUpRight, CheckCircle2, ExternalLink, RefreshCw, RotateCcw, ShieldAlert, XCircle } from "lucide-react";
import { useState } from "react";
import { workgraphFetch, WorkgraphError } from "@/lib/workgraph";
import { SynthesisShell } from "@/components/synthesis/SynthesisShell";
import { NoProjectSelected, ProjectPicker, useSelectedProjectId } from "@/components/synthesis/ProjectPicker";
import { useProjectLearning } from "@/components/synthesis/hooks/useSynthesis";
import { ConfidenceBar, EmptyState, StageHeader, SynButton, SynCard, SynChip, SynError, SynSkeleton } from "@/components/synthesis/ui/kit";

export function LearningWorkspaceScreen() {
  const pathname = usePathname() ?? "/synthesis/learning";
  const projectId = useSelectedProjectId();
  return <SynthesisShell title="Learning & Change Control" headerActions={<ProjectPicker pathname={pathname} />}>{projectId ? <LearningWorkspace projectId={projectId} /> : <NoProjectSelected surface="Learning & Change Control" />}</SynthesisShell>;
}

function LearningWorkspace({ projectId }: { projectId: string }) {
  const query = useProjectLearning(projectId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const transition = async (id: string, status: "OPEN" | "APPROVED" | "REJECTED" | "APPLIED") => {
    setBusy(id); setError(null);
    try {
      await workgraphFetch(`/studio/change-requests/${id}/transition`, { method: "POST", body: JSON.stringify({ status }) });
      await query.mutate();
    } catch (cause) { setError(cause instanceof WorkgraphError ? cause.message : "Could not update the change request."); }
    finally { setBusy(null); }
  };
  if (query.isLoading) return <SynSkeleton rows={6} />;
  if (query.error || !query.data) return <SynError message={query.error instanceof Error ? query.error.message : "Learning evidence is unavailable."} />;
  const data = query.data;
  return <div className="space-y-7">
    <StageHeader eyebrow="Verified delivery → Evidence → Belief update" title="Learning and governed change" description="Dynamic reconciliation moves claim confidence. Material negative movement opens a change request instead of silently rewriting an approved specification." icon={RefreshCw} actions={<SynButton variant="secondary" icon={RefreshCw} onClick={() => void query.mutate()}>Refresh</SynButton>} />
    {error ? <SynError message={error} /> : null}
    <div className="grid gap-3 sm:grid-cols-3">
      <Metric label="Material gains" value={data.summary.materialGains} tone="success" />
      <Metric label="Material drops" value={data.summary.materialDrops} tone="error" />
      <Metric label="Open change requests" value={data.summary.openChangeRequests} tone="secondary" />
    </div>
    <section>
      <div className="mb-3"><h2 className="font-black text-on-surface">Belief movement</h2><p className="text-xs text-on-surface-variant">Before and after values are pinned to the reconciliation that produced the evidence.</p></div>
      {!data.signals.length ? <EmptyState icon={RefreshCw} title="No verified learning yet" description="Run dynamic reconciliation on a generated WorkItem to create experiment-tier claim evidence." /> : <div className="space-y-3">{data.signals.map(signal => <SynCard key={signal.id} className="p-4"><div className="flex flex-wrap items-start gap-4"><div className={`grid h-9 w-9 shrink-0 place-items-center rounded-md ${signal.direction === "DOWN" ? "bg-error-container text-on-error-container" : "bg-secondary-container text-on-secondary-container"}`}>{signal.direction === "DOWN" ? <ArrowDownRight size={18} /> : <ArrowUpRight size={18} />}</div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm text-on-surface">{signal.claim.statement}</strong><SynChip tone={Math.abs(signal.delta) >= signal.threshold ? signal.direction === "DOWN" ? "error" : "success" : "neutral"}>{signal.status}</SynChip></div><div className="mt-3 grid gap-3 sm:grid-cols-2"><ConfidenceBar value={signal.beforeMean} label={`Before ${Math.round(signal.beforeMean * 100)}%`} /><ConfidenceBar value={signal.afterMean} label={`After ${Math.round(signal.afterMean * 100)}%`} /></div><p className="mt-2 text-xs text-on-surface-variant">{signal.direction === "DOWN" ? "Confidence fell" : "Confidence improved"} by {Math.abs(signal.delta * 100).toFixed(1)} points · {new Date(signal.createdAt).toLocaleString()}</p></div>{signal.traceId ? <Link className="icon-button" title="Open correlated evidence" href={`/audit/trace/${encodeURIComponent(signal.traceId)}`}><ExternalLink size={15} /></Link> : null}</div></SynCard>)}</div>}
    </section>
    <section>
      <div className="mb-3"><h2 className="font-black text-on-surface">Specification change control</h2><p className="text-xs text-on-surface-variant">Opening acknowledges the signal; approval requires another user; apply records that the specification was revised.</p></div>
      {!data.changeRequests.length ? <EmptyState icon={ShieldAlert} title="No change requests" description="Material negative drift will create a recommendation here automatically." /> : <div className="space-y-3">{data.changeRequests.map(request => <SynCard key={request.id} className="p-4"><div className="flex flex-wrap items-start gap-4"><ShieldAlert size={18} className="mt-0.5 shrink-0 text-tertiary" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm text-on-surface">{request.title}</strong><SynChip tone={request.status === "REJECTED" ? "error" : request.status === "APPLIED" ? "success" : "secondary"}>{request.status}</SynChip></div><p className="mt-1 text-xs leading-5 text-on-surface-variant">{request.reason}</p></div><div className="flex flex-wrap gap-2">{request.status === "RECOMMENDED" ? <SynButton variant="secondary" icon={RotateCcw} disabled={busy === request.id} onClick={() => void transition(request.id, "OPEN")}>Open</SynButton> : null}{request.status === "OPEN" ? <><SynButton icon={CheckCircle2} disabled={busy === request.id} onClick={() => void transition(request.id, "APPROVED")}>Approve</SynButton><SynButton variant="secondary" icon={XCircle} disabled={busy === request.id} onClick={() => void transition(request.id, "REJECTED")}>Reject</SynButton></> : null}{request.status === "APPROVED" ? <SynButton icon={CheckCircle2} disabled={busy === request.id} onClick={() => void transition(request.id, "APPLIED")}>Mark applied</SynButton> : null}</div></div></SynCard>)}</div>}
    </section>
  </div>;
}

function Metric({ label, value, tone }: { label: string; value: number; tone: "success" | "error" | "secondary" }) {
  return <SynCard className="p-4"><SynChip tone={tone}>{label}</SynChip><div className="mt-3 text-3xl font-black tabular-nums text-on-surface">{value}</div></SynCard>;
}
