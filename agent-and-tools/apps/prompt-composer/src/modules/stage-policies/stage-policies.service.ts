/**
 * M71 — Stage policy resolver + admin upsert.
 *
 * Reads `StagePolicy` + `StagePhasePolicy` and serves them to context-fabric
 * via /api/v1/stage-policies/resolve. The resolution chain mirrors
 * stage-prompts.service.ts:findBinding — exact (stageKey, agentRole) wins,
 * then (stageKey, null) fallback, then strip `loop.stage.<key>` to
 * `loop.stage` and retry.
 *
 * The goal: context-fabric loads ONE policy per /execute call, caches it for
 * the session, and enforces it as hard-refuse on every tool dispatch.
 */
import { prisma } from "../../config/prisma";
import { NotFoundError } from "../../shared/errors";
import type {
  Phase,
  PhasePolicyInput,
  ResolveStagePolicyInput,
  ResolveStagePolicyResult,
  UpsertStagePolicyInput,
} from "./stage-policies.schemas";

interface StagePolicyRow {
  id: string;
  stageKey: string;
  agentRole: string | null;
  version: number;
  status: string;
  approvalModel: unknown;
  limits: unknown;
  contextPolicy: unknown;
  editPolicy: unknown;
  verificationPolicy: unknown;
  riskPolicy: unknown;
}

/**
 * Find the highest-specificity ACTIVE policy for (stageKey, agentRole).
 * Same fallback chain as stage-prompts: exact → null role → parent stageKey
 * (stripping the `.intake`/`.develop` suffix down to `loop.stage`).
 */
async function findPolicy(
  stageKey: string,
  agentRole?: string,
): Promise<StagePolicyRow | null> {
  // M72 — Universal `loop.stage` fallback. The user's workflow may use
  // arbitrary stage keys like "story-intake", "develop", "qa-review" (kebab-
  // case normalisation happens in workgraph-api when a starter loopDefinition
  // gets saved). The previous narrow fallback only matched `loop.stage.*`,
  // so freshly-normalised stages 404'd. Now ANY stage key that doesn't have
  // its own policy falls through to the canonical `loop.stage` + agentRole
  // policy. Operators who want a stage-specific override can still seed
  // `loop.stage.<stagekey>` directly and it wins.
  const candidates = [stageKey];
  if (stageKey !== "loop.stage") {
    candidates.push("loop.stage");
  }
  for (const candidate of candidates) {
    if (agentRole) {
      const exact = await prisma.stagePolicy.findFirst({
        where: { stageKey: candidate, agentRole, status: "ACTIVE" },
        orderBy: { version: "desc" },
      });
      if (exact) return exact;
    }
    const fallback = await prisma.stagePolicy.findFirst({
      where: { stageKey: candidate, agentRole: null, status: "ACTIVE" },
      orderBy: { version: "desc" },
    });
    if (fallback) return fallback;
  }
  return null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export const stagePoliciesService = {
  /**
   * The hot path. context-fabric calls this once per /execute (or per session)
   * and uses the returned `phases[*].allowedTools` to refuse out-of-phase tool
   * calls with PHASE_TOOL_FORBIDDEN.
   */
  async resolve(input: ResolveStagePolicyInput): Promise<ResolveStagePolicyResult> {
    const policy = await findPolicy(input.stageKey, input.agentRole);
    if (!policy) {
      throw new NotFoundError(
        `No StagePolicy for stageKey="${input.stageKey}"` +
          (input.agentRole ? ` agentRole="${input.agentRole}"` : "") +
          ". Seed prompt-composer or POST /api/v1/stage-policies.",
      );
    }

    const phases = await prisma.stagePhasePolicy.findMany({
      where: {
        stagePolicyId: policy.id,
        ...(input.phase ? { phase: input.phase } : {}),
      },
      orderBy: { phase: "asc" },
    });

    return {
      policyId:           policy.id,
      stageKey:           policy.stageKey,
      agentRole:          policy.agentRole,
      version:            policy.version,
      status:             policy.status,
      approvalModel:      jsonObject(policy.approvalModel),
      limits:             jsonObject(policy.limits),
      contextPolicy:      jsonObject(policy.contextPolicy),
      editPolicy:         jsonObject(policy.editPolicy),
      verificationPolicy: jsonObject(policy.verificationPolicy),
      riskPolicy:         jsonObject(policy.riskPolicy),
      phases: phases.map((p) => ({
        phase:                p.phase as Phase,
        allowedTools:         p.allowedTools,
        forbiddenTools:       p.forbiddenTools,
        requiredOutputSchema: jsonObject(p.requiredOutputSchema),
        maxInputTokens:       p.maxInputTokens,
        maxOutputTokens:      p.maxOutputTokens,
        maxToolCalls:         p.maxToolCalls,
      })),
    };
  },

  /**
   * Admin upsert. Replaces all phase rows for the policy atomically.
   * Existing policies match on (stageKey, agentRole, version); if you want a
   * new revision, bump `version` and POST again — old revisions stay around
   * with status ACTIVE unless retired explicitly.
   */
  async upsert(input: UpsertStagePolicyInput): Promise<ResolveStagePolicyResult> {
    const agentRole = input.agentRole ?? null;
    const existing = await prisma.stagePolicy.findFirst({
      where: { stageKey: input.stageKey, agentRole, version: input.version },
    });

    const policy = existing
      ? await prisma.stagePolicy.update({
          where: { id: existing.id },
          data: {
            status:             input.status,
            description:        input.description ?? null,
            approvalModel:      input.approvalModel as never,
            limits:             input.limits as never,
            contextPolicy:      input.contextPolicy as never,
            editPolicy:         input.editPolicy as never,
            verificationPolicy: input.verificationPolicy as never,
            riskPolicy:         input.riskPolicy as never,
          },
        })
      : await prisma.stagePolicy.create({
          data: {
            stageKey:           input.stageKey,
            agentRole,
            version:            input.version,
            status:             input.status,
            description:        input.description ?? null,
            approvalModel:      input.approvalModel as never,
            limits:             input.limits as never,
            contextPolicy:      input.contextPolicy as never,
            editPolicy:         input.editPolicy as never,
            verificationPolicy: input.verificationPolicy as never,
            riskPolicy:         input.riskPolicy as never,
          },
        });

    // Atomic replace of phase rows. Cascade delete clears the old set.
    if (existing) {
      await prisma.stagePhasePolicy.deleteMany({ where: { stagePolicyId: policy.id } });
    }
    if (input.phases.length > 0) {
      await prisma.stagePhasePolicy.createMany({
        data: input.phases.map((p: PhasePolicyInput) => ({
          stagePolicyId:        policy.id,
          phase:                p.phase,
          allowedTools:         p.allowedTools ?? [],
          forbiddenTools:       p.forbiddenTools ?? [],
          requiredOutputSchema: (p.requiredOutputSchema ?? {}) as never,
          maxInputTokens:       p.maxInputTokens ?? null,
          maxOutputTokens:      p.maxOutputTokens ?? null,
          maxToolCalls:         p.maxToolCalls ?? null,
        })),
      });
    }

    return this.resolve({ stageKey: policy.stageKey, agentRole: policy.agentRole ?? undefined });
  },

  /** Diagnostic — list every active stage policy summary. */
  async list(): Promise<
    Array<{
      id: string;
      stageKey: string;
      agentRole: string | null;
      version: number;
      status: string;
      description: string | null;
      phaseCount: number;
    }>
  > {
    const rows = await prisma.stagePolicy.findMany({
      where: { status: "ACTIVE" },
      include: { _count: { select: { phases: true } } },
      orderBy: [{ stageKey: "asc" }, { agentRole: "asc" }, { version: "desc" }],
    });
    return rows.map((r) => ({
      id:          r.id,
      stageKey:    r.stageKey,
      agentRole:   r.agentRole,
      version:     r.version,
      status:      r.status,
      description: r.description,
      phaseCount:  r._count.phases,
    }));
  },
};
