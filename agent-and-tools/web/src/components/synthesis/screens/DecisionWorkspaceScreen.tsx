"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CheckCircle2, GitCompareArrows, Plus, Scale, Send } from "lucide-react";
import { workgraphFetch, WorkgraphError } from "@/lib/workgraph";
import { SynthesisShell } from "@/components/synthesis/SynthesisShell";
import { NoProjectSelected, ProjectPicker, useSelectedProjectId } from "@/components/synthesis/ProjectPicker";
import { useClaims, useDecisions } from "@/components/synthesis/hooks/useSynthesis";
import { EmptyState, MonoMeta, StageHeader, SynButton, SynCard, SynChip, SynError, SynSkeleton } from "@/components/synthesis/ui/kit";

type OptionDraft = { title: string; summary: string; estimatedHours: string; estimatedCostHigh: string; estimatedTokens: string };
const emptyOption = (): OptionDraft => ({ title: "", summary: "", estimatedHours: "", estimatedCostHigh: "", estimatedTokens: "" });
const control = "w-full rounded-md border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-secondary";

export function DecisionWorkspaceScreen() {
  const pathname = usePathname() ?? "/synthesis/decisions";
  const projectId = useSelectedProjectId();
  return (
    <SynthesisShell title="Decisions" headerActions={<ProjectPicker pathname={pathname} />}>
      {projectId ? <DecisionWorkspace projectId={projectId} /> : <NoProjectSelected surface="Decisions" />}
    </SynthesisShell>
  );
}

function DecisionWorkspace({ projectId }: { projectId: string }) {
  const decisionsQ = useDecisions(projectId);
  const claimsQ = useClaims(projectId);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [problem, setProblem] = useState("");
  const [claimRefs, setClaimRefs] = useState<string[]>([]);
  const [options, setOptions] = useState<OptionDraft[]>([emptyOption(), emptyOption()]);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createDossier = async () => {
    const normalized = options.filter(option => option.title.trim() && option.summary.trim());
    if (!title.trim() || !problem.trim() || normalized.length < 2) {
      setError("A governed decision needs a title, a problem statement, and at least two complete options.");
      return;
    }
    setBusy("create"); setError(null);
    try {
      await workgraphFetch(`/studio/projects/${projectId}/decisions`, {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(), problem: problem.trim(), claimRefs,
          options: normalized.map(option => ({
            title: option.title.trim(), summary: option.summary.trim(), claimRefs,
            ...(option.estimatedHours.trim() ? { estimatedHours: Number(option.estimatedHours) } : {}),
            ...(option.estimatedCostHigh.trim() ? { estimatedCostHigh: Number(option.estimatedCostHigh) } : {}),
            ...(option.estimatedTokens.trim() ? { estimatedTokens: Math.round(Number(option.estimatedTokens)) } : {}),
          })),
        }),
      });
      setTitle(""); setProblem(""); setClaimRefs([]); setOptions([emptyOption(), emptyOption()]); setCreating(false);
      await decisionsQ.mutate();
    } catch (cause) { setError(cause instanceof WorkgraphError ? cause.message : "Could not create the decision dossier."); }
    finally { setBusy(null); }
  };

  const requestReview = async (dossierId: string) => {
    const selectedOptionId = selections[dossierId];
    if (!selectedOptionId) { setError("Select the recommended option before requesting review."); return; }
    setBusy(dossierId); setError(null);
    try {
      await workgraphFetch(`/studio/decisions/${dossierId}/review`, { method: "POST", body: JSON.stringify({ selectedOptionId }) });
      await decisionsQ.mutate();
    } catch (cause) { setError(cause instanceof WorkgraphError ? cause.message : "Could not request decision review."); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-6">
      <StageHeader eyebrow="Claims → Options → Approval" title="Decision dossiers" description="Keep alternatives durable, record why one option wins, and require an independent approval before the specification can consume it." icon={Scale} actions={<SynButton icon={Plus} onClick={() => setCreating(value => !value)}>{creating ? "Close" : "New decision"}</SynButton>} />
      {error ? <SynError message={error} /> : null}
      {creating ? (
        <SynCard className="p-5">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="space-y-3">
              <label className="grid gap-1 text-xs font-bold text-on-surface-variant">Decision title<input className={control} value={title} onChange={event => setTitle(event.target.value)} placeholder="Choose repository migration strategy" /></label>
              <label className="grid gap-1 text-xs font-bold text-on-surface-variant">Problem to resolve<textarea className={`${control} min-h-24 resize-y`} value={problem} onChange={event => setProblem(event.target.value)} placeholder="What must be decided, by when, and under which constraints?" /></label>
            </div>
            <label className="grid content-start gap-1 text-xs font-bold text-on-surface-variant">Claims this decision relies on<select multiple className={`${control} min-h-32`} value={claimRefs} onChange={event => setClaimRefs(Array.from(event.target.selectedOptions, option => option.value))}>{(claimsQ.data?.items ?? []).map(claim => <option key={claim.id} value={claim.id}>{claim.statement.slice(0, 70)}</option>)}</select><span className="font-normal">Use Ctrl/Cmd to select several claims.</span></label>
          </div>
          <div className="mt-5 grid gap-3 lg:grid-cols-2">
            {options.map((option, index) => <OptionEditor key={index} index={index} option={option} onChange={patch => setOptions(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item))} />)}
          </div>
          <div className="mt-4 flex gap-2"><SynButton variant="secondary" icon={Plus} onClick={() => setOptions(current => [...current, emptyOption()])}>Add option</SynButton><SynButton icon={Scale} disabled={busy === "create"} onClick={() => void createDossier()}>{busy === "create" ? "Creating…" : "Create dossier"}</SynButton></div>
        </SynCard>
      ) : null}

      {decisionsQ.isLoading ? <SynSkeleton rows={4} /> : decisionsQ.error ? <SynError message={(decisionsQ.error as Error).message} /> : !(decisionsQ.data?.items.length) ? <EmptyState icon={GitCompareArrows} title="No decisions yet" description="Create alternatives here before locking the specification. Rejected options stay visible as design evidence." /> : (
        <div className="space-y-4">{decisionsQ.data.items.map(dossier => (
          <SynCard key={dossier.id} className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h2 className="text-base font-black text-on-surface">{dossier.title}</h2><SynChip tone={dossier.status === "ACCEPTED" ? "success" : dossier.status === "REJECTED" ? "error" : "neutral"}>{dossier.status.replaceAll("_", " ")}</SynChip></div><p className="mt-1 max-w-3xl text-sm text-on-surface-variant">{dossier.problem}</p></div><MonoMeta>Revision {dossier.revision}</MonoMeta></div>
            <div className="mt-4 grid gap-3 lg:grid-cols-2">{dossier.options.map(option => {
              const selected = (selections[dossier.id] ?? dossier.acceptedOptionId) === option.id;
              return <label key={option.id} className={`rounded-md border p-4 ${selected ? "border-secondary bg-secondary-container/30" : "border-outline-variant bg-surface"}`}><div className="flex items-center gap-2"><input type="radio" name={`decision-${dossier.id}`} disabled={!['DRAFT', 'CHANGES_REQUESTED'].includes(dossier.status)} checked={selected} onChange={() => setSelections(current => ({ ...current, [dossier.id]: option.id }))} /><strong className="text-sm text-on-surface">{option.title}</strong>{option.status === "ACCEPTED" ? <CheckCircle2 size={14} className="text-secondary" /> : null}</div><p className="mt-2 text-xs leading-5 text-on-surface-variant">{option.summary}</p><div className="mt-3 flex flex-wrap gap-2"><SynChip>{option.estimatedHours ?? "–"}h</SynChip><SynChip>{option.estimatedCostHigh == null ? "No cost" : `$${option.estimatedCostHigh.toLocaleString()}`}</SynChip><SynChip>{option.estimatedTokens?.toLocaleString() ?? "No token estimate"}</SynChip></div></label>;
            })}</div>
            {['DRAFT', 'CHANGES_REQUESTED'].includes(dossier.status) ? <div className="mt-4 flex justify-end"><SynButton icon={Send} disabled={busy === dossier.id} onClick={() => void requestReview(dossier.id)}>{busy === dossier.id ? "Requesting…" : "Request independent review"}</SynButton></div> : null}
          </SynCard>
        ))}</div>
      )}
      <div className="text-xs text-on-surface-variant">Reviewers act from the platform approval inbox. The author cannot approve their own dossier. <Link className="font-bold text-secondary" href="/approvals">Open approvals</Link></div>
    </div>
  );
}

function OptionEditor({ index, option, onChange }: { index: number; option: OptionDraft; onChange: (patch: Partial<OptionDraft>) => void }) {
  return <div className="rounded-md border border-outline-variant p-4"><MonoMeta>Option {index + 1}</MonoMeta><div className="mt-3 space-y-3"><input className={control} value={option.title} onChange={event => onChange({ title: event.target.value })} placeholder="Option title" /><textarea className={`${control} min-h-20 resize-y`} value={option.summary} onChange={event => onChange({ summary: event.target.value })} placeholder="Approach, trade-offs, and expected outcome" /><div className="grid grid-cols-3 gap-2"><input className={control} type="number" min="0" value={option.estimatedHours} onChange={event => onChange({ estimatedHours: event.target.value })} placeholder="Hours" /><input className={control} type="number" min="0" value={option.estimatedCostHigh} onChange={event => onChange({ estimatedCostHigh: event.target.value })} placeholder="Cost high" /><input className={control} type="number" min="0" value={option.estimatedTokens} onChange={event => onChange({ estimatedTokens: event.target.value })} placeholder="Tokens" /></div></div></div>;
}
