#!/usr/bin/env python3
"""Fail if known sensitive Workgraph surfaces lose strict tenant guards.

This is intentionally small and explicit. It does not try to prove all future
authorization logic from ASTs; it guards the routes that have already been
classified as tenant-sensitive so refactors cannot silently remove their
fail-closed checks. It also keeps a tenant-policy ledger for every mounted
Workgraph API route so new surfaces cannot appear without an explicit
tenant-scope decision.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]


ROUTE_POLICY_CATEGORIES = {
    "admin_global",
    "authenticated_catalog",
    "capability_scoped_authz",
    "event_signed_ingress",
    "external_proxy_authenticated",
    "iam_control_plane",
    "internal_tenant_scoped_service_token",
    "public_auth_surface",
    "tenant_scoped_runtime",
}


# Key format is "<mount path> <router variable>" because Express intentionally
# mounts several routers at the same path. The value is "<category>: <reason>".
ROUTE_TENANT_POLICIES: dict[str, str] = {
    "/api/auth authRouter": "public_auth_surface: login/token exchange; tenant is established by IAM/session claims, not a Workgraph row",
    "/api/internal/artifacts internalArtifactFetchRouter": "internal_tenant_scoped_service_token: prompt-composer bounded artifact reads; strict mode requires tenant-scoped service token and document ownership",
    "/api/users usersRouter": "iam_control_plane: IAM-owned identity data; Workgraph tenant filters do not own this surface",
    "/api/teams teamsRouter": "iam_control_plane: IAM-owned team data; Workgraph tenant filters do not own this surface",
    "/api/identity identitySyncRouter": "iam_control_plane: IAM sync facade; scoped by IAM authz rather than Workgraph tenant rows",
    "/api/roles rolesRouter": "iam_control_plane: IAM-owned role data; Workgraph tenant filters do not own this surface",
    "/api/skills skillsRouter": "iam_control_plane: IAM-owned skill metadata; Workgraph tenant filters do not own this surface",
    "/api/permissions permissionsRouter": "iam_control_plane: IAM-owned permission metadata; Workgraph tenant filters do not own this surface",
    "/api/workflow-templates workflowTemplatesRouter": "authenticated_catalog: workflow template catalog is tenant-neutral in v1 and capability-scoped by template metadata/IAM policy",
    "/api/workflows workflowTemplatesRouter": "authenticated_catalog: compatibility alias for workflow templates; tenant-neutral in v1",
    "/api/workflow-instances workflowInstancesRouter": "tenant_scoped_runtime: workflow instances carry tenantId/context and strict mode asserts tenant on run access",
    "/api/workflow-instances insightsRouter": "tenant_scoped_runtime: run insight/evidence routes assert workflow instance tenant before returning runtime evidence",
    "/api/workflow-triggers triggersRouter": "authenticated_catalog: trigger definitions are template/capability metadata in v1; not workflow-instance data",
    "/api/custom-node-types customNodeTypesRouter": "authenticated_catalog: designer node type catalog; tenant-neutral in v1",
    "/api/workflow-nodes/:nodeId/workbench workbenchDefinitionsRouter": "tenant_scoped_runtime: workbench definitions are node-owned runtime/design artifacts and strict mode asserts workflow-node tenant",
    "/api/triggers/webhook webhookRouter": "event_signed_ingress: unauthenticated webhook receiver is secret-gated by trigger configuration",
    "/api/tasks tasksRouter": "authenticated_catalog: task taxonomy/configuration surface; tenant-neutral in v1",
    "/api/metadata-definitions metadataDefinitionsRouter": "authenticated_catalog: metadata definition catalog; tenant-neutral in v1",
    "/api/work-item-routing-policies workItemRoutingPoliciesRouter": "capability_scoped_authz: routing rules are capability-scoped and protected by authenticated operator policy",
    "/api/work-item-triggers workItemTriggersRouter": "capability_scoped_authz: work-item triggers are capability-scoped configuration",
    "/api/work-items workItemLaptopRouter": "capability_scoped_authz: laptop-specific WorkItem actions use user/device ownership and WorkItem visibility checks",
    "/api/work-items workItemsRouter": "capability_scoped_authz: WorkItems are capability/target scoped with per-user visibility checks; no Workgraph tenant row in v1",
    "/api/planner plannerRouter": "capability_scoped_authz: planner creates capability-targeted WorkItems and clamps tasks to allowed capabilities",
    "/api/governance governanceRouter": "capability_scoped_authz: governance resolution is keyed by governed capability",
    "/api/laptop-invocations laptopInvocationsRouter": "capability_scoped_authz: laptop invocation records are protected by authenticated user/device routing",
    "/api/questions laptopQuestionsRouter": "capability_scoped_authz: laptop clarification questions are protected by authenticated user/device routing",
    "/api/approvals approvalsRouter": "tenant_scoped_runtime: approval requests link to workflow instances/nodes and strict mode asserts tenant",
    "/api/consumable-types consumableTypesRouter": "authenticated_catalog: consumable type catalog; tenant-neutral in v1",
    "/api/consumables consumablesRouter": "tenant_scoped_runtime: consumables link to workflow instances and strict mode asserts tenant",
    "/api/agents agentsRouter": "authenticated_catalog: Workgraph agent catalog/proxy; tenant-neutral in v1 while agent-runtime owns profile tenancy",
    "/api/agent-runs agentRunsRouter": "tenant_scoped_runtime: AgentRuns link to workflow instances and strict mode asserts tenant",
    "/api/tools toolsRouter": "authenticated_catalog: tool catalog/discovery metadata; invocations are governed elsewhere",
    "/api/tool-runs toolRunsRouter": "tenant_scoped_runtime: ToolRun approval/read surfaces link to workflow instances and strict mode asserts tenant",
    "/api/tool-registry toolRegistryRouter": "authenticated_catalog: embedded tool registry metadata; tenant-neutral in v1",
    "/api/audit auditRouter": "external_proxy_authenticated: audit timeline proxy is authenticated and keyed by trace/correlation inputs",
    "/api/engine curationRouter": "external_proxy_authenticated: audit-governance curation proxy; protected by auth and upstream policy",
    "/api/connectors connectorsRouter": "authenticated_catalog: connector catalog/configuration metadata; tenant-neutral in v1",
    "/api/artifact-templates artifactTemplatesRouter": "authenticated_catalog: artifact template catalog; tenant-neutral in v1",
    "/api/blueprint blueprintRouter": "capability_scoped_authz: Blueprint Workbench sessions are capability/workflow scoped through authenticated APIs",
    "/api/event-horizon eventHorizonRouter": "capability_scoped_authz: Event Horizon chat is governed by selected capability and user auth",
    "/api/llm-routing llmRoutingRouter": "admin_global: LLM routing policy is platform-level configuration",
    "/api/codegen codegenRouter": "tenant_scoped_runtime: code generation specs, runs, artifacts, gaps, patch tasks, and receipts carry tenantId and strict mode requires tenant context",
    "/api/contracts contractsRouter": "external_proxy_authenticated: immutable contract replay/lookup is authenticated and evidence-keyed",
    "/api/documents documentsRouter": "tenant_scoped_runtime: documents link to workflow instances and strict mode asserts tenant",
    "/api/runtime runtimeRouter": "tenant_scoped_runtime: runtime inbox aggregates tenant-sensitive work rows under tenant-scoped DB context",
    "/api/runs snapshotsRouter": "tenant_scoped_runtime: browser run snapshots carry tenantId and strict mode filters snapshot reads/writes by tenant",
    "/api/runs codeChangesRouter": "tenant_scoped_runtime: code-change reads assert workflow tenant or fail closed when unscoped",
    "/api/llm llmModelsRouter": "authenticated_catalog: model catalog metadata; provider credentials remain outside Workgraph",
    "/api/notify notifyRouter": "capability_scoped_authz: notifications are authenticated operator/user actions",
    "/api/lookup lookupRouter": "external_proxy_authenticated: federated reference lookup forwards the caller identity to source services",
    "/api/agent-studio agentStudioRouter": "capability_scoped_authz: Agent Studio facade applies capability/profile governance in agent-runtime",
    "/api/receipts receiptsRouter": "tenant_scoped_runtime: receipt timelines merge tenant-filtered Workgraph runtime receipts with external trace receipts",
    "/api/events/subscriptions eventSubscriptionsRouter": "admin_global: event-bus subscription registry is platform-level configuration",
    "/api/events/incoming incomingEventsRouter": "event_signed_ingress: cross-service event receiver is HMAC signature gated",
    "/api/admin/feature-flags featureFlagsRouter": "admin_global: strict mode requires admin for global feature-flag reads/writes",
    "/api/internal/feature-flags internalFeatureFlagsRouter": "internal_tenant_scoped_service_token: service-token read mirror requires tenant-scoped internal token in strict mode",
}


REQUIRED_MARKERS: dict[str, list[str]] = {
    "workgraph-studio/apps/api/src/lib/tenant-isolation.ts": [
        "export function requireTenantFromRequest",
        "export function requireTenantScopedInternalToken",
        "export async function assertWorkflowInstanceTenant",
        "export async function assertAgentRunTenant",
        "export async function assertToolRunTenant",
        "export async function assertApprovalRequestTenant",
        "export async function assertConsumableTenant",
        "export async function assertDocumentTenant",
        "export async function assertWorkflowNodeTenant",
    ],
    "workgraph-studio/apps/api/src/lib/tenant-db-context.ts": [
        "export function currentTenantDbClient",
        "export async function withTenantDbTransaction",
        "select set_config('app.tenant_id'",
        "TENANT_ISOLATION_MODE=strict requires tenant context",
    ],
    "workgraph-studio/apps/api/src/lib/prisma.ts": [
        "currentTenantDbClient",
        "new Proxy(basePrisma",
    ],
    "workgraph-studio/apps/api/src/modules/workflow/instances.router.ts": [
        "assertWorkflowInstanceTenant",
        "assertPendingExecutionTenant",
        "withTenantDbTransaction",
        "TENANT_ISOLATION_MODE=strict requires tenantId/tenant_id",
        "TENANT_ISOLATION_MODE=strict requires X-Tenant-Id or tenant_id when listing workflow instances",
    ],
    "workgraph-studio/apps/api/src/modules/workflow/insights.router.ts": [
        "assertWorkflowInstanceTenant(req, id)",
        "withTenantDbTransaction",
        "traceIdsForInstance",
        "buildInsightsResponse",
        "traceIdsByNodeForInstance",
    ],
    "workgraph-studio/apps/api/src/modules/workflow/workbench-definitions.router.ts": [
        "withTenantDbTransaction",
        "runTenantScoped",
        "service.getDefinition",
        "service.patchDefinition",
        "service.createStage",
        "service.reorderStages",
    ],
    "workgraph-studio/apps/api/src/modules/workflow/workbench-definitions.service.ts": [
        "Promise.all(",
        "prisma.workbenchStage.update",
    ],
    "workgraph-studio/apps/api/src/modules/tool/tool-runs.router.ts": [
        "assertToolRunTenant",
        "withTenantDbTransaction",
        "requireTenantFromRequest(req, 'pending tool-run approval')",
    ],
    "workgraph-studio/apps/api/src/modules/tool/tools.router.ts": [
        "withTenantDbTransaction",
        "requireTenantFromRequest(req, 'tool-run request')",
        "TENANT_ISOLATION_MODE=strict requires instanceId when requesting a tool run",
    ],
    "workgraph-studio/apps/api/src/modules/audit/receipts.router.ts": [
        "withTenantDbTransaction",
        "requireTenantFromRequest(req, 'receipt timeline')",
        "localReceipts(traceId, tenantId)",
        "wi.\"tenantId\" = ${tenantId ?? null}",
    ],
    "workgraph-studio/apps/api/src/modules/runtime/code-changes.router.ts": [
        "assertWorkflowInstanceTenant(req, runId)",
        "withTenantDbTransaction",
        "requireTenantFromRequest(req, 'code-change read')",
        "prisma.runSnapshot.findFirst({ where: { runId, tenantId }",
    ],
    "workgraph-studio/apps/api/src/modules/runtime/snapshots.router.ts": [
        "withTenantDbTransaction",
        "requireTenantFromRequest(req, 'run snapshot write')",
        "requireTenantFromRequest(req, 'run snapshot read')",
        "requireTenantFromRequest(req, 'run snapshot listing')",
        "requireTenantFromRequest(req, 'run snapshot delete')",
        "Tenant isolation is strict but this run snapshot has no tenantId",
    ],
    "workgraph-studio/apps/api/src/modules/runtime/runtime.router.ts": [
        "withTenantDbTransaction",
        "requireTenantFromRequest(req, 'runtime inbox')",
        "prisma.task.findMany",
        "prisma.approvalRequest.findMany",
        "prisma.consumable.findMany",
        "prisma.workflowInstance.findMany",
        "prisma.workflowNode.findMany",
    ],
    "workgraph-studio/apps/api/src/modules/codegen/codegen.router.ts": [
        "requireTenantFromRequest(req, 'code generation')",
        "resolveTenantFromRequest(req)",
        "tenantWhere(req)",
        "tenantId: args.tenantId ?? null",
        "where: { id: req.params.runId, ...tenantWhere(req) }",
    ],
    "workgraph-studio/apps/api/src/modules/agent/agent-runs.router.ts": [
        "assertAgentRunTenant",
        "withTenantDbTransaction",
        "requireTenantFromRequest(req, 'pending agent-run review')",
        "requireTenantFromRequest(req, 'pending agent-run approval')",
    ],
    "workgraph-studio/apps/api/src/modules/approval/approvals.router.ts": [
        "assertApprovalRequestTenant",
        "assertWorkflowInstanceTenant",
        "assertWorkflowNodeTenant",
        "withTenantDbTransaction",
        "requireTenantFromRequest(req, 'approval request listing')",
        "requireTenantFromRequest(req, 'my approvals')",
    ],
    "workgraph-studio/apps/api/src/modules/consumable/consumables.router.ts": [
        "assertConsumableTenant",
        "assertWorkflowInstanceTenant",
        "withTenantDbTransaction",
        "requireTenantFromRequest(req, 'consumable listing')",
        "TENANT_ISOLATION_MODE=strict requires instanceId when creating a consumable",
    ],
    "workgraph-studio/apps/api/src/modules/document/documents.router.ts": [
        "assertDocumentTenant",
        "assertWorkflowInstanceTenant",
        "withTenantDbTransaction",
        "requireTenantFromRequest(req, 'document listing')",
        "TENANT_ISOLATION_MODE=strict requires instanceId when uploading a document",
        "TENANT_ISOLATION_MODE=strict requires instanceId when attaching a document link",
    ],
    "workgraph-studio/apps/api/src/modules/internal/artifact-fetch.router.ts": [
        "requireTenantScopedInternalToken(req, 'internal artifact fetch')",
        "assertDocumentTenant(req, documentId)",
        "withTenantDbTransaction",
        "TENANT_ISOLATION_MODE=strict requires documentId or document: minioRef",
    ],
    "workgraph-studio/apps/api/src/modules/admin/feature-flags.router.ts": [
        "requireTenantScopedInternalToken(req, 'internal feature-flag reads')",
        "Only admins can read global feature flags when tenant isolation is strict",
    ],
    "workgraph-studio/apps/api/src/lib/iam/service-token.ts": [
        "IAM_SERVICE_TOKEN_TENANT_IDS",
        "validateIamServiceTokenTenantScope",
        "tenant_ids:",
    ],
    "context-fabric/services/context_api_service/app/iam_service_token.py": [
        "configured_tenant_ids_for_service_token",
        "validate_iam_service_token_tenant_scope",
        "tenant_ids",
    ],
    "bin/check-deploy-env.sh": [
        "IAM_SERVICE_TOKEN_TENANT_IDS must be configured",
        "WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS must be configured",
    ],
}


def validate_route_policy_ledger(failures: list[str]) -> Counter[str]:
    app_path = ROOT / "workgraph-studio/apps/api/src/app.ts"
    mount_re = re.compile(
        r"app\.use\(\s*'(?P<path>/api/[^']+)'\s*,\s*(?:authMiddleware\s*,\s*)?(?P<router>\w+)"
    )
    mounted = []
    for line in app_path.read_text(encoding="utf-8").splitlines():
        if line.lstrip().startswith("//"):
            continue
        match = mount_re.search(line)
        if match:
            mounted.append(f"{match.group('path')} {match.group('router')}")
    mounted_set = set(mounted)
    classified_set = set(ROUTE_TENANT_POLICIES)

    if len(mounted) != len(mounted_set):
        duplicates = [key for key, count in Counter(mounted).items() if count > 1]
        failures.append(f"workgraph-studio/apps/api/src/app.ts: duplicate identical route mount(s): {', '.join(duplicates)}")

    for key in sorted(mounted_set - classified_set):
        failures.append(f"workgraph-studio/apps/api/src/app.ts: missing tenant policy classification for {key!r}")
    for key in sorted(classified_set - mounted_set):
        failures.append(f"bin/check-workgraph-tenant-guards.py: stale tenant policy classification for unmounted route {key!r}")

    categories: Counter[str] = Counter()
    for key, value in ROUTE_TENANT_POLICIES.items():
        category = value.split(":", 1)[0]
        if category not in ROUTE_POLICY_CATEGORIES:
            failures.append(f"bin/check-workgraph-tenant-guards.py: unknown tenant policy category {category!r} for {key!r}")
        categories[category] += 1
        if ": " not in value:
            failures.append(f"bin/check-workgraph-tenant-guards.py: tenant policy for {key!r} needs '<category>: <reason>'")

    return categories


def main() -> int:
    failures: list[str] = []
    categories = validate_route_policy_ledger(failures)
    for rel, markers in REQUIRED_MARKERS.items():
        path = ROOT / rel
        if not path.exists():
            failures.append(f"{rel}: file missing")
            continue
        text = path.read_text(encoding="utf-8")
        for marker in markers:
            if marker not in text:
                failures.append(f"{rel}: missing marker {marker!r}")

    if failures:
        print("Workgraph tenant guard coverage failed:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    category_summary = ", ".join(f"{name}={count}" for name, count in sorted(categories.items()))
    print(
        f"Workgraph tenant guard coverage OK "
        f"({len(REQUIRED_MARKERS)} files, {len(ROUTE_TENANT_POLICIES)} route policies: {category_summary})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
