/**
 * Datadog/Splunk-style operational logs.
 *
 * These endpoints complement audit_events:
 *   - audit_events stay the canonical governance/event ledger.
 *   - observability_logs capture high-cardinality operational detail,
 *     searchable by trace/work item/service and backed by raw NDJSON storage.
 */
import { randomUUID } from "node:crypto";
import { Router, Request, Response } from "express";
import { z } from "zod";
import { query } from "./db";
import { requireServiceAuth } from "./routes-events";
import { getLogStorage, StoredLogInput } from "./log-storage";

export const logsRouter = Router();

// P0 — operator log lake (logs ingest + /logs/search + /traces/*). Service-token only for the
// whole router; the per-route guards on the ingest endpoints below are now redundant but kept.
// Browser consumers reach logs via the platform-web proxy (which injects the token).
logsRouter.use(requireServiceAuth);

const LogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal", "audit"]);

const RawLogSchema = z.object({
  timestamp: z.string().datetime().optional(),
  ts: z.string().datetime().optional(),
  time: z.string().datetime().optional(),
  level: LogLevelSchema.default("info"),
  service: z.string().trim().min(1).max(120),
  environment: z.string().trim().max(80).optional(),
  env: z.string().trim().max(80).optional(),
  host: z.string().trim().max(200).optional(),
  trace_id: z.string().trim().max(200).optional(),
  traceId: z.string().trim().max(200).optional(),
  span_id: z.string().trim().max(200).optional(),
  spanId: z.string().trim().max(200).optional(),
  workflow_instance_id: z.string().trim().max(200).optional(),
  workflowInstanceId: z.string().trim().max(200).optional(),
  workflow_node_id: z.string().trim().max(200).optional(),
  workflowNodeId: z.string().trim().max(200).optional(),
  work_item_id: z.string().trim().max(200).optional(),
  workItemId: z.string().trim().max(200).optional(),
  work_item_code: z.string().trim().max(200).optional(),
  workItemCode: z.string().trim().max(200).optional(),
  capability_id: z.string().trim().max(200).optional(),
  capabilityId: z.string().trim().max(200).optional(),
  tenant_id: z.string().trim().max(200).optional(),
  tenantId: z.string().trim().max(200).optional(),
  stage_key: z.string().trim().max(120).optional(),
  stageKey: z.string().trim().max(120).optional(),
  agent_role: z.string().trim().max(120).optional(),
  agentRole: z.string().trim().max(120).optional(),
  run_id: z.string().trim().max(200).optional(),
  runId: z.string().trim().max(200).optional(),
  tool_name: z.string().trim().max(160).optional(),
  toolName: z.string().trim().max(160).optional(),
  model: z.string().trim().max(200).optional(),
  event_type: z.string().trim().max(160).optional(),
  eventType: z.string().trim().max(160).optional(),
  kind: z.string().trim().max(160).optional(),
  message: z.string().max(8_000).optional(),
  msg: z.string().max(8_000).optional(),
  payload: z.record(z.unknown()).optional(),
  attributes: z.record(z.unknown()).optional(),
}).passthrough();

const IngestBodySchema = z.union([
  z.object({ logs: z.array(RawLogSchema).min(1) }),
  z.object({ records: z.array(RawLogSchema).min(1) }),
  RawLogSchema,
]);

const SearchLogsSchema = z.object({
  q: z.string().max(500).optional(),
  levels: z.array(LogLevelSchema).max(10).optional(),
  services: z.array(z.string().max(120)).max(50).optional(),
  eventTypes: z.array(z.string().max(160)).max(50).optional(),
  traceId: z.string().max(200).optional(),
  traceIdPrefix: z.string().max(200).optional(),
  workflowInstanceId: z.string().max(200).optional(),
  workflowNodeId: z.string().max(200).optional(),
  workItemId: z.string().max(200).optional(),
  capabilityId: z.string().max(200).optional(),
  tenantId: z.string().max(200).optional(),
  stageKey: z.string().max(120).optional(),
  agentRole: z.string().max(120).optional(),
  toolName: z.string().max(160).optional(),
  model: z.string().max(200).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(1_000).default(100),
  cursor: z.string().max(240).optional(),
});

type Cursor = { ts: string; id: string };

type NormalizedLog = StoredLogInput & {
  id: string;
  environment: string | null;
  host: string | null;
  trace_id: string | null;
  span_id: string | null;
  workflow_instance_id: string | null;
  workflow_node_id: string | null;
  work_item_id: string | null;
  work_item_code: string | null;
  capability_id: string | null;
  tenant_id: string | null;
  stage_key: string | null;
  agent_role: string | null;
  run_id: string | null;
  tool_name: string | null;
  model: string | null;
  event_type: string | null;
  payload: Record<string, unknown>;
};

const KNOWN_KEYS = new Set([
  "timestamp", "ts", "time", "level", "service", "environment", "env", "host",
  "trace_id", "traceId", "span_id", "spanId",
  "workflow_instance_id", "workflowInstanceId", "workflow_node_id", "workflowNodeId",
  "work_item_id", "workItemId", "work_item_code", "workItemCode",
  "capability_id", "capabilityId", "tenant_id", "tenantId",
  "stage_key", "stageKey", "agent_role", "agentRole", "run_id", "runId",
  "tool_name", "toolName", "model", "event_type", "eventType", "kind",
  "message", "msg", "payload", "attributes",
]);

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const sep = decoded.indexOf("|");
    if (sep < 0) return null;
    const ts = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!ts || !id || Number.isNaN(Date.parse(ts))) return null;
    return { ts, id };
  } catch {
    return null;
  }
}

function encodeCursor(ts: string, id: string): string {
  return Buffer.from(`${ts}|${id}`, "utf8").toString("base64");
}

function firstString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function compactPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const payload = typeof raw.payload === "object" && raw.payload !== null && !Array.isArray(raw.payload)
    ? raw.payload as Record<string, unknown>
    : {};
  const attributes = typeof raw.attributes === "object" && raw.attributes !== null && !Array.isArray(raw.attributes)
    ? raw.attributes as Record<string, unknown>
    : {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_KEYS.has(key) && value !== undefined) extra[key] = value;
  }
  return { ...extra, ...attributes, ...payload };
}

function normalizeLog(raw: unknown): NormalizedLog {
  const parsed = RawLogSchema.parse(raw) as Record<string, unknown>;
  const eventType = firstString(parsed.event_type, parsed.eventType, parsed.kind);
  const message = firstString(parsed.message, parsed.msg) ?? eventType ?? "";
  return {
    id: randomUUID(),
    ts: firstString(parsed.ts, parsed.timestamp, parsed.time) ?? new Date().toISOString(),
    level: firstString(parsed.level) ?? "info",
    service: firstString(parsed.service) ?? "unknown",
    environment: firstString(parsed.environment, parsed.env),
    host: firstString(parsed.host),
    trace_id: firstString(parsed.trace_id, parsed.traceId),
    span_id: firstString(parsed.span_id, parsed.spanId),
    workflow_instance_id: firstString(parsed.workflow_instance_id, parsed.workflowInstanceId),
    workflow_node_id: firstString(parsed.workflow_node_id, parsed.workflowNodeId),
    work_item_id: firstString(parsed.work_item_id, parsed.workItemId),
    work_item_code: firstString(parsed.work_item_code, parsed.workItemCode),
    capability_id: firstString(parsed.capability_id, parsed.capabilityId),
    tenant_id: firstString(parsed.tenant_id, parsed.tenantId),
    stage_key: firstString(parsed.stage_key, parsed.stageKey),
    agent_role: firstString(parsed.agent_role, parsed.agentRole),
    run_id: firstString(parsed.run_id, parsed.runId),
    tool_name: firstString(parsed.tool_name, parsed.toolName),
    model: firstString(parsed.model),
    event_type: eventType,
    message,
    payload: compactPayload(parsed),
  };
}

function logsFromBody(body: unknown): NormalizedLog[] {
  const parsed = IngestBodySchema.parse(body ?? {});
  const maybeBatch = parsed as { logs?: unknown; records?: unknown };
  if (Array.isArray(maybeBatch.logs)) return maybeBatch.logs.map(normalizeLog);
  if (Array.isArray(maybeBatch.records)) return maybeBatch.records.map(normalizeLog);
  return [normalizeLog(parsed)];
}

async function ingestLogs(req: Request, res: Response): Promise<void> {
  const maxBatch = Number(process.env.LOG_INGEST_MAX_BATCH ?? 500);
  const logs = logsFromBody(req.body);
  if (logs.length > maxBatch) {
    res.status(400).json({ error: "batch_too_large", max_batch: maxBatch });
    return;
  }

  const storage = getLogStorage();
  const pointers = await storage.writeBatch(logs);
  const ids: string[] = [];

  for (let i = 0; i < logs.length; i += 1) {
    const log = logs[i];
    const pointer = pointers[i];
    await query(
      `INSERT INTO audit_governance.observability_logs
         (id, ts, level, service, environment, host, trace_id, span_id,
          workflow_instance_id, workflow_node_id, work_item_id, work_item_code,
          capability_id, tenant_id, stage_key, agent_role, run_id, tool_name,
          model, event_type, message, payload, raw_storage_uri, raw_storage_offset,
          raw_storage_bytes)
       VALUES
         ($1,$2::timestamptz,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
          $17,$18,$19,$20,$21,$22::jsonb,$23,$24,$25)`,
      [
        log.id,
        log.ts,
        log.level,
        log.service,
        log.environment,
        log.host,
        log.trace_id,
        log.span_id,
        log.workflow_instance_id,
        log.workflow_node_id,
        log.work_item_id,
        log.work_item_code,
        log.capability_id,
        log.tenant_id,
        log.stage_key,
        log.agent_role,
        log.run_id,
        log.tool_name,
        log.model,
        log.event_type,
        log.message,
        JSON.stringify(log.payload),
        pointer.uri,
        pointer.offset,
        pointer.bytes,
      ],
    );
    ids.push(log.id);
  }

  res.status(201).json({
    ingested: ids.length,
    ids,
    storage: storage.health(),
  });
}

logsRouter.post("/logs", requireServiceAuth, ingestLogs);
logsRouter.post("/logs/batch", requireServiceAuth, ingestLogs);

logsRouter.post("/logs/search", async (req: Request, res: Response) => {
  const input = SearchLogsSchema.parse(req.body ?? {});
  const cursor = decodeCursor(input.cursor);
  const where: string[] = [];
  const params: unknown[] = [];

  if (input.q) {
    params.push(input.q);
    where.push(`search_vector @@ websearch_to_tsquery('english', $${params.length})`);
  }
  if (input.levels?.length) {
    params.push(input.levels);
    where.push(`level = ANY($${params.length}::text[])`);
  }
  if (input.services?.length) {
    params.push(input.services);
    where.push(`service = ANY($${params.length}::text[])`);
  }
  if (input.eventTypes?.length) {
    params.push(input.eventTypes);
    where.push(`event_type = ANY($${params.length}::text[])`);
  }
  if (input.traceId) {
    params.push(input.traceId);
    where.push(`trace_id = $${params.length}`);
  }
  if (input.traceIdPrefix) {
    const escaped = input.traceIdPrefix.replace(/[\\%_]/g, "\\$&");
    params.push(`${escaped}%`);
    where.push(`trace_id LIKE $${params.length} ESCAPE '\\'`);
  }
  const equals: Array<[unknown, string]> = [
    [input.workflowInstanceId, "workflow_instance_id"],
    [input.workflowNodeId, "workflow_node_id"],
    [input.workItemId, "work_item_id"],
    [input.capabilityId, "capability_id"],
    [input.tenantId, "tenant_id"],
    [input.stageKey, "stage_key"],
    [input.agentRole, "agent_role"],
    [input.toolName, "tool_name"],
    [input.model, "model"],
  ];
  for (const [value, column] of equals) {
    if (typeof value === "string" && value.length > 0) {
      params.push(value);
      where.push(`${column} = $${params.length}`);
    }
  }
  if (input.since) {
    params.push(input.since);
    where.push(`ts >= $${params.length}::timestamptz`);
  }
  if (input.until) {
    params.push(input.until);
    where.push(`ts <= $${params.length}::timestamptz`);
  }
  if (cursor) {
    params.push(cursor.ts, cursor.id);
    where.push(`(ts, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join("\n   AND ")}` : "";
  params.push(input.limit + 1);
  const rows = await query<{
    id: string;
    ts: Date;
    level: string;
    service: string;
    environment: string | null;
    host: string | null;
    trace_id: string | null;
    span_id: string | null;
    workflow_instance_id: string | null;
    workflow_node_id: string | null;
    work_item_id: string | null;
    work_item_code: string | null;
    capability_id: string | null;
    tenant_id: string | null;
    stage_key: string | null;
    agent_role: string | null;
    run_id: string | null;
    tool_name: string | null;
    model: string | null;
    event_type: string | null;
    message: string;
    payload: Record<string, unknown>;
    raw_storage_uri: string | null;
    raw_storage_offset: number | null;
    raw_storage_bytes: number | null;
    created_at: Date;
  }>(
    `SELECT id, ts, level, service, environment, host, trace_id, span_id,
            workflow_instance_id, workflow_node_id, work_item_id, work_item_code,
            capability_id, tenant_id, stage_key, agent_role, run_id, tool_name,
            model, event_type, message, payload, raw_storage_uri,
            raw_storage_offset, raw_storage_bytes, created_at
       FROM audit_governance.observability_logs
       ${whereSql}
      ORDER BY ts DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > input.limit;
  const items = hasMore ? rows.slice(0, input.limit) : rows;
  const lastRow = items[items.length - 1];
  res.json({
    items,
    pageSize: items.length,
    hasMore,
    nextCursor: hasMore && lastRow
      ? encodeCursor(lastRow.ts instanceof Date ? lastRow.ts.toISOString() : String(lastRow.ts), lastRow.id)
      : null,
  });
});

logsRouter.get("/logs/facets", async (_req: Request, res: Response) => {
  const [services, levels, eventTypes, stages, models] = await Promise.all([
    query<{ service: string; count: number }>(
      `SELECT service, COUNT(*)::int AS count
         FROM audit_governance.observability_logs
        WHERE ts > now() - interval '30 days'
        GROUP BY service
        ORDER BY count DESC
        LIMIT 80`,
    ),
    query<{ level: string; count: number }>(
      `SELECT level, COUNT(*)::int AS count
         FROM audit_governance.observability_logs
        WHERE ts > now() - interval '30 days'
        GROUP BY level
        ORDER BY count DESC`,
    ),
    query<{ event_type: string | null; count: number }>(
      `SELECT event_type, COUNT(*)::int AS count
         FROM audit_governance.observability_logs
        WHERE ts > now() - interval '30 days'
        GROUP BY event_type
        ORDER BY count DESC
        LIMIT 80`,
    ),
    query<{ stage_key: string | null; count: number }>(
      `SELECT stage_key, COUNT(*)::int AS count
         FROM audit_governance.observability_logs
        WHERE ts > now() - interval '30 days'
        GROUP BY stage_key
        ORDER BY count DESC
        LIMIT 40`,
    ),
    query<{ model: string | null; count: number }>(
      `SELECT model, COUNT(*)::int AS count
         FROM audit_governance.observability_logs
        WHERE ts > now() - interval '30 days'
        GROUP BY model
        ORDER BY count DESC
        LIMIT 40`,
    ),
  ]);
  res.json({
    services,
    levels,
    eventTypes: eventTypes.filter((row) => row.event_type !== null),
    stages: stages.filter((row) => row.stage_key !== null),
    models: models.filter((row) => row.model !== null),
  });
});

logsRouter.get("/traces/:traceId/timeline", async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 500), 1), 2_000);
  const traceId = req.params.traceId;
  const rows = await query<{
    source: string;
    id: string;
    ts: Date;
    service: string;
    level: string;
    event_type: string;
    message: string;
    capability_id: string | null;
    tenant_id: string | null;
    payload: Record<string, unknown>;
  }>(
    `SELECT *
       FROM (
         SELECT 'audit_event'::text AS source,
                id,
                created_at AS ts,
                source_service AS service,
                severity AS level,
                kind AS event_type,
                kind AS message,
                capability_id,
                tenant_id,
                payload
           FROM audit_governance.audit_events
          WHERE trace_id = $1
         UNION ALL
         SELECT 'log'::text AS source,
                id,
                ts,
                service,
                level,
                COALESCE(event_type, 'log') AS event_type,
                message,
                capability_id,
                tenant_id,
                payload
           FROM audit_governance.observability_logs
          WHERE trace_id = $1
       ) timeline
      ORDER BY ts ASC
      LIMIT $2`,
    [traceId, limit],
  );
  res.json({ traceId, items: rows, count: rows.length });
});

logsRouter.get("/logs/health", async (_req: Request, res: Response) => {
  const storage = getLogStorage();
  const [row] = await query<{ count: number; newest_ts: Date | null }>(
    `SELECT COUNT(*)::int AS count, MAX(ts) AS newest_ts
       FROM audit_governance.observability_logs`,
  );
  res.json({
    ok: true,
    storage: storage.health(),
    ingested_count: row?.count ?? 0,
    newest_ts: row?.newest_ts ?? null,
  });
});
