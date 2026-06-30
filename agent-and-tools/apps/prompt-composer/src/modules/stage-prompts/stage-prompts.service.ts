/**
 * M36.1 — stage-prompt resolver.
 *
 * Reads `StagePromptBinding` to map a (stageKey, agentRole) tuple to a
 * PromptProfile, then renders the profile's `taskTemplate` (Mustache) and
 * assembles a system-prompt fragment from the profile's AGENT_ROLE +
 * OUTPUT_CONTRACT layers.
 *
 * The goal: callers in workgraph-api stop hardcoding prompt strings like
 *   `architectTask`, `developerTask`, `qaTask`, `stageSystemPrompt`,
 *   `loopStageTask`, `loopStageSystemPrompt`
 * and instead POST {stageKey, agentRole, vars} here.
 */
import { prisma, runtimeReader } from "../../config/prisma";
import { logger } from "../../config/logger";
import { NotFoundError } from "../../shared/errors";
import { render as renderMustache } from "../../shared/mustache";
import { buildAgentSkillSourceLayer } from "../compose/skill-source-layer";
import type { ResolveStageInput, ResolveStageResult } from "./stage-prompts.schemas";

// #25 — read-only long-term-memory grounding for the governed turn. The composer
// already surfaces distilled memory on /compose-and-respond; the governed loop
// resolves prompts via /stage-prompts/resolve instead, which previously carried
// no memory. When a capabilityId is supplied we append the capability's promoted
// (distilled, status ACTIVE) memory to extraContext so it reaches the turn's
// user message. Best-effort + capped; the promotion WRITE lifecycle is separate.
const LONG_TERM_MEMORY_TOP_K = Math.max(0, Number(process.env.STAGE_PROMPT_MEMORY_TOP_K ?? 5));
const LONG_TERM_MEMORY_MAX_CHARS = Math.max(80, Number(process.env.STAGE_PROMPT_MEMORY_MAX_CHARS ?? 500));

async function renderLongTermMemory(capabilityId: string): Promise<string> {
  if (LONG_TERM_MEMORY_TOP_K === 0) return "";
  try {
    const rows = await runtimeReader.distilledMemory.findMany({
      where: { scopeType: "CAPABILITY", scopeId: capabilityId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      take: LONG_TERM_MEMORY_TOP_K,
    });
    if (rows.length === 0) return "";
    const lines = rows.map((m) => {
      const body = m.content.length > LONG_TERM_MEMORY_MAX_CHARS
        ? `${m.content.slice(0, LONG_TERM_MEMORY_MAX_CHARS)}…`
        : m.content;
      return `- [${m.memoryType}] ${m.title}: ${body}`;
    });
    return `## Long-term memory (prior distilled lessons for this capability)\n${lines.join("\n")}`;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, capabilityId },
      "[stage-prompts] long-term memory fetch failed (continuing without it)",
    );
    return "";
  }
}

interface BindingRow {
  id: string;
  stageKey: string;
  agentRole: string | null;
  phase: string | null;
  promptProfileId: string;
  isActive: boolean;
}

/**
 * Look up the most specific active binding.
 *
 * M71 — Specificity ladder (first match wins):
 *
 *   1. (stageKey,             agentRole, phase)   — most specific: e.g. DEVELOPER + ACT
 *   2. (stageKey,             agentRole, NULL)    — stage-level for this role
 *   3. (stageKey,             NULL,      phase)   — phase-level for any role
 *   4. (stageKey,             NULL,      NULL)    — stage default
 *   then strip the .intake/.develop suffix on `loop.stage.<key>` -> `loop.stage`
 *   and try 1..4 again.
 *
 * The phase-specific layer means an LLM in DEVELOPER ACT phase gets ACT-
 * focused guidance ("apply patches; mutate files; no exploration") while
 * the same agent in DEVELOPER PLAN phase sees PLAN-focused guidance
 * ("identify target files; declare test strategy; do NOT edit").
 */
async function findBinding(
  stageKey: string,
  agentRole?: string,
  phase?: string,
): Promise<BindingRow | null> {
  // M72 — Universal `loop.stage` fallback. Mirror the broadened fallback in
  // stage-policies.service.ts so prompt resolution and policy resolution
  // walk the same ladder. Without this, freshly-normalised stage keys
  // (`story-intake`, `develop`, …) hit the prompt ladder via the slug-strip
  // path but the policy ladder 404'd, producing the asymmetry that
  // surfaced as STAGE_POLICY_NOT_FOUND on the first run after a workitem
  // detach + reattach.
  const candidates = [stageKey];
  if (stageKey !== "loop.stage") {
    candidates.push("loop.stage");
  }
  for (const candidate of candidates) {
    // 1. exact: stageKey + role + phase
    if (agentRole && phase) {
      const exact = await prisma.stagePromptBinding.findFirst({
        where: { stageKey: candidate, agentRole, phase, isActive: true },
      });
      if (exact) return exact;
    }
    // 2. stage-level for this role: stageKey + role + NULL phase
    if (agentRole) {
      const roleFallback = await prisma.stagePromptBinding.findFirst({
        where: { stageKey: candidate, agentRole, phase: null, isActive: true },
      });
      if (roleFallback) return roleFallback;
    }
    // 3. phase-level for any role: stageKey + NULL role + phase
    if (phase) {
      const phaseFallback = await prisma.stagePromptBinding.findFirst({
        where: { stageKey: candidate, agentRole: null, phase, isActive: true },
      });
      if (phaseFallback) return phaseFallback;
    }
    // 4. stage default: stageKey + NULL role + NULL phase
    const defaultFallback = await prisma.stagePromptBinding.findFirst({
      where: { stageKey: candidate, agentRole: null, phase: null, isActive: true },
    });
    if (defaultFallback) return defaultFallback;
  }
  return null;
}

/**
 * Assemble the system-prompt fragment from a profile's AGENT_ROLE +
 * TOOL_CONTRACT + OUTPUT_CONTRACT layers (the bits the workbench previously
 * concatenated inline as `stageSystemPrompt` / `loopStageSystemPrompt`, plus
 * M36.3's tool-policy layers that replace mcp-server's inline system messages).
 *
 * We deliberately keep PLATFORM_CONSTITUTION OUT of this fragment — that
 * layer is already injected by the main compose.service path; including
 * it here would double-prompt the model.
 *
 * Layers are joined with newlines so tool-policy guidance reads as its own
 * paragraph rather than a run-on with the role contract.
 */
async function loadSystemPromptFragment(profileId: string): Promise<string> {
  const links = await prisma.promptProfileLayer.findMany({
    where: { promptProfileId: profileId, isEnabled: true },
    include: { promptLayer: true },
    orderBy: { priority: "asc" },
  });
  const parts: string[] = [];
  for (const link of links) {
    const layer = link.promptLayer;
    if (!layer || layer.status !== "ACTIVE") continue;
    if (
      layer.layerType === "AGENT_ROLE" ||
      layer.layerType === "TOOL_CONTRACT" ||
      layer.layerType === "OUTPUT_CONTRACT"
    ) {
      parts.push(layer.content);
    }
  }
  return parts.join("\n\n").trim();
}

/**
 * C — append the agent template's AGENT_SKILL_SOURCES layer (source type +
 * effective permissions + read-only / provider-locked) to a base system fragment,
 * reusing the same builder the full composer uses. No-op when no agentTemplateId
 * is supplied or the template has no bound skills, so callers that don't pass one
 * are unchanged.
 */
async function withSkillSources(base: string, agentTemplateId: string | undefined): Promise<string> {
  if (!agentTemplateId) return base;
  const layer = await buildAgentSkillSourceLayer(agentTemplateId);
  if (!layer) return base;
  return base ? `${base}\n\n${layer}` : layer;
}

export const stagePromptsService = {
  async resolve(input: ResolveStageInput): Promise<ResolveStageResult> {
    if (input.promptProfileKey) {
      const key = input.promptProfileKey;
      const profile = await prisma.promptProfile.findFirst({
        where: {
          status: "ACTIVE",
          OR: [
            { id: key },
            { stageKey: key },
            { name: key },
          ],
        },
      });
      if (profile) {
        const ctx = (input.vars ?? {}) as Record<string, unknown>;
        const taskRendered = profile.taskTemplate?.trim()
          ? renderMustache(profile.taskTemplate, ctx).rendered
          : "";
        let extraRendered = profile.extraContextTemplate?.trim()
          ? renderMustache(profile.extraContextTemplate, ctx).rendered
          : "";
        // #25 — same long-term-memory grounding on the pinned-profile path.
        if (input.capabilityId) {
          const memoryBlock = await renderLongTermMemory(input.capabilityId);
          if (memoryBlock) extraRendered = extraRendered ? `${extraRendered}\n\n${memoryBlock}` : memoryBlock;
        }
        return {
          task: taskRendered,
          systemPromptAppend: await withSkillSources(await loadSystemPromptFragment(profile.id), input.agentTemplateId),
          extraContext: extraRendered,
          promptProfileId: profile.id,
          bindingId: `direct:${profile.id}`,
          stageKey: profile.stageKey ?? input.stageKey,
          agentRole: profile.roleGate ?? null,
          // M71 — promptProfileKey takes a profile directly, bypassing the
          // (stageKey, role, phase) ladder. The phase isn't resolved here.
          phase: null,
        };
      }
    }

    const binding = await findBinding(input.stageKey, input.agentRole, input.phase);
    if (!binding) {
      throw new NotFoundError(
        `No StagePromptBinding for stageKey="${input.stageKey}"` +
          (input.agentRole ? ` agentRole="${input.agentRole}"` : "") +
          `. Seed prompt-composer or add a binding row.`,
      );
    }

    const profile = await prisma.promptProfile.findUnique({
      where: { id: binding.promptProfileId },
    });
    if (!profile) {
      throw new NotFoundError(
        `StagePromptBinding ${binding.id} references missing PromptProfile ${binding.promptProfileId}`,
      );
    }

    // 1. Render the task template (or empty if the profile has none — caller
    //    can fall back to whatever default they want, e.g. "Run stage X").
    const ctx = (input.vars ?? {}) as Record<string, unknown>;
    let task = "";
    if (profile.taskTemplate && profile.taskTemplate.trim().length > 0) {
      const rendered = renderMustache(profile.taskTemplate, ctx);
      if (rendered.warnings.length > 0) {
        logger.debug(
          { stageKey: input.stageKey, agentRole: input.agentRole, unresolved: rendered.warnings },
          "[stage-prompts] task template has unresolved Mustache vars",
        );
      }
      task = rendered.rendered;
    }

    // 2. M36.6 — Render the extraContext template too (used by the workbench
    //    loop runner so the per-execution policy block is also DB-owned).
    let extraContext = "";
    if (profile.extraContextTemplate && profile.extraContextTemplate.trim().length > 0) {
      const rendered = renderMustache(profile.extraContextTemplate, ctx);
      if (rendered.warnings.length > 0) {
        logger.debug(
          { stageKey: input.stageKey, agentRole: input.agentRole, unresolved: rendered.warnings },
          "[stage-prompts] extraContext template has unresolved Mustache vars",
        );
      }
      extraContext = rendered.rendered;
    }

    // 2b. #25 — append the capability's promoted long-term memory (read-only) so
    // the governed turn is grounded in prior distilled lessons.
    if (input.capabilityId) {
      const memoryBlock = await renderLongTermMemory(input.capabilityId);
      if (memoryBlock) {
        extraContext = extraContext ? `${extraContext}\n\n${memoryBlock}` : memoryBlock;
      }
    }

    // 3. Assemble the system-prompt fragment.
    const systemPromptAppend = await withSkillSources(await loadSystemPromptFragment(binding.promptProfileId), input.agentTemplateId);

    return {
      task,
      systemPromptAppend,
      extraContext,
      promptProfileId: binding.promptProfileId,
      bindingId: binding.id,
      stageKey: binding.stageKey,
      agentRole: binding.agentRole,
      phase: binding.phase,
    };
  },

  /** Diagnostic — list every active binding so an admin can see what's wired. */
  async list(): Promise<Array<BindingRow & { profileName: string | null }>> {
    const rows = await prisma.stagePromptBinding.findMany({
      where: { isActive: true },
      include: { promptProfile: true },
      // M71 — order by phase too so admin views group stage-level (NULL phase
      // sorts first under asc-NULLS-FIRST in PG) before phase-specific overrides.
      orderBy: [{ stageKey: "asc" }, { agentRole: "asc" }, { phase: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id,
      stageKey: r.stageKey,
      agentRole: r.agentRole,
      phase: r.phase,
      promptProfileId: r.promptProfileId,
      isActive: r.isActive,
      profileName: r.promptProfile?.name ?? null,
    }));
  },
};
