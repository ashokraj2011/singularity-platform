"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BadgeDollarSign, CalendarRange, Coins, Gauge, Plus, RefreshCw, Save, TimerReset, Trash2 } from "lucide-react";
import { workgraphFetch, WorkgraphError } from "@/lib/workgraph";
import { SynthesisShell } from "@/components/synthesis/SynthesisShell";
import { NoProjectSelected, ProjectPicker, useSelectedProjectId } from "@/components/synthesis/ProjectPicker";
import { useProjectEconomics } from "@/components/synthesis/hooks/useSynthesis";
import type { SynGenerationPlanRow } from "@/components/synthesis/types";
import { EmptyState, MonoMeta, StageHeader, SynButton, SynCard, SynChip, SynError, SynSkeleton } from "@/components/synthesis/ui/kit";

const control = "w-full rounded-md border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-secondary";
type StageBudgetRow = { key: string; stage: string; tokenLimit: string; costLimitUsd: string };

export function EconomicsWorkspaceScreen() {
  const pathname = usePathname() ?? "/synthesis/economics";
  const projectId = useSelectedProjectId();
  return <SynthesisShell title="Delivery Economics" headerActions={<ProjectPicker pathname={pathname} />}>{projectId ? <Economics projectId={projectId} /> : <NoProjectSelected surface="Delivery Economics" />}</SynthesisShell>;
}

function Economics({ projectId }: { projectId: string }) {
  const query = useProjectEconomics(projectId);
  const [form, setForm] = useState({ currency: "USD", budgetLow: "", budgetHigh: "", tokenLimit: "", warningPercent: "80", hardCapPercent: "120" });
  const [stageBudgets, setStageBudgets] = useState<StageBudgetRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amendment, setAmendment] = useState({ planId: "", requestedStartAt: "", reason: "" });

  useEffect(() => {
    const envelope = query.data?.envelope;
    if (!envelope) return;
    setForm({ currency: envelope.currency, budgetLow: String(envelope.budgetLow ?? ""), budgetHigh: String(envelope.budgetHigh ?? ""), tokenLimit: String(envelope.tokenLimit ?? ""), warningPercent: String(envelope.warningPercent), hardCapPercent: String(envelope.hardCapPercent) });
    setStageBudgets(Object.entries(envelope.stageBudgets ?? {}).map(([stage, value]) => ({ key: crypto.randomUUID(), stage, tokenLimit: String(value.tokenLimit ?? ""), costLimitUsd: String(value.costLimitUsd ?? "") })));
  }, [query.data?.envelope]);

  const rows = useMemo(() => (query.data?.plans ?? []).flatMap(plan => plan.rows.map(row => ({ plan, row }))).sort((left, right) => String(left.row.projectedStartAt ?? "").localeCompare(String(right.row.projectedStartAt ?? ""))), [query.data?.plans]);

  const save = async () => {
    setBusy("budget"); setError(null);
    const stageBudgetPayload = Object.fromEntries(stageBudgets.filter(row => row.stage.trim()).map(row => [row.stage.trim(), { tokenLimit: nullableNumber(row.tokenLimit), costLimitUsd: nullableNumber(row.costLimitUsd) }]));
    try {
      await workgraphFetch(`/studio/projects/${projectId}/budget-envelope`, { method: "PUT", body: JSON.stringify({ currency: form.currency, budgetLow: nullableNumber(form.budgetLow), budgetHigh: nullableNumber(form.budgetHigh), tokenLimit: nullableNumber(form.tokenLimit), warningPercent: Number(form.warningPercent), hardCapPercent: Number(form.hardCapPercent), stageBudgets: stageBudgetPayload }) });
      await query.mutate();
    } catch (cause) { setError(cause instanceof WorkgraphError ? cause.message : "Could not update the budget envelope."); }
    finally { setBusy(null); }
  };

  const proposeAmendment = async () => {
    if (!amendment.planId || amendment.reason.trim().length < 20) { setError("Choose a plan and explain the replan in at least 20 characters."); return; }
    setBusy("amendment"); setError(null);
    try {
      await workgraphFetch(`/generation-plans/${amendment.planId}/amendments`, { method: "POST", body: JSON.stringify({ reason: amendment.reason, ...(amendment.requestedStartAt ? { requestedStartAt: new Date(amendment.requestedStartAt).toISOString() } : {}) }) });
      setAmendment({ planId: "", requestedStartAt: "", reason: "" });
      await query.mutate();
    } catch (cause) { setError(cause instanceof WorkgraphError ? cause.message : "Could not propose the schedule amendment."); }
    finally { setBusy(null); }
  };

  const transitionAmendment = async (planId: string, amendmentId: string, status: "APPROVED" | "REJECTED" | "APPLIED") => {
    setBusy(amendmentId); setError(null);
    try { await workgraphFetch(`/generation-plans/${planId}/amendments/${amendmentId}/transition`, { method: "POST", body: JSON.stringify({ status }) }); await query.mutate(); }
    catch (cause) { setError(cause instanceof WorkgraphError ? cause.message : "Could not update the amendment."); }
    finally { setBusy(null); }
  };

  if (query.isLoading) return <SynSkeleton rows={6} />;
  if (query.error || !query.data) return <SynError message={(query.error as Error)?.message ?? "Economics data is unavailable."} />;
  const data = query.data;
  const decision = data.budgetDecision.effective;
  return <div className="space-y-7">
    <StageHeader eyebrow="Plan · Spend · Learn" title="Economics and delivery timeline" description="Govern model spend and delivery capacity from turn to stage, initiative, and tenant. Schedule amendments never silently rewrite the baseline." icon={BadgeDollarSign} />
    {error ? <SynError message={error} /> : null}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
      <Metric icon={BadgeDollarSign} label="Plan estimate" value={`$${data.rollup.estimatedPlanCostHigh.toLocaleString()}`} detail="High estimate" />
      <Metric icon={Coins} label="LLM cost" value={`$${data.rollup.ledgerCostUsd.toFixed(2)}`} detail={`${data.rollup.costPercent ?? 0}% of envelope`} />
      <Metric icon={TimerReset} label="Tokens used" value={data.rollup.ledgerTokens.toLocaleString()} detail={`${data.rollup.tokenPercent ?? 0}% of limit`} />
      <Metric icon={CalendarRange} label="Scheduled" value={String(rows.length)} detail={`${rows.filter(item => item.row.criticalPath).length} critical`} />
      <Metric icon={TimerReset} label="Actual hours" value={data.rollup.actualHours.toFixed(1)} detail={`${data.rollup.slippedRows} slipped`} />
      <Metric icon={BadgeDollarSign} label="Actual delivery" value={`$${data.rollup.actualCostUsd.toFixed(2)}`} detail="Recorded actuals" />
    </div>

    <div className={`flex flex-wrap items-center gap-4 rounded-md border px-5 py-4 ${decision.status === "HEALTHY" ? "border-outline-variant bg-surface" : decision.status === "WARNING" ? "border-amber-300 bg-amber-50" : "border-red-300 bg-red-50"}`}>
      <Gauge size={20} className="shrink-0" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm text-on-surface">Effective budget control</strong><SynChip tone={decision.status === "HEALTHY" ? "success" : decision.status === "WARNING" ? "tertiary" : "error"}>{decision.status}</SynChip></div><p className="mt-1 text-xs text-on-surface-variant">Action: {decision.action.replaceAll("_", " ")}. Humans remain enabled.{decision.recommendedModelAlias ? ` Economy route: ${decision.recommendedModelAlias}.` : ""}</p></div><div className="text-right text-xs text-on-surface-variant"><div>Initiative {data.budgetDecision.project.percentUsed.toFixed(1)}%</div><div>Tenant {data.budgetDecision.tenant.percentUsed.toFixed(1)}%</div></div>
    </div>

    <SynCard className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="font-black text-on-surface">Initiative and stage envelopes</h2><p className="mt-1 text-sm text-on-surface-variant">The configured warning routes an economy model; 100% pauses agent turns for a DRI raise; the hard cap cannot be bypassed. Human work remains available.</p></div><SynButton icon={Save} disabled={busy === "budget"} onClick={() => void save()}>{busy === "budget" ? "Saving…" : "Save guardrails"}</SynButton></div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-6"><Field label="Currency"><input className={control} maxLength={3} value={form.currency} onChange={event => setForm(current => ({ ...current, currency: event.target.value.toUpperCase() }))} /></Field><Field label="Budget low"><input className={control} type="number" min="0" value={form.budgetLow} onChange={event => setForm(current => ({ ...current, budgetLow: event.target.value }))} /></Field><Field label="Budget high"><input className={control} type="number" min="0" value={form.budgetHigh} onChange={event => setForm(current => ({ ...current, budgetHigh: event.target.value }))} /></Field><Field label="Token limit"><input className={control} type="number" min="1" value={form.tokenLimit} onChange={event => setForm(current => ({ ...current, tokenLimit: event.target.value }))} /></Field><Field label="Warn at %"><input className={control} type="number" min="1" max="100" value={form.warningPercent} onChange={event => setForm(current => ({ ...current, warningPercent: event.target.value }))} /></Field><Field label="Hard cap %"><input className={control} type="number" min="100" max="200" value={form.hardCapPercent} onChange={event => setForm(current => ({ ...current, hardCapPercent: event.target.value }))} /></Field></div>
      <div className="mt-5 border-t border-outline-variant pt-4"><div className="mb-3 flex items-center justify-between"><div><strong className="text-sm text-on-surface">Stage budgets</strong><p className="text-xs text-on-surface-variant">Optional limits matched to a workflow node label or configured stage key.</p></div><SynButton variant="secondary" icon={Plus} onClick={() => setStageBudgets(current => [...current, { key: crypto.randomUUID(), stage: "", tokenLimit: "", costLimitUsd: "" }])}>Add stage</SynButton></div>{!stageBudgets.length ? <p className="text-xs text-on-surface-variant">No stage-specific limits. The initiative envelope applies.</p> : <div className="space-y-2">{stageBudgets.map((row, index) => <div key={row.key} className="grid gap-2 sm:grid-cols-[minmax(180px,1fr)_150px_150px_36px]"><input className={control} placeholder="Stage key" value={row.stage} onChange={event => setStageBudgets(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, stage: event.target.value } : item))} /><input className={control} type="number" min="1" placeholder="Token limit" value={row.tokenLimit} onChange={event => setStageBudgets(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, tokenLimit: event.target.value } : item))} /><input className={control} type="number" min="0" placeholder="Cost limit" value={row.costLimitUsd} onChange={event => setStageBudgets(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, costLimitUsd: event.target.value } : item))} /><button className="icon-button" title="Remove stage budget" onClick={() => setStageBudgets(current => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={15} /></button></div>)}</div>}</div>
    </SynCard>

    <section>
      <div className="mb-3 flex items-center justify-between"><div><h2 className="font-black text-on-surface">Capacity timeline and actuals</h2><p className="text-xs text-on-surface-variant">Projected dates consume capability calendars, holidays, existing allocations, and WIP. Actuals make slippage and cost visible.</p></div><Link className="text-xs font-bold text-secondary" href={`/synthesis/generate?projectId=${encodeURIComponent(projectId)}`}>Open generation</Link></div>
      {!rows.length ? <EmptyState icon={CalendarRange} title="No validated schedule" description="Validate a generation plan to calculate capacity-aware dates and critical path." /> : <div className="overflow-x-auto rounded-md border border-outline-variant bg-surface"><div className="min-w-[1140px]"><div className="grid grid-cols-[minmax(190px,1fr)_100px_100px_100px_100px_110px_100px_250px] gap-3 border-b border-outline-variant bg-surface-container px-4 py-2 text-[10px] font-black uppercase text-on-surface-variant"><span>WorkItem</span><span>Plan start</span><span>Plan finish</span><span>Actual finish</span><span>Plan hours</span><span>Actual</span><span>State</span><span>Record delivery actuals</span></div>{rows.map(({ plan, row }) => <div key={row.id} className="grid grid-cols-[minmax(190px,1fr)_100px_100px_100px_100px_110px_100px_250px] gap-3 border-b border-outline-variant px-4 py-3 text-xs last:border-b-0"><span className="min-w-0"><strong className="block truncate text-on-surface">{row.title}</strong><span className="text-on-surface-variant">{row.capacityCalendarId ? "capacity scheduled" : "default calendar"}{row.criticalPath ? " · critical" : ""}</span></span><span>{formatDate(row.projectedStartAt)}</span><span>{formatDate(row.projectedFinishAt)}</span><span className={isLate(row) ? "font-bold text-error" : ""}>{formatDate(row.actualFinishAt)}</span><span>{row.estimatedHours ?? "–"}</span><span>{row.actualHours ?? "–"} h · ${(row.actualCostUsd ?? 0).toFixed(0)}</span><SynChip tone={row.state === "APPLIED" ? "success" : row.state === "FAILED" ? "error" : "neutral"}>{row.state}</SynChip><ActualsEditor planId={plan.id} row={row} onSaved={() => query.mutate()} onError={setError} /></div>)}</div></div>}
    </section>

    <SynCard className="p-5">
      <div><h2 className="font-black text-on-surface">Governed replan</h2><p className="mt-1 text-xs text-on-surface-variant">A replan is an amendment proposal. Another user approves it before dates and allocations move.</p></div>
      <div className="mt-4 grid gap-3 lg:grid-cols-[220px_190px_minmax(240px,1fr)_auto]"><select className={control} value={amendment.planId} onChange={event => setAmendment(current => ({ ...current, planId: event.target.value }))}><option value="">Choose plan</option>{data.plans.filter(plan => ["VALIDATED", "APPLIED", "PARTIAL"].includes(plan.status)).map(plan => <option key={plan.id} value={plan.id}>{plan.id.slice(0, 8)} · {plan.status}</option>)}</select><input className={control} type="datetime-local" value={amendment.requestedStartAt} onChange={event => setAmendment(current => ({ ...current, requestedStartAt: event.target.value }))} /><input className={control} placeholder="Why must the baseline change?" value={amendment.reason} onChange={event => setAmendment(current => ({ ...current, reason: event.target.value }))} /><SynButton icon={RefreshCw} disabled={busy === "amendment"} onClick={() => void proposeAmendment()}>{busy === "amendment" ? "Proposing…" : "Propose"}</SynButton></div>
      <div className="mt-4 space-y-2">{data.plans.flatMap(plan => (plan.amendments ?? []).map(item => <div key={item.id} className="flex flex-wrap items-center gap-2 rounded-md border border-outline-variant px-3 py-2"><SynChip tone={item.status === "APPLIED" ? "success" : item.status === "REJECTED" ? "error" : "secondary"}>#{item.generation} {item.status}</SynChip><span className="min-w-0 flex-1 truncate text-xs text-on-surface">{item.reason}</span>{item.status === "IN_REVIEW" ? <><SynButton className="h-8 text-xs" disabled={busy === item.id} onClick={() => void transitionAmendment(plan.id, item.id, "APPROVED")}>Approve</SynButton><SynButton className="h-8 text-xs" variant="secondary" disabled={busy === item.id} onClick={() => void transitionAmendment(plan.id, item.id, "REJECTED")}>Reject</SynButton></> : null}{item.status === "APPROVED" ? <SynButton className="h-8 text-xs" disabled={busy === item.id} onClick={() => void transitionAmendment(plan.id, item.id, "APPLIED")}>Apply baseline</SynButton> : null}</div>))}</div>
    </SynCard>

    <section><h2 className="mb-3 font-black text-on-surface">Budget control events</h2>{!data.budgetEvents.length ? <EmptyState icon={Gauge} title="No budget controls fired" description="Warnings and hard-cap decisions are recorded here when governed model usage crosses an envelope." /> : <div className="space-y-2">{data.budgetEvents.map(event => <div key={event.id} className="flex flex-wrap items-center gap-3 rounded-md border border-outline-variant bg-surface px-4 py-3 text-xs"><SynChip tone={event.status === "WARNING" ? "tertiary" : "error"}>{event.status}</SynChip><strong>{event.stage ?? "Initiative"}</strong><span>{event.percentUsed.toFixed(1)}% · {event.action.replaceAll("_", " ")}</span><span className="ml-auto text-on-surface-variant">{new Date(event.createdAt).toLocaleString()}</span>{event.traceId ? <Link className="font-bold text-secondary" href={`/audit/trace/${encodeURIComponent(event.traceId)}`}>Trace</Link> : null}</div>)}</div>}</section>
    <section><h2 className="mb-3 font-black text-on-surface">Model usage ledger</h2>{!data.ledger.length ? <EmptyState icon={Coins} title="No model usage recorded" description="Workflow node usage attached to this initiative will appear here with trace links." /> : <div className="space-y-2">{data.ledger.slice(0, 30).map(entry => <div key={entry.id} className="flex flex-wrap items-center gap-3 rounded-md border border-outline-variant bg-surface px-4 py-3 text-xs"><strong>{entry.stage ?? "Workflow"}</strong><span>{entry.provider ?? "provider"} / {entry.model ?? "model"}</span><span className="ml-auto">{entry.totalTokens.toLocaleString()} tokens · ${(entry.estimatedCostUsd ?? 0).toFixed(4)}</span>{entry.traceId ? <Link className="font-bold text-secondary" href={`/audit/trace/${encodeURIComponent(entry.traceId)}`}>Trace</Link> : null}</div>)}</div>}</section>
  </div>;
}

function ActualsEditor({ planId, row, onSaved, onError }: { planId: string; row: SynGenerationPlanRow; onSaved: () => Promise<unknown>; onError: (message: string | null) => void }) {
  const [hours, setHours] = useState(String(row.actualHours ?? ""));
  const [cost, setCost] = useState(String(row.actualCostUsd ?? ""));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); onError(null);
    const actualHours = nullableNumber(hours);
    const actualCostUsd = nullableNumber(cost);
    try { await workgraphFetch(`/generation-plans/${planId}/rows/${row.id}/actuals`, { method: "PATCH", body: JSON.stringify({ actualStartAt: row.actualStartAt ?? new Date().toISOString(), actualFinishAt: new Date().toISOString(), ...(actualHours !== null ? { actualHours } : {}), ...(actualCostUsd !== null ? { actualCostUsd } : {}) }) }); await onSaved(); }
    catch (cause) { onError(cause instanceof WorkgraphError ? cause.message : "Could not record actuals."); }
    finally { setBusy(false); }
  };
  return <div className="flex items-center gap-1"><input className="w-16 rounded border border-outline-variant bg-surface px-2 py-1" type="number" min="0" placeholder="hours" value={hours} onChange={event => setHours(event.target.value)} /><input className="w-20 rounded border border-outline-variant bg-surface px-2 py-1" type="number" min="0" placeholder="cost" value={cost} onChange={event => setCost(event.target.value)} /><button className="icon-button" disabled={busy} title="Record completion actuals" onClick={() => void save()}><Save size={14} /></button></div>;
}

function Metric({ icon: Icon, label, value, detail }: { icon: typeof BadgeDollarSign; label: string; value: string; detail: string }) { return <div className="rounded-md border border-outline-variant bg-surface p-4"><div className="flex items-center gap-2 text-on-surface-variant"><Icon size={15} /><MonoMeta>{label}</MonoMeta></div><div className="mt-3 text-2xl font-black text-on-surface">{value}</div><p className="mt-1 text-xs text-on-surface-variant">{detail}</p></div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="grid gap-1 text-xs font-bold text-on-surface-variant">{label}{children}</label>; }
function nullableNumber(value: string) { if (!value.trim()) return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function formatDate(value?: string | null) { return value ? new Date(value).toLocaleDateString() : "–"; }
function isLate(row: SynGenerationPlanRow) { return Boolean(row.actualFinishAt && row.projectedFinishAt && new Date(row.actualFinishAt) > new Date(row.projectedFinishAt)); }
