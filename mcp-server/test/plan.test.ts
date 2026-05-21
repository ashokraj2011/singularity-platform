/**
 * Unit tests for the Plan module (mcp-server/src/mcp/plan.ts).
 *
 * Covers:
 *   - extractAndParsePlan handles plain JSON, markdown-fenced JSON, fenced
 *     with leading prose, prose-then-brace recovery, and rejects no-JSON input
 *   - validatePlan accepts the canonical shape, rejects missing fields,
 *     invalid kind, skipped-without-reason
 *   - parsePlanResponse end-to-end discriminated union
 *   - Progress mutators (markRead/markEdited/markSkipped) don't downgrade
 *     statuses incorrectly
 *   - unsatisfiedRequiredTargets returns the right rows across required/skip/
 *     code-change combinations
 *   - diffPlans surfaces dropped/added targets, intent changes, required
 *     flips, and the hasUnjustifiedDrops flag
 *   - summarizePlanProgress one-liner is correct for empty/partial/all-done
 *     states
 */
import { describe, it, expect } from "vitest";
import {
  extractAndParsePlan,
  validatePlan,
  parsePlanResponse,
  initialPlanProgress,
  markRead,
  markEdited,
  markSkipped,
  unsatisfiedRequiredTargets,
  diffPlans,
  summarizePlanProgress,
  type Plan,
  type PlanProgress,
} from "../src/mcp/plan";

const VALID_PLAN_OBJECT = {
  rationale: "Add containsACharacter operator across enum, switch, and a test.",
  targets: [
    { file: "src/main/java/Operator.java", kind: "code", required: true, intent: "add enum value" },
    { file: "src/main/java/RuleEngineService.java", kind: "code", required: true, intent: "add switch case" },
    { file: "src/test/java/RuleEngineServiceTest.java", kind: "test", required: true, intent: "case-insensitive test" },
    { file: "README.md", kind: "docs", required: false, intent: "document operator" },
  ],
  verification: { suggested: { command: "mvn", args: ["test"], cwd: "." } },
  risks: ["case sensitivity"],
};

describe("extractAndParsePlan", () => {
  it("parses a clean JSON object", () => {
    const text = JSON.stringify(VALID_PLAN_OBJECT);
    const parsed = extractAndParsePlan(text);
    expect(parsed).toMatchObject({ rationale: VALID_PLAN_OBJECT.rationale });
  });

  it("extracts JSON from a ```json fenced block", () => {
    const text = "Here is my plan:\n\n```json\n" + JSON.stringify(VALID_PLAN_OBJECT, null, 2) + "\n```\n\nLet me know if you want changes.";
    const parsed = extractAndParsePlan(text) as Record<string, unknown>;
    expect(parsed.rationale).toBe(VALID_PLAN_OBJECT.rationale);
  });

  it("extracts JSON from an unlabeled ``` fenced block", () => {
    const text = "```\n" + JSON.stringify(VALID_PLAN_OBJECT) + "\n```";
    const parsed = extractAndParsePlan(text) as Record<string, unknown>;
    expect((parsed.targets as unknown[]).length).toBe(4);
  });

  it("recovers JSON by greedy outer-brace when there is no fence", () => {
    const text = "Here's what I propose: " + JSON.stringify(VALID_PLAN_OBJECT) + " That's the gist.";
    const parsed = extractAndParsePlan(text) as Record<string, unknown>;
    expect(parsed.rationale).toBe(VALID_PLAN_OBJECT.rationale);
  });

  it("throws a clear error when the response has no JSON at all", () => {
    expect(() => extractAndParsePlan("I cannot produce a plan right now.")).toThrowError(/No parseable JSON/);
  });

  it("throws a clear error when braces match but content is invalid JSON", () => {
    expect(() => extractAndParsePlan("Here is { not really json } at all")).toThrow();
  });
});

describe("validatePlan", () => {
  it("accepts the canonical Plan shape", () => {
    const result = validatePlan(VALID_PLAN_OBJECT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.targets).toHaveLength(4);
      // Default-applied status field
      expect(result.plan.targets[0].status).toBe("pending");
    }
  });

  it("rejects a plan with no rationale", () => {
    const bad = { ...VALID_PLAN_OBJECT, rationale: "" };
    const result = validatePlan(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toMatch(/rationale/);
  });

  it("rejects a target with an unknown kind", () => {
    const bad = {
      ...VALID_PLAN_OBJECT,
      targets: [{ ...VALID_PLAN_OBJECT.targets[0], kind: "wireframe" }],
    };
    const result = validatePlan(bad);
    expect(result.ok).toBe(false);
  });

  it("rejects status='skipped' without a skipReason", () => {
    const bad = {
      ...VALID_PLAN_OBJECT,
      targets: [{ ...VALID_PLAN_OBJECT.targets[0], status: "skipped" }],
    };
    const result = validatePlan(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toMatch(/skipReason/);
  });

  it("accepts status='skipped' WITH a skipReason", () => {
    const ok = {
      ...VALID_PLAN_OBJECT,
      targets: [{ ...VALID_PLAN_OBJECT.targets[0], status: "skipped", skipReason: "decided not needed" }],
    };
    const result = validatePlan(ok);
    expect(result.ok).toBe(true);
  });

  it("accepts a plan with zero targets (the fallback synthesized shape)", () => {
    const empty = { ...VALID_PLAN_OBJECT, targets: [] };
    const result = validatePlan(empty);
    expect(result.ok).toBe(true);
  });
});

describe("parsePlanResponse end-to-end", () => {
  it("returns ok=true for a fenced valid plan", () => {
    const text = "Plan:\n```json\n" + JSON.stringify(VALID_PLAN_OBJECT) + "\n```";
    const result = parsePlanResponse(text);
    expect(result.ok).toBe(true);
  });

  it("returns ok=false with the parse error when JSON is missing", () => {
    const result = parsePlanResponse("I do not have a plan.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/No parseable JSON/);
  });

  it("returns ok=false with the validation error when shape is wrong", () => {
    const text = "```json\n" + JSON.stringify({ rationale: "x" }) + "\n```";
    const result = parsePlanResponse(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Plan schema validation failed/);
  });
});

describe("progress mutators", () => {
  const plan: Plan = validatePlan(VALID_PLAN_OBJECT).ok
    ? (validatePlan(VALID_PLAN_OBJECT) as { ok: true; plan: Plan }).plan
    : (() => { throw new Error("seed plan invalid"); })();

  it("initialPlanProgress mirrors target status (all pending)", () => {
    const p = initialPlanProgress(plan);
    for (const t of plan.targets) {
      expect(p[t.file]?.status).toBe("pending");
    }
  });

  it("markRead promotes pending → read but does NOT downgrade edited/skipped", () => {
    const start: PlanProgress = {
      "a.ts": { status: "pending" },
      "b.ts": { status: "edited" },
      "c.ts": { status: "skipped", skipReason: "n/a" },
    };
    const afterA = markRead(start, "a.ts", 1);
    expect(afterA["a.ts"]?.status).toBe("read");
    const afterB = markRead(afterA, "b.ts", 2);
    expect(afterB["b.ts"]?.status).toBe("edited");   // no downgrade
    const afterC = markRead(afterB, "c.ts", 3);
    expect(afterC["c.ts"]?.status).toBe("skipped");  // no downgrade
  });

  it("markEdited overrides any prior status", () => {
    const start: PlanProgress = { "a.ts": { status: "read" } };
    const after = markEdited(start, "a.ts", 5);
    expect(after["a.ts"]?.status).toBe("edited");
  });

  it("markSkipped stores the reason verbatim", () => {
    const after = markSkipped({}, "a.ts", "already correct on main", 4);
    expect(after["a.ts"]?.status).toBe("skipped");
    expect(after["a.ts"]?.skipReason).toBe("already correct on main");
  });
});

describe("unsatisfiedRequiredTargets — the lazy-edit gate input", () => {
  const plan = (validatePlan(VALID_PLAN_OBJECT) as { ok: true; plan: Plan }).plan;

  it("returns ALL required targets when nothing has been touched", () => {
    const missing = unsatisfiedRequiredTargets(plan, new Set(), {});
    expect(missing.map((t) => t.file)).toEqual([
      "src/main/java/Operator.java",
      "src/main/java/RuleEngineService.java",
      "src/test/java/RuleEngineServiceTest.java",
    ]);
  });

  it("returns empty when every required target has a code-change path", () => {
    const codeChangePaths = new Set([
      "src/main/java/Operator.java",
      "src/main/java/RuleEngineService.java",
      "src/test/java/RuleEngineServiceTest.java",
    ]);
    const missing = unsatisfiedRequiredTargets(plan, codeChangePaths, {});
    expect(missing).toEqual([]);
  });

  it("treats markEdited as satisfying coverage", () => {
    const progress: PlanProgress = {
      "src/main/java/Operator.java": { status: "edited" },
      "src/main/java/RuleEngineService.java": { status: "edited" },
      "src/test/java/RuleEngineServiceTest.java": { status: "edited" },
    };
    const missing = unsatisfiedRequiredTargets(plan, new Set(), progress);
    expect(missing).toEqual([]);
  });

  it("treats skipped-with-reason as satisfied for the ACT transition", () => {
    const progress: PlanProgress = {
      "src/main/java/Operator.java": { status: "edited" },
      "src/main/java/RuleEngineService.java": { status: "edited" },
      "src/test/java/RuleEngineServiceTest.java": { status: "skipped", skipReason: "existing test already exercises it" },
    };
    const missing = unsatisfiedRequiredTargets(plan, new Set(), progress);
    expect(missing).toEqual([]);
  });

  it("ignores non-required targets entirely (docs-only edit on a code task)", () => {
    const codeChangePaths = new Set([
      "src/main/java/Operator.java",
      "src/main/java/RuleEngineService.java",
      "src/test/java/RuleEngineServiceTest.java",
    ]);
    // README is not required, no need to touch it.
    const missing = unsatisfiedRequiredTargets(plan, codeChangePaths, {});
    expect(missing).toEqual([]);
  });
});

describe("diffPlans — PLAN_CONFIRM revision detection", () => {
  const draft = (validatePlan(VALID_PLAN_OBJECT) as { ok: true; plan: Plan }).plan;

  it("identifies a dropped target and flags it as unjustified when no skipReason", () => {
    const confirmed: Plan = {
      ...draft,
      targets: draft.targets.filter((t) => t.file !== "README.md"),
    };
    const diff = diffPlans(draft, confirmed, {});
    expect(diff.dropped.map((t) => t.file)).toEqual(["README.md"]);
    expect(diff.hasUnjustifiedDrops).toBe(true); // README was non-required but drop still unannotated; flag triggers
  });

  it("does NOT flag a drop as unjustified when progress has a skipReason for it", () => {
    const confirmed: Plan = {
      ...draft,
      targets: draft.targets.filter((t) => t.file !== "src/test/java/RuleEngineServiceTest.java"),
    };
    const progress: PlanProgress = {
      "src/test/java/RuleEngineServiceTest.java": {
        status: "skipped",
        skipReason: "covered by an existing integration test",
      },
    };
    const diff = diffPlans(draft, confirmed, progress);
    expect(diff.dropped.map((t) => t.file)).toEqual(["src/test/java/RuleEngineServiceTest.java"]);
    expect(diff.hasUnjustifiedDrops).toBe(false);
  });

  it("identifies added targets and intent changes", () => {
    const confirmed: Plan = {
      ...draft,
      targets: [
        ...draft.targets,
        { file: "src/main/java/Operator.java", kind: "code", required: true, intent: "ALSO update toString()", status: "pending" } as Plan["targets"][number],
        { file: "NEW.java", kind: "code", required: false, intent: "side-effect helper", status: "pending" } as Plan["targets"][number],
      ],
    };
    // Replace the original Operator.java with one with a different intent
    confirmed.targets = confirmed.targets.filter((t, i, all) => {
      // keep only first occurrence of each file
      return all.findIndex((u) => u.file === t.file) === i;
    });
    // Mutate the kept Operator.java intent to differ from draft
    confirmed.targets = confirmed.targets.map((t) =>
      t.file === "src/main/java/Operator.java" ? { ...t, intent: "add enum value AND update toString()" } : t,
    );

    const diff = diffPlans(draft, confirmed, {});
    expect(diff.added.map((t) => t.file)).toEqual(["NEW.java"]);
    expect(diff.intentChanged.map((c) => c.file)).toContain("src/main/java/Operator.java");
  });

  it("identifies required flips (true → false counts as drop)", () => {
    const confirmed: Plan = {
      ...draft,
      targets: draft.targets.map((t) =>
        t.file === "src/main/java/RuleEngineService.java" ? { ...t, required: false } : t,
      ),
    };
    const diff = diffPlans(draft, confirmed, {});
    expect(diff.requiredFlipped.map((r) => r.file)).toEqual(["src/main/java/RuleEngineService.java"]);
    expect(diff.dropped.map((t) => t.file)).toContain("src/main/java/RuleEngineService.java");
  });
});

describe("summarizePlanProgress display helper", () => {
  const plan = (validatePlan(VALID_PLAN_OBJECT) as { ok: true; plan: Plan }).plan;

  it("returns the no-plan label for null", () => {
    expect(summarizePlanProgress(null, {})).toMatch(/no plan/);
  });

  it("returns the no-plan label for an empty-targets plan", () => {
    expect(summarizePlanProgress({ ...plan, targets: [] }, {})).toMatch(/no plan/);
  });

  it("reports 0/3 at the start (3 required targets in the seed)", () => {
    expect(summarizePlanProgress(plan, {})).toBe("0/3 required edited, 0 skipped");
  });

  it("reports edited/skipped counts correctly", () => {
    const progress: PlanProgress = {
      "src/main/java/Operator.java": { status: "edited" },
      "src/test/java/RuleEngineServiceTest.java": { status: "skipped", skipReason: "n/a" },
    };
    expect(summarizePlanProgress(plan, progress)).toBe("1/3 required edited, 1 skipped");
  });
});
