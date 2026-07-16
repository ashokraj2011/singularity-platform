"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, FolderKanban } from "lucide-react";
import { useProjects } from "./hooks/useSynthesis";
import { EmptyState, SynButton } from "./ui/kit";
import type { SynProject } from "./types";

/** Reads the currently-selected project id from the `?project=` query param. */
export function useSelectedProjectId(): string | null {
  const params = useSearchParams();
  return params?.get("project") ?? null;
}

/**
 * A compact project selector for the shell header. Keeps the selection in the
 * URL (`?project=<id>`) so screens are deep-linkable and shareable.
 */
export function ProjectPicker({ pathname }: { pathname: string }) {
  const router = useRouter();
  const selected = useSelectedProjectId();
  const { data } = useProjects();
  const projects = data?.items ?? [];

  function select(id: string) {
    const qs = id ? `?project=${id}` : "";
    router.replace(`${pathname}${qs}`);
  }

  if (projects.length === 0) return null;

  return (
    <div className="relative">
      <FolderKanban
        size={15}
        className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none"
      />
      <ChevronDown
        size={15}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none"
      />
      <select
        value={selected ?? ""}
        onChange={(e) => select(e.target.value)}
        className="h-9 min-w-[220px] pl-9 pr-9 rounded-lg bg-surface-container-low border border-outline-variant text-sm text-on-surface appearance-none focus:outline-none focus:border-secondary cursor-pointer"
      >
        <option value="" disabled>
          Select an initiative…
        </option>
        {projects.map((p: SynProject) => (
          <option key={p.id} value={p.id}>
            {p.code} · {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Rendered by project-scoped screens when no `?project=` is set. */
export function NoProjectSelected({ surface }: { surface: string }) {
  const router = useRouter();
  return (
    <EmptyState
      icon={FolderKanban}
      title="Choose an initiative"
      description={`${surface} works within a single initiative. Pick one from the selector above, or open the Workspace Hub.`}
      action={
        <SynButton onClick={() => router.push("/synthesis/hub")}>Go to Workspace Hub</SynButton>
      }
    />
  );
}
