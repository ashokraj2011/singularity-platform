import { Request, Response } from "express";
import { agentService } from "./agent.service";
import { ok } from "../../shared/response";
import { publishEvent } from "../../lib/eventbus/publisher";
import { emitAuditEvent } from "../../lib/audit-gov-emit";
import { prisma } from "../../config/prisma";

export const agentController = {
  async createTemplate(req: Request, res: Response) {
    const t = await agentService.createTemplate(req.body, req.user?.user_id);
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
    return ok(res, t, 201);
  },

  async listTemplates(req: Request, res: Response) {
    const result = await agentService.listTemplates(req.query as never);
    return ok(res, result);
  },

  async getTemplate(req: Request, res: Response) {
    const t = await agentService.getTemplate(req.params.id);
    return ok(res, t);
  },

  async deriveTemplate(req: Request, res: Response) {
    const baseId = req.params.id;
    const t = await agentService.deriveTemplate(baseId, req.body, req.user?.user_id);
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
    return ok(res, t, 201);
  },

  async updateTemplate(req: Request, res: Response) {
    // Platform-admin gate: agent-runtime currently runs optionalAuth. Deny by
    // default (no user ⟹ not admin); the lock only releases when a JWT
    // carrying is_platform_admin / is_super_admin is present. A privileged
    // service-to-service caller must use that header.
    const u = req.user as unknown as Record<string, unknown> | undefined;
    const isPlatformAdmin = Boolean(u && (u.is_platform_admin || u.is_super_admin));
    const t = await agentService.updateTemplate(req.params.id, req.body, isPlatformAdmin);
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
    return ok(res, t);
  },

  async createSkill(req: Request, res: Response) {
    const s = await agentService.createSkill(req.body);
    return ok(res, s, 201);
  },

  async listSkills(_req: Request, res: Response) {
    return ok(res, await agentService.listSkills());
  },

  async attachSkill(req: Request, res: Response) {
    const link = await agentService.attachSkill(req.params.id, req.body.skillId, req.body.isDefault);
    return ok(res, link, 201);
  },
};
