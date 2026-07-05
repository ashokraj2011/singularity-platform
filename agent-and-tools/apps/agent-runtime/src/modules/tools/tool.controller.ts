import { Request, Response } from "express";
import { toolService } from "./tool.service";
import { toolValidationService } from "./tool-validation.service";
import { ok } from "../../shared/response";

export const toolController = {
  async register(req: Request, res: Response) {
    return ok(res, await toolService.register(req.body, req.user), 201);
  },
  async list(req: Request, res: Response) {
    return ok(res, await toolService.list(req.query as never));
  },
  async get(req: Request, res: Response) {
    return ok(res, await toolService.get(req.params.id));
  },
  async createContract(req: Request, res: Response) {
    return ok(res, await toolService.createContract(req.params.id, req.body, req.user), 201);
  },
  async createPolicy(req: Request, res: Response) {
    return ok(res, await toolService.createPolicy(req.body, req.user), 201);
  },
  async listPolicies(_req: Request, res: Response) {
    return ok(res, await toolService.listPolicies());
  },
  async updatePolicy(req: Request, res: Response) {
    return ok(res, await toolService.updatePolicy(req.params.id, req.body, req.user));
  },
  async deletePolicy(req: Request, res: Response) {
    return ok(res, await toolService.deletePolicy(req.params.id, req.user));
  },
  async createGrant(req: Request, res: Response) {
    return ok(res, await toolService.createGrant(req.body, req.user), 201);
  },
  async listGrants(req: Request, res: Response) {
    return ok(res, await toolService.listGrants(req.query as never));
  },
  async updateGrant(req: Request, res: Response) {
    return ok(res, await toolService.updateGrant(req.params.id, req.body, req.user));
  },
  async deleteGrant(req: Request, res: Response) {
    return ok(res, await toolService.deleteGrant(req.params.id, req.user));
  },
  async validateCall(req: Request, res: Response) {
    return ok(res, await toolValidationService.validate(req.body));
  },
};
