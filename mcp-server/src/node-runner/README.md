# Workflow poll-runner

A first-class runner for **non-SERVER** workflow nodes (`executionLocation` = `CLIENT` /
`EDGE` / `EXTERNAL`). Those nodes are queued as `pending_executions` rows by
workgraph-api but nothing executes them out of the box — this process does.

It is **not** the dial-in bridge. It's a standalone consumer of the workgraph-api
pending-execution API, so it can run anywhere (an on-prem/edge host, a CI box, a
user desktop) and pull work for its location.

## Loop

```
GET  /api/workflow-instances/pending-executions/poll?location=<LOC>
POST /api/workflow-instances/pending-executions/:id/claim      → { claimToken }   (409 = another runner won it)
runNode(...)                                                    → result | error
POST /api/workflow-instances/pending-executions/:id/complete   { claimToken, result | error }
```

The claim/complete API is the hardened one (PR #382): the claim is an atomic
single-winner and complete is gated by the returned `claimToken`, so **multiple
runners can poll the same queue safely** (double-claim and cross-runner overwrite
are impossible).

## Supported node types (MVP)

- **TOOL_REQUEST** → runs the configured tool via the local tool registry
  (`toolName`/`toolId` + `inputPayload`/`args`).
- **RUN_PYTHON** → runs the inline program via the `run_python` sandbox
  (needs `MCP_COMMAND_EXECUTION_MODE=container` on this host).

Any other node type is rejected as `UNSUPPORTED_NODE_TYPE` (the node fails with a
clear reason rather than running the wrong thing).

## Run it

Shares the mcp-server environment (for the tool registry + Python sandbox), plus:

| Env | Required | Default | Meaning |
|-----|----------|---------|---------|
| `WORKGRAPH_API_URL` | ✅ | — | Base URL of workgraph-api, e.g. `http://localhost:8080` |
| `RUNNER_AUTH_TOKEN` | ✅ | — | Bearer token authorized to poll/claim/complete |
| `RUNNER_TENANT_ID` | under strict isolation | — | Sent as `X-Tenant-Id` |
| `RUNNER_LOCATION` | | `EDGE` | `CLIENT` \| `EDGE` \| `EXTERNAL` |
| `RUNNER_POLL_INTERVAL_MS` | | `3000` | Poll cadence (250–60000) |
| `RUNNER_MAX_CONCURRENCY` | | `2` | Concurrent node executions (1–16) |
| `RUNNER_HTTP_TIMEOUT_MS` | | `30000` | Per-request timeout (1000–600000) |

```bash
# dev
WORKGRAPH_API_URL=http://localhost:8080 RUNNER_AUTH_TOKEN=… RUNNER_LOCATION=EDGE \
  npm run dev:node-runner

# built
npm run build && npm run node-runner
```

## Not covered yet

- **EXTERNAL via webhook** (push to an external provider) — this runner is pull-only.
- **Expiry sweep**: if *no* runner is polling a location, those nodes stay `ACTIVE`
  until their `pending_executions.expiresAt` (24h). A server-side sweep that fails
  unclaimed-expired rows is a planned follow-up so a missing runner surfaces as a
  node failure instead of a stall.
