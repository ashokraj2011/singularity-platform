import { Request, Response } from "express";
import { agentService } from "./agent.service";
import { ok } from "../../shared/response";
import { publishEvent } from "../../lib/eventbus/publisher";
import { emitAuditEvent } from "../../lib/audit-gov-emit";
import { prisma } from "../../config/prisma";
import type { AuthUser } from "../../middleware/auth.middleware";

function canEditTemplate(template: { capabilityId?: string | null; lockedReason?: string | null }, user?: AuthUser): boolean {
  const roles = (user?.roles ?? []).map((r) => r.toLowerCase());
  const platformAdmin = Boolean(
    user?.is_platform_admin ||
    user?.is_super_admin ||
    roles.includes("platform-admin") ||
    roles.includes("super-admin"),
  );
  if (!template.capabilityId) return platformAdmin;
  return platformAdmin || Boolean(user?.capability_ids?.includes(template.capabilityId));
}

function shapeTemplate<T extends { capabilityId?: string | null; lockedReason?: string | null }>(template: T, user?: AuthUser): T & {
  scope: "common" | "capability";
  editable: boolean;
} {
  return {
    ...template,
    scope: template.capabilityId ? "capability" : "common",
    editable: canEditTemplate(template, user),
  };
}

export const agentController = {
  async createTemplate(req: Request, res: Response) {
    const t = await agentService.createTemplate(req.body, req.user);
    // M11.e — emit canonical event so workgraph etc. can react
    void publishEvent(prisma, {
      eventName: "agent.template.created",
      envelope: {
        source_service: "agent-runtime",
        subject: { kind: "agent_template", id: (t as { id: string }).id },
        actor:   req.user?.user_id ? { kind: "user", id: req.user.user_id } : null,
        status:  "emitted",
        started_at: new Date().toISOString(),
        payload: {
          name:     (t as { name?: string }).name,
          roleType: (t as { roleType?: string }).roleType,
          version:  (t as { version?: number }).version,
        },
      },
    }).catch((err) => console.warn("[eventbus] publishEvent failed:", (err as Error).message));
    return ok(res, shapeTemplate(t, req.user), 201);
  },

  async listTemplates(req: Request, res: Response) {
    const result = await agentService.listTemplates(req.query as never);
    return ok(res, { ...result, items: result.items.map((t) => shapeTemplate(t, req.user)) });
  },

  async getTemplate(req: Request, res: Response) {
    const t = await agentService.getTemplate(req.params.id);
    return ok(res, shapeTemplate(t, req.user));
  },

  async deriveTemplate(req: Request, res: Response) {
    const baseId = req.params.id;
    const t = await agentService.deriveTemplate(baseId, req.body, req.user);
    void publishEvent(prisma, {
      eventName: "agent.template.derived",
      envelope: {
        source_service: "agent-runtime",
        subject: { kind: "agent_template", id: (t as { id: string }).id },
        actor:   req.user?.user_id ? { kind: "user", id: req.user.user_id } : null,
        status:  "emitted",
        started_at: new Date().toISOString(),
        payload: {
          baseTemplateId: baseId,
          capabilityId:   (t as { capabilityId?: string }).capabilityId,
          name:           (t as { name?: string }).name,
          roleType:       (t as { roleType?: string }).roleType,
        },
      },
    }).catch((err) => console.warn("[eventbus] publishEvent failed:", (err as Error).message));
    // M22 — central audit ledger
    emitAuditEvent({
      source_service: "agent-runtime",
      kind:           "agent.template.derived",
      subject_type:   "AgentTemplate",
      subject_id:     (t as { id: string }).id,
      capability_id:  (t as { capabilityId?: string }).capabilityId,
      actor_id:       req.user?.user_id,
      severity:       "info",
      payload: {
        baseTemplateId: baseId,
        name:           (t as { name?: string }).name,
        roleType:       (t as { roleType?: string }).roleType,
      },
    });
    return ok(res, shapeTemplate(t, req.user), 201);
  },

  async updateTemplate(req: Request, res: Response) {
    const t = await agentService.updateTemplate(req.params.id, req.body, req.user);
    void publishEvent(prisma, {
      eventName: "agent.template.updated",
      envelope: {
        source_service: "agent-runtime",
        subject: { kind: "agent_template", id: (t as { id: string }).id },
        actor:   req.user?.user_id ? { kind: "user", id: req.user.user_id } : null,
        status:  "emitted",
        started_at: new Date().toISOString(),
        payload: { fields_updated: Object.keys(req.body) },
      },
    }).catch((err) => console.warn("[eventbus] publishEvent failed:", (err as Error).message));
    // M22 — central audit ledger
    emitAuditEvent({
      source_service: "agent-runtime",
      kind:           "agent.template.updated",
      subject_type:   "AgentTemplate",
      subject_id:     (t as { id: string }).id,
      capability_id:  (t as { capabilityId?: string }).capabilityId,
      actor_id:       req.user?.user_id,
      severity:       "info",
      payload: { fields_updated: Object.keys(req.body) },
    });
    return ok(res, shapeTemplate(t, req.user));
  },

  async listTemplateVersions(req: Request, res: Response) {
    const versions = await agentService.listTemplateVersions(req.params.id);
    return ok(res, versions);
  },

  async restoreTemplateVersion(req: Request, res: Response) {
    const version = Number.parseInt(req.params.version, 10);
    const t = await agentService.restoreTemplateVersion(req.params.id, version, req.body, req.user);
    void publishEvent(prisma, {
      eventName: "agent.template.version.restored",
      envelope: {
        source_service: "agent-runtime",
        subject: { kind: "agent_template", id: (t as { id: string }).id },
        actor:   req.user?.user_id ? { kind: "user", id: req.user.user_id } : null,
        status:  "emitted",
        started_at: new Date().toISOString(),
        payload: { restored_from_version: version, current_version: (t as { version?: number }).version },
      },
    }).catch((err) => console.warn("[eventbus] publishEvent failed:", (err as Error).message));
    emitAuditEvent({
      source_service: "agent-runtime",
      kind:           "agent.template.version.restored",
      subject_type:   "AgentTemplate",
      subject_id:     (t as { id: string }).id,
      capability_id:  (t as { capabilityId?: string }).capabilityId,
      actor_id:       req.user?.user_id,
      severity:       "info",
      payload: { restored_from_version: version, current_version: (t as { version?: number }).version },
    });
    return ok(res, shapeTemplate(t, req.user));
  },

  async createSkill(req: Request, res: Response) {
    const s = await agentService.createSkill(req.body, req.user);
    return ok(res, s, 201);
  },

  async listSkills(_req: Request, res: Response) {
    return ok(res, await agentService.listSkills());
  },

  async attachSkill(req: Request, res: Response) {
    const link = await agentService.attachSkill(req.params.id, req.body.skillId, req.body.isDefault, req.user);
    return ok(res, link, 201);
  },
};
