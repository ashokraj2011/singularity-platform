# Singularity Observability Log Lake

Singularity now has a Datadog/Splunk-style operational log surface in
`audit-governance-service`. It complements the governance ledger:

- `audit_events` remains the canonical event/audit timeline.
- `observability_logs` stores high-cardinality service logs with trace,
  workflow, WorkItem, stage, tool, model, and payload fields.
- Raw log records are durably written as NDJSON before the database row is
  inserted. Local/dev uses filesystem storage; object storage can be enabled
  with S3-compatible settings.

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
