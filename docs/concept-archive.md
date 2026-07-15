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

## Deliberate follow-up work

This slice leaves Pathfinder search, budget enforcement, embeddings, and Yjs
document collaboration for the next increment. The current contracts make
those additions safe: cards have trace/parent/operator metadata, proposals
have an explicit scope and base revision, and archive events provide the
append-only history needed for replay and evidence.
