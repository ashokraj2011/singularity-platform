"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  FolderKanban,
  Gauge,
  Lightbulb,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Target,
} from "lucide-react";
import { SynthesisShell } from "@/components/synthesis/SynthesisShell";
import {
  EmptyState,
  MonoMeta,
  SynButton,
  SynCard,
  SynChip,
  SynError,
  SynSkeleton,
} from "@/components/synthesis/ui/kit";
import { usePortfolio, useSyn } from "@/components/synthesis/hooks/useSynthesis";
import { workgraphFetch } from "@/lib/workgraph";
import type { SynProject } from "@/components/synthesis/types";

type LookupItem = Record<string, unknown>;
type SelectOption = { id: string; name: string };

type InitiativeForm = {
  name: string;
  mission: string;
  primaryCapabilityId: string;
  tokenBudget: string;
  costBudgetUsd: string;
  businessValue: string;
  customerImpact: string;
  strategicAlignment: string;
  urgency: string;
  deliveryRisk: string;
  technicalRisk: string;
  regulatoryRisk: string;
  confidence: string;
  effort: string;
  targetDate: string;
  reviewCadenceDays: string;
  sponsorId: string;
  productOwnerId: string;
  successMetrics: string;
  tags: string;
};

const EMPTY_FORM: InitiativeForm = {
  name: "",
  mission: "",
  primaryCapabilityId: "",
  tokenBudget: "250000",
  costBudgetUsd: "",
  businessValue: "",
  customerImpact: "",
  strategicAlignment: "",
  urgency: "",
  deliveryRisk: "",
  technicalRisk: "",
  regulatoryRisk: "",
  confidence: "",
  effort: "",
  targetDate: "",
  reviewCadenceDays: "30",
  sponsorId: "",
  productOwnerId: "",
  successMetrics: "",
  tags: "",
};

export default function WorkspaceHubPage() {
  const { data, error, isLoading, mutate } = usePortfolio({ refreshInterval: 20000 });
  const capabilitiesQ = useSyn<{ items: LookupItem[] }>("/lookup/capabilities?size=200&status=ACTIVE");
  const usersQ = useSyn<{ items: LookupItem[] }>("/lookup/users?size=200&status=ACTIVE");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [showPortfolioFields, setShowPortfolioFields] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<InitiativeForm>(EMPTY_FORM);

  const capabilities = useMemo(() => normalizeLookup(capabilitiesQ.data?.items ?? []), [capabilitiesQ.data]);
  const users = useMemo(() => normalizeLookup(usersQ.data?.items ?? []), [usersQ.data]);
  const projects = data?.projects ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((project) => [
      project.name,
      project.code,
      project.mission,
      project.primaryCapabilityName,
      ...(project.tags ?? []),
    ].some((value) => String(value ?? "").toLowerCase().includes(q)));
  }, [projects, query]);

  const setField = <K extends keyof InitiativeForm>(key: K, value: InitiativeForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  async function createProject() {
    if (!form.name.trim() || !form.primaryCapabilityId || busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const project = await workgraphFetch<SynProject>("/studio/projects", {
        method: "POST",
        body: JSON.stringify(toPayload(form)),
      });
      setForm(EMPTY_FORM);
      setCreating(false);
      setShowPortfolioFields(false);
      setNotice(`${project.name} is ready. The assigned capability agent is preparing an impact brief.`);
      await mutate();
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "The initiative could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SynthesisShell
      title="Workspace Hub"
      headerActions={
        <>
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search initiatives" className="h-9 w-56 rounded-lg border border-outline-variant bg-surface-container-low pl-9 pr-3 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-secondary focus:outline-none" />
          </div>
          <SynButton icon={Plus} onClick={() => setCreating((value) => !value)}>New initiative</SynButton>
        </>
      }
    >
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <MonoMeta className="mb-1 block">Portfolio command</MonoMeta>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-on-surface">Active initiatives</h1>
          <p className="mt-1 max-w-2xl text-sm text-on-surface-variant">Fund outcomes, watch risk and aging, and keep every initiative accountable to one platform capability.</p>
        </div>
        {data ? <MonoMeta>{projects.length} initiatives · {data.standaloneWorkItems.length} standalone work items</MonoMeta> : null}
      </div>

      {notice ? <div className="mb-5 flex items-center gap-2 rounded-lg border border-secondary/30 bg-secondary-container/50 px-4 py-3 text-sm text-on-secondary-container"><Sparkles size={16} />{notice}</div> : null}

      {creating ? (
        <InitiativeComposer
          form={form}
          capabilities={capabilities}
          users={users}
          busy={busy}
          error={formError}
          showPortfolioFields={showPortfolioFields}
          setShowPortfolioFields={setShowPortfolioFields}
          setField={setField}
          onCreate={createProject}
          onCancel={() => { setCreating(false); setFormError(null); }}
        />
      ) : null}

      {error ? <SynError message={`Could not load the portfolio: ${(error as Error).message}`} /> : isLoading ? (
        <SynSkeleton rows={4} />
      ) : filtered.length === 0 ? (
        <EmptyState icon={FolderKanban} title={query ? "No matching initiatives" : "No initiatives yet"} description={query ? "Try a different search term." : "Create an initiative, attach it to one capability, and let that capability agent identify impact and claims."} action={!query ? <SynButton icon={Plus} onClick={() => setCreating(true)}>New initiative</SynButton> : undefined} />
      ) : (
        <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((project) => <ProjectCard key={project.id} project={project} onRefresh={() => mutate()} />)}
        </div>
      )}
    </SynthesisShell>
  );
}

function InitiativeComposer({
  form,
  capabilities,
  users,
  busy,
  error,
  showPortfolioFields,
  setShowPortfolioFields,
  setField,
  onCreate,
  onCancel,
}: {
  form: InitiativeForm;
  capabilities: SelectOption[];
  users: SelectOption[];
  busy: boolean;
  error: string | null;
  showPortfolioFields: boolean;
  setShowPortfolioFields: (value: boolean) => void;
  setField: <K extends keyof InitiativeForm>(key: K, value: InitiativeForm[K]) => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  const scoreFields: Array<[keyof InitiativeForm, string, string]> = [
    ["businessValue", "Business value", "Expected commercial or operational value"],
    ["customerImpact", "Customer impact", "Reach and depth of customer outcome"],
    ["strategicAlignment", "Strategic alignment", "Fit with current strategy"],
    ["urgency", "Urgency", "Time sensitivity"],
    ["confidence", "Confidence", "Strength of evidence"],
    ["effort", "Effort", "Relative delivery effort"],
    ["deliveryRisk", "Delivery risk", "Schedule and execution uncertainty"],
    ["technicalRisk", "Technical risk", "Architecture and engineering uncertainty"],
    ["regulatoryRisk", "Regulatory risk", "Compliance and control exposure"],
  ];
  return (
    <SynCard className="mb-8 overflow-hidden">
      <div className="border-b border-outline-variant px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-secondary-container text-on-secondary-container"><Target size={18} /></span>
          <div><h2 className="font-display text-lg font-semibold text-on-surface">Frame the initiative</h2><p className="text-xs text-on-surface-variant">Exactly one platform capability and a token budget are required. Everything else sharpens prioritization.</p></div>
        </div>
      </div>
      <div className="grid gap-4 p-5 lg:grid-cols-2">
        <Field label="Initiative name" required><input autoFocus value={form.name} onChange={(event) => setField("name", event.target.value)} placeholder="e.g. Unified billing experience" className={inputClass} /></Field>
        <Field label="Capability" required hint="One initiative belongs to one platform capability"><select value={form.primaryCapabilityId} onChange={(event) => setField("primaryCapabilityId", event.target.value)} className={inputClass}><option value="">Choose capability</option>{capabilities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        <Field label="Outcome / mission" className="lg:col-span-2"><textarea value={form.mission} onChange={(event) => setField("mission", event.target.value)} placeholder="What changes for customers or the business when this succeeds?" className={`${inputClass} min-h-20 py-2`} /></Field>
        <Field label="Token budget" required hint="Shared by capability analysis and workflow LLM usage"><input type="number" min={10000} step={10000} value={form.tokenBudget} onChange={(event) => setField("tokenBudget", event.target.value)} className={inputClass} /></Field>
        <Field label="Optional cost guardrail (USD)"><input type="number" min={0} step="10" value={form.costBudgetUsd} onChange={(event) => setField("costBudgetUsd", event.target.value)} placeholder="No cost cap" className={inputClass} /></Field>
      </div>

      <button type="button" className="flex w-full items-center justify-between border-y border-outline-variant bg-surface-container-low px-5 py-3 text-left text-sm font-semibold text-on-surface" onClick={() => setShowPortfolioFields(!showPortfolioFields)}>
        <span className="flex items-center gap-2"><Gauge size={16} className="text-secondary" /> Value, risk, timing, owners, and outcomes</span>
        {showPortfolioFields ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {showPortfolioFields ? (
        <div className="space-y-6 p-5">
          <section>
            <MonoMeta className="mb-3 block">Portfolio scoring · optional · 1 low to 5 high</MonoMeta>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {scoreFields.map(([key, label, hint]) => <Field key={key} label={label} hint={hint}><select value={String(form[key])} onChange={(event) => setField(key, event.target.value as never)} className={inputClass}><option value="">Not scored</option>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} · {scoreLabel(value)}</option>)}</select></Field>)}
            </div>
          </section>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Target date"><input type="date" value={form.targetDate} onChange={(event) => setField("targetDate", event.target.value)} className={inputClass} /></Field>
            <Field label="Review cadence"><select value={form.reviewCadenceDays} onChange={(event) => setField("reviewCadenceDays", event.target.value)} className={inputClass}>{[14, 30, 60, 90].map((days) => <option key={days} value={days}>Every {days} days</option>)}</select></Field>
            <Field label="Sponsor"><select value={form.sponsorId} onChange={(event) => setField("sponsorId", event.target.value)} className={inputClass}><option value="">Unassigned</option>{users.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
            <Field label="Product owner"><select value={form.productOwnerId} onChange={(event) => setField("productOwnerId", event.target.value)} className={inputClass}><option value="">Unassigned</option>{users.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          </section>
          <section className="grid gap-3 lg:grid-cols-2">
            <Field label="Success metrics" hint="One measurable outcome per line"><textarea value={form.successMetrics} onChange={(event) => setField("successMetrics", event.target.value)} placeholder={"Reduce cycle time by 20%\nIncrease successful self-service to 80%"} className={`${inputClass} min-h-24 py-2`} /></Field>
            <Field label="Tags" hint="Comma separated"><textarea value={form.tags} onChange={(event) => setField("tags", event.target.value)} placeholder="customer-facing, fy27, regulatory" className={`${inputClass} min-h-24 py-2`} /></Field>
          </section>
        </div>
      ) : null}

      {error ? <div className="mx-5 mb-4"><SynError message={error} /></div> : null}
      <div className="flex flex-wrap justify-end gap-2 px-5 pb-5">
        <SynButton variant="ghost" onClick={onCancel}>Cancel</SynButton>
        <SynButton icon={Sparkles} onClick={onCreate} disabled={busy || !form.name.trim() || !form.primaryCapabilityId || Number(form.tokenBudget) < 10000}>{busy ? "Creating…" : "Create and assess impact"}</SynButton>
      </div>
    </SynCard>
  );
}

function ProjectCard({ project, onRefresh }: { project: SynProject; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [assessing, setAssessing] = useState(false);
  const assessments = project.impactAssessments ?? [];
  const completed = assessments.filter((item) => item.status === "COMPLETED");
  const recommendationCount = completed.reduce((sum, item) => sum + (item.recommendations?.length ?? 0), 0);

  async function assess() {
    setAssessing(true);
    try {
      await workgraphFetch(`/studio/projects/${project.id}/impact-assessments/run`, { method: "POST", body: JSON.stringify({}) });
      onRefresh();
    } finally {
      setAssessing(false);
    }
  }

  return (
    <SynCard as="article" className="overflow-hidden">
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2"><MonoMeta>{project.code}</MonoMeta><AgingChip project={project} /></div>
          <SynChip tone={project.status === "ACTIVE" ? "secondary" : "neutral"} mono>{project.status}</SynChip>
        </div>
        <Link href={`/synthesis/ideas?project=${project.id}`} className="mt-4 block rounded-md focus:outline-none focus:ring-2 focus:ring-secondary">
          <h3 className="font-display text-lg font-semibold leading-snug text-on-surface">{project.name}</h3>
          <p className="mt-1.5 line-clamp-2 min-h-10 text-sm text-on-surface-variant">{project.mission || "Outcome has not been framed yet."}</p>
        </Link>

        <div className="mt-4 flex items-center gap-2 text-xs font-semibold text-on-surface"><Target size={14} className="text-secondary" />{project.assignedCapability?.name ?? project.primaryCapabilityName ?? "Capability not assigned"}</div>

        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-on-surface-variant"><span>Token guardrail</span><span className="font-mono tabular-nums">{compact(project.tokenUsed)} / {compact(project.tokenBudget)}</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-container-high"><div className={`h-full rounded-full ${(project.tokenBudgetPercent ?? 0) >= 90 ? "bg-error" : "bg-secondary"}`} style={{ width: `${Math.min(100, project.tokenBudgetPercent ?? 0)}%` }} /></div>
        </div>

        <div className="mt-4 grid grid-cols-3 divide-x divide-outline-variant rounded-lg bg-surface-container-low py-2.5 text-center">
          <Metric label="Value" value={score(project.valueScore)} />
          <Metric label="Risk" value={score(project.riskScore)} />
          <Metric label="Priority" value={project.priorityScore == null ? "—" : project.priorityScore.toFixed(2)} />
        </div>

        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-on-surface-variant">
          <span className="flex items-center gap-1.5"><Lightbulb size={13} />{project.claimCount ?? 0} claims</span>
          <span className="flex items-center gap-1.5"><Target size={13} />{project.workItemCount} work items</span>
          <span className="flex items-center gap-1.5"><Bot size={13} />{recommendationCount} suggestions</span>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-outline-variant bg-surface-container-low px-4 py-3">
        <button type="button" className="inline-flex h-8 flex-1 items-center gap-2 rounded-md px-2 text-xs font-semibold text-on-surface hover:bg-surface-container-high" onClick={() => setExpanded((value) => !value)}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}Capability brief</button>
        <button type="button" disabled={assessing} className="inline-grid h-8 w-8 place-items-center rounded-md text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface disabled:opacity-50" title="Refresh capability-agent assessment" onClick={assess}><RefreshCw size={14} className={assessing ? "animate-spin" : ""} /></button>
        <Link href={`/synthesis/ideas?project=${project.id}`} className="inline-grid h-8 w-8 place-items-center rounded-md text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface" title="Open initiative"><ArrowUpRight size={15} /></Link>
      </div>

      {expanded ? <CapabilityBrief project={project} /> : null}
    </SynCard>
  );
}

function CapabilityBrief({ project }: { project: SynProject }) {
  const assessments = project.impactAssessments ?? [];
  return (
    <div className="space-y-3 border-t border-outline-variant p-4">
      {assessments.length === 0 ? <p className="text-xs text-on-surface-variant">No capability brief exists yet. Assign one capability or refresh the assessment.</p> : assessments.map((item) => (
        <div key={item.id} className="rounded-lg border border-outline-variant p-3">
          <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-on-surface">{item.capabilityName ?? item.capabilityId}</span><SynChip tone={item.status === "COMPLETED" ? "success" : item.status === "FAILED" ? "error" : "tertiary"} mono>{item.status}</SynChip></div>
          {item.agentTemplateName ? <div className="mt-1 flex items-center gap-1 text-[11px] text-on-surface-variant"><Bot size={11} />{item.agentTemplateName}</div> : null}
          {item.summary ? <p className="mt-2 text-xs leading-5 text-on-surface-variant">{item.summary}</p> : null}
          {(item.recommendations?.length ?? 0) > 0 ? <ul className="mt-2 space-y-1 text-xs text-on-surface">{item.recommendations!.slice(0, 3).map((text) => <li key={text} className="flex gap-2"><span className="text-secondary">•</span><span>{text}</span></li>)}</ul> : null}
          {item.error ? <p className="mt-2 flex gap-2 text-xs text-error"><AlertTriangle size={13} className="shrink-0" />{item.error}</p> : null}
        </div>
      ))}
    </div>
  );
}

function AgingChip({ project }: { project: SynProject }) {
  const status = project.agingStatus ?? "CURRENT";
  const tone = status === "CURRENT" ? "success" : status === "OVERDUE" ? "error" : "tertiary";
  const Icon = status === "OVERDUE" ? ShieldAlert : status === "CURRENT" ? Activity : CalendarClock;
  return <SynChip tone={tone} icon={Icon}>{status.replaceAll("_", " ")} · {project.ageDays ?? 0}d</SynChip>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><div className="font-mono text-sm font-semibold tabular-nums text-on-surface">{value}</div><div className="mt-0.5 text-[10px] uppercase tracking-wide text-on-surface-variant">{label}</div></div>;
}

function Field({ children, label, hint, required, className = "" }: { children: ReactNode; label: string; hint?: string; required?: boolean; className?: string }) {
  return <label className={`block ${className}`}><span className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-xs font-semibold text-on-surface"><span>{label}{required ? <span className="ml-1 text-error">*</span> : null}</span>{hint ? <span className="ml-auto max-w-full text-right text-[10px] font-normal text-on-surface-variant">{hint}</span> : null}</span>{children}</label>;
}

function normalizeLookup(items: LookupItem[]): SelectOption[] {
  const seen = new Set<string>();
  return items.map((item) => ({
    id: String(item.id ?? item.iamCapabilityId ?? item.user_id ?? "").trim(),
    name: String(item.name ?? item.displayName ?? item.display_name ?? item.email ?? item.label ?? item.id ?? "").trim(),
  })).filter((item) => item.id && item.name && !seen.has(item.id) && seen.add(item.id)).sort((left, right) => left.name.localeCompare(right.name));
}

function toPayload(form: InitiativeForm) {
  const scoreKeys = ["businessValue", "customerImpact", "strategicAlignment", "urgency", "deliveryRisk", "technicalRisk", "regulatoryRisk", "confidence", "effort"] as const;
  const scores = Object.fromEntries(scoreKeys.flatMap((key) => form[key] ? [[key, Number(form[key])]] : []));
  return {
    name: form.name.trim(),
    mission: form.mission.trim() || undefined,
    primaryCapabilityId: form.primaryCapabilityId,
    tokenBudget: Number(form.tokenBudget),
    costBudgetUsd: form.costBudgetUsd ? Number(form.costBudgetUsd) : undefined,
    ...scores,
    targetDate: form.targetDate ? new Date(`${form.targetDate}T23:59:59.000Z`).toISOString() : undefined,
    reviewCadenceDays: Number(form.reviewCadenceDays),
    sponsorId: form.sponsorId || undefined,
    productOwnerId: form.productOwnerId || undefined,
    successMetrics: form.successMetrics.split("\n").map((value) => value.trim()).filter(Boolean),
    tags: form.tags.split(",").map((value) => value.trim()).filter(Boolean),
  };
}

function score(value?: number | null) { return value == null ? "—" : `${value.toFixed(1)}/5`; }
function compact(value?: number | null) { return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value ?? 0); }
function scoreLabel(value: number) { return ["", "Low", "Moderate", "Meaningful", "High", "Very high"][value]; }

const inputClass = "h-10 w-full rounded-lg border border-outline-variant bg-surface-container-low px-3 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-secondary focus:outline-none";
