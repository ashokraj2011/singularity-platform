import { Router } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { AppError, NotFoundError } from "../shared/errors";
import { getLocalTool, listLocalTools } from "../tools/registry";
import { recordToolInvocation } from "../audit/store";
import { branchNameForWork, prepareWorkBranch } from "../workspace/git-workspace";
import { withSandboxRoot, workspaceRootForRunContext } from "../workspace/sandbox";

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
 * Synchronous, single-shot tool invocation outside the agent loop.
 *
 * M37.1 — This is a known bypass around the agent loop / governance /
 * approval checks. Production-class environments refuse it by default;
 * set `MCP_ALLOW_GENERIC_TOOLS_CALL=true` to opt in (e.g. tests, dev).
 *
 * For deterministic operational hooks (like the GIT_PUSH workflow node
 * pushing a work branch), use purpose-built endpoints (POST /mcp/work/...)
 * instead. Those don't require a tool-name string from the caller and
 * are auditable as named operations.
 *
 * Body: { name: string, arguments: object, runContext?: { traceId, runId, ... } }
 */
function isProdClass(): boolean {
  const env = (process.env.NODE_ENV ?? "development").toLowerCase();
  return ["production", "prod", "staging", "perf"].includes(env);
}

function genericToolsCallEnabled(): boolean {
  // Dev/test: enabled by default. Prod-class: opt-in via env flag.
  if (!isProdClass()) return true;
  return (process.env.MCP_ALLOW_GENERIC_TOOLS_CALL ?? "").toLowerCase() === "true";
}

const CallSchema = z.object({
  name: z.string(),
  arguments: z.record(z.unknown()).default({}),
  runContext: z
    .object({
      traceId: z.string().optional(),
      runId: z.string().optional(),
      workflowInstanceId: z.string().optional(),
      nodeId: z.string().optional(),
      runStepId: z.string().optional(),
      workItemId: z.string().optional(),
      workItemCode: z.string().optional(),
      branchBase: z.string().optional(),
      branchName: z.string().optional(),
      capabilityId: z.string().optional(),
      agentId: z.string().optional(),
    })
    .default({}),
});

toolsRouter.post("/tools/call", async (req, res) => {
  // M37.1 — Refuse generic tool-call in production-class envs unless
  // explicitly opted in. Operational callers (e.g. workgraph-api's
  // GIT_PUSH executor) should use purpose-built endpoints.
  if (!genericToolsCallEnabled()) {
    throw new AppError(
      "POST /mcp/tools/call is disabled in production-class environments. " +
        "Use a purpose-built endpoint (e.g. /mcp/work/finish-branch) or set " +
        "MCP_ALLOW_GENERIC_TOOLS_CALL=true to opt in for testing.",
      403,
      "GENERIC_TOOLS_CALL_DISABLED",
    );
  }
  const parsed = CallSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError("invalid /mcp/tools/call payload", 400, "VALIDATION_ERROR", parsed.error.flatten());
  }
  const body = parsed.data;
  const handler = getLocalTool(body.name);
  if (!handler) throw new NotFoundError(`tool '${body.name}' not in local registry`);

  const correlation = { ...body.runContext, mcpInvocationId: uuidv4() };
  const workspaceRoot = workspaceRootForRunContext({
    workItemId: body.runContext.workItemId,
    workItemCode: body.runContext.workItemCode,
    branchName: body.runContext.branchName,
  });
  const start = Date.now();
  try {
    const r = await withSandboxRoot(workspaceRoot, async () => {
      const branchRequest = {
        workflowInstanceId: body.runContext.workflowInstanceId ?? body.runContext.runId,
        nodeId: body.runContext.nodeId ?? body.runContext.runStepId,
        workItemId: body.runContext.workItemId,
        workItemCode: body.runContext.workItemCode,
        branchBase: body.runContext.branchBase,
        branchName: body.runContext.branchName,
      };
      if (body.name === "finish_work_branch" && branchNameForWork(branchRequest)) {
        await prepareWorkBranch(branchRequest, correlation);
      }
      return handler.execute(body.arguments);
    });
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
