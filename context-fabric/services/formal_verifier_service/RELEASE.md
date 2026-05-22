# formal-verifier-service — Release Notes

Z3-backed formal verification sidecar. Consumed by mcp-server's
`formal_verify` tool and `finish_work_branch` gate, and by
workgraph-api's Governance Path Analyzer.

## API surface

| Method | Path                                              | Notes                                                            |
|--------|---------------------------------------------------|------------------------------------------------------------------|
| GET    | `/health`                                         | Liveness + enabled flag.                                         |
| GET    | `/healthz/strict`                                 | 503 when enabled but Z3 init fails OR DATABASE_URL set but unreachable. |
| GET    | `/api/v1/verification/status`                     | Operator diagnostic: enabled?, solver readiness, DB readiness.   |
| POST   | `/api/v1/verification/verify`                     | Submit constraints + a query, get SAT/UNSAT/UNKNOWN + counterexample + hashes. |
| POST   | `/api/v1/verification/workflows/analyze`          | Verify a workflow template/instance graph for safety properties.  |
| POST   | `/api/v1/verification/agents/analyze`             | Verify an agent's tool permission set against policy.            |
| POST   | `/api/v1/verification/specs/analyze`              | Verify a code spec for consistency.                              |
| POST   | `/api/v1/verification/deployment-policies/analyze`| Verify a deployment policy.                                       |

## Env vars

| Var                              | Default                                          | Notes                                                          |
|----------------------------------|--------------------------------------------------|----------------------------------------------------------------|
| `FORMAL_VERIFICATION_ENABLED`    | `false`                                          | Master toggle. When false, `/verify` returns 409 FORMAL_VERIFICATION_DISABLED. |
| `DATABASE_URL`                   | empty                                            | When set, persists `verification_requests` / `verification_results` / `verification_receipts` rows to Postgres. Empty = synthetic IDs only (dev). |
| `DEFAULT_TIMEOUT_MS`             | `3000`                                           | Per-call Z3 budget.                                            |
| `MAX_TIMEOUT_MS`                 | `10000`                                          | Operator-facing cap so a caller can't hang the solver.          |

## Dependencies

**Upstream consumers**:
- mcp-server `formal_verify` tool + `finish_work_branch` gate
- workgraph-api Governance Path Analyzer

**Downstream**:
- Z3 SMT solver (bundled in the Python image via z3-solver==4.13.3.0)
- PostgreSQL (optional, for persistence)

## Milestones

- **M60 Slice 1** — service wired into docker-compose. Image built with z3-solver. `FORMAL_VERIFICATION_ENABLED=true` flipped in .env. Verified end-to-end with a sample SAT query returning a counterexample.

## Known limitations

- The `/api/v1/verification/status` "state" field has a labeling bug: when `solver_ok=true && db_ok=false` (DATABASE_URL empty), it reports "Service unreachable" instead of something like "Persistence disabled." The service itself is fully functional in this state — only display copy is wrong.
- Z3 timeouts on non-trivial constraints can run 5-30s. Defaults to 3000ms; raise per-call via the `timeoutMs` field in the request body when verifying complex workflow graphs.
- Constraint DSL diverges slightly from typical SMT-LIB. See `solver.py` for the field/operator dispatch. mcp-server's `formal_verify` tool wraps the conversion.
- No batch endpoint — each constraint set must be POSTed separately. Fine at the scale of "verify this workflow" but inefficient for "verify every workflow in a tenant nightly."
