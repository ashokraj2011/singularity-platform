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
import { applyPatchToCleanWorkspace, branchNameForWork, currentHeadSha, prepareWorkBranch } from "../workspace/git-workspace";
import { withSandboxRoot, workspaceRootForRunContext } from "../workspace/sandbox";
import { redactSecrets } from "../security/redact";
import { grantMode, toolRequiresGrant, verifyToolGrant, consumeGrantNonce } from "../security/tool-grant";
import { log } from "../shared/log";
import { assertEffectiveCapabilityAllowsTool } from "./effective-capability";

export const workRouter = Router();

export const FinishBranchSchema = z.object({
  message: z.string().optional(),
  remote: z.string().default("origin"),
  push: z.boolean().default(true),
  expectedCommitSha: z.string().optional(),
  patch: z.string().optional(),
  tool_grant: z.unknown().optional(),
  // P0 #2 — brokered, short-lived, repo-scoped git credential. `token` is used
  // in-memory for the push then discarded; the rest is audit metadata.
  gitCredential: z
    .object({
      token: z.string(),
      issuanceId: z.string().optional(),
      provider: z.string().optional(),
      expiresAt: z.string().optional(),
      repo: z.string().optional(),
      allowedOperation: z.string().optional(),
    })
    .optional(),
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
      workspaceRoot: z.string().optional(),
      capabilityId: z.string().optional(),
      agentId: z.string().optional(),
      effectiveCapabilities: z.array(z.record(z.unknown())).optional(),
      effective_capabilities: z.array(z.record(z.unknown())).optional(),
      effectiveCapabilitiesRequired: z.boolean().optional(),
      effective_capabilities_required: z.boolean().optional(),
      profileSnapshotHash: z.string().optional(),
      profile_snapshot_hash: z.string().optional(),
    })
    .default({}),
});

export type FinishBranchInput = z.infer<typeof FinishBranchSchema>;

/**
 * Core finish-work-branch logic, shared by the HTTP route below and the
 * `work-finish-branch` runtime-bridge frame (laptop/relay-client) so a laptop/
 * remote MCP that only dials into Context Fabric can finalize a work branch.
 * Verifies the grant, re-establishes the branch, restores the approved patch if
 * HEAD drifted, runs finishWorkBranchTool, records the audit invocation. Returns
 * { tool_invocation, output } on success; throws AppError on failure (after
 * recording the failed invocation).
 */
export async function runFinishWorkBranch(
  body: FinishBranchInput,
): Promise<{ tool_invocation: ReturnType<typeof recordToolInvocation>; output: unknown }> {
  const toolArgs = { message: body.message, push: body.push, remote: body.remote };
  // P0 #2 — audit metadata for the brokered credential (NEVER the token). The
  // sha256 fingerprint lives on the IAM issuance record (linked by issuanceId).
  const gitCredentialMetadata = body.gitCredential
    ? {
        issuanceId: body.gitCredential.issuanceId,
        provider: body.gitCredential.provider,
        expiresAt: body.gitCredential.expiresAt,
        repo: body.gitCredential.repo,
        operation: body.gitCredential.allowedOperation,
        actor: body.runContext.agentId,
      }
    : undefined;
  assertEffectiveCapabilityAllowsTool("finish_work_branch", body.runContext);
  const mode = grantMode();
  if (mode !== "off" && toolRequiresGrant("finish_work_branch")) {
    const verdict = verifyToolGrant(body.tool_grant, {
      toolName: "finish_work_branch",
      args: toolArgs,
      runContext: body.runContext,
    });
    if (verdict.ok) {
      // Single-use nonce: consume it before dispatch; reject a replay.
      const replay = await consumeGrantNonce(verdict.grant);
      if (!replay.ok) {
        log.warn(
          { tool: "finish_work_branch", mode, code: replay.code },
          "[work/finish-branch] refusing finalize dispatch: grant nonce already used (replay)",
        );
        throw new AppError(replay.message, 403, replay.code, {
          tool_name: "finish_work_branch",
          mode,
        });
      }
    } else {
      const missing = verdict.code === "TOOL_GRANT_REQUIRED";
      if (mode === "grace" && missing) {
        log.warn(
          { tool: "finish_work_branch", mode },
          "[work/finish-branch] grace mode: dispatching finalize tool WITHOUT a ToolInvocationGrant",
        );
      } else {
        log.warn(
          { tool: "finish_work_branch", mode, code: verdict.code },
          "[work/finish-branch] refusing finalize dispatch: grant verification failed",
        );
        throw new AppError(verdict.message, 403, verdict.code, {
          tool_name: "finish_work_branch",
          mode,
        });
      }
    }
  }
  const correlation = { ...body.runContext, mcpInvocationId: uuidv4() };
  const workspaceRoot = workspaceRootForRunContext({
    workItemId: body.runContext.workItemId,
    workItemCode: body.runContext.workItemCode,
    branchName: body.runContext.branchName,
    // (2026-06-02 M81 cross-stage fix) stage-stable last-resort key — see
    // workspaceRootForRunContext for the full resolution order.
    workflowInstanceId: body.runContext.workflowInstanceId,
    workspaceRoot: body.runContext.workspaceRoot,
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
      const headSha = await currentHeadSha();
      const patchRestore = body.expectedCommitSha
        && headSha
        && headSha !== body.expectedCommitSha
        && body.patch?.trim()
        ? await applyPatchToCleanWorkspace(body.patch)
        : undefined;
      if (patchRestore && !patchRestore.applied && patchRestore.skippedReason !== "patch already present in workspace") {
        throw new Error(`approved patch could not be restored before push: ${patchRestore.skippedReason}`);
      }
      const result = await finishWorkBranchTool.execute({
        message: toolArgs.message,
        push: toolArgs.push,
        remote: toolArgs.remote,
        // P0 #2 — brokered token; in-memory for the push only, never persisted.
        gitToken: body.gitCredential?.token,
      });
      if (patchRestore && result.output && typeof result.output === "object") {
        Object.assign(result.output as Record<string, unknown>, {
          patch_restored: patchRestore.applied,
          patch_restore_note: patchRestore.skippedReason,
        });
      }
      return result;
    });
    const rec = recordToolInvocation({
      correlation,
      tool_name: "finish_work_branch",
      args: redactSecrets(toolArgs),
      output: redactSecrets(r.output),
      success: r.success,
      error: r.error ? redactSecrets(r.error) : undefined,
      latency_ms: Date.now() - start,
      gitCredentialMetadata,
    });
    return { tool_invocation: rec, output: redactSecrets(r.output) };
  } catch (err) {
    const message = redactSecrets((err as Error).message);
    const rec = recordToolInvocation({
      correlation,
      tool_name: "finish_work_branch",
      args: redactSecrets(toolArgs),
      output: null,
      success: false,
      error: message,
      latency_ms: Date.now() - start,
      gitCredentialMetadata,
    });
    throw new AppError(
      message,
      500,
      "WORK_FINISH_BRANCH_FAILED",
      { tool_invocation: rec },
    );
  }
}

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
  const { tool_invocation, output } = await runFinishWorkBranch(parsed.data);
  res.json({
    success: true,
    data: { tool_invocation, output },
    requestId: res.locals.requestId,
  });
});
