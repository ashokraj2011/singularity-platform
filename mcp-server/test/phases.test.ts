/**
 * Unit tests for the Phases module (mcp-server/src/mcp/phases.ts).
 *
 * Covers:
 *   - Tool allowlists per phase (read-only in PLAN_DRAFT/EXPLORE/PLAN_CONFIRM,
 *     mutation+read in ACT, verification-only in VERIFY, none in FINALIZE)
 *   - formatGatedToolError includes the allowed-tools list and a transition hint
 *   - Per-phase budget defaults; resolvePhaseBudget honors overrides
 *   - PHASE_REPETITION_RULES: ACT requires output-identity, others don't
 *   - nextPhase transition predicates:
 *       * PLAN_DRAFT → EXPLORE on plan ready or budget exhaustion
 *       * EXPLORE → PLAN_CONFIRM when all required targets read OR budget
 *       * ACT → VERIFY when required targets covered (edited / code-change /
 *         skipped) OR budget
 *       * VERIFY → FINALIZE only on budget exhaustion (rest decided by runLoop)
 *   - computeCodeChangeCoverage: covered/skipped/missing buckets,
 *     hasRequiredCodeGap correctly flags missing code-kind targets
 *   - synthesizePhaseFrame includes phase, step counter, progress, allowed tools
 *   - synthesizeFallbackPlan creates a vacuous-target plan with sensible defaults
 */
import { describe, it, expect } from "vitest";
import {
  PHASE_ORDER,
  TOOL_ALLOWLISTS,
  isToolAllowed,
  formatGatedToolError,
  DEFAULT_PHASE_BUDGETS,
  resolvePhaseBudget,
  PHASE_REPETITION_RULES,
  nextPhase,
  computeCodeChangeCoverage,
  synthesizePhaseFrame,
  synthesizeFallbackPlan,
  type Phase,
  type PhaseLoopStateView,
} from "../src/mcp/phases";
import type { Plan, PlanProgress } from "../src/mcp/plan";

function makeView(overrides: Partial<PhaseLoopStateView>): PhaseLoopStateView {
  return {
    phase: "PLAN_DRAFT",
    plan: null,
    planProgress: {},
    phaseStepUsage: {
      PLAN_DRAFT: 0, EXPLORE: 0, PLAN_CONFIRM: 0, ACT: 0, VERIFY: 0, FINALIZE: 0,
    },
    phaseBudgets: {},
    planFromFallback: false,
    ...overrides,
  };
}

const SAMPLE_PLAN: Plan = {
  rationale: "Add a new operator end to end.",
  targets: [
    { file: "src/Operator.java",          kind: "code", required: true,  intent: "add enum",  status: "pending" },
    { file: "src/RuleEngineService.java", kind: "code", required: true,  intent: "switch",    status: "pending" },
    { file: "test/RuleEngineServiceTest.java", kind: "test", required: true, intent: "test",  status: "pending" },
    { file: "README.md",                  kind: "docs", required: false, intent: "docs",      status: "pending" },
  ],
  verification: { suggested: { command: "mvn", args: ["test"], cwd: "." } },
  risks: [],
};

describe("PHASE_ORDER and TOOL_ALLOWLISTS", () => {
  it("exposes all six phases in order", () => {
    expect(PHASE_ORDER).toEqual(["PLAN_DRAFT", "EXPLORE", "PLAN_CONFIRM", "ACT", "VERIFY", "FINALIZE"]);
  });

  it("PLAN_DRAFT has narrow grounding tools (v4.2)", () => {
    // v4.1 attempted to force plan-JSON by giving PLAN_DRAFT zero tools,
    // but the model then hallucinated workspace state ("operator already
    // implemented" — wrong) because it couldn't look. v4.2: narrow set of
    // fast indexing tools so the model can ground its hypothesis without
    // going off into freeform exploration. Heavy reads still belong in EXPLORE.
    expect(isToolAllowed("PLAN_DRAFT", "index_workspace")).toBe(true);
    expect(isToolAllowed("PLAN_DRAFT", "list_directory")).toBe(true);
    expect(isToolAllowed("PLAN_DRAFT", "find_symbol")).toBe(true);
    // NOT in PLAN_DRAFT — these belong in EXPLORE
    expect(isToolAllowed("PLAN_DRAFT", "read_file")).toBe(false);
    expect(isToolAllowed("PLAN_DRAFT", "get_ast_slice")).toBe(false);
    expect(isToolAllowed("PLAN_DRAFT", "search_code")).toBe(false);
    expect(isToolAllowed("PLAN_DRAFT", "write_file")).toBe(false);
  });

  it("EXPLORE and PLAN_CONFIRM share the read-only set (no mutation)", () => {
    const mutationTools = ["replace_text", "replace_range", "apply_patch", "write_file"];
    for (const phase of ["EXPLORE", "PLAN_CONFIRM"] as Phase[]) {
      for (const t of mutationTools) {
        expect(isToolAllowed(phase, t)).toBe(false);
      }
      // sanity: read tools are present
      expect(isToolAllowed(phase, "read_file")).toBe(true);
    }
  });

  it("ACT includes mutation tools AND the read-back subset (verification Gap 4)", () => {
    expect(isToolAllowed("ACT", "replace_text")).toBe(true);
    expect(isToolAllowed("ACT", "write_file")).toBe(true);
    // read access during editing is critical — these MUST be allowed
    expect(isToolAllowed("ACT", "read_file")).toBe(true);
    expect(isToolAllowed("ACT", "search_code")).toBe(true);
    expect(isToolAllowed("ACT", "get_symbol")).toBe(true);
    expect(isToolAllowed("ACT", "get_ast_slice")).toBe(true);
    // but NOT verification tools (those belong to VERIFY)
    expect(isToolAllowed("ACT", "run_test")).toBe(false);
    expect(isToolAllowed("ACT", "run_command")).toBe(false);
    // and NOT index_workspace (slow, do once in PLAN_DRAFT)
    expect(isToolAllowed("ACT", "index_workspace")).toBe(false);
  });

  it("VERIFY only allows verification tools", () => {
    expect(isToolAllowed("VERIFY", "run_test")).toBe(true);
    expect(isToolAllowed("VERIFY", "run_command")).toBe(true);
    expect(isToolAllowed("VERIFY", "verification_unavailable")).toBe(true);
    expect(isToolAllowed("VERIFY", "write_file")).toBe(false);
    expect(isToolAllowed("VERIFY", "read_file")).toBe(false);
  });

  it("FINALIZE has no tools at all (auto-finish)", () => {
    expect(TOOL_ALLOWLISTS.FINALIZE.size).toBe(0);
  });
});

describe("formatGatedToolError", () => {
  it("includes the offending tool name, allowed list, and a transition hint", () => {
    const msg = formatGatedToolError("EXPLORE", "write_file", "PLAN_CONFIRM unlocks once all required draft targets are read.");
    expect(msg).toMatch(/write_file/);
    expect(msg).toMatch(/Available tools this phase/);
    expect(msg).toMatch(/read_file/);
    expect(msg).toMatch(/PLAN_CONFIRM unlocks/);
  });
});

describe("resolvePhaseBudget", () => {
  it("uses defaults when no overrides supplied", () => {
    expect(resolvePhaseBudget("PLAN_DRAFT", undefined)).toBe(DEFAULT_PHASE_BUDGETS.PLAN_DRAFT);
    expect(resolvePhaseBudget("ACT", undefined)).toBe(DEFAULT_PHASE_BUDGETS.ACT);
  });

  it("honors per-phase overrides while falling back to defaults for missing keys", () => {
    expect(resolvePhaseBudget("ACT", { ACT: 50 })).toBe(50);
    expect(resolvePhaseBudget("PLAN_DRAFT", { ACT: 50 })).toBe(DEFAULT_PHASE_BUDGETS.PLAN_DRAFT);
  });
});

describe("PHASE_REPETITION_RULES", () => {
  it("ACT requires output-identity (CONFLICT-retry must not trip)", () => {
    expect(PHASE_REPETITION_RULES.ACT.compareOutput).toBe(true);
  });

  it("other phases do not compare output", () => {
    for (const phase of ["PLAN_DRAFT", "EXPLORE", "PLAN_CONFIRM", "VERIFY", "FINALIZE"] as Phase[]) {
      expect(PHASE_REPETITION_RULES[phase].compareOutput).toBe(false);
    }
  });

  it("VERIFY uses a tighter threshold (2) than exploration phases (3)", () => {
    expect(PHASE_REPETITION_RULES.VERIFY.threshold).toBe(2);
    expect(PHASE_REPETITION_RULES.EXPLORE.threshold).toBe(3);
    expect(PHASE_REPETITION_RULES.ACT.threshold).toBe(3);
  });
});

describe("nextPhase — transitions", () => {
  it("PLAN_DRAFT stays put if no plan and budget not exhausted", () => {
    const view = makeView({ phase: "PLAN_DRAFT", plan: null, phaseStepUsage: { PLAN_DRAFT: 1, EXPLORE: 0, PLAN_CONFIRM: 0, ACT: 0, VERIFY: 0, FINALIZE: 0 } });
    expect(nextPhase(view, new Set())).toBe(null);
  });

  it("PLAN_DRAFT → EXPLORE when a plan is produced", () => {
    const view = makeView({ phase: "PLAN_DRAFT", plan: SAMPLE_PLAN });
    expect(nextPhase(view, new Set())).toBe("EXPLORE");
  });

  it("PLAN_DRAFT → EXPLORE on budget exhaustion (fallback plan path)", () => {
    const view = makeView({
      phase: "PLAN_DRAFT", plan: null,
      phaseStepUsage: { PLAN_DRAFT: DEFAULT_PHASE_BUDGETS.PLAN_DRAFT, EXPLORE: 0, PLAN_CONFIRM: 0, ACT: 0, VERIFY: 0, FINALIZE: 0 },
    });
    expect(nextPhase(view, new Set())).toBe("EXPLORE");
  });

  it("EXPLORE stays put when required targets still pending", () => {
    const view = makeView({ phase: "EXPLORE", plan: SAMPLE_PLAN });
    expect(nextPhase(view, new Set())).toBe(null);
  });

  it("EXPLORE → PLAN_CONFIRM when every required target has been read", () => {
    const progress: PlanProgress = {
      "src/Operator.java": { status: "read" },
      "src/RuleEngineService.java": { status: "read" },
      "test/RuleEngineServiceTest.java": { status: "read" },
    };
    const view = makeView({ phase: "EXPLORE", plan: SAMPLE_PLAN, planProgress: progress });
    expect(nextPhase(view, new Set())).toBe("PLAN_CONFIRM");
  });

  it("EXPLORE → PLAN_CONFIRM under fallback (plan with empty targets) immediately", () => {
    const fallback: Plan = { ...SAMPLE_PLAN, targets: [] };
    const view = makeView({ phase: "EXPLORE", plan: fallback, planFromFallback: true });
    expect(nextPhase(view, new Set())).toBe("PLAN_CONFIRM");
  });

  it("ACT → VERIFY when every required target is covered by code-change paths", () => {
    const view = makeView({ phase: "ACT", plan: SAMPLE_PLAN });
    const paths = new Set(["src/Operator.java", "src/RuleEngineService.java", "test/RuleEngineServiceTest.java"]);
    expect(nextPhase(view, paths)).toBe("VERIFY");
  });

  it("ACT → VERIFY when targets are mixed-skipped + edited (no missing required)", () => {
    const progress: PlanProgress = {
      "src/Operator.java": { status: "edited" },
      "src/RuleEngineService.java": { status: "edited" },
      "test/RuleEngineServiceTest.java": { status: "skipped", skipReason: "covered by existing test" },
    };
    const view = makeView({ phase: "ACT", plan: SAMPLE_PLAN, planProgress: progress });
    expect(nextPhase(view, new Set())).toBe("VERIFY");
  });

  it("ACT stays put while any required target is missing", () => {
    const progress: PlanProgress = {
      "src/Operator.java": { status: "edited" },
      // RuleEngineService.java and test file still pending
    };
    const view = makeView({ phase: "ACT", plan: SAMPLE_PLAN, planProgress: progress });
    expect(nextPhase(view, new Set())).toBe(null);
  });

  it("ACT → VERIFY on budget exhaustion when AT LEAST ONE code change landed", () => {
    // M47.C — VERIFY is only useful when there's something to verify. If a
    // mutation succeeded in ACT, exhausting the budget transitions normally.
    const view = makeView({
      phase: "ACT", plan: SAMPLE_PLAN,
      phaseStepUsage: { PLAN_DRAFT: 0, EXPLORE: 0, PLAN_CONFIRM: 0, ACT: DEFAULT_PHASE_BUDGETS.ACT, VERIFY: 0, FINALIZE: 0 },
    });
    expect(nextPhase(view, new Set(["src/Operator.java"]))).toBe("VERIFY");
  });

  it("ACT → FINALIZE on budget exhaustion when ZERO code changes landed (M47.C)", () => {
    // The audit-log RCA showed agents thrashing in VERIFY trying to make
    // edits that were phase-gated, because ACT exited with no successful
    // mutation. Route straight to FINALIZE so the run ends cleanly and
    // the workgraph path-coverage gate refuses approval.
    const view = makeView({
      phase: "ACT", plan: SAMPLE_PLAN,
      phaseStepUsage: { PLAN_DRAFT: 0, EXPLORE: 0, PLAN_CONFIRM: 0, ACT: DEFAULT_PHASE_BUDGETS.ACT, VERIFY: 0, FINALIZE: 0 },
    });
    expect(nextPhase(view, new Set())).toBe("FINALIZE");
  });

  it("ACT under fallback plan stays put until ACT budget is exhausted (v4.2)", () => {
    // v4.1 transitioned on the FIRST observed mutation under a fallback
    // plan. The 2026-05-21 13:14 attempt showed that's too eager: model
    // edited Operator.java, ACT bailed, agent never got to edit
    // RuleEngineService.java or tests → wrong, incomplete code change.
    //
    // v4.2: under fallback, ONLY budget exhaustion transitions. The model
    // gets its full ACT budget to make multi-file changes.
    const fallback: Plan = { ...SAMPLE_PLAN, targets: [] };
    const view = makeView({ phase: "ACT", plan: fallback, planFromFallback: true });
    // No code change → stay
    expect(nextPhase(view, new Set())).toBe(null);
    // One mutation observed → STILL stay (v4.2 change vs v4.1)
    expect(nextPhase(view, new Set(["src/Operator.java"]))).toBe(null);
    // planProgress edit also does NOT fire transition
    const withEdit = makeView({
      phase: "ACT", plan: fallback, planFromFallback: true,
      planProgress: { "src/Operator.java": { status: "edited" } },
    });
    expect(nextPhase(withEdit, new Set())).toBe(null);
    // Only budget exhaustion → transition (with at least one code change
    // landed → VERIFY; M47.C path covered in its own dedicated test)
    const exhausted = makeView({
      phase: "ACT", plan: fallback, planFromFallback: true,
      planProgress: { "src/Operator.java": { status: "edited" } },
      phaseStepUsage: { PLAN_DRAFT: 0, EXPLORE: 0, PLAN_CONFIRM: 0, ACT: DEFAULT_PHASE_BUDGETS.ACT, VERIFY: 0, FINALIZE: 0 },
    });
    expect(nextPhase(exhausted, new Set(["src/Operator.java"]))).toBe("VERIFY");
  });

  it("ACT under a plan with zero `required` targets also stays until budget exhausted (v4.2)", () => {
    // Same rule: with no path-coverage signal, run the full ACT budget.
    const noRequired: Plan = {
      ...SAMPLE_PLAN,
      targets: SAMPLE_PLAN.targets.map((t) => ({ ...t, required: false })),
    };
    const view = makeView({ phase: "ACT", plan: noRequired });
    expect(nextPhase(view, new Set())).toBe(null);
    expect(nextPhase(view, new Set(["src/anything.java"]))).toBe(null);
  });

  it("VERIFY → FINALIZE on budget exhaustion (else handled by runLoop on receipt)", () => {
    const exhausted = makeView({
      phase: "VERIFY", plan: SAMPLE_PLAN,
      phaseStepUsage: { PLAN_DRAFT: 0, EXPLORE: 0, PLAN_CONFIRM: 0, ACT: 0, VERIFY: DEFAULT_PHASE_BUDGETS.VERIFY, FINALIZE: 0 },
    });
    expect(nextPhase(exhausted, new Set())).toBe("FINALIZE");

    const inProgress = makeView({ phase: "VERIFY", plan: SAMPLE_PLAN });
    expect(nextPhase(inProgress, new Set())).toBe(null);
  });

  it("FINALIZE is terminal", () => {
    const view = makeView({ phase: "FINALIZE", plan: SAMPLE_PLAN });
    expect(nextPhase(view, new Set())).toBe(null);
  });
});

describe("computeCodeChangeCoverage — the path-coverage gate input", () => {
  it("returns empty buckets when plan is null (legacy / flat-loop run)", () => {
    const cov = computeCodeChangeCoverage(null, {}, new Set());
    expect(cov.required).toEqual([]);
    expect(cov.hasRequiredCodeGap).toBe(false);
  });

  it("flags hasRequiredCodeGap=true when a required code target is missing", () => {
    const cov = computeCodeChangeCoverage(SAMPLE_PLAN, {}, new Set());
    expect(cov.missing).toContain("src/Operator.java");
    expect(cov.hasRequiredCodeGap).toBe(true);
  });

  it("does NOT flag a gap for a docs-only task even when README is missing", () => {
    const docsOnlyPlan: Plan = {
      ...SAMPLE_PLAN,
      targets: [{ file: "README.md", kind: "docs", required: true, intent: "doc", status: "pending" }],
    };
    const cov = computeCodeChangeCoverage(docsOnlyPlan, {}, new Set());
    expect(cov.missing).toContain("README.md");
    expect(cov.hasRequiredCodeGap).toBe(false);  // docs gap is allowed by this flag
  });

  it("buckets code-change paths into covered, skipped-with-reason into skipped, leftovers into missing", () => {
    const codePaths = new Set(["src/Operator.java"]);
    const progress: PlanProgress = {
      "test/RuleEngineServiceTest.java": { status: "skipped", skipReason: "existing test fine" },
    };
    const cov = computeCodeChangeCoverage(SAMPLE_PLAN, progress, codePaths);
    expect(cov.covered).toEqual(["src/Operator.java"]);
    expect(cov.skipped.map((s) => s.file)).toEqual(["test/RuleEngineServiceTest.java"]);
    expect(cov.missing).toEqual(["src/RuleEngineService.java"]);
    expect(cov.hasRequiredCodeGap).toBe(true);  // RuleEngineService.java is code+required+missing
  });
});

describe("synthesizePhaseFrame", () => {
  it("includes phase, step counter, allowed tools, and a transition hint", () => {
    const view = makeView({ phase: "ACT", plan: SAMPLE_PLAN, phaseStepUsage: { PLAN_DRAFT: 0, EXPLORE: 0, PLAN_CONFIRM: 0, ACT: 3, VERIFY: 0, FINALIZE: 0 } });
    const frame = synthesizePhaseFrame(view);
    expect(frame).toMatch(/Phase: ACT/);
    expect(frame).toMatch(/step 4 of/);   // used 3 → next is the 4th
    expect(frame).toMatch(/replace_text/);
    expect(frame).toMatch(/Transition: apply every required target's edit/);
  });

  it("reports 'no plan yet' before PLAN_DRAFT emits anything", () => {
    const view = makeView({ phase: "PLAN_DRAFT", plan: null });
    const frame = synthesizePhaseFrame(view);
    expect(frame).toMatch(/no plan yet/);
  });

  it("calls out fallback-plan operation mode explicitly", () => {
    const fallback: Plan = { ...SAMPLE_PLAN, targets: [] };
    const view = makeView({ phase: "EXPLORE", plan: fallback, planFromFallback: true });
    const frame = synthesizePhaseFrame(view);
    expect(frame).toMatch(/fallback plan/);
  });

  it("shows edited/skipped progress when partial", () => {
    const progress: PlanProgress = {
      "src/Operator.java": { status: "edited" },
      "test/RuleEngineServiceTest.java": { status: "skipped", skipReason: "n/a" },
    };
    const view = makeView({ phase: "ACT", plan: SAMPLE_PLAN, planProgress: progress });
    const frame = synthesizePhaseFrame(view);
    expect(frame).toMatch(/1\/3 required targets edited/);
    expect(frame).toMatch(/1 skipped/);
    expect(frame).toMatch(/Remaining: src\/RuleEngineService.java/);
  });
});

describe("synthesizeFallbackPlan", () => {
  it("produces an empty-targets plan with the language-appropriate verifier (java → mvn)", () => {
    const plan = synthesizeFallbackPlan(["java"], "Implement containsACharacter operator");
    expect(plan.targets).toEqual([]);
    expect(plan.verification.suggested.command).toBe("mvn");
    expect(plan.risks.some((r) => /auto-generated/.test(r))).toBe(true);
  });

  it("falls back to an empty-command suggestion when language is unknown", () => {
    const plan = synthesizeFallbackPlan([], "do something");
    expect(plan.verification.suggested.command).toBe("");
  });

  it("includes a truncated goal excerpt in risks for trace visibility", () => {
    const long = "a".repeat(500);
    const plan = synthesizeFallbackPlan(["typescript"], long);
    expect(plan.risks.some((r) => r.includes("goal excerpt:"))).toBe(true);
  });
});

// ── M50 — ACT read-budget urgency hint ────────────────────────────────────

describe("M50 synthesizePhaseFrame — ACT read-budget escalation", () => {
  const makeAct = (reads: number) => makeView({
    phase: "ACT",
    plan: SAMPLE_PLAN,
    actReadsSinceLastMutation: reads,
  });

  it("no urgency hint at 0-2 reads", () => {
    expect(synthesizePhaseFrame(makeAct(0))).not.toMatch(/ACT READ-LIMIT|read-only/i);
    expect(synthesizePhaseFrame(makeAct(2))).not.toMatch(/ACT READ-LIMIT|read-only/i);
  });

  it("soft note at 3-4 reads", () => {
    const frame = synthesizePhaseFrame(makeAct(3));
    expect(frame).toMatch(/3 consecutive read-only calls/);
    expect(frame).not.toMatch(/READ-LIMIT REACHED/);
  });

  it("hard escalation at >= 5 reads", () => {
    const frame = synthesizePhaseFrame(makeAct(5));
    expect(frame).toMatch(/ACT READ-LIMIT REACHED/);
    expect(frame).toMatch(/MUST be a mutation tool/);
    expect(frame).toMatch(/replace_text|apply_patch|write_file/);
    expect(frame).toMatch(/status:"skipped"/);
  });

  it("hard escalation also at 10 reads (full ACT budget burnt on reads)", () => {
    const frame = synthesizePhaseFrame(makeAct(10));
    expect(frame).toMatch(/ACT READ-LIMIT REACHED/);
    expect(frame).toMatch(/10 consecutive read-only/);
  });

  it("does NOT escalate in non-ACT phases even with a high read counter", () => {
    const exploreFrame = synthesizePhaseFrame(makeView({
      phase: "EXPLORE",
      plan: SAMPLE_PLAN,
      actReadsSinceLastMutation: 8,
    }));
    expect(exploreFrame).not.toMatch(/ACT READ-LIMIT|read-only calls in ACT/);
  });
});
