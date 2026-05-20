import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const configured = process.env.REAL_PROVIDER_SMOKE === "1" && Boolean(process.env.REAL_PROVIDER_MODEL_ALIAS);
const describeSmoke = configured ? describe : describe.skip;

describeSmoke("real-provider MCP coding smoke", () => {
  it("can produce code-change and verification receipts through MCP", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-real-provider-"));
    const oldEnv = { ...process.env };
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({
        scripts: { test: "node --test" },
        type: "module",
      }, null, 2));
      writeFileSync(join(root, "src/value.js"), "export const value = 1;\n");
      writeFileSync(
        join(root, "test/value.test.js"),
        "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.js';\ntest('value is two', () => assert.equal(value, 2));\n",
      );

      vi.resetModules();
      process.env = {
        ...oldEnv,
        NODE_ENV: "test",
        MCP_BEARER_TOKEN: oldEnv.MCP_BEARER_TOKEN ?? "test-bearer-token-12345-min-16-chars",
        LLM_GATEWAY_URL: oldEnv.LLM_GATEWAY_URL ?? "http://localhost:8001",
        MCP_SANDBOX_ROOT: root,
        MCP_COMMAND_EXECUTION_MODE: oldEnv.MCP_COMMAND_EXECUTION_MODE ?? "process",
      };
      const { executeInvokePayload } = await import("../src/mcp/invoke");
      const result = await executeInvokePayload({
        systemPrompt: "You are running a gated smoke test. Use tools only. Change src/value.js so the test passes, then run npm test.",
        history: [],
        message: "Patch src/value.js to export value = 2. Then run npm test. Finish with a short summary.",
        tools: [],
        modelConfig: {
          modelAlias: process.env.REAL_PROVIDER_MODEL_ALIAS,
          temperature: 0,
          maxTokens: 1200,
        },
        runContext: {
          traceId: "real-provider-smoke",
          workflowInstanceId: "real-provider-smoke",
          nodeId: "developer",
          workspaceRoot: root,
        },
        limits: {
          includeLocalTools: true,
          maxSteps: 8,
          timeoutSec: 240,
          compressToolResults: true,
        },
        governanceMode: "fail_closed",
        allowAutonomousMutation: true,
      });

      expect(result.status).toBe("COMPLETED");
      expect((result.correlation as Record<string, unknown>).codeChangeIds).toEqual(expect.arrayContaining([expect.any(String)]));
      expect(result.verificationReceipts).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "verification_result", passed: true }),
      ]));
    } finally {
      process.env = oldEnv;
      rmSync(root, { recursive: true, force: true });
      vi.resetModules();
    }
  }, 300_000);
});

if (!configured) {
  it.skip("real provider smoke not configured; set REAL_PROVIDER_SMOKE=1 and REAL_PROVIDER_MODEL_ALIAS=<alias>", () => {});
}
