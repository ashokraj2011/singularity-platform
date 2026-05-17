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
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { NotFoundError } from "../../shared/errors";
import { render as renderMustache } from "../../shared/mustache";
import type { ResolveStageInput, ResolveStageResult } from "./stage-prompts.schemas";

interface BindingRow {
  id: string;
  stageKey: string;
  agentRole: string | null;
  promptProfileId: string;
  isActive: boolean;
}

/**
 * Look up the most specific active binding for (stageKey, role).
 * Exact (stageKey, role) wins over (stageKey, null) fallback.
 */
async function findBinding(stageKey: string, agentRole?: string): Promise<BindingRow | null> {
  // Prefer exact role match first.
  if (agentRole) {
    const exact = await prisma.stagePromptBinding.findFirst({
      where: { stageKey, agentRole, isActive: true },
    });
    if (exact) return exact;
  }
  // Fall back to the role-agnostic binding.
  return await prisma.stagePromptBinding.findFirst({
    where: { stageKey, agentRole: null, isActive: true },
  });
}

/**
 * Assemble the system-prompt fragment from a profile's AGENT_ROLE +
 * OUTPUT_CONTRACT layers (the bits the workbench previously concatenated
 * inline as `stageSystemPrompt` / `loopStageSystemPrompt`).
 *
 * We deliberately keep PLATFORM_CONSTITUTION OUT of this fragment — that
 * layer is already injected by the main compose.service path; including
 * it here would double-prompt the model.
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
    if (layer.layerType === "AGENT_ROLE" || layer.layerType === "OUTPUT_CONTRACT") {
      parts.push(layer.content);
    }
  }
  return parts.join(" ").trim();
}

export const stagePromptsService = {
  async resolve(input: ResolveStageInput): Promise<ResolveStageResult> {
    const binding = await findBinding(input.stageKey, input.agentRole);
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

    // 3. Assemble the system-prompt fragment.
    const systemPromptAppend = await loadSystemPromptFragment(binding.promptProfileId);

    return {
      task,
      systemPromptAppend,
      extraContext,
      promptProfileId: binding.promptProfileId,
      bindingId: binding.id,
      stageKey: binding.stageKey,
      agentRole: binding.agentRole,
    };
  },

  /** Diagnostic — list every active binding so an admin can see what's wired. */
  async list(): Promise<Array<BindingRow & { profileName: string | null }>> {
    const rows = await prisma.stagePromptBinding.findMany({
      where: { isActive: true },
      include: { promptProfile: true },
      orderBy: [{ stageKey: "asc" }, { agentRole: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id,
      stageKey: r.stageKey,
      agentRole: r.agentRole,
      promptProfileId: r.promptProfileId,
      isActive: r.isActive,
      profileName: r.promptProfile?.name ?? null,
    }));
  },
};
