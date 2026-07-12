# Approval Authorization

Human decisions are permission-driven. The API does not identify approvers by
role name.

## Policy keys

WorkGraph resolves these environment keys at startup:

| Surface | Configuration | Default permission |
| --- | --- | --- |
| Workflow and WorkItem | `APPROVAL_WORKFLOW_PERMISSION` | `workflow:approve` |
| Agent run review | `APPROVAL_AGENT_PERMISSION` | `agent:approve` |
| Tool execution | `APPROVAL_TOOL_PERMISSION` | `tool:approve_execution` |
| Governance waiver | `APPROVAL_GOVERNANCE_PERMISSION` | `governance:approve` |
| Generated deliverable | `APPROVAL_CONSUMABLE_PERMISSION` | `consumable:approve` |
| Platform administration | `PLATFORM_ADMIN_PERMISSION` | `platform:all` |

Change a mapping with environment configuration when a deployment uses a
different permission catalog. No TypeScript role list needs to change.

## Assigning approvers

1. Create or select a permission in Identity.
2. Open the role that should approve.
3. Grant the matching permission to that role.
4. Assign the role to users, or grant the role on the governed capability in
   IAM.

Local WorkGraph mode resolves `User -> Role -> Permission`. IAM mode calls
`/authz/check` with the configured permission and the approval's capability
scope. IAM failures and unscoped capability approvals fail closed.

## Routing checks

Before a decision is recorded, the API verifies the user, explicit assignee,
team, skill, capability permission, and due date. Direct WorkItem, Agent Run,
Tool Run, Consumable, and Governance Waiver actions use the same authorization
gate as the approval inbox. A pending approval is transitioned atomically so a
second decision cannot win a race.

Seeders create the default permission catalog and local role bindings. Existing
deployments should rerun the WorkGraph seed after upgrading, then review the
resulting grants in Identity.
