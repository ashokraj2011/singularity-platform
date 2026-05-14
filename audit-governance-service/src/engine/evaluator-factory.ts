/**
 * Singularity Engine — evaluator factory + runner.
 *
 * Creates custom evaluators from resolved engine issues and runs them
 * against traces to detect regressions.
 *
 * Evaluator types:
 *   - rule_based: regex/keyword matching on error messages
 *   - latency:    threshold-based latency check
 *   - token_count: threshold-based token usage check
 *   - llm_judge:  LLM-powered pass/fail scoring (Phase 2)
 */
import { query, queryOne } from "../db";

// ── Types ──────────────────────────────────────────────────────────────

export interface EvaluatorDef {
  name:            string;
  description:     string;
  evaluator_type:  "rule_based" | "latency" | "token_count" | "llm_judge";
  criteria:        Record<string, unknown>;
  evaluator_config: Record<string, unknown>;
  capability_id?:  string;
  issue_id?:       string;
}

export interface EvalResult {
  evaluator_id: string;
  trace_id:     string;
  passed:       boolean;
  reason:       string;
  score?:       number;
}

// ── Factory: create evaluator from a diagnosed issue ──────────────────

export async function createEvaluatorFromIssue(issueId: string): Promise<{ id: string; name: string }> {
  const issue = await queryOne<Record<string, unknown>>(
    `SELECT id, title, category, error_pattern, root_cause, capability_id
     FROM audit_governance.engine_issues WHERE id = $1`,
    [issueId],
  );
  if (!issue) throw Object.assign(new Error("issue not found"), { status: 404 });

  const rootCause = issue.root_cause as Record<string, unknown> | null;
  const category = String(issue.category ?? "unknown");
  const errorPattern = String(issue.error_pattern ?? "");

  // Auto-select evaluator type based on issue category.
  let evaluatorType: EvaluatorDef["evaluator_type"] = "rule_based";
  let criteria: Record<string, unknown> = {};
  let config: Record<string, unknown> = {};

  switch (category) {
    case "latency_spike":
      evaluatorType = "latency";
      // Extract threshold from error pattern (e.g., "threshold 10000ms").
      const latMatch = errorPattern.match(/threshold (\d+)/);
      config = { max_latency_ms: latMatch ? Number(latMatch[1]) : 30_000 };
      criteria = { check: "llm_call_latency", operator: "lte", value: config.max_latency_ms };
      break;

    case "token_blowout":
      evaluatorType = "token_count";
      const tokMatch = errorPattern.match(/threshold (\d+)/);
      config = { max_total_tokens: tokMatch ? Number(tokMatch[1]) : 50_000 };
      criteria = { check: "total_tokens", operator: "lte", value: config.max_total_tokens };
      break;

    case "tool_failure":
    case "llm_error":
    case "governance_denied":
    default:
      evaluatorType = "rule_based";
      // Build a regex pattern from the normalised error.
      const escapedPattern = errorPattern
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .slice(0, 200);
      config = { pattern: escapedPattern, case_insensitive: true };
      criteria = {
        check: "error_message_absent",
        description: rootCause?.evaluator_hint ?? `Ensure error pattern does not recur: ${errorPattern.slice(0, 100)}`,
      };
      break;
  }

  const name = `auto-eval-${category}-${String(issue.id).slice(0, 8)}`;
  const row = await queryOne<{ id: string }>(
    `INSERT INTO audit_governance.engine_evaluators
       (issue_id, name, description, evaluator_type, criteria, evaluator_config, capability_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
     RETURNING id`,
    [
      issueId,
      name,
      `Auto-generated evaluator for issue: ${String(issue.title).slice(0, 200)}`,
      evaluatorType,
      JSON.stringify(criteria),
      JSON.stringify(config),
      issue.capability_id ?? null,
    ],
  );

  return { id: row!.id, name };
}

// ── Runner: evaluate a trace against all enabled evaluators ──────────

export async function runEvaluatorsForTrace(traceId: string): Promise<EvalResult[]> {
  // Load trace events.
  const events = await query<Record<string, unknown>>(
    `SELECT kind, payload, created_at
     FROM audit_governance.audit_events
     WHERE trace_id = $1
     ORDER BY created_at ASC`,
    [traceId],
  );

  // Load LLM call data for the trace.
  const llmCalls = await query<Record<string, unknown>>(
    `SELECT latency_ms, total_tokens, finish_reason, model
     FROM audit_governance.llm_calls
     WHERE trace_id = $1`,
    [traceId],
  );

  // Load enabled evaluators.
  const evaluators = await query<Record<string, unknown>>(
    `SELECT id, evaluator_type, criteria, evaluator_config, capability_id
     FROM audit_governance.engine_evaluators
     WHERE enabled = true`,
  );

  const results: EvalResult[] = [];

  for (const ev of evaluators) {
    const evId = String(ev.id);
    const evType = String(ev.evaluator_type);
    const config = ev.evaluator_config as Record<string, unknown>;
    let passed = true;
    let reason = "pass";

    switch (evType) {
      case "latency": {
        const maxMs = Number(config.max_latency_ms ?? 30_000);
        const worstLatency = Math.max(...llmCalls.map((c) => Number(c.latency_ms ?? 0)), 0);
        passed = worstLatency <= maxMs;
        reason = passed
          ? `Latency ${worstLatency}ms within threshold ${maxMs}ms`
          : `Latency ${worstLatency}ms exceeds threshold ${maxMs}ms`;
        break;
      }
      case "token_count": {
        const maxTokens = Number(config.max_total_tokens ?? 50_000);
        const totalTokens = llmCalls.reduce((sum, c) => sum + Number(c.total_tokens ?? 0), 0);
        passed = totalTokens <= maxTokens;
        reason = passed
          ? `Tokens ${totalTokens} within threshold ${maxTokens}`
          : `Tokens ${totalTokens} exceeds threshold ${maxTokens}`;
        break;
      }
      case "rule_based": {
        const pattern = String(config.pattern ?? "");
        if (pattern) {
          const flags = config.case_insensitive ? "i" : "";
          const re = new RegExp(pattern, flags);
          // Check all event payloads for the error pattern.
          for (const evt of events) {
            const payload = evt.payload as Record<string, unknown>;
            const errorMsg = String(payload.error ?? payload.message ?? "");
            if (re.test(errorMsg)) {
              passed = false;
              reason = `Error pattern matched: "${errorMsg.slice(0, 100)}"`;
              break;
            }
          }
          if (passed) reason = "Error pattern not found in trace events";
        }
        break;
      }
      default:
        reason = `Evaluator type '${evType}' not yet implemented`;
    }

    // Update evaluator stats.
    await query(
      `UPDATE audit_governance.engine_evaluators
       SET fire_count    = fire_count + 1,
           pass_count    = pass_count + $1,
           fail_count    = fail_count + $2,
           last_fired_at = now()
       WHERE id = $3`,
      [passed ? 1 : 0, passed ? 0 : 1, evId],
    );

    results.push({ evaluator_id: evId, trace_id: traceId, passed, reason });
  }

  return results;
}

// ── Batch runner ───────────────────────────────────────────────────────

export async function runEvaluatorsForRecentTraces(
  windowMinutes: number = 60,
  limit: number = 100,
): Promise<{ traces_evaluated: number; total_results: number; failures: number }> {
  const traces = await query<{ trace_id: string }>(
    `SELECT DISTINCT trace_id
     FROM audit_governance.audit_events
     WHERE created_at > now() - ($1 || ' minutes')::interval
       AND trace_id IS NOT NULL
     ORDER BY trace_id
     LIMIT $2`,
    [windowMinutes, limit],
  );

  let totalResults = 0;
  let failures = 0;

  for (const { trace_id } of traces) {
    const results = await runEvaluatorsForTrace(trace_id);
    totalResults += results.length;
    failures += results.filter((r) => !r.passed).length;
  }

  return { traces_evaluated: traces.length, total_results: totalResults, failures };
}
