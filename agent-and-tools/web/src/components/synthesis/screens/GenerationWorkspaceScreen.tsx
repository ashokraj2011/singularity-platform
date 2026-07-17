"use client";

import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { Braces, CheckCircle2, LockKeyhole, WandSparkles } from "lucide-react";
import { workgraphFetch, WorkgraphError } from "@/lib/workgraph";
import { ProjectGeneration } from "@/components/studio/ProjectGeneration";
import { SynthesisShell } from "@/components/synthesis/SynthesisShell";
import { NoProjectSelected, ProjectPicker, useSelectedProjectId } from "@/components/synthesis/ProjectPicker";
import { useClaims, useDecisions, useProjectSpec, useSyn } from "@/components/synthesis/hooks/useSynthesis";
import type { SynSpecificationVersion } from "@/components/synthesis/types";
import { MonoMeta, StageHeader, SynButton, SynCard, SynChip, SynError, SynSkeleton } from "@/components/synthesis/ui/kit";

export function GenerationWorkspaceScreen() {
  const pathname = usePathname() ?? "/synthesis/generate";
  const projectId = useSelectedProjectId();
  return <SynthesisShell title="Compile & Generate" headerActions={<ProjectPicker pathname={pathname} />}>{projectId ? <GenerationWorkspace projectId={projectId} /> : <NoProjectSelected surface="Compile & Generate" />}</SynthesisShell>;
}

function GenerationWorkspace({ projectId }: { projectId: string }) {
  const specQ = useProjectSpec(projectId);
  const claimsQ = useClaims(projectId);
  const decisionsQ = useDecisions(projectId);
  const versionsQ = useSyn<{ items: SynSpecificationVersion[] }>(`/specifications/${projectId}/versions`);
  const [waivers, setWaivers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [generationKey, setGenerationKey] = useState(0);
  const requirements = specQ.data?.package.requirements ?? [];
  const acceptedDecisions = (decisionsQ.data?.items ?? []).filter(item => item.status === "ACCEPTED");
  const weakClaims = useMemo(() => (claimsQ.data?.items ?? []).filter(claim => typeof claim.mean === "number" && claim.mean < 0.35), [claimsQ.data?.items]);
  const latest = versionsQ.data?.items[0];

  const compile = async () => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await workgraphFetch<{ version: SynSpecificationVersion; warnings?: Array<{ reason: string }> }>(`/studio/projects/${projectId}/compile`, { method: "POST", body: JSON.stringify({ waiverReasons: waivers }) });
      setMessage(`Locked specification v${result.version.version}${result.warnings?.length ? ` with ${result.warnings.length} belief warning(s)` : ""}. Generation will pin this exact version.`);
      await versionsQ.mutate();
      setGenerationKey(value => value + 1);
    } catch (cause) { setError(cause instanceof WorkgraphError ? cause.message : "Could not compile and lock this specification."); }
    finally { setBusy(false); }
  };

  if (specQ.isLoading || decisionsQ.isLoading || claimsQ.isLoading || versionsQ.isLoading) return <SynSkeleton rows={6} />;
  return <div className="space-y-6">
    <StageHeader eyebrow="Approved intent → Immutable contract → WorkItems" title="Compile and generate" description="Compile claims, requirements, and accepted decisions into one immutable version. Then plan, validate, schedule, and apply the WorkItems that implement it." icon={WandSparkles} />
    {error ? <SynError message={error} /> : null}
    {message ? <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"><CheckCircle2 size={16} />{message}</div> : null}
    <div className="grid gap-3 md:grid-cols-4"><Readiness label="Requirements" value={requirements.length} ready={requirements.length > 0} /><Readiness label="Claims" value={claimsQ.data?.items.length ?? 0} ready={(claimsQ.data?.items.length ?? 0) > 0} /><Readiness label="Accepted decisions" value={acceptedDecisions.length} ready={acceptedDecisions.length > 0} optional /><Readiness label="Locked version" value={latest ? `v${latest.version}` : "None"} ready={Boolean(latest && ["LOCKED", "ACTIVE", "APPROVED"].includes(latest.status))} /></div>
    <SynCard className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><LockKeyhole size={16} className="text-secondary" /><h2 className="font-black text-on-surface">Compile and lock the execution contract</h2></div><p className="mt-1 max-w-3xl text-sm text-on-surface-variant">Compilation checks requirement structure and belief health, stores a canonical content hash, and preserves earlier versions. WorkItems bind to the selected version rather than a mutable draft.</p></div><SynButton icon={LockKeyhole} disabled={busy || requirements.length === 0} onClick={() => void compile()}>{busy ? "Compiling…" : "Compile & lock"}</SynButton></div>
      {weakClaims.length ? <div className="mt-5 border-t border-outline-variant pt-4"><MonoMeta>Explicit belief waivers required</MonoMeta><div className="mt-3 space-y-3">{weakClaims.map(claim => <label key={claim.id} className="grid gap-1 text-xs text-on-surface-variant"><span><strong>{Math.round((claim.mean ?? 0) * 100)}%</strong> · {claim.statement}</span><textarea className="min-h-20 rounded-md border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-secondary" value={waivers[claim.id] ?? ""} onChange={event => setWaivers(current => ({ ...current, [claim.id]: event.target.value }))} placeholder="Explain why delivery may proceed despite this low-confidence claim (minimum 20 characters)." /></label>)}</div></div> : null}
    </SynCard>
    <section className="border-t border-outline-variant pt-6"><div className="mb-4 flex items-center gap-2"><Braces size={17} className="text-secondary" /><div><h2 className="font-black text-on-surface">Generation plan</h2><p className="text-xs text-on-surface-variant">Plan → validate coverage, lineage, budget, and dependency DAG → apply idempotently.</p></div></div><ProjectGeneration key={`${projectId}-${generationKey}`} projectId={projectId} /></section>
  </div>;
}

function Readiness({ label, value, ready, optional = false }: { label: string; value: string | number; ready: boolean; optional?: boolean }) { return <div className="rounded-md border border-outline-variant bg-surface px-4 py-3"><div className="flex items-center justify-between"><MonoMeta>{label}</MonoMeta><SynChip tone={ready ? "success" : optional ? "neutral" : "error"}>{ready ? "Ready" : optional ? "Optional" : "Needed"}</SynChip></div><div className="mt-2 text-xl font-black text-on-surface">{value}</div></div>; }
