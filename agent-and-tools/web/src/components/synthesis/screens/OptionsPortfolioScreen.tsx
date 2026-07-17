"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GitCompareArrows, Scale } from "lucide-react";
import { SynthesisShell } from "@/components/synthesis/SynthesisShell";
import { NoProjectSelected, ProjectPicker, useSelectedProjectId } from "@/components/synthesis/ProjectPicker";
import { useDecisions } from "@/components/synthesis/hooks/useSynthesis";
import { EmptyState, StageHeader, SynButton, SynCard, SynChip, SynError, SynSkeleton } from "@/components/synthesis/ui/kit";

export function OptionsPortfolioScreen() {
  const pathname = usePathname() ?? "/synthesis/options";
  const projectId = useSelectedProjectId();
  return <SynthesisShell title="Solution Options" headerActions={<ProjectPicker pathname={pathname} />}>{projectId ? <Portfolio projectId={projectId} /> : <NoProjectSelected surface="Solution Options" />}</SynthesisShell>;
}

function Portfolio({ projectId }: { projectId: string }) {
  const query = useDecisions(projectId);
  const options = (query.data?.items ?? []).flatMap(dossier => dossier.options.map(option => ({ dossier, option })));
  return <div><StageHeader eyebrow="Explore before committing" title="Option portfolio" description="Alternatives remain visible after a decision, including rejected paths and their estimates. This prevents the chosen design from erasing its reasoning." icon={GitCompareArrows} actions={<Link href={`/synthesis/decisions?projectId=${encodeURIComponent(projectId)}`}><SynButton icon={Scale}>Govern decisions</SynButton></Link>} />{query.isLoading ? <SynSkeleton rows={4} /> : query.error ? <SynError message={(query.error as Error).message} /> : !options.length ? <EmptyState icon={GitCompareArrows} title="No durable options" description="Create a decision dossier with at least two alternatives. Options will appear here for portfolio comparison." /> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{options.map(({ dossier, option }) => <SynCard key={option.id} className="p-5"><div className="flex items-start justify-between gap-3"><div><div className="text-xs font-bold text-on-surface-variant">{dossier.title}</div><h2 className="mt-1 text-base font-black text-on-surface">{option.title}</h2></div><SynChip tone={option.status === "ACCEPTED" ? "success" : option.status === "REJECTED" ? "error" : "neutral"}>{option.status}</SynChip></div><p className="mt-3 text-sm leading-6 text-on-surface-variant">{option.summary}</p><div className="mt-4 grid grid-cols-3 gap-2 text-center"><Metric label="Hours" value={option.estimatedHours} /><Metric label="Cost high" value={option.estimatedCostHigh == null ? null : `$${option.estimatedCostHigh.toLocaleString()}`} /><Metric label="Tokens" value={option.estimatedTokens?.toLocaleString()} /></div></SynCard>)}</div>}</div>;
}

function Metric({ label, value }: { label: string; value?: string | number | null }) { return <div className="rounded-md bg-surface-container px-2 py-2"><div className="text-sm font-black text-on-surface">{value ?? "–"}</div><div className="text-[9px] font-bold uppercase text-on-surface-variant">{label}</div></div>; }
