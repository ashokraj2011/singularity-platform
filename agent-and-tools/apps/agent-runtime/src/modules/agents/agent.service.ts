import { prisma } from "../../config/prisma";
import type { AgentRoleType, EntityStatus, Prisma } from "../../../generated/prisma-client";
import { ForbiddenError, NotFoundError } from "../../shared/errors";
import type { AuthUser } from "../../middleware/auth.middleware";
import {
  CreateAgentTemplateInput, DeriveAgentTemplateInput, RestoreAgentTemplateVersionInput, UpdateAgentTemplateInput,
} from "./agent.schemas";

type TemplateSnapshotSource = {
  id: string;
  name: string;
  roleType: string;
  description?: string | null;
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
    basePromptProfileId: template.basePromptProfileId ?? null,
    defaultToolPolicyId: template.defaultToolPolicyId ?? null,
    status: template.status,
    capabilityId: template.capabilityId ?? null,
    baseTemplateId: template.baseTemplateId ?? null,
    lockedReason: template.lockedReason ?? null,
    version: template.version,
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

export const agentService = {
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
    return prisma.$transaction(async (tx) => {
      await ensureVersionSnapshot(tx, existing, "Baseline before versioned edit", actor);
      const updated = await tx.agentTemplate.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
        include: { skills: { include: { skill: true } } },
      });
      await ensureVersionSnapshot(tx, updated, changeSummary ?? `Updated ${Object.keys(data).join(", ") || "metadata"}`, actor);
      return updated;
    });
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
