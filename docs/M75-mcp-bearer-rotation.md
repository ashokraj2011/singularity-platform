# MCP_BEARER_TOKEN rotation strategy

**Status**: Design doc. No code in this commit. Task #92.

## Problem

`MCP_BEARER_TOKEN` is the bearer that context-fabric uses to
authenticate to mcp-server's `/mcp/tool-run` (and the dead
`/mcp/invoke`). Today:

- It's a static string in env (`docker-compose.yml`, the prod
  secret manager, every operator's local `.env`).
- There's no rotation path. To change it: edit env in every
  service, restart every service, accept downtime.
- Compromise = the only recovery is the manual rotation above.
- Every CF→mcp-server call sends the same token forever.

The bridge dispatch path doesn't use this bearer (the laptop
handshake owns its own auth), so this debt only affects the
shared mcp-server path. But that's still the majority of
calls today.

## What good looks like

A rotation can:
1. Be triggered by an operator (compromise) or a scheduled job
   (quarterly hygiene).
2. Run with zero downtime — CF and mcp-server both accept the old
   AND the new token during a transition window, then mcp-server
   drops the old token.
3. Be auditable — the rotation event lands in audit-gov so an
   incident review can reconstruct the timeline.
4. Be reversible — if the new token is bad, the old one is still
   valid until the window closes.

## Recommended design — two-token lease

The smallest design that meets all four:

### mcp-server accepts a SET of tokens, not a single one

Replace `MCP_BEARER_TOKEN` (singular) with `MCP_BEARER_TOKENS`
(comma-separated list). The first non-empty token is the
"primary" (used in new outbound dispatches by CF if CF reads from
this env too — it doesn't currently, but documenting the
convention now). All tokens in the list are accepted as valid
authorizers on inbound requests.

```ini
# mcp-server .env
MCP_BEARER_TOKENS=newtoken_2026Q2,oldtoken_2026Q1
```

mcp-server's auth middleware: `if (req.bearer in
allowed_tokens) accept`. Pin in a TS test that a list with one
entry behaves identically to the current single-token code.

### CF reads PRIMARY only

CF's `dispatch.py` (the line `_MCP_BEARER = os.environ.get(...)`)
stays single-valued. The env-loader picks the first comma-
separated entry from `MCP_BEARER_TOKENS` if set, else falls back
to the legacy `MCP_BEARER_TOKEN` for back-compat.

### Rotation flow

```
T-7d (week before): ops generates `newtoken_2026Q2`.
T-0:   Add newtoken to MCP_BEARER_TOKENS on mcp-server, push,
       restart mcp-server. Order in list: [oldtoken_2026Q1, newtoken_2026Q2].
       (mcp-server now accepts both. CF still sends old.)
T+0:   Switch the order on mcp-server: [newtoken_2026Q2, oldtoken_2026Q1].
       Update CF's MCP_BEARER_TOKEN to newtoken_2026Q2. Restart CF.
       (CF sends new. mcp-server accepts both.)
T+1d:  Verify audit-gov shows zero 401s from CF. Remove oldtoken
       from mcp-server's list. Restart mcp-server.
       (mcp-server only accepts new. Done.)
```

Total downtime: zero. Worst case if a step is missed: 401s start
firing in audit-gov, ops rolls back the list change. Two restarts
of each service, no in-flight call disruption (next call uses
new token after restart; in-flight finishes on old socket).

### Audit-gov coverage

Three new event kinds:
- `mcp.bearer.token_added` — emitted by mcp-server on env reload
  when a new token appears in the list.
- `mcp.bearer.token_dropped` — emitted on env reload when a token
  leaves the list.
- `mcp.bearer.auth_rejected` — already exists implicitly (any
  401); make sure mcp-server's middleware logs it with
  `severity=warn` so it shows up in the dashboard alongside the
  rotation events.

Operator dashboard: a query for
`kind:mcp.bearer.*` over the last 30 days shows the rotation
history. A spike in `auth_rejected` after a `token_dropped`
means CF didn't pick up the new env — the rollback signal.

## Alternative considered — JWT-style short-lived tokens

CF asks mcp-server for a 1h JWT on every cold start, refreshes
in the background. Rejected because:

- Adds a new endpoint (`/mcp/auth/issue`) and refresh logic to
  both sides. ~400 LOC + tests.
- mcp-server has to hold a long-lived signing key anyway — the
  rotation problem just moves up a level.
- The two-token lease pattern is what most ops are familiar with
  from cloud provider IAM. Less surprise.

JWT becomes the right answer when we need per-call audience
restrictions (e.g. CF's QA stage can only run `run_test`, not
`apply_patch`). That's an M76+ concern; the rotation problem is
solved standalone today.

## Cross-service implications

- **agent-runtime** doesn't call mcp-server with a bearer (it's
  internal-only to CF→mcp-server). No change.
- **workgraph-api** doesn't call mcp-server directly post-M71. No
  change.
- **laptop bridge** (M75) uses its own per-device tokens, not
  this bearer. No change.
- **audit-gov** has its own `AUDIT_GOV_SERVICE_TOKEN` with the
  same rotation problem — same lease pattern would apply, but
  the blast radius is smaller (only used for service-to-service
  ingest). Lower priority; track as a sibling follow-up if and
  when the MCP rotation lands.

## Implementation cost

- mcp-server middleware change: ~40 LOC + ~50 LOC tests.
- CF env-loader update: ~10 LOC + ~30 LOC tests.
- audit-gov event-emit hook in mcp-server's auth middleware:
  ~20 LOC.
- Runbook for the rotation flow: this doc + an internal SOP.
- Docker-compose env update + secrets-manager template: ~10 LOC.

Total: ~150 LOC code + tests, plus operator runbook. Ships in
~1 day of focused work.

## Rollout plan

1. **Phase 1** — Ship the multi-token acceptance on mcp-server,
   keep CF on single-token. Backward compatible: `MCP_BEARER_TOKEN`
   continues to work; `MCP_BEARER_TOKENS` is an optional addition.
2. **Phase 2** — Add audit-gov event emission on auth decisions.
3. **Phase 3** — Document the rotation runbook. Do a dry-run
   rotation in dev.
4. **Phase 4** — Schedule the first prod rotation. Wait one
   quarter (or until compromise). Run the dry-run flow live.

## Out of scope (deferred)

- Token-per-tenant or token-per-stage. Today every CF call uses
  the same bearer; multi-tenant isolation would require a
  meaningful re-architecture and isn't on the M75 path.
- HSM-backed key storage. The token is a bearer, not a signing
  key — overkill for the threat model.
- Automatic rotation on detected compromise. Manual ops with
  good audit trail is the right level of friction for a key this
  load-bearing.
