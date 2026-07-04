import { prisma } from "../../config/prisma";
import { Prisma } from "../../../generated/prisma-client";
import type { AgentRoleType, EntityStatus } from "../../../generated/prisma-client";
import { isProductionClassEnv } from "@agentandtools/shared";
import { AppError, ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors";
import type { AuthUser } from "../../middleware/auth.middleware";
import {
  CreateAgentProfileInput, CreateAgentTemplateInput, DeriveAgentTemplateInput, PreviewSkillSourceInput, RestoreAgentTemplateVersionInput, UpdateAgentTemplateInput,
} from "./agent.schemas";
import { extractKnowledgeText, type UploadedKnowledgeFile } from "../capabilities/document-extract";
import { createHash } from "crypto";
import { env } from "../../config/env";
import { getIamServiceAuthHeader } from "../../lib/iam/service-token";
import { isPlatformAdmin, requireCapabilityOwner, requirePlatformAdmin } from "../../lib/authz/platform-admin";
import {
  resolveLocalOrDocumentCapability,
  normalizeCapabilityPermissions,
  resolveProviderCapabilities,
  sortEffectiveCapabilities,
  summarizeProfileSources,
  type EffectiveCapability,
  type ProfileSkillForResolution,
  type ProviderResolution,
} from "./agent-profile-resolve";
import { validateProviderManifestEnvelope, verifyProviderManifestSignature } from "./agent-provider-manifest";
import { assertAgentSourceUrlAllowed } from "./agent-source-url-policy";
import {
  capabilityAgentTemplateKey,
  normalizedAgentTemplateName,
} from "../capabilities/capability-agent-template-identity";
import { sourceBackedKnowledgeArtifactKey } from "../capabilities/capability-knowledge-identity";
import {
  capabilityKnowledgeSourceKey,
  normalizedKnowledgeArtifactType,
  normalizedSourceValue,
} from "../capabilities/capability-source-identity";
import {
  dedupeProfileSkillBindings,
  findDuplicateUploadedFileName,
} from "./agent-profile-binding-identity";
import {
  agentSkillKey,
  normalizedAgentSkillIdentityValue,
} from "./agent-skill-identity";
import {
  agentSkillSourceKey,
  normalizedAgentSkillSourceValue,
} from "./agent-skill-source-identity";
import {
  agentTemplateSkillKey,
  normalizedAgentTemplateSkillValue,
} from "./agent-template-skill-identity";
import { requireActiveCapability } from "../capabilities/capability-lifecycle";
import { parseUpstreamJson, readUpstreamJsonObject } from "../../shared/upstream-json";

const AGENT_SOURCE_FETCH_TIMEOUT_MS = env.AGENT_SOURCE_FETCH_TIMEOUT_SEC * 1000;
const AGENT_CONTRACT_MINT_TIMEOUT_MS = env.AGENT_CONTRACT_MINT_TIMEOUT_SEC * 1000;

type TemplateSnapshotSource = {
  id: string;
  name: string;
  roleType: string;
  description?: string | null;
  instructions?: string | null;
  basePromptProfileId?: string | null;
  defaultToolPolicyId?: string | null;
  status: string;
  capabilityId?: string | null;
  baseTemplateId?: string | null;
  lockedReason?: string | null;
  version: number;
};

type AgentDbClient = typeof prisma | Prisma.TransactionClient;

async function assertAgentCapabilityWritable(
  client: AgentDbClient,
  capabilityId: string | null | undefined,
  message = "Capability is archived and cannot be modified.",
): Promise<void> {
  if (!capabilityId) return;
  const rows = await client.$queryRaw<Array<{ status: string }>>(Prisma.sql`
    SELECT status
    FROM "Capability"
    WHERE id = ${capabilityId}
    FOR UPDATE
  `);
  const capability = rows[0];
  if (!capability) throw new NotFoundError("Capability not found");
  if (capability.status === "ARCHIVED") throw new ForbiddenError(message);
}

async function assertAgentToolPolicyReference(
  client: AgentDbClient,
  input: {
    policyId?: string | null;
    capabilityId?: string | null;
    agentTemplateId?: string | null;
    context: string;
  },
): Promise<void> {
  if (!input.policyId) return;
  const rows = await client.$queryRaw<Array<{ status: string; scopeType: string | null; scopeId: string | null }>>(Prisma.sql`
    SELECT status, "scopeType" AS "scopeType", "scopeId" AS "scopeId"
    FROM "ToolPolicy"
    WHERE id = ${input.policyId}
    FOR UPDATE
  `);
  const policy = rows[0];
  if (!policy) throw new NotFoundError("Tool policy not found");
  if (policy.status !== "ACTIVE") {
    throw new ConflictError(`Tool policy is ${policy.status} and cannot be used as ${input.context}.`);
  }

  const scopeType = policy.scopeType?.trim().toUpperCase();
  if (!scopeType || !policy.scopeId) return;

  if (scopeType === "CAPABILITY") {
    if (!input.capabilityId || policy.scopeId !== input.capabilityId) {
      throw new ForbiddenError(`Tool policy scope belongs to another capability and cannot be used as ${input.context}.`);
    }
    return;
  }

  if (scopeType === "AGENT_TEMPLATE") {
    if (!input.agentTemplateId || policy.scopeId !== input.agentTemplateId) {
      throw new ForbiddenError(`Tool policy scope belongs to another agent template and cannot be used as ${input.context}.`);
    }
    return;
  }

  if (scopeType === "AGENT_BINDING") {
    throw new ForbiddenError(`Agent binding-scoped tool policy cannot be used as ${input.context}.`);
  }
}

async function findActiveCapabilityTemplateNameConflict(
  client: AgentDbClient,
  capabilityId: string,
  name: string,
  excludeId?: string,
): Promise<{ id: string; name: string } | null> {
  const normalizedName = normalizedAgentTemplateName(name);
  if (!capabilityId || !normalizedName) return null;
  const excludeClause = excludeId ? Prisma.sql`AND id <> ${excludeId}` : Prisma.empty;
  const rows = await client.$queryRaw<Array<{ id: string; name: string }>>(Prisma.sql`
    SELECT id, name
    FROM "AgentTemplate"
    WHERE "capabilityId" = ${capabilityId}
      AND status <> 'ARCHIVED'
      AND lower(btrim(name)) = lower(btrim(${normalizedName}))
      ${excludeClause}
    ORDER BY "updatedAt" DESC, "createdAt" DESC
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function lockCapabilityTemplateName(
  client: AgentDbClient,
  capabilityId: string,
  name: string,
): Promise<void> {
  const lockKey = capabilityAgentTemplateKey({ capabilityId, name });
  if (!lockKey) return;
  await client.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
}

async function assertNoActiveCapabilityTemplateNameConflict(
  client: AgentDbClient,
  input: { capabilityId?: string | null; name: string; excludeId?: string; label?: string },
): Promise<void> {
  if (!input.capabilityId) return;
  await lockCapabilityTemplateName(client, input.capabilityId, input.name);
  const existingByName = await findActiveCapabilityTemplateNameConflict(
    client,
    input.capabilityId,
    input.name,
    input.excludeId,
  );
  if (existingByName) {
    throw new ConflictError(
      `An ${input.label ?? "agent template"} named "${input.name}" already exists for this capability (id ${existingByName.id}).`,
    );
  }
}

function snapshotTemplate(template: TemplateSnapshotSource) {
  return {
    name: template.name,
    roleType: template.roleType,
    description: template.description ?? null,
    instructions: template.instructions ?? null,
    basePromptProfileId: template.basePromptProfileId ?? null,
    defaultToolPolicyId: template.defaultToolPolicyId ?? null,
    status: template.status,
    capabilityId: template.capabilityId ?? null,
    baseTemplateId: template.baseTemplateId ?? null,
    lockedReason: template.lockedReason ?? null,
    version: template.version,
  };
}

const CAPABILITY_PERMISSIONS = ["read", "invoke", "configure", "edit"] as const;
type CapabilityPermission = typeof CAPABILITY_PERMISSIONS[number];
const PERMISSION_SET = new Set<string>(CAPABILITY_PERMISSIONS);

function uniquePermissions(values: unknown, fallback: CapabilityPermission[]): CapabilityPermission[] {
  if (!Array.isArray(values)) return fallback;
  const out = values.filter((value): value is CapabilityPermission => typeof value === "string" && PERMISSION_SET.has(value));
  return out.length ? Array.from(new Set(out)) : fallback;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function defaultPermissionsFor(sourceType: string): CapabilityPermission[] {
  return sourceType === "local" ? ["read", "invoke"] : ["read"];
}

function normalizeBindingPermissions(binding: {
  sourceType: string;
  permissions?: CapabilityPermission[];
  readOnly?: boolean;
  providerLocked?: boolean;
}): { permissions: CapabilityPermission[]; readOnly: boolean; providerLocked: boolean } {
  const providerLocked = binding.sourceType === "url_document" || binding.sourceType === "uploaded_document"
    ? true
    : Boolean(binding.providerLocked);
  const external = binding.sourceType !== "local";
  const readOnly = binding.readOnly ?? external;
  let permissions = uniquePermissions(binding.permissions, defaultPermissionsFor(binding.sourceType));
  if (readOnly || providerLocked) permissions = permissions.filter((p) => p === "read");
  if (!permissions.includes("read")) permissions.unshift("read");
  return { permissions: Array.from(new Set(permissions)), readOnly, providerLocked };
}

function normalizeSourceRef(binding: { sourceType: string; sourceRef?: string; providerManifestUrl?: string; url?: string; fileName?: string }): string | undefined {
  return binding.sourceRef ?? binding.providerManifestUrl ?? binding.url ?? binding.fileName;
}

function shortHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36).slice(0, 8);
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function persistProfileUploadedArtifact(
  tx: Prisma.TransactionClient,
  input: {
    capabilityId: string;
    title: string;
    content: string;
    sourceRef: string;
  },
) {
  const capabilityId = normalizedSourceValue(input.capabilityId);
  const title = normalizedSourceValue(input.title);
  const sourceRef = normalizedSourceValue(input.sourceRef);
  const artifactType = "AGENT_SOURCE";
  const sourceType = "FILE_UPLOAD";
  const contentHash = sha256(input.content);
  const artifactKey = sourceBackedKnowledgeArtifactKey({
    capabilityId,
    artifactType,
    title,
    sourceType,
    sourceRef,
  });
  if (!artifactKey) throw new AppError("Uploaded document source identity is incomplete.", 400);

  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${artifactKey}))`;
  const existingRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "CapabilityKnowledgeArtifact"
    WHERE status = 'ACTIVE'
      AND "capabilityId" = ${capabilityId}
      AND lower(btrim("artifactType")) = lower(btrim(${artifactType}))
      AND lower(btrim(title)) = lower(btrim(${title}))
      AND lower(coalesce(nullif(btrim("sourceType"), ''), '')) = lower(${sourceType})
      AND lower(btrim("sourceRef")) = lower(btrim(${sourceRef}))
    ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
    LIMIT 1
  `);
  const existing = existingRows[0]
    ? await tx.capabilityKnowledgeArtifact.findUnique({ where: { id: existingRows[0].id } })
    : null;
  if (!existing) {
    return tx.capabilityKnowledgeArtifact.create({
      data: {
        capabilityId,
        artifactType,
        title,
        content: input.content,
        sourceType,
        sourceRef,
        confidence: 0.9,
        contentHash,
        status: "ACTIVE",
      },
    });
  }

  const contentChanged = existing.contentHash !== contentHash || existing.content !== input.content;
  const metadataChanged = existing.title !== title || existing.sourceRef !== sourceRef || existing.sourceType !== sourceType;
  if (!contentChanged && !metadataChanged) return existing;

  const updated = await tx.capabilityKnowledgeArtifact.update({
    where: { id: existing.id },
    data: {
      title,
      content: input.content,
      sourceType,
      sourceRef,
      confidence: 0.9,
      contentHash,
      ...(contentChanged ? { version: { increment: 1 } } : {}),
    },
  });
  if (contentChanged) {
    await tx.$executeRaw`UPDATE "CapabilityKnowledgeArtifact" SET embedding = NULL WHERE id = ${updated.id}`;
  }
  return updated;
}

async function persistProfileKnowledgeSource(
  tx: Prisma.TransactionClient,
  input: {
    capabilityId: string;
    url: string;
    artifactType?: string | null;
    title?: string | null;
  },
) {
  const capabilityId = normalizedSourceValue(input.capabilityId);
  const url = normalizedSourceValue(input.url);
  const artifactType = normalizedKnowledgeArtifactType(input.artifactType);
  const sourceKey = capabilityKnowledgeSourceKey({ capabilityId, url, artifactType });
  if (!sourceKey) throw new AppError("URL document source identity is incomplete.", 400);

  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${sourceKey}))`;
  const existingRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "CapabilityKnowledgeSource"
    WHERE status = 'ACTIVE'
      AND "capabilityId" = ${capabilityId}
      AND lower(btrim(url)) = lower(btrim(${url}))
      AND lower(btrim("artifactType")) = lower(btrim(${artifactType}))
    ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
    LIMIT 1
  `);
  const existing = existingRows[0]
    ? await tx.capabilityKnowledgeSource.findUnique({ where: { id: existingRows[0].id } })
    : null;
  if (!existing) {
    return tx.capabilityKnowledgeSource.create({
      data: {
        capabilityId,
        url,
        artifactType,
        title: input.title ?? undefined,
        pollIntervalSec: null,
        status: "ACTIVE",
      },
    });
  }

  const next: Prisma.CapabilityKnowledgeSourceUpdateInput = {};
  if (existing.url !== url) next.url = url;
  if (existing.artifactType !== artifactType) next.artifactType = artifactType;
  if (input.title !== undefined && existing.title !== input.title) next.title = input.title;
  if (existing.pollIntervalSec !== null) next.pollIntervalSec = null;
  if (Object.keys(next).length === 0) return existing;
  return tx.capabilityKnowledgeSource.update({ where: { id: existing.id }, data: next });
}

async function persistAgentSkill(
  client: AgentDbClient,
  input: {
    name: string;
    skillType: string;
    description?: string | null;
    promptLayerId?: string | null;
  },
) {
  const name = normalizedAgentSkillIdentityValue(input.name);
  const skillType = normalizedAgentSkillIdentityValue(input.skillType);
  const promptLayerId = normalizedAgentSkillIdentityValue(input.promptLayerId) || null;
  const skillKey = agentSkillKey({ name, skillType, promptLayerId });
  if (!skillKey) throw new AppError("Agent skill name and type are required.", 400, "AGENT_SKILL_IDENTITY_INVALID");

  await client.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${skillKey}))`;
  const existingRows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "AgentSkill"
    WHERE status = 'ACTIVE'
      AND lower(btrim(name)) = lower(btrim(${name}))
      AND lower(btrim("skillType")) = lower(btrim(${skillType}))
      AND lower(coalesce(nullif(btrim("promptLayerId"), ''), '')) = lower(${promptLayerId ?? ""})
    ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
    LIMIT 1
  `);
  const existing = existingRows[0]
    ? await client.agentSkill.findUnique({ where: { id: existingRows[0].id } })
    : null;
  if (!existing) {
    return client.agentSkill.create({
      data: {
        name,
        skillType,
        description: input.description ?? undefined,
        promptLayerId: promptLayerId ?? undefined,
        status: "ACTIVE",
      },
    });
  }

  const next: Prisma.AgentSkillUpdateInput = {};
  if (!existing.description && input.description) next.description = input.description;
  if (!existing.promptLayerId && promptLayerId) next.promptLayerId = promptLayerId;
  if (Object.keys(next).length === 0) return existing;
  return client.agentSkill.update({ where: { id: existing.id }, data: next });
}

async function persistAgentSkillSource(
  client: AgentDbClient,
  input: {
    skillId: string;
    sourceType: string;
    sourceRef?: string | null;
    capabilityId?: string | null;
    permissions: Prisma.InputJsonValue;
    readOnly: boolean;
    providerLocked: boolean;
    metadata?: Prisma.InputJsonValue;
  },
) {
  const skillId = normalizedAgentSkillSourceValue(input.skillId);
  const sourceType = normalizedAgentSkillSourceValue(input.sourceType);
  const sourceRef = normalizedAgentSkillSourceValue(input.sourceRef) || null;
  const capabilityId = normalizedAgentSkillSourceValue(input.capabilityId) || null;
  const sourceKey = agentSkillSourceKey({ skillId, sourceType, sourceRef, capabilityId });
  if (!sourceKey) throw new AppError("Agent skill source identity is incomplete.", 400, "AGENT_SKILL_SOURCE_IDENTITY_INVALID");

  await client.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${sourceKey}))`;
  const existingRows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "AgentSkillSource"
    WHERE status = 'ACTIVE'
      AND "skillId" = ${skillId}
      AND lower(btrim("sourceType")) = lower(btrim(${sourceType}))
      AND lower(coalesce(nullif(btrim("sourceRef"), ''), '')) = lower(${sourceRef ?? ""})
      AND lower(coalesce(nullif(btrim("capabilityId"), ''), '')) = lower(${capabilityId ?? ""})
    ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
    LIMIT 1
  `);
  const existing = existingRows[0]
    ? await client.agentSkillSource.findUnique({ where: { id: existingRows[0].id } })
    : null;
  const metadata = {
    ...objectValue(existing?.metadata),
    ...objectValue(input.metadata),
  } as Prisma.InputJsonValue;

  if (!existing) {
    return client.agentSkillSource.create({
      data: {
        skillId,
        sourceType,
        sourceRef,
        capabilityId,
        permissions: input.permissions,
        readOnly: input.readOnly,
        providerLocked: input.providerLocked,
        metadata,
        status: "ACTIVE",
      },
    });
  }

  return client.agentSkillSource.update({
    where: { id: existing.id },
    data: {
      permissions: input.permissions,
      readOnly: input.readOnly,
      providerLocked: input.providerLocked,
      metadata,
    },
  });
}

async function persistAgentTemplateSkill(
  client: AgentDbClient,
  input: {
    agentTemplateId: string;
    skillId: string;
    isDefault: boolean;
    sourceType: string;
    sourceRef?: string | null;
    capabilityId?: string | null;
    permissions: Prisma.InputJsonValue;
    readOnly: boolean;
    providerLocked: boolean;
    metadata?: Prisma.InputJsonValue;
  },
) {
  const agentTemplateId = normalizedAgentTemplateSkillValue(input.agentTemplateId);
  const skillId = normalizedAgentTemplateSkillValue(input.skillId);
  const sourceType = normalizedAgentTemplateSkillValue(input.sourceType);
  const sourceRef = normalizedAgentTemplateSkillValue(input.sourceRef) || null;
  const capabilityId = normalizedAgentTemplateSkillValue(input.capabilityId) || null;
  const linkKey = agentTemplateSkillKey({ agentTemplateId, skillId, sourceType, sourceRef, capabilityId });
  if (!linkKey) throw new AppError("Agent template skill binding identity is incomplete.", 400, "AGENT_TEMPLATE_SKILL_IDENTITY_INVALID");

  await client.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${linkKey}))`;
  const existingRows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "AgentTemplateSkill"
    WHERE "agentTemplateId" = ${agentTemplateId}
      AND "skillId" = ${skillId}
      AND lower(btrim("sourceType")) = lower(btrim(${sourceType}))
      AND lower(coalesce(nullif(btrim("sourceRef"), ''), '')) = lower(${sourceRef ?? ""})
      AND lower(coalesce(nullif(btrim("capabilityId"), ''), '')) = lower(${capabilityId ?? ""})
    ORDER BY "createdAt" DESC, id DESC
    LIMIT 1
  `);
  const existing = existingRows[0]
    ? await client.agentTemplateSkill.findUnique({ where: { id: existingRows[0].id } })
    : null;
  const metadata = {
    ...objectValue(existing?.metadata),
    ...objectValue(input.metadata),
  } as Prisma.InputJsonValue;

  if (!existing) {
    return client.agentTemplateSkill.create({
      data: {
        agentTemplateId,
        skillId,
        isDefault: input.isDefault,
        sourceType,
        sourceRef,
        capabilityId,
        permissions: input.permissions,
        readOnly: input.readOnly,
        providerLocked: input.providerLocked,
        metadata,
      },
    });
  }

  return client.agentTemplateSkill.update({
    where: { id: existing.id },
    data: {
      isDefault: input.isDefault,
      permissions: input.permissions,
      readOnly: input.readOnly,
      providerLocked: input.providerLocked,
      metadata,
    },
  });
}

async function fetchJsonWithTimeout(url: string): Promise<{
  manifest: Record<string, unknown>;
  manifestDigest: string;
  signatureKeyId: string | null;
  signedManifest: boolean;
}> {
  await assertAgentSourceUrlAllowed(url, { allowPrivateUrls: env.AGENT_SOURCE_ALLOW_PRIVATE_URLS });
  const res = await fetch(url, { signal: AbortSignal.timeout(AGENT_SOURCE_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new Error(`manifest must be JSON, got ${contentType || "unknown content-type"}`);
  }
  const text = await res.text();
  const signature = res.headers.get("x-manifest-signature");
  const signatureKeyId = res.headers.get("x-manifest-key-id")?.trim() || null;
  verifyProviderManifestSignature({
    body: text,
    signature,
    keyId: signatureKeyId,
    trustedKeys: env.PROVIDER_MANIFEST_TRUSTED_KEYS,
    mode: env.PROVIDER_MANIFEST_SIGNATURE_MODE,
    nodeEnv: env.NODE_ENV,
  });
  const body = parseUpstreamJson(text, "provider manifest", res.status);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("manifest body must be a JSON object");
  }
  const manifest = body as Record<string, unknown>;
  validateProviderManifestEnvelope({
    manifest,
    trustedKeys: env.PROVIDER_MANIFEST_TRUSTED_KEYS,
    mode: env.PROVIDER_MANIFEST_SIGNATURE_MODE,
    nodeEnv: env.NODE_ENV,
    maxTtlSeconds: env.PROVIDER_MANIFEST_MAX_TTL_SECONDS,
  });
  return {
    manifest,
    manifestDigest: sha256(text),
    signatureKeyId,
    signedManifest: Boolean(signature && signatureKeyId),
  };
}

async function previewProviderManifest(url: string) {
  const fetched = await fetchJsonWithTimeout(url);
  const manifest = fetched.manifest;
  const skills = Array.isArray(manifest.skills) ? manifest.skills as Array<Record<string, unknown>> : [];
  const capabilities = Array.isArray(manifest.capabilities)
    ? manifest.capabilities as Array<Record<string, unknown>>
    : skills.flatMap((skill) => Array.isArray(skill.capabilities) ? skill.capabilities as Array<Record<string, unknown>> : []);
  const providerConstraints = objectValue(manifest.constraints);
  const providerReadOnly = Boolean(providerConstraints.readOnly ?? providerConstraints.read_only);
  const providerLocked = Boolean(providerConstraints.providerLocked ?? providerConstraints.provider_locked);
  return {
    title: stringValue(manifest.name) ?? stringValue(manifest.provider) ?? "Provider skill",
    description: stringValue(manifest.description),
    sourceRef: url,
    sourceType: "provider_manifest",
    defaultPermissions: ["read"],
    readOnly: true,
    providerLocked,
    capabilities: capabilities.map((cap, index) => {
      const constraints = objectValue(cap.constraints);
      const readOnly = Boolean(constraints.readOnly ?? constraints.read_only ?? providerReadOnly);
      const capabilityProviderLocked = Boolean(constraints.providerLocked ?? constraints.provider_locked ?? providerLocked);
      const permissions = normalizeCapabilityPermissions(
        cap.permissions ?? cap.capability_permissions,
        ["read"],
        readOnly || capabilityProviderLocked,
      );
      const rawId = stringValue(cap.id) ?? stringValue(cap.capability_id) ?? stringValue(cap.name) ?? `capability-${index + 1}`;
      return {
        id: rawId,
        name: stringValue(cap.name) ?? rawId,
        description: stringValue(cap.description),
        permissions,
        defaultPermissions: ["read"],
        readOnly,
        providerLocked: capabilityProviderLocked,
        constraints: {
          readOnly,
          providerLocked: capabilityProviderLocked,
        },
        schema: cap.schema ?? cap.input_schema ?? cap.inputSchema,
        invocationEndpoint: stringValue(cap.endpoint) ?? stringValue(cap.invocation_endpoint),
      };
    }),
    manifestVersion: manifest.version ?? manifest.manifest_version ?? manifest.manifestVersion,
    manifestDigest: fetched.manifestDigest,
    signatureKeyId: fetched.signatureKeyId,
    signedManifest: fetched.signedManifest,
  };
}

async function ensureVersionSnapshot(
  tx: Prisma.TransactionClient,
  template: TemplateSnapshotSource,
  changeSummary: string,
  actor?: AuthUser,
) {
  return tx.agentTemplateVersion.upsert({
    where: {
      agentTemplateId_version: {
        agentTemplateId: template.id,
        version: template.version,
      },
    },
    create: {
      agentTemplateId: template.id,
      version: template.version,
      changeSummary,
      snapshot: snapshotTemplate(template),
      createdBy: actor?.user_id,
    },
    update: {},
  });
}

type ContractMintResult = { minted: true } | { minted: false; reason: string };

function contractMintRequiredForActiveTemplate(): boolean {
  return isProductionClassEnv(env.NODE_ENV) || process.env.AGENT_CONTRACT_MINT_REQUIRED === "true";
}

/**
 * Record a freshly-minted contract's pin on the template version row.
 *
 * The contract ALREADY exists in composer by the time this runs, so this step
 * is best-effort + idempotent: a transient DB blip must NOT be reported as a
 * mint failure (that would make the caller revert an activation whose contract
 * was already minted, and re-mint a duplicate on retry). Retries once, then
 * logs loudly and returns — the pin is recoverable (re-mint is an upsert, and
 * the contract is queryable from composer by templateId+version). Never throws.
 */
async function recordContractPin(
  template: TemplateSnapshotSource,
  contractId: string,
  contractHash: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await prisma.agentTemplateVersion.update({
        where: { agentTemplateId_version: { agentTemplateId: template.id, version: template.version } },
        data: { contractHash, contractId },
      });
      return;
    } catch (err) {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      // eslint-disable-next-line no-console
      console.error(
        `[agent-service] contract ${contractId} minted for ${template.id}@v${template.version} ` +
        `but recording its pin failed: ${(err as Error).message}. The contract exists in composer; ` +
        `the version-row pin is unset and should be reconciled.`,
      );
    }
  }
}

/**
 * M40 — Mint an ImmutableContract when a template transitions to ACTIVE.
 *
 * Local/dev runs can keep publishing during composer outages, but
 * production-class environments fail closed: an ACTIVE template version must
 * carry a contract pin for replay/audit determinism.
 */
async function maybeMintContract(template: TemplateSnapshotSource, actor?: AuthUser): Promise<ContractMintResult> {
  if (template.status !== "ACTIVE") return { minted: true };
  const composerUrl = (process.env.PROMPT_COMPOSER_URL ?? "http://prompt-composer:3004").replace(/\/$/, "");
  try {
    const authHeader = await getIamServiceAuthHeader();
    if (!authHeader && env.AUTH_OPTIONAL === false) {
      const reason = "no IAM service token available";
      console.warn(`[agent-service] contract mint skipped for ${template.id}@v${template.version}: ${reason}`);
      return { minted: false, reason };
    }
    const res = await fetch(`${composerUrl}/api/v1/contracts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authHeader ? { authorization: authHeader } : {}),
      },
      body: JSON.stringify({
        agentTemplateId: template.id,
        agentTemplateVersion: template.version,
        capabilityId: template.capabilityId ?? undefined,
        // Model alias not bound to template today; downstream can override
        // via the same endpoint when minting for a specific run context.
        capturedBy: actor?.user_id ?? null,
        capturedFrom: "agent-service:publish",
      }),
      signal: AbortSignal.timeout(AGENT_CONTRACT_MINT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const reason = `prompt-composer returned ${res.status}${body ? `: ${body.slice(0, 240)}` : ""}`;
      // eslint-disable-next-line no-console
      console.warn(`[agent-service] contract mint failed for ${template.id}@v${template.version}: ${reason}`);
      return { minted: false, reason };
    }
    const body = await readUpstreamJsonObject(res, "prompt-composer contract mint");
    if (body.success !== true) return { minted: false, reason: "prompt-composer returned success=false" };
    const data = objectValue(body.data);
    const contractId = stringValue(data.id);
    const bundleHash = stringValue(data.bundleHash) ?? stringValue(data.bundle_hash);
    if (!contractId || !bundleHash) {
      return { minted: false, reason: "prompt-composer returned malformed contract response" };
    }
    // The contract now EXISTS in composer. Recording its pin on the version row
    // is a SEPARATE, recoverable step — it must not flip a successful mint to
    // "failed" (that would revert the activation and re-mint a duplicate).
    await recordContractPin(template, contractId, bundleHash);
    return { minted: true };
  } catch (err) {
    const reason = (err as Error).message;
    // eslint-disable-next-line no-console
    console.warn(`[agent-service] contract mint error for ${template.id}@v${template.version}: ${reason}`);
    return { minted: false, reason };
  }
}

export const agentService = {
  async previewSkillSource(input: PreviewSkillSourceInput, file?: UploadedKnowledgeFile) {
    const sourceType = input.sourceType;
    if (sourceType === "provider_manifest") {
      const url = input.providerManifestUrl ?? input.sourceRef;
      if (!url) throw new Error("providerManifestUrl is required");
      return previewProviderManifest(url);
    }
    if (sourceType === "uploaded_document") {
      if (!file) {
        return {
          title: input.fileName ?? input.name ?? "Uploaded document",
          sourceType,
          sourceRef: input.sourceRef ?? input.fileName,
          defaultPermissions: ["read"],
          readOnly: true,
          providerLocked: true,
          capabilities: [],
        };
      }
      const text = await extractKnowledgeText(file);
      return {
        title: file.originalname,
        description: text.slice(0, 500),
        sourceType,
        sourceRef: file.originalname,
        defaultPermissions: ["read"],
        readOnly: true,
        providerLocked: true,
        capabilities: [],
      };
    }
    if (sourceType === "url_document") {
      const url = input.url ?? input.sourceRef;
      if (!url) throw new Error("url is required");
      await assertAgentSourceUrlAllowed(url, { allowPrivateUrls: env.AGENT_SOURCE_ALLOW_PRIVATE_URLS });
      let description: string | undefined;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(AGENT_SOURCE_FETCH_TIMEOUT_MS) });
        if (res.ok) description = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 500);
      } catch {
        description = undefined;
      }
      return {
        title: input.name ?? url,
        description,
        sourceType,
        sourceRef: url,
        defaultPermissions: ["read"],
        readOnly: true,
        providerLocked: true,
        capabilities: [],
      };
    }
    return {
      title: input.name ?? "Local skill",
      sourceType: "local",
      sourceRef: input.sourceRef,
      defaultPermissions: ["read", "invoke"],
      readOnly: false,
      providerLocked: false,
      capabilities: [],
    };
  },

  async createProfile(input: CreateAgentProfileInput, files: UploadedKnowledgeFile[] = [], actor?: AuthUser) {
    requireCapabilityOwner(actor, input.capabilityId, "Creating an agent profile");
    await requireActiveCapability(input.capabilityId, "Cannot create an agent profile for an archived capability");
    const duplicateUploadName = findDuplicateUploadedFileName(files);
    if (duplicateUploadName) {
      throw new ConflictError(
        `Uploaded source filename "${duplicateUploadName}" appears more than once. Rename one file before creating the agent profile.`,
      );
    }

    // No silent duplicates: active profile names are unique within capability,
    // matched case-insensitively after trimming. Archived rows remain history
    // and do not block recreating a profile name.
    const existingByName = await findActiveCapabilityTemplateNameConflict(prisma, input.capabilityId, input.name);
    if (existingByName) {
      throw new ConflictError(
        `An agent profile named "${input.name}" already exists for this capability (id ${existingByName.id}).`,
      );
    }

    const uploaded: Array<{ file: UploadedKnowledgeFile; content: string }> = [];
    for (const file of files) {
      const content = await extractKnowledgeText(file);
      if (!content) continue;
      uploaded.push({
        file,
        content: content.slice(0, 5_000_000),
      });
    }

    const bindings = [...input.skillBindings];
    const boundUploadedRefs = new Set(
      bindings
        .filter((binding) => binding.sourceType === "uploaded_document")
        .map((binding) => normalizeSourceRef(binding) ?? "")
        .filter(Boolean),
    );
    for (const upload of uploaded) {
      if (boundUploadedRefs.has(upload.file.originalname)) continue;
      bindings.push({
        sourceType: "uploaded_document",
        name: upload.file.originalname,
        description: "Read-only uploaded agent source document.",
        skillType: "DOCUMENT_SOURCE",
        sourceRef: upload.file.originalname,
        permissions: ["read"],
        readOnly: true,
        providerLocked: true,
        isDefault: true,
        metadata: {},
      });
    }

    const dedupedBindings = dedupeProfileSkillBindings(bindings);

    return prisma.$transaction(async (tx) => {
      await assertAgentCapabilityWritable(tx, input.capabilityId, "Cannot create an agent profile for an archived capability");
      await assertAgentToolPolicyReference(tx, {
        policyId: input.defaultToolPolicyId,
        capabilityId: input.capabilityId,
        context: "agent profile default tool policy",
      });
      await assertNoActiveCapabilityTemplateNameConflict(tx, {
        capabilityId: input.capabilityId,
        name: input.name,
        label: "agent profile",
      });
      const created = await tx.agentTemplate.create({
        data: {
          name: input.name,
          roleType: input.roleType,
          description: input.description,
          instructions: input.instructions,
          basePromptProfileId: input.basePromptProfileId,
          defaultToolPolicyId: input.defaultToolPolicyId,
          capabilityId: input.capabilityId,
          lockedReason: null,
          status: "DRAFT",
          createdBy: actor?.user_id,
        },
      });
      await ensureVersionSnapshot(tx, created, "Initial agent profile draft", actor);

      const uploadedArtifacts = new Map<string, { id: string; title: string; sourceRef: string }>();
      for (const upload of uploaded) {
        const artifact = await persistProfileUploadedArtifact(tx, {
          capabilityId: input.capabilityId,
          title: upload.file.originalname,
          content: upload.content,
          sourceRef: upload.file.originalname,
        });
        uploadedArtifacts.set(upload.file.originalname, { id: artifact.id, title: artifact.title, sourceRef: artifact.sourceRef ?? upload.file.originalname });
      }

      const permissionSummary: Array<Record<string, unknown>> = [];
      const skillLinks = [];

      for (const binding of dedupedBindings) {
        const sourceType = binding.sourceType;
        const sourceRef = normalizeSourceRef(binding);
        const normalized = normalizeBindingPermissions(binding);
        let sourceArtifact: Record<string, unknown> | undefined;

        if (sourceType === "url_document" && sourceRef) {
          const source = await persistProfileKnowledgeSource(tx, {
            capabilityId: input.capabilityId,
            url: sourceRef,
            artifactType: "AGENT_SOURCE",
            title: binding.name,
          });
          sourceArtifact = { kind: "knowledge_source", id: source.id, sourceRef };
        } else if (sourceType === "uploaded_document" && sourceRef && uploadedArtifacts.has(sourceRef)) {
          sourceArtifact = { kind: "knowledge_artifact", ...uploadedArtifacts.get(sourceRef) };
        }

        let skill;
        if (binding.skillId) {
          skill = await tx.agentSkill.findUnique({ where: { id: binding.skillId } });
          if (!skill) throw new NotFoundError(`Skill not found: ${binding.skillId}`);
        } else {
          const skillName = binding.name ?? (
            sourceType === "provider_manifest" ? `Provider skill ${shortHash(sourceRef ?? input.name)}` :
            sourceType === "url_document" ? `Document link ${shortHash(sourceRef ?? input.name)}` :
            sourceType === "uploaded_document" ? `Document ${sourceRef ?? shortHash(input.name)}` :
            `Local skill ${shortHash(input.name)}`
          );
          skill = await persistAgentSkill(tx, {
            name: skillName,
            skillType: binding.skillType ?? (
              sourceType === "provider_manifest" ? "PROVIDER_MANIFEST" :
              sourceType === "local" ? "LOCAL" :
              "DOCUMENT_SOURCE"
            ),
            description: binding.description,
            promptLayerId: binding.promptLayerId,
          });
        }

        let sourceId: string | undefined;
        if (sourceType !== "local" || sourceRef) {
          const source = await persistAgentSkillSource(tx, {
            skillId: skill.id,
            sourceType,
            sourceRef,
            capabilityId: input.capabilityId,
            permissions: normalized.permissions as Prisma.InputJsonValue,
            readOnly: normalized.readOnly,
            providerLocked: normalized.providerLocked,
            metadata: {
              ...(binding.metadata ?? {}),
              ...(sourceArtifact ? { sourceArtifact } : {}),
            } as Prisma.InputJsonValue,
          });
          sourceId = source.id;
        }

        const link = await persistAgentTemplateSkill(tx, {
          agentTemplateId: created.id,
          skillId: skill.id,
          isDefault: binding.isDefault ?? true,
          sourceType,
          sourceRef,
          capabilityId: input.capabilityId,
          permissions: normalized.permissions as Prisma.InputJsonValue,
          readOnly: normalized.readOnly,
          providerLocked: normalized.providerLocked,
          metadata: {
            ...(binding.metadata ?? {}),
            ...(sourceId ? { skillSourceId: sourceId } : {}),
            ...(sourceArtifact ? { sourceArtifact } : {}),
          } as Prisma.InputJsonValue,
        });
        skillLinks.push(link);
        permissionSummary.push({
          skillId: skill.id,
          skillName: skill.name,
          sourceType,
          sourceRef,
          permissions: normalized.permissions,
          readOnly: normalized.readOnly,
          providerLocked: normalized.providerLocked,
        });
      }

      const profile = await tx.agentTemplate.findUnique({
        where: { id: created.id },
        include: { skills: { include: { skill: true } } },
      });

      return {
        profile,
        template: profile,
        skillBindings: skillLinks,
        sourceArtifacts: Array.from(uploadedArtifacts.values()),
        effectivePermissions: permissionSummary,
      };
    });
  },

  async createTemplate(input: CreateAgentTemplateInput, actor?: AuthUser) {
    if (input.capabilityId) {
      requireCapabilityOwner(actor, input.capabilityId, "Creating a capability agent template");
      await requireActiveCapability(input.capabilityId, "Cannot create an agent template for an archived capability");
      const existingByName = await findActiveCapabilityTemplateNameConflict(prisma, input.capabilityId, input.name);
      if (existingByName) {
        throw new ConflictError(
          `An agent template named "${input.name}" already exists for this capability (id ${existingByName.id}).`,
        );
      }
    } else {
      requirePlatformAdmin(actor, "Creating a common agent template");
    }
    return prisma.$transaction(async (tx) => {
      if (input.capabilityId) {
        await assertAgentCapabilityWritable(tx, input.capabilityId, "Cannot create an agent template for an archived capability");
        await assertNoActiveCapabilityTemplateNameConflict(tx, {
          capabilityId: input.capabilityId,
          name: input.name,
        });
      }
      await assertAgentToolPolicyReference(tx, {
        policyId: input.defaultToolPolicyId,
        capabilityId: input.capabilityId ?? null,
        context: "agent template default tool policy",
      });
      const created = await tx.agentTemplate.create({
        data: { ...input, createdBy: actor?.user_id, status: "DRAFT" },
      });
      await ensureVersionSnapshot(tx, created, "Initial draft", actor);
      return created;
    });
  },

  async listTemplates(filter: {
    roleType?: string; status?: string;
    scope?: "common" | "capability" | "all";
    capabilityId?: string;
    page: number; limit: number;
  }) {
    const where: Record<string, unknown> = {};
    if (filter.roleType) where.roleType = filter.roleType;
    where.status = filter.status ?? { not: "ARCHIVED" };
    // M23 — scope filter for Agent Studio.
    //   common     ⟹ capabilityId IS NULL
    //   capability ⟹ capabilityId = <given>
    //   all (or omitted with capabilityId set) ⟹ common ∪ capabilityId rows
    if (filter.scope === "common") {
      where.capabilityId = null;
    } else if (filter.scope === "capability" && filter.capabilityId) {
      where.capabilityId = filter.capabilityId;
    } else if (filter.capabilityId) {
      where.OR = [{ capabilityId: null }, { capabilityId: filter.capabilityId }];
    }
    const [items, total] = await Promise.all([
      prisma.agentTemplate.findMany({
        where, skip: (filter.page - 1) * filter.limit, take: filter.limit,
        orderBy: [{ capabilityId: "asc" }, { createdAt: "desc" }],
        include: { skills: { include: { skill: true } } },
      }),
      prisma.agentTemplate.count({ where }),
    ]);
    return { items, total, page: filter.page, limit: filter.limit };
  },

  async getTemplate(id: string) {
    const template = await prisma.agentTemplate.findUnique({
      where: { id },
      include: { skills: { include: { skill: true } } },
    });
    if (!template) throw new NotFoundError("Agent template not found");
    return template;
  },

  async resolveProfile(id: string, actor?: AuthUser) {
    const template = await prisma.agentTemplate.findUnique({
      where: { id },
      include: { skills: { include: { skill: true }, orderBy: { createdAt: "asc" } } },
    });
    if (!template) throw new NotFoundError("Agent profile not found");
    if (!template.capabilityId) {
      requirePlatformAdmin(actor, "Resolving a common agent profile");
    } else {
      requireCapabilityOwner(actor, template.capabilityId, "Resolving an agent profile");
    }

    const capabilities: EffectiveCapability[] = [];
    const providerResolutions: ProviderResolution[] = [];

    for (const link of template.skills) {
      if (!link.isDefault) continue;
      const binding: ProfileSkillForResolution = {
        skillId: link.skillId,
        skillName: link.skill.name,
        skillType: link.skill.skillType,
        sourceType: link.sourceType,
        sourceRef: link.sourceRef,
        capabilityId: link.capabilityId,
        permissions: link.permissions,
        readOnly: link.readOnly,
        providerLocked: link.providerLocked,
        metadata: link.metadata,
      };

      if (binding.sourceType === "provider_manifest") {
        if (!binding.sourceRef) {
          providerResolutions.push({
            sourceRef: "",
            status: "failed_closed",
            error: "provider_manifest binding has no sourceRef",
            capabilityCount: 0,
          });
          continue;
        }
        try {
          const fetched = await fetchJsonWithTimeout(binding.sourceRef);
          const resolved = resolveProviderCapabilities(binding, fetched.manifest, {
            manifestDigest: fetched.manifestDigest,
            signatureKeyId: fetched.signatureKeyId,
            signedManifest: fetched.signedManifest,
          });
          capabilities.push(...resolved.capabilities);
          providerResolutions.push(resolved.provider);
        } catch (err) {
          providerResolutions.push({
            sourceRef: binding.sourceRef,
            status: "failed_closed",
            error: (err as Error).message,
            capabilityCount: 0,
          });
        }
        continue;
      }

      capabilities.push(resolveLocalOrDocumentCapability(binding));
    }

    const effectiveCapabilities = sortEffectiveCapabilities(capabilities);
    const snapshotBasis = {
      profileId: template.id,
      profileVersion: template.version,
      skillBindings: template.skills
        .filter((link) => link.isDefault)
        .map((link) => ({
          skillId: link.skillId,
          sourceType: link.sourceType,
          sourceRef: link.sourceRef,
          permissions: link.permissions,
          readOnly: link.readOnly,
          providerLocked: link.providerLocked,
          metadata: link.metadata,
        })),
      providerResolutions,
      effectiveCapabilities,
    };

    return {
      profile: {
        id: template.id,
        name: template.name,
        roleType: template.roleType,
        description: template.description,
        instructions: template.instructions,
        capabilityId: template.capabilityId,
        status: template.status,
        version: template.version,
      },
      resolvedAt: new Date().toISOString(),
      snapshotHash: sha256(JSON.stringify(snapshotBasis)),
      effectiveCapabilities,
      providerResolutions,
      summary: {
        totalCapabilities: effectiveCapabilities.length,
        readOnlyCapabilities: effectiveCapabilities.filter((capability) => capability.readOnly).length,
        invokableCapabilities: effectiveCapabilities.filter((capability) => capability.permissions.includes("invoke")).length,
        failedProviders: providerResolutions.filter((provider) => provider.status === "failed_closed").length,
      },
    };
  },

  async getProfileSources(id: string, actor?: AuthUser) {
    const template = await prisma.agentTemplate.findUnique({
      where: { id },
      include: { skills: { include: { skill: true }, orderBy: { createdAt: "asc" } } },
    });
    if (!template) throw new NotFoundError("Agent profile not found");
    if (!template.capabilityId) {
      requirePlatformAdmin(actor, "Inspecting common agent profile sources");
    } else {
      requireCapabilityOwner(actor, template.capabilityId, "Inspecting agent profile sources");
    }

    const bindings = template.skills.map((link) => ({
      bindingId: link.id,
      skillId: link.skillId,
      skillName: link.skill.name,
      skillType: link.skill.skillType,
      sourceType: link.sourceType,
      sourceRef: link.sourceRef,
      capabilityId: link.capabilityId,
      permissions: link.permissions,
      readOnly: link.readOnly,
      providerLocked: link.providerLocked,
      metadata: link.metadata,
    }));
    const governance = summarizeProfileSources(bindings);
    return {
      profile: {
        id: template.id,
        name: template.name,
        roleType: template.roleType,
        capabilityId: template.capabilityId,
        status: template.status,
        version: template.version,
      },
      inspectedAt: new Date().toISOString(),
      ...governance,
    };
  },

  // M23 — derive a capability-scoped child template. Carries the base
  // template's prompt profile + role + tool policy by default; caller can
  // override `name`, `description`, and `basePromptProfileId`.
  async deriveTemplate(baseId: string, input: DeriveAgentTemplateInput, actor?: AuthUser) {
    requireCapabilityOwner(actor, input.capabilityId, "Deriving an agent template");

    await requireActiveCapability(input.capabilityId, "Cannot derive an agent template for an archived capability");

    const base = await prisma.agentTemplate.findUnique({ where: { id: baseId } });
    if (!base) throw new NotFoundError("Base agent template not found");
    if (base.capabilityId && base.capabilityId !== input.capabilityId && !isPlatformAdmin(actor)) {
      throw new ForbiddenError("Cannot derive from another capability's agent template");
    }
    const derivedName = input.name ?? `${base.name} (${input.capabilityId.slice(0, 8)})`;
    const existingByName = await findActiveCapabilityTemplateNameConflict(prisma, input.capabilityId, derivedName);
    if (existingByName) {
      throw new ConflictError(
        `An agent template named "${derivedName}" already exists for this capability (id ${existingByName.id}).`,
      );
    }

    const derived = await prisma.$transaction(async (tx) => {
      await assertAgentCapabilityWritable(tx, input.capabilityId, "Cannot derive an agent template for an archived capability");
      await assertAgentToolPolicyReference(tx, {
        policyId: base.defaultToolPolicyId,
        capabilityId: input.capabilityId,
        context: "derived agent template default tool policy",
      });
      await assertNoActiveCapabilityTemplateNameConflict(tx, {
        capabilityId: input.capabilityId,
        name: derivedName,
      });
      const created = await tx.agentTemplate.create({
        data: {
          name: derivedName,
          description: input.description ?? base.description ?? undefined,
          instructions: base.instructions ?? undefined,
          roleType: base.roleType,
          basePromptProfileId: input.basePromptProfileId ?? base.basePromptProfileId ?? undefined,
          defaultToolPolicyId: base.defaultToolPolicyId ?? undefined,
          capabilityId: input.capabilityId,
          baseTemplateId: base.id,
          // Derived templates are editable by capability owners — no lock.
          lockedReason: null,
          status: "DRAFT",
          createdBy: actor?.user_id,
        },
        include: { skills: { include: { skill: true } } },
      });
      await ensureVersionSnapshot(tx, created, `Derived from ${base.id}`, actor);
      return created;
    });
    return derived;
  },

  // M23 — patch a template. Common (locked) templates reject patches unless
  // the caller is platform-admin.
  async updateTemplate(id: string, patch: UpdateAgentTemplateInput, actor?: AuthUser) {
    const existing = await prisma.agentTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Agent template not found");
    if (existing.lockedReason && !isPlatformAdmin(actor)) {
      throw new ForbiddenError(`Editing locked agent template requires platform admin access: ${existing.lockedReason}`);
    }
    if (!existing.capabilityId) {
      requirePlatformAdmin(actor, existing.lockedReason ? `Editing locked common template (${existing.lockedReason})` : "Editing common template");
    } else {
      requireCapabilityOwner(actor, existing.capabilityId, "Editing a capability agent template");
    }
    const { changeSummary, ...data } = patch;
    const nextStatus = data.status ?? existing.status;
    const nextName = data.name ?? existing.name;
    if (existing.capabilityId && nextStatus !== "ARCHIVED") {
      await requireActiveCapability(existing.capabilityId, "Cannot edit an agent template for an archived capability");
      const existingByName = await findActiveCapabilityTemplateNameConflict(prisma, existing.capabilityId, nextName, id);
      if (existingByName) {
        throw new ConflictError(
          `An agent template named "${nextName}" already exists for this capability (id ${existingByName.id}).`,
        );
      }
    }
    const result = await prisma.$transaction(async (tx) => {
      if (existing.capabilityId && nextStatus !== "ARCHIVED") {
        await assertAgentCapabilityWritable(tx, existing.capabilityId, "Cannot edit an agent template for an archived capability");
        await assertNoActiveCapabilityTemplateNameConflict(tx, {
          capabilityId: existing.capabilityId,
          name: nextName,
          excludeId: id,
        });
      }
      if (data.defaultToolPolicyId !== undefined && nextStatus !== "ARCHIVED") {
        await assertAgentToolPolicyReference(tx, {
          policyId: data.defaultToolPolicyId,
          capabilityId: existing.capabilityId ?? null,
          agentTemplateId: existing.id,
          context: "agent template default tool policy",
        });
      }
      await ensureVersionSnapshot(tx, existing, "Baseline before versioned edit", actor);
      const updated = await tx.agentTemplate.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
        include: { skills: { include: { skill: true } } },
      });
      await ensureVersionSnapshot(tx, updated, changeSummary ?? `Updated ${Object.keys(data).join(", ") || "metadata"}`, actor);
      return updated;
    });
    // M40 — when the update transitions to ACTIVE, mint an ImmutableContract
    // from the current prompts + tools + model resolution. This HTTP call
    // must happen after the DB transaction commits so composer can read the
    // saved template version. Production-class environments compensate on
    // failure by reverting the template status and returning an error.
    const mintResult = await maybeMintContract(result, actor);
    if (!mintResult.minted && result.status === "ACTIVE" && contractMintRequiredForActiveTemplate()) {
      await prisma.agentTemplate.update({
        where: { id: result.id },
        data: { status: existing.status },
      });
      throw new AppError(
        `Agent template activation requires an ImmutableContract, but contract minting failed: ${mintResult.reason}`,
        503,
        "CONTRACT_MINT_REQUIRED",
      );
    }
    return result;
  },

  async listTemplateVersions(id: string) {
    const template = await prisma.agentTemplate.findUnique({ where: { id }, select: { id: true } });
    if (!template) throw new NotFoundError("Agent template not found");
    return prisma.agentTemplateVersion.findMany({
      where: { agentTemplateId: id },
      orderBy: { version: "desc" },
    });
  },

  async restoreTemplateVersion(
    id: string,
    version: number,
    input: RestoreAgentTemplateVersionInput,
    actor?: AuthUser,
  ) {
    const existing = await prisma.agentTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Agent template not found");
    if (existing.lockedReason && !isPlatformAdmin(actor)) {
      throw new ForbiddenError(`Restoring locked agent template requires platform admin access: ${existing.lockedReason}`);
    }
    if (!existing.capabilityId) {
      requirePlatformAdmin(actor, existing.lockedReason ? `Restoring locked common template (${existing.lockedReason})` : "Restoring common template");
    } else {
      requireCapabilityOwner(actor, existing.capabilityId, "Restoring a capability agent template");
    }
    const target = await prisma.agentTemplateVersion.findUnique({
      where: { agentTemplateId_version: { agentTemplateId: id, version } },
    });
    if (!target) throw new NotFoundError("Agent template version not found");

    const snapshot = target.snapshot as Partial<TemplateSnapshotSource>;
    if (!snapshot.name || !snapshot.roleType || !snapshot.status) {
      throw new AppError("Agent template version snapshot is incomplete and cannot be restored.", 409, "TEMPLATE_VERSION_INVALID");
    }
    const restoredName = snapshot.name;
    const restoredCapabilityId = snapshot.capabilityId ?? null;
    if (restoredCapabilityId !== (existing.capabilityId ?? null)) {
      throw new AppError(
        "Agent template version snapshot belongs to a different scope and cannot be restored onto this template.",
        409,
        "TEMPLATE_VERSION_SCOPE_MISMATCH",
      );
    }
    if ((snapshot.baseTemplateId ?? null) !== (existing.baseTemplateId ?? null)) {
      throw new AppError(
        "Agent template version snapshot has different template lineage and cannot be restored onto this template.",
        409,
        "TEMPLATE_VERSION_LINEAGE_MISMATCH",
      );
    }
    const restoredStatus = snapshot.status as EntityStatus;
    if (restoredCapabilityId && restoredStatus !== "ARCHIVED") {
      await requireActiveCapability(restoredCapabilityId, "Cannot restore an agent template for an archived capability");
      const existingByName = await findActiveCapabilityTemplateNameConflict(prisma, restoredCapabilityId, restoredName, id);
      if (existingByName) {
        throw new ConflictError(
          `Restoring this version would duplicate active agent template "${restoredName}" in capability ${restoredCapabilityId} (id ${existingByName.id}).`,
        );
      }
    }
    const restoredResult = await prisma.$transaction(async (tx) => {
      if (restoredCapabilityId && restoredStatus !== "ARCHIVED") {
        await assertAgentCapabilityWritable(tx, restoredCapabilityId, "Cannot restore an agent template for an archived capability");
        await assertNoActiveCapabilityTemplateNameConflict(tx, {
          capabilityId: restoredCapabilityId,
          name: restoredName,
          excludeId: id,
        });
      }
      if (snapshot.defaultToolPolicyId && restoredStatus !== "ARCHIVED") {
        await assertAgentToolPolicyReference(tx, {
          policyId: snapshot.defaultToolPolicyId,
          capabilityId: existing.capabilityId ?? null,
          agentTemplateId: existing.id,
          context: "restored agent template default tool policy",
        });
      }
      await ensureVersionSnapshot(tx, existing, "Baseline before restore", actor);
      const restored = await tx.agentTemplate.update({
        where: { id },
        data: {
          name: restoredName,
          roleType: snapshot.roleType as AgentRoleType,
          description: snapshot.description ?? null,
          instructions: snapshot.instructions ?? null,
          basePromptProfileId: snapshot.basePromptProfileId ?? null,
          defaultToolPolicyId: snapshot.defaultToolPolicyId ?? null,
          status: snapshot.status as EntityStatus,
          capabilityId: existing.capabilityId ?? null,
          baseTemplateId: existing.baseTemplateId ?? null,
          lockedReason: snapshot.lockedReason ?? null,
          version: { increment: 1 },
        },
        include: { skills: { include: { skill: true } } },
      });
      await ensureVersionSnapshot(tx, restored, input.changeSummary ?? `Restored from version ${version}`, actor);
      return restored;
    });
    const mintResult = await maybeMintContract(restoredResult, actor);
    if (!mintResult.minted && restoredResult.status === "ACTIVE" && contractMintRequiredForActiveTemplate()) {
      await prisma.agentTemplate.update({
        where: { id: restoredResult.id },
        data: { status: existing.status },
      });
      throw new AppError(
        `Agent template restore requires an ImmutableContract for ACTIVE status, but contract minting failed: ${mintResult.reason}`,
        503,
        "CONTRACT_MINT_REQUIRED",
      );
    }
    return restoredResult;
  },

  async createSkill(input: { name: string; skillType: string; description?: string; promptLayerId?: string }, actor?: AuthUser) {
    requirePlatformAdmin(actor, "Creating an agent skill");
    return prisma.$transaction((tx) => persistAgentSkill(tx, input));
  },

  async listSkills() {
    return prisma.agentSkill.findMany({
      where: { status: "ACTIVE" },
      orderBy: [{ name: "asc" }, { skillType: "asc" }],
    });
  },

  async attachSkill(agentTemplateId: string, skillId: string, isDefault: boolean, actor?: AuthUser) {
    const template = await this.getTemplate(agentTemplateId);
    if (!template.capabilityId) {
      requirePlatformAdmin(actor, "Attaching a skill to a common template");
    } else {
      requireCapabilityOwner(actor, template.capabilityId, "Attaching a skill to a capability template");
      await requireActiveCapability(template.capabilityId, "Cannot attach a skill to an archived capability template");
    }
    const skill = await prisma.agentSkill.findUnique({ where: { id: skillId } });
    if (!skill) throw new NotFoundError("Skill not found");
    return prisma.$transaction(async (tx) => {
      await assertAgentCapabilityWritable(tx, template.capabilityId, "Cannot attach a skill to an archived capability template");
      return persistAgentTemplateSkill(tx, {
        agentTemplateId,
        skillId,
        isDefault,
        sourceType: "local",
        sourceRef: null,
        capabilityId: template.capabilityId ?? null,
        permissions: ["read", "invoke"] as Prisma.InputJsonValue,
        readOnly: false,
        providerLocked: false,
        metadata: {},
      });
    });
  },
};
