# @agentandtools/agent-runtime — deterministic light world model

> Generated 26 August 2026 (2026-08-26T06:24:43.267Z) · source `de85b24340d8f72eacf0f9b19ba6ce36806afdf2` · branch `sflow/govern/singularity-platform-de85b243`

## Repository shape

- Files indexed: 2753
- Source-like files: 2193
- Test-like files: 580
- Build manifests: 56
- Deployment/operations files: 5
- Languages: TypeScript (1750), Python (375), Shell (59), JavaScript (9)
- Top-level areas: workgraph-studio (912), agent-and-tools (772), context-fabric (276), mcp-server (171), singularity-code-foundry (137), singularity-iam-service (86), docs (85), bin (83), audit-governance-service (67), claim-registry (50)

## Facts {#core.facts}

<!-- singularity-flow:repository-facts:start -->
```yaml
# Derived from the repository, not inferred. Every path and line is checkable.
files: 2753
languages_scanned: 1773
frameworks: [Electron, Express, Next.js, Prisma, React, Tailwind CSS, TypeScript, Vite, Vitest, esbuild]
entrypoints:
  - { path: clients/singularity-desktop/src/main.js, declared: main, at: "clients/singularity-desktop/package.json:6" }
  - { path: singularity-code-foundry/apps/code-foundry-api/src/cli/index.ts, declared: bin, at: "singularity-code-foundry/apps/code-foundry-api/package.json:19" }
  - { path: singularity-code-foundry/packages/feature-flags/src/index.ts, declared: main, at: "singularity-code-foundry/packages/feature-flags/package.json:6" }
  - { path: singularity-desktop/electron/main.cjs, declared: main, at: "singularity-desktop/package.json:6" }
  - { path: workgraph-studio/packages/engine/src/index.ts, declared: main, at: "workgraph-studio/packages/engine/package.json:6" }
  - { path: workgraph-studio/packages/shared-types/src/index.ts, declared: main, at: "workgraph-studio/packages/shared-types/package.json:5" }
  - { path: workgraph-studio/packages/vm/src/index.ts, declared: main, at: "workgraph-studio/packages/vm/package.json:6" }
commands:
  - { run: "npm run dev", at: "agent-and-tools/apps/agent-runtime/package.json:5" }
  - { run: "npm run build", at: "agent-and-tools/apps/agent-runtime/package.json:6" }
  - { run: "npm run start", at: "agent-and-tools/apps/agent-runtime/package.json:7" }
  - { run: "npm run pretest:contracts", at: "agent-and-tools/apps/agent-runtime/package.json:8" }
  - { run: "npm run test:contracts", at: "agent-and-tools/apps/agent-runtime/package.json:9" }
  - { run: "npm run prisma:generate", at: "agent-and-tools/apps/agent-runtime/package.json:10" }
  - { run: "npm run prisma:migrate", at: "agent-and-tools/apps/agent-runtime/package.json:11" }
  - { run: "npm run prisma:dev", at: "agent-and-tools/apps/agent-runtime/package.json:12" }
  - { run: "npm run prisma:seed", at: "agent-and-tools/apps/agent-runtime/package.json:13" }
  - { run: "npm run dev", at: "agent-and-tools/apps/agent-service/package.json:5" }
  - { run: "npm run build", at: "agent-and-tools/apps/agent-service/package.json:6" }
  - { run: "npm run start", at: "agent-and-tools/apps/agent-service/package.json:7" }
# What the rest of the repository depends on. A count, not an impression.
most_depended_on:
  - { path: workgraph-studio/apps/api/src/lib/prisma.ts, imported_by: 182 }
  - { path: workgraph-studio/apps/api/src/lib/tenant-db-context.ts, imported_by: 128 }
  - { path: workgraph-studio/apps/api/src/lib/errors.ts, imported_by: 100 }
  - { path: workgraph-studio/apps/api/src/lib/audit.ts, imported_by: 83 }
  - { path: workgraph-studio/apps/api/src/config.ts, imported_by: 77 }
  - { path: workgraph-studio/apps/web/src/lib/api.ts, imported_by: 65 }
  - { path: workgraph-studio/apps/api/src/middleware/validate.ts, imported_by: 57 }
  - { path: mcp-server/src/config.ts, imported_by: 46 }
# Commits touching each file in the last year, from Git history.
most_changed:
  - { path: docs/platform-gap-audit-2026-07-18.md, commits: 149 }
  - { path: docs/platform-handbook.md, commits: 139 }
  - { path: workgraph-studio/apps/api/src/modules/blueprint/blueprint.router.ts, commits: 122 }
  - { path: docs/platform-handbook.html, commits: 99 }
  - { path: bin/bare-metal.sh, commits: 93 }
  - { path: docker-compose.yml, commits: 92 }
  - { path: context-fabric/services/context_api_service/app/execute.py, commits: 87 }
  - { path: workgraph-studio/apps/api/prisma/schema.prisma, commits: 80 }
# 3284 exported top-level declarations; the most-depended-on files' are listed.
key_symbols:
  - { name: config, kind: binding, at: "workgraph-studio/apps/api/src/config.ts:298" }
  - { name: logEvent, kind: function, at: "workgraph-studio/apps/api/src/lib/audit.ts:29" }
  - { name: createReceipt, kind: function, at: "workgraph-studio/apps/api/src/lib/audit.ts:65" }
  - { name: publishOutbox, kind: function, at: "workgraph-studio/apps/api/src/lib/audit.ts:78" }
  - { name: AppError, kind: class, at: "workgraph-studio/apps/api/src/lib/errors.ts:1" }
  - { name: NotFoundError, kind: class, at: "workgraph-studio/apps/api/src/lib/errors.ts:17" }
  - { name: ForbiddenError, kind: class, at: "workgraph-studio/apps/api/src/lib/errors.ts:28" }
  - { name: ConflictError, kind: class, at: "workgraph-studio/apps/api/src/lib/errors.ts:35" }
  - { name: ValidationError, kind: class, at: "workgraph-studio/apps/api/src/lib/errors.ts:42" }
  - { name: prisma, kind: binding, at: "workgraph-studio/apps/api/src/lib/prisma.ts:16" }
  - { name: currentTenantDbContext, kind: function, at: "workgraph-studio/apps/api/src/lib/tenant-db-context.ts:19" }
  - { name: currentTenantIdForDb, kind: function, at: "workgraph-studio/apps/api/src/lib/tenant-db-context.ts:23" }
  - { name: currentTraceIdForRequest, kind: function, at: "workgraph-studio/apps/api/src/lib/tenant-db-context.ts:27" }
  - { name: currentTenantDbClient, kind: function, at: "workgraph-studio/apps/api/src/lib/tenant-db-context.ts:31" }
  - { name: runWithTenantDbContext, kind: function, at: "workgraph-studio/apps/api/src/lib/tenant-db-context.ts:35" }
  - { name: tenantDbContextMiddleware, kind: function, at: "workgraph-studio/apps/api/src/lib/tenant-db-context.ts:69" }
  - { name: withTenantDbTransaction, kind: function, at: "workgraph-studio/apps/api/src/lib/tenant-db-context.ts:77" }
  - { name: workgraphApiPath, kind: function, at: "workgraph-studio/apps/web/src/lib/api.ts:15" }
  - { name: api, kind: binding, at: "workgraph-studio/apps/web/src/lib/api.ts:20" }
tests: 580
```
<!-- singularity-flow:repository-facts:end -->

## Likely entry points

- `agent-and-tools/apps/agent-runtime/Dockerfile`
- `agent-and-tools/apps/agent-runtime/package.json`
- `agent-and-tools/apps/agent-runtime/src/app.ts`
- `agent-and-tools/apps/agent-runtime/src/server.ts`
- `agent-and-tools/apps/agent-service/Dockerfile`
- `agent-and-tools/apps/agent-service/package.json`
- `agent-and-tools/apps/agent-service/src/index.ts`
- `agent-and-tools/apps/prompt-composer/Dockerfile`
- `agent-and-tools/apps/prompt-composer/package.json`
- `agent-and-tools/apps/prompt-composer/src/app.ts`
- `agent-and-tools/apps/prompt-composer/src/server.ts`
- `agent-and-tools/package.json`
- `agent-and-tools/packages/shared/package.json`
- `agent-and-tools/packages/shared/src/embeddings/index.ts`
- `agent-and-tools/packages/shared/src/index.ts`

## Observed commands

- `npm run build`
- `npm run db:init`
- `npm run dev`
- `npm run docker:down`
- `npm run docker:up`
- `npm run posttest:contracts`
- `npm run pretest:contracts`
- `npm run prisma:dev`
- `npm run prisma:generate`
- `npm run prisma:migrate`
- `npm run prisma:seed`
- `npm run seed`
- `npm run start`
- `npm run test`
- `npm run test:contracts`
- `npm run test:coverage`

## Grounding boundary

This model was generated locally without Copilot or another AI model and consumed **zero model tokens**. It intentionally records only deterministic repository metadata. It does not claim runtime behavior, business meaning, ownership, security, test coverage, or architectural intent. Deeper phases can replace it with a quick, standard, or deep model when semantic analysis is worth the token cost.
