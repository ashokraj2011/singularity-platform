# Concept Archive

The Concept Archive is the first Creative Studio slice. It gives a team a
tenant-scoped, sparse idea map backed by the existing `SpecificationProject`
root. A `Studio` is a thin identity for exploration surfaces; it does not
replace project specifications, WorkItems, or workflow runs.

## Operating model

1. Stage a concept with a title, summary, evidence, and declared coordinates.
2. A human confirms the coordinates before the card can become an elite.
3. Agent-only candidates may replace agent elites when they exceed the
   configured score margin. Human-authored, pinned, or mixed-authority cells
   create a proposal instead of being displaced automatically.
4. Humans can vote, pin, promote, or kill a cell. Killing a cell creates a
   technical Claim in the project and preserves the reason in archive history.
5. A selected set of current elites can be frozen into a content-hashed
   portfolio. Frozen archives reject new cards and coordinate changes.

## API surface

The authenticated API is mounted at `/api/concept-archive`:

- `GET /studios?projectId=...`
- `POST /studios`
- `GET|POST /studios/:studioId/archives`
- `GET /archives/:archiveId`
- `POST /archives/:archiveId/cards`
- `POST /archives/:archiveId/pathfinder`
- `POST /cards/:cardId/confirm-coords`
- `POST /cards/:cardId/vote`, `/pin`, `/unpin`, `/promote`
- `POST /archives/:archiveId/cells/kill`, `/freeze`, `/recut`
- `GET|POST /studios/:studioId/proposals`
- `POST /proposals/:proposalId/accept`, `/reject`, `/rebase`

All records carry tenant context or are reached through a tenant-scoped
parent. Mutations run through the tenant transaction helper and append an
`ArchiveEvent` plus platform audit/outbox activity. Proposal acceptance is
revision-aware: a stale base revision is marked `STALE` and must be rebased;
it is never silently applied to newer archive axes.

## Budgets, search, and deduplication

Archives carry bounded `budgetConfig` and `budgetUsage` JSON. The defaults are
500 cards, 100 proposals, 1,000 embedding calls, and 200 Pathfinder search
expansions. Budget exhaustion fails closed. These values can be supplied when
an archive is created and are surfaced in the archive response for operator
visibility.

Pathfinder is a deterministic, bounded lexical search over live cards. It
returns matched terms, a composite-score tie breaker, and up to eight parent
card lineage steps. It never calls an LLM and cannot expand beyond the
configured archive budget.

Staging performs lexical duplicate detection by default. If
`CONCEPT_ARCHIVE_EMBEDDING_URL` is configured, the service also requests an
optional embedding using `CONCEPT_ARCHIVE_EMBEDDING_TOKEN` (the token is read
only from the server environment and never stored or returned). Embedding
failure falls back to lexical checks; an explicit `allowDuplicate` flag is
required to stage a near-duplicate.

## Collaboration

Staged cards expose a collaborative notes surface backed by the existing
authenticated Yjs/Studio relay. The relay gives concurrent editors mergeable
notes and presence, while the canonical card body remains changed through the
normal archive API. Relay documents are intentionally ephemeral until a later
durable snapshot policy is introduced; archive decisions and card content are
still persisted and audited in WorkGraph.

Proposal acceptance supports `CREATE`, `UPDATE`, `MUTATE`, `PROMOTE`, and
`SWAP`. Archive-scoped proposals enforce studio ownership, revision fencing,
tenant scope, and the proposal budget on creation, coordinate confirmation,
and rebase.
