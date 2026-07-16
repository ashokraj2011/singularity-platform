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

## Deferred (later milestones)
- M-CR3: `/lookup/resolve` + the Workgraph `claim`-kind resolver case + decay
  subscription + Rooms→registry promotion intake.
- M-CR4: ambiguity ledger + sweeps (decay/contradiction/starvation) + projections.
- The LISTEN/NOTIFY outbox **dispatcher** (HMAC, 5-attempt retry) and the IAM
  service-token/JWT middleware are copied in during M-CR1 hardening.

## Setup
```
cp .env.example .env    # set DATABASE_URL_CLAIM_REGISTRY (Postgres 5437, extensions vector + pgcrypto)
npm install
npm run prisma:generate
npm run prisma:deploy   # or: npx prisma db push (bare-metal)
npm run dev
```
