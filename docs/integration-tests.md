# Workflow-runtime integration tests (real Postgres)

## Why this exists

The workgraph-api unit suite **mocks Prisma**. That means the type-checker + esbuild
are the only things guarding the runtime's hand-written SQL — and they can't see into
a query string. The `text = uuid` regression proved the gap: a `::uuid` cast was added
to `WHERE id = ${x}` on the **TEXT** `workflow_nodes.id` column. It compiled, passed
the mocked tests, shipped to the live stack, and only there did Postgres reject every
affected statement with error `42883` (`operator does not exist: text = uuid`) —
silently breaking `PARALLEL_JOIN` advancement and the timer/stuck sweeps.

`test/workflow-runtime.integration.test.ts` closes that gap: it runs the runtime's
**exact** SQL patterns and a real `startInstance` advance against an **actual**
Postgres. Anything that only breaks against a live DB (type mismatches, JSON operators,
constraint violations, RLS) surfaces here instead of in production.

## What it covers

1. **Raw-SQL regression floor** — runs the exact `$executeRaw` patterns from
   `GraphTraverser` (PARALLEL_JOIN `completed_joins` increment), `StuckRunSweep`
   (per-attempt claim), and `TimerSweep` (single-fire claim) against the real TEXT
   `id` column. A reintroduced `::uuid` (or any `text = uuid`) fails these outright.
2. **End-to-end engine run** — seeds a `START → END` graph and asserts
   `startInstance` drives it to `COMPLETED` against real Postgres.
3. **`it.todo`** — a full `START → [A,B] → PARALLEL_JOIN → END` run to exercise the
   join increment in situ (needs branch node types that complete in-process; finalize
   against a live test DB).

## How it's gated

The suite is wrapped in `describe.runIf(process.env.TEST_DATABASE_URL)`, so it is a
**no-op unless `TEST_DATABASE_URL` is set** — the default `npm test` run (and anyone
without a throwaway DB) skips it cleanly. `startInstance` connects via the app's own
Prisma client, which reads `DATABASE_URL`; set both to the same throwaway DB.

## Running it

### CI (automatic)

The `workgraph-api-integration` job in `.github/workflows/ci.yml` spins up a
`postgres:16` service, applies the schema with `prisma db push`, sets
`DATABASE_URL` = `TEST_DATABASE_URL` = the service URL (plus `JWT_SECRET`), and runs
just this file. No local setup required.

### Locally against a throwaway DB

```bash
cd workgraph-studio/apps/api

# 1. a throwaway Postgres (don't point this at a real workgraph DB — the suite writes/deletes)
docker run --rm -d --name wg-it -e POSTGRES_USER=workgraph -e POSTGRES_PASSWORD=workgraph \
  -e POSTGRES_DB=workgraph_test -p 5499:5432 postgres:16

export DATABASE_URL=postgresql://workgraph:workgraph@localhost:5499/workgraph_test
export TEST_DATABASE_URL=$DATABASE_URL
export JWT_SECRET=test-jwt-secret-min-32-chars-long!

# 2. apply schema, then run the suite
npx prisma db push --skip-generate
npx vitest run test/workflow-runtime.integration.test.ts

docker rm -f wg-it
```

> The default `npm test` script hardcodes `DATABASE_URL=…:5434/test`; this suite skips
> under that run because `TEST_DATABASE_URL` is unset. Set it explicitly (as above) to
> opt in.

## Extending it

- Add a real-SQL assertion here the moment you hand-write a new `$queryRaw` /
  `$executeRaw` in the runtime — that's precisely the code the type-checker can't vet.
- Finish the `it.todo` PARALLEL_JOIN run once the branch node types can complete
  in-process without external services.
- Follow-up: broaden the CI job from this one file to the full vitest suite once the
  ~80 existing tests are vetted for a clean-DB CI run (today they only ran locally
  against `:5434`).
