/**
 * M63 Slice D — risk classifier pure-function tests.
 *
 * No DB, no HTTP. Verifies the kind → risk-level mapping and the
 * severity-derived fallback so a future taxonomy change (or new
 * event kind from a new service) keeps classifying predictably.
 */
import { describe, it, expect } from "vitest";
import { classifyRisk } from "../src/risk-classifier";

describe("M63 classifyRisk", () => {
  // ── Critical tier ────────────────────────────────────────────────────────
  describe("critical", () => {
    it("formal_verify.failed → critical", () => {
      expect(classifyRisk({ kind: "formal_verify.failed" })).toBe("critical");
    });
    it("security.violation → critical even with severity=info (the act itself is risky)", () => {
      expect(classifyRisk({ kind: "security.violation", severity: "info" })).toBe("critical");
    });
    it("budget.exhausted → critical", () => {
      expect(classifyRisk({ kind: "budget.exhausted" })).toBe("critical");
    });
    it("rate_limit.exceeded → critical", () => {
      expect(classifyRisk({ kind: "rate_limit.exceeded" })).toBe("critical");
    });
    it("authz.decision.deny → critical (suffix match)", () => {
      expect(classifyRisk({ kind: "authz.decision.deny" })).toBe("critical");
    });
  });

  // ── High tier ────────────────────────────────────────────────────────────
  describe("high", () => {
    it("code_change → high", () => {
      expect(classifyRisk({ kind: "code_change" })).toBe("high");
    });
    it("code_change.applied → high (specific variant)", () => {
      expect(classifyRisk({ kind: "code_change.applied" })).toBe("high");
    });
    it("workflow.branch.pushed → high", () => {
      expect(classifyRisk({ kind: "workflow.branch.pushed" })).toBe("high");
    });
    it("workflow.deploy.applied → high", () => {
      expect(classifyRisk({ kind: "workflow.deploy.applied" })).toBe("high");
    });
    it("tool.filesystem.access.sensitive → high", () => {
      expect(classifyRisk({ kind: "tool.filesystem.access.sensitive" })).toBe("high");
    });
    it("approval.requested → high (action awaiting human)", () => {
      expect(classifyRisk({ kind: "approval.requested" })).toBe("high");
    });
  });

  // ── Low tier — high-volume routine events ────────────────────────────────
  describe("low", () => {
    it("llm.call.completed → low (routine, even though paid)", () => {
      expect(classifyRisk({ kind: "llm.call.completed" })).toBe("low");
    });
    it("tool.embedding.completed → low", () => {
      expect(classifyRisk({ kind: "tool.embedding.completed" })).toBe("low");
    });
    it("tool.filesystem.access (non-sensitive) → low", () => {
      expect(classifyRisk({ kind: "tool.filesystem.access" })).toBe("low");
    });
    it("blueprint.stage.* → low (prefix match)", () => {
      expect(classifyRisk({ kind: "blueprint.stage.run.started" })).toBe("low");
      expect(classifyRisk({ kind: "blueprint.stage.consumables.approved" })).toBe("low");
    });
    it("workbench.consumable.* → low (prefix match)", () => {
      expect(classifyRisk({ kind: "workbench.consumable.created" })).toBe("low");
    });
  });

  // ── Fallback — unknown kinds ─────────────────────────────────────────────
  describe("severity-derived fallback for unknown kinds", () => {
    it("unknown kind + severity=error → medium (recoverable by default)", () => {
      expect(classifyRisk({ kind: "some.new.kind.from.future", severity: "error" })).toBe("medium");
    });
    it("unknown kind + severity=warn → medium", () => {
      expect(classifyRisk({ kind: "another.new.kind", severity: "warn" })).toBe("medium");
    });
    it("unknown kind + severity=info → low", () => {
      expect(classifyRisk({ kind: "yet.another.kind", severity: "info" })).toBe("low");
    });
    it("unknown kind + severity=audit → low", () => {
      expect(classifyRisk({ kind: "service.metric.captured", severity: "audit" })).toBe("low");
    });
    it("unknown kind + no severity → low", () => {
      expect(classifyRisk({ kind: "ghost.kind" })).toBe("low");
    });
  });

  // ── Ordering — first match wins ──────────────────────────────────────────
  describe("ordering", () => {
    it("known critical kind beats severity fallback (severity ignored)", () => {
      // Even if some weird upstream sent budget.exhausted with severity=info,
      // it stays critical.
      expect(classifyRisk({ kind: "budget.exhausted", severity: "info" })).toBe("critical");
    });
  });
});
