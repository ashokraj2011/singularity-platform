# Staging validation runbook — RLS cutover + capability grounding

Everything in the RLS series (#416/#417/#419) and the grounding series (#421–#425) is
merged but has only been **static-verified** (esbuild / py_compile / config-guards). None
of it has touched a live DB, gateway, or central mcp-server. This runbook is the ordered
checklist to prove each on **staging** before prod, with the exact checks and the rollback
for each.

Order matters: **Part 1 (RLS) first** (it can block API boot), then **Part 2 (grounding)**,
and within grounding **A/D1 before B/C/D3** (nothing can embed or index until the embedding
provider works).

Conventions: `$WG_ADMIN` = the workgraph **admin** DB URL (`DATABASE_URL_WORKGRAPH_ADMIN`);
`$WG_APP` = the non-bypass **app** DB URL. `$API` = the platform-web API base (e.g.
`http://localhost:5180`). Adjust mount prefixes for your deployment.

---

## Part 1 — RLS cutover (highest risk; do first)

Forces RLS on 23 tables (16 engine + 7 WorkItem/trigger family). Fail-closed: the migration
preflight RAISEs and aborts the deploy if a precondition is unmet, so a bad cutover fails
the deploy **loudly** rather than silently breaking data access.

### 1.1 Pre-flight (before applying)
```bash
# Static contract guards (no DB needed) — should all pass:
python3 bin/check-workgraph-forced-rls-cutover.py
python3 bin/check-workgraph-db-tenant-isolation.py        # source/schema layer

# The admin role MUST be able to bypass RLS (else TimerSweep / trigger sweeps go blind):
psql "$WG_ADMIN" -c "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;"
#   expect rolsuper=t OR rolbypassrls=t. If not:  ALTER ROLE "<admin>" BYPASSRLS;

# No NULL-tenant rows (the backfill 20260709145000 handles pre-existing; confirm 0):
psql "$WG_ADMIN" -c "SELECT count(*) FROM workflow_instances WHERE \"tenantId\" IS NULL;"   # expect 0
```

### 1.2 Apply
Migrations auto-apply on deploy: Docker runs `prisma migrate deploy` on container start;
bare-metal runs `db push` + the psql list in `bin/bare-metal.sh`. Just deploy the branch.
If a guard aborts the deploy, that's the fail-closed signal — resolve the named blocker
(below) and redeploy.

### 1.3 Verify FORCE is on + access still works
```bash
# All 23 tables show relrowsecurity=t AND relforcerowsecurity=t:
psql "$WG_ADMIN" -c "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
  WHERE relnamespace='public'::regnamespace AND relforcerowsecurity ORDER BY relname;"

# Full contract incl. live RLS state (fail-closed):
python3 bin/check-workgraph-db-tenant-isolation.py --require-db --require-rls
```
Then exercise **as the app role** (`$WG_APP`, non-bypass) through the API with a normal
tenant session:
- List runs / open a run  → rows visible (the app role's `SET app.tenant_id='default'` makes
  single-tenant rows visible).
- **Task CRUD** (create/list/complete a task) — the B1 blocker: bare `prisma.task.create`
  without tenantId is rejected by the FORCE `WITH CHECK` unless the DB default / write path
  supplies it. If task CRUD fails under FORCE, that's blocker **B1** (untenanted write route).
- Trigger a SCHEDULE/EVENT workflow trigger and a timer → confirm it still fires (that's the
  admin-role/BYPASSRLS path — blocker **B4** if it stops).

### 1.4 Rollback
Run the DISABLE / NO FORCE block from
`workgraph-studio/apps/api/prisma/rls-cutover-manual-apply-only.sql` **as the admin role**.
(Forcing is idempotent, so re-deploy re-applies once blockers are fixed.)

### 1.5 Named blockers to resolve if verification fails
- **B1** — a non-engine write route inserts without a tenantId (task CRUD, agents `/:id/runs`,
  laptop.service, ToolGatewayService). Tenant-scope the offender.
- **B4** — admin role lacks `BYPASSRLS` → cross-tenant sweeps stop. `ALTER ROLE … BYPASSRLS;`

---

## Part 2 — Grounding

### 2.A Embedding provider works (do before B/C/D3 — nothing embeds otherwise)
The gateway only embeds for openai/openrouter/mock; the default `anthropic` 400s.
```bash
python3 bin/check-embedding-provider.py --strict     # must print OK (exit 0)
```
If it FAILs: set `EMBEDDING_MODEL_ALIAS` to an embedding-capable alias — `embed-mock` for
staging, or a real openai/openrouter model (add it to `.singularity/llm-models.json` +
`allowedProviders` + credential). Then confirm a real embedding round-trips:
```bash
curl -sS -X POST "$LLM_GATEWAY_URL/v1/embeddings" \
  -H "authorization: Bearer $LLM_GATEWAY_BEARER" -H "content-type: application/json" \
  -d '{"input":["ping"],"model_alias":"'"$EMBEDDING_MODEL_ALIAS"'"}' | jq '.dim, .provider'
#   expect a dim (e.g. 1536) + an embedding-capable provider, NOT a 400.
```

### 2.D1 Direct-to-gateway transport (grounding off the mcp/laptop bridge)
Set `LLM_GATEWAY_URL` (+ `LLM_GATEWAY_BEARER`) on agent-runtime + prompt-composer.
- Run one agent stage / compose; confirm embeddings + LLM calls succeed with the
  `mcp-server` relay **stopped** (proves the direct path is used, not the relay).
- Leave `LLM_GATEWAY_URL` unset to fall back to the relay (default).

### 2.B Auto-grounding (onboard → usable) — needs 2.A green
```bash
export CAPABILITY_AUTO_GROUND=true        # on agent-runtime, then onboard a capability
```
Onboard a test capability, then check the grounding/readiness:
```bash
curl -sS "$API/api/runtime/capabilities/$CAP_ID/grounding-status" | jq
```
Expect: the **6 non-locked** agents ACTIVE, the **3 locked gates** (Verifier/Security/
Governance) still DRAFT, safe knowledge groups (`agent_team_grounding`, `architecture_diagram`,
`platform_inventory`) MATERIALIZED with **non-null embeddings** (`embeddingCoverage.degraded=false`
if 2.A is green), and the bootstrap run's `warnings` carrying the review note for the locked gates.

### 2.C Freshness (drift → real re-ground) — needs 2.A green
```bash
export WORLD_MODEL_AUTO_REFRESH_ENABLED=true     # on agent-runtime
```
Simulate a repo change so the fingerprint differs, then hit the fingerprint endpoint (or let
the runtime report it). Confirm in logs: `[worldModel.autoRefresh] … background re-grounding
completed (profiles=…, artifacts=…)` — i.e. a **real** re-ground ran, not just a stamped
`lastAutoRefreshAt`. Grounding status should return to `LEARNED`.

### 2.D3 Central code grounding (clone + AST index server-side, no laptop)
Requires `MCP_SERVER_URL` → a **central** mcp-server (not a laptop dial-in) and
`MCP_AUTO_CHECKOUT_SOURCE=true` on it.
```bash
export GROUND_CODE_AT_ONBOARD=true        # on agent-runtime
```
Onboard a capability with a real (public, for a first pass) repo, **laptop offline**. Verify:
```bash
# world model got an AST index stamp + a real file count, produced centrally:
curl -sS "$API/api/runtime/capabilities/$CAP_ID/world-model" | jq '.astIndexedAt, .repoFingerprint'
```
Or hit the endpoint directly to see the result inline:
```bash
curl -sS -X POST "$MCP_SERVER_URL/mcp/source/ground" \
  -H "authorization: Bearer $MCP_BEARER_TOKEN" -H "content-type: application/json" \
  -d '{"capability_id":"'"$CAP_ID"'","source_uri":"'"$REPO_URL"'","source_ref":"main"}' | jq '.data'
#   expect { grounded:true, indexedFiles:>0, headSha:"…" }. grounded:false + reason tells you why
#   (auto-checkout disabled, or source not checked out).
```
For **private** repos, confirm the broker issues a clone credential (or set a static
`GITHUB_TOKEN` on the central mcp-server for a first pass).

---

## Deferred (not in this runbook — separate efforts)
- Physical merge of the two outbox tables (fail-open; #420 shipped the safe decouple only).
- Dynamic central grounding (running build/test centrally) — needs container isolation.
- RLS enforcement blockers B1/B4 are the gate for Part 1 passing under real multi-tenant load.
