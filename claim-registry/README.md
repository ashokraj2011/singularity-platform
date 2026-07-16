# claim-registry

The **belief layer** of the design studio — hypotheses, assumptions, decisions, and
requirements as **typed claims** with Bayesian posteriors, tier-weighted evidence,
decay kinetics, and a maturity state machine. Knowledge-plane microservice; owns its
DB outright (Postgres+pgvector on 5437), API on **8600**.

## M-CR1 (this milestone)
Schema, claim create/read, evidence attach, the **posterior engine**, maturity gates,
receipts, and the event outbox.

- **`src/lib/posterior.ts`** — pure log-odds engine: tier-capped LLRs, exponential
  decay (`exp(−λ·age)`), same-source diminishing (`LLR/(1+n)`), `effectiveEvidence`.
- **`src/lib/maturity.ts`** — the `FRAGMENT → HYPOTHESIS → VALIDATED → REQUIREMENT →
  SPEC_BOUND` gate machine (+ `FALSIFIED` from any state ≤ 0.20).
- **`src/services/claim.service.ts`** — create (canonicalization), attach evidence +
  synchronous recompute + auto-transition, gated transitions with receipts.
- **`src/routes/claims.router.ts` / `src/index.ts`** — `/api/v1/claims…` + `/health`.

Both engines are **pure (no DB/clock)** and unit-tested — `npm test` (20 tests),
including the M-CR1 smoke path (prior 0.5 + T2+T1 support → posterior ≥ 0.8, auto-VALIDATED).

## Deliberate decisions (from the spec validation)
- **Coexist, not supersede** the in-workgraph `rooms`/`Claim` belief layer: Rooms stay
  ephemeral scratch (Beta math, wg-postgres); this registry is the durable
  system-of-record (log-odds, :5437). Only `PROMOTED` claims cross the boundary
  (Beta→log-odds translation) — the promotion intake lands in M-CR3.
- **Canonicalization is fail-LOUD, never a silent fork.** The exact-hash `canonicalKey`
  is the hard dedup guard (works without embeddings). Embedding near-dup is deferred +
  flagged `embeddingDegraded`, because the platform's default embedding path 400s
  (anthropic) and would otherwise make dedup silently fail *open*. Wire the
  `/v1/embeddings` call once a real embedding alias is configured.
- **Prisma standalone** (as speced) — diverges from the raw-`pg` sibling services;
  the M11.e outbox / M11.d receipt / self-registration / IAM patterns are copied
  (their Prisma-flavored variants) rather than imported (none are shared libs).

## M-CR2 (shipped)
Permissive knowledge-event intake (hash-dedup) → transcript **lowering** through the LLM
gateway (`gateway.ts`, model_alias only) → **curation queue** of `LoweringCandidate`s, each
**pre-matched against existing claims by canonicalKey** (the dedup guard) → accept
(create a claim, or attach to the matched one) / reject. `src/lib/lowering.ts` is the pure
parse/validate core (`npm test`); the payload store is an inline stub (MinIO in production).

## M-CR3 (shipped — registry side)
`POST /lookup/resolve` (M11.b, 200/207 so Workgraph can 422 on bad claim refs), the
Rooms→registry **promotion intake** (`POST /promotions`, Beta→log-odds prior via
`betaToLogOdds`), and the **decay-recompute job** (`POST /jobs/decay-recompute`) that
re-derives every ACTIVE posterior with decay applied, emits
`claim.decay.threshold_crossed` when a matured claim slips below its gate (no
auto-demotion — humans decide), and auto-falsifies at ≤ 0.20 (`claim.falsified`).
**Cross-service tail (a workgraph-api PR):** teach Workgraph's `resolver.ts` the
`claim` kind + the `claim.decay`/`claim.falsified` subscription → template review flag.

## M-CR4 (shipped)
The **ambiguity ledger** + the sweeps that fill it + the first **projection**.

- **`src/lib/ambiguity.ts`** — pure detectors (`npm test`): `dedupeKeyFor` (order-independent
  idempotency key), `detectStarvation`, `contradictionLive` / `contradictionSeverity`.
- **Ledger** (`ambiguity.service.ts`) — a queue of surfaced-but-unresolved tensions
  (`CONTRADICTION` / `MISSING_EVIDENCE` / `STARVATION`). Opening is **idempotent** (one OPEN
  row per logical key, code-enforced); closing is a human act (`acknowledge` / `resolve` /
  `dismiss`). The ledger **never** mutates a claim's belief or maturity — it only surfaces.
- **Sweeps** (`sweeps.service.ts`, `POST /jobs/*`) — `contradiction-sweep` (asserted
  `CONTRADICTS` edges where both sides are still believed), `starvation-sweep` (young
  evidence-less claims aged out), and the existing `decay-recompute` now also opens a
  `MISSING_EVIDENCE` ambiguity when a matured claim slips below its gate. `sweep-all` runs
  the lot. **None demote** — humans decide.
- **Relations** (`relation.service.ts`, `POST /claims/:id/relations`) — typed claim-to-claim
  edges, **asserted, never inferred** (no embeddings — the same fail-loud stance). `CONTRADICTS`
  is the contradiction sweep's input.
- **Projection** (`projections.service.ts`, `GET /projections/assumption-register`) — every
  ASSUMPTION claim with its live belief state, evidence balance, and open-ambiguity count,
  riskiest-first. A live query; materialization + the other projections are deferred.

## Deferred (later milestones)
- **M-CR3 cross-service tail** (a workgraph-api PR): teach Workgraph's `resolver.ts` the
  `claim` kind + subscribe `claim.decay`/`claim.falsified` → template review flag.
- More projections (decision-log, requirements-traceability, open-questions) + projection
  materialization; `ClaimMerge`.
- The LISTEN/NOTIFY outbox **dispatcher** (HMAC, 5-attempt retry) and the IAM
  service-token/JWT middleware are copied in during hardening.

## Setup
```
cp .env.example .env    # set DATABASE_URL_CLAIM_REGISTRY (Postgres 5437, extensions vector + pgcrypto)
npm install
npm run prisma:generate
npm run prisma:deploy   # or: npx prisma db push (bare-metal)
npm run dev
```

## Runtime security contract

All `/api/v1` requests require a verified IAM bearer token. The registry derives
the actor from the verified identity and scopes every read and write to the
verified tenant. Legacy `x-user-id` and `x-service-name` headers are not trusted.
Use `x-tenant-id` only when the tenant is present in the verified token's tenant
membership; strict deployments reject ambiguous or missing tenant context.

`/health` is public for liveness checks. Scheduled `/jobs/*` endpoints require a
service-principal bearer token and are intended for the platform scheduler, not
browser users.

Example authenticated request:

```bash
curl -H "Authorization: Bearer $IAM_SERVICE_TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  http://localhost:8600/api/v1/claims
```

For production, set `AUTH_PROVIDER=iam`, `AUTH_OPTIONAL=false`,
`REQUIRE_TENANT_ID=true`, and the IAM URL/token settings from `.env.example`.
