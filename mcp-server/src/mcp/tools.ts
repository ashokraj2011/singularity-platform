import { Router } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { AppError, NotFoundError } from "../shared/errors";
import { getLocalTool, listLocalTools } from "../tools/registry";
import { recordToolInvocation } from "../audit/store";

export const toolsRouter = Router();

/**
 * GET /mcp/tools/list
 * Standard MCP semantics. Returns the tools served by this MCP server's
 * local registry. Does NOT include SERVER-target tools — those live in
 * tool-service and are provided to the LLM by context-fabric in the
 * /mcp/invoke `tools[]` payload.
 */
toolsRouter.get("/tools/list", (_req, res) => {
  res.json({
    success: true,
    data: { tools: listLocalTools() },
    requestId: res.locals.requestId,
  });
});

/**
 * POST /mcp/tools/call
 *
 * Synchronous, single-shot tool invocation outside the agent loop. Useful
 * for testing and for clients that want to drive the LLM themselves.
 *
 * Body: { name: string, arguments: object, runContext?: { traceId, runId, ... } }
 */
const CallSchema = z.object({
  name: z.string(),
  arguments: z.record(z.unknown()).default({}),
  runContext: z
    .object({
      traceId: z.string().optional(),
      runId: z.string().optional(),
      capabilityId: z.string().optional(),
      agentId: z.string().optional(),
    })
    .default({}),
});

toolsRouter.post("/tools/call", async (req, res) => {
  const parsed = CallSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError("invalid /mcp/tools/call payload", 400, "VALIDATION_ERROR", parsed.error.flatten());
  }
  const body = parsed.data;
  const handler = getLocalTool(body.name);
  if (!handler) throw new NotFoundError(`tool '${body.name}' not in local registry`);

  const correlation = { ...body.runContext, mcpInvocationId: uuidv4() };
  const start = Date.now();
  try {
    const r = await handler.execute(body.arguments);
    const rec = recordToolInvocation({
      correlation, tool_name: body.name, args: body.arguments,
      output: r.output, success: r.success, error: r.error,
      latency_ms: Date.now() - start,
    });
    res.json({
      success: true,
      data: { tool_invocation: rec, output: r.output },
      requestId: res.locals.requestId,
    });
  } catch (err) {
    const rec = recordToolInvocation({
      correlation, tool_name: body.name, args: body.arguments, output: null,
      success: false, error: (err as Error).message, latency_ms: Date.now() - start,
    });
    throw new AppError((err as Error).message, 500, "TOOL_EXECUTION_ERROR", { tool_invocation: rec });
  }
});
