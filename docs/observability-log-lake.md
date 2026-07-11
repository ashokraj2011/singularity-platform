# Singularity Observability Log Lake

Singularity now has a Datadog/Splunk-style operational log surface in
`audit-governance-service`. It complements the governance ledger:

- `audit_events` remains the canonical event/audit timeline.
- `observability_logs` stores high-cardinality service logs with trace,
  workflow, WorkItem, stage, tool, model, and payload fields.
- Raw log records are durably written as NDJSON before the database row is
  inserted. Local/dev uses filesystem storage; object storage can be enabled
  with S3-compatible settings.
- Platform Web `/operations/logs` searches the indexed lake and the current
  host's bounded local log tails together. Local tails remain useful for boot
  failures that happen before the log lake is reachable.
- `/audit/trace/<traceId>` merges audit events, durable observability logs,
  Workgraph receipts, Context Fabric receipts, MCP receipts, and local log
  tails into one evidence timeline.

## Bare-metal collection

`bin/bare-metal.sh up` starts `bin/log-forwarder.py` after audit-governance is
healthy. The forwarder:

- tails `logs/*.log`, `*.out`, and `*.err`;
- stores restart-safe inode/offset checkpoints under `.singularity/`;
- redacts bearer tokens, provider keys, passwords, and secret-shaped values;
- preserves `traceId`, workflow instance, WorkItem, capability, and node fields;
- sends bounded batches to `/api/v1/logs/batch`;
- excludes `audit-gov.log` and `log-forwarder.log` to prevent an ingest loop.

Configuration:

```bash
LOG_FORWARDER_ENABLED=1
LOG_FORWARDER_POLL_SEC=2
LOG_FORWARDER_MAX_BATCH=200
LOG_FORWARDER_BOOTSTRAP_BYTES=262144
LOG_FORWARDER_EXCLUDE=some-noisy-service.log
SINGULARITY_LOG_DIR=$PWD/logs
```

One-shot verification:

```bash
source .env.local
python3 bin/log-forwarder.py --once
curl -s http://localhost:8500/api/v1/logs/health \
  -H "authorization: Bearer $AUDIT_GOV_SERVICE_TOKEN" | jq
```

Set `LOG_FORWARDER_ENABLED=0` when another collector already owns the files.
For Docker/Kubernetes, prefer the deployment's stdout collector or OTLP agent;
do not mount the Docker socket into Platform Web.

## Endpoints

All ingest calls require the audit-governance service token:

```bash
curl -X POST http://localhost:8500/api/v1/logs \
  -H "authorization: Bearer $AUDIT_GOV_SERVICE_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "service": "context-api",
    "level": "error",
    "traceId": "trace-123",
    "workflowInstanceId": "wf-123",
    "workItemId": "wrk-123",
    "stageKey": "PLAN",
    "eventType": "context_fabric.execute.failed",
    "message": "Plan stage failed",
    "payload": { "reason": "missing agent runtime token" }
  }'
```

Batch ingest:

```bash
POST /api/v1/logs/batch
{ "logs": [ ... ] }
```

Search:

```bash
POST /api/v1/logs/search
{
  "q": "timeout OR failed",
  "services": ["context-api", "mcp-server"],
  "levels": ["error", "fatal"],
  "traceIdPrefix": "blueprint-",
  "since": "2026-05-24T00:00:00Z",
  "limit": 100
}
```

Facets:

```bash
GET /api/v1/logs/facets
```

Combined trace timeline:

```bash
GET /api/v1/traces/<traceId>/timeline
```

Platform aggregation:

```bash
GET /api/platform-logs?backend=all&q=timeout&level=error
GET /api/platform-logs?trace_id=<traceId>
GET /api/traces/<traceId>
```

`backend=central` searches only the durable lake. `backend=local` reads only
bounded local tails. `backend=all` is the Operations UI default.

Health/config:

```bash
GET /api/v1/logs/health
```

## Storage

Default local storage writes raw NDJSON to:

```text
/data/singularity-logs/YYYY/MM/DD/<service>/logs.ndjson
```

Configure filesystem storage:

```bash
LOG_STORAGE_BACKEND=filesystem
LOG_STORAGE_PATH=/data/singularity-logs
```

Configure S3-compatible storage:

```bash
LOG_STORAGE_BACKEND=s3
LOG_S3_ENDPOINT=http://wg-minio:9000
LOG_S3_BUCKET=singularity-logs
LOG_S3_REGION=us-east-1
LOG_S3_ACCESS_KEY=...
LOG_S3_SECRET_KEY=...
LOG_S3_PREFIX=singularity-logs
```

The S3 writer uses path-style `PUT` with AWS Signature V4 so it works with
MinIO and S3-compatible stores.

## Recommended Producer Shape

Every service should emit logs with these fields when available:

- `service`
- `level`
- `traceId`
- `workflowInstanceId`
- `workflowNodeId`
- `workItemId`
- `capabilityId`
- `stageKey`
- `agentRole`
- `runId`
- `toolName`
- `model`
- `eventType`
- `message`
- `payload`

That shape is what lets operators answer:

- What failed for this WorkItem?
- Which stage is stuck?
- Which model/tool is causing retries?
- What happened across Workgraph, Context Fabric, Agent Execution Runtime, and audit-governance in one trace?

## External Datadog or Splunk

The platform evidence key remains `x-singularity-trace-id`/`trace_id` even when
infrastructure spans use W3C `traceparent`. Forward structured stdout or OTLP
telemetry to Datadog/Splunk with the deployment collector and retain these
fields as indexed attributes. The Singularity log lake remains available for
governance evidence and can run beside an external observability backend.

## Hardening boundaries

- In strict tenant mode, workflow operations, inbound-event history, runner
  queues, event deliveries, subscriptions, and LLM routing are filtered by the
  request tenant. New event-log and event-bus rows persist their tenant key;
  legacy rows with no tenant key remain compatibility data and are not returned
  by strict tenant-scoped operations.
- Replay, outbound-delivery retry, runner requeue, event-subscription changes,
  and LLM routing changes require an administrator role. Read-only log search
  requires a verified user bearer at Platform Web and a service token at
  audit-governance.
- Log batches and nested payloads are bounded before durable storage. Export
  workers reject redirects, keep credentials in named environment variables,
  and retry through a durable queue. The bare-metal forwarder persists its
  checkpoint with owner-only permissions and consumes oversized physical lines
  without losing the next record boundary.
