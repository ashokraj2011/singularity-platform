/**
 * M71 — Slice D: dumb tool-runner endpoint.
 *
 * context-fabric (the new policy chokepoint) calls this once per tool
 * invocation. mcp-server does ZERO policy decisions here — no formal
 * verifier, no phase nudges, no finish-gate preflight, no prompt
 * injection. Just:
 *
 *   1. Look up the tool by name in the local registry.
 *   2. Resolve the workspace root for the (workItemId|workspaceId) tuple.
 *   3. Prep the work branch if the tool is finish_work_branch (existing
 *      idempotent guard from /mcp/tools/call).
 *   4. Execute the tool inside the sandbox.
 *   5. Record an audit invocation locally (audit-gov is the canonical sink
 *      after M65 1C; this local record is the sandbox-debug copy).
 *   6. Return { result, durationMs, success, error?, toolInvocationId }.
 *
 * All phase-gating, allowlist enforcement, and receipt validation happens
 * UPSTREAM in context-fabric/app/governed/. By the time mcp-server sees a
 * /tool-run call, the policy decision has already been made.
 *
 * The old /mcp/invoke (the agent loop) becomes a 410 Gone shim in Slice I.
 * The old /mcp/tools/call stays for one milestone of backward compat then
 * gets removed too.
 *
 * Body shape (matches the M71 plan):
 *   {
 *     tool_name:    string,
 *     args:         object,
 *     workspace_id?: string,   // mirrors workItemId; either is accepted
 *     work_item_id?: string,
 *     run_context?: {          // optional — carries trace/run identifiers
 *       traceId, runId, workflowInstanceId, nodeId, runStepId,
 *       workItemCode, branchBase, branchName, workspaceRoot,
 *       capabilityId, agentId
 *     }
 *   }
 *
 * Response:
 *   {
 *     success: boolean,
 *     data: {
 *       result: <tool-specific output>,
 *       durationMs: number,
 *       toolInvocationId: string
 *     }
 *   }
 */
import { Router } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { AppError, NotFoundError } from "../shared/errors";
import { getLocalTool } from "../tools/registry";
import { recordToolInvocation } from "../audit/store";
import { branchNameForWork, prepareWorkBranch } from "../workspace/git-workspace";
import { withSandboxRoot, workspaceRootForRunContext } from "../workspace/sandbox";

export const toolRunRouter = Router();

const ToolRunSchema = z.object({
  tool_name: z.string().min(1, "tool_name required"),
  args: z.record(z.unknown()).default({}),
  // Either `work_item_id` or `workspace_id` works. The sandbox resolver
  // prefers explicit workspace > workItemId > branchName > workItemCode.
  work_item_id: z.string().optional(),
  workspace_id: z.string().optional(),
  run_context: z
    .object({
      traceId: z.string().optional(),
      runId: z.string().optional(),
      workflowInstanceId: z.string().optional(),
      nodeId: z.string().optional(),
      runStepId: z.string().optional(),
      workItemCode: z.string().optional(),
      branchBase: z.string().optional(),
      branchName: z.string().optional(),
      workspaceRoot: z.string().optional(),
      capabilityId: z.string().optional(),
      agentId: z.string().optional(),
      // M72 Slice C — caller-supplied attempt id; per-attempt sandbox isolation.
      // Accepts both snake_case (context-fabric's `attempt_id`) and camelCase
      // (workgraph-api's `attemptId`) via the alias below.
      attemptId: z.string().optional(),
      attempt_id: z.string().optional(),
    })
    .default({}),
});

toolRunRouter.post("/tool-run", async (req, res) => {
  const parsed = ToolRunSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError("invalid /mcp/tool-run payload", 400, "VALIDATION_ERROR", parsed.error.flatten());
  }
  const body = parsed.data;

  // Find the tool. If it isn't in the local registry, this is the caller's
  // bug (context-fabric should only dispatch tools that exist) — 404 lets
  // the upstream surface a clear "this tool name is unknown" error.
  const handler = getLocalTool(body.tool_name);
  if (!handler) {
    throw new NotFoundError(`tool '${body.tool_name}' not in local registry`);
  }

  // Build the correlation context that flows into audit + receipts.
  // workspace_id is treated as an alias for work_item_id for sandbox routing.
  const workItemId = body.work_item_id ?? body.workspace_id ?? undefined;
  const correlation = {
    ...body.run_context,
    workItemId,
    mcpInvocationId: uuidv4(),
  };

  // M72 Slice C — Accept attempt id from either casing so callers in Python
  // (snake_case) and TS (camelCase) both work without a translation layer.
  const attemptId = body.run_context.attemptId ?? body.run_context.attempt_id;
  const workspaceRoot = workspaceRootForRunContext({
    workItemId,
    workItemCode: body.run_context.workItemCode,
    branchName: body.run_context.branchName,
    workspaceRoot: body.run_context.workspaceRoot,
    attemptId,
  });

  const start = Date.now();
  try {
    const r = await withSandboxRoot(workspaceRoot, async () => {
      // finish_work_branch needs the work branch prepared. Same logic as
      // /mcp/tools/call so existing branch idempotency is preserved.
      const branchRequest = {
        workflowInstanceId: body.run_context.workflowInstanceId ?? body.run_context.runId,
        nodeId: body.run_context.nodeId ?? body.run_context.runStepId,
        workItemId,
        workItemCode: body.run_context.workItemCode,
        branchBase: body.run_context.branchBase,
        branchName: body.run_context.branchName,
      };
      if (body.tool_name === "finish_work_branch" && branchNameForWork(branchRequest)) {
        await prepareWorkBranch(branchRequest, correlation);
      }
      return handler.execute(body.args);
    });

    const durationMs = Date.now() - start;
    const rec = recordToolInvocation({
      correlation,
      tool_name: body.tool_name,
      args: body.args,
      output: r.output,
      success: r.success,
      error: r.error,
      latency_ms: durationMs,
    });

    res.json({
      success: true,
      data: {
        result: r.output,
        durationMs,
        toolInvocationId: rec.id,
        // Echo the success/error from the tool itself so context-fabric
        // can distinguish "tool ran but reported failure" from "endpoint
        // threw". Both are visible to the LLM.
        toolSuccess: r.success,
        toolError: r.error ?? null,
      },
      requestId: res.locals.requestId,
    });
  } catch (err) {
    const durationMs = Date.now() - start;
    const rec = recordToolInvocation({
      correlation,
      tool_name: body.tool_name,
      args: body.args,
      output: null,
      success: false,
      error: (err as Error).message,
      latency_ms: durationMs,
    });
    throw new AppError((err as Error).message, 500, "TOOL_EXECUTION_ERROR", {
      durationMs,
      toolInvocationId: rec.id,
    });
  }
});
