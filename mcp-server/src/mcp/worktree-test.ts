// M83 S3 (2026-05-26) — Worktree test runner with SSE-streamed result.
//
// Lets the workbench fire `mvn test` / `pytest` / `npm test` (etc.)
// against the workitem's wi/<code> worktree and stream the output back.
// Reuses the existing mcp-sandbox-runner via callSandboxRunner — which
// now has the persistent .m2 cache from f47efd2, so warm test runs land
// in seconds instead of minutes.
//
// Wire format: text/event-stream with three event types:
//   event: started   — once, with run metadata
//   event: stdout    — final stdout / stderr blob (v1 buffers; the spec
//                      calls for true line streaming once the runner
//                      itself chunks. The wire format is stable so v2
//                      drops in without breaking clients.)
//   event: finished  — once, with exit code + duration + receipt
//
// Authenticated via the parent /mcp/ middleware (bearer + scope). The
// workitemCode and command are validated server-side; only the runner's
// existing ALLOWED_COMMANDS allowlist can run (mvn, gradle, pytest,
// npm, pnpm, yarn, go, cargo, dotnet, make, node, python, python3, git,
// rg, gradlew). No shell metacharacters.

import { Router } from "express";
import * as path from "node:path";
import * as fs from "node:fs";
import { z } from "zod";

import { workspaceRootForRunContext, baseSandboxRoot } from "../workspace/sandbox";
import { callSandboxRunner } from "../tools/runner-client";
import { AppError } from "../shared/errors";
import { config } from "../config";

export const worktreeTestRouter: Router = Router();

// Per-call defaults. The operator-configured ceiling keeps browser-triggered
// worktree tests bounded while still allowing larger enterprise test suites.
const DEFAULT_TIMEOUT_MS = config.MCP_WORKTREE_TEST_DEFAULT_TIMEOUT_MS;
const MAX_TIMEOUT_MS = config.MCP_WORKTREE_TEST_MAX_TIMEOUT_MS;
const MAX_OUTPUT_CHARS = 100_000;

const runTestSchema = z.object({
  command: z.string().min(1).max(40),
  args: z.array(z.string().max(500)).max(64).default([]),
  cwd: z.string().max(500).optional().default("."),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
});

worktreeTestRouter.post("/:workItemCode/run-test", async (req, res, next) => {
  try {
    const params = z.object({ workItemCode: z.string().min(1).max(120) }).parse(req.params);
    const body = runTestSchema.parse(req.body);

    // Resolve the workitem root and confirm it exists; the runner's
    // workspace cwd is *relative to the sandbox root* (so the host
    // bind-mount lines up between the host docker daemon and the
    // sandbox-runner). We compute the runner-cwd as the relative path
    // from the sandbox base to the workitem root + the requested
    // subdir. This mirrors what mcp-server's other run_test paths do.
    const workItemRoot = workspaceRootForRunContext({ workItemCode: params.workItemCode });
    if (!fs.existsSync(workItemRoot) || !fs.statSync(workItemRoot).isDirectory()) {
      throw new AppError(
        `Workitem ${params.workItemCode} has no materialized worktree at ${workItemRoot}. ` +
          `Run develop or qa-review at least once so wi/${params.workItemCode} gets checked out.`,
        404,
      );
    }
    const sandboxRoot = baseSandboxRoot();
    const subCwd = body.cwd.split("/").filter(Boolean).join("/") || ".";
    const candidateAbs = path.resolve(workItemRoot, subCwd);
    const rel = path.relative(workItemRoot, candidateAbs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new AppError("cwd escapes the workitem root", 400);
    }
    const runnerCwd = path.relative(sandboxRoot, candidateAbs);
    if (runnerCwd.startsWith("..") || path.isAbsolute(runnerCwd)) {
      throw new AppError("workitem root is not inside the sandbox root", 500);
    }

    const startedAt = Date.now();
    const runId = `worktree-run-${startedAt}-${Math.random().toString(36).slice(2, 10)}`;
    const timeoutMs = body.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Set up SSE response. text/event-stream + flush headers so the
    // browser's EventSource begins listening before the long-running
    // runner call lands.
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      // .flush() is express's optional Node-side hint; we lean on the
      // headers above plus the empty newline pair to push.
      (res as unknown as { flush?: () => void }).flush?.();
    };

    sendEvent("started", {
      runId,
      workItemCode: params.workItemCode,
      commandPreview: `${body.command} ${body.args.join(" ")}`.trim(),
      cwd: runnerCwd,
      timeoutMs,
    });

    try {
      const result = (await callSandboxRunner({
        command: body.command,
        args: body.args,
        cwd: runnerCwd,
        timeoutMs,
        maxOutputChars: MAX_OUTPUT_CHARS,
      })) as {
        kind?: string;
        verification_kind?: string;
        command?: string;
        cwd?: string;
        exit_code?: number;
        passed?: boolean;
        timed_out?: boolean;
        duration_ms?: number;
        stdout_excerpt?: string;
        stderr_excerpt?: string;
      };

      // v1: emit the full stdout/stderr as a single chunk per stream.
      // The wire format already speaks "stdout" + "stderr" events, so
      // when the runner gains chunked streaming the client doesn't
      // need to change.
      if (result.stdout_excerpt) {
        sendEvent("stdout", { line: result.stdout_excerpt });
      }
      if (result.stderr_excerpt) {
        sendEvent("stderr", { line: result.stderr_excerpt });
      }

      sendEvent("finished", {
        runId,
        exitCode: typeof result.exit_code === "number" ? result.exit_code : null,
        passed: result.passed === true,
        timedOut: result.timed_out === true,
        durationMs: typeof result.duration_ms === "number" ? result.duration_ms : Date.now() - startedAt,
        // Echo back the runner-style receipt so the workbench can
        // persist it on the latest attempt's verificationReceipts
        // array (follow-up; v1 just renders it inline).
        verificationReceipt: {
          kind: result.kind ?? "verification_result",
          verification_kind: result.verification_kind ?? "command",
          command: result.command ?? `${body.command} ${body.args.join(" ")}`,
          cwd: result.cwd ?? runnerCwd,
          passed: result.passed === true,
          exit_code: result.exit_code ?? null,
          duration_ms: result.duration_ms ?? Date.now() - startedAt,
          origin: "human",
        },
      });
    } catch (runErr) {
      const message = runErr instanceof Error ? runErr.message : String(runErr);
      sendEvent("finished", {
        runId,
        exitCode: null,
        passed: false,
        timedOut: message.includes("timeout") || message.includes("Timed out"),
        durationMs: Date.now() - startedAt,
        error: message,
      });
    } finally {
      res.end();
    }
  } catch (err) {
    next(err);
  }
});
