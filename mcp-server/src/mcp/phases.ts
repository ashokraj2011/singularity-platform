/**
 * Phased Agent Reasoning Model — phase definitions, transition predicates,
 * tool allowlists, and per-step phase frame synthesis.
 *
 * See /Users/ashokraj/.claude/plans/immutable-sniffing-quiche.md (v4) for the
 * design. Six phases gate which tools are visible AND dispatchable, and a
 * pinned phase frame is injected into each LLM call so the model always knows
 * its position in the loop.
 *
 * This module is intentionally side-effect-free: pure types + predicates. The
 * state machine integration lives in invoke.ts:runLoop.
 */

import type { Plan, PlanProgress } from "./plan";

/** Phase identifiers, ordered by typical progression. */
export const PHASE_ORDER = [
  "PLAN_DRAFT",
  "EXPLORE",
  "PLAN_CONFIRM",
  "ACT",
  "VERIFY",
  "FINALIZE",
] as const;

export type Phase = (typeof PHASE_ORDER)[number];

/**
 * Per-phase tool allowlists (by tool name). Applied to BOTH
 * `LoopState.availableTools` (LLM-visible) and `LoopState.fullToolDescriptors`
 * (dispatch-eligible) so a malformed tool_call cannot bypass the contract.
 *
 * If a tool name appears in the loop's tool list but is NOT in the active
 * phase's allowlist, it is filtered out before the LLM call. If the model
 * emits a tool_call for a filtered tool anyway, dispatch returns a friendly
 * error (see `formatGatedToolError`) and the step still counts.
 */
const READ_ONLY_TOOLS = new Set<string>([
  "find_symbol",
  "get_symbol",
  "get_ast_slice",
  "get_dependencies",
  "search_code",
  "read_file",
  "list_directory",
  "index_workspace",
  // M42.9 — AST-index-backed file enumeration. Preferred over find_files for
  // code-file lookups (queries the index built in PLAN_DRAFT, no fs walk).
  "list_indexed_files",
  // M42.8 — fallback OS-verb replacements (filesystem walks for non-indexed
  // files only — README, *.yml, *.properties — or before index_workspace).
  "find_files",   // fallback file enumeration
  "file_stats",   // fallback metadata (fresh size after edits)
  "grep_lines",   // grep with context lines (ripgrep)
  // M43 — agentic workflow grounding (cheap, structured, read-only).
  "repo_map",     // initial topology + build-system + verifier inventory
]);

const MUTATION_TOOLS = new Set<string>([
  "replace_text",
  "replace_range",
  "apply_patch",
  "write_file",
]);

const VERIFICATION_TOOLS = new Set<string>([
  "run_test",
  "run_command",
  "verification_unavailable",
  // M43 — pick the right command deterministically rather than free-form.
  "recommended_verification",
]);

/** ACT keeps a read-only subset because editing constantly needs to inspect
 *  surrounding code (imports, surrounding signatures). Verification report Gap 4.
 *  Also includes the M42.8 token-efficient discovery tools so the agent
 *  never falls back to OS verbs (find/grep/wc) mid-edit. */
const ACT_READ_SUBSET = new Set<string>([
  "read_file",
  "search_code",
  "get_symbol",
  "get_ast_slice",
  "list_indexed_files",
  "find_files",
  "file_stats",
  "grep_lines",
]);

export const TOOL_ALLOWLISTS: Record<Phase, ReadonlySet<string>> = {
  // PLAN_DRAFT v4.2 — narrow grounding tools only. v4.1 made this empty
  // (text-only) to force plan-JSON emission, but the practical effect was
  // the model hallucinated workspace state ("operator already implemented")
  // because it had no way to look. We narrow to fast indexing tools so the
  // model can ground its initial hypothesis without freeform exploration.
  // The contract prompt still requires a plan JSON in the same turn — model
  // must call these tools AND emit the JSON. Heavy reads belong in EXPLORE.
  PLAN_DRAFT: new Set<string>([
    "index_workspace",
    "list_indexed_files", // M42.9 — query the index right after building it
    "list_directory",
    "find_symbol",
    "repo_map",           // M43 — compact topology snapshot for grounding
  ]),
  EXPLORE: READ_ONLY_TOOLS,
  PLAN_CONFIRM: READ_ONLY_TOOLS,
  ACT: new Set([...MUTATION_TOOLS, ...ACT_READ_SUBSET]),
  // VERIFY can also run review_diff between/after verifier invocations to
  // confirm coverage before the loop auto-transitions to FINALIZE.
  VERIFY: new Set([...VERIFICATION_TOOLS, "review_diff"]),
  FINALIZE: new Set<string>(),  // no tools — MCP auto-finishes
};

export function isToolAllowed(phase: Phase, toolName: string): boolean {
  return TOOL_ALLOWLISTS[phase].has(toolName);
}

/** Format a friendly, model-readable rejection when a tool call is gated.
 *  Includes the allowed-tools list so the model can self-correct without
 *  guessing. Mirrors verification report Gap 3 guidance. */
export function formatGatedToolError(phase: Phase, toolName: string, transitionHint: string): string {
  const allowed = [...TOOL_ALLOWLISTS[phase]].sort();
  const allowedSummary = allowed.length === 0 ? "(none — phase auto-finishes)" : allowed.join(", ");
  return [
    `Tool '${toolName}' is not available in phase ${phase}.`,
    `Available tools this phase: ${allowedSummary}.`,
    transitionHint,
  ].join(" ");
}

/** Default per-phase step budgets. Total = 23 (with 5 slack for absolute
 *  cap at 28 — see WORKBENCH_DEVELOPER_MAX_STEPS_TOTAL in workgraph-api). */
export const DEFAULT_PHASE_BUDGETS: Record<Phase, number> = {
  PLAN_DRAFT: 2,
  EXPLORE: 6,
  PLAN_CONFIRM: 2,
  ACT: 10,
  VERIFY: 2,
  FINALIZE: 1,
};

/** Caller-supplied per-phase overrides — workgraph-api / context-fabric may
 *  pass these in `body.limits.phaseBudgets`. Missing keys fall back to the
 *  default budget. */
export type PhaseBudgets = Partial<Record<Phase, number>>;

export function resolvePhaseBudget(phase: Phase, budgets: PhaseBudgets | undefined): number {
  return budgets?.[phase] ?? DEFAULT_PHASE_BUDGETS[phase];
}

/**
 * Per-phase repetition rule. Verification report Gap 5: ACT threshold of 2
 * was too aggressive because CONFLICT-retry-with-new-hash is legit progress.
 * Phase-aware threshold AND optional output-identity check (only count as
 * repetition if BOTH args AND output are identical — i.e. nothing changed).
 */
export interface PhaseRepetitionRule {
  threshold: number;
  compareOutput: boolean;
}

export const PHASE_REPETITION_RULES: Record<Phase, PhaseRepetitionRule> = {
  PLAN_DRAFT:   { threshold: 3, compareOutput: false },
  EXPLORE:      { threshold: 3, compareOutput: false },
  PLAN_CONFIRM: { threshold: 3, compareOutput: false },
  ACT:          { threshold: 3, compareOutput: true },  // CONFLICT-retry must not trip
  VERIFY:       { threshold: 2, compareOutput: false }, // two identical verifications = no progress
  FINALIZE:     { threshold: 3, compareOutput: false },
};

/**
 * Minimal LoopState shape this module relies on. Kept loose so that the real
 * LoopState in invoke.ts can be extended without forcing a re-import cycle.
 */
export interface PhaseLoopStateView {
  phase: Phase;
  plan: Plan | null;
  planProgress: PlanProgress;
  phaseStepUsage: Record<Phase, number>;
  phaseBudgets: PhaseBudgets;
  /** True when PLAN_DRAFT exhausted budget and we synthesized a default. */
  planFromFallback: boolean;
}

/**
 * Transition predicates. Returns the next phase if a transition should occur
 * NOW (called after each step), or null to stay in the current phase.
 *
 * Order of checks matters — budget exhaustion always wins so the loop cannot
 * get stuck.
 */
export function nextPhase(state: PhaseLoopStateView, accumulatedCodeChangePaths: ReadonlySet<string>): Phase | null {
  const cur = state.phase;
  const used = state.phaseStepUsage[cur] ?? 0;
  const budget = resolvePhaseBudget(cur, state.phaseBudgets);
  const budgetExhausted = used >= budget;

  switch (cur) {
    case "PLAN_DRAFT": {
      // Transition when a plan exists (either model-emitted or fallback) or budget exhausted.
      const planReady = state.plan !== null;
      if (planReady || budgetExhausted) return "EXPLORE";
      return null;
    }
    case "EXPLORE": {
      // Transition when every required draft target has been read, OR budget exhausted.
      if (budgetExhausted) return "PLAN_CONFIRM";
      if (!state.plan || state.plan.targets.length === 0) return "PLAN_CONFIRM"; // fallback plan path
      const requiredFiles = state.plan.targets.filter((t) => t.required).map((t) => t.file);
      // "Read" means we've advanced past pending. A file with no progress entry
      // at all is treated as NOT read (the earlier `!== "pending"` check
      // returned true for `undefined` and over-transitioned).
      const READ_STATUSES = new Set<string>(["read", "edited", "skipped"]);
      const allRead = requiredFiles.every((f) => {
        const status = state.planProgress[f]?.status;
        return typeof status === "string" && READ_STATUSES.has(status);
      });
      return allRead ? "PLAN_CONFIRM" : null;
    }
    case "PLAN_CONFIRM": {
      // Transition is decided by the runLoop after parsing the confirmation response.
      // If the model already emitted a confirmed plan this step, runLoop sets a flag and
      // we move to ACT. Otherwise stay until budget exhausts.
      if (budgetExhausted) return "ACT";
      return null;
    }
    case "ACT": {
      if (budgetExhausted) return "VERIFY";
      if (!state.plan) return "VERIFY";
      const required = state.plan.targets.filter((t) => t.required);

      // ── Fallback-plan guard (v4.2) ───────────────────────────────────
      // When the plan is fallback or has no required targets, we have no
      // path-coverage signal to know when "enough" mutations have happened.
      // v4.1 transitioned on the FIRST mutation, but the 2026-05-21 13:14
      // attempt showed that's too eager: the model edited Operator.java,
      // then ACT bailed before it could edit RuleEngineService.java or
      // tests. The result was a wrong, incomplete code change.
      //
      // v4.2: under fallback, ACT stays put until budget is exhausted.
      // The model gets its full ACT budget (10 steps default) to keep
      // making edits. Budget-exhaustion already returned at the top of
      // this case, so we just stay (`null`) here.
      if (state.planFromFallback || required.length === 0) {
        return null;
      }

      // Normal path — every required target is satisfied if EITHER an
      // accumulated code-change touched its file OR its progress entry says
      // edited/skipped. We check the code-change set first because the
      // run-loop may not have populated planProgress yet for a freshly-
      // mutated file in this step.
      const satisfied = required.every((t) => {
        if (accumulatedCodeChangePaths.has(t.file)) return true;
        const status = state.planProgress[t.file]?.status;
        return status === "edited" || status === "skipped";
      });
      return satisfied ? "VERIFY" : null;
    }
    case "VERIFY": {
      // Transition decided by runLoop after a verification receipt is captured
      // (passing or explicitly-unavailable). Budget exhaustion still forces the move.
      if (budgetExhausted) return "FINALIZE";
      return null;
    }
    case "FINALIZE":
      // Terminal — runLoop returns from here.
      return null;
  }
}

/** Compute the path-coverage summary used by buildResponseBody and the
 *  workgraph-api gate. Code-required targets must be either covered (by an
 *  actual code-change path touching that file) or skipped-with-reason. */
export interface CodeChangeCoverage {
  required: string[];
  covered: string[];
  skipped: Array<{ file: string; reason: string }>;
  missing: string[];   // required-true but neither covered nor skipped
  hasRequiredCodeGap: boolean;
}

export function computeCodeChangeCoverage(
  plan: Plan | null,
  planProgress: PlanProgress,
  codeChangePaths: ReadonlySet<string>,
): CodeChangeCoverage {
  if (!plan) {
    return { required: [], covered: [], skipped: [], missing: [], hasRequiredCodeGap: false };
  }
  const required = plan.targets.filter((t) => t.required).map((t) => t.file);
  const covered: string[] = [];
  const skipped: Array<{ file: string; reason: string }> = [];
  const missing: string[] = [];
  for (const target of plan.targets) {
    const prog = planProgress[target.file];
    if (!target.required) continue;
    if (codeChangePaths.has(target.file) || prog?.status === "edited") {
      covered.push(target.file);
      continue;
    }
    if (prog?.status === "skipped") {
      skipped.push({ file: target.file, reason: prog.skipReason ?? "(no reason given)" });
      continue;
    }
    missing.push(target.file);
  }
  const hasRequiredCodeGap = plan.targets
    .filter((t) => t.required && t.kind === "code")
    .some((t) => missing.includes(t.file));
  return { required, covered, skipped, missing, hasRequiredCodeGap };
}

/**
 * Build the per-step system-role frame that gets injected before every LLM
 * call. Verification report Gap 3: explicit phase + allowed tools so the
 * model has no excuse to call a hidden tool.
 */
export function synthesizePhaseFrame(state: PhaseLoopStateView): string {
  const phase = state.phase;
  const used = state.phaseStepUsage[phase] ?? 0;
  const budget = resolvePhaseBudget(phase, state.phaseBudgets);
  const allowed = [...TOOL_ALLOWLISTS[phase]].sort();
  const allowedSummary = allowed.length === 0 ? "(none — phase auto-finishes)" : allowed.join(", ");

  let progressLine = "";
  if (state.plan && state.plan.targets.length > 0) {
    const required = state.plan.targets.filter((t) => t.required);
    const editedCount = required.filter((t) => state.planProgress[t.file]?.status === "edited").length;
    const skippedCount = required.filter((t) => state.planProgress[t.file]?.status === "skipped").length;
    const remaining = required
      .filter((t) => {
        const s = state.planProgress[t.file]?.status;
        return s !== "edited" && s !== "skipped";
      })
      .map((t) => t.file);
    progressLine = `Plan progress: ${editedCount}/${required.length} required targets edited, ${skippedCount} skipped.${remaining.length > 0 ? " Remaining: " + remaining.join(", ") : ""}`;
  } else if (state.planFromFallback) {
    progressLine = "Plan progress: operating under auto-generated fallback plan (no required targets). Apply the user's goal directly.";
  } else {
    progressLine = "Plan progress: no plan yet — emit a plan JSON object this turn (see Phased Agent Contract).";
  }

  const lines = [
    `Phase: ${phase} (step ${used + 1} of ${budget} in this phase).`,
    progressLine,
    `Allowed this phase: ${allowedSummary}.`,
  ];

  const transitionHint = describeTransition(phase);
  if (transitionHint) lines.push(transitionHint);

  return lines.join("\n");
}

function describeTransition(phase: Phase): string {
  switch (phase) {
    case "PLAN_DRAFT":
      return "Transition: emit a valid plan JSON to advance to EXPLORE. Plan may be wrong — EXPLORE will correct it.";
    case "EXPLORE":
      return "Transition: read each required plan target file to advance to PLAN_CONFIRM.";
    case "PLAN_CONFIRM":
      return "Transition: emit a revised plan JSON (or the original plan unchanged) to advance to ACT. Targets you drop must include a skipReason.";
    case "ACT":
      return "Transition: apply every required target's edit (or mark skipped with reason) to advance to VERIFY.";
    case "VERIFY":
      return "Transition: capture a verification receipt (pass, fail, or verification_unavailable with reason) to advance to FINALIZE.";
    case "FINALIZE":
      return "Phase auto-finishes — emit a final summary text response.";
  }
}

/**
 * Synthesize a minimal default plan when PLAN_DRAFT exhausts budget without
 * producing valid JSON. Empty targets = vacuous path-coverage check, so the
 * agent operates in unconstrained-but-budget-enforced mode (verification
 * report Gap 2).
 */
export function synthesizeFallbackPlan(detectedLanguages: string[], goalText: string): Plan {
  const language = detectedLanguages[0]?.toLowerCase();
  const suggestion = defaultVerifierFor(language);
  return {
    rationale: "Auto-generated: model did not produce a valid plan within PLAN_DRAFT budget. Treating goal text as exploration mandate without specific target constraints.",
    targets: [],
    verification: suggestion ? { suggested: suggestion } : { suggested: { command: "", args: [], cwd: "." } },
    risks: [
      "plan was auto-generated; agent operating without target constraints",
      goalText.length > 200 ? `goal excerpt: ${goalText.slice(0, 200)}…` : `goal: ${goalText}`,
    ],
  };
}

function defaultVerifierFor(language?: string): { command: string; args: string[]; cwd: string } | undefined {
  switch (language) {
    case "java":
    case "kotlin":
      return { command: "mvn", args: ["test"], cwd: "." };
    case "typescript":
    case "javascript":
      return { command: "pnpm", args: ["test"], cwd: "." };
    case "python":
      return { command: "pytest", args: [], cwd: "." };
    case "go":
      return { command: "go", args: ["test", "./..."], cwd: "." };
    case "rust":
      return { command: "cargo", args: ["test"], cwd: "." };
    default:
      return undefined;
  }
}
