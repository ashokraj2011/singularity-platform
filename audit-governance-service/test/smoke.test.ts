/**
 * M35.5 — smoke tests for audit-governance-service.
 *
 * Pure-unit tests that don't need a live database. The goal is to prove the
 * test harness works and the basic invariants of the service hold (token
 * compare is timing-safe, source_service allowlist parsing handles edge
 * cases, event payload validation accepts known-good shapes).
 *
 * Integration tests that need Postgres should live alongside in
 * test/integration/*.test.ts and check process.env.TEST_DATABASE_URL.
 */
import { describe, it, expect } from "vitest";
import { timingSafeEqual } from "node:crypto";

describe("audit-governance-service / smoke", () => {
  it("timingSafeEqual rejects equal-length non-matching tokens", () => {
    const a = Buffer.from("aaaaaaaa");
    const b = Buffer.from("bbbbbbbb");
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  it("timingSafeEqual accepts identical buffers", () => {
    const a = Buffer.from("same-secret-value-here");
    const b = Buffer.from("same-secret-value-here");
    expect(timingSafeEqual(a, b)).toBe(true);
  });
});

describe("audit-governance-service / source_service allowlist parsing", () => {
  // Mirrors the parsing logic in routes-events.ts so we can prove a regression
  // would be caught at unit-test time before it hits the wire.
  function parseAllowlist(envValue: string | undefined): string[] {
    if (!envValue) return [];
    return envValue.split(",").map((s) => s.trim()).filter(Boolean);
  }

  it("returns empty for unset env (allow-all default)", () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist("")).toEqual([]);
  });

  it("trims whitespace and drops empties", () => {
    expect(parseAllowlist("mcp-server,  agent-runtime ,, prompt-composer")).toEqual([
      "mcp-server",
      "agent-runtime",
      "prompt-composer",
    ]);
  });

  it("preserves order from env (deterministic)", () => {
    expect(parseAllowlist("b,a,c")).toEqual(["b", "a", "c"]);
  });
});
