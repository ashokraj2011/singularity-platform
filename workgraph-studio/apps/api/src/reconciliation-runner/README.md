# Reconciliation runner

The out-of-process executor for the **dynamic** reconciliation layer (spec §15, "Layer 2"). It
runs an implementer's declared tests off the request path and reports per-obligation results back
to workgraph-api, which folds them into the verdict matrix (declared → **verified**).

## Why a separate process

Running an implementer's tests means executing customer code. That must never happen inside the
API request. Instead, a deterministic `DYNAMIC` reconciliation enqueues a `ReconciliationJob`; this
runner claims it, checks out the head commit in an isolated workspace, runs the plan, and posts the
results. Claim + complete use the same atomic claim + `claimToken` fencing as `PendingExecution`,
so you can run several runners against one queue safely.

## Loop

```
GET  /api/reconciliation-jobs                → pending jobs
POST /api/reconciliation-jobs/:id/claim      → { …job, claimToken }   (409 = another runner won)
checkout headCommit → run testPlan           → TestResult[]
POST /api/reconciliation-jobs/:id/complete   { claimToken, tests }
POST /api/reconciliation-jobs/:id/fail       { claimToken, error }    (checkout/setup failure)
```

Each test plan entry maps an obligation to the requirement ids it verifies plus an optional
`command`. Exit 0 → `PASS`, non-zero → `FAIL`, no command (and no default) → `SKIPPED` (the API
treats `SKIPPED` as "not executed", so it never inflates a verdict).

## Run it

```bash
# from workgraph-studio/apps/api, after `pnpm build`
WORKGRAPH_API_URL=http://localhost:8080 \
RECONCILIATION_RUNNER_TOKEN=<bearer authorized to poll/claim/complete> \
RUNNER_TENANT_ID=default \
RECON_DEFAULT_TEST_COMMAND="npm test" \
node dist/apps/api/src/reconciliation-runner/runner.js
```

| Env | Default | Meaning |
| --- | --- | --- |
| `WORKGRAPH_API_URL` | — (required) | base URL of workgraph-api |
| `RECONCILIATION_RUNNER_TOKEN` | — (required) | bearer token authorized to poll/claim/complete |
| `RUNNER_TENANT_ID` | — | `X-Tenant-Id` (required under strict tenant isolation) |
| `RECON_GIT_BASE_URL` | `https://github.com/` | prefix for `org/repo` repositories |
| `RECON_DEFAULT_TEST_COMMAND` | — | command for obligations that declare none |
| `RECON_WORK_DIR` | OS temp dir | parent dir for checkouts |
| `RECON_POLL_INTERVAL_MS` | `5000` | queue poll cadence |
| `RECON_COMMAND_TIMEOUT_MS` | `600000` | per-command kill timeout |

## Isolation & auth (operator responsibility)

- **Sandbox the runner.** It executes arbitrary repo commands — run it in a disposable container /
  VM with no access to secrets or production networks, not on the API host.
- **Private repos.** `git clone` uses ambient git auth; provide a credential helper or a tokenized
  `RECON_GIT_BASE_URL` for private repositories. Never bake long-lived credentials into the image.
