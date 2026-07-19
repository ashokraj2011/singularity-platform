"use client";

import useSWR, { type SWRConfiguration } from "swr";
import { workgraphFetch } from "@/lib/workgraph";
import { apiPath, authHeaders } from "@/lib/api";
import type {
  CanvasObject,
  CanvasViewport,
  Positions,
  SaveLayoutPayload,
} from "../board/canvasLayout";
import type {
  DiscoverySession,
  ProjectSpecView,
  SynClaim,
  SynConvergence,
  SynDecisionDossier,
  SynGenerationPlan,
  SynBudgetDecision,
  SynBusinessRollup,
  SynDesk,
  SynPilotReadiness,
  SynPortfolio,
  SynProjectLearning,
  SynProbe,
  SynProject,
  SynProjectEconomics,
  SynRoom,
  SynTraceability,
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

/**
 * Fetch probes for many claims at once (there is no project-level probes
 * endpoint). Keyed by the sorted claim ids so the request is stable and
 * revalidates only when the claim set actually changes. Per-claim failures are
 * tolerated so one missing claim never blanks the whole board.
 */
export function useProjectProbes(
  claimIds: string[],
  config?: SWRConfiguration<SynProbe[]>,
) {
  const sorted = [...claimIds].sort();
  const key = sorted.length ? (["syn-probes", ...sorted] as const) : null;
  return useSWR<SynProbe[]>(
    key,
    async () => {
      const results = await Promise.allSettled(
        sorted.map((id) => workgraphFetch<{ items: SynProbe[] }>(`/studio/claims/${id}/probes`)),
      );
      return results.flatMap((r) => (r.status === "fulfilled" ? r.value.items ?? [] : []));
    },
    { revalidateOnFocus: false, ...config },
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

/* ─── Strategy Canvas: per-user persistent layout ───────────────────────── */

/** Server-stored personal layout for a project's Strategy Canvas (see board/canvasLayout.ts). */
export interface CanvasLayoutDto {
  positions: Positions;
  objects: CanvasObject[];
  viewport: CanvasViewport | null;
  updatedAt: string | null;
}

/**
 * Load the signed-in user's personal Strategy Canvas layout for a project. Positions + free-form
 * objects are personal (one row per user), so this follows the user across devices without moving
 * anyone else's board. Revalidation on focus is off — the local editing state is authoritative while
 * the board is open and we push saves explicitly.
 */
export function useCanvasLayout(
  projectId: string | null,
  config?: SWRConfiguration<CanvasLayoutDto>,
) {
  return useSyn<CanvasLayoutDto>(
    projectId ? `/studio/projects/${projectId}/canvas-layout` : null,
    { revalidateOnFocus: false, revalidateIfStale: false, ...config },
  );
}

/** Persist the full personal layout (positions + objects + viewport) for a project. */
export async function saveCanvasLayout(
  projectId: string,
  payload: SaveLayoutPayload,
): Promise<CanvasLayoutDto> {
  return workgraphFetch<CanvasLayoutDto>(`/studio/projects/${projectId}/canvas-layout`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export interface UploadedCanvasImage {
  storageKey: string;
  bucket: string;
  mimeType: string;
  url: string;
}

/**
 * Upload an image for the canvas. Multipart, so it bypasses {@link workgraphFetch} (which forces a
 * JSON content type) and posts a FormData body directly to the workgraph proxy with auth headers.
 */
export async function uploadCanvasImage(
  projectId: string,
  file: File,
): Promise<UploadedCanvasImage> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch(
    apiPath(`/api/workgraph/studio/projects/${projectId}/canvas-layout/images`),
    { method: "POST", headers: authHeaders(), body },
  );
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      data && typeof data === "object" && typeof (data as Record<string, unknown>).message === "string"
        ? String((data as Record<string, unknown>).message)
        : `Image upload failed (${res.status})`;
    throw new Error(message);
  }
  return data as UploadedCanvasImage;
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

export function useDecisions(
  projectId: string | null,
  config?: SWRConfiguration<{ items: SynDecisionDossier[] }>,
) {
  return useSyn<{ items: SynDecisionDossier[] }>(
    projectId ? `/studio/projects/${projectId}/decisions` : null,
    config,
  );
}

export function useGenerationPlans(
  projectId: string | null,
  config?: SWRConfiguration<{ items: SynGenerationPlan[] }>,
) {
  return useSyn<{ items: SynGenerationPlan[] }>(
    projectId ? `/generation-plans?specificationProjectId=${encodeURIComponent(projectId)}` : null,
    config,
  );
}

export function useProjectEconomics(
  projectId: string | null,
  config?: SWRConfiguration<SynProjectEconomics>,
) {
  return useSyn<SynProjectEconomics>(
    projectId ? `/studio/projects/${projectId}/economics` : null,
    config,
  );
}

export function useProjectTraceability(projectId: string | null, config?: SWRConfiguration<SynTraceability>) {
  return useSyn<SynTraceability>(projectId ? `/studio/projects/${projectId}/traceability` : null, config);
}

export function useProjectLearning(projectId: string | null, config?: SWRConfiguration<SynProjectLearning>) {
  return useSyn<SynProjectLearning>(projectId ? `/studio/projects/${projectId}/learning` : null, config);
}

export function usePilotReadiness(projectId: string | null, config?: SWRConfiguration<SynPilotReadiness>) {
  return useSyn<SynPilotReadiness>(projectId ? `/studio/projects/${projectId}/pilot-readiness` : null, config);
}

export function useBudgetDecision(projectId: string | null, stage?: string, config?: SWRConfiguration<SynBudgetDecision>) {
  const suffix = stage ? `?stage=${encodeURIComponent(stage)}` : "";
  return useSyn<SynBudgetDecision>(projectId ? `/studio/projects/${projectId}/budget-decision${suffix}` : null, config);
}

export function useBusinessAlignment(projectId: string | null, config?: SWRConfiguration<SynBusinessRollup>) {
  return useSyn<SynBusinessRollup>(projectId ? `/studio/business-alignment/projects/${projectId}/rollup` : null, config);
}

export function useDesk(projectId: string | null, reviewBudget = 12, config?: SWRConfiguration<SynDesk>) {
  return useSyn<SynDesk>(projectId ? `/studio/experience/desk?projectId=${encodeURIComponent(projectId)}&reviewBudget=${reviewBudget}` : null, config);
}
