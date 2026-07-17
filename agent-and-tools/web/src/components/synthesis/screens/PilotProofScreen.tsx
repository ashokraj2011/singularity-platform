"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CheckCircle2, CircleDashed, ClipboardCheck, RefreshCw, Route, ShieldCheck } from "lucide-react";
import { SynthesisShell } from "@/components/synthesis/SynthesisShell";
import { NoProjectSelected, ProjectPicker, useSelectedProjectId } from "@/components/synthesis/ProjectPicker";
import { usePilotReadiness } from "@/components/synthesis/hooks/useSynthesis";
import { StageHeader, SynButton, SynCard, SynChip, SynError, SynSkeleton } from "@/components/synthesis/ui/kit";

export function PilotProofScreen() {
  const pathname = usePathname() ?? "/synthesis/pilot";
  const projectId = useSelectedProjectId();
  return <SynthesisShell title="Pilot Proof" headerActions={<ProjectPicker pathname={pathname} />}>{projectId ? <PilotProof projectId={projectId} /> : <NoProjectSelected surface="Pilot Proof" />}</SynthesisShell>;
}

function PilotProof({ projectId }: { projectId: string }) {
  const query = usePilotReadiness(projectId, { refreshInterval: 15000 });
  if (query.isLoading) return <SynSkeleton rows={7} />;
  if (query.error || !query.data) return <SynError message={query.error instanceof Error ? query.error.message : "Pilot evidence is unavailable."} />;
  const data = query.data;
  return <div className="space-y-7">
    <StageHeader eyebrow="Idea → Verified check-in" title="End-to-end pilot proof" description="This score is earned from durable records. It does not turn green because a page exists; every check points to the evidence or the place that fixes it." icon={ShieldCheck} actions={<SynButton variant="secondary" icon={RefreshCw} onClick={() => void query.mutate()}>Refresh proof</SynButton>} />
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <SynCard className="p-6"><div className="text-xs font-black uppercase text-on-surface-variant">Pilot readiness</div><div className="mt-3 flex items-end gap-2"><span className="text-6xl font-black tabular-nums text-on-surface">{data.score}</span><span className="pb-2 text-sm font-bold text-on-surface-variant">/ 100</span></div><div className="mt-4 h-2 overflow-hidden rounded-full bg-surface-container-high"><div className={`h-full ${data.ready ? "bg-secondary" : "bg-tertiary"}`} style={{ width: `${data.score}%` }} /></div><p className="mt-4 text-sm text-on-surface-variant">{data.ready ? "The declared pilot evidence is complete." : `${data.checks.filter(check => !check.ok).length} proof obligation(s) remain.`}</p></SynCard>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Generated / AD_HOC" value={`${data.metrics.origin.specGenerated} / ${data.metrics.origin.adHoc}`} /><Metric label="Verified items" value={String(data.metrics.verified)} /><Metric label="Finalized items" value={String(data.metrics.finalized)} /><Metric label="Rows with actuals" value={String(data.metrics.actualRows)} /></div>
    </div>
    <section><div className="mb-3 flex items-center gap-2"><ClipboardCheck size={17} className="text-secondary" /><div><h2 className="font-black text-on-surface">Proof obligations</h2><p className="text-xs text-on-surface-variant">Every result is calculated from durable records; fix links preserve the selected initiative.</p></div></div><div className="overflow-hidden rounded-md border border-outline-variant bg-surface">{data.checks.map(check => <div key={check.key} className="flex flex-wrap items-start gap-3 border-b border-outline-variant px-4 py-3 last:border-b-0 sm:flex-nowrap sm:items-center">{check.ok ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-secondary sm:mt-0" /> : <CircleDashed size={18} className="mt-0.5 shrink-0 text-tertiary sm:mt-0" />}<div className="min-w-0 flex-[1_1_180px]"><div className="text-sm font-semibold text-on-surface">{check.label}</div>{check.evidence ? <div className="mt-0.5 break-words text-xs text-on-surface-variant">{check.evidence}</div> : null}</div><div className="ml-7 flex shrink-0 items-center gap-2 sm:ml-0"><SynChip tone={check.ok ? "success" : "tertiary"}>{check.ok ? "Evidenced" : "Pending"}</SynChip>{!check.ok ? <Link className="btn-secondary text-xs" href={check.fixRoute}>Resolve</Link> : null}</div></div>)}</div></section>
    <SynCard className="p-5"><div className="flex flex-wrap items-center gap-4"><Route size={20} className="text-secondary" /><div className="min-w-0 flex-1"><strong className="text-sm text-on-surface">Traceability chain</strong><p className="text-xs text-on-surface-variant">{data.traceability.completeChains} complete chain(s), {data.traceability.rejectedOptions} preserved rejected option(s), and {data.traceability.reconciliations} reconciliation record(s).</p></div><Link className="btn-primary text-sm" href={`/synthesis/spec?projectId=${encodeURIComponent(projectId)}`}>Open lineage</Link></div></SynCard>
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <SynCard className="p-4"><div className="text-[10px] font-black uppercase text-on-surface-variant">{label}</div><div className="mt-2 text-2xl font-black tabular-nums text-on-surface">{value}</div></SynCard>;
}
