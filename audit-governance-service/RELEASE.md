# audit-governance-service — Release Notes

Canonical event store + governance authority for the platform. Every
service emits structured `audit_events` here. M21-onward, this is THE
operator surface for "what is happening across services."

## API surface

| Method | Path                                       | Notes                                                                |
|--------|--------------------------------------------|----------------------------------------------------------------------|
| GET    | `/health`                                  | Liveness.                                                            |
| GET    | `/healthz/strict`                          | 503 when DB schema is missing or `gen_random_uuid()` fails.          |
| POST   | `/api/v1/events`                           | Single event ingest. Single source of truth.                         |
| POST   | `/api/v1/events/batch`                     | Many at once (max 500).                                              |
| GET    | `/api/v1/audit/timeline`                   | Legacy per-entity drilldown by trace_id/capability_id/actor_id.      |
| GET    | `/api/v1/audit/events/:id`                 | Single event by id.                                                  |
| POST   | `/api/v1/audit/search` (M63)               | Splunk-like search: free-text + kind/severity/risk filters + cursor. |
| GET    | `/api/v1/audit/search/facets` (M63)        | Filter dropdown values (kinds / sources / severities / risks).       |
| GET    | `/api/v1/audit/stream` (M63)               | SSE live-tail with the same filters.                                 |
| POST   | `/api/v1/governance/approvals`             | Pending-approval creation.                                           |
| POST   | `/api/v1/governance/approvals/:id/decide`  | Approve / reject. Single-source-of-truth gate (M21.5).                |
| POST   | `/api/v1/governance/budgets`               | Per-tenant / per-capability token + cost caps.                       |
| GET    | `/api/v1/cost/rollup`                      | Cost grouped by time bucket. Powered by the cost-worker denormaliser. |
| GET    | `/api/v1/savings/{session,agent,best-mode,dashboard}` (M65) | Token-savings analytics, moved here from metrics-ledger. |
| GET    | `/api/v1/engine/issues`                    | Singularity Engine: clustered failure groups.                        |

## Env vars

| Var                                  | Default                                              | Notes                                                          |
|--------------------------------------|------------------------------------------------------|----------------------------------------------------------------|
| `AUDIT_GOV_SERVICE_TOKEN`            | (required in prod)                                   | Bearer auth on ingest. 32+ chars; KNOWN_BAD list enforced.     |
| `AUDIT_GOV_ALLOW_ANONYMOUS_DEV`      | unset                                                | When `1`, allow unauth ingest in dev. Off by default (M35.1).  |
| `AUDIT_GOV_ALLOWED_SOURCE_SERVICES`  | empty (no allowlist)                                 | When set, reject events whose `source_service` isn't in the comma-separated list. |
| `AUDIT_GOV_EVENT_RATE_WINDOW_MS`     | `60000`                                              | Per-actor rate-limit window.                                   |
| `AUDIT_GOV_EVENT_RATE_MAX`           | `2000`                                               | Events per window per (ip, source_service, tenant_id).          |
| `AUDIT_GOV_STREAM_MAX_SUBSCRIBERS`   | `50`                                                 | Concurrent SSE clients per instance.                           |
| `AUDIT_GOV_STREAM_KEEPALIVE_MS`      | `15000`                                              | Heartbeat interval on SSE streams.                             |

## Dependencies

**Upstream consumers** (everything writes here):
- mcp-server, workgraph-api, prompt-composer, agent-runtime, context-fabric

**Downstream**:
- PostgreSQL 16 (with pgvector + pgcrypto extensions).

## Milestones

- **M21** — initial release. Postgres `audit_events` table, event ingest, cost-worker denormaliser, governance approvals.
- **M21.5** — `continuation_payload` on approvals so mcp-server can resume after a restart. `consumed` lifecycle state.
- **M35.1** — anonymous-mode opt-in only (`AUDIT_GOV_ALLOW_ANONYMOUS_DEV=1`). Per-source-service allowlist.
- **M35.3** — resource limits + healthcheck so dependent services can use `condition: service_healthy`.
- **M63 Slice A** — `/audit/search` Splunk-like endpoint with Postgres tsvector FTS, multi-value filters, cursor pagination. New `search_vector` generated column with GIN index.
- **M63 Slice B** — `/audit/stream` SSE live-tail.
- **M63 Slice C** — `tool.filesystem.access` and `.sensitive` event kinds added (emitted by mcp-server).
- **M63 Slice D** — `risk_level` column (low/medium/high/critical) classified at ingest. Backfill UPDATE on existing 7K rows.
- **M65 Slice 1A** — `token_savings_runs` table migrated from metrics-ledger. New `/api/v1/savings/*` read endpoints. cost-worker extended to populate the table from `llm.call.completed` events with cache/compression metrics.

## Known limitations

- SSE stream is single-instance in-process (no Redis fanout). Capped at 50 subscribers. Scaling beyond one audit-gov pod would require pg LISTEN/NOTIFY bridging.
- FTS uses the English Snowball stemmer — non-English event payloads will tokenize but won't stem.
- Last-Event-ID resume on SSE reconnect not implemented; clients re-issue the matching `/audit/search` to catch up.
- `engine_*` tables (Singularity Engine — automated failure triage) are evolving; treat as M-numbered but unstable surface.
