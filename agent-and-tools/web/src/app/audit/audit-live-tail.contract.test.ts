import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "src/app/audit/page.tsx"), "utf8");
const tracePage = fs.readFileSync(path.join(process.cwd(), "src/app/audit/trace/[traceId]/page.tsx"), "utf8");

assert.match(
  source,
  /function isAuditEventRow\(value: unknown\): value is AuditEventRow[\s\S]*?typeof value\.id === "string"[\s\S]*?typeof value\.kind === "string"[\s\S]*?isRecord\(value\.payload\)[\s\S]*?typeof value\.created_at === "string"/,
  "audit live-tail should validate the row shape before adding streamed events to UI state",
);

assert.match(
  source,
  /function parseAuditEventFrame\(raw: string\): AuditEventRow \| null[\s\S]*?JSON\.parse\(raw\) as unknown[\s\S]*?return isAuditEventRow\(parsed\) \? parsed : null[\s\S]*?catch/,
  "audit live-tail should parse SSE frames safely and drop malformed frames",
);

assert.match(
  source,
  /const data = parseAuditEventFrame\(\(ev as MessageEvent\)\.data\);[\s\S]*?if \(!data\) return;[\s\S]*?setPaused\(currentPaused =>/,
  "audit live-tail should ignore invalid SSE frames before mutating rows or paused buffers",
);

assert.doesNotMatch(
  source,
  /const data = JSON\.parse\(\(ev as MessageEvent\)\.data\) as AuditEventRow/,
  "audit live-tail should not cast arbitrary parsed JSON into AuditEventRow",
);

assert.match(
  tracePage,
  /import \{ traceApi, type PlatformTraceTimelineRow \} from "@\/lib\/api";/,
  "trace cockpit should use the unified platform trace API instead of the audit-only timeline",
);

assert.match(
  tracePage,
  /data\?\.sources\.workgraphReceipts[\s\S]*data\?\.sources\.contextFabricReceipts[\s\S]*data\?\.sources\.mcpReceipts[\s\S]*data\?\.sources\.auditEvents/,
  "trace cockpit should surface source coverage across Workgraph, Context Fabric, MCP, and audit-governance",
);

assert.match(
  tracePage,
  /Platform trace id[\s\S]*OTel trace id/,
  "trace cockpit should label app-level trace ids separately from optional OTel trace ids",
);

console.log("audit live-tail contract tests passed");
