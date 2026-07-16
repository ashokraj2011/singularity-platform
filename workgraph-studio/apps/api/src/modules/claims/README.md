# claims — the M-CR3 cross-service tail

Closes the decay loop from the other side. When claim-registry decides a belief has
weakened (`claim.decay.threshold_crossed`) or been refuted (`claim.falsified`), this
module re-flags every workflow template that rests on that claim.

- **`claim-events-core.ts`** — pure, DB-free. Recognizes the two review events, extracts
  `metadata.claimRefs` tolerantly, and appends review flags idempotently. Unit-tested
  (`test/claim-events-core.test.ts`).
- **`claim-event-handler.ts`** — called from `/api/events/incoming` (the M11.e receiver)
  **after** HMAC verification. Scans workflow templates (`prisma.workflow`,
  `@@map("workflow_templates")`), flags those referencing the claim, and writes a
  `WorkflowTemplateClaimReviewFlagged` EventLog row. **Flags only — never blocks or
  deactivates** (the registry's no-auto-demotion stance). Runs outside a tenant context on
  purpose: a claim can be referenced across tenants, and templates are not RLS-scoped.

## The template convention this establishes
- `Workflow.metadata.claimRefs: Array<{ claimId, snapshotId?, note? }>` — written when a
  template is justified by a SPEC_BOUND claim. Validated at write time via the resolver's
  new `claim` kind (`POST /api/lookup/resolve` with `{ kind: "claim", id }`).
- `Workflow.metadata.claimReview: Array<ReviewFlag>` — appended by the handler; idempotent
  per `(claimId, eventName, outboxId)` so webhook redelivery never double-flags. Cleared by
  a human from the template UI (frontend — out of scope here).

## Operator wiring (deploy-time, not code)
1. **claim-registry** — seed the subscription: `claim-registry/prisma/seed-subscriptions.example.sql`
   (one row; its `secret` is the shared value).
2. **workgraph-api env** — `WORKGRAPH_INCOMING_EVENT_SECRETS` must include the same secret
   keyed by source: `{"claim-registry": "<shared-secret>", ...}`. Unconfigured sources
   fail closed (401 UNTRUSTED_SOURCE).
3. **workgraph-api env** — `CLAIM_REGISTRY_URL=http://claim-registry:8600` (the resolver's
   `claim` kind reads this; defaults to that value).

## Known limitation
Claim envelopes carry no `tenant_id` (claims are capability-scoped). The receiver accepts
them under the default `TENANT_ISOLATION_MODE=off`; a `strict` workgraph deployment would
reject them (403 MISSING_EVENT_TENANT) before flagging. Threading the outbox row's tenant
into the envelope is the follow-up if strict-mode delivery is needed.

## End-to-end smoke (after both sides are wired)
1. Create a claim, attach evidence, transition it to VALIDATED.
2. Add `{"claimRefs":[{"claimId":"<id>"}]}` to a workflow template's metadata (the resolver
   now validates it).
3. Backdate the evidence and `POST /api/v1/jobs/decay-recompute` on claim-registry.
4. Registry emits `claim.decay.threshold_crossed` → dispatcher signs + POSTs → workgraph
   verifies, flags the template, writes `WorkflowTemplateClaimReviewFlagged` to EventLog.
5. Redeliver the same webhook — no second flag (idempotency).
