# DEPRECATED — metrics-ledger-service

**Status:** sunset as of M65 (commits 1A + 1B).
**Removal target:** M66.

## Why

The platform had two parallel homes for LLM-call analytics:

- `audit-governance-service` (Postgres, since M21) — canonical event store
  with FTS (M63), risk classifier (M63), live tail (M63), cost
  denormalisation via the cost worker, and (as of M65 Slice 1A) the
  `token_savings_runs` table.
- `metrics-ledger-service` (this directory; legacy SQLite, now Postgres-capable for migration, since M30) — a
  separate sidecar that received POST writes for token-savings runs
  and per-LLM-call rollups.

Operators had to query two places for the same fact, and the dual-write
path was a source of drift bugs whenever schemas diverged. M65 Slice 1A
migrated the `token_savings_runs` schema (verbatim) into audit-gov's
Postgres and extended the cost-worker to populate it from
`llm.call.completed` events that carry cache or compression metrics.
Slice 1B (this) removed the running container.

## What stays

- This source tree (for one operator cycle, in case anyone reads the
  old host-mounted data directly).
- The `data/metrics_ledger/metrics_ledger.db` file on the host volume
  (untouched). `bin/migrate-context-fabric-sqlite-to-postgres.py` can
  backfill it into `singularity_context_fabric` before deletion.
- A stale `settings.metrics_ledger_url` field in `context_api_service`
  config — kept only because the deprecated `/chat/respond` endpoint
  (HTTP `Sunset: 2026-07-01`) still references it. The actual writes
  fail silently (connection refused) — correct behaviour for a
  deprecated path that's already on its way out.

## What's gone

- `metrics-ledger` compose service entry.
- `METRICS_LEDGER_URL` env on every consumer.
- `metrics-ledger` from `context-api`'s `depends_on`.
- Live read fallback: `/metrics/dashboard` and `/sessions/{id}/metrics`
  return 503 when `AUDIT_GOV_URL` is unset (instead of silent-routing
  to a dead host).

## Migration cheat sheet

| Old (metrics-ledger)                                       | New (audit-gov)                                       |
|-----------------------------------------------------------|-------------------------------------------------------|
| `GET  http://metrics-ledger:8003/metrics/dashboard`        | `GET  http://audit-gov:8500/api/v1/savings/dashboard` |
| `GET  http://metrics-ledger:8003/metrics/savings/session/X`| `GET  http://audit-gov:8500/api/v1/savings/session/X` |
| `GET  http://metrics-ledger:8003/metrics/savings/agent/X`  | `GET  http://audit-gov:8500/api/v1/savings/agent/X`   |
| `GET  http://metrics-ledger:8003/metrics/best-mode`        | `GET  http://audit-gov:8500/api/v1/savings/best-mode` |
| `POST http://metrics-ledger:8003/metrics/token-savings`    | Emit `llm.call.completed` audit event with cache/compression metrics — the cost-worker (`audit-governance-service/src/cost-worker.ts`) populates `token_savings_runs` automatically. No direct write path. |
| `GET  http://metrics-ledger:8003/metrics/llm-calls/...`    | The existing `llm_calls` denormalised table in audit-gov (M21 cost-worker output) covers this. Cost-per-converged-capability is a follow-up query. |

## How to actually remove this in M66

```bash
# In docker-compose.yml: nothing to do (already gone).
# To delete the source tree:
git rm -r context-fabric/services/metrics_ledger_service/
# To delete the SQLite volume:
rm -rf context-fabric/data/metrics_ledger/
# To drop the stale config field:
# Edit context-fabric/services/context_api_service/app/config.py
# remove `metrics_ledger_url` and the corresponding env-fallback line.
# Then remove the metrics-write block in main.py:/chat/respond (the
# entire `metrics_url = settings.metrics_ledger_url...` + the
# try/except around post_json /metrics/token-savings).
```
