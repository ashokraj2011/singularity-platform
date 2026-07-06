import { NextRequest, NextResponse } from "next/server";
import { readJsonish } from "../../_json";
import { boundedSecondsEnv } from "@/lib/serverEnvBounds";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type JsonRecord = Record<string, unknown>;

type TraceTimelineRow = {
  id: string;
  ts: string;
  source: string;
  service: string;
  level: string;
  event_type: string;
  eventType: string;
  message: string;
  capability_id: string | null;
  tenant_id: string | null;
  payload: JsonRecord;
  correlation?: JsonRecord;
};

type SourceResponse = {
  ok: boolean;
  status: number;
  data: unknown;
  text: string;
  parseError?: string;
};

const FETCH_TIMEOUT_MS = boundedSecondsEnv("PLATFORM_TRACE_FETCH_TIMEOUT_SEC", 6, 1, 300) * 1000;
const MAX_TRACE_ID_LENGTH = 300;

function normalizeTraceId(value: string): string | null {
  let raw = value;
  try {
    raw = decodeURIComponent(value);
  } catch {
    raw = value;
  }
  const traceId = raw.trim();
  if (!traceId || traceId.length > MAX_TRACE_ID_LENGTH || traceId.includes("\0")) return null;
  return traceId;
}

function authHeaders(req: NextRequest): HeadersInit {
  const auth = req.headers.get("authorization");
  return auth ? { authorization: auth } : {};
}

async function getJson(origin: string, path: string, req: NextRequest): Promise<SourceResponse> {
  try {
    const res = await fetch(`${origin}${path}`, {
      cache: "no-store",
      headers: authHeaders(req),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await readJsonish(res);
    return {
      ok: res.ok,
      status: res.status,
      data: body.data,
      text: body.text,
      parseError: body.parseError,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      text: err instanceof Error ? err.message : "Request failed",
    };
  }
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectValue(value: unknown): JsonRecord {
  return record(value);
}

function timestampValue(...values: unknown[]): string {
  const value = firstString(...values);
  if (value) return value;
  return new Date(0).toISOString();
}

function levelForStatus(status: string | null): string {
  const normalized = (status ?? "").toLowerCase();
  if (["failed", "failure", "error", "denied", "rejected", "blocked"].includes(normalized)) return "error";
  if (["waiting", "waiting_approval", "warning", "warn", "paused"].includes(normalized)) return "warn";
  return "info";
}

function shortSourceFailure(source: string, response: SourceResponse): string {
  const detail = response.text || response.parseError || (response.status ? `HTTP ${response.status}` : "request failed");
  return `${source} unavailable: ${detail.slice(0, 220)}`;
}

function receiptTimelineRows(receipts: unknown[]): TraceTimelineRow[] {
  return receipts.map((item, index) => {
    const receipt = record(item);
    const correlation = objectValue(receipt.correlation);
    const payload = objectValue(receipt.payload);
    const kind = firstString(receipt.kind, payload.kind, "receipt") ?? "receipt";
    const service = firstString(receipt.source_service, receipt.sourceService, "receipt") ?? "receipt";
    const status = firstString(receipt.status);
    const ts = timestampValue(receipt.started_at, receipt.completed_at, receipt.created_at, payload.ts, payload.timestamp);
    const id = firstString(receipt.receipt_id, receipt.id, `${service}-${kind}-${index}`) ?? `${service}-${kind}-${index}`;
    return {
      id,
      ts,
      source: "receipt",
      service,
      level: levelForStatus(status),
      event_type: kind,
      eventType: kind,
      message: `${kind}${status ? ` - ${status}` : ""}`,
      capability_id: firstString(receipt.capability_id, payload.capability_id, payload.capabilityId),
      tenant_id: firstString(receipt.tenant_id, payload.tenant_id, payload.tenantId),
      payload,
      correlation,
    };
  });
}

function auditTimelineRows(items: unknown[]): TraceTimelineRow[] {
  return items.map((item, index) => {
    const row = record(item);
    const payload = objectValue(row.payload);
    const eventType = firstString(row.event_type, row.eventType, row.kind, "audit_event") ?? "audit_event";
    const service = firstString(row.service, row.source_service, row.sourceService, "audit-governance") ?? "audit-governance";
    const ts = timestampValue(row.ts, row.created_at, row.createdAt);
    const id = firstString(row.id, `${service}-${eventType}-${index}`) ?? `${service}-${eventType}-${index}`;
    return {
      id,
      ts,
      source: firstString(row.source, "audit_event") ?? "audit_event",
      service,
      level: firstString(row.level, row.severity, "info") ?? "info",
      event_type: eventType,
      eventType,
      message: firstString(row.message, eventType) ?? eventType,
      capability_id: firstString(row.capability_id, row.capabilityId),
      tenant_id: firstString(row.tenant_id, row.tenantId),
      payload,
      correlation: objectValue(row.correlation),
    };
  });
}

function collectCorrelation(traceId: string, rows: TraceTimelineRow[]): JsonRecord {
  const correlation: JsonRecord = { traceId };
  for (const row of rows) {
    for (const source of [row.correlation, row.payload].filter(Boolean)) {
      const data = record(source);
      for (const [target, keys] of Object.entries({
        cfCallId: ["cfCallId", "cf_call_id"],
        promptAssemblyId: ["promptAssemblyId", "prompt_assembly_id"],
        mcpInvocationId: ["mcpInvocationId", "mcp_invocation_id"],
        modelCallId: ["modelCallId", "model_call_id"],
        agentRunId: ["agentRunId", "agent_run_id"],
        workflowInstanceId: ["workflowInstanceId", "workflow_instance_id", "runId", "run_id"],
        workflowNodeId: ["workflowNodeId", "workflow_node_id", "nodeId", "node_id"],
        workItemId: ["workItemId", "work_item_id"],
        tenantId: ["tenantId", "tenant_id"],
      })) {
        if (correlation[target]) continue;
        const value = firstString(...keys.map((key) => data[key]));
        if (value) correlation[target] = value;
      }
      if (!correlation.otelTraceId) {
        const traceparent = firstString(data.traceparent, data.traceParent, record(data.headers).traceparent);
        const otelTraceId = traceparent?.match(/^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i)?.[1];
        if (otelTraceId) correlation.otelTraceId = otelTraceId;
      }
    }
  }
  return correlation;
}

function sourceCount(sources: JsonRecord, key: string): number {
  const value = sources[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function GET(req: NextRequest, context: { params: Promise<{ traceId: string }> }) {
  const params = await context.params;
  const traceId = normalizeTraceId(params.traceId);
  if (!traceId) {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "traceId is required" },
      { status: 400 },
    );
  }

  const encoded = encodeURIComponent(traceId);
  const [receiptsResponse, auditResponse] = await Promise.all([
    getJson(req.nextUrl.origin, `/api/workgraph/receipts?trace_id=${encoded}`, req),
    getJson(req.nextUrl.origin, `/api/audit-gov/traces/${encoded}/timeline?limit=1000`, req),
  ]);

  const warnings: string[] = [];
  const receiptBody = record(receiptsResponse.data);
  const auditBody = record(auditResponse.data);
  if (!receiptsResponse.ok) warnings.push(shortSourceFailure("Workgraph receipts", receiptsResponse));
  if (!auditResponse.ok) warnings.push(shortSourceFailure("Audit timeline", auditResponse));

  const receipts = receiptsResponse.ok ? arrayValue(receiptBody.receipts) : [];
  const auditItems = auditResponse.ok ? arrayValue(auditBody.items) : [];
  if (receiptsResponse.ok && receipts.length === 0) warnings.push("No Workgraph/Context Fabric/MCP receipts were found for this trace.");
  if (auditResponse.ok && auditItems.length === 0) warnings.push("No audit-governance events or observability logs were found for this trace.");

  const timeline = [
    ...receiptTimelineRows(receipts),
    ...auditTimelineRows(auditItems),
  ].sort((left, right) => left.ts.localeCompare(right.ts));
  const receiptSources = record(receiptBody.sources);
  const sources = {
    workgraphReceipts: sourceCount(receiptSources, "workgraph-api"),
    contextFabricReceipts: sourceCount(receiptSources, "context-api"),
    mcpReceipts: sourceCount(receiptSources, "mcp-server"),
    auditEvents: auditItems.length,
    total: timeline.length,
  };

  return NextResponse.json({
    traceId,
    generatedAt: new Date().toISOString(),
    sources,
    warnings,
    correlation: collectCorrelation(traceId, timeline),
    timeline,
  });
}
