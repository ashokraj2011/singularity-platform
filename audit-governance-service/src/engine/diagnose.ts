/**
 * Singularity Engine — LLM-powered root-cause diagnosis.
 *
 * When an operator triggers diagnosis on an engine_issue, this module:
 *   1. Loads the issue's sample trace timelines from audit_events
 *   2. Builds a structured prompt for the LLM
 *   3. Calls the central LLM gateway's /v1/chat/completions endpoint (M33)
 *   4. Stores the diagnosis in engine_issues.root_cause
 *   5. Auto-generates a proposed fix based on the diagnosis
 *
 * No provider keys live here; the gateway is the single LLM call point.
 */
import { query, queryOne } from "../db";

const LLM_GATEWAY_URL    = process.env.LLM_GATEWAY_URL    ?? "http://llm-gateway:8001";
const LLM_GATEWAY_BEARER = process.env.LLM_GATEWAY_BEARER ?? "";
const ENGINE_MODEL_ALIAS = process.env.ENGINE_MODEL_ALIAS ?? "mock";
const ENGINE_TIMEOUT_MS  = Number(process.env.ENGINE_TIMEOUT_MS ?? 120_000);

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

const DIAGNOSIS_SYSTEM_PROMPT = `You are a production agent debugging expert for the Singularity AI agent platform.

You will receive clustered failure data from production traces. Your job is to:
1. Identify the root cause of the failure pattern
2. Classify the fix type (prompt change, tool description fix, config change, code fix)
3. Propose a specific, actionable fix
4. Suggest what an automated evaluator should check to prevent regression

Respond ONLY in valid JSON matching this schema:
{
  "root_cause": "Clear explanation of why the failures are occurring",
  "confidence": "high|medium|low",
  "category": "The failure category",
  "fix_type": "prompt|tool_description|config|code|unknown",
  "fix_summary": "One-line summary of the proposed fix",
  "fix_detail": "Detailed description of exactly what to change",
  "evaluator_hint": "What an automated evaluator should check for"
}`;

async function callLlmForDiagnosis(prompt: string): Promise<DiagnosisResult> {
  // M33 — LLM call goes through the central llm-gateway. If the gateway
  // is unavailable, fall back to deterministic local heuristics rather
  // than reaching for any provider SDK or API directly.
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (LLM_GATEWAY_BEARER) headers.authorization = `Bearer ${LLM_GATEWAY_BEARER}`;
    const llmRes = await fetch(`${LLM_GATEWAY_URL.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model_alias: ENGINE_MODEL_ALIAS,
        messages: [
          { role: "system", content: DIAGNOSIS_SYSTEM_PROMPT },
          { role: "user",   content: prompt },
        ],
        temperature: 0,
        max_output_tokens: 1500,
        trace_id: `engine-diagnose-${Date.now()}`,
      }),
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
    });
    if (llmRes.ok) {
      const data = await llmRes.json() as { content?: string };
      const content = data.content ?? "";
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as DiagnosisResult;
      }
    }
  } catch {
    // Gateway unavailable — fall through to heuristic analysis.
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
