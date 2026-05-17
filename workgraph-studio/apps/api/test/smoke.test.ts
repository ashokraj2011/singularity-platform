/**
 * M35.5 — smoke tests for workgraph-api.
 *
 * Pure-unit tests that don't need a live Postgres + MinIO + IAM. The goal is
 * to prove the test harness works and that the config invariants hold.
 *
 * Integration tests that need infra should live in test/integration/*.test.ts
 * and check process.env.TEST_DATABASE_URL / TEST_MINIO_ENDPOINT.
 */
import { describe, it, expect } from "vitest";

describe("workgraph-api / smoke", () => {
  it("vitest harness is wired up", () => {
    expect(1 + 1).toBe(2);
  });
});

describe("workgraph-api / canonical event name conversion", () => {
  // Mirrors toCanonicalEventName in src/lib/audit.ts. If this regresses,
  // legacy PascalCase events stop joining to the canonical event-bus.
  function toCanonicalEventName(eventType: string): string {
    return eventType
      .replace(/([A-Z])/g, " $1")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .join(".");
  }

  it("converts PascalCase to dotted lowercase", () => {
    expect(toCanonicalEventName("AgentRunCompleted")).toBe("agent.run.completed");
    expect(toCanonicalEventName("WorkflowRunCreated")).toBe("workflow.run.created");
    expect(toCanonicalEventName("WorkItemAssigned")).toBe("work.item.assigned");
  });

  it("passes through already-canonical strings", () => {
    expect(toCanonicalEventName("simple")).toBe("simple");
  });

  it("handles single-word PascalCase", () => {
    expect(toCanonicalEventName("Created")).toBe("created");
  });
});

describe("workgraph-api / CORS origin parsing", () => {
  // Mirrors the CORS_ORIGINS split logic used in src/index.ts.
  function parseCorsOrigins(env: string | undefined): string[] {
    if (!env) return [];
    return env.split(",").map((o) => o.trim()).filter(Boolean);
  }

  it("parses comma-separated origins with trimming", () => {
    expect(parseCorsOrigins("http://localhost:5173 , http://localhost:3000,,http://localhost:5174")).toEqual([
      "http://localhost:5173",
      "http://localhost:3000",
      "http://localhost:5174",
    ]);
  });

  it("returns empty array when unset", () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins("")).toEqual([]);
  });
});
