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

describe("SERVER tool delegation", () => {
  it("routes through Context Fabric and records a delegation receipt", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "mcp-server-delegation-"));
    let delegated = false;
    server = http.createServer((req, res) => {
      if (req.url?.startsWith("/v1/chat/completions")) {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
          const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: string }> };
          const sawToolResult = body.messages?.some((msg) => msg.role === "tool" && msg.content.includes("delegation_receipt")) ?? false;
          const response = sawToolResult
            ? { content: "delegated tool completed", finish_reason: "stop" }
            : {
                content: "",
                finish_reason: "tool_call",
                tool_calls: [{
                  id: "server-echo",
                  name: "remote_echo",
                  args: { text: "hello" },
                }],
              };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            input_tokens: 8,
            output_tokens: 4,
            latency_ms: 1,
            provider: "fake",
            model: "fake-server",
            ...response,
          }));
        });
        return;
      }

      if (req.url === "/internal/mcp/tools/remote_echo/call") {
        delegated = true;
        expect(req.headers["x-service-token"]).toBe("context-service-token");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          status: "success",
          tool_execution_id: "tool-exec-1",
          output: { echoed: "hello" },
          receipt: {
            kind: "delegation_receipt",
            from: "context-fabric",
            to: "tool-service",
            toolExecutionId: "tool-exec-1",
          },
        }));
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
    process.env.CONTEXT_FABRIC_URL = baseUrl;
    process.env.CONTEXT_FABRIC_SERVICE_TOKEN = "context-service-token";

    const { executeInvokePayload } = await import("../src/mcp/invoke");
    const { audit } = await import("../src/audit/store");

    const result = await executeInvokePayload({
      message: "Call the remote echo tool.",
      runContext: {
        traceId: "trace-server-delegation",
        capabilityId: "cap-1",
      },
      tools: [{
        name: "remote_echo",
        description: "Echo through a delegated server tool.",
        input_schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        execution_target: "SERVER",
        risk_level: "LOW",
        requires_approval: false,
        version: "1.0.0",
      }],
      limits: { includeLocalTools: false, maxSteps: 3 },
      allowAutonomousMutation: true,
      modelConfig: { modelAlias: "fake-server" },
    });

    expect(result.status).toBe("COMPLETED");
    expect(delegated).toBe(true);
    const toolIds = (result.correlation as { toolInvocationIds?: string[] }).toolInvocationIds ?? [];
    expect(toolIds).toHaveLength(1);
    const invocation = audit.toolInvocations.byId(toolIds[0]);
    expect(invocation?.output).toMatchObject({
      status: "success",
      delegation_receipt: {
        kind: "delegation_receipt",
        execution_target: "SERVER",
        tool_name: "remote_echo",
        tool_execution_id: "tool-exec-1",
        downstream_receipt: {
          kind: "delegation_receipt",
          from: "context-fabric",
        },
      },
    });
  });
});
