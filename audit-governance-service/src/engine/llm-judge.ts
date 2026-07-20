/**
 * M74 Phase 2A — LLM-as-judge evaluator.
 *
 * The eval system needed a capability bar, not just a regression bar.
 * Substring matching and regex catch "did the same crash happen again";
 * they don't catch "is the new code actually a good fix." This module
 * runs an LLM judge against the (expected, actual, rubric) tuple and
 * returns a numeric score + reason.
 *
 * Routing: posts directly to llm-gateway's /v1/chat/completions rather
 * than going through mcp-server. mcp-server's /mcp/invoke returns 410
 * Gone after the M71 cutover, so the legacy diagnose path
 * (diagnose.ts:113) is broken too — but that's a separate bug.
 * Judging is a single-turn evaluation, not an agent loop, so the
 * gateway is the right endpoint shape.
 *
 * Failure handling is deliberately strict-fail-closed by default: a
 * judge that can't run produces a failed eval, not a silently-passed
 * one. Set evaluator_config.fail_mode = "open" to opt out (useful for
 * non-critical evaluators that shouldn't block on judge outages).
 */

import { getRubricForStageType, type RubricSpec } from "./rubrics";
import { readUpstreamJsonObject } from "./upstream-json";
import { boundedEnvInteger } from "../env";

const LLM_GATEWAY_URL = (process.env.LLM_GATEWAY_URL ?? "http://host.docker.internal:8001").replace(/\/$/, "");
const DEFAULT_JUDGE_MODEL_ALIAS = process.env.JUDGE_MODEL_ALIAS ?? process.env.ENGINE_MODEL_ALIAS ?? "";
const DEFAULT_JUDGE_TIMEOUT_MS = boundedEnvInteger("JUDGE_TIMEOUT_MS", {
  defaultValue: 30_000,
  min: 1_000,
  max: 300_000,
});
const DEFAULT_JUDGE_THRESHOLD = 3; // pass when judge scores >= 3 on a 1-5 scale

/**
 * Gateway actor for this service's background LLM traffic.
 *
 * The `system:<service-name>` form is load-bearing: it lets the gateway tell
 * "no human involved" apart from "the caller failed to propagate an actor",
 * which a null actor_id would conflate. Exported so the guard test can assert
 * every gateway call site here uses it.
 */
export const GATEWAY_ACTOR_ID = "system:audit-governance-service";

export interface JudgeInput {
  /** Optional rubric text. If absent, looked up by stage_type. */
  rubricText?: string;
  /** Stage type for rubric lookup. */
  stageType?: string;
  /** Expected output — typically operator-curated or prior-trace baseline. */
  expected: string;
  /** Actual output from the trace/dataset row under evaluation. */
  actual: string;
  /** Score >= threshold passes. 1-5 scale. */
  threshold?: number;
  /** Which model_alias to use for judging. Empty string = gateway default. */
  modelAlias?: string;
  /** Hard timeout on the gateway call. */
  timeoutMs?: number;
  /**
   * "closed" (default): judge unavailable → eval fails (safe).
   * "open": judge unavailable → eval passes (use for low-criticality).
   */
  failMode?: "open" | "closed";
}

export interface JudgeOutcome {
  /** True when score >= threshold AND judge actually ran. */
  passed: boolean;
  /** 0 when judge couldn't run; 1..5 when it did. */
  score: number;
  /**
   * Human-readable explanation. Either the judge's own reason field,
   * or the failure-mode message when the judge couldn't run.
   */
  reason: string;
  /** Structured detail for the eval evidence column. */
  evidence: Record<string, unknown>;
}

interface GatewayMessage {
  role: "system" | "user";
  content: string;
}

interface GatewayResponse {
  content: string;
  finish_reason: string;
  input_tokens?: number;
  output_tokens?: number;
  provider?: string;
  model?: string;
}

interface JudgeJsonResponse {
  score: number;
  reason?: string;
  criteria_met?: string[];
  criteria_failed?: string[];
}

const JUDGE_SYSTEM_PROMPT = [
  "You are an expert code reviewer evaluating an agent's output.",
  "You will be given a rubric, an expected output (baseline or target), and the agent's actual output.",
  "Score the actual output on a 1-5 scale per the rubric:",
  "  5 — fully meets the rubric, no concerns",
  "  4 — meets the rubric with minor gaps that don't affect correctness",
  "  3 — partially meets the rubric; acceptable but with notable gaps",
  "  2 — fails a key rubric criterion",
  "  1 — fundamentally wrong or missing",
  "",
  "Respond with ONLY a JSON object, no prose before or after, of the shape:",
  "  {",
  "    \"score\": <integer 1-5>,",
  "    \"reason\": \"<one to three sentences explaining the score>\",",
  "    \"criteria_met\": [\"<bullet>\", ...],",
  "    \"criteria_failed\": [\"<bullet>\", ...]",
  "  }",
].join("\n");

function buildUserPrompt(rubric: string, expected: string, actual: string): string {
  return [
    "RUBRIC:",
    rubric,
    "",
    "EXPECTED OUTPUT (baseline or target):",
    expected || "(none provided)",
    "",
    "ACTUAL OUTPUT (what the agent produced):",
    actual || "(none provided)",
    "",
    "Score the actual output against the rubric. JSON only.",
  ].join("\n");
}

/** Extract the first {...} JSON object from possibly-noisy text. */
function extractJsonObject(text: string): JudgeJsonResponse | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (
      parsed && typeof parsed === "object" &&
      "score" in parsed && typeof (parsed as JudgeJsonResponse).score === "number"
    ) {
      return parsed as JudgeJsonResponse;
    }
    return null;
  } catch {
    return null;
  }
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score < 1) return 1;
  if (score > 5) return 5;
  return Math.round(score);
}

/**
 * Resolve a rubric. Caller-provided text wins; else look up the stage-type
 * default; else fall back to a minimal generic rubric that's better than
 * nothing.
 */
function resolveRubric(input: JudgeInput): RubricSpec {
  if (input.rubricText && input.rubricText.trim()) {
    return {
      text: input.rubricText.trim(),
      source: "config",
      stageType: input.stageType ?? null,
    };
  }
  if (input.stageType) {
    const fromCatalog = getRubricForStageType(input.stageType);
    if (fromCatalog) return fromCatalog;
  }
  return {
    text: "Does the actual output address the apparent intent of the expected output? Are there obvious omissions, factual errors, or contradictions?",
    source: "fallback-generic",
    stageType: input.stageType ?? null,
  };
}

/**
 * Run the judge. Pure orchestration: build messages, POST to gateway,
 * parse response, classify pass/fail. Never throws; failure modes go
 * through the JudgeOutcome contract.
 */
export async function runJudge(input: JudgeInput): Promise<JudgeOutcome> {
  const threshold = input.threshold ?? DEFAULT_JUDGE_THRESHOLD;
  const failMode = input.failMode ?? "closed";
  const modelAlias = input.modelAlias ?? DEFAULT_JUDGE_MODEL_ALIAS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
  const rubric = resolveRubric(input);

  const messages: GatewayMessage[] = [
    { role: "system", content: JUDGE_SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(rubric.text, input.expected, input.actual) },
  ];

  let res: Response;
  try {
    res = await fetch(`${LLM_GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(modelAlias ? { model_alias: modelAlias } : {}),
        messages,
        temperature: 0,
        max_output_tokens: 800,
        trace_id: `audit-gov-judge-${Date.now()}`,
        // This call reached the gateway with no task_tag, so it would 400 the
        // moment GATEWAY_REQUIRE_TASK_TAG flips — and until then its spend was
        // unattributable. "judge" is the vocabulary's bucket for exactly this
        // (llm_gateway_service/app/task_tags.py).
        task_tag: "judge",
        // Nobody is waiting on this: eval judging is engine-triggered work, so
        // "system:<service>" is the truthful actor. Never null — null is
        // reserved for "somebody forgot to propagate it".
        actor_id: GATEWAY_ACTOR_ID,
        // No tenant_id: JudgeInput carries no tenant, and the eval rows this
        // scores are not tenant-scoped on this branch. Inventing a default
        // would make a fabricated value indistinguishable from a real one.
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return judgeUnavailable(`gateway unreachable: ${message}`, rubric, failMode);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return judgeUnavailable(
      `gateway ${res.status}: ${detail.slice(0, 200)}`,
      rubric,
      failMode,
    );
  }

  let gw: GatewayResponse;
  try {
    gw = await readUpstreamJsonObject<GatewayResponse>(res, "LLM gateway judge");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return judgeUnavailable(`gateway returned non-JSON: ${message}`, rubric, failMode);
  }

  const parsed = extractJsonObject(gw.content ?? "");
  if (!parsed) {
    return {
      passed: failMode === "open",
      score: 0,
      reason: failMode === "open"
        ? "judge response not parseable; failing open per config"
        : "judge response not parseable; failing closed (set fail_mode=open to override)",
      evidence: {
        judge_status: "malformed_response",
        raw_content: (gw.content ?? "").slice(0, 500),
        rubric_source: rubric.source,
        stage_type: rubric.stageType,
        provider: gw.provider,
        model: gw.model,
      },
    };
  }

  const score = clampScore(parsed.score);
  const passed = score >= threshold;
  const judgeReason = parsed.reason?.trim() || `judge returned score ${score} (no reason text)`;
  return {
    passed,
    score,
    reason: passed
      ? `judge passed (score=${score} >= threshold=${threshold}): ${judgeReason}`
      : `judge failed (score=${score} < threshold=${threshold}): ${judgeReason}`,
    evidence: {
      judge_status: "ran",
      score,
      threshold,
      rubric_source: rubric.source,
      stage_type: rubric.stageType,
      criteria_met: parsed.criteria_met ?? [],
      criteria_failed: parsed.criteria_failed ?? [],
      provider: gw.provider,
      model: gw.model,
      input_tokens: gw.input_tokens,
      output_tokens: gw.output_tokens,
    },
  };
}

function judgeUnavailable(
  why: string,
  rubric: RubricSpec,
  failMode: "open" | "closed",
): JudgeOutcome {
  const passed = failMode === "open";
  return {
    passed,
    score: 0,
    reason: passed
      ? `judge unavailable (${why}); failing open per config`
      : `judge unavailable (${why}); failing closed (set fail_mode=open to override)`,
    evidence: {
      judge_status: "unavailable",
      gateway_url: LLM_GATEWAY_URL,
      why,
      rubric_source: rubric.source,
      stage_type: rubric.stageType,
    },
  };
}

// ── Exported helpers for tests ───────────────────────────────────────────

export const __test_internals = {
  buildUserPrompt,
  extractJsonObject,
  clampScore,
  resolveRubric,
  JUDGE_SYSTEM_PROMPT,
};
