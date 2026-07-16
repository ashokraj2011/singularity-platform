"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Boxes, Search, Layers, ArrowUpRight } from "lucide-react";
import { SynthesisShell } from "@/components/synthesis/SynthesisShell";
import {
  SynCard,
  SynChip,
  MonoMeta,
  EmptyState,
  SynSkeleton,
  SynError,
  ConfidenceBar,
} from "@/components/synthesis/ui/kit";
import { usePortfolio } from "@/components/synthesis/hooks/useSynthesis";
import type { ChipTone } from "@/components/synthesis/ui/kit";
import type { SynProject } from "@/components/synthesis/types";

type Maturity = "SEED" | "SHAPING" | "DELIVERING" | "MATURE";

const MATURITY_ORDER: Maturity[] = ["MATURE", "DELIVERING", "SHAPING", "SEED"];
const MATURITY_TONE: Record<Maturity, ChipTone> = {
  SEED: "neutral",
  SHAPING: "tertiary",
  DELIVERING: "secondary",
  MATURE: "success",
};

/**
 * Maturity heuristic from portfolio signals we already have: an initiative with
 * many work items and an active status is further along than an empty draft.
 * Score in [0,1] drives the label; both are shown for transparency.
 */
function maturity(p: SynProject): { score: number; label: Maturity } {
  const items = p.workItemCount ?? 0;
  const activity = p.status === "ACTIVE" ? 0.35 : p.status === "ARCHIVED" ? 0.1 : 0.2;
  const delivery = Math.min(0.65, items * 0.13);
  const score = Math.min(1, activity + delivery);
  const label: Maturity =
    score >= 0.8 ? "MATURE" : score >= 0.55 ? "DELIVERING" : score >= 0.3 ? "SHAPING" : "SEED";
  return { score, label };
}

export default function UseCaseRegistryScreen() {
  const { data, error, isLoading } = usePortfolio({ refreshInterval: 20000 });
  const [query, setQuery] = useState("");
  const projects = data?.projects ?? [];

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects
      .filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          p.code.toLowerCase().includes(q) ||
          (p.mission ?? "").toLowerCase().includes(q),
      )
      .map((p) => ({ project: p, ...maturity(p) }))
      .sort(
        (a, b) =>
          MATURITY_ORDER.indexOf(a.label) - MATURITY_ORDER.indexOf(b.label) ||
          b.score - a.score,
      );
  }, [projects, query]);

  const dist = useMemo(() => {
    const d: Record<Maturity, number> = { SEED: 0, SHAPING: 0, DELIVERING: 0, MATURE: 0 };
    for (const p of projects) d[maturity(p).label] += 1;
    return d;
  }, [projects]);

  return (
    <SynthesisShell
      title="Use-Case Registry"
      headerActions={
        <div className="relative">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search use cases"
            className="h-9 w-56 pl-9 pr-3 rounded-lg bg-surface-container-low border border-outline-variant text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:border-secondary"
          />
        </div>
      }
    >
      <div className="mb-8">
        <MonoMeta className="block mb-1">Maturity &amp; dependencies</MonoMeta>
        <h1 className="font-display font-semibold text-2xl text-on-surface tracking-tight">
          Business Use-Case Registry
        </h1>
        <p className="mt-1.5 text-sm text-on-surface-variant max-w-2xl">
          Every initiative as a business use case, ranked by how far it has matured from a seed idea
          to delivered work.
        </p>
      </div>

      {error ? (
        <SynError message={`Could not load the registry: ${(error as Error).message}`} />
      ) : isLoading ? (
        <SynSkeleton rows={5} />
      ) : projects.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No use cases yet"
          description="Create an initiative on the Workspace Hub to register your first business use case."
        />
      ) : (
        <div className="flex flex-col gap-8">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {MATURITY_ORDER.map((m) => (
              <SynCard key={m} className="p-5">
                <MonoMeta className="block mb-3">{m}</MonoMeta>
                <div className="font-display font-semibold text-3xl text-on-surface tabular-nums">
                  {dist[m]}
                </div>
              </SynCard>
            ))}
          </div>

          <div className="flex flex-col gap-3">
            {rows.map(({ project, score, label }) => (
              <Link key={project.id} href={`/synthesis/spec?project=${project.id}`}>
                <SynCard interactive className="p-5 flex items-center gap-5">
                  <div className="w-10 h-10 rounded-xl bg-secondary-container text-on-secondary-container flex items-center justify-center shrink-0">
                    <Layers size={18} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-on-surface truncate">
                        {project.name}
                      </span>
                      <MonoMeta>{project.code}</MonoMeta>
                    </div>
                    {project.mission ? (
                      <p className="text-xs text-on-surface-variant truncate mt-0.5">
                        {project.mission}
                      </p>
                    ) : null}
                  </div>
                  <div className="w-40 shrink-0 hidden md:block">
                    <ConfidenceBar value={score} label={`${Math.round(score * 100)}%`} />
                  </div>
                  <SynChip tone={MATURITY_TONE[label]} mono>
                    {label}
                  </SynChip>
                  <span className="text-xs text-on-surface-variant hidden lg:inline">
                    {project.workItemCount} item{project.workItemCount === 1 ? "" : "s"}
                  </span>
                  <ArrowUpRight size={16} className="text-on-surface-variant shrink-0" />
                </SynCard>
              </Link>
            ))}
          </div>
        </div>
      )}
    </SynthesisShell>
  );
}
