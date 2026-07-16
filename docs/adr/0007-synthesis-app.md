# ADR 0007: Synthesis — a unified pre-development front-end

## Status

Accepted (v1 implemented). Front-end only; no new backend contracts or
migrations. Lives in `platform-web` (`agent-and-tools/web`) as the `/synthesis`
route group.

## Context

The pre-development journey — **capture ideas → reduce unknowns → validate
assumptions → converge a spec → generate tickets** — is already fully supported
by the platform backend, but through several separate surfaces:

- `/studio/:projectId` (rooms/claims/probes, project specification),
- the Work Item IDE (`/workflows/work/workitem/:id`),
- discovery panels, and portfolio/dashboards.

A folder of 12 high-fidelity mockups (the "Ethos & Form" design language)
described one polished product for this journey, inconsistently branded
("Concept Studio" / Nexus / Blueprint / Kinetic). The gap was **cohesion and
brand**, not backend capability.

## Decision

Ship **Synthesis**: a single, brand-consistent front-end product for the
pre-development journey, built on the *existing* project-scoped APIs. One brand
name ("Synthesis") replaces the mockups' inconsistent naming.

### Scope & data model

Synthesis is **project-centric**, so it anchors on the project-scoped epistemic
layer that already exists rather than on discovery sessions (which are only
scoped to `WORKFLOW_STAGE | WORK_ITEM | RUN`, never to a project). This avoided
any new scope type or migration:

| Concept in Synthesis | Backing (existing) API |
|---|---|
| Idea / assumption | a **claim** in a room (`claimType` Market/User/Operational/Technical) carrying a Beta posterior (`mean` = P(true), `disagreement` = estimator variance = where the ignorance is) |
| Reduce unknowns | contested-ranked claims + **probes** + per-room **convergence** |
| Spec | project **specification** package (analysis / requirements / decisions) |
| Tickets | deep-link to Studio work-program generation |
| Portfolio / use cases | `/studio/portfolio` + `/studio/projects` |

### Screens (eight)

Workspace Hub, System Overview, Idea Wall, Discovery Board, Assumption Rooms,
Spec & Traceability, Logic Console, Use-Case Registry. Each is wired to real
endpoints via `workgraphFetch` + SWR. Derived views (traceability pipeline,
consistency signals, use-case maturity, dashboard metrics, activity feed) are
computed **client-side** over those APIs — no dedicated aggregation endpoints
were added for v1.

### Theming

The Ethos tokens (warm Sand/Charcoal/Sage) are added to `tailwind.config.ts` as
color utilities that resolve to `var(--syn-*, <hex fallback>)`. The `--syn-*`
variables are defined **only** under `.synthesis-root` (in `synthesis.css`), so
the utilities are inert everywhere else and cannot collide with the rest of
platform-web. Synthesis renders full-bleed (added to `FULL_BLEED_PREFIXES`) with
its own chrome (`SynthesisShell`).

## Consequences

- **No new backend / no migration.** Synthesis runs against the platform as-is.
- Consistency/traceability/maturity are heuristics over existing data (see
  `src/components/synthesis/logic.ts`, unit-tested in `logic.contract.test.ts`).
  If richer, server-authoritative aggregation is later required, add endpoints
  behind the same hooks without changing the screens.
- Studio and the Work Item IDE remain as the deep authoring surfaces; Synthesis
  is the unifying front door and does not replace them.

## Alternatives considered

- **Add project-scoped discovery sessions** + five aggregation endpoints (ideas,
  traceability graph, conflict detection, use-case aggregation, dashboard).
  Deferred: it required schema/enum changes and a migration for functionality
  that the project-scoped claim/spec/portfolio APIs already provide client-side.
