"use client";

import { useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FileText,
  Target,
  Ban,
  ArrowRight,
  Lightbulb,
  ListChecks,
  Ticket,
  ExternalLink,
  GitBranch,
  Scale,
  ShieldCheck,
} from "lucide-react";
import { SynthesisShell } from "@/components/synthesis/SynthesisShell";
import {
  ProjectPicker,
  NoProjectSelected,
  useSelectedProjectId,
} from "@/components/synthesis/ProjectPicker";
import {
  SynCard,
  SynChip,
  MonoMeta,
  SynButton,
  EmptyState,
  SynSkeleton,
  SynError,
} from "@/components/synthesis/ui/kit";
import {
  useProjectSpec,
  useClaims,
  useProjectWorkItems,
  useProjectTraceability,
} from "@/components/synthesis/hooks/useSynthesis";
import type { ChipTone } from "@/components/synthesis/ui/kit";
import type { RequirementPriority, SpecRequirement } from "@/components/synthesis/types";

const PRIORITY_TONE: Record<string, ChipTone> = {
  MUST: "error",
  SHOULD: "secondary",
  MAY: "neutral",
};

export function SpecTraceabilityScreen() {
  const pathname = usePathname() ?? "/synthesis/spec";
  const projectId = useSelectedProjectId();
  return (
    <SynthesisShell
      title="Spec & Traceability"
      headerActions={<ProjectPicker pathname={pathname} />}
    >
      {projectId ? (
        <SpecTraceability projectId={projectId} />
      ) : (
        <NoProjectSelected surface="Spec & Traceability" />
      )}
    </SynthesisShell>
  );
}

function SpecTraceability({ projectId }: { projectId: string }) {
  const specQ = useProjectSpec(projectId);
  const claimsQ = useClaims(projectId);
  const itemsQ = useProjectWorkItems(projectId);
  const traceQ = useProjectTraceability(projectId);

  const pkg = specQ.data?.package;
  const claims = claimsQ.data?.items ?? [];
  const workItems = itemsQ.data?.items ?? [];
  const requirements = pkg?.requirements ?? [];

  const byPriority = useMemo(() => {
    const order: RequirementPriority[] = ["MUST", "SHOULD", "MAY"];
    return [...requirements].sort(
      (a, b) => order.indexOf(a.priority) - order.indexOf(b.priority),
    );
  }, [requirements]);

  return (
    <div>
      <div className="flex items-start justify-between gap-6 mb-8">
        <div>
          <MonoMeta className="block mb-1">Converge · Trace · Generate</MonoMeta>
          <h1 className="font-display font-semibold text-2xl text-on-surface tracking-tight">
            Spec &amp; Traceability
          </h1>
          <p className="mt-1.5 text-sm text-on-surface-variant max-w-2xl">
            The converged specification and its lineage — from raw claims through requirements to the
            work items that deliver them.
          </p>
        </div>
        <Link href={`/synthesis/generate?projectId=${encodeURIComponent(projectId)}`}>
          <SynButton icon={Ticket}>Generate tickets</SynButton>
        </Link>
      </div>

      {specQ.error ? (
        <SynError message={`Could not load specification: ${(specQ.error as Error).message}`} />
      ) : specQ.isLoading ? (
        <SynSkeleton rows={4} />
      ) : (
        <div className="flex flex-col gap-8">
          {/* Traceability pipeline */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
            <PipelineStage
              icon={Lightbulb}
              label="Claims"
              count={claims.length}
              caption="Captured ideas & assumptions"
            />
            <PipelineStage
              icon={ListChecks}
              label="Requirements"
              count={requirements.length}
              caption="Converged in the spec"
              connector
            />
            <PipelineStage
              icon={Ticket}
              label="Work items"
              count={workItems.length}
              caption="Delivering the spec"
              connector
            />
          </div>

          {traceQ.data ? <LineageExplorer data={traceQ.data} /> : traceQ.error ? <SynError message="Could not load the complete lineage graph." /> : <SynSkeleton rows={2} />}

          {/* Analysis */}
          {pkg?.analysis ? <AnalysisCard analysis={pkg.analysis} /> : null}

          {/* Requirements spine */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <span className="font-display font-semibold text-base text-on-surface">
                Requirements
              </span>
              <MonoMeta>{requirements.length} total</MonoMeta>
            </div>
            {requirements.length === 0 ? (
              <EmptyState
                icon={FileText}
                title="No requirements yet"
                description="Converge claims into requirements in the studio, then trace them here."
              />
            ) : (
              <div className="flex flex-col gap-3">
                {byPriority.map((r) => (
                  <RequirementRow key={r.id} req={r} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function LineageExplorer({ data }: { data: import("@/components/synthesis/types").SynTraceability }) {
  const stages = [
    { key: "business", label: "Business intent", types: ["business-objective"], icon: Target },
    { key: "idea", label: "Idea evidence", types: ["board-object", "option-source", "rejected-option"], icon: Lightbulb },
    { key: "claim", label: "Claims", types: ["claim"], icon: GitBranch },
    { key: "decision", label: "Decisions", types: ["decision-option", "decision"], icon: Scale },
    { key: "contract", label: "Contract", types: ["requirement", "specification", "generation-plan", "plan-row"], icon: FileText },
    { key: "proof", label: "Delivery proof", types: ["work-item", "submission", "reconciliation", "finalization"], icon: ShieldCheck },
  ];
  return <section>
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-display font-semibold text-base text-on-surface">One-click evidence lineage</h2><p className="text-xs text-on-surface-variant">Rejected alternatives remain visible; every item opens its owning surface.</p></div><SynChip tone={data.summary.completeChains === data.summary.workItems && data.summary.workItems > 0 ? "success" : "tertiary"}>{data.summary.completeChains}/{data.summary.workItems} complete chains</SynChip></div>
    <div className="overflow-x-auto rounded-md border border-outline-variant bg-surface"><div className="grid min-w-[1320px] grid-cols-6 divide-x divide-outline-variant">{stages.map(stage => { const Icon = stage.icon; const nodes = data.nodes.filter(node => stage.types.includes(node.type)); return <div key={stage.key} className="min-w-0"><div className="flex h-11 items-center gap-2 border-b border-outline-variant bg-surface-container px-3"><Icon size={15} className="text-secondary" /><strong className="text-xs text-on-surface">{stage.label}</strong><span className="ml-auto text-[10px] tabular-nums text-on-surface-variant">{nodes.length}</span></div><div className="max-h-[340px] space-y-2 overflow-y-auto p-2">{nodes.length ? nodes.map(node => { const content = <><span className="block truncate text-xs font-semibold text-on-surface">{node.label}</span><span className="mt-0.5 block truncate text-[10px] uppercase text-on-surface-variant">{node.type}{node.status ? ` · ${node.status}` : ""}</span></>; return node.href ? <Link key={node.id} href={node.href} title={node.detail ?? node.label} className="block rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-2 hover:border-secondary">{content}</Link> : <div key={node.id} className="rounded-md border border-outline-variant px-3 py-2">{content}</div>; }) : <div className="px-2 py-6 text-center text-xs text-on-surface-variant">No evidence yet</div>}</div></div>; })}</div></div>
  </section>;
}

function PipelineStage({
  icon: Icon,
  label,
  count,
  caption,
  connector,
}: {
  icon: typeof FileText;
  label: string;
  count: number;
  caption: string;
  connector?: boolean;
}) {
  return (
    <div className="relative">
      {connector ? (
        <ArrowRight
          size={20}
          className="hidden md:block absolute -left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant z-10"
        />
      ) : null}
      <SynCard className="p-6 h-full flex flex-col gap-3">
        <div className="flex items-center gap-2 text-on-surface-variant">
          <Icon size={16} strokeWidth={1.8} />
          <MonoMeta>{label}</MonoMeta>
        </div>
        <div className="font-display font-semibold text-3xl text-on-surface tabular-nums">
          {count}
        </div>
        <div className="text-xs text-on-surface-variant">{caption}</div>
      </SynCard>
    </div>
  );
}

function AnalysisCard({
  analysis,
}: {
  analysis: {
    problem: string;
    goals: { text: string; metric?: string }[];
    constraints: string[];
  };
}) {
  const hasContent =
    analysis.problem || analysis.goals.length > 0 || analysis.constraints.length > 0;
  if (!hasContent) return null;
  return (
    <SynCard className="p-6">
      <MonoMeta className="block mb-3">Problem framing</MonoMeta>
      {analysis.problem ? (
        <p className="text-sm text-on-surface leading-relaxed max-w-3xl">{analysis.problem}</p>
      ) : (
        <p className="text-sm text-on-surface-variant/70 italic">No problem statement yet.</p>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-5">
        {analysis.goals.length > 0 ? (
          <div>
            <div className="flex items-center gap-1.5 mb-2 text-on-surface-variant">
              <Target size={14} strokeWidth={1.8} />
              <MonoMeta>Goals</MonoMeta>
            </div>
            <ul className="space-y-1.5">
              {analysis.goals.map((g, i) => (
                <li key={i} className="text-sm text-on-surface flex gap-2">
                  <span className="text-secondary">·</span>
                  <span>
                    {g.text}
                    {g.metric ? (
                      <span className="text-on-surface-variant"> — {g.metric}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {analysis.constraints.length > 0 ? (
          <div>
            <div className="flex items-center gap-1.5 mb-2 text-on-surface-variant">
              <Ban size={14} strokeWidth={1.8} />
              <MonoMeta>Constraints</MonoMeta>
            </div>
            <ul className="space-y-1.5">
              {analysis.constraints.map((c, i) => (
                <li key={i} className="text-sm text-on-surface flex gap-2">
                  <span className="text-on-surface-variant">·</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </SynCard>
  );
}

function RequirementRow({ req }: { req: SpecRequirement }) {
  return (
    <SynCard className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <MonoMeta>{req.id}</MonoMeta>
            <SynChip tone={PRIORITY_TONE[req.priority] ?? "neutral"} mono>
              {req.priority}
            </SynChip>
          </div>
          <p className="text-sm text-on-surface leading-snug">{req.statement}</p>
          {req.acceptanceCriteria.length > 0 ? (
            <ul className="mt-3 space-y-1">
              {req.acceptanceCriteria.map((a, i) => (
                <li key={i} className="text-xs text-on-surface-variant flex gap-2">
                  <ListChecks size={13} className="mt-0.5 shrink-0 text-secondary" />
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </SynCard>
  );
}

/** Exported so the traceability hub can be embedded elsewhere later. */
export const SpecStudioLink = ({ projectId }: { projectId: string }) => (
  <Link
    href={`/studio/${projectId}`}
    className="inline-flex items-center gap-1.5 text-sm text-secondary hover:underline"
  >
    Open in studio <ExternalLink size={14} />
  </Link>
);
