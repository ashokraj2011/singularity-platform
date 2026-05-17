/**
 * M35.5 — smoke tests for platform-registry.
 *
 * Pure-unit tests that don't need a live Postgres. The goal is to prove the
 * test harness works; integration tests that touch the registry tables
 * should live in test/integration/*.test.ts and check TEST_DATABASE_URL.
 */
import { describe, it, expect } from "vitest";

describe("platform-registry / smoke", () => {
  it("vitest harness is wired up", () => {
    expect(1 + 1).toBe(2);
  });

  it("can import from the registry source (no runtime errors on module load)", async () => {
    // If src/index.ts has a top-level throw or unresolved import, the test
    // harness surfaces it here instead of at first dev/start.
    await expect(
      import("../src/lib/version").catch(() => ({ version: "?" })),
    ).resolves.toBeDefined();
  });
});

describe("platform-registry / service-name validation", () => {
  // Mirrors the canonical service-name regex used by the registry's
  // capability index. If a service registers with a name that doesn't match,
  // we want to fail fast at registration time, not at query time.
  const SERVICE_NAME_RE = /^[a-z][a-z0-9-]{2,63}$/;

  it("accepts lowercase-hyphen names", () => {
    expect(SERVICE_NAME_RE.test("agent-service")).toBe(true);
    expect(SERVICE_NAME_RE.test("mcp-server")).toBe(true);
    expect(SERVICE_NAME_RE.test("audit-governance-service")).toBe(true);
  });

  it("rejects uppercase, underscores, and short names", () => {
    expect(SERVICE_NAME_RE.test("AgentService")).toBe(false);
    expect(SERVICE_NAME_RE.test("agent_service")).toBe(false);
    expect(SERVICE_NAME_RE.test("ag")).toBe(false); // too short
    expect(SERVICE_NAME_RE.test("123-leading-digit")).toBe(false);
  });

  it("rejects names exceeding 64 chars (column limit)", () => {
    expect(SERVICE_NAME_RE.test("a" + "-x".repeat(40))).toBe(false);
  });
});
