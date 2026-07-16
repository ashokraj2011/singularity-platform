"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Plus, FolderKanban, Search, Users, ArrowUpRight } from "lucide-react";
import { SynthesisShell } from "@/components/synthesis/SynthesisShell";
import {
  SynCard,
  SynChip,
  MonoMeta,
  SynButton,
  EmptyState,
  SynSkeleton,
  SynError,
} from "@/components/synthesis/ui/kit";
import { usePortfolio } from "@/components/synthesis/hooks/useSynthesis";
import { workgraphFetch } from "@/lib/workgraph";
import type { SynProject } from "@/components/synthesis/types";

/**
 * Workspace Hub — the Synthesis landing surface. Shows every active initiative
 * (specification project) as a card, plus standalone work items, backed by
 * GET /studio/portfolio. Mirrors the enterprise_workspace_hub mockup.
 */
export default function WorkspaceHubPage() {
  const { data, error, isLoading, mutate } = usePortfolio({ refreshInterval: 20000 });
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");

  const projects = data?.projects ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q) ||
        (p.mission ?? "").toLowerCase().includes(q),
    );
  }, [projects, query]);

  async function createProject() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await workgraphFetch<SynProject>("/studio/projects", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      setName("");
      setCreating(false);
      await mutate();
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
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search initiatives"
              className="h-9 w-56 pl-9 pr-3 rounded-lg bg-surface-container-low border border-outline-variant text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:border-secondary"
            />
          </div>
          <SynButton icon={Plus} onClick={() => setCreating((v) => !v)}>
            New initiative
          </SynButton>
        </>
      }
    >
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <MonoMeta className="block mb-1">Portfolio</MonoMeta>
          <h1 className="font-display font-semibold text-2xl text-on-surface tracking-tight">
            Active initiatives
          </h1>
        </div>
        {data ? (
          <MonoMeta>
            {projects.length} project{projects.length === 1 ? "" : "s"} ·{" "}
            {data.standaloneWorkItems.length} standalone
          </MonoMeta>
        ) : null}
      </div>

      {creating ? (
        <SynCard className="p-5 mb-8">
          <div className="flex items-end gap-3">
            <label className="flex-1">
              <MonoMeta className="block mb-2">Initiative name</MonoMeta>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createProject()}
                placeholder="e.g. Unified billing experience"
                className="h-10 w-full px-3 rounded-lg bg-surface-container-low border border-outline-variant text-sm text-on-surface focus:outline-none focus:border-secondary"
              />
            </label>
            <SynButton onClick={createProject} disabled={!name.trim() || busy}>
              {busy ? "Creating…" : "Create"}
            </SynButton>
            <SynButton variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </SynButton>
          </div>
        </SynCard>
      ) : null}

      {error ? (
        <SynError message={`Could not load the portfolio: ${(error as Error).message}`} />
      ) : isLoading ? (
        <SynSkeleton rows={4} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title={query ? "No matching initiatives" : "No initiatives yet"}
          description={
            query
              ? "Try a different search term."
              : "Start a new initiative to capture ideas, reduce unknowns, and converge a spec."
          }
          action={
            !query ? (
              <SynButton icon={Plus} onClick={() => setCreating(true)}>
                New initiative
              </SynButton>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 items-start">
          {filtered.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}
    </SynthesisShell>
  );
}

function ProjectCard({ project }: { project: SynProject }) {
  return (
    <Link href={`/synthesis/ideas?project=${project.id}`} className="block">
      <SynCard interactive className="p-6 flex flex-col gap-5 h-full">
        <div className="flex items-start justify-between gap-3">
          <MonoMeta>{project.code}</MonoMeta>
          <SynChip tone={project.status === "ACTIVE" ? "secondary" : "neutral"} mono>
            {project.status}
          </SynChip>
        </div>
        <div>
          <h3 className="font-display font-semibold text-lg text-on-surface leading-snug line-clamp-2">
            {project.name}
          </h3>
          {project.mission ? (
            <p className="mt-2 text-sm text-on-surface-variant line-clamp-2">{project.mission}</p>
          ) : (
            <p className="mt-2 text-sm text-on-surface-variant/70 italic">No mission set</p>
          )}
        </div>
        <div className="flex items-center justify-between mt-auto pt-4 border-t border-outline-variant/60">
          <span className="flex items-center gap-1.5 text-xs text-on-surface-variant">
            <Users size={13} strokeWidth={1.8} />
            {project.workItemCount} work item{project.workItemCount === 1 ? "" : "s"}
          </span>
          <ArrowUpRight
            size={16}
            className="text-on-surface-variant group-hover:text-secondary"
          />
        </div>
      </SynCard>
    </Link>
  );
}
