/**
 * Singularity Engine — failure clustering.
 *
 * Groups similar audit_event failures into named engine_issues. Each issue
 * has a stable `cluster_fingerprint` (SHA-256 of the normalised error
 * pattern) so repeated failures merge into the same row.
 *
 * Severity auto-escalates based on trace_count and affected_pct:
 *   - ≥ 25% of traces → critical
 *   - ≥ 10% of traces → high
 *   - ≥ 5  trace_count → medium
 *   - otherwise → low
 */
import { createHash } from "node:crypto";
import { query, queryOne } from "../db";

// ── Types ──────────────────────────────────────────────────────────────────

export interface FailureSignal {
  trace_id:        string | null;
  kind:            string;           // audit_event.kind
  source_service:  string;
  capability_id:   string | null;
  tenant_id:       string | null;
  category:        FailureCategory;
  error_message:   string;           // representative error / pattern
  payload:         Record<string, unknown>;
  created_at:      string;
}

export type FailureCategory =
  | "tool_failure"
  | "llm_error"
  | "timeout"
  | "latency_spike"
  | "token_blowout"
  | "max_steps"
  | "eval_failure"
  | "governance_denied";

export interface ClusterResult {
  issueId:     string;
  isNew:       boolean;
  fingerprint: string;
  title:       string;
  traceCount:  number;
  severity:    string;
}

// ── Fingerprint computation ─────────────────────────────────────────────

/**
 * Normalise an error message for fingerprinting: strip UUIDs, numbers,
 * timestamps, and variable-length whitespace so structurally identical
 * errors produce the same hash.
 */
function normaliseError(msg: string): string {
  return msg
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, "<TS>")
    .replace(/\b\d+(\.\d+)?\b/g, "<N>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function computeFingerprint(signal: FailureSignal): string {
  const key = [
    signal.category,
    signal.source_service,
    signal.capability_id ?? "global",
    normaliseError(signal.error_message),
  ].join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

// ── Title generation ────────────────────────────────────────────────────

function generateTitle(signal: FailureSignal): string {
  const cap = signal.capability_id ? ` [${signal.capability_id}]` : "";
  switch (signal.category) {
    case "tool_failure":
      return `Tool invocation failure${cap}: ${signal.error_message.slice(0, 80)}`;
    case "llm_error":
      return `LLM call error${cap}: ${signal.error_message.slice(0, 80)}`;
    case "timeout":
      return `Request timeout${cap}: ${signal.error_message.slice(0, 80)}`;
    case "latency_spike":
      return `Latency spike detected${cap}`;
    case "token_blowout":
      return `Token usage anomaly${cap}`;
    case "max_steps":
      return `Agent loop exhausted max steps${cap}`;
    case "eval_failure":
      return `Evaluator failure${cap}: ${signal.error_message.slice(0, 80)}`;
    case "governance_denied":
      return `Governance denial${cap}: ${signal.error_message.slice(0, 80)}`;
    default:
      return `Unknown failure${cap}: ${signal.error_message.slice(0, 80)}`;
  }
}

// ── Severity computation ────────────────────────────────────────────────

function computeSeverity(traceCount: number, affectedPct: number | null): string {
  const pct = affectedPct ?? 0;
  if (pct >= 25 || traceCount >= 50) return "critical";
  if (pct >= 10 || traceCount >= 20) return "high";
  if (traceCount >= 5) return "medium";
  return "low";
}

// ── Cluster upsert ──────────────────────────────────────────────────────

const MAX_SAMPLE_TRACES = 20;

/**
 * Cluster a batch of failure signals into engine_issues. Returns results
 * for each created or updated issue.
 */
export async function clusterFailures(
  signals: FailureSignal[],
  totalTracesInWindow: number,
): Promise<ClusterResult[]> {
  if (signals.length === 0) return [];

  // Group signals by fingerprint.
  const groups = new Map<string, FailureSignal[]>();
  for (const sig of signals) {
    const fp = computeFingerprint(sig);
    const arr = groups.get(fp) ?? [];
    arr.push(sig);
    groups.set(fp, arr);
  }

  const results: ClusterResult[] = [];

  for (const [fingerprint, sigs] of groups) {
    const representative = sigs[0];
    const traceIds = [...new Set(sigs.map((s) => s.trace_id).filter(Boolean))] as string[];
    const affectedPct = totalTracesInWindow > 0
      ? Math.round((traceIds.length / totalTracesInWindow) * 10000) / 100
      : null;

    // Check if an issue already exists for this fingerprint.
    const existing = await queryOne<{
      id: string; trace_count: number; sample_trace_ids: string[];
      status: string;
    }>(
      `SELECT id, trace_count, sample_trace_ids, status
       FROM audit_governance.engine_issues
       WHERE cluster_fingerprint = $1`,
      [fingerprint],
    );

    if (existing) {
      // Don't update dismissed issues unless trace_count jumps significantly.
      if (existing.status === "dismissed" && sigs.length < 5) continue;

      // Merge sample trace_ids (cap at MAX_SAMPLE_TRACES).
      const merged = [...new Set([
        ...(existing.sample_trace_ids ?? []),
        ...traceIds,
      ])].slice(0, MAX_SAMPLE_TRACES);

      const newCount = existing.trace_count + sigs.length;
      const newSeverity = computeSeverity(newCount, affectedPct);

      // If issue was dismissed/resolved but failures recur, reopen.
      const reopenClause = (existing.status === "resolved" || existing.status === "dismissed")
        ? ", status = 'open', resolved_at = NULL, resolved_by = NULL"
        : "";

      await query(
        `UPDATE audit_governance.engine_issues
         SET trace_count     = $1,
             sample_trace_ids = $2,
             severity        = $3,
             affected_pct    = $4,
             last_seen_at    = now(),
             updated_at      = now()
             ${reopenClause}
         WHERE id = $5`,
        [newCount, merged, newSeverity, affectedPct, existing.id],
      );

      results.push({
        issueId: existing.id,
        isNew: false,
        fingerprint,
        title: "",
        traceCount: newCount,
        severity: newSeverity,
      });
    } else {
      // Create new issue.
      const title = generateTitle(representative);
      const severity = computeSeverity(sigs.length, affectedPct);
      const sampleIds = traceIds.slice(0, MAX_SAMPLE_TRACES);

      const row = await queryOne<{ id: string }>(
        `INSERT INTO audit_governance.engine_issues
           (title, description, severity, category, capability_id, tenant_id,
            trace_count, affected_pct, sample_trace_ids, cluster_fingerprint,
            error_pattern, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (cluster_fingerprint) DO UPDATE
         SET trace_count  = engine_issues.trace_count + $7,
             last_seen_at = now(),
             updated_at   = now()
         RETURNING id`,
        [
          title,
          `Automatically detected ${representative.category} pattern: ${normaliseError(representative.error_message)}`,
          severity,
          representative.category,
          representative.capability_id ?? null,
          representative.tenant_id ?? null,
          sigs.length,
          affectedPct,
          sampleIds,
          fingerprint,
          representative.error_message.slice(0, 1000),
          representative.created_at,
          sigs[sigs.length - 1].created_at,
        ],
      );

      if (row) {
        results.push({
          issueId: row.id,
          isNew: true,
          fingerprint,
          title,
          traceCount: sigs.length,
          severity,
        });
      }
    }
  }

  return results;
}

/**
 * Get total trace count in a time window (for affected_pct calculation).
 */
export async function countTracesInWindow(windowMinutes: number): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(DISTINCT trace_id)::text AS count
     FROM audit_governance.audit_events
     WHERE created_at > now() - ($1 || ' minutes')::interval
       AND trace_id IS NOT NULL`,
    [windowMinutes],
  );
  return Number(row?.count ?? 0);
}
