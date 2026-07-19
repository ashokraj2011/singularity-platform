# Business metric vocabulary — implementation plan

Grounded design for ask #3 ("Objectives, bidirectional coverage, target metric
should be dropdowns; screens for that metadata are also needed").

Written from a read of the actual schema and routers, not from assumption. It is
smaller than it first looks, because **most of the admin surface already exists
and is kind-generic** — but it also contains one thing that is genuinely a
migration, not a dropdown.

## What is true today

- `BusinessObjective.targetMetric` is `Json @default("{}")`
  (`prisma/schema.prisma:1546`). Shape is enforced **only** by Zod at
  `business-alignment.router.ts:38-44`: `{name, baseline?, target, unit?, byDate?}`.
  No enum, no FK, no catalog.
- The UI renders it as two bare `<input>`s — "Target metric" / "Target value"
  (`BusinessAlignmentScreen.tsx:119`).
- **"Bidirectional coverage" is computed and never stored** —
  `detectObjectiveCoverage` (`business-alignment/business-alignment.ts:23`) emits
  THREE codes: `ACTIVE_OBJECTIVE_UNSERVED`, `REQUIREMENT_WITHOUT_OBJECTIVE`, and
  `UNKNOWN_OBJECTIVE_REFERENCE` (error). It gates spec lock.
- Correction to an earlier reading: the detector is **sound**. It already catches
  dangling refs, and `coveragePercent` counts only objectives that real
  requirements serve, so a dangling ref cannot inflate the number. Phase 3 is not
  about fixing broken math.
- The objective↔requirement link is **string ids inside
  `ProjectSpecification.package` JSON** (`requirement.objectiveRefs`). No join
  table, no referential integrity.

## The lever: MetadataDefinition is already the right table

`MetadataDefinition` (`schema.prisma:3312`) is a generic, versioned, scoped
vocabulary: `kind + key + version + scopeType + scopeId`, plus
`label / description / icon / color / category` and five JSON columns
(`schema, defaults, policy, ui, compatibility`).

Its CRUD router (`metadata/metadata.router.ts`) is **kind-generic** — every
handler works for any kind. The only thing narrowing it is a hardcoded literal
array at `metadata.router.ts:10` duplicating the Prisma enum.

So the "screens for this metadata" half of the ask is **mostly already built**
(`WorkgraphRegistryConsole.tsx`, `MetadataRegistryPage.tsx`). It needs a new kind,
not a new subsystem.

## Phase 1 — the catalog (small)

1. `MetadataDefinitionKind` (`schema.prisma:329`) gains `BUSINESS_METRIC`.
   Timestamped migration; additive enum value, so no backfill.
2. `metadata.router.ts:10` — add `'BUSINESS_METRIC'` to the `kinds` array. This
   is the duplication that makes step 1 insufficient on its own; miss it and the
   API silently filters the new kind out of every query.
3. A definition carries, in `schema`/`ui`: `unit`, `direction`
   (`HIGHER_IS_BETTER` | `LOWER_IS_BETTER`), and optionally a default baseline.
   `direction` is the field that makes a metric interpretable — "churn 5%" is
   good or bad depending on it, and nothing records that today.
4. Confirm the existing registry console lists the new kind without a change. If
   it hardcodes a kind list of its own, it needs the same one-line addition.

## Phase 2 — reference it from objectives (small)

5. `targetMetric` gains an **optional `metricKey`**. Deliberately a soft key, not
   a FK: `targetMetric` is JSON and the catalog is versioned + scoped, so a
   relational constraint does not fit. More importantly, a soft key lets every
   existing free-text objective keep working.
6. Router validation: when `metricKey` is present it must resolve to an ACTIVE
   definition; `unit` and `direction` fill from the catalog when the caller omits
   them. When absent, today's free-text path is untouched.
7. UI: "Target metric" becomes a `<select>` over the catalog **with a free-text
   fallback**. A closed dropdown on day one would block anyone whose metric is not
   yet catalogued, which is how teams end up putting the real metric in the
   rationale field.

## Phase 3 — coverage integrity (this is the migration)

**This is the part that is not a dropdown**, and it is narrower than "the
detector is broken" — it is not. The detector is correct. What is missing is
everything *around* the link, because it lives as string ids in a JSON blob:

1. **Errors surface far from the edit that caused them.** Detection happens at
   READ time. A spec package saves happily with a dangling `objectiveRef`;
   nothing objects until someone opens coverage or attempts a lock — by which
   point the person who broke it has moved on. Deleting an objective silently
   dangles every reference to it, with no warning at the point of deletion.
2. **The link is unqueryable.** "Which requirements serve this objective?"
   cannot be answered without loading and scanning every spec package's JSON.
   That rules out objective-centric views, and it is why coverage must be
   recomputed in full on every call rather than read.
3. **No history.** There is no record of when a requirement was linked to or
   unlinked from an objective, so a coverage regression cannot be traced to a
   change.

Options, in increasing cost:

- **(a) Validate on write.** Reject a spec package whose `objectiveRefs` do not
  all resolve, and warn when deleting an objective that requirements reference.
  Fixes (1) only. Cheapest by a wide margin; no migration, no backfill.
- **(b) Add a join table** `ObjectiveRequirementLink(objectiveId, requirementKey,
  specificationVersionId)` written alongside the package, with a real FK to the
  objective. Coverage reads the table. Fixes (1), (2) and (3). Needs a backfill
  from existing packages, and the package JSON stays the source of truth for the
  requirement text, so the two must be written transactionally or they drift.
- **(c) Promote requirements out of JSON entirely.** Correct long-term, far
  beyond this ask.

Recommendation: **(a) now, (b) only when something depends on querying the link.**
Do not do (c) as part of this. (b) buys integrity and queryability but introduces
a dual-write between the table and the package JSON — a real risk that is only
worth taking once a feature actually needs the query.

## Sequencing

Phase 1 → 2 are independently shippable and low-risk; the dropdown lands after
phase 2. Phase 3 is a separate decision and should not be bundled — it changes
what spec lock means.

## Verification checklist

- `prisma migrate diff` DB-free for the enum migration
- `tsc --noEmit` in `workgraph-studio/apps/api` and `agent-and-tools/web`
- a router test that `BUSINESS_METRIC` survives the `kinds` filter (the failure
  mode in step 2 is silent)
- a test that an objective with no `metricKey` still validates unchanged
