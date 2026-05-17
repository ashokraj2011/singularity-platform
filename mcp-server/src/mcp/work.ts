/**
 * M37.1 — Purpose-built workflow-branch endpoint.
 *
 *   POST /mcp/work/finish-branch
 *
 * Replaces the bypass path where workgraph-api's GitPushExecutor used to
 * POST to /mcp/tools/call with a hardcoded `name: "finish_work_branch"`
 * string literal in its body. That path violated two M36 invariants:
 *   - tool names should come from LLM tool_call decisions, not from string
 *     literals in caller TS source
 *   - the generic /mcp/tools/call endpoint is a bypass around the agent
 *     loop, with no governance / approval / risk-tier check
 *
 * This endpoint is operational by design: GIT_PUSH is a deterministic
 * workflow step ("the operator approved this push; do it"), not an agent
 * decision. So we expose it as a named HTTP operation, not via the tool
 * runner. Internally it reuses the same prepareWorkBranch + finishWorkBranch
 * primitives but the tool name is owned by this server, not the caller.
 *
 * Auth: same bearer as the rest of /mcp/* routes.
 */
import { Router } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { AppError } from "../shared/errors";
import { finishWorkBranchTool } from "../tools/ast-tools";
import { recordToolInvocation } from "../audit/store";
import { branchNameForWork, prepareWorkBranch } from "../workspace/git-workspace";
import { withSandboxRoot, workspaceRootForRunContext } from "../workspace/sandbox";

export const workRouter = Router();

const FinishBranchSchema = z.object({
  message: z.string().optional(),
  remote: z.string().default("origin"),
  push: z.boolean().default(true),
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

workRouter.post("/work/finish-branch", async (req, res) => {
  const parsed = FinishBranchSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(
      "invalid /mcp/work/finish-branch payload",
      400,
      "VALIDATION_ERROR",
      parsed.error.flatten(),
    );
  }
  const body = parsed.data;
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
      // Re-establish the work branch on disk so the commit lands on the
      // right ref. (mcp-server may have restarted between agent-loop end
      // and this push.) Same logic as the legacy /mcp/tools/call special
      // case at tools.ts:81, now hosted by this purpose-built endpoint.
      if (branchNameForWork(branchRequest)) {
        await prepareWorkBranch(branchRequest, correlation);
      }
      return finishWorkBranchTool.execute({
        message: body.message,
        push: body.push,
        remote: body.remote,
      });
    });
    const rec = recordToolInvocation({
      correlation,
      tool_name: "finish_work_branch",
      args: { message: body.message, push: body.push, remote: body.remote },
      output: r.output,
      success: r.success,
      error: r.error,
      latency_ms: Date.now() - start,
    });
    res.json({
      success: true,
      data: { tool_invocation: rec, output: r.output },
      requestId: res.locals.requestId,
    });
  } catch (err) {
    const rec = recordToolInvocation({
      correlation,
      tool_name: "finish_work_branch",
      args: { message: body.message, push: body.push, remote: body.remote },
      output: null,
      success: false,
      error: (err as Error).message,
      latency_ms: Date.now() - start,
    });
    throw new AppError(
      (err as Error).message,
      500,
      "WORK_FINISH_BRANCH_FAILED",
      { tool_invocation: rec },
    );
  }
});
