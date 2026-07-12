# Durable SDLC Journey

The planner, workflow runtime, and human controls now share a durable server-side spine.

## Planner sessions

`POST /api/planner/converse` creates a `PlannerSession` when `sessionId` is omitted and returns its `sessionId`. Later turns send that id. Every update creates a `PlannerSessionRevision`.

- `GET /api/planner/sessions`
- `GET /api/planner/sessions/:id`
- `PATCH /api/planner/sessions/:id`
- `POST /api/planner/commit` and `POST /api/planner/launch` accept `sessionId`

Sessions are scoped to the authenticated user and tenant. The client can recover an in-progress story after a refresh without trusting browser-only state.

## Dependencies and executable programs

WorkItems can be linked with `BLOCKS` dependencies. The routing boundary rejects cycles and refuses to attach/start a dependent item until all blocking predecessors are `COMPLETED` or `ARCHIVED`.

- `GET /api/work-items/:id/dependencies`
- `POST /api/work-items/:id/dependencies` with `{ predecessorId, dependencyType? }`
- `DELETE /api/work-items/:id/dependencies/:dependencyId`

Work Programs materialize a reusable ordered set of WorkItems and dependencies:

- `POST /api/work-programs`
- `GET /api/work-programs`
- `GET /api/work-programs/:id`
- `POST /api/work-programs/:id/execute` with `{ input }`
- `GET /api/work-programs/:id/runs/:runId`

Use `{{input.path}}` in step title/description templates. Steps with no predecessors route first; later steps are released when their predecessors complete.

## Human approvals

Approval nodes accept `quorumRequired`, `adminOverride`, and `escalationPolicy` in node config. Positive votes stay `PENDING` until the quorum is met. A caller with the configured platform-admin permission may finalize when `adminOverride` is enabled. Rejections and send-backs finalize immediately. Every approver can vote only once.

The same permission and capability-scope checks apply to workflow, governance, agent, tool, consumable, and direct-LLM approvals. A governance waiver cannot bypass the pending approval quorum.

Creating an approval request is also authorized: local deployments require the
surface permission (or the configured platform-admin permission), while IAM
deployments require that permission on the governed capability. The requester
does not automatically become an eligible approver; the request's explicit
user/team/role/skill routing is checked again when a vote is cast.

`escalationPolicy` shape:

```json
{
  "levels": [
    { "teamId": "...", "afterSeconds": 3600 },
    { "skillKey": "release-manager", "afterSeconds": 7200 }
  ]
}
```

The API sweep is controlled by `APPROVAL_ESCALATION_SWEEP_MS` and creates durable notifications for the next audience.

Human rejection and send-back are terminal workflow decisions by default. They
use the runtime failure path with retries disabled, so a retry policy cannot
silently re-run a rejected approval.

## Notifications

Durable notifications are stored in WorkGraph, not only in browser local storage:

- `GET /api/notifications`
- `GET /api/notifications/unread-count`
- `POST /api/notifications/:id/read`
- `POST /api/notifications/:id/resolve`
- `POST /api/notifications/:id/snooze`

The Platform Web notification center merges these with readiness notifications. Approval requests and released dependent WorkItems create actionable entries when a direct user or team audience is known.

## Simulation, checkpoints, and replay

- `POST /api/workflows/:id/simulate`
- `GET /api/workflow-instances/:id/checkpoints`
- `POST /api/workflow-instances/:id/checkpoints`
- `POST /api/workflow-instances/:id/replay` with `{ checkpointId?, mode: "DRY_RUN" | "RESUME" }`

Simulation traverses the published design without executing side effects and reports approval points. Checkpoints capture context and node state. `DRY_RUN` returns a restore preview; `RESUME` is limited to an existing `ACTIVE`, `PAUSED`, or `FAILED` run and records a replay audit row before restarting the runtime.

## Operating rule

Roles do not directly grant approval. They grant the configured permission keys, and the approval request's team, role, skill, capability, due date, quorum, and tenant scope are evaluated together. `PLATFORM_ADMIN_PERMISSION` defaults to `platform:all` and may be changed per deployment.

## Deployment note

The P0 DDL is in `workgraph-studio/apps/api/prisma/migrations/20260712120000_p0_durable_journey/migration.sql`.
Bare-metal setup applies it as idempotent raw SQL after WorkGraph's `prisma db push`,
because supported office/laptop databases may predate Prisma's migration ledger.
Fresh Docker databases continue through the normal migration chain.
