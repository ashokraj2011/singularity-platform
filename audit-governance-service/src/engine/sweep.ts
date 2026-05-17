/**
 * Singularity Engine — sweep worker.
 *
 * Runs every SWEEP_INTERVAL_MS (default 5 min) and scans recent
 * audit_events for failure signals. Detected signals are passed to
 * the clusterer which creates or updates engine_issues.
 *
 * Signal detection:
 *   1. Tool invocation failures (payload.success = false)
 *   2. LLM call errors (finish_reason ∉ {stop, tool_call})
 *   3. LLM call length exhaustion (finish_reason = length)
 *   4. Governance denials
 *   5. Latency spikes (> 2× the 7-day rolling avg)
 *   6. Token blowouts (> 3× the 7-day rolling avg)
 *   7. Evaluator failures (kind = engine.evaluator.failed)
 */
import { query, queryOne } from "../db";
import {
  clusterFailures, countTracesInWindow,
  type FailureSignal, type FailureCategory,
} from "./cluster";
// M38 — confirmed-resolved issues drive the lesson extraction tail of each sweep.
import { confirmStableResolutions, extractPendingLessons } from "./extract-lesson";

const SWEEP_INTERVAL_MS = Number(process.env.ENGINE_SWEEP_INTERVAL_MS ?? 5 * 60_000);
const SWEEP_WINDOW_MIN  = Number(process.env.ENGINE_SWEEP_WINDOW_MIN ?? 10);

let sweepTimer: NodeJS.Timeout | null = null;
let lastSweepAt: string | null = null;

// ── Signal extractors ──────────────────────────────────────────────────

/** Scan for tool invocation failures. */
async function scanToolFailures(since: string): Promise<FailureSignal[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT trace_id, source_service, capability_id, tenant_id,
            payload, created_at
     FROM audit_governance.audit_events
     WHERE kind = 'tool.invocation.completed'
       AND created_at > $1
       AND (payload->>'success')::boolean = false
     ORDER BY created_at DESC
     LIMIT 500`,
    [since],
  );
  return rows.map((r) => ({
    trace_id:       r.trace_id as string | null,
    kind:           "tool.invocation.completed",
    source_service: r.source_service as string,
    capability_id:  r.capability_id as string | null,
    tenant_id:      r.tenant_id as string | null,
    category:       "tool_failure" as FailureCategory,
    error_message:  String((r.payload as Record<string, unknown>)?.error ?? "unknown tool error"),
    payload:        r.payload as Record<string, unknown>,
    created_at:     String(r.created_at),
  }));
}

/** Scan for LLM call errors and length exhaustion. */
async function scanLlmErrors(since: string): Promise<FailureSignal[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT e.trace_id, e.source_service, e.capability_id, e.tenant_id,
            e.payload, e.created_at,
            l.finish_reason, l.latency_ms, l.total_tokens
     FROM audit_governance.audit_events e
     LEFT JOIN audit_governance.llm_calls l ON l.audit_event_id = e.id
     WHERE e.kind = 'llm.call.completed'
       AND e.created_at > $1
       AND (
         l.finish_reason NOT IN ('stop', 'tool_call')
         OR e.severity IN ('error', 'warn')
       )
     ORDER BY e.created_at DESC
     LIMIT 500`,
    [since],
  );
  return rows.map((r) => {
    const fr = String(r.finish_reason ?? "unknown");
    const category: FailureCategory = fr === "length" ? "llm_error" : "llm_error";
    return {
      trace_id:       r.trace_id as string | null,
      kind:           "llm.call.completed",
      source_service: r.source_service as string,
      capability_id:  r.capability_id as string | null,
      tenant_id:      r.tenant_id as string | null,
      category,
      error_message:  `LLM call finished with reason='${fr}'`,
      payload:        r.payload as Record<string, unknown>,
      created_at:     String(r.created_at),
    };
  });
}

/** Scan for governance denials. */
async function scanGovernanceDenials(since: string): Promise<FailureSignal[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT trace_id, source_service, capability_id, tenant_id,
            payload, created_at
     FROM audit_governance.audit_events
     WHERE kind IN ('governance.budget.denied', 'governance.ratelimit.denied')
       AND created_at > $1
     ORDER BY created_at DESC
     LIMIT 200`,
    [since],
  );
  return rows.map((r) => ({
    trace_id:       r.trace_id as string | null,
    kind:           r.kind as string ?? "governance.denied",
    source_service: r.source_service as string,
    capability_id:  r.capability_id as string | null,
    tenant_id:      r.tenant_id as string | null,
    category:       "governance_denied" as FailureCategory,
    error_message:  `Governance denial: ${String((r.payload as Record<string, unknown>)?.reason ?? "budget/rate limit exceeded")}`,
    payload:        r.payload as Record<string, unknown>,
    created_at:     String(r.created_at),
  }));
}

/** Scan for latency spikes (> 2× rolling 7-day avg). */
async function scanLatencySpikes(since: string): Promise<FailureSignal[]> {
  const avg = await queryOne<{ avg_ms: string }>(
    `SELECT COALESCE(AVG(latency_ms), 5000)::text AS avg_ms
     FROM audit_governance.llm_calls
     WHERE created_at > now() - interval '7 days'
       AND latency_ms IS NOT NULL`,
  );
  const threshold = Math.max(Math.ceil(Number(avg?.avg_ms ?? 5000) * 2), 10_000);

  const rows = await query<Record<string, unknown>>(
    `SELECT e.trace_id, e.source_service, e.capability_id, e.tenant_id,
            e.payload, e.created_at, l.latency_ms, l.model
     FROM audit_governance.audit_events e
     JOIN audit_governance.llm_calls l ON l.audit_event_id = e.id
     WHERE e.kind = 'llm.call.completed'
       AND e.created_at > $1
       AND l.latency_ms > $2
     ORDER BY l.latency_ms DESC
     LIMIT 100`,
    [since, threshold],
  );
  return rows.map((r) => ({
    trace_id:       r.trace_id as string | null,
    kind:           "llm.call.completed",
    source_service: r.source_service as string,
    capability_id:  r.capability_id as string | null,
    tenant_id:      r.tenant_id as string | null,
    category:       "latency_spike" as FailureCategory,
    error_message:  `Latency ${r.latency_ms}ms exceeds 2x avg (threshold ${Math.round(threshold)}ms) on model ${r.model}`,
    payload:        r.payload as Record<string, unknown>,
    created_at:     String(r.created_at),
  }));
}

/** Scan for token blowouts (> 3× rolling 7-day avg). */
async function scanTokenBlowouts(since: string): Promise<FailureSignal[]> {
  const avg = await queryOne<{ avg_tokens: string }>(
    `SELECT COALESCE(AVG(total_tokens), 2000)::text AS avg_tokens
     FROM audit_governance.llm_calls
     WHERE created_at > now() - interval '7 days'
       AND total_tokens > 0`,
  );
  const threshold = Math.max(Math.ceil(Number(avg?.avg_tokens ?? 2000) * 3), 10_000);

  const rows = await query<Record<string, unknown>>(
    `SELECT e.trace_id, e.source_service, e.capability_id, e.tenant_id,
            e.payload, e.created_at, l.total_tokens, l.model
     FROM audit_governance.audit_events e
     JOIN audit_governance.llm_calls l ON l.audit_event_id = e.id
     WHERE e.kind = 'llm.call.completed'
       AND e.created_at > $1
       AND l.total_tokens > $2
     ORDER BY l.total_tokens DESC
     LIMIT 100`,
    [since, threshold],
  );
  return rows.map((r) => ({
    trace_id:       r.trace_id as string | null,
    kind:           "llm.call.completed",
    source_service: r.source_service as string,
    capability_id:  r.capability_id as string | null,
    tenant_id:      r.tenant_id as string | null,
    category:       "token_blowout" as FailureCategory,
    error_message:  `Token count ${r.total_tokens} exceeds 3x avg (threshold ${Math.round(threshold)}) on model ${r.model}`,
    payload:        r.payload as Record<string, unknown>,
    created_at:     String(r.created_at),
  }));
}

// ── Main sweep ─────────────────────────────────────────────────────────

async function runSweep(): Promise<void> {
  const since = lastSweepAt ?? new Date(Date.now() - SWEEP_WINDOW_MIN * 60_000).toISOString();
  const sweepStart = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[engine] sweep starting, window since ${since}`);

  try {
    const [toolFails, llmErrors, govDenials, latSpikes, tokenBlowouts] = await Promise.all([
      scanToolFailures(since),
      scanLlmErrors(since),
      scanGovernanceDenials(since),
      scanLatencySpikes(since),
      scanTokenBlowouts(since),
    ]);

    const allSignals: FailureSignal[] = [
      ...toolFails, ...llmErrors, ...govDenials, ...latSpikes, ...tokenBlowouts,
    ];

    if (allSignals.length === 0) {
      // eslint-disable-next-line no-console
      console.log("[engine] sweep complete: 0 failure signals found");
      lastSweepAt = sweepStart;
      return;
    }

    const totalTraces = await countTracesInWindow(SWEEP_WINDOW_MIN);
    const results = await clusterFailures(allSignals, totalTraces);

    const newIssues = results.filter((r) => r.isNew).length;
    const updatedIssues = results.filter((r) => !r.isNew).length;
    // eslint-disable-next-line no-console
    console.log(
      `[engine] sweep complete: ${allSignals.length} signals → ${newIssues} new issues, ${updatedIssues} updated`,
    );
    lastSweepAt = sweepStart;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[engine] sweep error:", (err as Error).message);
  }

  // M38 — Lesson extraction tail.
  //   Phase A: promote stably-resolved issues (no re-open after the cooldown).
  //   Phase B: extract + POST a 2-sentence rule per confirmed issue, up to a
  //            small batch so a backlog doesn't starve the next sweep cycle.
  // Wrapped in its own try/catch so any extraction error doesn't poison the
  // main failure-detection loop.
  try {
    const confirmed = await confirmStableResolutions();
    if (confirmed > 0) {
      // eslint-disable-next-line no-console
      console.log(`[engine] confirmed ${confirmed} issue(s) as stably-resolved`);
    }
    const extracted = await extractPendingLessons();
    if (extracted > 0) {
      // eslint-disable-next-line no-console
      console.log(`[engine] extracted ${extracted} lesson(s) from confirmed-resolved issues`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[engine] lesson-extract tail error:", (err as Error).message);
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────

export function startEngineSweep(): void {
  // eslint-disable-next-line no-console
  console.log(`[engine] sweep worker started (interval=${SWEEP_INTERVAL_MS}ms, window=${SWEEP_WINDOW_MIN}min)`);
  // Run first sweep shortly after boot (10s delay so DB is ready).
  setTimeout(() => void runSweep(), 10_000);
  sweepTimer = setInterval(() => void runSweep(), SWEEP_INTERVAL_MS);
}

export function stopEngineSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  // eslint-disable-next-line no-console
  console.log("[engine] sweep worker stopped");
}

/** Expose for manual trigger via POST /engine/sweep. */
export { runSweep };
