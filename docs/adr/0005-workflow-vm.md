# ADR 0005: Workflow VM — portable, signed, run-anywhere WorkGraph images

## Status

Accepted. Implemented as the `@workgraph/vm` package, the `wgvm` CLI
(`workgraph-studio/apps/wgvm-cli`) and an OCI image. Phase 1–3 of the plan are
delivered and tested; parity/e2e hardening (Phase 4) is tracked separately.

## Context

Today a WorkGraph workflow can only execute inside `workgraph-studio/apps/api`,
whose `WorkflowRuntime` (~2000 lines, 35 node executors) is tightly coupled to
Prisma, the tenant Postgres database, IAM, the LLM router, MCP tools, connectors,
git and the audit-governance service. There is no way to take a workflow and run
it somewhere else — a laptop, an edge node, an air-gapped host, or a different
cluster — nor to run it while disconnected from the central platform.

We want to **build a workflow once into a self-contained, signed artifact and
execute it anywhere**, online (calling central services through injected
adapters) or offline (degrading/queuing the steps that need humans or IAM),
persisting state locally and syncing tamper-evident receipts back to audit-gov
when reconnected.

## Decision

Introduce a **Workflow VM**: a Prisma-free portable runtime plus a signed
package format.

### 1. The `.wgvm` image format (content-addressed, signed)

A `.wgvm` image is a deterministic, canonical-JSON document with:

- **`manifest`** — `imageId` (sha256 of the canonical payload), engine ABI,
  workflow id/name, `versionHash`, the node types used, the adapter capabilities
  required to run online, a `policyHash`, and a per-file digest map.
- **`payload.workflow`** — the portable `WorkflowDefinition` (nodes, edges,
  variables, globals), mapped from a template's design-graph exactly as the
  studio player maps it (`apps/web/src/lib/engineHooks.ts` `loadDefinition`), so
  a VM run matches a studio run.
- **`payload.policy`** — a bundled governance policy snapshot (gated node types,
  allowed capabilities, approval-required node types, `failClosed`) so gates can
  enforce **offline**.
- **`payload.assets`** — node-embedded artifacts (e.g. prompt templates) needed
  for offline runs.
- **`signature`** — an optional detached Ed25519 signature over the canonical
  digest of the manifest + payload.

Integrity is **fail-closed**: `verifyImage`/`loadImage` recompute every file
digest and the `imageId`, and (when a signature or a trusted-key set is present)
verify the signature before the VM will run. Any mismatch refuses execution.

### 2. The portable runtime — `@workgraph/vm`

Built on the existing Prisma-free `@workgraph/engine` (EdgeEvaluator,
GraphTraverser, types). It provides:

- **`WorkflowVm`** — a Prisma-free re-implementation of the server's
  activate → execute → bind → advance loop, driving the same
  `resolveNextEdges` edge logic (XOR decision gates, inclusive gateways,
  AND-joins), with error boundaries and blocking/parking + resume.
- **`StateStore` / `SqliteStateStore`** — embedded state on Node's built-in
  `node:sqlite` (no native dependency): `runs`, hash-chained `receipts`, and an
  **outbox** that queues audit events so they are **never dropped** offline.
- **Adapter interfaces** (`Iam`, `Llm`, `McpTool`, `Git`, `HumanTask`, `Audit`,
  `Clock`) with two implementations: **`httpAdapters`** (online, per-capability
  base URLs + bearer tokens) and **`offlineAdapters`** (degrade: service-bound
  capabilities throw `OfflineError`, which executors translate into a `BLOCKED`
  outcome so the run parks and can resume/sync later). `mergeAdapters` composes
  them per capability, so a partially-connected VM degrades only the
  capabilities it can't reach.
- **Executors** — deterministic nodes (SET_CONTEXT, decision/structural, TIMER)
  run fully offline; service-bound nodes (HUMAN_TASK/APPROVAL, GOVERNANCE_GATE,
  DIRECT_LLM_TASK/AGENT_TASK, TOOL_REQUEST, GIT_PUSH/RAISE_PR/CREATE_BRANCH)
  route through adapters and degrade offline.
- **Signed receipts** — every node completion emits a sha256 receipt chained
  from the previous one (`prevHash` "GENESIS" first), optionally Ed25519-signed,
  giving a tamper-evident execution ledger.

### 3. Builder, CLI and packaging

- **Builder** (`buildImageFromDesignGraph`) turns a design-graph + policy
  snapshot into a deterministic, optionally-signed `.wgvm`.
- **`wgvm` CLI** — `keygen`, `build`, `verify`, `run`, `status`, `resume`,
  `sync`. `build` accepts a local spec (`--input`) or fetches from the API
  (`--from-api`); `run`/`resume` accept per-capability online endpoints and
  fall back to offline degrade otherwise.
- **`receipt-sync`** (`syncOutbox`) replays the SQLite outbox to audit-gov on
  reconnect, using each outbox entry id as an **idempotency key** so re-sends
  after a crash de-duplicate.
- **OCI image** — the CLI + vm + engine are bundled into a single dependency-free
  ESM file with esbuild, copied into a slim Node image. `docker run wgvm run
  /image.wgvm …` runs a workflow anywhere, needing only Node built-ins.

## Consequences

- **Portability:** a workflow now runs on a laptop, edge node, air-gapped host or
  container, not just the central API.
- **Offline safety:** governance gates are **fail-closed** offline, human/IAM
  steps **park** rather than silently pass, and audit events are **queued, never
  dropped**.
- **Trust:** verify-before-run is mandatory and fail-closed; images are
  content-addressed and optionally signed; receipts are hash-chained.
- **Executor duplication (accepted risk):** the VM currently ports a subset of
  the 35 server executors. The long-term direction is to refactor the *server*
  runtime onto the same adapter interfaces so there is one executor codebase with
  two adapter sets (Prisma-backed in-server, HTTP/offline in-VM). Until then, new
  node semantics must be mirrored in both places — the manifest's `nodeTypes` and
  `requiredAdapters` make gaps explicit.
- **Governance staleness (accepted):** the bundled policy is a point-in-time
  snapshot; the manifest carries a `policyHash` and images must be rebuilt when
  policy changes.

## References

- Package: `workgraph-studio/packages/vm` (`@workgraph/vm`)
- CLI + Dockerfile: `workgraph-studio/apps/wgvm-cli`
- Design-graph mapping reference: `apps/web/src/lib/engineHooks.ts`
- Server runtime being ported: `apps/api/src/modules/workflow/runtime/WorkflowRuntime.ts`
