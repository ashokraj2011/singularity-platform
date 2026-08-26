# {{work.id}} — Governed UI exploration

## Authorized target

{{inputs}}

Record the approved environment, exact origin, browser project, viewport, source revision, feature
flags, test-data identity, and Playwright host attestation. Refer to secret names only. Stop if the
browser is redirected outside the approved origin or the environment cannot be identified.

## Observed journeys and states

| Scenario / AC | Actions performed | Observed state | Expected state | Result |
|---|---|---|---|---|
| `[POC:AC-nnn]` | navigation and human-like actions | exact observation | approved expectation | matched/gap/blocked |

Use browser observations to refine the impact map. Do not turn a transient live response into a
product requirement and do not execute destructive or production-like actions without explicit
authorization.

## Accessibility and locator evidence

| Element / state | Role and accessible name | Candidate stable locator | Evidence |
|---|---|---|---|
| Record observed control | role/name/state from snapshot | role, label, or approved test id | MCP record / snapshot |

Prefer accessibility semantics and existing test IDs. Mark CSS structure, generated classes,
coordinates, and XPath as brittle; do not select them simply because they make one run pass.

## Visual and runtime evidence

Inventory each governed MCP call and each durable screenshot, accessibility snapshot, console log,
network summary, trace, or video. Record its repository-relative path and SHA-256/provenance record.
Run `mcp smoke playwright --url <EXACT-APPROVED-URL>` during this generation. The live MCP host's
observed final URL is the navigation receipt; agent-declared navigation records are refused.
Captured `browser_snapshot` output must report a `Page URL` on the same authorized origin.
Redact or exclude secrets and personal data before publication. A screenshot is evidence of one
state at one viewport, not proof of every browser or responsive layout.

## Coverage gaps

List states that were not observed, why they were unavailable, and whether generation may proceed.
Separate application defects, access blockers, environment failures, and unknown expectations.
