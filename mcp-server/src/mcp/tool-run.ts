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
import { ensureWorkspaceSource } from "../workspace/source-materializer";
import { indexWorkspace } from "../workspace/ast-index";

// M90.C (2026-05-27) — Selective workspace fail-fast.
//
// Pre-M90.C, ensureWorkspaceSource() swallowed materialization errors
// silently and let the tool dispatch continue. That's safe for tools
// that don't touch the workspace (parsers, classifiers, synthesizers)
// but catastrophic for everything else — apply_patch against an empty
// workspace produces a no-op "success" that the agent then "verifies"
// against the also-empty workspace, while the operator gets a green
// approval card pointing at a phantom commit.
//
// M91.D (2026-05-27) — adopted the canonical tool-registry as the
// single source for which tools are workspace-independent. Previously
// the allowlist was a hand-maintained Set of four names here; now it
// derives from the registry's `category` field (analyzer +
// verify_meta = workspace-independent). When a new such tool ships,
// add it to tools.json and the runtime picks it up automatically.
// See mcp-server/src/tools/tool-registry-loader.ts for the implementation.
//
// NOTE: the module file is `tool-registry-loader.ts`, deliberately NOT
// `tools-registry.ts`. A sibling data file `tools-registry.json` lives in
// the same directory, and Node's extensionless module resolution tries
// `.json` BEFORE ts-node's `.ts` — so `import ... from "../tools/tools-registry"`
// silently resolved to the JSON manifest (keys: tools, version) instead of
// the TS module, making `workspaceIndependentTools` undefined at load time
// and crash-looping the dev tool-runner. Keeping distinct basenames removes
// the ambiguity in both ts-node (dev) and compiled (prod) modes.
import { workspaceIndependentTools } from "../tools/tool-registry-loader";
const _WORKSPACE_INDEPENDENT_TOOLS = workspaceIndependentTools();

export function isWorkspaceIndependentTool(name: string): boolean {
  return _WORKSPACE_INDEPENDENT_TOOLS.has(name);
}

export const toolRunRouter = Router();

export const ToolRunSchema = z.object({
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
      // (2026-05-24) Workspace source fields — when present, the runner
      // calls ensureWorkspaceSource() before tool dispatch so the github
      // (or local) repo is checked out into the sandbox. Without these,
      // tools like repo_map / list_indexed_files run against an empty
      // workspace because the legacy /mcp/invoke path that did the
      // materialization was deleted in M71 Slice I but the replacement
      // never inherited the responsibility. Both camelCase
      // (workgraph-api's `sourceType`) and snake_case (context-fabric's
      // `source_type`) are accepted to match the existing alias
      // convention on attemptId/attempt_id.
      sourceType: z.string().optional(),
      source_type: z.string().optional(),
      sourceUri: z.string().optional(),
      source_uri: z.string().optional(),
      sourceRef: z.string().optional(),
      source_ref: z.string().optional(),
      // M81 P4 (2026-05-26) — long-lived workitem branch. workgraph-api
      // computes `wi/<workItemCode>` and sends it via workitem_branch
      // (snake_case); ensureWorkspaceSource aligns the worktree HEAD
      // with this branch so every stage attempt shares its history.
      workitemBranch: z.string().optional(),
      workitem_branch: z.string().optional(),
      // M92.B (2026-05-27) — Story Intake / no-repo short-circuit. When
      // context-fabric's StageExecutionPolicy says `repo_access=false`
      // (canonical case: PRODUCT_OWNER intake — STORY_ONLY context_policy
      // + tool_policy=NONE), set this to false to skip workspace
      // materialization entirely. CF's tool gateway should already
      // refuse any repo-touching tool in this state; if one slips
      // through, the dispatch below refuses with
      // WORKSPACE_DISABLED_BY_POLICY (defence-in-depth).
      repo_access: z.boolean().optional(),
      repoAccess: z.boolean().optional(),
    })
    .default({}),
});

/**
 * (2026-05-25) Lenient arg-name normalization.
 *
 * Models routinely emit camelCase / snake_case / "common name" aliases
 * even when the tool's input_schema declares a specific field name.
 * Claude haiku, GPT, and Copilot all have ingrained habits from other
 * MCP-style toolkits (VS Code MCP, Cursor, gh copilot CLI) that use
 * `filePath` / `file_path` / `diff` / `contents` etc. The model emits
 * those aliases, the tool handler reads `args.path` (or whatever the
 * canonical name is), gets `undefined`, and returns
 * "path is required" — wasting a turn AND the agent has to figure out
 * which spelling to try next.
 *
 * Rather than play whack-a-mole at each tool handler OR force a stricter
 * schema validation (which Anthropic's input_schema doesn't strictly
 * enforce anyway — it's a hint), we normalize aliases ONCE here, before
 * dispatch. The canonical name wins when both are present. Aliases that
 * don't apply to the target tool are harmlessly ignored by handlers
 * that don't read them.
 *
 * Discovered by the 2026-05-25 develop-stage RCA: 8 of 15 mutation
 * tool calls failed with "path is required" because Claude emitted
 * `filePath` instead of `path`. Same model produced perfect
 * `oldText`/`newText` shape — only the path alias was wrong.
 */
const ARG_ALIASES: Record<string, string[]> = {
  // Path aliases — every file-targeting tool needs this.
  path: ["filePath", "file_path", "filepath", "file"],
  // Patch aliases — apply_patch.
  patch: ["diff", "unified_diff", "unifiedDiff", "patchContent", "patch_content"],
  // Content aliases — write_file.
  content: ["contents", "body", "fileContent", "file_content", "text"],
  // replace_text — both halves can come in snake_case.
  oldText: ["old_text", "oldtext", "before", "search"],
  newText: ["new_text", "newtext", "after", "replace"],
  // replace_range — line numbers.
  startLine: ["start_line", "startline", "from", "fromLine", "from_line"],
  endLine: ["end_line", "endline", "to", "toLine", "to_line"],
  replacement: ["replacement_text", "replacementText", "newContent", "new_content"],
};

export function normalizeToolArgs(args: Record<string, unknown>): {
  normalized: Record<string, unknown>;
  applied: Array<{ from: string; to: string }>;
} {
  const out: Record<string, unknown> = { ...args };
  const applied: Array<{ from: string; to: string }> = [];
  for (const [canonical, aliases] of Object.entries(ARG_ALIASES)) {
    // Canonical already present (non-null/undefined/empty-string)? Keep it.
    if (out[canonical] !== undefined && out[canonical] !== null && out[canonical] !== "") {
      continue;
    }
    for (const alias of aliases) {
      if (out[alias] !== undefined && out[alias] !== null) {
        out[canonical] = out[alias];
        applied.push({ from: alias, to: canonical });
        break;
      }
    }
  }
  return { normalized: out, applied };
}

// M75 Slice 2 — outcome of one tool-run dispatch, in the shape both the
// HTTP route and the WebSocket bridge expect to wrap (HTTP nests under
// `data`; WS wraps inside ResponseFrame.payload). Either transport
// translates this to its envelope; the runner itself is transport-
// agnostic.
export interface ToolRunOutcome {
  result: unknown;
  durationMs: number;
  toolInvocationId: string;
  toolSuccess: boolean;
  toolError: string | null;
}

/**
 * M75 Slice 2 — transport-neutral tool runner. Pulled out of the HTTP
 * route so the laptop bridge (relay-client) can dispatch tool-run
 * frames against the same code path. The HTTP route + WS handler
 * become thin envelope-translators around this function.
 *
 * Throws AppError on validation / lookup failures. Throws on tool
 * execution failure — the caller wraps as a 500 (HTTP) or an error
 * ResponseFrame (WS). Tool-reported failures (where the tool
 * executed but returned success=false) come back inside the
 * ToolRunOutcome with toolSuccess=false + toolError populated, NOT
 * as a throw.
 *
 * Accepts the parsed ToolRunSchema body (NOT raw JSON) so callers
 * can run their own schema validation upstream — both the HTTP route
 * (via ToolRunSchema.safeParse on req.body) and the WS handler (via
 * ToolRunPayload.parse on the frame payload) do this.
 */
export async function runToolByName(body: z.infer<typeof ToolRunSchema>): Promise<ToolRunOutcome> {
  const handler = getLocalTool(body.tool_name);
  if (!handler) {
    throw new NotFoundError(`tool '${body.tool_name}' not in local registry`);
  }

  const workItemId = body.work_item_id ?? body.workspace_id ?? undefined;
  const correlation = {
    ...body.run_context,
    workItemId,
    mcpInvocationId: uuidv4(),
  };

  const attemptId = body.run_context.attemptId ?? body.run_context.attempt_id;
  const workspaceRoot = workspaceRootForRunContext({
    workItemId,
    workItemCode: body.run_context.workItemCode,
    branchName: body.run_context.branchName,
    workspaceRoot: body.run_context.workspaceRoot,
    attemptId,
  });

  // (2026-05-24) Workspace source materialization. The legacy
  // /mcp/invoke endpoint did this before every agent loop; the new
  // /mcp/tool-run path inherited none of it after the M71 cutover,
  // leaving every tool to run against an empty sandbox. The materializer
  // is idempotent (no-op when the workspace already has the right git
  // remote and is clean), so calling it on every tool dispatch costs
  // ~one git status check on the warm path and a one-time clone on the
  // cold path. Without this, repo_map/list_indexed_files/read_file all
  // see zero files and the ARCHITECT/DEVELOPER stages stall asking for
  // clarification because they can't see the source.
  const sourceType =
    body.run_context.sourceType ?? body.run_context.source_type;
  const sourceUri =
    body.run_context.sourceUri ?? body.run_context.source_uri;
  const sourceRef =
    body.run_context.sourceRef ?? body.run_context.source_ref;
  // M81 P4 (2026-05-26) — Long-lived workitem branch. workgraph-api now
  // sends `workitem_branch: wi/<workItemCode>` for every stage attempt
  // so the source-materializer (P1) aligns the worktree HEAD with this
  // branch — preserving cross-stage continuity. Accept the camelCase
  // alias too in case future callers normalize differently.
  const workitemBranch =
    body.run_context.workitemBranch ?? body.run_context.workitem_branch;

  // M92.B (2026-05-27) — Story Intake / no-repo short-circuit. When CF
  // signals `repo_access=false` (workflow's StageExecutionPolicy says
  // STORY_ONLY / tool_policy=NONE) we MUST NOT clone or materialise
  // anything. The git-clone runs as a slow no-op on intake stages
  // that have no source repo URI at all; worse, when an intake stage
  // happens to inherit a sourceUri from upstream state, materialising
  // pollutes the sandbox for a stage that's supposed to be context-only.
  //
  // Defence-in-depth: if a repo-touching tool slips past CF's gateway
  // and gets dispatched in this mode, refuse it with a structured
  // error rather than silently letting it operate on an empty sandbox.
  // CF's policy filter (stage_execution_policy._filter_phase_tools)
  // already strips read/mutate/run/finalize tools when repo_access is
  // False, so this branch should only ever fire if something upstream
  // is misconfigured.
  const repoAccessDisabled =
    body.run_context.repo_access === false ||
    body.run_context.repoAccess === false;
  if (repoAccessDisabled && !isWorkspaceIndependentTool(body.tool_name)) {
    throw new AppError(
      `Cannot dispatch tool=${body.tool_name} — repo_access is disabled by ` +
      `stage policy (story-only / no-repo stage). This tool needs the ` +
      `workspace, which the workflow has refused to materialise for this ` +
      `stage. If this tool genuinely should run on a context-only stage, ` +
      `change its category to analyzer/verify_meta in tools.json.`,
      403,
      "WORKSPACE_DISABLED_BY_POLICY",
      { tool_name: body.tool_name, repo_access: false },
    );
  }

  const start = Date.now();
  try {
    const r = await withSandboxRoot(workspaceRoot, async () => {
      if (sourceUri && !repoAccessDisabled) {
        try {
          await ensureWorkspaceSource(
            { sourceType, sourceUri, sourceRef, workitemBranch },
            correlation,
          );
        } catch (err) {
          const reason = (err as Error).message;
          // M90.C — selective fail-fast. Pre-M90.C this branch logged
          // and continued for EVERY tool. Repo-dependent tools then
          // ran against an empty/stale workspace and produced
          // misleading "success" — apply_patch with no target file,
          // run_test against an empty src/, etc. Now: tools that
          // we KNOW are workspace-independent (parsers, synthesizers,
          // classifiers) still continue; everything else refuses with
          // a structured error so the agent gets a clear signal and
          // the operator sees the materialization failure surfaced
          // instead of swallowed.
          // eslint-disable-next-line no-console
          console.warn(
            `[tool-run] ensureWorkspaceSource failed (tool=${body.tool_name}): ${reason}`,
          );
          if (!isWorkspaceIndependentTool(body.tool_name)) {
            throw new AppError(
              `Cannot dispatch tool=${body.tool_name} — workspace materialization failed: ${reason}. ` +
              `This tool requires a materialized repo workspace; running it against an empty sandbox ` +
              `would produce misleading results. Retry the stage once the source-materializer issue ` +
              `is resolved, or expand isWorkspaceIndependentTool() if this tool genuinely doesn't ` +
              `need the workspace.`,
              503,
              "WORKSPACE_MATERIALIZATION_FAILED",
              { tool_name: body.tool_name, cause: reason },
            );
          }
        }
        // (2026-05-24) AST index bootstrap. Mirrors the legacy
        // /mcp/invoke path (invoke.ts:3021 "invoke_start" call) so
        // repo_map / symbol_search / list_indexed_files actually see
        // the files we just materialized. Without this, the agent gets
        // `totals.indexedFiles: 0` even when the workspace has real
        // source files on disk and concludes the workspace is empty.
        // indexWorkspace is idempotent — re-walking the tree is cheap
        // on the warm path and the upsert per file is the same cost as
        // the first call.
        try {
          await indexWorkspace("tool_run_bootstrap");
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[tool-run] indexWorkspace failed (tool=${body.tool_name}): ${(err as Error).message}`,
          );
        }
      }
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
      // (2026-05-25) Normalize common arg-name aliases before dispatch.
      // The model sometimes emits `filePath` instead of `path`, `diff`
      // instead of `patch`, etc. Without this every alias mismatch
      // burned a turn on "path is required" errors. We mutate body.args
      // in place so the local audit record + tool handler + output all
      // see the same normalized shape, then log when the normalization
      // actually fired so operators can spot misbehaving models.
      const { normalized, applied } = normalizeToolArgs(body.args);
      if (applied.length > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[tool-run] normalized args for tool=${body.tool_name}: ${applied.map((a) => `${a.from}->${a.to}`).join(", ")}`,
        );
        body.args = normalized;
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

    return {
      result: r.output,
      durationMs,
      toolInvocationId: rec.id,
      toolSuccess: r.success,
      toolError: r.error ?? null,
    };
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
}

toolRunRouter.post("/tool-run", async (req, res) => {
  const parsed = ToolRunSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError("invalid /mcp/tool-run payload", 400, "VALIDATION_ERROR", parsed.error.flatten());
  }

  // M75 Slice 2 — both transports share runToolByName. HTTP wraps the
  // outcome in {success: true, data: ...}; the WS handler in
  // relay-client wraps it inside a ResponseFrame.payload. The dispatch
  // logic itself is identical.
  const outcome = await runToolByName(parsed.data);
  res.json({
    success: true,
    data: {
      result: outcome.result,
      durationMs: outcome.durationMs,
      toolInvocationId: outcome.toolInvocationId,
      toolSuccess: outcome.toolSuccess,
      toolError: outcome.toolError,
    },
    requestId: res.locals.requestId,
  });
});
