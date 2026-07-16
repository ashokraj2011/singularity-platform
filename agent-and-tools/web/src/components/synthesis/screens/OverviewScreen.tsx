"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  LayoutDashboard,
  FolderKanban,
  Activity,
  CheckCircle2,
  Clock,
  ArrowUpRight,
  Boxes,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SynthesisShell } from "@/components/synthesis/SynthesisShell";
import {
  SynCard,
  SynChip,
  MonoMeta,
  EmptyState,
  SynSkeleton,
  SynError,
} from "@/components/synthesis/ui/kit";
import { usePortfolio } from "@/components/synthesis/hooks/useSynthesis";
import { timeAgo } from "@/components/synthesis/logic";
import type { SynProject } from "@/components/synthesis/types";

export default function OverviewScreen() {
  const { data, error, isLoading } = usePortfolio({ refreshInterval: 20000 });
  const projects = data?.projects ?? [];
  const standalone = data?.standaloneWorkItems ?? [];

  const metrics = useMemo(() => {
    const active = projects.filter((p) => p.status === "ACTIVE").length;
    const totalItems = projects.reduce((s, p) => s + (p.workItemCount ?? 0), 0);
    const empty = projects.filter((p) => (p.workItemCount ?? 0) === 0).length;
    return { active, totalItems, empty };
  }, [projects]);

  const recent = useMemo(
    () =>
      [...projects]
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )
        .slice(0, 8),
    [projects],
  );

  return (
    <SynthesisShell title="System Overview">
      <div className="mb-8">
        <MonoMeta className="block mb-1">Health &amp; activity</MonoMeta>
        <h1 className="font-display font-semibold text-2xl text-on-surface tracking-tight">
          System Overview
        </h1>
        <p className="mt-1.5 text-sm text-on-surface-variant max-w-2xl">
          A live pulse across every initiative — where discovery is active, what&apos;s converging,
          and what needs attention.
        </p>
      </div>

      {error ? (
        <SynError message={`Could not load overview: ${(error as Error).message}`} />
      ) : isLoading ? (
        <SynSkeleton rows={5} />
      ) : (
        <div className="flex flex-col gap-8">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Metric icon={FolderKanban} label="Initiatives" value={projects.length} />
            <Metric icon={Activity} label="Active" value={metrics.active} tone="secondary" />
            <Metric icon={Boxes} label="Work items" value={metrics.totalItems} />
            <Metric
              icon={Clock}
              label="Awaiting work"
              value={metrics.empty}
              tone={metrics.empty > 0 ? "warning" : "secondary"}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
            {/* Activity feed */}
            <div className="lg:col-span-2">
              <div className="flex items-center justify-between mb-4">
                <span className="font-display font-semibold text-base text-on-surface">
                  Recent activity
                </span>
                <MonoMeta>Updated initiatives</MonoMeta>
              </div>
              {recent.length === 0 ? (
                <EmptyState
                  icon={LayoutDashboard}
                  title="No activity yet"
                  description="Create an initiative on the Workspace Hub to start capturing ideas."
                />
              ) : (
                <div className="flex flex-col gap-2.5">
                  {recent.map((p) => (
                    <ActivityRow key={p.id} project={p} />
                  ))}
                </div>
              )}
            </div>

            {/* Standalone work */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <span className="font-display font-semibold text-base text-on-surface">
                  Standalone work
                </span>
                <MonoMeta>{standalone.length}</MonoMeta>
              </div>
              <SynCard className="p-5">
                {standalone.length === 0 ? (
                  <p className="text-sm text-on-surface-variant flex items-center gap-2">
                    <CheckCircle2 size={16} className="text-secondary" />
                    Everything is attached to an initiative.
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {standalone.slice(0, 8).map((w) => (
                      <li key={w.id} className="flex items-start gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-on-tertiary-container mt-1.5 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm text-on-surface truncate">
                            {w.title ?? w.name ?? w.code ?? w.id}
                          </p>
                          {w.status ? <MonoMeta>{w.status}</MonoMeta> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </SynCard>
            </div>
          </div>
        </div>
      )}
    </SynthesisShell>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  tone = "neutral",
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  tone?: "neutral" | "secondary" | "warning";
}) {
  const accent =
    tone === "secondary"
      ? "text-secondary"
      : tone === "warning"
        ? "text-on-tertiary-container"
        : "text-on-surface";
  return (
    <SynCard className="p-5">
      <div className="flex items-center gap-2 text-on-surface-variant mb-3">
        <Icon size={16} strokeWidth={1.8} />
        <MonoMeta>{label}</MonoMeta>
      </div>
      <div className={`font-display font-semibold text-3xl tabular-nums ${accent}`}>{value}</div>
    </SynCard>
  );
}

function ActivityRow({ project }: { project: SynProject }) {
  return (
    <Link href={`/synthesis/ideas?project=${project.id}`}>
      <SynCard interactive className="px-5 py-4 flex items-center gap-4">
        <div className="w-9 h-9 rounded-lg bg-secondary-container text-on-secondary-container flex items-center justify-center shrink-0">
          <FolderKanban size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm text-on-surface truncate">{project.name}</span>
            <MonoMeta>{project.code}</MonoMeta>
          </div>
          <MonoMeta>
            {project.workItemCount} work item{project.workItemCount === 1 ? "" : "s"} · updated{" "}
            {timeAgo(project.updatedAt)}
          </MonoMeta>
        </div>
        <SynChip tone={project.status === "ACTIVE" ? "secondary" : "neutral"} mono>
          {project.status}
        </SynChip>
        <ArrowUpRight size={16} className="text-on-surface-variant" />
      </SynCard>
    </Link>
  );
}
