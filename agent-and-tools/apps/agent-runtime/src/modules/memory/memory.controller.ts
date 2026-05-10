import { Request, Response } from "express";
import { memoryService } from "./memory.service";
import { ok } from "../../shared/response";

export const memoryController = {
  async storeExecution(req: Request, res: Response) {
    return ok(res, await memoryService.storeExecution(req.body), 201);
  },
  async listExecution(req: Request, res: Response) {
    return ok(res, await memoryService.listExecution(req.query as never));
  },
  async review(req: Request, res: Response) {
    return ok(res, await memoryService.review(req.params.id, req.body.decision));
  },
  async promote(req: Request, res: Response) {
    return ok(res, await memoryService.promote(req.body), 201);
  },
  async listDistilled(req: Request, res: Response) {
    return ok(res, await memoryService.listDistilled(req.query as never));
  },
};
