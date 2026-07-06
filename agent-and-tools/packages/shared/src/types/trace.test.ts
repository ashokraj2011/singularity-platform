import { describe, expect, it } from "vitest";
import {
  normalizeTraceId,
  requireTraceId,
  traceHeaders,
  traceIdFromParts,
  workflowNodeTraceId,
  SINGULARITY_TRACE_HEADER,
} from "./trace";

describe("trace helpers", () => {
  it("normalizes and preserves existing platform trace ids", () => {
    expect(normalizeTraceId("  wf-run-node-123  ")).toBe("wf-run-node-123");
    expect(normalizeTraceId("blueprint-session-stage")).toBe("blueprint-session-stage");
  });

  it("rejects empty, non-string, nul, and overlong trace ids", () => {
    expect(normalizeTraceId("")).toBeNull();
    expect(normalizeTraceId("   ")).toBeNull();
    expect(normalizeTraceId(42)).toBeNull();
    expect(normalizeTraceId("abc\0def")).toBeNull();
    expect(normalizeTraceId("x".repeat(301))).toBeNull();
    expect(() => requireTraceId(" ")).toThrow("traceId is required");
  });

  it("emits the platform trace header without touching traceparent", () => {
    expect(traceHeaders({ traceparent: "00-otel-span" }, " app-trace ")).toEqual({
      traceparent: "00-otel-span",
      [SINGULARITY_TRACE_HEADER]: "app-trace",
    });
  });

  it("builds deterministic workflow node trace ids through the helper", () => {
    expect(traceIdFromParts(["planner", "cap-1"], ":")).toBe("planner:cap-1");
    expect(workflowNodeTraceId({
      workflowInstanceId: "instance-1",
      workflowNodeId: "node-2",
      runId: "1234567890",
    })).toBe("wf-instance-1-node-2-12345678");
    expect(workflowNodeTraceId({
      prefix: "git-push",
      workflowInstanceId: "instance-1",
      workflowNodeId: "node-2",
    })).toBe("git-push-instance-1-node-2");
  });
});
