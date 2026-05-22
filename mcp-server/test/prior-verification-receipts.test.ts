/**
 * M66 — Verify that priorVerificationReceipts on a fresh /mcp/invoke payload
 * seeds state.verificationReceipts and survives to the response.
 *
 * Without this knob, blueprint-workbench's multi-stage flow drops receipts
 * between stages: a QA stage's run_test result never reaches the developer
 * stage's auto-finish, and finish_work_branch's formal verifier sees
 * verificationReceiptPresent=False. Caller (workgraph-studio blueprint
 * router) is responsible for accumulating receipts session-wide and
 * threading them in here on every stage.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

let server: http.Server | undefined;
let tempRoot: string | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server?.close((err) => (err ? reject(err) : resolve())));
    server = undefined;
  }
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
  vi.resetModules();
});

describe("M66 — priorVerificationReceipts seeds state.verificationReceipts", () => {
  it("includes prior receipts in the response when caller seeds them", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "mcp-m66-"));

    // Stub LLM gateway that returns "stop" immediately so the loop runs
    // exactly one LLM call and produces a clean response — no tools, no
    // mutations. The test is purely about whether the seeded receipts
    // make it from the invoke body into the response payload.
    server = http.createServer((req, res) => {
      if (!req.url?.startsWith("/v1/chat/completions")) {
        res.writeHead(404);
        res.end();
        return;
      }
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          content: "ok",
          finish_reason: "stop",
          input_tokens: 5,
          output_tokens: 2,
          latency_ms: 1,
          provider: "fake",
          model: "fake-finalizer",
          model_alias: "fake-finalizer",
        }));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    const address = server.address() as AddressInfo;

    process.env.MCP_BEARER_TOKEN = "test-bearer-token-12345-min-16-chars";
    process.env.LLM_GATEWAY_URL = `http://127.0.0.1:${address.port}`;
    process.env.MCP_SANDBOX_ROOT = tempRoot;
    process.env.MCP_WORKSPACE_GC_ENABLED = "false";

    const { executeInvokePayload } = await import("../src/mcp/invoke");

    const priorReceipts = [
      {
        kind: "verification_result",
        verification_kind: "test",
        command: "mvn test -Dtest=RuleEngineServiceTest",
        passed: true,
        exit_code: 0,
        toolInvocationId: "prior-stage-tii-1",
        capturedAt: "2026-05-22T12:00:00.000Z",
      },
      {
        kind: "verification_result",
        verification_kind: "lint",
        command: "mvn checkstyle:check",
        passed: true,
        exit_code: 0,
        toolInvocationId: "prior-stage-tii-2",
        capturedAt: "2026-05-22T12:01:00.000Z",
      },
    ];

    const result = await executeInvokePayload({
      message: "carry receipts forward",
      tools: [],
      limits: { includeLocalTools: false, maxSteps: 1 },
      allowAutonomousMutation: false,
      modelConfig: { modelAlias: "fake-finalizer" },
      priorVerificationReceipts: priorReceipts,
    }) as Record<string, unknown>;

    expect(result.status).toBe("COMPLETED");

    const correlation = result.correlation as Record<string, unknown>;
    const responseReceipts = correlation.verificationReceipts as Array<Record<string, unknown>>;
    expect(responseReceipts).toBeDefined();
    expect(responseReceipts.length).toBeGreaterThanOrEqual(2);

    // The two seeded receipts should be findable in the response. The loop
    // may layer additional receipts on top (baseline-skip, etc.) — only
    // assert presence of the seeded ones, not exact array equality.
    const cmds = responseReceipts.map((r) => r.command);
    expect(cmds).toContain("mvn test -Dtest=RuleEngineServiceTest");
    expect(cmds).toContain("mvn checkstyle:check");

    // Top-level shape too — Blueprint Workbench reads from both paths.
    const topLevel = result.verificationReceipts as Array<Record<string, unknown>>;
    expect(topLevel.map((r) => r.command)).toContain("mvn test -Dtest=RuleEngineServiceTest");
  });

  it("defaults to empty array when priorVerificationReceipts is omitted", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "mcp-m66-empty-"));

    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        content: "ok",
        finish_reason: "stop",
        input_tokens: 5,
        output_tokens: 2,
        latency_ms: 1,
        provider: "fake",
        model: "fake-finalizer",
        model_alias: "fake-finalizer",
      }));
    });
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    const address = server.address() as AddressInfo;

    process.env.MCP_BEARER_TOKEN = "test-bearer-token-12345-min-16-chars";
    process.env.LLM_GATEWAY_URL = `http://127.0.0.1:${address.port}`;
    process.env.MCP_SANDBOX_ROOT = tempRoot;
    process.env.MCP_WORKSPACE_GC_ENABLED = "false";

    const { executeInvokePayload } = await import("../src/mcp/invoke");

    const result = await executeInvokePayload({
      message: "no prior receipts",
      tools: [],
      limits: { includeLocalTools: false, maxSteps: 1 },
      allowAutonomousMutation: false,
      modelConfig: { modelAlias: "fake-finalizer" },
    }) as Record<string, unknown>;

    expect(result.status).toBe("COMPLETED");
    const correlation = result.correlation as Record<string, unknown>;
    const responseReceipts = correlation.verificationReceipts as Array<Record<string, unknown>>;
    // The loop may insert a `baseline_skipped` marker even with no seed,
    // so we only assert that none of our prior-test commands leak through.
    const cmds = responseReceipts.map((r) => r.command).filter(Boolean);
    expect(cmds).not.toContain("mvn test -Dtest=RuleEngineServiceTest");
  });
});
