/**
 * Plan artifact — schema, robust JSON extraction, progress bookkeeping, and
 * path-coverage helpers for the Phased Agent Reasoning Model.
 *
 * See /Users/ashokraj/.claude/plans/immutable-sniffing-quiche.md (v4) for the
 * design rationale. Notably:
 *   - `kind` × `required` is the centerpiece of the path-coverage gate that
 *     prevents the "README changed, service untouched" lazy-edit failure mode.
 *   - `extractAndParsePlan` handles the reality that LLMs wrap JSON in
 *     markdown fences and pad it with conversational prose (verification Gap 1).
 *   - `diffPlans` powers the PLAN_CONFIRM audit event when targets get
 *     dropped from the draft plan to the confirmed plan.
 */

import { z } from "zod";

/** A single plan target — a file the agent intends to (or considered) touching. */
export const PlanTargetSchema = z.object({
  file: z.string().min(1),
  kind: z.enum(["code", "test", "docs", "config"]),
  required: z.boolean(),
  intent: z.string().min(1),
  status: z.enum(["pending", "read", "edited", "skipped"]).default("pending"),
  skipReason: z.string().optional(),
}).refine(
  (t) => t.status !== "skipped" || (typeof t.skipReason === "string" && t.skipReason.trim().length > 0),
  { message: "skipReason is required when status === 'skipped'", path: ["skipReason"] },
);

export type PlanTarget = z.infer<typeof PlanTargetSchema>;

/** Suggested verification command — treated as a hint, validated by the
 *  verifier registry at VERIFY entry. */
export const PlanVerificationSchema = z.object({
  suggested: z.object({
    command: z.string(),
    args: z.array(z.string()).default([]),
    cwd: z.string().default("."),
  }),
});

export type PlanVerification = z.infer<typeof PlanVerificationSchema>;

export const PlanSchema = z.object({
  rationale: z.string().min(1),
  targets: z.array(PlanTargetSchema),
  verification: PlanVerificationSchema,
  risks: z.array(z.string()).default([]),
});

export type Plan = z.infer<typeof PlanSchema>;

/** Tracks per-file progress separately from the immutable Plan so reverting
 *  a target's status doesn't churn the Plan object. */
export type PlanProgressEntry = {
  status: "pending" | "read" | "edited" | "skipped";
  skipReason?: string;
  /** Step at which the status last changed — for trace diagnostics. */
  changedAtStep?: number;
};

export type PlanProgress = Record<string, PlanProgressEntry>;

export function initialPlanProgress(plan: Plan): PlanProgress {
  const progress: PlanProgress = {};
  for (const t of plan.targets) {
    progress[t.file] = { status: t.status };
  }
  return progress;
}

/**
 * Extract a JSON object from an LLM text response. Tolerant of:
 *   - markdown-fenced code blocks (```json ... ``` or ``` ... ```)
 *   - conversational prose before/after the JSON
 *   - trailing whitespace
 *
 * Throws if no JSON object can be located.
 *
 * Verification report Gap 1.
 */
export function extractAndParsePlan(text: string): unknown {
  // 1. Prefer fenced code block
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    // 2. Greedy outer-brace recovery — find first { and last } in candidate
    const first = candidate.indexOf("{");
    const last = candidate.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(candidate.slice(first, last + 1));
      } catch (innerErr) {
        throw new Error(`Failed to parse plan JSON after brace recovery: ${(innerErr as Error).message}`);
      }
    }
    throw new Error("No parseable JSON object found in LLM response");
  }
}

/**
 * Validate an extracted JSON value against the Plan schema. Returns
 * `{ ok: true, plan }` or `{ ok: false, issues }`. Callers can choose to fall
 * back to a synthesized plan on validation failure rather than aborting.
 */
export function validatePlan(parsed: unknown): { ok: true; plan: Plan } | { ok: false; issues: string[] } {
  const result = PlanSchema.safeParse(parsed);
  if (result.success) return { ok: true, plan: result.data };
  const issues = result.error.errors.map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`);
  return { ok: false, issues };
}

/** Convenience: parse text → validate, returning a discriminated union. */
export function parsePlanResponse(text: string): { ok: true; plan: Plan } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = extractAndParsePlan(text);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const validated = validatePlan(parsed);
  if (!validated.ok) {
    return { ok: false, error: `Plan schema validation failed: ${validated.issues.join("; ")}` };
  }
  // M46.A — Coherence check: a "registry add" without a matching "dispatch
  // edit" is the lazy-edit anti-pattern that produced 0 functional change in
  // the RuleEngine run. Reject so the model is forced to revise the plan.
  const coherence = checkPlanCoherence(validated.plan);
  if (!coherence.ok) {
    return { ok: false, error: `Plan coherence check failed: ${coherence.issues.join("; ")}` };
  }
  return { ok: true, plan: validated.plan };
}

// ─────────────────────────────────────────────────────────────────────────
// M46.A — Plan coherence: detect "registry-without-dispatch" anti-pattern.
//
// Example failure: the agent's plan listed Operator.java (add enum value)
// as the ONLY required code target, omitting RuleEngineService.java (the
// switch that dispatches on the enum). The run added the enum but never
// wired it up — verifier passed because the new operator was never tested
// (or worse, tests broke unrelated code). The path-coverage gate couldn't
// help because it only checks "did you edit what you said you'd edit" —
// not "is what you said you'd edit sufficient."
//
// Detection heuristic: if a required code target's intent mentions
// add/new + enum/value/operator/variant/case, expect a SECOND required
// code target whose file path or intent looks like a dispatcher /
// service / handler / switch. Single-target registry adds are blocked
// with an actionable message so the model can revise.
// ─────────────────────────────────────────────────────────────────────────

const REGISTRY_INTENT_RE = /\b(add|new|introduce|create|register)\b.*\b(enum|value|operator|variant|case|kind|type)\b/i;
const REGISTRY_FILE_RE = /(Operator|Operators|OperatorType|Enum|Types|Codes|Registry|Constants|Kinds)\.(java|kt|ts|tsx|py|go|rs|cs)$/i;
const DISPATCH_INTENT_RE = /\b(switch|case|dispatch|handle|route|evaluate|apply|impl|implement|wire)\b/i;
const DISPATCH_FILE_RE = /(Service|Engine|Evaluator|Handler|Dispatcher|Router|Executor|Resolver|Processor|Manager)\.(java|kt|ts|tsx|py|go|rs|cs)$/i;

function looksLikeRegistryAdd(target: { file: string; intent: string }): boolean {
  return REGISTRY_FILE_RE.test(target.file) || REGISTRY_INTENT_RE.test(target.intent);
}

function looksLikeDispatchEdit(target: { file: string; intent: string }): boolean {
  return DISPATCH_FILE_RE.test(target.file) || DISPATCH_INTENT_RE.test(target.intent);
}

export function checkPlanCoherence(plan: Plan): { ok: true } | { ok: false; issues: string[] } {
  const requiredCode = plan.targets.filter((t) => t.required && t.kind === "code");
  const registryTargets = requiredCode.filter(looksLikeRegistryAdd);
  if (registryTargets.length === 0) return { ok: true };
  const dispatchTargets = requiredCode.filter(looksLikeDispatchEdit);
  if (dispatchTargets.length > 0) return { ok: true };
  // Found a registry-add but no dispatch edit — this is the lazy-edit shape.
  return {
    ok: false,
    issues: [
      `target ${registryTargets[0].file} looks like a registry/enum addition ` +
      `("${registryTargets[0].intent}") but no matching dispatcher/service/handler ` +
      `edit is required in this plan. Add a second required target for the ` +
      `switch/case/dispatch site (likely a *Service.java / *Engine.java / *Evaluator.java) ` +
      `so the new enum value is actually wired into runtime behaviour. ` +
      `Without it, the new operator will exist in the enum but be unreachable at runtime.`,
    ],
  };
}

// ── Progress mutators (pure functions returning new state objects) ─────────

export function markRead(progress: PlanProgress, file: string, atStep: number): PlanProgress {
  const existing = progress[file];
  if (existing?.status === "edited" || existing?.status === "skipped") return progress;  // don't downgrade
  return { ...progress, [file]: { status: "read", changedAtStep: atStep } };
}

export function markEdited(progress: PlanProgress, file: string, atStep: number): PlanProgress {
  return { ...progress, [file]: { status: "edited", changedAtStep: atStep } };
}

export function markSkipped(progress: PlanProgress, file: string, reason: string, atStep: number): PlanProgress {
  return { ...progress, [file]: { status: "skipped", skipReason: reason, changedAtStep: atStep } };
}

// ── Path-coverage helpers ──────────────────────────────────────────────────

/** Return the list of `required: true` targets whose file is neither covered
 *  by a code-change path nor marked skipped-with-reason. The ACT transition
 *  gate uses this to decide when mutation work is "done enough". */
export function unsatisfiedRequiredTargets(
  plan: Plan,
  codeChangePaths: ReadonlySet<string>,
  progress: PlanProgress,
): PlanTarget[] {
  return plan.targets.filter((t) => {
    if (!t.required) return false;
    if (codeChangePaths.has(t.file)) return false;
    const prog = progress[t.file];
    if (prog?.status === "edited") return false;
    if (prog?.status === "skipped") return false;
    return true;
  });
}

// ── Plan-diff for PLAN_CONFIRM audit event ─────────────────────────────────

export interface PlanDiff {
  /** Targets present in draft but absent (or required→false) in confirmed. */
  dropped: PlanTarget[];
  /** Targets in confirmed but not in draft. */
  added: PlanTarget[];
  /** Targets whose `intent` text changed between draft and confirmed. */
  intentChanged: Array<{ file: string; before: string; after: string }>;
  /** Targets where `required` flag changed. */
  requiredFlipped: Array<{ file: string; before: boolean; after: boolean }>;
  /** True when any drop lacked a corresponding skipReason in progress. */
  hasUnjustifiedDrops: boolean;
}

export function diffPlans(draft: Plan, confirmed: Plan, progress: PlanProgress): PlanDiff {
  const draftByFile = new Map(draft.targets.map((t) => [t.file, t]));
  const confirmedByFile = new Map(confirmed.targets.map((t) => [t.file, t]));

  const dropped: PlanTarget[] = [];
  const intentChanged: Array<{ file: string; before: string; after: string }> = [];
  const requiredFlipped: Array<{ file: string; before: boolean; after: boolean }> = [];

  for (const [file, draftTarget] of draftByFile) {
    const conf = confirmedByFile.get(file);
    if (!conf) {
      dropped.push(draftTarget);
      continue;
    }
    if (conf.intent !== draftTarget.intent) {
      intentChanged.push({ file, before: draftTarget.intent, after: conf.intent });
    }
    if (conf.required !== draftTarget.required) {
      requiredFlipped.push({ file, before: draftTarget.required, after: conf.required });
      if (draftTarget.required && !conf.required) {
        // required→false counts as a drop too (we no longer enforce it)
        dropped.push(draftTarget);
      }
    }
  }

  const added: PlanTarget[] = [];
  for (const [file, conf] of confirmedByFile) {
    if (!draftByFile.has(file)) added.push(conf);
  }

  const hasUnjustifiedDrops = dropped.some((t) => {
    const prog = progress[t.file];
    return !prog || prog.status !== "skipped" || !prog.skipReason;
  });

  return { dropped, added, intentChanged, requiredFlipped, hasUnjustifiedDrops };
}

// ── Display helpers ────────────────────────────────────────────────────────

/** One-line summary of progress for the phase frame / trace viewer. */
export function summarizePlanProgress(plan: Plan | null, progress: PlanProgress): string {
  if (!plan || plan.targets.length === 0) return "no plan (fallback or unset)";
  const required = plan.targets.filter((t) => t.required);
  const edited = required.filter((t) => progress[t.file]?.status === "edited").length;
  const skipped = required.filter((t) => progress[t.file]?.status === "skipped").length;
  return `${edited}/${required.length} required edited, ${skipped} skipped`;
}
