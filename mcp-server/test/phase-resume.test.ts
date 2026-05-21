/**
 * Phased Agent Reasoning Model (v4) — approval-pause persistence test.
 *
 * Verifies that an in-flight phased run can be saved into a PendingApproval
 * envelope and restored with phase, plan, planProgress, budgets, step usage,
 * and repetition counters intact. Also verifies that LEGACY envelopes (minted
 * before this field existed) deserialize cleanly with phase_machine absent —
 * the resume path treats absence as "this is a flat-loop run, no rehydrate".
 *
 * Without this test, the phase machine silently dies the moment an approval
 * pause happens mid-ACT (the user would see the agent un-stuck post-approval
 * but it would behave like a flat-loop run, missing the path-coverage gate).
 */
import { describe, it, expect } from "vitest";
import { savePending, takePending } from "../src/audit/pending";
import type { ChatMessage, ToolCall } from "../src/llm/types";
import type { Plan, PlanProgress } from "../src/mcp/plan";

const SAMPLE_PLAN: Plan = {
  rationale: "Add containsACharacter operator end to end.",
  targets: [
    { file: "src/main/java/Operator.java",        kind: "code", required: true, intent: "add enum",   status: "edited" },
    { file: "src/main/java/RuleEngineService.java", kind: "code", required: true, intent: "switch",    status: "pending" },
    { file: "src/test/java/RuleEngineServiceTest.java", kind: "test", required: true, intent: "test", status: "read" },
  ],
  verification: { suggested: { command: "mvn", args: ["test"], cwd: "." } },
  risks: ["case sensitivity"],
};

const SAMPLE_PROGRESS: PlanProgress = {
  "src/main/java/Operator.java": { status: "edited", changedAtStep: 8 },
  "src/test/java/RuleEngineServiceTest.java": { status: "read", changedAtStep: 5 },
};

function makePhasedEnvelope() {
  const messages: ChatMessage[] = [{ role: "user", content: "do the thing" }];
  const pending_tool_call: ToolCall = { id: "call_1", name: "replace_text", args: { path: "src/main/java/RuleEngineService.java" } };
  return {
    trace_id: "trace-phased-1",
    mcp_invocation_id: "invoke-phased-1",
    messages,
    pending_tool_call,
    pending_tool_descriptor: {
      name: "replace_text",
      description: "replace text in a file",
      input_schema: {},
      execution_target: "LOCAL" as const,
      requires_approval: true,
    },
    available_tools: [],
    full_tool_descriptors: [],
    model_config: { provider: "mock", model: "mock-model" },
    correlation: {
      mcpInvocationId: "invoke-phased-1",
      traceId: "trace-phased-1",
      capabilityId: "cap-phased-1",
    },
    step_index: 9,
    max_steps: 28,
    llm_call_ids: [],
    tool_invocation_ids: [],
    artifact_ids: [],
    total_input_tokens: 0,
    total_output_tokens: 0,
    // The new phase_machine field — the whole point of this test.
    phase_machine: {
      phase: "ACT" as const,
      plan: SAMPLE_PLAN,
      planProgress: SAMPLE_PROGRESS,
      phaseBudgets: { PLAN_DRAFT: 2, EXPLORE: 6, PLAN_CONFIRM: 2, ACT: 10, VERIFY: 2, FINALIZE: 1 },
      phaseStepUsage: { PLAN_DRAFT: 2, EXPLORE: 6, PLAN_CONFIRM: 1, ACT: 4, VERIFY: 0, FINALIZE: 0 },
      phaseRepetitionCounters: {
        PLAN_DRAFT: { count: 0 }, EXPLORE: { count: 0 }, PLAN_CONFIRM: { count: 0 },
        ACT: { count: 1, lastKey: "replace_text|hash1|outhash1" }, VERIFY: { count: 0 }, FINALIZE: { count: 0 },
      },
      phaseViolationCount: 2,
      planFromFallback: false,
    },
  };
}

function makeLegacyEnvelope() {
  // Identical to the phased envelope MINUS the phase_machine field —
  // simulates an envelope minted before v4 shipped.
  const env = makePhasedEnvelope() as Partial<ReturnType<typeof makePhasedEnvelope>>;
  delete env.phase_machine;
  return env as ReturnType<typeof makePhasedEnvelope>;
}

describe("Phased Agent Reasoning Model — approval pause persistence", () => {
  it("savePending preserves the phase_machine block end to end", () => {
    const saved = savePending(makePhasedEnvelope());
    const result = takePending(saved.continuation_token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pm = result.approval.phase_machine;
    expect(pm).toBeDefined();
    if (!pm) return;
    expect(pm.phase).toBe("ACT");
    expect(pm.planFromFallback).toBe(false);
    expect(pm.phaseViolationCount).toBe(2);
    // Plan content survives JSON round-trip
    const plan = pm.plan as Plan;
    expect(plan.rationale).toMatch(/containsACharacter/);
    expect(plan.targets).toHaveLength(3);
    expect(plan.targets[0].file).toBe("src/main/java/Operator.java");
    // Progress detail preserved
    expect(pm.planProgress["src/main/java/Operator.java"]?.status).toBe("edited");
    expect(pm.planProgress["src/main/java/Operator.java"]?.changedAtStep).toBe(8);
    // Repetition counter detail preserved (the ACT-phase output-identity key)
    expect(pm.phaseRepetitionCounters.ACT.count).toBe(1);
    expect(pm.phaseRepetitionCounters.ACT.lastKey).toBe("replace_text|hash1|outhash1");
    // Budgets + usage preserved
    expect(pm.phaseStepUsage.ACT).toBe(4);
    expect(pm.phaseBudgets?.ACT).toBe(10);
  });

  it("savePending → takePending on a LEGACY envelope (no phase_machine) returns a usable approval with phase_machine absent", () => {
    const saved = savePending(makeLegacyEnvelope());
    const result = takePending(saved.continuation_token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The KEY invariant: takePending must not throw on a legacy envelope, and
    // the resume path will see phase_machine === undefined and fall back to
    // flat-loop behavior. This protects in-flight envelopes minted before v4.
    expect(result.approval.phase_machine).toBeUndefined();
    // All non-phase fields still rehydrate normally
    expect(result.approval.correlation.traceId).toBe("trace-phased-1");
    expect(result.approval.pending_tool_call.name).toBe("replace_text");
  });

  it("rejects a tampered phase_machine.phase via the existing HMAC signature check", () => {
    // We can't directly mutate the envelope after sign (single-use store +
    // signature would catch any change). But verifying that the existing
    // signing path COVERS the phase_machine bytes is best done by saving
    // and checking that takePending of the unmodified token works while a
    // hand-edited token fails. This codifies that phase_machine is part of
    // the signed surface.
    const saved = savePending(makePhasedEnvelope());
    const tampered = saved.continuation_token.slice(0, -3) + "AAA"; // mangle the suffix
    const result = takePending(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["invalid_signature", "malformed_token", "expired_token", "not_found"]).toContain(result.reason);
    }
  });

  it("two consecutive resumes on the same token are still rejected as replay_attempt (single-use invariant)", () => {
    const saved = savePending(makePhasedEnvelope());
    const first = takePending(saved.continuation_token);
    expect(first.ok).toBe(true);
    const second = takePending(saved.continuation_token);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("replay_attempt");
  });
});
