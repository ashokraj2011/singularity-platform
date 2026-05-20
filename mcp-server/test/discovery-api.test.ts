import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

let server: http.Server;
let baseUrl = "";

beforeAll(async () => {
  process.env.MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN ?? "test-bearer-token-12345-min-16-chars";
  process.env.LLM_GATEWAY_URL = process.env.LLM_GATEWAY_URL ?? "mock";
  process.env.MCP_SANDBOX_ROOT = process.env.MCP_SANDBOX_ROOT ?? process.cwd();
  const { app } = await import("../src/app");
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("GET /mcp/discovery", () => {
  it("requires bearer auth", async () => {
    const res = await fetch(`${baseUrl}/mcp/discovery`);
    expect(res.status).toBe(401);
  });

  it("returns standardized endpoint, tool, and schema metadata", async () => {
    const res = await fetch(`${baseUrl}/mcp/discovery`, {
      headers: { authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      data: {
        kind: string;
        schemaVersion: string;
        capabilities: Record<string, unknown>;
        endpoints: Array<{ id: string; path: string; auth: string }>;
        tools: Array<{ name: string; description: string; input_schema: unknown; execution_target: string; tags?: string[] }>;
        delegation?: Record<string, unknown>;
        schemas: {
          toolDescriptor?: { required?: string[]; properties?: Record<string, unknown> };
          invokeRequest?: unknown;
        };
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.kind).toBe("singularity.mcp.discovery");
    expect(body.data.schemaVersion).toBe("1.0.0");
    expect(body.data.endpoints.some((endpoint) => endpoint.path === "/mcp/invoke")).toBe(true);
    expect(body.data.endpoints.some((endpoint) => endpoint.path === "/mcp/discovery")).toBe(true);
    expect(body.data.endpoints.some((endpoint) => endpoint.path === "/mcp/workspaces/stats")).toBe(true);
    expect(body.data.tools.some((tool) => tool.name === "apply_patch" && tool.execution_target === "LOCAL")).toBe(true);
    expect(body.data.tools.some((tool) => tool.name === "verification_unavailable" && tool.execution_target === "LOCAL")).toBe(true);
    expect(body.data.tools.every((tool) => Array.isArray(tool.tags))).toBe(true);
    expect(body.data.capabilities.workspaceStorageStats).toBe(true);
    expect(body.data.capabilities.serverToolDelegation).toBe(true);
    expect(body.data.delegation).toBeTruthy();
    expect(body.data.schemas.toolDescriptor?.required).toContain("execution_target");
    expect(body.data.schemas.toolDescriptor?.properties?.tags).toBeTruthy();
    expect(body.data.schemas.toolDescriptor).toBeTruthy();
    expect(body.data.schemas.invokeRequest).toBeTruthy();
  });

  it("returns workspace storage stats for Operations", async () => {
    const res = await fetch(`${baseUrl}/mcp/workspaces/stats`, {
      headers: { authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      data: {
        baseSandboxRoot: string;
        workItemWorkspacesRoot: string;
        sourceCacheRoot: string;
        totalManagedBytes: number;
        quotaBytes: number | null;
        quotaUsedPercent: number | null;
        gc: { enabled: boolean };
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.baseSandboxRoot).toBeTruthy();
    expect(body.data.workItemWorkspacesRoot).toBeTruthy();
    expect(body.data.sourceCacheRoot).toBeTruthy();
    expect(typeof body.data.totalManagedBytes).toBe("number");
    expect(body.data.gc).toBeTruthy();
  });
});
