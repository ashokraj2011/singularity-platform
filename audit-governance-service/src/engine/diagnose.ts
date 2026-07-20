/**
 * Singularity Engine — LLM-powered root-cause diagnosis.
 *
 * When an operator triggers diagnosis on an engine_issue, this module:
 *   1. Loads the issue's sample trace timelines from audit_events
 *   2. Builds a structured prompt for the LLM
 *   3. Calls llm-gateway directly (single-turn, no tools)
 *   4. Stores the diagnosis in engine_issues.root_cause
 *   5. Auto-generates a proposed fix based on the diagnosis
 *
 * Routing note (2026-05-23): the original implementation POSTed to
 * mcp-server's /mcp/invoke. After the M71 cutover that endpoint
 * returns 410 GONE — every diagnose call has silently fallen back to
 * the heuristic path since then. Re-pointed at llm-gateway following
 * the M74 Phase 2A llm-judge.ts pattern: single-turn diagnosis isn't
 * an agent loop, so the gateway is the right endpoint shape.
 *
 * No provider keys live here. Heuristic fallback kicks in iff the
 * gateway is unreachable or returns a malformed payload.
 */
import { query, queryOne } from "../db";
import { readUpstreamJsonObject } from "./upstream-json";
import { boundedEnvInteger } from "../env";
// One actor constant per service, shared with llm-judge.ts, so the two gateway
// call sites in audit-gov cannot drift into two spellings of the same service.
import { GATEWAY_ACTOR_ID } from "./llm-judge";

const LLM_GATEWAY_URL    = (process.env.LLM_GATEWAY_URL ?? "http://host.docker.internal:8001").replace(/\/$/, "");
const ENGINE_MODEL_ALIAS = process.env.ENGINE_MODEL_ALIAS?.trim();
const ENGINE_TIMEOUT_MS  = boundedEnvInteger("ENGINE_TIMEOUT_MS", {
  defaultValue: 120_000,
  min: 1_000,
  max: 600_000,
});

// ── Trace loading ──────────────────────────────────────────────────────

interface TraceTimeline {
  trace_id: string;
  events: Array<{
    kind: string;
    source_service: string;
    severity: string;
    payload: Record<string, unknown>;
    created_at: string;
  }>;
}

async function loadTraceTimelines(traceIds: string[]): Promise<TraceTimeline[]> {
  if (traceIds.length === 0) return [];
  const timelines: TraceTimeline[] = [];

  // Load up to 5 traces (avoid prompt explosion).
  for (const tid of traceIds.slice(0, 5)) {
    const events = await query<Record<string, unknown>>(
      `SELECT kind, source_service, severity, payload, created_at
       FROM audit_governance.audit_events
       WHERE trace_id = $1
       ORDER BY created_at ASC
       LIMIT 50`,
      [tid],
    );
    timelines.push({
      trace_id: tid,
      events: events.map((e) => ({
        kind:           String(e.kind),
        source_service: String(e.source_service),
        severity:       String(e.severity),
        payload:        e.payload as Record<string, unknown>,
        created_at:     String(e.created_at),
      })),
    });
  }
  return timelines;
}

// ── LLM call ──────────────────────────────────────────────────────────

interface DiagnosisResult {
  root_cause:    string;
  confidence:    "high" | "medium" | "low";
  category:      string;
  fix_type:      "prompt" | "tool_description" | "config" | "code" | "unknown";
  fix_summary:   string;
  fix_detail:    string;
  evaluator_hint: string;
}

// M36.4 — diagnosis system prompt was hardcoded here; now lives in
// prompt-composer SystemPrompt table under key "audit-gov.diagnose". Fetched
// once on first use, cached in-process. Audit-gov lives outside the
// agent-and-tools workspace so we inline the cache helper (~30 lines).
const PROMPT_COMPOSER_URL = process.env.PROMPT_COMPOSER_URL?.trim() ?? "http://prompt-composer:3004";
const DIAGNOSIS_PROMPT_KEY = "audit-gov.diagnose";
let cachedDiagnosisPrompt: string | null = null;
let cachedDiagnosisPromptAt = 0;
const DIAGNOSIS_PROMPT_TTL_MS = boundedEnvInteger("SYSTEM_PROMPT_CACHE_TTL_SEC", {
  defaultValue: 300,
  min: 1,
  max: 86_400,
}) * 1000;

async function getDiagnosisSystemPrompt(): Promise<string> {
  if (cachedDiagnosisPrompt && Date.now() - cachedDiagnosisPromptAt < DIAGNOSIS_PROMPT_TTL_MS) {
    return cachedDiagnosisPrompt;
  }
  const res = await fetch(
    `${PROMPT_COMPOSER_URL.replace(/\/$/, "")}/api/v1/system-prompts/${encodeURIComponent(DIAGNOSIS_PROMPT_KEY)}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) {
    if (cachedDiagnosisPrompt) return cachedDiagnosisPrompt; // stale-ok
    const text = await res.text().catch(() => "");
    throw new Error(`audit-gov diagnose system prompt fetch failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const body = await readUpstreamJsonObject<{ success?: unknown; data?: unknown }>(res, "audit-gov diagnose system prompt");
  if (body.success !== true) {
    if (cachedDiagnosisPrompt) return cachedDiagnosisPrompt;
    throw new Error(`audit-gov diagnose system prompt fetch returned success=false`);
  }
  const data = body.data && typeof body.data === "object" && !Array.isArray(body.data)
    ? body.data as Record<string, unknown>
    : {};
  const content = typeof data.content === "string" ? data.content : "";
  if (!content) {
    if (cachedDiagnosisPrompt) return cachedDiagnosisPrompt;
    throw new Error("audit-gov diagnose system prompt response did not include content");
  }
  cachedDiagnosisPrompt = content;
  cachedDiagnosisPromptAt = Date.now();
  return cachedDiagnosisPrompt;
}

async function callLlmForDiagnosis(prompt: string): Promise<DiagnosisResult> {
  // Single-turn diagnosis: system prompt from prompt-composer + user
  // prompt with the trace timelines, JSON response parsed out. No
  // tool use, no multi-turn — so we call llm-gateway directly rather
  // than running through the governed agent loop in context-fabric.
  //
  // Failure → heuristic fallback. Never throws: silent degradation is
  // the right behaviour for an operator-triggered diagnose action
  // (the heuristic answer is usually directionally correct, and the
  // operator can re-run when the gateway comes back).
  try {
    const systemPrompt = await getDiagnosisSystemPrompt();
    const res = await fetch(`${LLM_GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // ENGINE_MODEL_ALIAS still wins when set. Unset, the call declares that
        // it is audit-gov diagnosis rather than arriving with no identity at all
        // — which is what let this traffic silently share whatever the gateway's
        // global default alias was.
        task_tag: "judge",
        purpose: "diagnosis",
        ...(ENGINE_MODEL_ALIAS ? { model_alias: ENGINE_MODEL_ALIAS } : {}),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_output_tokens: 1500,
        trace_id: `audit-gov-diagnose-${Date.now()}`,
        // Same bucket as llm-judge: the vocabulary's "judge" covers audit-gov
        // LLM judging AND diagnosis (task_tags.py:32). Previously untagged,
        // so it would 400 under GATEWAY_REQUIRE_TASK_TAG.
        task_tag: "judge",
        // Operator-triggered, but the operator's identity does not reach here:
        // diagnoseIssue() takes only an issueId. The engine is the actor.
        actor_id: GATEWAY_ACTOR_ID,
        // No tenant_id — engine_issues rows are not tenant-scoped on this branch.
      }),
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = await readUpstreamJsonObject<{ content?: unknown }>(res, "LLM gateway diagnose");
      const content = typeof body.content === "string" ? body.content : "";
      // The diagnosis prompt instructs the model to emit a single
      // JSON object. Tolerate a code-fence wrapper or a leading
      // chatty preamble — we match the outermost {...} balanced
      // span. Cheap regex (greedy) is fine because heuristic
      // fallback catches malformed responses.
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as DiagnosisResult;
      }
    }
  } catch {
    // Gateway unreachable / non-JSON / parse failure — fall through
    // to heuristic. Intentional swallow: the heuristic path is the
    // documented degradation mode and the operator-visible status
    // doesn't lie ("low" confidence on the heuristic branch).
  }

  // Heuristic fallback when LLM is not available.
  return heuristicDiagnosis(prompt);
}

function heuristicDiagnosis(prompt: string): DiagnosisResult {
  const lower = prompt.toLowerCase();
  if (lower.includes("tool") && lower.includes("not registered")) {
    return {
      root_cause: "Tool referenced by the agent is not registered in the MCP server's local tool registry.",
      confidence: "high",
      category: "tool_failure",
      fix_type: "config",
      fix_summary: "Register the missing tool or update the agent prompt to use available tools.",
      fix_detail: "Check mcp-server/src/tools/registry.ts for the registered tool list and add the missing tool.",
      evaluator_hint: "Check that all tools referenced in agent responses exist in the tool registry.",
    };
  }
  if (lower.includes("latency") || lower.includes("timeout")) {
    return {
      root_cause: "LLM call latency exceeds acceptable thresholds, possibly due to context size or model load.",
      confidence: "medium",
      category: "latency_spike",
      fix_type: "config",
      fix_summary: "Consider reducing context window size or switching to a faster model.",
      fix_detail: "Adjust max_context_tokens in the context policy or switch to gpt-4o-mini for latency-sensitive tasks.",
      evaluator_hint: "Monitor p95 latency and flag if it exceeds 2x the 7-day rolling average.",
    };
  }
  if (lower.includes("token") && (lower.includes("blowout") || lower.includes("exceed"))) {
    return {
      root_cause: "Token usage is abnormally high, likely due to excessive context or repeated tool calls.",
      confidence: "medium",
      category: "token_blowout",
      fix_type: "prompt",
      fix_summary: "Add context pruning or limit agent loop iterations.",
      fix_detail: "Reduce max_steps, enable aggressive context optimization, or add token budget guardrails.",
      evaluator_hint: "Flag traces where total_tokens exceeds the configured budget threshold.",
    };
  }
  return {
    root_cause: "Unable to determine root cause automatically. Manual trace review recommended.",
    confidence: "low",
    category: "unknown",
    fix_type: "unknown",
    fix_summary: "Review the sample traces manually to identify the failure pattern.",
    fix_detail: "Use the audit timeline to inspect the full trace for each sample_trace_id.",
    evaluator_hint: "Create a rule-based evaluator matching the error message pattern.",
  };
}

// ── Public API ─────────────────────────────────────────────────────────

export interface DiagnoseResult {
  issue_id:    string;
  root_cause:  DiagnosisResult;
  proposed_fix: {
    type:        string;
    summary:     string;
    detail:      string;
  };
  status:      string;
}

// ── Exported helpers for tests ─────────────────────────────────────────
// Re-pointing the gateway call (the M71-cutover bug fix above) needed
// focused unit coverage that doesn't drag the full Postgres path into
// every test. Same pattern as llm-judge.ts:__test_internals.
export const __test_internals = {
  callLlmForDiagnosis,
  heuristicDiagnosis,
};

export async function diagnoseIssue(issueId: string): Promise<DiagnoseResult> {
  const issue = await queryOne<Record<string, unknown>>(
    `SELECT * FROM audit_governance.engine_issues WHERE id = $1`,
    [issueId],
  );
  if (!issue) throw Object.assign(new Error("issue not found"), { status: 404 });

  const traceIds = (issue.sample_trace_ids as string[]) ?? [];
  const timelines = await loadTraceTimelines(traceIds);

  // Build the diagnosis prompt.
  const prompt = [
    `## Issue: ${issue.title}`,
    `Category: ${issue.category}`,
    `Severity: ${issue.severity}`,
    `Trace count: ${issue.trace_count}`,
    `Error pattern: ${issue.error_pattern ?? "N/A"}`,
    "",
    "## Sample Trace Timelines",
    ...timelines.map((t) => [
      `### Trace ${t.trace_id}`,
      ...t.events.map((e) =>
        `  [${e.created_at}] ${e.kind} (${e.severity}) — ${JSON.stringify(e.payload).slice(0, 300)}`,
      ),
    ].join("\n")),
    "",
    "Analyze the failure pattern and provide your diagnosis.",
  ].join("\n");

  const diagnosis = await callLlmForDiagnosis(prompt);

  // Store the diagnosis.
  await query(
    `UPDATE audit_governance.engine_issues
     SET root_cause    = $1::jsonb,
         proposed_fix  = $2::jsonb,
         status        = 'fix_proposed',
         updated_at    = now()
     WHERE id = $3`,
    [
      JSON.stringify(diagnosis),
      JSON.stringify({
        type:    diagnosis.fix_type,
        summary: diagnosis.fix_summary,
        detail:  diagnosis.fix_detail,
      }),
      issueId,
    ],
  );

  return {
    issue_id:    issueId,
    root_cause:  diagnosis,
    proposed_fix: {
      type:    diagnosis.fix_type,
      summary: diagnosis.fix_summary,
      detail:  diagnosis.fix_detail,
    },
    status: "fix_proposed",
  };
}
