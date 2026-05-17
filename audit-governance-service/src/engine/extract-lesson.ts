/**
 * M38 — Lesson extractor for confirmed-resolved failure clusters.
 *
 * Trigger model:
 *   1. cluster.ts marks an issue status='resolved' when no new failures appear
 *      in a sweep window after the issue's last_seen_at + grace period.
 *   2. After LESSON_CONFIRM_WINDOW_SEC (default 1h) with status=resolved AND
 *      no re-open, we set resolution_confirmed_at to "lock in" the resolution.
 *   3. This module finds successful retry traces on the same (capability_id,
 *      tool_name) within ±2h of the original failures, builds an extraction
 *      prompt from the failure pattern + retry trace, and asks the LLM (via
 *      the audit-gov.lesson-extract SystemPrompt) for a 2-sentence rule.
 *   4. POSTs the rule to prompt-composer's /api/v1/lessons endpoint, which
 *      embeds + persists + supersedes near-duplicate older lessons.
 *
 * Idempotency: engine_issues.lesson_id is set after a successful POST; this
 * module skips any issue with a non-null lesson_id so re-runs are safe.
 */
import { query, queryOne } from "../db";

const LESSON_CONFIRM_WINDOW_SEC = Number(process.env.LESSON_CONFIRM_WINDOW_SEC ?? 3600);
const RETRY_LOOKBACK_HOURS      = Number(process.env.LESSON_RETRY_LOOKBACK_HOURS ?? 2);
const PROMPT_COMPOSER_URL       = (process.env.PROMPT_COMPOSER_URL ?? "http://prompt-composer:3004").replace(/\/$/, "");
const LLM_GATEWAY_URL           = (process.env.LLM_GATEWAY_URL ?? "http://llm-gateway:8001").replace(/\/$/, "");
const LLM_GATEWAY_BEARER        = process.env.LLM_GATEWAY_BEARER ?? "";
const ENGINE_MODEL_ALIAS        = process.env.ENGINE_MODEL_ALIAS ?? "";
const EXTRACT_TIMEOUT_MS        = Number(process.env.LESSON_EXTRACT_TIMEOUT_MS ?? 30_000);

// SystemPrompt cache (same pattern as audit-gov/src/engine/diagnose.ts).
const LESSON_PROMPT_KEY = "audit-gov.lesson-extract";
let cachedLessonSystemPrompt: string | null = null;
let cachedLessonSystemPromptAt = 0;
const LESSON_PROMPT_TTL_MS = Number(process.env.SYSTEM_PROMPT_CACHE_TTL_SEC ?? 300) * 1000;

async function getLessonSystemPrompt(): Promise<string> {
  if (cachedLessonSystemPrompt && Date.now() - cachedLessonSystemPromptAt < LESSON_PROMPT_TTL_MS) {
    return cachedLessonSystemPrompt;
  }
  const url = `${PROMPT_COMPOSER_URL}/api/v1/system-prompts/${encodeURIComponent(LESSON_PROMPT_KEY)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    if (cachedLessonSystemPrompt) return cachedLessonSystemPrompt;
    throw new Error(`audit-gov lesson-extract system prompt fetch failed: ${res.status}`);
  }
  const body = await res.json() as { success: boolean; data: { content: string } };
  if (!body.success) {
    if (cachedLessonSystemPrompt) return cachedLessonSystemPrompt;
    throw new Error(`audit-gov lesson-extract system prompt returned success=false`);
  }
  cachedLessonSystemPrompt = body.data.content;
  cachedLessonSystemPromptAt = Date.now();
  return cachedLessonSystemPrompt;
}

interface IssueRow extends Record<string, unknown> {
  id: string;
  title: string;
  description: string | null;
  capability_id: string | null;
  error_pattern: string | null;
  sample_trace_ids: string[];
  root_cause: Record<string, unknown> | null;
  resolved_at: string | null;
  last_seen_at: string;
  resolution_confirmed_at: string | null;
  lesson_extracted_at: string | null;
  lesson_id: string | null;
  resolved_trace_ids: string[];
}

interface ExtractedLesson {
  rule_text: string;
  confidence: number;
  applies_to?: { capability_id?: string; tool_name?: string };
}

/**
 * Phase A — promote resolved issues to "confirmed resolved" once the cooldown
 * window has elapsed without re-open. Called at the end of every sweep.
 */
export async function confirmStableResolutions(): Promise<number> {
  const result = await query(
    `UPDATE audit_governance.engine_issues
        SET resolution_confirmed_at = now()
      WHERE status = 'resolved'
        AND resolved_at IS NOT NULL
        AND resolution_confirmed_at IS NULL
        AND resolved_at < (now() - ($1 || ' seconds')::interval)
      RETURNING id`,
    [String(LESSON_CONFIRM_WINDOW_SEC)],
  );
  return result.length;
}

/**
 * Phase B — for each confirmed-resolved issue that hasn't yet produced a
 * lesson, attempt extraction. Called at the end of every sweep.
 *
 * Returns the number of lessons successfully extracted + posted.
 */
export async function extractPendingLessons(maxPerSweep = 5): Promise<number> {
  const rows = await query<IssueRow>(
    `SELECT id, title, description, capability_id, error_pattern,
            sample_trace_ids, root_cause, resolved_at, last_seen_at,
            resolution_confirmed_at, lesson_extracted_at, lesson_id,
            resolved_trace_ids
       FROM audit_governance.engine_issues
      WHERE resolution_confirmed_at IS NOT NULL
        AND lesson_extracted_at IS NULL
        AND lesson_id IS NULL
        AND capability_id IS NOT NULL
      ORDER BY resolution_confirmed_at ASC
      LIMIT $1`,
    [maxPerSweep],
  );
  let extracted = 0;
  for (const row of rows) {
    try {
      const lesson = await extractLessonForIssue(row);
      if (lesson) {
        const lessonId = await postLessonToComposer(row, lesson);
        await query(
          `UPDATE audit_governance.engine_issues
              SET lesson_extracted_at = now(), lesson_id = $1
            WHERE id = $2`,
          [lessonId, row.id],
        );
        extracted += 1;
      } else {
        // Even on extraction skip, mark extracted_at so we don't retry forever.
        await query(
          `UPDATE audit_governance.engine_issues
              SET lesson_extracted_at = now()
            WHERE id = $1`,
          [row.id],
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[engine] lesson extraction failed for issue ${row.id}: ${(err as Error).message}`);
    }
  }
  return extracted;
}

async function extractLessonForIssue(issue: IssueRow): Promise<ExtractedLesson | null> {
  if (!issue.capability_id) return null;
  // Look for a successful retry trace on the same capability after the issue's
  // last failure. We don't need many — one good example is enough context.
  const retryTrace = await queryOne<Record<string, unknown>>(
    `SELECT trace_id, payload, created_at
       FROM audit_governance.audit_events
      WHERE capability_id = $1
        AND kind = 'tool.invocation.completed'
        AND (payload->>'success')::boolean = true
        AND created_at > $2
        AND created_at < (now() + ($3 || ' hours')::interval)
      ORDER BY created_at ASC
      LIMIT 1`,
    [issue.capability_id, issue.last_seen_at, String(RETRY_LOOKBACK_HOURS)],
  );

  // Compose the extraction prompt.
  const failureSummary = JSON.stringify({
    title: issue.title,
    description: issue.description,
    error_pattern: issue.error_pattern,
    root_cause: issue.root_cause,
    sample_trace_count: issue.sample_trace_ids?.length ?? 0,
  }, null, 2);
  const retrySummary = retryTrace
    ? JSON.stringify({ trace_id: retryTrace.trace_id, payload: retryTrace.payload }, null, 2).slice(0, 4000)
    : "(no successful retry trace found in window — extract rule from failure pattern alone)";

  const userPrompt = [
    `Failure cluster (resolved):`,
    failureSummary,
    ``,
    `Successful retry trace:`,
    retrySummary,
  ].join("\n");

  const systemPrompt = await getLessonSystemPrompt();
  const llmResponse = await callLlmGateway(systemPrompt, userPrompt);
  // Parse JSON out of the LLM response (same defensive pattern as diagnose.ts).
  const match = llmResponse.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as ExtractedLesson;
    if (typeof parsed.rule_text !== "string" || parsed.rule_text.trim().length < 10) return null;
    return {
      rule_text: parsed.rule_text.trim(),
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.6,
      applies_to: parsed.applies_to,
    };
  } catch {
    return null;
  }
}

async function callLlmGateway(systemPrompt: string, userPrompt: string): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (LLM_GATEWAY_BEARER) headers.authorization = `Bearer ${LLM_GATEWAY_BEARER}`;
  const res = await fetch(`${LLM_GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...(ENGINE_MODEL_ALIAS ? { model_alias: ENGINE_MODEL_ALIAS } : {}),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      temperature: 0,
      max_output_tokens: 400,
      trace_id: `engine-lesson-${Date.now()}`,
    }),
    signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`llm-gateway lesson-extract → ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json() as { content?: string };
  return data.content ?? "";
}

async function postLessonToComposer(issue: IssueRow, lesson: ExtractedLesson): Promise<string> {
  const url = `${PROMPT_COMPOSER_URL}/api/v1/lessons`;
  const body = {
    capabilityId: lesson.applies_to?.capability_id ?? issue.capability_id ?? "",
    toolName: lesson.applies_to?.tool_name,
    ruleText: lesson.rule_text,
    sourceIssueId: issue.id,
    sourceTraceIds: [...(issue.sample_trace_ids ?? []), ...(issue.resolved_trace_ids ?? [])],
    confidence: lesson.confidence,
    extractedBy: "audit-gov:engine:sweep",
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`prompt-composer /lessons → ${res.status}: ${text.slice(0, 300)}`);
  }
  const payload = await res.json() as { success: boolean; data: { id: string } };
  if (!payload.success) throw new Error("prompt-composer /lessons returned success=false");
  return payload.data.id;
}
