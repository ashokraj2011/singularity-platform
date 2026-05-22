/**
 * M63 Slice D — Risk-level classifier for audit events.
 *
 * Severity asks "did it succeed?" (info / warn / error).
 * Risk asks "if this had gone wrong, how bad?" (low / medium / high / critical).
 *
 * Both dimensions are useful at the search/filter UI:
 *   - "Show me errors" (severity=error) catches things that DID break
 *   - "Show me high-risk activity" (risk=high) catches things you'd
 *     want to audit even when they succeeded (code commits, deployments,
 *     reading secrets, governance denials)
 *
 * The classification is a pure mapping over (kind, severity, payload).
 * Keep the rule table flat and ordered — first matching rule wins.
 * Out-of-table kinds fall back to a sensible severity-derived default
 * so a new event kind from a new service still gets a row.
 *
 * The SAME classification logic is mirrored in the SQL backfill at
 * db/migrations/m63_search_and_risk.sql. If you change one, change both.
 */

export type RiskLevel = "low" | "medium" | "high" | "critical";

type ClassifierInput = {
  kind: string;
  severity?: string | null;
  payload?: Record<string, unknown> | null;
};

/**
 * Kind patterns that ALWAYS classify as a given risk level, regardless
 * of severity. Ordering matters — first match wins.
 *
 * The patterns are simple string prefixes / equals checks so the table
 * is readable. RegExp is overkill for the event-kind taxonomy (which
 * is intentionally a flat namespace of dotted strings).
 */
const RULES: Array<{ match: (k: string) => boolean; risk: RiskLevel; reason: string }> = [
  // Critical — security violations, formal verifier failures, governance hard-denies.
  { match: (k) => k === "formal_verify.failed",            risk: "critical", reason: "formal verification failed" },
  { match: (k) => k === "security.violation",              risk: "critical", reason: "security violation" },
  { match: (k) => k === "governance.precheck.denied",      risk: "critical", reason: "governance precheck denied" },
  { match: (k) => k === "budget.exhausted",                risk: "critical", reason: "budget exhausted" },
  { match: (k) => k === "rate_limit.exceeded",             risk: "critical", reason: "rate limit hit" },
  { match: (k) => k.startsWith("authz.decision") && k.endsWith(".deny"), risk: "critical", reason: "authz deny" },

  // High — code/deploy mutations, sensitive file access, approval flows.
  { match: (k) => k === "code_change" || k === "code_change.applied", risk: "high", reason: "code mutation" },
  { match: (k) => k === "workflow.branch.pushed",          risk: "high", reason: "branch pushed" },
  { match: (k) => k === "workflow.deploy.applied",         risk: "high", reason: "deploy applied" },
  { match: (k) => k === "tool.filesystem.access.sensitive", risk: "high", reason: "sensitive path read" },
  { match: (k) => k === "approval.requested",              risk: "high", reason: "human approval requested" },
  { match: (k) => k === "governance.escalation",           risk: "high", reason: "governance escalation" },

  // Low — high-volume routine events that drown out signal if classified higher.
  { match: (k) => k === "llm.call.completed",              risk: "low",  reason: "routine llm call" },
  { match: (k) => k === "tool.embedding.completed",        risk: "low",  reason: "routine embedding" },
  { match: (k) => k === "tool.filesystem.access",          risk: "low",  reason: "routine fs read" },
  { match: (k) => k.startsWith("blueprint.stage."),        risk: "low",  reason: "blueprint stage progress" },
  { match: (k) => k.startsWith("workbench.consumable."),   risk: "low",  reason: "workbench artifact lifecycle" },
];

/**
 * Classify one event. Pure function — no DB, no I/O. Safe to call
 * from inside an ingest transaction.
 */
export function classifyRisk(input: ClassifierInput): RiskLevel {
  for (const rule of RULES) {
    if (rule.match(input.kind)) return rule.risk;
  }
  // Fallback by severity. error → medium (default-not-critical, since
  // most errors are recoverable). warn → medium. info/audit → low.
  if (input.severity === "error" || input.severity === "warn") return "medium";
  return "low";
}
