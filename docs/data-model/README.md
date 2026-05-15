# Singularity Platform — Data Model

> Canonical data-model documentation. **Start with [`00-platform-overview.md`](./00-platform-overview.md)** for the cross-DB picture; drill into per-DB ERDs from there.

## Index

| # | DB | Owner | Models | Diagram |
|---|---|---|---|---|
| **00** | (all 5 DBs) | — | join-key map | **[Platform overview →](./00-platform-overview.md)** |
| 01 | `singularity_iam` | `singularity-iam-service` | 20 | [IAM](./01-iam.md) |
| 02 | `singularity` | `agent-runtime` | 25 | [agent-runtime](./02-agent-runtime.md) · [PNG](./02-agent-runtime.png) |
| 03a | `singularity_composer` | `prompt-composer` (OWNED) | 6 | [composer-owned](./03-prompt-composer-owned.md) · [PNG](./03-prompt-composer-owned.png) |
| 03b | `singularity` | `prompt-composer` (READ-only) | 12 | [composer-runtime-read](./03-prompt-composer-runtime-read.md) · [PNG](./03-prompt-composer-runtime-read.png) |
| 04 | `workgraph` | `workgraph-studio/apps/api` | 76 | [workgraph](./04-workgraph.md) |
| 05 | `audit_governance` | `audit-governance-service` | 11 | [audit-gov](./05-audit-gov.md) |
| 06 | `singularity` (schema `tool.*`) | `tool-service` | 8 | [tool-service](./06-tool-service.md) |

**Total**: 158 models / tables across 5 Postgres databases.

## Generation policy

| Diagram | Source | How updated |
|---|---|---|
| 00 (platform overview) | hand-written | manual edit when new cross-DB UUID flow is added |
| 02 (agent-runtime) | `agent-and-tools/apps/agent-runtime/prisma/schema.prisma` | **auto** — emitted by `prisma generate` via `prisma-erd-generator` |
| 03a (composer-OWNED) | `agent-and-tools/apps/prompt-composer/prisma/schema.prisma` | **auto** |
| 03b (composer-runtime-read) | `agent-and-tools/apps/prompt-composer/prisma/runtime-read.prisma` | **auto** |
| 04 (workgraph) | `workgraph-studio/apps/api/prisma/schema.prisma` | **auto** (markdown only — 76 models would be illegible as PNG) |
| 01 (IAM) | `singularity-iam-service/app/models.py` | hand — edit when SQLAlchemy models change |
| 05 (audit-gov) | `audit-governance-service/db/init.sql` | hand |
| 06 (tool-service) | `agent-and-tools/packages/db/init.sql` (schema `tool.*`) | hand |

## CI drift gate

The `data-model-drift` job in `.github/workflows/ci.yml` re-runs `prisma generate` for each of the 4 Prisma schemas and asserts the committed ERD files in this folder are byte-identical. A PR that changes a Prisma schema without re-running `prisma generate` fails red with the file path of the stale diagram.

The hand-written diagrams (01, 05, 06) are NOT drift-checked. They cover schemas that change rarely (last meaningful change to audit-gov was the audit_events table; tool-service hasn't changed shape in a year). When you do change them, update the corresponding `.md` file in the same PR.

## Regenerating after a schema change

```bash
# All 4 Prisma services in one go (run from repo root)
( cd agent-and-tools/apps/agent-runtime \
  && DATABASE_URL=postgresql://ashokraj:postgres@localhost:5432/singularity \
     npx prisma generate )

( cd agent-and-tools/apps/prompt-composer \
  && DATABASE_URL=postgresql://ashokraj:postgres@localhost:5432/singularity_composer \
     npx prisma generate --schema=prisma/schema.prisma )

( cd agent-and-tools/apps/prompt-composer \
  && DATABASE_URL_RUNTIME_READ=postgresql://ashokraj:postgres@localhost:5432/singularity \
     npx prisma generate --schema=prisma/runtime-read.prisma )

( cd workgraph-studio/apps/api \
  && DATABASE_URL=postgresql://ashokraj:postgres@localhost:5434/workgraph \
     npx prisma generate )
```

Then `git diff docs/data-model/` should show whatever your schema change produced. Commit both the schema + the regenerated ERD in the same PR.
