# @workgraph/vm — portable Workflow VM

Build a WorkGraph workflow once into a **signed, self-contained `.wgvm` image**
and execute it **anywhere** — laptop, edge node, air-gapped host or container —
online (calling central services through injected adapters) or offline
(degrading/queuing the steps that need humans or IAM). State persists in embedded
SQLite and tamper-evident receipts sync back to audit-gov on reconnect.

Built on the Prisma-free [`@workgraph/engine`](../engine). Nothing here imports
Prisma or Express, so it runs anywhere Node runs.

## Why

The server `WorkflowRuntime` is coupled to Prisma, the tenant DB, IAM, the LLM
router, MCP tools, git and audit-gov, so a workflow could only ever run inside
the central API. The VM lifts the orchestration loop out of that coupling behind
**adapter interfaces** and packages the workflow + governance policy into a
signed artifact. See [ADR 0005](../../../docs/adr/0005-workflow-vm.md).

## Concepts

| Piece | What it does |
| --- | --- |
| `.wgvm` image | Canonical-JSON, content-addressed (`imageId` = sha256), per-file digests, optional Ed25519 signature. Bundles the workflow, a governance policy snapshot and assets. |
| `WorkflowVm` | Prisma-free activate → execute → bind → advance loop driving `@workgraph/engine`. Parks on offline/human steps and resumes. |
| `StateStore` / `SqliteStateStore` | Embedded state on Node's built-in `node:sqlite`: runs, hash-chained receipts, and an outbox that never drops audit events. |
| Adapters | `iam` / `llm` / `tool` / `git` / `human` / `audit` / `clock`. `httpAdapters` (online) + `offlineAdapters` (degrade) + `mergeAdapters` (per-capability). |
| Executors | Deterministic (SET_CONTEXT, decision/structural, TIMER) run offline; service-bound ones route through adapters and BLOCK offline. |
| Receipts | Per-node, sha256, chained from the previous (`prevHash` "GENESIS" first), optionally signed. |

## Library usage

```ts
import {
  buildImageFromDesignGraph, verifyImage, WorkflowVm,
  SqliteStateStore, offlineAdapters, httpAdapters, mergeAdapters,
} from '@workgraph/vm'

// 1. Build a signed image from a design-graph + policy snapshot.
const image = buildImageFromDesignGraph({
  workflow: { id: 'wf-1', name: 'Demo', currentVersion: 3 },
  graph: { nodes, edges },              // design-graph shape
  policy: {
    gatedNodeTypes: ['GOVERNANCE_GATE'],
    allowedCapabilities: [],            // capabilities allowed offline
    approvalRequiredNodeTypes: [],
    failClosed: true,                   // gates that can't evaluate → BLOCK
  },
  signingPrivateKeyB64, signingPublicKeyB64,   // optional Ed25519 keypair
})

verifyImage(image)                      // fail-closed integrity check

// 2. Run it. Offline degrades; online routes through HTTP adapters.
const store = new SqliteStateStore('run.db'); store.init()
const adapters = mergeAdapters(
  httpAdapters({ llm: { baseUrl: 'https://api…', token }, iam: { baseUrl: '…' } }),
  offlineAdapters(store),
)
const vm = new WorkflowVm({ image, store, adapters, receiptSigningKeyB64 })
const state = await vm.start({ /* inputs */ })
// state.status is COMPLETED | BLOCKED | FAILED; resume a parked run:
if (state.status === 'BLOCKED') await vm.resume(state.runId)
```

## CLI (`wgvm`)

From `workgraph-studio/apps/wgvm-cli` (`node --import tsx src/index.ts <cmd>` in
dev, or the bundled `node dist/wgvm.mjs <cmd>`):

```sh
wgvm keygen --out key.json
wgvm build  --input spec.json --out demo.wgvm --keypair key.json
wgvm verify demo.wgvm --require-signature
wgvm run    demo.wgvm --state run.db --run r1 \
            --llm-url https://api… --llm-token $T --audit-url https://audit…
wgvm status --state run.db --run r1
wgvm resume demo.wgvm --run r1 --state run.db --human-url https://tasks…
wgvm sync   --state run.db --audit-url https://audit… --audit-token $T
```

`build --input` spec shape:

```json
{
  "workflow": { "id": "wf-1", "name": "Demo", "currentVersion": 1 },
  "graph": { "nodes": [ … ], "edges": [ … ] },
  "policy": { "gatedNodeTypes": [], "allowedCapabilities": [],
              "approvalRequiredNodeTypes": [], "failClosed": true }
}
```

`build --from-api https://api… --workflow-id <id> --token $T` fetches the
template + design-graph instead of `--input`.

## OCI container

The CLI + vm + engine bundle into one dependency-free file, so the container
needs only Node built-ins (no npm install, no registry):

```sh
pnpm --filter @workgraph/wgvm-cli bundle          # -> apps/wgvm-cli/dist/wgvm.mjs
docker build -f apps/wgvm-cli/Dockerfile -t wgvm:latest .   # context = workgraph-studio/
docker run --rm -v "$PWD:/data" wgvm:latest \
  run /data/demo.wgvm --state /data/run.db
```

Bake a specific workflow into a self-contained appliance with
`--build-arg WGVM_IMAGE=demo.wgvm`, then `docker run … run /app/image.wgvm`.

## Offline / trust guarantees

- **Verify before run, fail-closed** — digests + `imageId` are recomputed and any
  signature checked; mismatches refuse to run.
- **Governance offline** — gated capabilities not in the bundled policy's
  allow-list **BLOCK** when `failClosed` (no silent pass).
- **Humans/IAM degrade** — service-bound steps park as `BLOCKED` and resume when
  the matching adapter is online.
- **Audit never dropped** — offline audit events queue in the outbox; `wgvm sync`
  replays them idempotently to audit-gov.

## Develop

```sh
pnpm --filter @workgraph/vm typecheck
pnpm --filter @workgraph/vm test        # node --test, node:sqlite (Node 22+)
```
