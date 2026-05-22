/**
 * M61 Slice B — Async bootstrap phase helpers.
 *
 * The bootstrap flow splits across phases:
 *
 *   Phase 0 — sync, returns to the operator in <500ms.
 *     Creates Capability + IAM sync + governance defaults +
 *     CapabilityBootstrapRun row (status=RUNNING, currentPhase=
 *     phase1_discovery). The HTTP handler returns immediately.
 *
 *   Phase 1 — async, discovery + agent generation + learning candidates +
 *     world-model seed. This is the existing heavy block; the only
 *     refactor is that it runs after the HTTP response is sent.
 *
 *   Phase 2 — async, AST index build. Stub for now; the worker hook
 *     is wired but the implementation defers to mcp-server's lazy
 *     index build at first workflow run.
 *
 *   Phase 3 — async, README distillation + architecture-slice build.
 *     Stub for now; produces the WorldModel.readmeSummary +
 *     architectureSlice once the worker lands.
 *
 * The async path is opt-in via BOOTSTRAP_ASYNC=true. Default false
 * preserves the existing synchronous behavior so this slice can land
 * without changing wire semantics for any caller that hasn't enabled
 * the flag.
 *
 * Each phase reads/writes CapabilityBootstrapRun.phaseProgress so the
 * wizard UI can poll bootstrap-runs/:runId and render progress
 * without holding the HTTP request open.
 */
import type { Prisma } from "../../../generated/prisma-client";
import { prisma } from "../../config/prisma";

export type PhaseStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type PhaseProgressEntry = {
  status: PhaseStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  stats?: Record<string, unknown>;
};

export type PhaseProgressMap = Record<string, PhaseProgressEntry>;

export const PHASE_KEYS = {
  P0: "phase0_setup",
  P1: "phase1_discovery",
  P2: "phase2_ast_index",
  P3: "phase3_distillation",
  DONE: "done",
} as const;

/**
 * True when the operator has opted into the async bootstrap path.
 * Read fresh each call so test harnesses can toggle without restart.
 */
export function isAsyncBootstrapEnabled(): boolean {
  return String(process.env.BOOTSTRAP_ASYNC ?? "").toLowerCase() === "true";
}

/**
 * Read the current phaseProgress map for a run. Returns {} if the
 * row doesn't exist (caller should already have verified existence).
 */
export async function readPhaseProgress(runId: string): Promise<PhaseProgressMap> {
  const row = await prisma.capabilityBootstrapRun.findUnique({
    where: { id: runId },
    select: { phaseProgress: true },
  });
  if (!row || !row.phaseProgress || typeof row.phaseProgress !== "object" || Array.isArray(row.phaseProgress)) {
    return {};
  }
  return row.phaseProgress as PhaseProgressMap;
}

/**
 * Patch one phase's entry. Merges into the existing JSONB map; never
 * blows away other phases' progress. Optionally bumps currentPhase
 * to a new value (e.g. on phase transition).
 */
export async function patchPhase(
  runId: string,
  phaseKey: string,
  patch: Partial<PhaseProgressEntry>,
  opts: { setCurrentPhase?: string | null } = {},
): Promise<void> {
  const existing = await readPhaseProgress(runId);
  const prior: PhaseProgressEntry = existing[phaseKey] ?? { status: "pending" };
  const next: PhaseProgressEntry = { ...prior, ...patch };
  if (patch.status === "completed" && prior.startedAt && !next.completedAt) {
    next.completedAt = new Date().toISOString();
  }
  if (next.startedAt && next.completedAt && next.durationMs === undefined) {
    next.durationMs = new Date(next.completedAt).getTime() - new Date(next.startedAt).getTime();
  }
  const merged: PhaseProgressMap = { ...existing, [phaseKey]: next };
  const data: Prisma.CapabilityBootstrapRunUncheckedUpdateInput = {
    phaseProgress: merged as unknown as Prisma.InputJsonValue,
  };
  if (opts.setCurrentPhase !== undefined) {
    data.currentPhase = opts.setCurrentPhase;
  }
  await prisma.capabilityBootstrapRun.update({ where: { id: runId }, data });
}

/**
 * Mark a phase as starting. Sets status=running, stamps startedAt,
 * bumps currentPhase. Use this at the top of each phase worker.
 */
export async function markPhaseStarted(runId: string, phaseKey: string): Promise<void> {
  await patchPhase(
    runId,
    phaseKey,
    { status: "running", startedAt: new Date().toISOString() },
    { setCurrentPhase: phaseKey },
  );
}

/**
 * Mark a phase as completed with optional stats payload.
 */
export async function markPhaseCompleted(
  runId: string,
  phaseKey: string,
  stats?: Record<string, unknown>,
): Promise<void> {
  await patchPhase(runId, phaseKey, {
    status: "completed",
    completedAt: new Date().toISOString(),
    stats,
  });
}

/**
 * Mark a phase as failed. Stores the error message so the wizard UI
 * can surface it without re-querying logs. Does NOT bump currentPhase
 * — the caller decides whether the failure aborts the chain or
 * the next phase still runs (degraded mode).
 */
export async function markPhaseFailed(
  runId: string,
  phaseKey: string,
  error: Error | string,
): Promise<void> {
  await patchPhase(runId, phaseKey, {
    status: "failed",
    completedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Mark a phase as skipped (e.g. AST index when no repository was
 * attached, distillation when no README was discovered).
 */
export async function markPhaseSkipped(runId: string, phaseKey: string, reason: string): Promise<void> {
  await patchPhase(runId, phaseKey, {
    status: "skipped",
    completedAt: new Date().toISOString(),
    stats: { reason },
  });
}
