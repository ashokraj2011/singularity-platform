/**
 * M63 Slice A — Splunk-like search over audit_events.
 *
 *   POST /api/v1/audit/search
 *   Body: {
 *     q?:           string                  // free-text (Postgres FTS over kind+subject+payload)
 *     kinds?:       string[]                // exact-match any-of
 *     severities?:  ("info"|"warn"|"error"|"audit")[]
 *     riskLevels?:  ("low"|"medium"|"high"|"critical")[]
 *     sources?:     string[]                // workgraph-api, mcp-server, …
 *     capabilityId?: string
 *     actorId?:     string
 *     traceId?:     string
 *     since?:       ISO8601                 // created_at >= since
 *     until?:       ISO8601                 // created_at <= until
 *     limit?:       number                  // 1-500, default 100
 *     cursor?:      string                  // opaque pagination cursor from prior page
 *   }
 *   Returns: { items: AuditEventRow[], nextCursor: string | null, total?: number }
 *
 * Why a new endpoint vs extending /audit/timeline:
 *   - /audit/timeline requires one of trace_id / capability_id / actor_id
 *     (it's a per-entity drill-down). /audit/search is the operator's
 *     general-purpose "what's happening" query.
 *   - Cursor pagination, multi-value filters, and FTS need their own
 *     contract — bolting them onto the existing GET would have made
 *     the URL unwieldy and the parsing fragile.
 *
 * The cursor is `${created_at_iso}|${id}` base64-encoded. Stable across
 * inserts because audit_events.id is monotonic-ish (uuid v4) AND
 * created_at is unique-enough at the millisecond level for realistic
 * write rates. We sort by (created_at DESC, id DESC) for determinism.
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import { query } from "./db";

export const searchRouter = Router();

const SearchRequestSchema = z.object({
  q: z.string().max(500).optional(),
  kinds: z.array(z.string().max(120)).max(40).optional(),
  severities: z.array(z.enum(["info", "warn", "error", "audit"])).optional(),
  riskLevels: z.array(z.enum(["low", "medium", "high", "critical"])).optional(),
  sources: z.array(z.string().max(80)).max(20).optional(),
  capabilityId: z.string().max(200).optional(),
  actorId: z.string().max(200).optional(),
  traceId: z.string().max(200).optional(),
  // M69 — prefix match support for the Loop Theater. Sessions span
  // multiple stage trace_ids (blueprint-<sessionId>-design,
  // blueprint-<sessionId>-develop, etc.); a single prefix
  // `blueprint-<sessionId>` lets the theater pull the whole session.
  // Pattern is escaped at query time so SQL wildcards in the input
  // don't leak through.
  traceIdPrefix: z.string().max(200).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().max(200).optional(),
});

type Cursor = { createdAt: string; id: string };

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const sep = decoded.indexOf("|");
    if (sep < 0) return null;
    const createdAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!createdAt || !id) return null;
    // Sanity: the createdAt must parse as a valid ISO timestamp so a
    // malformed cursor doesn't crash the SQL with an invalid timestamp.
    if (Number.isNaN(Date.parse(createdAt))) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64");
}

searchRouter.post("/audit/search", async (req: Request, res: Response) => {
  const input = SearchRequestSchema.parse(req.body ?? {});
  const cursor = decodeCursor(input.cursor);

  // Build the WHERE clause dynamically. Postgres parameter index walks
  // alongside the conditions array — easier to maintain than a static
  // template string with 12+ optional clauses.
  const where: string[] = [];
  const params: unknown[] = [];

  const push = (sql: string, ...values: unknown[]) => {
    where.push(sql);
    params.push(...values);
  };

  if (input.q) {
    // websearch_to_tsquery handles operator-friendly syntax: quoted
    // phrases, OR, -negation. Better than plain to_tsquery for a
    // human-typed search box.
    params.push(input.q);
    where.push(`search_vector @@ websearch_to_tsquery('english', $${params.length})`);
  }
  if (input.kinds && input.kinds.length > 0) {
    params.push(input.kinds);
    where.push(`kind = ANY($${params.length}::text[])`);
  }
  if (input.severities && input.severities.length > 0) {
    params.push(input.severities);
    where.push(`severity = ANY($${params.length}::text[])`);
  }
  if (input.riskLevels && input.riskLevels.length > 0) {
    params.push(input.riskLevels);
    where.push(`risk_level = ANY($${params.length}::text[])`);
  }
  if (input.sources && input.sources.length > 0) {
    params.push(input.sources);
    where.push(`source_service = ANY($${params.length}::text[])`);
  }
  if (input.capabilityId) {
    params.push(input.capabilityId);
    where.push(`capability_id = $${params.length}`);
  }
  if (input.actorId) {
    params.push(input.actorId);
    where.push(`actor_id = $${params.length}`);
  }
  if (input.traceId) {
    params.push(input.traceId);
    where.push(`trace_id = $${params.length}`);
  }
  if (input.traceIdPrefix) {
    // M69 — Escape SQL LIKE wildcards (% and _) so a user-supplied
    // prefix doesn't unintentionally match unrelated traces. Backslash
    // serves as the ESCAPE char; the explicit ESCAPE clause makes the
    // intent obvious and survives strict_mode toggles.
    const escaped = input.traceIdPrefix.replace(/[\\%_]/g, '\\$&');
    params.push(`${escaped}%`);
    where.push(`trace_id LIKE $${params.length} ESCAPE '\\'`);
  }
  if (input.since) {
    params.push(input.since);
    where.push(`created_at >= $${params.length}::timestamptz`);
  }
  if (input.until) {
    params.push(input.until);
    where.push(`created_at <= $${params.length}::timestamptz`);
  }
  // Cursor: pagination by (created_at DESC, id DESC). The strict tuple
  // comparison `(created_at, id) < (cursor.createdAt, cursor.id)` is
  // index-friendly and avoids the off-by-one bugs of OFFSET pagination
  // on actively-written tables.
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    where.push(
      `(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join("\n   AND ")}` : "";

  // Fetch limit+1 to detect "is there a next page?" without a second
  // count(*) round-trip.
  params.push(input.limit + 1);
  const limitParam = `$${params.length}`;

  const sql = `
    SELECT id, trace_id, source_service, kind, subject_type, subject_id,
           actor_id, capability_id, tenant_id, severity, risk_level,
           payload, created_at
      FROM audit_governance.audit_events
      ${whereSql}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limitParam}
  `;

  const rows = await query<{
    id: string;
    trace_id: string | null;
    source_service: string;
    kind: string;
    subject_type: string | null;
    subject_id: string | null;
    actor_id: string | null;
    capability_id: string | null;
    tenant_id: string | null;
    severity: string;
    risk_level: string | null;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(sql, params);

  const hasMore = rows.length > input.limit;
  const items = hasMore ? rows.slice(0, input.limit) : rows;
  const lastRow = items[items.length - 1];
  const nextCursor = hasMore && lastRow
    ? encodeCursor(
        lastRow.created_at instanceof Date
          ? lastRow.created_at.toISOString()
          : String(lastRow.created_at),
        lastRow.id,
      )
    : null;

  res.json({
    items,
    nextCursor,
    pageSize: items.length,
    hasMore,
  });
});

// ── Facet endpoints ─────────────────────────────────────────────────────────
// The UI needs to populate the filter dropdowns with available kinds /
// sources / severities. Pulling DISTINCT live keeps the dropdowns
// current without a separate config table.

searchRouter.get("/audit/search/facets", async (_req: Request, res: Response) => {
  const [kinds, sources, severityCounts, riskCounts] = await Promise.all([
    query<{ kind: string; count: number }>(
      `SELECT kind, COUNT(*)::int AS count
         FROM audit_governance.audit_events
        WHERE created_at > now() - interval '30 days'
        GROUP BY kind
        ORDER BY count DESC
        LIMIT 60`,
    ),
    query<{ source_service: string; count: number }>(
      `SELECT source_service, COUNT(*)::int AS count
         FROM audit_governance.audit_events
        WHERE created_at > now() - interval '30 days'
        GROUP BY source_service
        ORDER BY count DESC
        LIMIT 30`,
    ),
    query<{ severity: string; count: number }>(
      `SELECT severity, COUNT(*)::int AS count
         FROM audit_governance.audit_events
        WHERE created_at > now() - interval '30 days'
        GROUP BY severity
        ORDER BY count DESC`,
    ),
    query<{ risk_level: string | null; count: number }>(
      `SELECT risk_level, COUNT(*)::int AS count
         FROM audit_governance.audit_events
        WHERE created_at > now() - interval '30 days'
        GROUP BY risk_level
        ORDER BY count DESC`,
    ),
  ]);
  res.json({
    kinds,
    sources,
    severities: severityCounts,
    riskLevels: riskCounts.filter((r) => r.risk_level !== null),
  });
});
