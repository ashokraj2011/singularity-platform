import { prisma } from "../../config/prisma";
import type { AgentRoleType, EntityStatus, Prisma } from "../../../generated/prisma-client";
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
import {
  resolveLocalOrDocumentCapability,
  resolveProviderCapabilities,
  sortEffectiveCapabilities,
  summarizeProfileSources,
  type EffectiveCapability,
  type ProfileSkillForResolution,
  type ProviderResolution,
} from "./agent-profile-resolve";
import { validateProviderManifestEnvelope, verifyProviderManifestSignature } from "./agent-provider-manifest";
import { assertAgentSourceUrlAllowed } from "./agent-source-url-policy";

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

function rolesOf(actor: AuthUser | undefined): string[] {
  return (actor?.roles ?? []).map((r) => r.toLowerCase());
}

function isPlatformAdmin(actor: AuthUser | undefined): boolean {
  const roles = rolesOf(actor);
  return Boolean(
    actor?.is_platform_admin ||
    actor?.is_super_admin ||
    roles.includes("platform-admin") ||
    roles.includes("super-admin"),
  );
}

function canManageCapability(actor: AuthUser | undefined, capabilityId: string): boolean {
  if (isPlatformAdmin(actor)) return true;
  if (actor?.capability_ids?.includes(capabilityId)) return true;
  const roles = rolesOf(actor);
  return roles.includes(`capability-owner:${capabilityId}`) || roles.includes(`owner:${capabilityId}`);
}

function requirePlatformAdmin(actor: AuthUser | undefined, action: string): void {
  if (!isPlatformAdmin(actor)) {
    throw new ForbiddenError(`${action} requires platform admin access`);
  }
}

function requireCapabilityOwner(actor: AuthUser | undefined, capabilityId: string, action: string): void {
  if (!canManageCapability(actor, capabilityId)) {
    throw new ForbiddenError(`${action} requires ownership of capability ${capabilityId}`);
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

async function fetchJsonWithTimeout(url: string): Promise<{
  manifest: Record<string, unknown>;
  manifestDigest: string;
  signatureKeyId: string | null;
  signedManifest: boolean;
}> {
  await assertAgentSourceUrlAllowed(url, { allowPrivateUrls: env.AGENT_SOURCE_ALLOW_PRIVATE_URLS });
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
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
  const body = JSON.parse(text);
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
      const permissions = uniquePermissions(cap.permissions ?? cap.capability_permissions, ["read"]);
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
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const reason = `prompt-composer returned ${res.status}${body ? `: ${body.slice(0, 240)}` : ""}`;
      // eslint-disable-next-line no-console
      console.warn(`[agent-service] contract mint failed for ${template.id}@v${template.version}: ${reason}`);
      return { minted: false, reason };
    }
    const body = await res.json() as { success: boolean; data: { id: string; bundleHash: string } };
    if (!body.success) return { minted: false, reason: "prompt-composer returned success=false" };
    // Record the contract on the version row (best-effort — UPDATE outside tx).
    await prisma.agentTemplateVersion.update({
      where: { agentTemplateId_version: { agentTemplateId: template.id, version: template.version } },
      data: { contractHash: body.data.bundleHash, contractId: body.data.id },
    });
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
        const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
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
    const cap = await prisma.capability.findUnique({ where: { id: input.capabilityId }, select: { id: true, status: true } });
    if (!cap) throw new NotFoundError("Capability not found");
    if (cap.status === "ARCHIVED") throw new ForbiddenError("Cannot create an agent profile for an archived capability");

    // [P0] No silent duplicates: a profile name is unique within its capability
    // (backed by AgentTemplate @@unique([capabilityId, name])). Common-library
    // templates (null capabilityId) are exempt. Re-creating after ARCHIVE is allowed.
    const existingByName = await prisma.agentTemplate.findFirst({
      where: { capabilityId: input.capabilityId, name: input.name, status: { not: "ARCHIVED" } },
      select: { id: true },
    });
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

    return prisma.$transaction(async (tx) => {
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
        const artifact = await tx.capabilityKnowledgeArtifact.create({
          data: {
            capabilityId: input.capabilityId,
            artifactType: "AGENT_SOURCE",
            title: upload.file.originalname,
            content: upload.content,
            sourceType: "FILE_UPLOAD",
            sourceRef: upload.file.originalname,
            confidence: 0.9,
            contentHash: sha256(upload.content),
            status: "ACTIVE",
          },
        });
        uploadedArtifacts.set(upload.file.originalname, { id: artifact.id, title: artifact.title, sourceRef: artifact.sourceRef ?? upload.file.originalname });
      }

      const permissionSummary: Array<Record<string, unknown>> = [];
      const skillLinks = [];

      for (const binding of bindings) {
        const sourceType = binding.sourceType;
        const sourceRef = normalizeSourceRef(binding);
        const normalized = normalizeBindingPermissions(binding);
        let sourceArtifact: Record<string, unknown> | undefined;

        if (sourceType === "url_document" && sourceRef) {
          const source = await tx.capabilityKnowledgeSource.create({
            data: {
              capabilityId: input.capabilityId,
              url: sourceRef,
              artifactType: "AGENT_SOURCE",
              title: binding.name,
              pollIntervalSec: null,
              status: "ACTIVE",
            },
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
          skill = await tx.agentSkill.create({
            data: {
              name: skillName,
              skillType: binding.skillType ?? (
                sourceType === "provider_manifest" ? "PROVIDER_MANIFEST" :
                sourceType === "local" ? "LOCAL" :
                "DOCUMENT_SOURCE"
              ),
              description: binding.description,
              promptLayerId: binding.promptLayerId,
              status: "ACTIVE",
            },
          });
        }

        let sourceId: string | undefined;
        if (sourceType !== "local" || sourceRef) {
          const source = await tx.agentSkillSource.create({
            data: {
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
              status: "ACTIVE",
            },
          });
          sourceId = source.id;
        }

        const link = await tx.agentTemplateSkill.upsert({
          where: { agentTemplateId_skillId: { agentTemplateId: created.id, skillId: skill.id } },
          create: {
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
          },
          update: {
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
          },
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
      const cap = await prisma.capability.findUnique({ where: { id: input.capabilityId }, select: { id: true } });
      if (!cap) throw new NotFoundError("Capability not found");
    } else {
      requirePlatformAdmin(actor, "Creating a common agent template");
    }
    return prisma.$transaction(async (tx) => {
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
    if (filter.status) where.status = filter.status;
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

    const targetCapability = await prisma.capability.findUnique({ where: { id: input.capabilityId }, select: { id: true } });
    if (!targetCapability) throw new NotFoundError("Capability not found");

    const base = await prisma.agentTemplate.findUnique({ where: { id: baseId } });
    if (!base) throw new NotFoundError("Base agent template not found");
    if (base.capabilityId && base.capabilityId !== input.capabilityId && !isPlatformAdmin(actor)) {
      throw new ForbiddenError("Cannot derive from another capability's agent template");
    }

    const derived = await prisma.$transaction(async (tx) => {
      const created = await tx.agentTemplate.create({
        data: {
          name: input.name ?? `${base.name} (${input.capabilityId.slice(0, 8)})`,
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
    const result = await prisma.$transaction(async (tx) => {
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
    return prisma.$transaction(async (tx) => {
      await ensureVersionSnapshot(tx, existing, "Baseline before restore", actor);
      const restored = await tx.agentTemplate.update({
        where: { id },
        data: {
          name: snapshot.name,
          roleType: snapshot.roleType as AgentRoleType,
          description: snapshot.description ?? null,
          instructions: snapshot.instructions ?? null,
          basePromptProfileId: snapshot.basePromptProfileId ?? null,
          defaultToolPolicyId: snapshot.defaultToolPolicyId ?? null,
          status: snapshot.status as EntityStatus,
          capabilityId: snapshot.capabilityId ?? null,
          baseTemplateId: snapshot.baseTemplateId ?? null,
          lockedReason: snapshot.lockedReason ?? null,
          version: { increment: 1 },
        },
        include: { skills: { include: { skill: true } } },
      });
      await ensureVersionSnapshot(tx, restored, input.changeSummary ?? `Restored from version ${version}`, actor);
      return restored;
    });
  },

  async createSkill(input: { name: string; skillType: string; description?: string; promptLayerId?: string }, actor?: AuthUser) {
    requirePlatformAdmin(actor, "Creating an agent skill");
    return prisma.agentSkill.create({ data: { ...input, status: "ACTIVE" } });
  },

  async listSkills() {
    return prisma.agentSkill.findMany({ orderBy: { createdAt: "desc" } });
  },

  async attachSkill(agentTemplateId: string, skillId: string, isDefault: boolean, actor?: AuthUser) {
    const template = await this.getTemplate(agentTemplateId);
    if (!template.capabilityId) {
      requirePlatformAdmin(actor, "Attaching a skill to a common template");
    } else {
      requireCapabilityOwner(actor, template.capabilityId, "Attaching a skill to a capability template");
    }
    const skill = await prisma.agentSkill.findUnique({ where: { id: skillId } });
    if (!skill) throw new NotFoundError("Skill not found");
    return prisma.agentTemplateSkill.upsert({
      where: { agentTemplateId_skillId: { agentTemplateId, skillId } },
      create: { agentTemplateId, skillId, isDefault },
      update: { isDefault },
    });
  },
};
