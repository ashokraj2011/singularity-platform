import { Request, Response } from "express";
import { capabilityService } from "./capability.service";
import { ok } from "../../shared/response";

export const capabilityController = {
  async create(req: Request, res: Response) {
    return ok(res, await capabilityService.create(req.body), 201);
  },
  async list(_req: Request, res: Response) {
    return ok(res, await capabilityService.list());
  },
  async get(req: Request, res: Response) {
    return ok(res, await capabilityService.get(req.params.id));
  },
  async attachRepo(req: Request, res: Response) {
    return ok(res, await capabilityService.attachRepository(req.params.id, req.body), 201);
  },
  async bindAgent(req: Request, res: Response) {
    return ok(res, await capabilityService.bindAgent(req.params.id, req.body, req.user?.user_id), 201);
  },
  async listBindings(req: Request, res: Response) {
    return ok(res, await capabilityService.listBindings(req.params.id));
  },
  async addKnowledge(req: Request, res: Response) {
    return ok(res, await capabilityService.addKnowledge(req.params.id, req.body), 201);
  },
  async listKnowledge(req: Request, res: Response) {
    return ok(res, await capabilityService.listKnowledge(req.params.id));
  },
};
