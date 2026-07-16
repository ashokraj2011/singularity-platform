"use client";

import useSWR, { type SWRConfiguration } from "swr";
import { workgraphFetch } from "@/lib/workgraph";
import type {
  DiscoverySession,
  SynPortfolio,
  SynProject,
} from "../types";

/** Shared SWR fetcher hitting the workgraph API proxy. */
export const synFetcher = <T,>(path: string) => workgraphFetch<T>(path);

/** A screen-agnostic SWR wrapper that always uses {@link synFetcher}. */
export function useSyn<T>(path: string | null, config?: SWRConfiguration<T>) {
  return useSWR<T>(path, synFetcher, {
    revalidateOnFocus: false,
    ...config,
  });
}

export function usePortfolio(config?: SWRConfiguration<SynPortfolio>) {
  return useSyn<SynPortfolio>("/studio/portfolio", config);
}

export function useProjects(config?: SWRConfiguration<{ items: SynProject[] }>) {
  return useSyn<{ items: SynProject[] }>("/studio/projects", config);
}

export function useProject(
  projectId: string | null,
  config?: SWRConfiguration<SynProject>,
) {
  return useSyn<SynProject>(projectId ? `/studio/projects/${projectId}` : null, config);
}

/**
 * Resolve (get-or-create) a discovery session for a scope, then read it.
 * The Synthesis Idea Wall / Discovery board bind to a project-scoped session.
 */
export function useDiscoverySession(
  sessionId: string | null,
  config?: SWRConfiguration<DiscoverySession>,
) {
  return useSyn<DiscoverySession>(
    sessionId ? `/discovery/sessions/${sessionId}` : null,
    config,
  );
}

/** POST /discovery/sessions/resolve — idempotent get-or-create by scope. */
export async function resolveDiscoverySession(input: {
  scopeType: string;
  scopeId?: string | null;
}): Promise<DiscoverySession> {
  return workgraphFetch<DiscoverySession>("/discovery/sessions/resolve", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
