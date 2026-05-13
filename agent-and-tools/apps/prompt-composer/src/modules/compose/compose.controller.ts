import { Request, Response } from "express";
import { composeService } from "./compose.service";
import { ok } from "../../shared/response";

export const composeController = {
  async composeAndRespond(req: Request, res: Response) {
    // M25.5 C6 — operators editing knowledge content need fresh results, not a
    // stale compiled paragraph. Accept the bypass at the route boundary so
    // the body schema stays declarative and callers can pick either form.
    const queryFlag  = String((req.query as Record<string, string>).nocache ?? "").trim();
    const headerFlag = String(req.header("Bypass-Cache") ?? "").trim();
    const truthy = (s: string) => s !== "" && s !== "0" && s.toLowerCase() !== "false";
    const bodyFlag = req.body?.bypassCache === true;
    const bypass   = bodyFlag || truthy(queryFlag) || truthy(headerFlag);
    const result = await composeService.composeAndRespond({ ...req.body, bypassCache: bypass });
    return ok(res, result, 201);
  },
};
