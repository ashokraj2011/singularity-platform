/**
 * M45 — Loop-trace endpoint folds the existing by-trace records into the
 * structured timeline shape the workbench Loop tab consumes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { recordLlmCall, recordToolInvocation } from "../src/audit/store";

let server: http.Server;
let baseUrl = "";
// Use a unique-per-run trace id so seeding doesn't collide with other test
// files that share the in-process audit store ring buffer.
const TRACE_ID = `trace-m45-test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const MCP_INV = `mcp-inv-m45-test-${Date.now()}`;

beforeAll(async () => {
  process.env.MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN ?? "test-bearer-token-12345-min-16-chars";
  process.env.LLM_GATEWAY_URL = process.env.LLM_GATEWAY_URL ?? "mock";
  const { app } = await import("../src/app");
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Helper: small delay between seeds so timestamps don't collide. The
  // attribution logic walks events in chronological order — synchronous
  // recording in production interleaves with real tool latencies, so we
  // mimic that by sleeping ~3ms between record calls.
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // Seed a synthetic trace: PLAN_DRAFT → ACT → VERIFY across 3 LLM calls.
  recordLlmCall({
    correlation: { traceId: TRACE_ID, mcpInvocationId: MCP_INV },
    provider: "anthropic", model: "claude-sonnet-4-5", model_alias: "sonnet",
    input_tokens: 1200, output_tokens: 80, latency_ms: 600,
    prompt_messages_count: 3, finish_reason: "tool_call",
    step_index: 0, phase: "PLAN_DRAFT",
    prompt_messages_preview: [
      { role: "system", content_preview: "You are a developer agent..." },
      { role: "user", content_preview: "Add containsACharacter operator" },
    ],
    response_text: "",
    response_tool_calls: [{ name: "index_workspace", args_preview: "" }],
  });
  await wait(3);
  recordToolInvocation({
    correlation: { traceId: TRACE_ID, mcpInvocationId: MCP_INV },
    tool_name: "index_workspace",
    args: {}, output: { indexedFiles: 42, indexedSymbols: 380 },
    success: true, latency_ms: 150,
  });
  await wait(3);
  recordLlmCall({
    correlation: { traceId: TRACE_ID, mcpInvocationId: MCP_INV },
    provider: "anthropic", model: "claude-sonnet-4-5", model_alias: "sonnet",
    input_tokens: 1400, output_tokens: 120, latency_ms: 700,
    prompt_messages_count: 5, finish_reason: "tool_call",
    step_index: 1, phase: "ACT",
    prompt_messages_preview: [
      { role: "system", content_preview: "Phase: ACT (1/10)" },
    ],
    response_tool_calls: [{ name: "apply_patch", args_preview: "patch=..." }],
  });
  await wait(3);
  recordToolInvocation({
    correlation: { traceId: TRACE_ID, mcpInvocationId: MCP_INV },
    tool_name: "apply_patch",
    args: { patch: "diff..." }, output: { kind: "code_change", paths_touched: ["Operator.java"] },
    success: true, latency_ms: 80,
  });
  await wait(3);
  recordLlmCall({
    correlation: { traceId: TRACE_ID, mcpInvocationId: MCP_INV },
    provider: "anthropic", model: "claude-sonnet-4-5", model_alias: "sonnet",
    input_tokens: 1500, output_tokens: 60, latency_ms: 500,
    prompt_messages_count: 7, finish_reason: "stop",
    step_index: 2, phase: "VERIFY",
    response_text: "All tests pass.",
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("M45 GET /mcp/audit/loop-trace/:traceId", () => {
  it("requires bearer auth", async () => {
    const res = await fetch(`${baseUrl}/mcp/audit/loop-trace/${TRACE_ID}`);
    expect(res.status).toBe(401);
  });

  it("returns the structured timeline", async () => {
    const res = await fetch(`${baseUrl}/mcp/audit/loop-trace/${TRACE_ID}`, {
      headers: { authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      data: {
        traceId: string;
        phases: Array<{ phase: string; llmCallCount: number; toolInvocationCount: number }>;
        steps: Array<{ stepIndex: number | null; phase: string | null; toolInvocations: unknown[] }>;
        summary: { totalSteps: number; totalToolInvocations: number; changedPaths: string[] };
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.traceId).toBe(TRACE_ID);

    // 3 LLM calls → 3 steps
    expect(body.data.steps).toHaveLength(3);
    expect(body.data.steps[0].stepIndex).toBe(0);
    expect(body.data.steps[0].phase).toBe("PLAN_DRAFT");
    expect(body.data.steps[1].phase).toBe("ACT");
    expect(body.data.steps[2].phase).toBe("VERIFY");

    // Each step has its tool invocations attached
    expect(body.data.steps[0].toolInvocations).toHaveLength(1);
    expect(body.data.steps[1].toolInvocations).toHaveLength(1);
    expect(body.data.steps[2].toolInvocations).toHaveLength(0);

    // Phase summary: three distinct phases
    expect(body.data.phases.map((p) => p.phase)).toEqual(["PLAN_DRAFT", "ACT", "VERIFY"]);
    expect(body.data.phases[0].llmCallCount).toBe(1);
    expect(body.data.phases[0].toolInvocationCount).toBe(1);

    // Summary counts
    expect(body.data.summary.totalSteps).toBe(3);
    expect(body.data.summary.totalToolInvocations).toBe(2);
  });

  it("returns an empty timeline for an unknown trace", async () => {
    const res = await fetch(`${baseUrl}/mcp/audit/loop-trace/unknown-trace-xyz`, {
      headers: { authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { steps: unknown[]; phases: unknown[] } };
    expect(body.data.steps).toEqual([]);
    expect(body.data.phases).toEqual([]);
  });
});
