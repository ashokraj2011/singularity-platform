"use client";

import useSWR, { type SWRConfiguration } from "swr";
import { workgraphFetch } from "@/lib/workgraph";
import type {
  DiscoverySession,
  ProjectSpecView,
  SynClaim,
  SynConvergence,
  SynPortfolio,
  SynProbe,
  SynProject,
  SynRoom,
  SynWorkItemCard,
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

/* ─── Project-scoped rooms & claims (the epistemic backbone) ─────────────── */

export function useRooms(
  projectId: string | null,
  config?: SWRConfiguration<{ items: SynRoom[] }>,
) {
  return useSyn<{ items: SynRoom[] }>(
    projectId ? `/studio/projects/${projectId}/rooms` : null,
    config,
  );
}

export function useClaims(
  projectId: string | null,
  opts: { roomId?: string; contested?: boolean } = {},
  config?: SWRConfiguration<{ items: SynClaim[] }>,
) {
  const qs = new URLSearchParams();
  if (opts.roomId) qs.set("roomId", opts.roomId);
  if (opts.contested) qs.set("contested", "true");
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return useSyn<{ items: SynClaim[] }>(
    projectId ? `/studio/projects/${projectId}/claims${suffix}` : null,
    config,
  );
}

export function useConvergence(
  roomId: string | null,
  config?: SWRConfiguration<SynConvergence>,
) {
  return useSyn<SynConvergence>(
    roomId ? `/studio/rooms/${roomId}/convergence` : null,
    { refreshInterval: 15000, ...config },
  );
}

export function useProbes(
  claimId: string | null,
  config?: SWRConfiguration<{ items: SynProbe[] }>,
) {
  return useSyn<{ items: SynProbe[] }>(
    claimId ? `/studio/claims/${claimId}/probes` : null,
    config,
  );
}

export async function createRoom(projectId: string, title: string): Promise<SynRoom> {
  return workgraphFetch<SynRoom>(`/studio/projects/${projectId}/rooms`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export async function createClaim(
  projectId: string,
  input: {
    roomId?: string;
    statement: string;
    riskiestAssumption?: string;
    claimType?: string;
    initialEstimate?: number;
  },
): Promise<SynClaim> {
  return workgraphFetch<SynClaim>(`/studio/projects/${projectId}/claims`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function proposeClaims(roomId: string, prompt: string) {
  return workgraphFetch(`/studio/rooms/${roomId}/copilot/propose`, {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
}

/* ─── Specification + work items (the spec/traceability spine) ───────────── */

export function useProjectSpec(
  projectId: string | null,
  config?: SWRConfiguration<ProjectSpecView>,
) {
  return useSyn<ProjectSpecView>(
    projectId ? `/studio/projects/${projectId}/specification` : null,
    config,
  );
}

export function useProjectWorkItems(
  projectId: string | null,
  config?: SWRConfiguration<{ items: SynWorkItemCard[] }>,
) {
  return useSyn<{ items: SynWorkItemCard[] }>(
    projectId ? `/studio/projects/${projectId}/work-items` : null,
    config,
  );
}
