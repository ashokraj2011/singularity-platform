import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("finish_work_branch formal verification gate", () => {
  it("blocks the commit and preserves the dirty workspace when the verifier returns SAT", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "mcp-formal-"));
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        result: "SAT",
        riskLevel: "HIGH",
        explanation: "verification receipt policy is violated",
        counterexample: { verificationReceiptPassed: false },
      }));
    });
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    const address = server.address() as AddressInfo;

    process.env.MCP_BEARER_TOKEN = "test-bearer-token-12345-min-16-chars";
    process.env.LLM_GATEWAY_URL = "mock";
    process.env.MCP_SANDBOX_ROOT = tempRoot;
    process.env.FORMAL_VERIFICATION_ENABLED = "true";
    process.env.FORMAL_VERIFIER_URL = `http://127.0.0.1:${address.port}`;
    process.env.FORMAL_VERIFICATION_TIMEOUT_MS = "2000";

    const { withSandboxRoot } = await import("../src/workspace/sandbox");
    const { ensureGitRepo, finishWorkBranch, dirtyPaths } = await import("../src/workspace/git-workspace");

    await withSandboxRoot(tempRoot, async () => {
      await ensureGitRepo();
      writeFileSync(join(tempRoot!, "policy.ts"), "export const allowed = false;\n", "utf8");

      const result = await finishWorkBranch("formal gate test", {
        verificationReceipts: [{ kind: "verification_result", command: "npm test", passed: false }],
      });

      expect(result.committed).toBe(false);
      expect(result.formalVerificationBlocked).toBe(true);
      expect(result.formalVerification).toMatchObject({
        kind: "verification_result",
        verification_kind: "formal",
        passed: false,
        result: "SAT",
      });
      expect(await dirtyPaths()).toContain("policy.ts");
    });
  });

  it("feeds formal verifier feedback back into the loop and commits after repair", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "mcp-formal-loop-"));
    let formalCalls = 0;
    server = http.createServer((req, res) => {
      if (req.url?.startsWith("/api/v1/verification/verify")) {
        formalCalls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        if (formalCalls === 1) {
          res.end(JSON.stringify({
            result: "SAT",
            riskLevel: "HIGH",
            explanation: "bad value violates the policy",
            counterexample: { file: "policy.ts", value: "bad" },
            recommendations: [{ action: "set value to repaired" }],
          }));
          return;
        }
        res.end(JSON.stringify({
          result: "UNSAT",
          riskLevel: "LOW",
          explanation: "no violation remains",
        }));
        return;
      }

      if (req.url?.startsWith("/v1/chat/completions")) {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
          const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: string }> };
          const feedbackSeen = body.messages?.some((msg) => msg.content.includes("formal_verification_blocked")) ?? false;
          const alreadyWrote = body.messages?.some((msg) => msg.role === "tool" && msg.content.includes("policy.ts")) ?? false;
          const repaired = body.messages?.some((msg) => msg.role === "tool" && msg.content.includes("repaired")) ?? false;
          const response = feedbackSeen && !repaired
            ? {
                content: "",
                finish_reason: "tool_call",
                tool_calls: [{
                  id: "repair-policy",
                  name: "write_file",
                  args: { path: "policy.ts", content: "export const value = 'repaired';\n", forceFullReplace: true },
                }],
              }
            : alreadyWrote
              ? { content: feedbackSeen ? "repaired after verifier feedback" : "initial edit complete", finish_reason: "stop" }
              : {
                  content: "",
                  finish_reason: "tool_call",
                  tool_calls: [{
                    id: "write-policy",
                    name: "write_file",
                    args: { path: "policy.ts", content: "export const value = 'bad';\n" },
                  }],
                };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            input_tokens: 10,
            output_tokens: 5,
            latency_ms: 1,
            provider: "fake",
            model: "fake-repair",
            ...response,
          }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    process.env.MCP_BEARER_TOKEN = "test-bearer-token-12345-min-16-chars";
    process.env.LLM_GATEWAY_URL = baseUrl;
    process.env.MCP_SANDBOX_ROOT = tempRoot;
    process.env.FORMAL_VERIFICATION_ENABLED = "true";
    process.env.FORMAL_VERIFIER_URL = baseUrl;
    process.env.FORMAL_VERIFICATION_TIMEOUT_MS = "2000";

    const { executeInvokePayload } = await import("../src/mcp/invoke");

    const result = await executeInvokePayload({
      message: "Create the policy file.",
      runContext: {
        workflowInstanceId: "wf-formal-loop",
        nodeId: "dev",
        workItemId: "wi-1",
      },
      tools: [{
        name: "write_file",
        description: "Write a complete file body.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            forceFullReplace: { type: "boolean" },
          },
          required: ["path", "content"],
        },
        execution_target: "LOCAL",
        risk_level: "LOW",
        requires_approval: false,
      }],
      modelConfig: { modelAlias: "fake-repair" },
      allowAutonomousMutation: true,
      limits: { maxSteps: 6, includeLocalTools: false },
    });

    expect(result.status).toBe("COMPLETED");
    expect(formalCalls).toBe(2);
    expect(String(result.finalResponse)).toContain("repaired");
    expect((result.workspace as { workspaceCommitSha?: string }).workspaceCommitSha).toBeTruthy();
    expect((result.verificationReceipts as Array<Record<string, unknown>>).some((receipt) => receipt.result === "SAT")).toBe(true);
    expect((result.verificationReceipts as Array<Record<string, unknown>>).some((receipt) => receipt.result === "UNSAT")).toBe(true);
  });
});
