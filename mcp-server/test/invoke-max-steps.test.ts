import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("read-only max step finalization", () => {
  it("forces a no-tools final response instead of failing max_steps", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "mcp-max-steps-"));
    writeFileSync(join(tempRoot, "notes.txt"), "RuleEngine supports case-insensitive string operators.\n", "utf8");

    let llmCalls = 0;
    let finalizationTools: unknown = null;
    let finalizationSawToolResult = false;
    server = http.createServer((req, res) => {
      if (!req.url?.startsWith("/v1/chat/completions")) {
        res.writeHead(404);
        res.end();
        return;
      }
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        llmCalls += 1;
        const body = JSON.parse(raw) as {
          tools?: unknown[];
          messages?: Array<{ role: string; content: string }>;
        };
        if (llmCalls === 1) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            content: "",
            finish_reason: "tool_call",
            tool_calls: [{
              id: "read-notes",
              name: "read_file",
              args: { path: "notes.txt" },
            }],
            input_tokens: 10,
            output_tokens: 5,
            latency_ms: 1,
            provider: "fake",
            model: "fake-finalizer",
            model_alias: "fake-finalizer",
          }));
          return;
        }

        finalizationTools = body.tools;
        finalizationSawToolResult = body.messages?.some((msg) =>
          msg.role === "tool" && msg.content.includes("case-insensitive string operators")
        ) ?? false;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          content: "Use the gathered evidence to produce the Plan artifact now.",
          finish_reason: "stop",
          input_tokens: 12,
          output_tokens: 8,
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

    const result = await executeInvokePayload({
      message: "Create a concise plan from repository evidence.",
      tools: [{
        name: "read_file",
        description: "Read a sandboxed file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        execution_target: "LOCAL",
        risk_level: "LOW",
        requires_approval: false,
      }],
      limits: { includeLocalTools: false, maxSteps: 1 },
      allowAutonomousMutation: false,
      modelConfig: { modelAlias: "fake-finalizer" },
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.finishReason).toBe("stop");
    expect(result.finalResponse).toBe("Use the gathered evidence to produce the Plan artifact now.");
    expect(llmCalls).toBe(2);
    expect(finalizationTools).toEqual([]);
    expect(finalizationSawToolResult).toBe(true);
  });

  it("forces mutation-only tools when a Developer run exhausts steps without code changes", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "mcp-max-steps-mutate-"));
    writeFileSync(join(tempRoot, "Operator.java"), "enum Operator { CONTAINS }\n", "utf8");

    let llmCalls = 0;
    let forcedTools: string[] = [];
    server = http.createServer((req, res) => {
      if (!req.url?.startsWith("/v1/chat/completions")) {
        res.writeHead(404);
        res.end();
        return;
      }
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        llmCalls += 1;
        const body = JSON.parse(raw) as { tools?: Array<{ name: string }> };
        if (llmCalls === 1) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            content: "",
            finish_reason: "tool_call",
            tool_calls: [{
              id: "read-operator",
              name: "read_file",
              args: { path: "Operator.java" },
            }],
            input_tokens: 10,
            output_tokens: 5,
            latency_ms: 1,
            provider: "fake",
            model: "fake-mutator",
            model_alias: "fake-mutator",
          }));
          return;
        }

        forcedTools = body.tools?.map((tool) => tool.name) ?? [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          content: "",
          finish_reason: "tool_call",
          tool_calls: [{
            id: "patch-operator",
            name: "apply_patch",
            args: {
              patch: [
                "diff --git a/Operator.java b/Operator.java",
                "--- a/Operator.java",
                "+++ b/Operator.java",
                "@@ -1 +1 @@",
                "-enum Operator { CONTAINS }",
                "+enum Operator { CONTAINS, CONTAINS_A_CHARACTER }",
                "",
              ].join("\n"),
            },
          }],
          input_tokens: 12,
          output_tokens: 8,
          latency_ms: 1,
          provider: "fake",
          model: "fake-mutator",
          model_alias: "fake-mutator",
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

    const result = await executeInvokePayload({
      message: "Implement containsACharacter.",
      tools: [
        {
          name: "read_file",
          description: "Read a sandboxed file.",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          execution_target: "LOCAL",
          risk_level: "LOW",
          requires_approval: false,
        },
        {
          name: "apply_patch",
          description: "Apply a patch.",
          input_schema: {
            type: "object",
            properties: { patch: { type: "string" } },
            required: ["patch"],
          },
          execution_target: "LOCAL",
          risk_level: "MEDIUM",
          requires_approval: false,
        },
      ],
      limits: { includeLocalTools: false, maxSteps: 1 },
      allowAutonomousMutation: true,
      modelConfig: { modelAlias: "fake-mutator" },
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.finishReason).toBe("stop");
    expect((result.correlation as { codeChangeIds?: string[] }).codeChangeIds?.length).toBeGreaterThan(0);
    expect(forcedTools).toEqual(["apply_patch"]);
    expect(readFileSync(join(tempRoot, "Operator.java"), "utf8")).toContain("CONTAINS_A_CHARACTER");
  });
});
