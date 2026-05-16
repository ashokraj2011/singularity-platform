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
    return res.status(410).json({
      success: false,
      data: null,
      error: {
        code: "DIRECT_RUNTIME_RETIRED",
        message: "Direct agent-runtime execution is retired. Start agent work through Workgraph AGENT_TASK so Prompt Composer, Context Fabric, MCP, budgets, approvals, and receipts are enforced.",
        details: {
          executionId: req.params.id,
          successor: "Workgraph workflow execution",
        },
      },
      requestId: res.locals.requestId ?? null,
    });
  },
  async getReceipt(req: Request, res: Response) {
    return ok(res, await executionService.getReceipt(req.params.id));
  },
};
