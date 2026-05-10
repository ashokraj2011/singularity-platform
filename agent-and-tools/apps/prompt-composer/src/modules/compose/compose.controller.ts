import { Request, Response } from "express";
import { composeService } from "./compose.service";
import { ok } from "../../shared/response";

export const composeController = {
  async composeAndRespond(req: Request, res: Response) {
    const result = await composeService.composeAndRespond(req.body);
    return ok(res, result, 201);
  },
};
