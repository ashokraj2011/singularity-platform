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
 *   - expected_output_contains: deterministic substring check
 *   - llm_judge:  LLM-powered pass/fail scoring (Phase 2)
 */
import { ensureEngineEvalTables, query, queryOne } from "../db";

// ── Types ──────────────────────────────────────────────────────────────

export interface EvaluatorDef {
  name:            string;
  description:     string;
  evaluator_type:  "rule_based" | "latency" | "token_count" | "expected_output_contains" | "llm_judge";
  criteria:        Record<string, unknown>;
  evaluator_config: Record<string, unknown>;
  capability_id?:  string;
  issue_id?:       string;
}

export interface EvalResult {
  evaluator_id: string;
  trace_id?:     string;
  dataset_example_id?: string;
  passed:       boolean;
  reason:       string;
  score?:       number;
  evidence?:    Record<string, unknown>;
}

export interface PersistedEvalRun {
  id: string;
  mode: "TRACE" | "DATASET";
  trace_id?: string | null;
  dataset_id?: string | null;
  capability_id?: string | null;
  status: string;
  total_examples: number;
  total_evaluators: number;
  passed_count: number;
  failed_count: number;
  pass_rate: number;
  metadata: Record<string, unknown>;
  created_at: string;
  completed_at?: string | null;
  results: EvalResult[];
}

type EvaluatorRow = {
  id: string;
  evaluator_type: string;
  criteria: Record<string, unknown>;
  evaluator_config: Record<string, unknown>;
  capability_id?: string | null;
}

type TraceFacts = {
  traceId: string;
  events: Array<Record<string, unknown>>;
  llmCalls: Array<Record<string, unknown>>;
}

type DatasetExample = {
  id: string;
  trace_id: string;
  input: Record<string, unknown>;
  expected_output: Record<string, unknown> | null;
  actual_output: Record<string, unknown> | null;
  criteria: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
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

async function loadTraceFacts(traceId: string): Promise<TraceFacts> {
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

  return { traceId, events, llmCalls };
}

async function loadEnabledEvaluators(opts: {
  evaluatorIds?: string[];
  capabilityId?: string;
} = {}): Promise<EvaluatorRow[]> {
  const clauses = ["enabled = true"];
  const params: unknown[] = [];
  if (opts.evaluatorIds && opts.evaluatorIds.length > 0) {
    params.push(opts.evaluatorIds);
    clauses.push(`id = ANY($${params.length}::uuid[])`);
  }
  if (opts.capabilityId) {
    params.push(opts.capabilityId);
    clauses.push(`(capability_id IS NULL OR capability_id = $${params.length})`);
  }
  return query<EvaluatorRow>(
    `SELECT id, evaluator_type, criteria, evaluator_config, capability_id
     FROM audit_governance.engine_evaluators
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at ASC`,
    params,
  );
}

function textFromValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function configuredNeedles(config: Record<string, unknown>, criteria?: Record<string, unknown> | null): string[] {
  const raw = config.expected_contains
    ?? config.contains
    ?? criteria?.expected_contains
    ?? criteria?.contains
    ?? criteria?.must_contain;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  return [];
}

function evaluateTrace(ev: EvaluatorRow, facts: TraceFacts): EvalResult {
  const evId = String(ev.id);
  const evType = String(ev.evaluator_type);
  const config = (ev.evaluator_config ?? {}) as Record<string, unknown>;
  const criteria = (ev.criteria ?? {}) as Record<string, unknown>;
  let passed = true;
  let reason = "pass";
  let score = 1;
  let evidence: Record<string, unknown> = {};

  switch (evType) {
    case "latency": {
      const maxMs = Number(config.max_latency_ms ?? 30_000);
      const worstLatency = Math.max(...facts.llmCalls.map((c) => Number(c.latency_ms ?? 0)), 0);
      if (facts.llmCalls.length === 0) {
        passed = false;
        score = 0;
        reason = "Missing LLM latency evidence for trace";
      } else {
        passed = worstLatency <= maxMs;
        score = passed ? 1 : 0;
        reason = passed
          ? `Latency ${worstLatency}ms within threshold ${maxMs}ms`
          : `Latency ${worstLatency}ms exceeds threshold ${maxMs}ms`;
      }
      evidence = { worst_latency_ms: worstLatency, max_latency_ms: maxMs, llm_calls: facts.llmCalls.length };
      break;
    }
    case "token_count": {
      const maxTokens = Number(config.max_total_tokens ?? 50_000);
      const totalTokens = facts.llmCalls.reduce((sum, c) => sum + Number(c.total_tokens ?? 0), 0);
      if (facts.llmCalls.length === 0) {
        passed = false;
        score = 0;
        reason = "Missing LLM token evidence for trace";
      } else {
        passed = totalTokens <= maxTokens;
        score = passed ? 1 : 0;
        reason = passed
          ? `Tokens ${totalTokens} within threshold ${maxTokens}`
          : `Tokens ${totalTokens} exceeds threshold ${maxTokens}`;
      }
      evidence = { total_tokens: totalTokens, max_total_tokens: maxTokens, llm_calls: facts.llmCalls.length };
      break;
    }
    case "expected_output_contains": {
      const needles = configuredNeedles(config, criteria);
      const haystack = textFromValue({
        events: facts.events.map((evt) => evt.payload),
        llm_calls: facts.llmCalls,
      }).toLowerCase();
      passed = needles.length > 0 && needles.every((needle) => haystack.includes(needle.toLowerCase()));
      score = passed ? 1 : 0;
      reason = needles.length === 0
        ? "No expected text configured"
        : passed
          ? "Trace evidence contains all expected text"
          : `Trace evidence is missing: ${needles.filter((needle) => !haystack.includes(needle.toLowerCase())).join(", ")}`;
      evidence = { expected_contains: needles, event_count: facts.events.length, llm_calls: facts.llmCalls.length };
      break;
    }
    case "rule_based": {
      const pattern = String(config.pattern ?? "");
      if (pattern) {
        const flags = config.case_insensitive ? "i" : "";
        const re = new RegExp(pattern, flags);
        // Check all event payloads for the error pattern.
        for (const evt of facts.events) {
          const payload = evt.payload as Record<string, unknown>;
          const errorMsg = String(payload.error ?? payload.message ?? "");
          if (re.test(errorMsg)) {
            passed = false;
            score = 0;
            reason = `Error pattern matched: "${errorMsg.slice(0, 100)}"`;
            evidence = { matched_payload: payload, pattern };
            break;
          }
        }
        if (passed) {
          reason = "Error pattern not found in trace events";
          evidence = { pattern, event_count: facts.events.length };
        }
      } else {
        reason = "No rule pattern configured";
        evidence = { event_count: facts.events.length };
      }
      break;
    }
    case "llm_judge":
      passed = false;
      score = 0;
      reason = "llm_judge is disabled in the MVP evaluator runner";
      evidence = { disabled: true };
      break;
    default:
      passed = false;
      score = 0;
      reason = `Evaluator type '${evType}' not implemented`;
      evidence = { evaluator_type: evType };
  }

  return { evaluator_id: evId, trace_id: facts.traceId, passed, reason, score, evidence };
}

function evaluateDatasetExample(ev: EvaluatorRow, example: DatasetExample): EvalResult {
  const evId = String(ev.id);
  const evType = String(ev.evaluator_type);
  const config = (ev.evaluator_config ?? {}) as Record<string, unknown>;
  const criteria = {
    ...((example.criteria ?? {}) as Record<string, unknown>),
    ...((ev.criteria ?? {}) as Record<string, unknown>),
  };
  let passed = true;
  let reason = "pass";
  let score = 1;
  let evidence: Record<string, unknown> = {};

  switch (evType) {
    case "expected_output_contains": {
      const configured = configuredNeedles(config, criteria);
      const expectedText = textFromValue(example.expected_output).trim();
      const needles = configured.length > 0
        ? configured
        : expectedText ? [expectedText] : [];
      const actual = textFromValue(example.actual_output).toLowerCase();
      passed = needles.length > 0 && needles.every((needle) => actual.includes(needle.toLowerCase()));
      score = passed ? 1 : 0;
      reason = needles.length === 0
        ? "No expected output text is available"
        : passed
          ? "Actual output contains expected text"
          : `Actual output is missing: ${needles.filter((needle) => !actual.includes(needle.toLowerCase())).join(", ")}`;
      evidence = { expected_contains: needles, actual_preview: actual.slice(0, 500) };
      break;
    }
    case "rule_based": {
      const pattern = String(config.pattern ?? "");
      if (!pattern) {
        reason = "No rule pattern configured";
        evidence = { example_id: example.id };
        break;
      }
      const flags = config.case_insensitive ? "i" : "";
      const re = new RegExp(pattern, flags);
      const actual = textFromValue(example.actual_output);
      passed = !re.test(actual);
      score = passed ? 1 : 0;
      reason = passed ? "Error pattern not found in actual output" : "Error pattern matched actual output";
      evidence = { pattern, actual_preview: actual.slice(0, 500) };
      break;
    }
    case "latency":
    case "token_count": {
      passed = false;
      score = 0;
      reason = `${evType} requires trace LLM call evidence; run this evaluator in trace mode`;
      evidence = { evaluator_type: evType };
      break;
    }
    case "llm_judge":
      passed = false;
      score = 0;
      reason = "llm_judge is disabled in the MVP evaluator runner";
      evidence = { disabled: true };
      break;
    default:
      passed = false;
      score = 0;
      reason = `Evaluator type '${evType}' not implemented`;
      evidence = { evaluator_type: evType };
  }

  return {
    evaluator_id: evId,
    trace_id: example.trace_id,
    dataset_example_id: example.id,
    passed,
    reason,
    score,
    evidence,
  };
}

async function recordEvaluatorStats(results: EvalResult[]): Promise<void> {
  const byEvaluator = new Map<string, { pass: number; fail: number }>();
  for (const result of results) {
    const row = byEvaluator.get(result.evaluator_id) ?? { pass: 0, fail: 0 };
    if (result.passed) row.pass += 1;
    else row.fail += 1;
    byEvaluator.set(result.evaluator_id, row);
  }
  for (const [evId, stats] of byEvaluator.entries()) {
    await query(
      `UPDATE audit_governance.engine_evaluators
       SET fire_count    = fire_count + $1,
           pass_count    = pass_count + $2,
           fail_count    = fail_count + $3,
           last_fired_at = now()
       WHERE id = $4`,
      [stats.pass + stats.fail, stats.pass, stats.fail, evId],
    );
  }
}

export async function runEvaluatorsForTrace(
  traceId: string,
  opts: { evaluatorIds?: string[]; capabilityId?: string } = {},
): Promise<EvalResult[]> {
  const facts = await loadTraceFacts(traceId);

  // Load enabled evaluators.
  const evaluators = await loadEnabledEvaluators(opts);

  const results: EvalResult[] = [];

  for (const ev of evaluators) {
    results.push(evaluateTrace(ev, facts));
  }

  await recordEvaluatorStats(results);
  return results;
}

async function createEvalRun(args: {
  mode: "TRACE" | "DATASET";
  traceId?: string;
  datasetId?: string;
  capabilityId?: string;
  totalExamples: number;
  totalEvaluators: number;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  await ensureEngineEvalTables();
  const row = await queryOne<{ id: string }>(
    `INSERT INTO audit_governance.engine_eval_runs
       (mode, trace_id, dataset_id, capability_id, total_examples, total_evaluators, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING id`,
    [
      args.mode,
      args.traceId ?? null,
      args.datasetId ?? null,
      args.capabilityId ?? null,
      args.totalExamples,
      args.totalEvaluators,
      JSON.stringify(args.metadata ?? {}),
    ],
  );
  return row!.id;
}

async function persistEvalRunResults(runId: string, results: EvalResult[]): Promise<void> {
  for (const result of results) {
    await query(
      `INSERT INTO audit_governance.engine_eval_results
         (eval_run_id, evaluator_id, trace_id, dataset_example_id, passed, score, reason, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        runId,
        result.evaluator_id,
        result.trace_id ?? null,
        result.dataset_example_id ?? null,
        result.passed,
        result.score ?? null,
        result.reason,
        JSON.stringify(result.evidence ?? {}),
      ],
    );
  }
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const passRate = results.length > 0 ? passed / results.length : 0;
  await query(
    `UPDATE audit_governance.engine_eval_runs
     SET status = 'COMPLETED',
         passed_count = $1,
         failed_count = $2,
         pass_rate = $3,
         completed_at = now()
     WHERE id = $4`,
    [passed, failed, passRate, runId],
  );
}

export async function runTraceEvaluatorsPersisted(args: {
  traceId: string;
  evaluatorIds?: string[];
  capabilityId?: string;
  metadata?: Record<string, unknown>;
}): Promise<PersistedEvalRun> {
  const evaluators = await loadEnabledEvaluators({
    evaluatorIds: args.evaluatorIds,
    capabilityId: args.capabilityId,
  });
  const runId = await createEvalRun({
    mode: "TRACE",
    traceId: args.traceId,
    capabilityId: args.capabilityId,
    totalExamples: 1,
    totalEvaluators: evaluators.length,
    metadata: args.metadata,
  });
  const facts = await loadTraceFacts(args.traceId);
  const results = evaluators.map((ev) => evaluateTrace(ev, facts));
  await recordEvaluatorStats(results);
  await persistEvalRunResults(runId, results);
  return getEvalRun(runId);
}

export async function runDatasetEvaluatorsPersisted(args: {
  datasetId: string;
  evaluatorIds?: string[];
  capabilityId?: string;
  metadata?: Record<string, unknown>;
}): Promise<PersistedEvalRun> {
  const [evaluators, examples] = await Promise.all([
    loadEnabledEvaluators({ evaluatorIds: args.evaluatorIds, capabilityId: args.capabilityId }),
    query<DatasetExample>(
      `SELECT id, trace_id, input, expected_output, actual_output, criteria, metadata
       FROM audit_governance.engine_dataset_examples
       WHERE dataset_id = $1
       ORDER BY created_at ASC`,
      [args.datasetId],
    ),
  ]);
  const runId = await createEvalRun({
    mode: "DATASET",
    datasetId: args.datasetId,
    capabilityId: args.capabilityId,
    totalExamples: examples.length,
    totalEvaluators: evaluators.length,
    metadata: args.metadata,
  });
  const results = examples.flatMap((example) => evaluators.map((ev) => evaluateDatasetExample(ev, example)));
  await recordEvaluatorStats(results);
  await persistEvalRunResults(runId, results);
  return getEvalRun(runId);
}

export async function getEvalRun(id: string): Promise<PersistedEvalRun> {
  await ensureEngineEvalTables();
  const run = await queryOne<Record<string, unknown>>(
    `SELECT * FROM audit_governance.engine_eval_runs WHERE id = $1`,
    [id],
  );
  if (!run) throw Object.assign(new Error("eval run not found"), { status: 404 });
  const results = await query<Record<string, unknown>>(
    `SELECT evaluator_id, trace_id, dataset_example_id, passed, score, reason, evidence
     FROM audit_governance.engine_eval_results
     WHERE eval_run_id = $1
     ORDER BY created_at ASC`,
    [id],
  );
  return {
    id: String(run.id),
    mode: String(run.mode) as "TRACE" | "DATASET",
    trace_id: run.trace_id as string | null | undefined,
    dataset_id: run.dataset_id as string | null | undefined,
    capability_id: run.capability_id as string | null | undefined,
    status: String(run.status),
    total_examples: Number(run.total_examples ?? 0),
    total_evaluators: Number(run.total_evaluators ?? 0),
    passed_count: Number(run.passed_count ?? 0),
    failed_count: Number(run.failed_count ?? 0),
    pass_rate: Number(run.pass_rate ?? 0),
    metadata: (run.metadata ?? {}) as Record<string, unknown>,
    created_at: isoString(run.created_at),
    completed_at: run.completed_at == null ? null : isoString(run.completed_at),
    results: results.map((row) => ({
      evaluator_id: String(row.evaluator_id),
      trace_id: row.trace_id ? String(row.trace_id) : undefined,
      dataset_example_id: row.dataset_example_id ? String(row.dataset_example_id) : undefined,
      passed: Boolean(row.passed),
      score: row.score == null ? undefined : Number(row.score),
      reason: String(row.reason ?? ""),
      evidence: (row.evidence ?? {}) as Record<string, unknown>,
    })),
  };
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
