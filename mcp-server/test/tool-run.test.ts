/**
 * M71 Slice D — /mcp/tool-run endpoint tests.
 *
 * The dumb tool-runner. context-fabric calls this after the policy chokepoint
 * (PhaseToolForbidden checks) has cleared the dispatch. We only test the
 * endpoint's contract here:
 *
 *   - auth is enforced
 *   - bad payloads → 400 with structured error
 *   - unknown tool name → 404
 *   - happy path returns { result, durationMs, toolInvocationId }
 *   - tool-level failures (handler returns success=false) are surfaced
 *     via `toolSuccess: false` rather than 500
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { registerLocalTool } from "../src/tools/registry";

let server: http.Server;
let baseUrl = "";
let countedInvocations = 0;

beforeAll(async () => {
  // Match discovery-api.test.ts: only set if not already provided. config.ts
  // reads MCP_BEARER_TOKEN at module-load, before beforeAll runs — so a
  // hardcoded literal in this file wouldn't match the loaded config.
  process.env.MCP_BEARER_TOKEN =
    process.env.MCP_BEARER_TOKEN ?? "test-bearer-token-12345-min-16-chars";
  process.env.LLM_GATEWAY_URL = process.env.LLM_GATEWAY_URL ?? "mock";
  process.env.MCP_SANDBOX_ROOT = process.env.MCP_SANDBOX_ROOT ?? process.cwd();

  // Register a couple of fake tools so we don't depend on the real
  // registry being primed.
  registerLocalTool({
    name: "test_echo",
    description: "Echo args back as output. M71 test fixture.",
    inputSchema: { type: "object" },
    async execute(args: Record<string, unknown>) {
      return { success: true, output: { echoed: args } };
    },
  });
  registerLocalTool({
    name: "test_failing",
    description: "Always returns success=false. M71 test fixture.",
    inputSchema: { type: "object" },
    async execute() {
      return { success: false, output: null, error: "intentional failure" };
    },
  });
  registerLocalTool({
    name: "test_counted",
    description: "Counts executions. Capability-gate test fixture.",
    inputSchema: { type: "object" },
    async execute(args: Record<string, unknown>) {
      countedInvocations += 1;
      return { success: true, output: { echoed: args } };
    },
  });

  const { app } = await import("../src/app");
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("POST /mcp/tool-run", () => {
  it("requires bearer auth", async () => {
    const res = await fetch(`${baseUrl}/mcp/tool-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_name: "test_echo", args: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects missing tool_name with 400", async () => {
    const res = await fetch(`${baseUrl}/mcp/tool-run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 for unknown tool name", async () => {
    const res = await fetch(`${baseUrl}/mcp/tool-run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
      body: JSON.stringify({ tool_name: "this_tool_does_not_exist", args: {} }),
    });
    expect(res.status).toBe(404);
  });

  it("dispatches happy-path tool and returns {result, durationMs, toolInvocationId}", async () => {
    const res = await fetch(`${baseUrl}/mcp/tool-run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
      body: JSON.stringify({
        tool_name: "test_echo",
        args: { foo: "bar" },
        work_item_id: "wi-123",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.result).toEqual({ echoed: { foo: "bar" } });
    expect(typeof body.data.durationMs).toBe("number");
    expect(body.data.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof body.data.toolInvocationId).toBe("string");
    expect(body.data.toolSuccess).toBe(true);
    expect(body.data.toolError).toBeNull();
  });

  it("surfaces tool-level failure via toolSuccess=false, not 500", async () => {
    // The semantic contract: an endpoint-level error (e.g. crashed handler)
    // is 500, but a tool that ran cleanly and reported success=false is 200
    // with toolSuccess=false. This lets context-fabric distinguish the two
    // failure modes without inspecting the error message.
    const res = await fetch(`${baseUrl}/mcp/tool-run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
      body: JSON.stringify({ tool_name: "test_failing", args: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.toolSuccess).toBe(false);
    expect(body.data.toolError).toBe("intentional failure");
    expect(body.data.result).toBeNull();
  });

  it("accepts workspace_id as an alias for work_item_id", async () => {
    // Sandbox routing should treat either field as the workspace identity.
    const res = await fetch(`${baseUrl}/mcp/tool-run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
      body: JSON.stringify({
        tool_name: "test_echo",
        args: { x: 1 },
        workspace_id: "ws-456",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.result).toEqual({ echoed: { x: 1 } });
  });

  it("refuses tools denied by the effective agent profile capability set", async () => {
    countedInvocations = 0;
    const res = await fetch(`${baseUrl}/mcp/tool-run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
      body: JSON.stringify({
        tool_name: "test_counted",
        args: { x: 1 },
        run_context: {
          profileSnapshotHash: "profile-sha",
          effectiveCapabilities: [
            { id: "test_counted", permissions: ["read"] },
          ],
        },
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("EFFECTIVE_CAPABILITY_DENIED");
    expect(body.error?.details?.reason).toBe("missing invoke");
    expect(countedInvocations).toBe(0);
  });

  it("accepts effective capabilities with snake_case ids and object permissions", async () => {
    countedInvocations = 0;
    const res = await fetch(`${baseUrl}/mcp/tool-run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
      body: JSON.stringify({
        tool_name: "test_counted",
        args: { x: 1 },
        run_context: {
          profile_snapshot_hash: "profile-sha",
          effective_capabilities: [
            {
              capability_id: "test_counted",
              permissions: { read: true, invoke: true, edit: false },
            },
          ],
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.toolSuccess).toBe(true);
    expect(countedInvocations).toBe(1);
  });

  it("refuses tools when a profile-backed run requires an unresolved effective capability set", async () => {
    countedInvocations = 0;
    const res = await fetch(`${baseUrl}/mcp/tool-run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
      body: JSON.stringify({
        tool_name: "test_counted",
        args: { x: 1 },
        run_context: {
          profileSnapshotHash: "profile-sha",
          effectiveCapabilities: [],
          effectiveCapabilitiesRequired: true,
        },
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("EFFECTIVE_CAPABILITY_DENIED");
    expect(body.error?.details?.reason).toBe("effective capability set required");
    expect(countedInvocations).toBe(0);
  });

  it("fails closed for profile-backed tool-runs when effective capabilities are omitted", async () => {
    countedInvocations = 0;
    const res = await fetch(`${baseUrl}/mcp/tool-run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
      body: JSON.stringify({
        tool_name: "test_counted",
        args: { x: 1 },
        run_context: {
          profileSnapshotHash: "profile-sha",
        },
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("EFFECTIVE_CAPABILITY_DENIED");
    expect(body.error?.details?.reason).toBe("effective capability set required");
    expect(countedInvocations).toBe(0);
  });

  it("also gates legacy /mcp/tools/call with the effective profile capability set", async () => {
    countedInvocations = 0;
    const res = await fetch(`${baseUrl}/mcp/tools/call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
      body: JSON.stringify({
        name: "test_counted",
        arguments: { y: 2 },
        runContext: {
          profileSnapshotHash: "profile-sha",
          effectiveCapabilities: [
            { id: "test_counted", permissions: ["read"] },
          ],
        },
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("EFFECTIVE_CAPABILITY_DENIED");
    expect(body.error?.details?.reason).toBe("missing invoke");
    expect(countedInvocations).toBe(0);
  });

  it("also fails closed for profile-backed legacy /mcp/tools/call without effective capabilities", async () => {
    countedInvocations = 0;
    const res = await fetch(`${baseUrl}/mcp/tools/call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
      body: JSON.stringify({
        name: "test_counted",
        arguments: { y: 2 },
        runContext: {
          profileSnapshotHash: "profile-sha",
        },
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("EFFECTIVE_CAPABILITY_DENIED");
    expect(body.error?.details?.reason).toBe("effective capability set required");
    expect(countedInvocations).toBe(0);
  });

  it("disables legacy /mcp/tools/call for production-class APP_ENV labels", async () => {
    const priorNodeEnv = process.env.NODE_ENV;
    const priorAppEnv = process.env.APP_ENV;
    const priorAllow = process.env.MCP_ALLOW_GENERIC_TOOLS_CALL;
    process.env.NODE_ENV = "development";
    process.env.APP_ENV = "staging";
    delete process.env.MCP_ALLOW_GENERIC_TOOLS_CALL;
    try {
      const res = await fetch(`${baseUrl}/mcp/tools/call`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
        body: JSON.stringify({
          name: "test_counted",
          arguments: { y: 3 },
          runContext: {},
        }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe("GENERIC_TOOLS_CALL_DISABLED");
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
      if (priorAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = priorAppEnv;
      if (priorAllow === undefined) delete process.env.MCP_ALLOW_GENERIC_TOOLS_CALL;
      else process.env.MCP_ALLOW_GENERIC_TOOLS_CALL = priorAllow;
    }
  });
});
