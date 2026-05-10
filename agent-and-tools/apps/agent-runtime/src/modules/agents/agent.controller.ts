import { Request, Response } from "express";
import { agentService } from "./agent.service";
import { ok } from "../../shared/response";

export const agentController = {
  async createTemplate(req: Request, res: Response) {
    const t = await agentService.createTemplate(req.body, req.user?.user_id);
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
