/**
 * The read side: what one agent actually receives.
 *
 * A slice is core + the caller's role views + any relevant domain/task guide,
 * trimmed to a budget. It is the only thing context-fabric needs to ask for; the
 * caller supplies a role and gets back a prompt-sized answer rather than a
 * catalogue to filter itself.
 *
 * Three decisions worth knowing about:
 *  - Stale views are INCLUDED, flagged. Grounding that is one commit behind is
 *    far more useful than no grounding, and the flag lets the reader discount it.
 *    Dropping them would make a re-ground silently strip every agent's context.
 *  - Only READY views are served. PENDING has no content and FAILED has only an
 *    error; either would be noise in a prompt.
 *  - The budget evicts from the back. Routing order is priority order, and
 *    core_summary is never evicted.
 */

import { prisma } from "../../config/prisma";
import { getWorldModel } from "./world-model.service";
import { projectViewDoc, viewKey, type WorldModelViewDoc, type WorldModelViewKind } from "./world-model-views.types";
import { resolveRoleViews, loadRoleViews, type SliceBudget } from "./world-model-role-views.config";

export type SliceView = {
  kind: WorldModelViewKind;
  domainKey: string;
  title: string;
  contentMd: string;
  tokenEstimate: number;
  contentHash: string | null;
  stale: boolean;
};

export type WorldModelSlice = {
  capabilityId: string;
  /** The capability-wide world model, or null — parent capabilities may have
   *  views (built from artifacts and children) without one. */
  worldModel: Awaited<ReturnType<typeof getWorldModel>>;
  views: SliceView[];
  routing: {
    role: string;
    matched: boolean;
    requested: WorldModelViewKind[];
    reason: string;
    dropped: { kind: WorldModelViewKind; domainKey: string; reason: string }[];
  };
};

export type SliceRequest = {
  role?: string | null;
  task?: string | null;
  domainKey?: string | null;
  budget?: Partial<SliceBudget>;
};

/**
 * Apply the budget. core_summary is exempt: it is the smallest view and the one
 * that makes the others interpretable, so evicting it to fit a role view would
 * be exactly backwards.
 */
function applyBudget(
  views: SliceView[],
  budget: SliceBudget,
): { kept: SliceView[]; dropped: { kind: WorldModelViewKind; domainKey: string; reason: string }[] } {
  const kept: SliceView[] = [];
  const dropped: { kind: WorldModelViewKind; domainKey: string; reason: string }[] = [];
  let chars = 0;

  for (const view of views) {
    const exempt = view.kind === "core_summary";
    if (!exempt && kept.length >= budget.maxViews) {
      dropped.push({ kind: view.kind, domainKey: view.domainKey, reason: `over maxViews (${budget.maxViews})` });
      continue;
    }
    const next = chars + view.contentMd.length;
    if (!exempt && next > budget.maxTotalChars) {
      dropped.push({ kind: view.kind, domainKey: view.domainKey, reason: `over maxTotalChars (${budget.maxTotalChars})` });
      continue;
    }
    kept.push(view);
    chars = next;
  }
  return { kept, dropped };
}

function toSliceView(doc: WorldModelViewDoc, currentFingerprint: string | null): SliceView {
  return {
    kind: doc.kind,
    domainKey: doc.domainKey,
    title: doc.title,
    contentMd: doc.contentMd,
    tokenEstimate: doc.tokenEstimate,
    contentHash: doc.contentHash,
    // Computed here rather than read from the row so a re-ground takes effect
    // immediately, without rewriting every view.
    stale: !!currentFingerprint && !!doc.repoFingerprint && doc.repoFingerprint !== currentFingerprint,
  };
}

/**
 * Build the slice for one role.
 *
 * Returns `views: []` rather than throwing when a capability has no views built
 * — that is the normal state until an operator builds them, and it is exactly
 * today's behaviour for every caller.
 */
export async function getWorldModelSlice(capabilityId: string, request: SliceRequest = {}): Promise<WorldModelSlice> {
  const config = loadRoleViews();
  const budget: SliceBudget = { ...config.budget, ...request.budget };
  const routing = resolveRoleViews(request.role, config);

  const task = (request.task ?? "").trim();
  const domainKey = (request.domainKey ?? "").trim();

  // Wanted, in priority order: core, the role's views, then the narrower
  // on-demand kinds. Domain and task guide come last because they are the most
  // specific and the most likely to be missing.
  const wanted: { kind: WorldModelViewKind; domainKey: string }[] = routing.kinds.map((kind) => ({ kind, domainKey: "" }));
  if (domainKey) wanted.push({ kind: "domain", domainKey });
  if (task) wanted.push({ kind: "task_guide", domainKey: task });

  const [rows, worldModel] = await Promise.all([
    prisma.capabilityWorldModelViewDoc.findMany({
      where: { capabilityId, status: "READY", OR: wanted.map((w) => ({ kind: w.kind, domainKey: w.domainKey })) },
    }),
    getWorldModel(capabilityId),
  ]);

  const currentFingerprint = worldModel?.repoFingerprint ?? null;
  const byKey = new Map(rows.map((row) => [viewKey(row.kind, row.domainKey), projectViewDoc(row)]));

  // Order by what was wanted, not by what the database returned, so routing
  // priority survives into the prompt.
  const ordered: SliceView[] = [];
  for (const want of wanted) {
    const doc = byKey.get(viewKey(want.kind, want.domainKey));
    if (doc) ordered.push(toSliceView(doc, currentFingerprint));
  }

  const { kept, dropped } = applyBudget(ordered, budget);

  return {
    capabilityId,
    worldModel,
    views: kept,
    routing: {
      role: routing.role,
      matched: routing.matched,
      requested: wanted.map((w) => w.kind),
      reason: routing.reason,
      dropped,
    },
  };
}
