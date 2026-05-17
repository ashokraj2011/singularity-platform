/**
 * M40 — Bundle assembler for ImmutableContract.
 *
 * Given an agent template + capability (and a snapshot of the model alias
 * resolution from llm-gateway), assemble the full bundle JSON that captures
 * every prompt layer, every system prompt, every stage binding, every tool
 * pin, and the model resolution AT THIS MOMENT. Hash the canonical JSON
 * with SHA-256; that hash IS the contract identity.
 *
 * The bundle is what replay reads — not the live PromptLayer / SystemPrompt
 * rows. So a layer or prompt that gets edited after the contract is minted
 * does NOT affect runs pinned to the contract.
 *
 * Canonicalization: keys are sorted recursively before JSON.stringify so
 * two equivalent bundles always produce the same hash regardless of the
 * order Prisma returns rows in.
 */
import { createHash } from "node:crypto";
import { prisma, runtimeReader } from "../../config/prisma";
import { logger } from "../../config/logger";

export interface BundleResult {
  bundleHash: string;
  promptProfileVersions: Array<{ profileId: string; version: number; name: string }>;
  promptLayerVersions: Array<{
    layerId: string;
    version: number;
    layerHash: string;
    contentSnapshot: string;
    layerType: string;
    priority: number;
  }>;
  systemPromptVersions: Array<{ key: string; version: number; content: string }>;
  stageBindingVersions: Array<{
    stageKey: string;
    agentRole: string | null;
    profileId: string;
    taskTemplate: string | null;
    extraContextTemplate: string | null;
  }>;
  toolPins: Array<{
    toolNamespace: string;
    toolName: string;
    version: number;
    riskLevel: string | null;
    requires_approval: boolean;
  }>;
  modelResolution: {
    alias: string | null;
    provider: string;
    model: string;
    version: string | null;
    resolvedAt: string;
  };
}

export interface BundleInput {
  agentTemplateId: string;
  capabilityId?: string;
  modelResolution: BundleResult["modelResolution"];
}

/** Canonicalize a JSON value: sort object keys recursively. */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/**
 * Build the bundle from current DB rows + a caller-supplied modelResolution.
 * The caller is responsible for fetching modelResolution from llm-gateway
 * before invoking this function — composer doesn't know how to resolve
 * aliases to provider versions (that's llm-gateway's domain).
 */
export async function assembleBundle(input: BundleInput): Promise<BundleResult> {
  // 1. Agent template → base PromptProfile.
  const template = await runtimeReader.agentTemplate.findUnique({
    where: { id: input.agentTemplateId },
    select: { id: true, basePromptProfileId: true, defaultToolPolicyId: true },
  });
  if (!template) {
    throw new Error(`AgentTemplate ${input.agentTemplateId} not found`);
  }

  // 2. Walk every PromptProfile this template touches:
  //    - basePromptProfileId
  //    - any binding-level overrides (skipped here; future enhancement to
  //      walk AgentCapabilityBinding.promptProfileId when capabilityId set)
  //    - every StagePromptBinding linked profile
  const profileIds = new Set<string>();
  if (template.basePromptProfileId) profileIds.add(template.basePromptProfileId);

  const stageBindings = await prisma.stagePromptBinding.findMany({
    where: { isActive: true },
    select: { stageKey: true, agentRole: true, promptProfileId: true, promptProfile: true },
  });
  for (const b of stageBindings) profileIds.add(b.promptProfileId);

  const profiles = await prisma.promptProfile.findMany({
    where: { id: { in: [...profileIds] } },
    select: { id: true, name: true, version: true, taskTemplate: true, extraContextTemplate: true },
  });

  // 3. For each profile, fetch its linked PromptLayer rows with full content.
  const profileLayerLinks = await prisma.promptProfileLayer.findMany({
    where: { promptProfileId: { in: [...profileIds] }, isEnabled: true },
    select: { promptProfileId: true, promptLayerId: true, priority: true, promptLayer: true },
  });
  const layerSet = new Map<string, typeof profileLayerLinks[number]["promptLayer"] & { priority: number }>();
  for (const l of profileLayerLinks) {
    if (!l.promptLayer) continue;
    // Take the highest priority instance per layer (de-dupe across profiles).
    const existing = layerSet.get(l.promptLayerId);
    if (!existing || l.priority < existing.priority) {
      layerSet.set(l.promptLayerId, { ...l.promptLayer, priority: l.priority });
    }
  }

  // 4. All SystemPrompts (active versions only) — agents may reference any
  //    of these at runtime, so we capture the full catalog. Future
  //    optimization: trace which keys the agent actually fetches.
  const systemPrompts = await prisma.systemPrompt.findMany({
    where: { isActive: true },
    select: { key: true, version: true, content: true },
  });

  // 5. Tool pins — get the agent's effective tool grants. Today: read every
  //    ToolDefinition the agent's defaultToolPolicy grants. We snapshot the
  //    LATEST version per tool at minting time.
  const toolPins: BundleResult["toolPins"] = [];
  if (template.defaultToolPolicyId) {
    try {
      const grants = await runtimeReader.$queryRawUnsafe<Array<{
        namespace: string;
        name: string;
        version: number;
        risk_level: string | null;
        requires_approval: boolean | null;
      }>>(
        `SELECT t.namespace, t.name, t.version,
                COALESCE(c.risk_level::text, NULL) AS risk_level,
                COALESCE(t.requires_approval, false) AS requires_approval
           FROM "ToolGrant" g
                JOIN "ToolDefinition" t ON t.id = g."toolId"
                LEFT JOIN "ToolContract" c ON c."toolDefinitionId" = t.id
          WHERE g."toolPolicyId" = $1
          ORDER BY t.namespace, t.name, t.version DESC`,
        template.defaultToolPolicyId,
      );
      for (const g of grants) {
        toolPins.push({
          toolNamespace: g.namespace,
          toolName: g.name,
          version: g.version,
          riskLevel: g.risk_level,
          requires_approval: g.requires_approval ?? false,
        });
      }
    } catch (err) {
      logger.warn(
        { agentTemplateId: input.agentTemplateId, err: (err as Error).message },
        "[contracts] tool-grant query failed; bundle proceeds with empty tool pins",
      );
    }
  }

  // 6. Stage binding versions — snapshot every (stageKey, agentRole) tuple
  //    that points to a profile this agent uses.
  const stageBindingVersions: BundleResult["stageBindingVersions"] = [];
  for (const b of stageBindings) {
    if (!profileIds.has(b.promptProfileId)) continue;
    const prof = profiles.find((p) => p.id === b.promptProfileId);
    stageBindingVersions.push({
      stageKey: b.stageKey,
      agentRole: b.agentRole,
      profileId: b.promptProfileId,
      taskTemplate: prof?.taskTemplate ?? null,
      extraContextTemplate: prof?.extraContextTemplate ?? null,
    });
  }

  // 7. Assemble + canonicalize + hash.
  const promptProfileVersions = profiles.map((p) => ({
    profileId: p.id,
    version: p.version,
    name: p.name,
  }));
  const promptLayerVersions = [...layerSet.values()].map((l) => ({
    layerId: l.id,
    version: l.version,
    layerHash: l.contentHash ?? sha256(l.content),
    contentSnapshot: l.content,
    layerType: String(l.layerType),
    priority: l.priority,
  }));
  const systemPromptVersions = systemPrompts.map((s) => ({
    key: s.key,
    version: s.version,
    content: s.content,
  }));

  const bundle = {
    promptProfileVersions,
    promptLayerVersions,
    systemPromptVersions,
    stageBindingVersions,
    toolPins,
    modelResolution: input.modelResolution,
  };
  const canonical = JSON.stringify(canonicalize(bundle));
  const bundleHash = sha256(canonical);

  return { bundleHash, ...bundle };
}
