"use client";

import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { AlertTriangle, CalendarClock, Download, FileSignature, Flag, Plus, RefreshCw, Target } from "lucide-react";
import { apiPath, authHeaders } from "@/lib/api";
import { workgraphFetch, WorkgraphError } from "@/lib/workgraph";
import { SynthesisShell } from "@/components/synthesis/SynthesisShell";
import { NoProjectSelected, ProjectPicker, useSelectedProjectId } from "@/components/synthesis/ProjectPicker";
import { useBusinessAlignment, useGenerationPlans, useProject, useProjectLearning, useSyn } from "@/components/synthesis/hooks/useSynthesis";
import type { SynBusinessMilestone, SynBusinessReadout, SynBusinessRisk, SynGenerationPlan, SynSpecificationVersion } from "@/components/synthesis/types";
import { ConfidenceBar, EmptyState, MonoMeta, StageHeader, SynButton, SynCard, SynChip, SynError, SynSkeleton } from "@/components/synthesis/ui/kit";

const control = "h-10 w-full rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface outline-none focus:border-secondary";
const textArea = `${control} h-auto min-h-24 py-2`;

export function BusinessAlignmentScreen() {
  const pathname = usePathname() ?? "/synthesis/business";
  const projectId = useSelectedProjectId();
  return <SynthesisShell title="Business Alignment" headerActions={<ProjectPicker pathname={pathname} />}>{projectId ? <BusinessAlignment projectId={projectId} /> : <NoProjectSelected surface="Business Alignment" />}</SynthesisShell>;
}

function BusinessAlignment({ projectId }: { projectId: string }) {
  const rollupQ = useBusinessAlignment(projectId);
  const projectQ = useProject(projectId);
  const plansQ = useGenerationPlans(projectId);
  const versionsQ = useSyn<{ items: SynSpecificationVersion[] }>(`/specifications/${projectId}/versions`);
  const learningQ = useProjectLearning(projectId);
  const sponsorGateQ = useSyn<{ required: boolean; estimatedCost: number; requirementCount: number; sponsorId?: string | null; reason: string }>(`/studio/business-alignment/projects/${projectId}/sponsor-gate`);
  const mappingsQ = useSyn<{ items: Array<{ id: string; entityType: string; entityId: string; externalSystem: string; externalType: string; externalLabel?: string | null; costCenterRef?: string | null }> }>(`/studio/business-alignment/projects/${projectId}/taxonomy-mappings`);
  const usersQ = useSyn<{ items: Array<Record<string, unknown>> }>("/lookup/users?size=200&status=ACTIVE");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    await Promise.all([rollupQ.mutate(), plansQ.mutate(), versionsQ.mutate(), sponsorGateQ.mutate(), learningQ.mutate(), mappingsQ.mutate()]);
  };
  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await action(); await refresh(); }
    catch (cause) { setError(cause instanceof WorkgraphError ? cause.message : cause instanceof Error ? cause.message : "The operation could not be completed."); }
    finally { setBusy(null); }
  };

  if (rollupQ.isLoading || projectQ.isLoading) return <SynSkeleton rows={7} />;
  if (!rollupQ.data || !projectQ.data) return <SynError message="Business alignment data could not be loaded." />;
  const rollup = rollupQ.data;
  const latestVersion = versionsQ.data?.items.find(version => ["LOCKED", "ACTIVE", "APPROVED"].includes(version.status));

  return <div className="space-y-8">
    <StageHeader eyebrow="Funded intent → Delivery → Evidence" title="Business alignment" description="Connect every requirement to a business objective, derive milestone and risk status from live delivery evidence, and give sponsors a document whose signed hash proves exactly what they approved." icon={Target} actions={<SynButton variant="secondary" icon={RefreshCw} onClick={() => void refresh()}>Refresh evidence</SynButton>} />
    {error ? <SynError message={error} /> : null}

    <section className="grid gap-px overflow-hidden rounded-md border border-outline-variant bg-outline-variant sm:grid-cols-2 xl:grid-cols-5">
      <Metric label="Objective coverage" value={`${rollup.coverage.coveragePercent}%`} tone={rollup.coverage.errors.length ? "error" : "success"} />
      <Metric label="Finalized work" value={`${rollup.work.finalized}/${rollup.work.total}`} />
      <Metric label="Milestones at risk" value={rollup.milestones.filter(item => ["AT_RISK", "LATE"].includes(item.status)).length} tone={rollup.milestones.some(item => item.status === "LATE") ? "error" : "neutral"} />
      <Metric label="Open risks" value={rollup.risks.filter(item => item.status !== "CLOSED").length} tone={rollup.risks.some(item => item.severity >= 5) ? "error" : "neutral"} />
      <Metric label="Actual burn" value={`$${rollup.burn.actualCostUsd.toLocaleString()}`} />
    </section>

    <Section title="Objectives and bidirectional coverage" description="An objective with no work is unfunded intent. Work with no objective is unexplained scope." icon={Target}>
      <ObjectiveComposer projectId={projectId} ownerId={projectQ.data.sponsorId ?? projectQ.data.productOwnerId ?? ""} users={(usersQ.data?.items ?? []).map(item => ({ id: String(item.id ?? item.userId ?? ""), label: String(item.name ?? item.displayName ?? item.email ?? item.id ?? "") })).filter(item => item.id)} busy={busy} onCreate={(payload) => act("objective", () => workgraphFetch(`/studio/business-alignment/objectives`, { method: "POST", body: JSON.stringify(payload) }))} />
      <div className="mt-5 grid gap-3 lg:grid-cols-2">
        {rollup.objectives.map(objective => <SynCard key={objective.id} className="p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="font-bold text-on-surface">{objective.title}</h3><p className="mt-1 text-sm text-on-surface-variant">{objective.description}</p></div><SynChip tone={objective.status === "ACTIVE" ? "success" : "neutral"}>{objective.status.replaceAll("_", " ")}</SynChip></div><div className="mt-4 flex items-center gap-3"><MonoMeta>Value {objective.valueScore}/5</MonoMeta><div className="min-w-28 flex-1"><ConfidenceBar value={objective.valueScore * 20} /></div>{objective.budgetLineRef ? <SynChip>{objective.budgetLineRef}</SynChip> : null}</div></SynCard>)}
      </div>
      {rollup.objectives.length === 0 ? <div className="mt-5"><EmptyState icon={Target} title="No funded objective yet" description="Create the business outcome first, then attach requirements to it in Specification." /></div> : null}
      <div className="mt-5 space-y-2">{[...rollup.coverage.errors, ...rollup.coverage.warnings].map(issue => <div key={`${issue.code}-${issue.entityId}`} className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${issue.severity === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}><AlertTriangle size={15} className="mt-0.5 shrink-0" /><span>{issue.message}</span><SynChip tone={issue.severity === "error" ? "error" : "tertiary"}>{issue.severity === "error" ? "Blocks lock" : "Review"}</SynChip></div>)}</div>
    </Section>

    <Section title="Milestones and value delivery" description="Milestone status is derived from finalized WorkItems and scheduler projection. It cannot be manually painted green." icon={CalendarClock}>
      <MilestoneComposer plans={plansQ.data?.items ?? []} busy={busy} onCreate={(payload) => act("milestone", () => workgraphFetch(`/studio/business-alignment/projects/${projectId}/milestones`, { method: "POST", body: JSON.stringify(payload) }))} />
      <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead><tr className="border-b border-outline-variant text-xs text-on-surface-variant"><th className="py-2">Milestone</th><th>Business value</th><th>Target</th><th>Projection</th><th>Completion</th><th>Status</th></tr></thead><tbody>{rollup.milestones.map(milestone => <MilestoneRow key={milestone.id} milestone={milestone} />)}</tbody></table></div>
      {rollup.milestones.length === 0 ? <p className="mt-5 text-sm text-on-surface-variant">No business milestones yet. Attach plan rows above so delivery status can be derived.</p> : null}
    </Section>

    <Section title="Sponsor and weekly readouts" description="Each readout is regenerated from live records with citations. Sponsor approval stores the exact content hash." icon={FileSignature}>
      <div className="flex flex-wrap items-center gap-2"><SynButton icon={FileSignature} disabled={Boolean(busy)} onClick={() => void act("sponsor-readout", () => workgraphFetch(`/studio/business-alignment/projects/${projectId}/readouts`, { method: "POST", body: JSON.stringify({ kind: "SPONSOR", specificationVersionId: latestVersion?.id }) }))}>{busy === "sponsor-readout" ? "Generating…" : "Generate sponsor readout"}</SynButton><SynButton variant="secondary" icon={CalendarClock} disabled={Boolean(busy)} onClick={() => void act("weekly-readout", () => workgraphFetch(`/studio/business-alignment/projects/${projectId}/readouts`, { method: "POST", body: JSON.stringify({ kind: "WEEKLY", periodStart: new Date(Date.now() - 7 * 86_400_000).toISOString(), periodEnd: new Date().toISOString() }) }))}>{busy === "weekly-readout" ? "Generating…" : "Generate weekly status"}</SynButton><SynChip tone={sponsorGateQ.data?.required ? "tertiary" : "success"}>{sponsorGateQ.data?.required ? "Sponsor lane required" : "DRI fast lane"}</SynChip><span className="text-xs text-on-surface-variant">{sponsorGateQ.data?.reason}</span></div>
      <div className="mt-5 space-y-3">{rollup.readouts.map(readout => <ReadoutRow key={readout.id} readout={readout} busy={busy} onReview={() => act(`review-${readout.id}`, () => workgraphFetch(`/studio/business-alignment/readouts/${readout.id}/sponsor-review`, { method: "POST" }))} />)}</div>
      {rollup.readouts.length === 0 ? <p className="mt-5 text-sm text-on-surface-variant">Generate the first cited readout when the objective, scope, cost, and milestone picture is ready.</p> : null}
    </Section>

    <Section title="Composed risk register" description="Signals are composed from contested MUST claims, open agent challenges, budget variance, schedule slippage, and material drift." icon={Flag}>
      <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead><tr className="border-b border-outline-variant text-xs text-on-surface-variant"><th className="py-2">Risk</th><th>Category</th><th>Severity</th><th>Owner</th><th>Mitigation</th><th>Status</th><th></th></tr></thead><tbody>{rollup.risks.map(risk => <RiskRow key={risk.id} risk={risk} busy={busy === `risk-${risk.id}`} onUpdate={(payload) => act(`risk-${risk.id}`, () => workgraphFetch(`/studio/business-alignment/risks/${risk.id}`, { method: "PATCH", body: JSON.stringify(payload) }))} />)}</tbody></table></div>
      {rollup.risks.length === 0 ? <p className="text-sm text-on-surface-variant">No active risk signals were composed from the current evidence.</p> : null}
    </Section>

    <Section title="Consequence-priced change" description="Post-lock changes carry requirement, cost, schedule, and milestone consequences before the sponsor makes a decision." icon={AlertTriangle}>
      <ChangeRequestComposer versionId={latestVersion?.id} busy={busy} onCreate={(payload) => act("change-request", () => workgraphFetch(`/studio/business-alignment/projects/${projectId}/change-requests`, { method: "POST", body: JSON.stringify(payload) }))} />
      <div className="mt-5 space-y-3">{(learningQ.data?.changeRequests ?? []).map(change => <SynCard key={change.id} className="p-4"><div className="flex flex-wrap items-center gap-3"><strong className="text-sm text-on-surface">{change.title}</strong><SynChip tone={change.status === "APPROVED" || change.status === "APPLIED" ? "success" : change.status === "REJECTED" ? "error" : "tertiary"}>{change.status.replaceAll("_", " ")}</SynChip><MonoMeta>{new Date(change.createdAt).toLocaleDateString()}</MonoMeta>{["DRAFT", "OPEN", "RECOMMENDED"].includes(change.status) ? <SynButton className="ml-auto" variant="secondary" icon={FileSignature} disabled={Boolean(busy)} onClick={() => void act(`change-review-${change.id}`, () => workgraphFetch(`/studio/business-alignment/change-requests/${change.id}/sponsor-review`, { method: "POST" }))}>Send consequences to sponsor</SynButton> : null}</div><p className="mt-2 text-sm text-on-surface-variant">{change.reason}</p><pre className="mt-3 overflow-x-auto rounded-md bg-surface-container p-3 text-xs text-on-surface">{JSON.stringify({ requirementDeltas: change.requirementDeltas, costDelta: change.costDelta, scheduleDelta: change.scheduleDelta, milestoneImpacts: change.milestoneImpacts }, null, 2)}</pre></SynCard>)}</div>
    </Section>

    <Section title="Evidence and external handoff" description="Export the live trace, spend, signed consent, and decision evidence. Jira remains a deliberate one-way delivery handoff." icon={Download}>
      <TaxonomyMappingComposer rows={(plansQ.data?.items ?? []).flatMap(plan => plan.rows)} mappings={mappingsQ.data?.items ?? []} busy={busy} onSave={(payload) => act("taxonomy", () => workgraphFetch(`/studio/business-alignment/projects/${projectId}/taxonomy-mappings`, { method: "PUT", body: JSON.stringify(payload) }))} />
      <div className="flex flex-wrap gap-2">
        <SynButton variant="secondary" icon={Download} onClick={() => void downloadArtifact(projectId, "traceability.xlsx", setError)}>Traceability XLSX</SynButton>
        <SynButton variant="secondary" icon={Download} onClick={() => void downloadArtifact(projectId, "spend.xlsx", setError)}>Spend XLSX</SynButton>
        <SynButton variant="secondary" icon={Download} onClick={() => void downloadArtifact(projectId, "signed-readouts.docx", setError)}>Signed readouts DOCX</SynButton>
        <SynButton variant="secondary" icon={Download} onClick={() => void downloadArtifact(projectId, "signed-readouts.pdf", setError)}>Signed readouts PDF</SynButton>
        <SynButton variant="secondary" icon={Download} onClick={() => void downloadArtifact(projectId, "decision-log.docx", setError)}>Decision log DOCX</SynButton>
        <SynButton variant="secondary" icon={Download} onClick={() => void downloadArtifact(projectId, "decision-log.pdf", setError)}>Decision log PDF</SynButton>
        <SynButton variant="secondary" icon={Download} onClick={() => void downloadArtifact(projectId, "jira.csv", setError)}>Jira import CSV</SynButton>
      </div>
    </Section>
  </div>;
}

function Section({ title, description, icon: Icon, children }: { title: string; description: string; icon: typeof Target; children: React.ReactNode }) {
  return <section className="border-t border-outline-variant pt-6"><div className="mb-4 flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-secondary-container text-on-secondary-container"><Icon size={17} /></span><div><h2 className="font-display text-lg font-semibold text-on-surface">{title}</h2><p className="text-sm text-on-surface-variant">{description}</p></div></div>{children}</section>;
}

function Metric({ label, value, tone = "neutral" }: { label: string; value: string | number; tone?: "neutral" | "error" | "success" }) { return <div className="bg-surface-container-lowest px-4 py-4"><MonoMeta>{label}</MonoMeta><div className={`mt-2 text-2xl font-black ${tone === "error" ? "text-error" : tone === "success" ? "text-secondary" : "text-on-surface"}`}>{value}</div></div>; }

function ObjectiveComposer({ projectId, ownerId, users, busy, onCreate }: { projectId: string; ownerId: string; users: Array<{ id: string; label: string }>; busy: string | null; onCreate: (payload: Record<string, unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(""); const [description, setDescription] = useState(""); const [owner, setOwner] = useState(ownerId); const [metric, setMetric] = useState(""); const [target, setTarget] = useState(""); const [value, setValue] = useState(3); const [rationale, setRationale] = useState(""); const [budget, setBudget] = useState(""); const [end, setEnd] = useState("");
  if (!open) return <SynButton variant="secondary" icon={Plus} onClick={() => setOpen(true)}>New objective</SynButton>;
  const submit = async () => { await onCreate({ title, description, ownerId: owner, targetMetric: { name: metric, target }, valueScore: value, valueRationale: rationale, budgetLineRef: budget || null, period: { start: new Date().toISOString(), end: new Date(`${end}T23:59:59.000Z`).toISOString() }, projectIds: [projectId], studioProjectId: projectId }); setOpen(false); setTitle(""); setDescription(""); };
  return <div className="grid gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-4 md:grid-cols-2 xl:grid-cols-4"><label className="grid gap-1 text-xs font-bold text-on-surface-variant">Objective title<input className={control} value={title} onChange={event => setTitle(event.target.value)} /></label><label className="grid gap-1 text-xs font-bold text-on-surface-variant">Business owner<select className={control} value={owner} onChange={event => setOwner(event.target.value)}><option value="">Choose an active user</option>{owner && !users.some(user => user.id === owner) ? <option value={owner}>{owner}</option> : null}{users.map(user => <option key={user.id} value={user.id}>{user.label}</option>)}</select></label><label className="grid gap-1 text-xs font-bold text-on-surface-variant">Target metric<input className={control} value={metric} onChange={event => setMetric(event.target.value)} placeholder="Activation rate" /></label><label className="grid gap-1 text-xs font-bold text-on-surface-variant">Target value<input className={control} value={target} onChange={event => setTarget(event.target.value)} placeholder="70%" /></label><label className="grid gap-1 text-xs font-bold text-on-surface-variant md:col-span-2">Business outcome<textarea className={textArea} value={description} onChange={event => setDescription(event.target.value)} /></label><label className="grid gap-1 text-xs font-bold text-on-surface-variant">Value score<select className={control} value={value} onChange={event => setValue(Number(event.target.value))}>{[1, 2, 3, 4, 5].map(item => <option key={item} value={item}>{item} / 5</option>)}</select></label><label className="grid gap-1 text-xs font-bold text-on-surface-variant">Target date<input type="date" className={control} value={end} onChange={event => setEnd(event.target.value)} /></label><label className="grid gap-1 text-xs font-bold text-on-surface-variant md:col-span-2">Value rationale<input className={control} value={rationale} onChange={event => setRationale(event.target.value)} /></label><label className="grid gap-1 text-xs font-bold text-on-surface-variant">Funding line<input className={control} value={budget} onChange={event => setBudget(event.target.value)} /></label><div className="flex items-end gap-2"><SynButton disabled={busy === "objective" || !title || !description || !owner || !metric || !target || !end || !rationale} onClick={() => void submit()}>{busy === "objective" ? "Creating…" : "Create objective"}</SynButton><SynButton variant="ghost" onClick={() => setOpen(false)}>Cancel</SynButton></div></div>;
}

function MilestoneComposer({ plans, busy, onCreate }: { plans: SynGenerationPlan[]; busy: string | null; onCreate: (payload: Record<string, unknown>) => Promise<void> }) {
  const rows = useMemo(() => plans.flatMap(plan => plan.rows), [plans]);
  const [open, setOpen] = useState(false); const [name, setName] = useState(""); const [value, setValue] = useState(""); const [date, setDate] = useState(""); const [rowIds, setRowIds] = useState<string[]>([]);
  if (!open) return <SynButton variant="secondary" icon={Plus} onClick={() => setOpen(true)}>New milestone</SynButton>;
  const submit = async () => { await onCreate({ name, valueStatement: value, targetDate: new Date(`${date}T23:59:59.000Z`).toISOString(), completionDefinition: { rule: "ALL", planRowIds: rowIds, workItemIds: [] } }); setOpen(false); };
  return <div className="grid gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-4 md:grid-cols-2 xl:grid-cols-4"><label className="grid gap-1 text-xs font-bold text-on-surface-variant">Milestone name<input className={control} value={name} onChange={event => setName(event.target.value)} /></label><label className="grid gap-1 text-xs font-bold text-on-surface-variant">Target date<input type="date" className={control} value={date} onChange={event => setDate(event.target.value)} /></label><label className="grid gap-1 text-xs font-bold text-on-surface-variant md:col-span-2">What the business gets<input className={control} value={value} onChange={event => setValue(event.target.value)} /></label><label className="grid gap-1 text-xs font-bold text-on-surface-variant md:col-span-2">Completion plan rows<select multiple className={`${control} h-32 py-2`} value={rowIds} onChange={event => setRowIds(Array.from(event.target.selectedOptions, option => option.value))}>{rows.map(row => <option key={row.id} value={row.id}>{row.rowKey} · {row.title}</option>)}</select></label><div className="flex items-end gap-2"><SynButton disabled={busy === "milestone" || !name || !value || !date || !rowIds.length} onClick={() => void submit()}>{busy === "milestone" ? "Creating…" : "Create milestone"}</SynButton><SynButton variant="ghost" onClick={() => setOpen(false)}>Cancel</SynButton></div></div>;
}

function MilestoneRow({ milestone }: { milestone: SynBusinessMilestone }) { const tone = milestone.status === "DELIVERED" ? "success" : milestone.status === "LATE" ? "error" : milestone.status === "AT_RISK" ? "tertiary" : "neutral"; return <tr className="border-b border-outline-variant"><td className="py-3 font-bold text-on-surface">{milestone.name}</td><td className="max-w-sm text-on-surface-variant">{milestone.valueStatement}</td><td>{new Date(milestone.targetDate).toLocaleDateString()}</td><td>{milestone.projectedFinishAt ? new Date(milestone.projectedFinishAt).toLocaleDateString() : "Not scheduled"}</td><td className="w-44"><ConfidenceBar value={milestone.percentComplete} label={`${milestone.completed}/${milestone.total}`} /></td><td><SynChip tone={tone}>{milestone.status.replaceAll("_", " ")}</SynChip></td></tr>; }

function ReadoutRow({ readout, busy, onReview }: { readout: SynBusinessReadout; busy: string | null; onReview: () => Promise<void> }) { return <SynCard className="p-4"><div className="flex flex-wrap items-center gap-3"><FileSignature size={16} className="text-secondary" /><strong className="text-sm text-on-surface">{readout.kind === "SPONSOR" ? "Sponsor readout" : "Weekly status"}</strong><SynChip tone={readout.status === "SIGNED" ? "success" : readout.status === "PENDING_SPONSOR" ? "tertiary" : "neutral"}>{readout.status.replaceAll("_", " ")}</SynChip><MonoMeta>{new Date(readout.createdAt).toLocaleString()}</MonoMeta><code className="text-[10px] text-on-surface-variant">sha256:{readout.contentHash.slice(0, 12)}</code>{readout.kind === "SPONSOR" && readout.status === "DRAFT" ? <SynButton className="ml-auto" variant="secondary" icon={FileSignature} disabled={Boolean(busy)} onClick={() => void onReview()}>{busy === `review-${readout.id}` ? "Submitting…" : "Request sponsor signature"}</SynButton> : null}</div><details className="mt-3"><summary className="cursor-pointer text-xs font-bold text-secondary">View exact generated document</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-surface-container p-4 text-xs text-on-surface">{readout.renderedMarkdown}</pre></details></SynCard>; }

function RiskRow({ risk, busy, onUpdate }: { risk: SynBusinessRisk; busy: boolean; onUpdate: (payload: Record<string, unknown>) => Promise<void> }) {
  const [mitigation, setMitigation] = useState(risk.mitigation ?? "");
  const [status, setStatus] = useState(risk.status);
  return <tr className="border-b border-outline-variant"><td className="py-3"><strong className="block text-on-surface">{risk.title}</strong><span className="text-xs text-on-surface-variant">{risk.description}</span></td><td>{risk.category}</td><td><SynChip tone={risk.severity >= 5 ? "error" : risk.severity >= 4 ? "tertiary" : "neutral"}>{risk.severity}/5</SynChip></td><td>{risk.ownerId ?? "Unassigned"}</td><td className="min-w-64"><input className={control} value={mitigation} onChange={event => setMitigation(event.target.value)} placeholder="Record mitigation" /></td><td className="min-w-36"><select className={control} value={status} onChange={event => setStatus(event.target.value as SynBusinessRisk["status"])}><option value="OPEN">Open</option><option value="MITIGATING">Mitigating</option><option value="ACCEPTED">Accepted</option><option value="CLOSED">Closed</option></select></td><td><SynButton variant="ghost" disabled={busy || (!mitigation.trim() && status === risk.status)} onClick={() => void onUpdate({ mitigation: mitigation.trim() || null, status })}>{busy ? "Saving…" : "Save"}</SynButton></td></tr>;
}

function ChangeRequestComposer({ versionId, busy, onCreate }: { versionId?: string; busy: string | null; onCreate: (payload: Record<string, unknown>) => Promise<void> }) { const [open, setOpen] = useState(false); const [title, setTitle] = useState(""); const [reason, setReason] = useState(""); const [added, setAdded] = useState(""); const [changed, setChanged] = useState(""); const [removed, setRemoved] = useState(""); const ids = (value: string) => value.split(",").map(item => item.trim()).filter(Boolean); if (!open) return <SynButton variant="secondary" icon={Plus} disabled={!versionId} onClick={() => setOpen(true)}>New change request</SynButton>; const submit = async () => { if (!versionId) return; await onCreate({ specificationVersionId: versionId, title, reason, requirementDeltas: { added: ids(added), changed: ids(changed), removed: ids(removed) } }); setOpen(false); }; return <div className="grid gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-4 md:grid-cols-2 xl:grid-cols-3"><label className="grid gap-1 text-xs font-bold text-on-surface-variant md:col-span-2">Change summary<input className={control} value={title} onChange={event => setTitle(event.target.value)} /></label><MonoMeta className="self-end pb-3">Amends locked version</MonoMeta><label className="grid gap-1 text-xs font-bold text-on-surface-variant md:col-span-2 xl:col-span-3">Why this change is needed<textarea className={textArea} value={reason} onChange={event => setReason(event.target.value)} /></label><label className="grid gap-1 text-xs font-bold text-on-surface-variant">Added requirement ids<input className={control} value={added} onChange={event => setAdded(event.target.value)} placeholder="REQ-12, REQ-13" /></label><label className="grid gap-1 text-xs font-bold text-on-surface-variant">Changed requirement ids<input className={control} value={changed} onChange={event => setChanged(event.target.value)} /></label><label className="grid gap-1 text-xs font-bold text-on-surface-variant">Removed requirement ids<input className={control} value={removed} onChange={event => setRemoved(event.target.value)} /></label><div className="flex gap-2"><SynButton disabled={busy === "change-request" || !title || reason.trim().length < 20 || ids(`${added},${changed},${removed}`).length === 0} onClick={() => void submit()}>{busy === "change-request" ? "Computing…" : "Compute consequences"}</SynButton><SynButton variant="ghost" onClick={() => setOpen(false)}>Cancel</SynButton></div></div>; }

function TaxonomyMappingComposer({ rows, mappings, busy, onSave }: { rows: SynGenerationPlan["rows"]; mappings: Array<{ entityId: string; externalType: string; externalLabel?: string | null; costCenterRef?: string | null }>; busy: string | null; onSave: (payload: Record<string, unknown>) => Promise<void> }) {
  const [rowId, setRowId] = useState("");
  const selected = rows.find(row => row.id === rowId);
  const existing = mappings.find(mapping => mapping.entityId === rowId);
  const [issueType, setIssueType] = useState("Story");
  const [label, setLabel] = useState("");
  const [costCenter, setCostCenter] = useState("");
  const choose = (value: string) => { const match = mappings.find(mapping => mapping.entityId === value); setRowId(value); setIssueType(match?.externalType ?? "Story"); setLabel(match?.externalLabel ?? ""); setCostCenter(match?.costCenterRef ?? ""); };
  return <div className="mb-4 grid gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-4 md:grid-cols-2 xl:grid-cols-5"><label className="grid gap-1 text-xs font-bold text-on-surface-variant xl:col-span-2">Plan row<select className={control} value={rowId} onChange={event => choose(event.target.value)}><option value="">Choose work to map</option>{rows.map(row => <option key={row.id} value={row.id}>{row.rowKey} · {row.title}</option>)}</select></label><label className="grid gap-1 text-xs font-bold text-on-surface-variant">Jira issue type<select className={control} value={issueType} onChange={event => setIssueType(event.target.value)}><option>Story</option><option>Task</option><option>Bug</option><option>Epic</option></select></label><label className="grid gap-1 text-xs font-bold text-on-surface-variant">Label<input className={control} value={label} onChange={event => setLabel(event.target.value)} /></label><label className="grid gap-1 text-xs font-bold text-on-surface-variant">Cost center<input className={control} value={costCenter} onChange={event => setCostCenter(event.target.value)} /></label><div className="flex items-center gap-3 md:col-span-2 xl:col-span-5"><SynButton variant="secondary" disabled={!selected || busy === "taxonomy"} onClick={() => void onSave({ entityType: "GENERATION_PLAN_ROW", entityId: selected?.id, externalSystem: "JIRA", externalType: issueType, externalLabel: label || null, costCenterRef: costCenter || null })}>{busy === "taxonomy" ? "Saving…" : existing ? "Update Jira mapping" : "Save Jira mapping"}</SynButton><span className="text-xs text-on-surface-variant">{mappings.length} explicit mapping{mappings.length === 1 ? "" : "s"}</span></div></div>;
}

async function downloadArtifact(projectId: string, artifact: string, setError: (value: string | null) => void) {
  try {
    setError(null);
    const response = await fetch(apiPath(`/api/workgraph/studio/business-alignment/projects/${projectId}/exports/${artifact}`), { headers: authHeaders() });
    if (!response.ok) throw new Error(await response.text());
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? `${projectId}-${artifact}`;
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : "Could not generate the evidence export.");
  }
}
