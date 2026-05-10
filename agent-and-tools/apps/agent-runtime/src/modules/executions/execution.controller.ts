import { Request, Response } from "express";
import { executionService } from "./execution.service";
import { ok } from "../../shared/response";

export const executionController = {
  async create(req: Request, res: Response) {
    return ok(res, await executionService.create(req.body, req.user?.user_id), 201);
  },
  async list(req: Request, res: Response) {
    return ok(res, await executionService.list(req.query as never));
  },
  async get(req: Request, res: Response) {
    return ok(res, await executionService.get(req.params.id));
  },
  async start(req: Request, res: Response) {
    return ok(res, await executionService.start(req.params.id, req.body));
  },
  async getReceipt(req: Request, res: Response) {
    return ok(res, await executionService.getReceipt(req.params.id));
  },
};
