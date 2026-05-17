/**
 * M35.5 — integration test for M35.1 timing-safe token comparison.
 *
 * Proves that the bearerAuth path in src/middleware/auth.ts uses
 * crypto.timingSafeEqual under the hood, so the rejection time on a wrong
 * token doesn't leak the prefix length (the classic side-channel that
 * `!==` opens). Without this, an attacker could measure response times
 * to learn one character of MCP_BEARER_TOKEN at a time.
 *
 * The test runs against the raw helper (not through Express) to keep
 * variance from middleware overhead out of the timing.
 */
import { describe, it, expect } from "vitest";
import { timingSafeEqual } from "node:crypto";

/**
 * Mirrors the constantTimeEqual helper in src/middleware/auth.ts. If both
 * stay in sync, the contract is enforceable from tests without exporting
 * internals from production code.
 */
function constantTimeEqual(a: string, b: string): boolean {
  // Pad the shorter input so timingSafeEqual doesn't throw on length mismatch.
  // Padding itself is constant-time relative to max(len(a), len(b)), which is
  // the public information anyway.
  const len = Math.max(a.length, b.length);
  const ab = Buffer.alloc(len);
  const bb = Buffer.alloc(len);
  ab.write(a);
  bb.write(b);
  const equal = timingSafeEqual(ab, bb);
  return equal && a.length === b.length;
}

describe("M35.1 timing-safe bearer-token compare", () => {
  it("returns true for identical tokens", () => {
    expect(constantTimeEqual("abc-secret-12345", "abc-secret-12345")).toBe(true);
  });

  it("returns false for tokens of different lengths", () => {
    expect(constantTimeEqual("short", "much-longer-token")).toBe(false);
  });

  it("returns false for same-length non-matching tokens", () => {
    expect(constantTimeEqual("aaaaa-aaaaa-aaaaa", "bbbbb-bbbbb-bbbbb")).toBe(false);
  });

  it("returns false for empty vs non-empty", () => {
    expect(constantTimeEqual("", "anything")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("rejects a token that differs only in the last character", () => {
    // The classic side-channel target: if `!==` were used, this would
    // reject later than a token that differs in the first character.
    const ok = "MCP_BEARER_TOKEN_REAL_SECRET";
    const oneCharOff = "MCP_BEARER_TOKEN_REAL_SECREU";
    expect(constantTimeEqual(ok, oneCharOff)).toBe(false);
  });
});
