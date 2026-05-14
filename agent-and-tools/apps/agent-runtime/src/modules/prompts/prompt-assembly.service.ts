/**
 * @deprecated M29 gate — final blocker for the prompt-composer DB split.
 *
 * Prompt assembly was moved to prompt-composer in M2. This service remains
 * because executions/execution.service.ts still imports `promptAssemblyService`
 * for legacy AgentExecutionReceipt rows. Once that import is removed (or
 * routed through HTTP to prompt-composer), this file can be deleted and the
 * Postgres DB split becomes a safe one-PR change.
 *
 * **Do not add new callers.** New code should call prompt-composer's
 * /api/v1/compose-and-respond endpoint instead.
 */
import { prisma } from "../../config/prisma";
import { NotFoundError } from "../../shared/errors";
import { sha256, estimateTokens } from "../../shared/hash";
import { AssembleInput } from "./prompt.schemas";

interface AssembledLayer {
  promptLayerId?: string;
  layerType: string;
  priority: number;
  inclusionReason: string;
  contentSnapshot: string;
  layerHash: string;
}

export const promptAssemblyService = {
  /**
   * Assembles a final prompt per spec §16.2:
   *   template base profile → binding profile → capability context + knowledge + distilled memory
   *   → workflow phase layers → tool contracts → task context → output contract → sort by priority → hash.
   */
  async assemble(input: AssembleInput, executionId?: string) {
    const layers: AssembledLayer[] = [];

    // 1. Agent template + base prompt profile
    const template = await prisma.agentTemplate.findUnique({ where: { id: input.agentTemplateId } });
    if (!template) throw new NotFoundError("Agent template not found");

    if (template.basePromptProfileId) {
      const baseLayers = await loadProfileLayers(template.basePromptProfileId, "agent template base profile");
      layers.push(...baseLayers);
    }

    // 2. Binding overlay
    let binding: { id: string; promptProfileId: string | null; capabilityId: string | null } | null = null;
    if (input.agentBindingId) {
      binding = await prisma.agentCapabilityBinding.findUnique({
        where: { id: input.agentBindingId },
        select: { id: true, promptProfileId: true, capabilityId: true },
      });
      if (binding?.promptProfileId) {
        const overlay = await loadProfileLayers(binding.promptProfileId, "agent binding overlay");
        layers.push(...overlay);
      }
    }

    // 3. Capability context, knowledge, distilled memory
    const capabilityId = input.capabilityId ?? binding?.capabilityId ?? null;
    if (capabilityId) {
      const capability = await prisma.capability.findUnique({ where: { id: capabilityId } });
      if (capability) {
        const capContent = `Capability: ${capability.name}\nType: ${capability.capabilityType ?? "—"}\nCriticality: ${capability.criticality ?? "—"}\n${capability.description ?? ""}`;
        layers.push({
          layerType: "CAPABILITY_CONTEXT",
          priority: 200,
          inclusionReason: "capability scope provided",
          contentSnapshot: capContent,
          layerHash: sha256(capContent),
        });

        const artifacts = await prisma.capabilityKnowledgeArtifact.findMany({
          where: { capabilityId, status: "ACTIVE" },
          orderBy: { createdAt: "desc" }, take: 10,
        });
        for (const a of artifacts) {
          const content = `[${a.artifactType}] ${a.title}\n${a.content}`;
          layers.push({
            layerType: "RUNTIME_EVIDENCE",
            priority: 250,
            inclusionReason: `knowledge artifact ${a.artifactType}`,
            contentSnapshot: content,
            layerHash: sha256(content),
          });
        }

        const memory = await prisma.distilledMemory.findMany({
          where: { scopeType: "CAPABILITY", scopeId: capabilityId, status: "ACTIVE" },
          orderBy: { createdAt: "desc" }, take: 10,
        });
        for (const m of memory) {
          const content = `[${m.memoryType}] ${m.title}\n${m.content}`;
          layers.push({
            layerType: "MEMORY_CONTEXT",
            priority: 300,
            inclusionReason: "distilled memory match",
            contentSnapshot: content,
            layerHash: sha256(content),
          });
        }
      }
    }

    // 4. Workflow phase layers
    if (input.workflowPhase) {
      const phaseLayers = await prisma.promptLayer.findMany({
        where: { scopeType: "WORKFLOW_PHASE", scopeId: input.workflowPhase, status: "ACTIVE" },
      });
      for (const l of phaseLayers) {
        layers.push({
          promptLayerId: l.id,
          layerType: l.layerType,
          priority: 350 + l.priority,
          inclusionReason: `workflow phase ${input.workflowPhase}`,
          contentSnapshot: l.content,
          layerHash: l.contentHash ?? sha256(l.content),
        });
      }
    }

    // 5+6. Resolve allowed tools and build the Available Tools section
    const toolsSection = await resolveAllowedToolsSection({
      agentTemplateId: input.agentTemplateId,
      agentBindingId: input.agentBindingId,
      capabilityId,
      workflowPhase: input.workflowPhase,
    });
    if (toolsSection) {
      layers.push({
        layerType: "TOOL_CONTRACT",
        priority: 500,
        inclusionReason: "resolved tool grants",
        contentSnapshot: toolsSection,
        layerHash: sha256(toolsSection),
      });
    }

    // 7. Task context
    const taskContent = `# Current Task\n${input.task}`;
    layers.push({
      layerType: "TASK_CONTEXT",
      priority: 900,
      inclusionReason: "user task",
      contentSnapshot: taskContent,
      layerHash: sha256(taskContent),
    });

    // 8. Sort by priority ascending
    layers.sort((a, b) => a.priority - b.priority);

    // 9. Concatenate
    const finalPrompt = layers.map(l => `# ${humanLayer(l.layerType)}\n${l.contentSnapshot}`).join("\n\n");
    const finalPromptHash = sha256(finalPrompt);

    // 10. Persist
    const assembly = await prisma.promptAssembly.create({
      data: {
        executionId: executionId ?? null,
        agentTemplateId: input.agentTemplateId,
        agentBindingId: input.agentBindingId ?? null,
        capabilityId: capabilityId ?? null,
        workflowExecutionId: input.workflowExecutionId ?? null,
        promptProfileId: template.basePromptProfileId ?? null,
        modelProvider: input.modelProvider ?? null,
        modelName: input.modelName ?? null,
        finalPromptHash,
        finalPromptPreview: finalPrompt.slice(0, 4000),
        estimatedInputTokens: estimateTokens(finalPrompt),
        layers: {
          create: layers.map(l => ({
            promptLayerId: l.promptLayerId ?? null,
            layerType: l.layerType,
            layerHash: l.layerHash,
            priority: l.priority,
            included: true,
            inclusionReason: l.inclusionReason,
            contentSnapshot: l.contentSnapshot,
          })),
        },
      },
      include: { layers: true },
    });

    return {
      promptAssemblyId: assembly.id,
      finalPromptHash,
      finalPromptPreview: assembly.finalPromptPreview,
      estimatedInputTokens: assembly.estimatedInputTokens,
      includedLayers: layers.map(l => ({ layerType: l.layerType, priority: l.priority, layerHash: l.layerHash })),
    };
  },
};

async function loadProfileLayers(profileId: string, reason: string): Promise<AssembledLayer[]> {
  const links = await prisma.promptProfileLayer.findMany({
    where: { promptProfileId: profileId, isEnabled: true },
    include: { promptLayer: true },
    orderBy: { priority: "asc" },
  });
  return links
    .filter(l => l.promptLayer.status === "ACTIVE")
    .map(l => ({
      promptLayerId: l.promptLayer.id,
      layerType: l.promptLayer.layerType,
      priority: l.priority,
      inclusionReason: reason,
      contentSnapshot: l.promptLayer.content,
      layerHash: l.promptLayer.contentHash ?? sha256(l.promptLayer.content),
    }));
}

async function resolveAllowedToolsSection(ctx: {
  agentTemplateId: string;
  agentBindingId?: string;
  capabilityId?: string | null;
  workflowPhase?: string;
}): Promise<string | null> {
  const scopeFilters: Array<{ grantScopeType: string; grantScopeId: string }> = [
    { grantScopeType: "AGENT_TEMPLATE", grantScopeId: ctx.agentTemplateId },
  ];
  if (ctx.agentBindingId) scopeFilters.push({ grantScopeType: "AGENT_BINDING", grantScopeId: ctx.agentBindingId });
  if (ctx.capabilityId) scopeFilters.push({ grantScopeType: "CAPABILITY", grantScopeId: ctx.capabilityId });

  const grants = await prisma.toolGrant.findMany({
    where: { OR: scopeFilters as never, status: "ACTIVE" },
    include: { tool: { include: { contracts: { where: { status: "ACTIVE" }, orderBy: { version: "desc" }, take: 1 } } } },
  });

  // Filter by workflow phase (null phase on grant means "any phase")
  const filtered = grants.filter(g => !g.workflowPhase || g.workflowPhase === ctx.workflowPhase);
  if (filtered.length === 0) return null;

  const lines = filtered.map(g => {
    const contract = g.tool.contracts[0];
    const fullName = `${g.tool.namespace}.${g.tool.name}`;
    const risk = contract?.riskLevel ?? "LOW";
    const desc = g.tool.description ?? "";
    return `Tool: ${fullName}\nDescription: ${desc}\nRisk: ${risk}\nInput schema: ${contract ? JSON.stringify(contract.inputSchema) : "{}"}\n`;
  });

  return `Available tools:\n\n${lines.join("\n")}`;
}

function humanLayer(layerType: string): string {
  return layerType.split("_").map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");
}
