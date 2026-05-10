import { Request, Response } from "express";
import { toolService } from "./tool.service";
import { toolValidationService } from "./tool-validation.service";
import { ok } from "../../shared/response";

export const toolController = {
  async register(req: Request, res: Response) {
    return ok(res, await toolService.register(req.body), 201);
  },
  async list(req: Request, res: Response) {
    return ok(res, await toolService.list(req.query as never));
  },
  async get(req: Request, res: Response) {
    return ok(res, await toolService.get(req.params.id));
  },
  async createContract(req: Request, res: Response) {
    return ok(res, await toolService.createContract(req.params.id, req.body), 201);
  },
  async createPolicy(req: Request, res: Response) {
    return ok(res, await toolService.createPolicy(req.body), 201);
  },
  async listPolicies(_req: Request, res: Response) {
    return ok(res, await toolService.listPolicies());
  },
  async createGrant(req: Request, res: Response) {
    return ok(res, await toolService.createGrant(req.body), 201);
  },
  async listGrants(req: Request, res: Response) {
    return ok(res, await toolService.listGrants(req.query as never));
  },
  async validateCall(req: Request, res: Response) {
    return ok(res, await toolValidationService.validate(req.body));
  },
};
