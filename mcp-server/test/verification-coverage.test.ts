/**
 * M43 Slice 3 — deterministic verification gate signal.
 *
 * `computeVerificationCoverage` is the pure helper that `buildResponseBody`
 * uses to populate `correlation.verificationCoverage`. The workgraph-side
 * gate (blueprint.router.ts::attemptVerificationCoverage) reads `.gap` and
 * refuses approval when true.
 */
import { describe, expect, it } from "vitest";
import { computeVerificationCoverage } from "../src/mcp/invoke";

describe("M43 computeVerificationCoverage", () => {
  it("returns gap=false when no code changed (read-only stage)", () => {
    const cov = computeVerificationCoverage(0, []);
    expect(cov).toEqual({
      codeChanged: false,
      receiptsPresent: false,
      hasPassingReceipt: false,
      hasUnavailableReceipt: false,
      gap: false,
    });
  });

  it("returns gap=true when code changed but no receipt", () => {
    const cov = computeVerificationCoverage(1, []);
    expect(cov.codeChanged).toBe(true);
    expect(cov.receiptsPresent).toBe(false);
    expect(cov.gap).toBe(true);
  });

  it("clears gap when a passing receipt is present", () => {
    const cov = computeVerificationCoverage(2, [
      { command: "mvn", passed: true, exit_code: 0 },
    ]);
    expect(cov.gap).toBe(false);
    expect(cov.hasPassingReceipt).toBe(true);
  });

  it("clears gap when a verification_unavailable receipt is present", () => {
    // Three shapes the unavailable receipt can take — all should count.
    const shapes = [
      { command: "verification_unavailable", reason: "no verifier" },
      { unavailable: true, reason: "no verifier" },
      { verification_kind: "unavailable", reason: "no verifier" },
    ];
    for (const r of shapes) {
      const cov = computeVerificationCoverage(1, [r]);
      expect(cov.gap, JSON.stringify(r)).toBe(false);
      expect(cov.hasUnavailableReceipt, JSON.stringify(r)).toBe(true);
    }
  });

  it("flags hasPassingReceipt=false when only a failed receipt is present", () => {
    const cov = computeVerificationCoverage(1, [
      { command: "mvn", passed: false, exit_code: 1 },
    ]);
    // Failed receipt is still a receipt — so receiptsPresent=true and gap=false.
    // But hasPassingReceipt=false lets the workgraph gate make a tighter decision
    // if it wants to require a PASSING receipt for green.
    expect(cov.receiptsPresent).toBe(true);
    expect(cov.gap).toBe(false);
    expect(cov.hasPassingReceipt).toBe(false);
  });

  it("treats exitCode (camelCase) the same as exit_code", () => {
    const cov = computeVerificationCoverage(1, [
      { command: "pnpm", exitCode: 0 },
    ]);
    expect(cov.hasPassingReceipt).toBe(true);
    expect(cov.gap).toBe(false);
  });
});
