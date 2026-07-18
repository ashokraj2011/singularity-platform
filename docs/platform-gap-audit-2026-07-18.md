# Platform Gap Audit - 2026-07-18

This audit records gaps observed from the current local worktree and running
bare-metal services. It is evidence-led, not a roadmap wish list.

Current repo evidence:

- Branch: `main`
- HEAD: `87b705b6`
- Worktree: dirty; includes Synthesis and single-capability initiative changes.
- Route smoke: primary routes return 200, but several legacy/confusing surfaces
  still return 200.
- Adoption health: score 60, with runtime/model/git blockers.
- Bare-metal status: services are running, but process names are mangled in the
  status output.

## P0 Gaps

### 1. Runtime and LLM path is not ready in the current deployment

Evidence:

- `GET /api/adoption/health` reports:
  - `runtime-bridge`: warning, no MCP runtime dialed in.
  - `llm-default-model`: blocked, default model alias not ready.
  - `git-push`: blocked, no connected runtime credential path.
- `GET http://localhost:8000/api/runtime-bridge/status` without the service
  token returns `missing runtime bridge service token`, which is secure but still
  a recurring operator confusion point.

Impact:

- The main SDLC path cannot reliably launch real runs, invoke Copilot/MCP, use a
  live model, or push Git changes without manual setup recovery.

Required fixes:

- Make `/llm-settings` and setup scripts print the exact authenticated runtime
  status command and token source.
- Add a one-command client-runtime preflight that proves runtime bridge,
  model catalog, default alias, and Git push credential readiness.
- Make launch screens fail closed with the exact missing runtime/model/git item.

### 2. Synthesis/Studio authorization is too coarse

Evidence:

- `workgraph-studio/apps/api/src/modules/studio/studio-authz.ts` maps all Studio
  reads to `workflow:view` and all writes to `workflow:update` on `__platform__`.
- Synthesis initiatives now attach to one platform capability, but Studio access is
  not yet checked against the initiative's owning capability/resource grant.
- `board.router.ts` and `concept-archive/archive.router.ts` handlers rely on
  the broad Studio middleware; individual board/archive reads and mutations do
  not enforce the owning project/capability.
- `app.ts` mounts `conceptArchiveRouter` behind `authMiddleware, studioAuthz`,
  while `archive.router.ts` exposes high-impact actions such as stage card,
  confirm coordinates, vote, pin/unpin, promote, kill cell, freeze archive,
  recut axes, pathfinder search, proposal create, proposal accept/reject, and
  proposal rebase.
- `studio-authz.ts` determines `resourceType` from whether the path includes
  `/boards`; Concept Archive paths therefore authorize as generic
  `StudioProject`, not as the specific studio, archive, card, cell, proposal,
  or owning initiative/capability.
- `archive.service.ts` helpers such as `studioOrThrow(...)` and
  `archiveOrThrow(...)` check only current tenant visibility via `tenantWhere()`.
  They do not evaluate card/archive/proposal ownership, project grant,
  capability membership, sponsor authority, or curation permission.
- The test suite has Studio board, merge, archive, and single-capability tests,
  but no direct-ID/cross-capability Studio authorization matrix.

Impact:

- In enterprise mode, a user with broad workflow view/update could potentially
  see or mutate Synthesis initiatives, boards, rooms, and concept data outside
  their capability/resource scope.
- Concept curation actions can affect claims, promoted concept status, archive
  axes, portfolio evidence, and future execution handoffs, so treating them like
  generic workflow edits is too permissive.
- A direct archive, card, or proposal id may be enough for an otherwise broad
  Studio editor to mutate another initiative's concept portfolio inside the same
  tenant.

Required fixes:

- Replace broad Studio authz with resource-aware decisions:
  `synthesis:initiative:view`, `synthesis:initiative:edit`,
  `synthesis:board:view`, `synthesis:board:edit`,
  `synthesis:concept:view`, `synthesis:concept:curate`,
  `synthesis:concept:promote`, `synthesis:archive:freeze`,
  `synthesis:archive:recut`, `synthesis:proposal:decide`, and capability
  ownership checks.
- Resolve the project/studio/archive/card/proposal before authorization, then
  authorize against the owning initiative's tenant, primary capability, and
  resource grants.
- Add direct-ID and cross-capability tests for Synthesis projects, boards,
  rooms, concept archive cards, archive cells, pathfinder, promotion, freeze,
  recut, and proposal decision APIs.

### 3. Main unified workflow designer still exposes raw node JSON

Evidence:

- `agent-and-tools/web/src/components/workflows/WorkflowDesigner.tsx` inspector
  uses a single `Node config JSON` textarea for most node configuration.
- The richer React Flow inspector in
  `workgraph-studio/apps/web/src/features/workflow/NodeInspector.tsx` has role,
  capability, agent, model, and template pickers, but that is not the only
  designer route users can hit.

Impact:

- Users can misconfigure Direct LLM, human task, governance gate, event, and
  runner nodes through raw JSON.
- The platform has two different workflow-authoring experiences with different
  safety levels.

Required fixes:

- Make the canonical `/workflows/design/:id` route use the richer typed
  inspector, or port its typed editors into the unified Next designer.
- Hide raw JSON behind advanced mode and validate before save.
- Add browser tests for adding/editing Direct LLM, Human Task, Governance Gate,
  Event, and Call Workflow nodes.

### 4. Non-server execution locations are not complete product features

Evidence:

- `NodeInspector.tsx` labels `CLIENT`, `EDGE`, and `EXTERNAL` as requiring a
  runner, and says none is built in yet.
- `WorkflowRuntime.ts` queues `PendingExecution` rows for non-server locations.
- Operations can show runner queues, but no turnkey runner enrollment path is
  visible in the authoring flow.

Impact:

- Users can design workflows that stay active forever unless a custom runner is
  deployed and knows how to claim/complete pending executions.

Required fixes:

- Either make `SERVER` the only selectable location unless a runner is registered,
  or add first-class runner setup/enrollment from the designer.
- Add a "runner required" launch blocker for workflows containing client/edge
  nodes with no matching runner.

### 5. Foreach fan-out/fan-in is not implemented

Evidence:

- `ForeachExecutor.ts` records `_items`, `_completed`, `_parallel`, and
  `_maxConcurrency`, but comments state real fan-out requires sub-workflow or
  inner-graph support.
- For non-empty collections, dispatch fails loudly instead of executing per item.

Impact:

- The workflow engine cannot yet model common enterprise automation patterns
  like validating many documents, many repos, many services, or many affected
  capabilities in one run.

Required fixes:

- Implement bounded fan-out/fan-in with item-scoped context, concurrency,
  aggregation, retry policy, and evidence per item.
- Add run cockpit rendering for foreach progress.

### 6. Governed graph mutation path is missing after DRAFT freeze

Evidence:

- `workgraph-studio/apps/api/src/modules/workflow/templates.router.ts` exposes
  `POST/PATCH/DELETE /:id/design/phases`, `/:id/design/nodes`, and
  `/:id/design/edges`.
- Those routes call `assertTemplatePermission(..., 'edit')` and
  `bumpDesignRevision(...)`.
- `bumpDesignRevision(...)` now updates only `status: 'DRAFT'` workflow
  templates and fails non-DRAFT saves with `WORKFLOW_DESIGN_FROZEN`.
- The error message tells callers to duplicate the workflow or create a
  governed graph-mutation proposal, but there is no graph-mutation proposal
  model, route, safety-analysis step, or approval workflow in the current
  WorkGraph API.

Impact:

- The dangerous direct mutation path is closed for non-DRAFT templates, but
  enterprise operators still lack a first-class way to safely amend an active or
  published workflow without cloning and manually re-wiring consumers.
- Regulated workflows need a durable mutation proposal, snapshot diff, safety
  analysis, approval, generation increment, and rollback evidence.

Required fixes:

- Add `WorkflowGraphMutationProposal` records with before/after graph snapshots,
  safety analysis, requested-by/approved-by metadata, and generation numbers.
- Add proposal routes for active/published workflows and keep direct design CRUD
  DRAFT-only.
- Add API tests proving non-DRAFT direct edits fail and approved graph mutation
  proposals create a new immutable version/generation.

### 7. Capability ownership is split between IAM and Agent Runtime

Evidence:

- `Synthesis` initiative creation now uses the federated `/lookup/capabilities`
  picker and stores a single `primaryCapabilityId`, but that picker is
  runtime-authoritative rather than IAM-authoritative.
- `workgraph-studio/apps/api/src/modules/lookup/lookup.router.ts` says Agent
  Runtime is the executable capability catalog and IAM is an optional
  authorization/governance overlay for this picker.
- `workgraph-studio/apps/api/src/modules/lookup/resolver.ts` says workflow
  configuration resolves `capability` from the executable Agent Runtime record,
  "not the IAM authorization record."
- Agent Runtime capability materialization requires an IAM reference through
  `requireIamCapabilityReference`, so a link exists during create/bootstrap,
  but later WorkGraph selection and planner validation still operate primarily
  against runtime capability IDs and readiness.
- `workgraph-studio/apps/api/src/modules/planner/planner.service.ts` validates
  planner home capabilities, child capabilities, repo grounding, assignment
  scope, and launchability through `getRuntimeCapability`,
  `listRuntimeCapabilities`, and `getRuntimeCapabilityWorldModel`.
- `workgraph-studio/apps/api/src/modules/work-items/work-items.router.ts`
  rejects WorkItem targets when a capability is missing from the Agent and Tools
  capability catalog.

Impact:

- IAM can be the intended source of truth while planner/work item launch still
  fails with messages such as "Capability is not available" if the runtime-side
  capability catalog is stale, missing, or unsynced.
- Users see this as a broken capability even though the actual IAM capability
  may exist and be authorized, or as an authorized runtime capability even when
  IAM overlay metadata is missing.

Required fixes:

- Make IAM capability ID the canonical identity and have Agent Runtime expose a
  read model/readiness extension keyed by the same IAM capability ID.
- Split validation errors into `IAM capability missing/inactive/unauthorized`
  versus `runtime metadata or world model missing`.
- Replace direct runtime-catalog existence checks in planner, WorkItems, and
  generic lookup with a federated resolver that checks IAM authority first and
  runtime readiness second.
- Add drift tests: IAM active/runtime missing, IAM inactive/runtime active, and
  runtime stale/IAM updated.

### 8. Project-level specification APIs are tenant-only, not resource-authorized

Evidence:

- `contractBoundRouter` is mounted at `/api`, so `/api/specifications` is a
  first-class authenticated route.
- `POST /specifications` now requires and validates one `primaryCapabilityId`,
  creates one `PRIMARY` capability link, and creates one pending capability
  impact assessment.
- `GET /specifications`, `POST /specifications`,
  `GET/POST /specifications/:id/versions`, and
  `GET/POST /specifications/:id/reviews` check `tenantOf(req)`, but do not call
  `assertCapabilityPermission`, `assertGenerationProjectAccess`, or another
  project/capability resource gate.
- The create path validates that the platform capability exists and is active,
  but it does not verify that the caller may create specifications for that
  capability.
- The same router does use `assertGenerationProjectAccess` for generation plans,
  proving the intended capability-aware pattern exists but is not consistently
  applied to the specification root APIs.

Impact:

- Any authenticated user in a tenant may list, create against an active
  capability, version, or inspect review metadata for project-level
  specifications, even when they do not belong to the owning capability or
  resource grant.
- This weakens the new contract-bound model because specifications are the
  upstream authority for generated WorkItems and evidence.

Required fixes:

- Add project/specification access helpers that authorize against the
  specification project's primary capability and explicit grants.
- Require dedicated permissions such as `specification:view`,
  `specification:create`, `specification:edit`, and
  `specification:review_request`.
- Add direct-ID tests proving users cannot list or mutate another capability's
  specifications inside the same tenant.

## P1 Gaps

### 9. Legacy/duplicate surfaces remain reachable

Evidence:

- Route smoke returns 200 for `/studio`, `/concept-studio`, `/concept-archive`,
  and `/foundry`.
- `/studio` redirects into Synthesis after following redirects, but
  `/concept-studio` and `/concept-archive` both render `ConceptArchiveConsole`.
- `/foundry` still renders `FoundryRoute` even though Code Foundry was previously
  hidden from the main menu.

Impact:

- Users can still land on old or competing surfaces and ask which one is real.

Required fixes:

- Pick canonical destinations and redirect or dev-gate legacy surfaces.
- If Concept Studio remains valuable, rename it clearly as an advanced Synthesis
  sub-surface and remove "archive" as the primary mental model.
- Add a route-inventory contract test so every reachable page is either in the
  lifecycle navigation, explicitly redirected, or explicitly dev/advanced gated.

### 10. Direct LLM runtime is safer than before, but not fully deterministic

Evidence:

- `direct-llm-config.ts` validates credential env names, prompt URL shape,
  input bindings, output schema, enum types, bounded numeric schema values, and
  validation mode.
- `DirectLlmTaskExecutor.ts` blocks Copilot direct and requires Copilot through
  the governed MCP `copilot_execute` path.
- Pinned node loop strategies fail closed, but run-level loop strategy fallback
  is best-effort: unknown/unpublished strategy leaves the node un-strategied.

Impact:

- Runtime behavior can differ between node-pinned and run-level strategy
  configuration, which weakens reproducibility.

Required fixes:

- Make run-level loop strategy resolution either explicit and fail-closed or
  clearly marked as optional demo/default behavior in receipts.
- Record the resolved strategy source, version, and digest for every Direct LLM
  execution.

### 11. Direct LLM connection aliases can silently fall back to mock execution

Evidence:

- `DirectLlmTaskExecutor.ts` reads `connectionAlias`, `modelAlias`, or
  `llmAlias`, then looks up `LlmConnection` by alias and the workflow instance
  tenant.
- If a named alias does not resolve, the executor does not return
  `DIRECT_LLM_CONNECTION_NOT_FOUND`; it continues with `connection === null`.
- Provider resolution then falls back to `cfgString(provider) ??
  (connection?.baseUrl ? 'openai_compatible' : 'mock')`.
- `modelAlias` is still set from the unresolved alias, so receipts can show the
  operator-selected alias while the provider was actually `mock`.
- `direct-llm-config.ts` validates env-name allowlists and prompt/schema
  syntax, but does not validate that `connectionAlias` exists and is enabled.

Impact:

- A typo, deleted connection, tenant mismatch, or missing seed can make a Direct
  LLM node pass with mock output instead of failing before provider invocation.
- Production runs can produce artifacts, approvals, and downstream decisions
  without ever calling the intended LLM provider.
- Operators cannot trust `modelAlias` alone as proof that the configured model
  was used.

Required fixes:

- When `connectionAlias`/`modelAlias`/`llmAlias` is supplied, fail closed if no
  enabled tenant-scoped `LlmConnection` resolves.
- Allow `provider: mock` only through an explicit demo/development setting or a
  published mock connection alias.
- Record both requested alias and resolved connection id/provider in receipts.
- Add regression tests for missing alias, disabled alias, cross-tenant alias,
  explicit mock, and valid tenant connection.

### 12. Loop strategy publishing has tenant scope but no explicit workflow permission

Evidence:

- `app.ts` mounts `/api/loop-strategies` behind `authMiddleware`, but no
  route-level resource or workflow permission middleware.
- `loop-strategy.router.ts` exposes create, update, version, validate, and
  publish routes. The handlers pass only `actorId` to `createLoopStrategy`,
  `createLoopStrategyVersion`, `updateLoopStrategy`, and
  `publishLoopStrategy`.
- `loop-strategy.service.ts` scopes reads/writes by tenant and system template
  visibility, but does not check whether the actor is allowed to author or
  publish tenant-wide Direct LLM execution strategies.
- `LoopStrategy` has no `capabilityId`, team, visibility, or access-grant
  fields, so strategies are effectively tenant-library resources.

Impact:

- Any authenticated tenant user can potentially publish a reusable loop strategy
  that changes Direct LLM execution behavior for workflows that attach it.
- Loop strategies are execution policy, not just UI preferences; publishing
  should be governed similarly to workflow template publication or LLM routing
  administration.

Required fixes:

- Add explicit permissions such as `workflow:loop_strategy:view`,
  `workflow:loop_strategy:create`, `workflow:loop_strategy:publish`, and
  `workflow:loop_strategy:delete`.
- Add owner/team/capability/resource grants or make loop strategies admin-only
  until those grants exist.
- Add API tests proving a viewer cannot create/publish a strategy, an editor can
  draft only within scope, and an authorized publisher can publish immutable
  versions.

### 13. Direct LLM review requests bypass approval-request authorization

Evidence:

- `ApprovalExecutor.ts` validates approval routing before creating an approval
  request.
- `DirectLlmTaskExecutor.ts` creates `ApprovalRequest` rows for `DirectLlmTask`
  review without calling `validateApprovalRouting` or
  `assertCanRequestApproval`.
- `approval.ts` later fails closed in IAM mode when an approval has no governed
  capability scope, but the Direct LLM executor can already have persisted the
  pending review row.

Impact:

- A Direct LLM co-work/review node can create an unactionable or invisible
  approval request instead of failing clearly before the node advances.
- The run cockpit may show "approval required" while no eligible approver can
  decide it.

Required fixes:

- Route Direct LLM review creation through the same approval helper used by
  normal approval nodes.
- Validate assignment mode, selector, capability scope, and requester permission
  before persisting `ApprovalRequest`.
- Add regression tests for Direct LLM review with missing capability, missing
  role/team/user selector, unauthorized requester, and valid routed approver.

### 14. Direct LLM persists full prompt/document context into broad AgentRun evidence

Evidence:

- `DirectLlmTaskExecutor.ts` creates an `AgentRunInput` of type
  `DIRECT_LLM_REQUEST` containing provider, model, modelAlias, baseUrl,
  credentialEnv, full prompt text, system prompt, prompt URL, prompt variables,
  input artifacts, output schema, output fields, harness options, and loop
  strategy.
- The same executor writes `EXECUTION_TRACE` and `LLM_RESPONSE` outputs with a
  correlation payload that includes baseUrl, credentialEnv, promptUrl,
  promptVariables, inputArtifacts, output schema/fields, harness receipt, and
  structured output.
- `agent-runs.router.ts` `GET /:id` returns `agent`, `inputs`, `outputs`, and
  reviews after only `assertAgentRunTenant`; `GET /:id/outputs` returns all
  outputs after the same tenant check.
- `GitPushExecutor.ts`, `EvalGateExecutor.ts`, governance control resolution,
  workflow insights, and receipts all read `AgentRunOutput` rows of type
  `EXECUTION_TRACE`, `LLM_RESPONSE`, or `APPROVAL_REQUIRED`.

Impact:

- Direct LLM nodes can ingest event documents, prompt URLs, and workflow
  variables, then persist that prompt/document context as ordinary run evidence
  without an explicit sensitivity classification.
- Any tenant user who can reach an agent-run output route or a downstream
  evidence surface may see prompt text, document excerpts, external provider
  hostnames, env-var names, and structured validation context unrelated to their
  resource permission.
- Evidence consumers can accidentally couple to raw prompt payloads instead of
  a minimized, stable contract, making later redaction harder.

Required fixes:

- Split Direct LLM evidence into public receipt metadata and restricted
  sensitive payloads.
- Store credential env names, base URLs, prompt text, prompt variables, and
  input artifacts behind resource-aware evidence permissions and redact them
  from default AgentRun, receipt, insight, and cockpit responses.
- Persist stable hashes/citations for prompt and document context so audit can
  prove what ran without exposing full content to every reader.
- Add tests proving a normal workflow viewer can see Direct LLM status, model
  alias, validation outcome, artifact id, and trace id, but cannot see prompt or
  document payloads without sensitive-evidence permission.

### 15. Approval request read and ensure routes are tenant-scoped, not resource-authorized

Evidence:

- `POST /approvals` validates the routed request and calls
  `assertCanRequestApproval` before creating a workflow-node approval request.
- `GET /approvals` lists approval requests after tenant filtering, but does not
  call `canDecideApproval`, workflow instance view authorization, or approval
  audit/view permission before returning rows with `decisions`.
- `GET /approvals/:id` and `GET /approvals/:id/decisions` call
  `assertApprovalRequestTenant`, then return the full request or decisions.
- `POST /approvals/workflow-node/:nodeId/ensure` verifies tenant, node type, and
  active status, then calls `activateApproval`; it does not call
  `assertCanRequestApproval` or a workflow instance `operate`/`approve`
  permission check.

Impact:

- Any authenticated user in the tenant can potentially inspect approval request
  metadata and decision history for workflows they cannot otherwise view.
- A tenant user may be able to materialize an approval request for an active
  approval node without holding the capability/workflow permission that the
  explicit create route requires.
- Approval rows can contain `formData`, routing, assignee, role, team, and
  business decision context, so read access needs the same resource-aware
  treatment as artifacts and audit evidence.

Required fixes:

- Add approval read permissions such as `workflow:approval:view` and
  `workflow:approval:audit_view`, mapped through the workflow instance,
  capability, and approval subject.
- Make `GET /approvals` return only direct/delegated actionable approvals unless
  the caller has broader workflow approval audit permission.
- Gate `GET /approvals/:id`, `/decisions`, and `/workflow-node/:nodeId/ensure`
  with resource-aware workflow/capability authorization, not just tenant
  membership.
- Redact `formData` and sensitive routing details unless the caller can decide
  or audit the approval.

### 16. Run cockpit "Approve & advance" is a manual force-complete override

Evidence:

- `RunGraphView.tsx` renders `Approve & advance` for active agent stages.
- That button calls `POST /workflow-instances/:id/nodes/:nodeId/force-complete`
  with a generic comment of `Approved from run graph`.
- The force-complete route checks `assertInstancePermission(..., 'edit')`, not
  `workflow:approve`, `assertCanDecideApproval`, or an `ApprovalRequest`.
- `forceCompleteNode` is explicitly documented as an operator escape hatch that
  works on any non-completed node, writes a `NODE_MANUAL_COMPLETION`
  `WorkflowMutation`, publishes `NodeManuallyCompleted`, and then calls
  `advance(...)`.
- The normal approval route writes `ApprovalDecision`, `APPROVAL_DECISION`
  receipt, `ApprovalDecided`/`ApprovalVoteRecorded` events, quorum evidence, and
  subject-specific transitions. The force-complete path does not create those
  approval artifacts.

Impact:

- A user with workflow edit permission can advance an agent stage through a UI
  action labeled as approval without producing an approval request, approval
  decision, quorum record, or approval receipt.
- Evidence packs can show a run advanced by a manual completion while operators
  believe a governed approval happened.
- This blurs the difference between emergency override and ordinary human
  approval, which is risky for regulated SDLC flows.

Required fixes:

- Rename the run-cockpit action to `Manual override` unless it routes through an
  approval request.
- For true agent-stage approval, create or load an `ApprovalRequest` and call
  `/approvals/:id/decision`, enforcing assignment, role/team/skill,
  capability, quorum, and separation-of-duty rules.
- Gate `force-complete` with a dedicated action such as
  `workflow:override_node`, require an override reason, and surface it
  separately from approvals in run evidence.
- Add regression tests proving workflow edit does not imply approval, and that
  force-complete evidence is distinct from approval evidence.

### 17. Dual specification roots remain active

Evidence:

- New contract-bound routes expose project-level
  `/api/specifications/:specificationId/versions`.
- The legacy `specificationsRouter` is still mounted under
  `/api/work-items/:workItemId/specifications`; its file header says "The Work
  Item stays the root."
- `specifications.service.ts`, `spec-agent.service.ts`,
  `pseudocode-generation.service.ts`, and `development-targets.service.ts`
  still reject versions unless `version.workItemId === workItemId`.
- `WorkItemsConsole` reads both contract bindings/scopes and the legacy
  `/work-items/:id/specifications` collection.

Impact:

- Users can see or create local WorkItem-owned specifications alongside the
  project-level governing specification package.
- Generated WorkItems are supposed to use immutable bindings and change
  requests, but the legacy edit surface still makes the WorkItem look like it
  owns its own specification truth.

Required fixes:

- Gate legacy WorkItem specification creation/editing for `SPEC_GENERATED` or
  project-bound WorkItems.
- Make legacy routes compatibility read-only aliases once a WorkItem has a
  current `WorkItemSpecificationBinding`.
- Move spec-agent and pseudocode generation to operate on project specs or
  explicit change requests, then remove the "Work Item stays the root" mental
  model from UI copy.

### 18. Generation plan apply lacks a plan-level command fence

Evidence:

- `GenerationPlanStatus` includes `APPLYING`.
- `POST /generation-plans/:planId/apply` checks for `VALIDATED` or `PARTIAL`,
  then loops rows and creates WorkItems.
- The apply route does not first compare-and-set the plan from `VALIDATED` to
  `APPLYING`, does not create a plan-apply command/lease, and does not reject a
  concurrent apply already in progress.
- Per-row WorkItem creation uses idempotency keys, which reduces duplicates, but
  it does not make the whole plan application one fenced operation.

Impact:

- Two operators or retries can race the same plan. Rows may avoid duplicate
  WorkItems, but plan status, row errors, dependency creation, allocation
  updates, and `appliedRows` increments can still become confusing.

Required fixes:

- Add a `GenerationPlanApplyCommand` or plan-level CAS/lease using `APPLYING`.
- Make apply idempotent by request hash and return the existing apply result
  when retried.
- Add concurrency tests for two simultaneous apply requests and crash-after-row
  recovery.

### 19. Contract-bound UI is mostly observational

Evidence:

- `WorkItemsConsole` shows counts for specifications, bindings, scopes,
  handoffs, reconciliation, and finalization, but does not provide guided
  actions to create a binding, create/publish a scope handoff, start
  reconciliation, or request finalization.
- `ProjectGeneration` provides a compact manual row composer for generation
  plans, but it is not a full guided wizard for requirement coverage, target
  scope, handoff evidence, dependency policy, budget, and capacity.

Impact:

- The backend has many of the contract-bound primitives, but the normal user
  flow still feels like status cards plus advanced side routes. Operators have
  to know which screen/API performs the next action.

Required fixes:

- Add an action-first Contract panel: "Bind spec", "Create scope", "Publish
  handoff", "Submit implementation", "Run reconciliation", and "Finalize".
- Upgrade generation planning into a guided wizard with coverage, target,
  handoff, dependencies, budget/capacity, and review steps.
- Add browser E2E proving a user can complete the path without manual API calls
  or hidden legacy WorkItem IDE routes.

### 20. Workflow launch does not capture the derived runtime input contract

Evidence:

- `runtime-inputs.ts` can derive required launch inputs by scanning node
  placeholders and workflow variable definitions.
- `GET /workflow-templates/:id/runtime-inputs` returns those inputs and
  references with node ownership and `captureMode: 'workflow_start'`.
- `startWorkItemTarget` accepts `vars`, `globals`, and `params` and threads
  them into the cloned run context.
- The normal Platform Web start modal in `WorkflowManager.tsx` starts a selected
  WorkItem with only `{ childWorkflowTemplateId: workflow.id }`; it never calls
  the runtime-inputs endpoint and never sends the captured values.
- Human task and approval executors support runtime placeholders such as
  `{{instance.vars.requiredRole}}`, but unresolved values fail only when the node
  activates.

Impact:

- A workflow can launch successfully and later block at a Human Task, Approval,
  Agent Task, Git, or Direct LLM node because required per-node values were not
  collected at start.
- Users cannot see one consolidated launch form for all node-specific runtime
  values, even though the backend can already derive that contract.
- Event-driven and scheduled starts have the same risk unless routing policies
  validate that the incoming event payload satisfies the derived contract.

Required fixes:

- Wire the main start modal to `/workflow-templates/:id/runtime-inputs` and
  render grouped fields by node, kind, scope, required/default status, and
  suggested source.
- Submit captured values to `/work-items/:id/targets/:targetId/start` as
  `vars`, `globals`, and `params`.
- Add a server-side start guard that calls `missingRuntimeInputs` before cloning
  a run and returns a clear list of missing fields.
- Apply the same contract validation to AUTO_START, SCHEDULED_START, and event
  trigger routing before a run is created.

### 21. Workbench definitions still have table, JSON, and URL sources of truth

Evidence:

- `workbench-definitions.service.ts` says the first-class
  `WorkbenchDefinition` tree writes through to
  `WorkflowNode.config.workbench.loopDefinition` because the runtime executor
  still reads the legacy JSON blob until a later migration.
- `writeThroughToLegacy` skips that write-back when
  `WORKBENCH_TABLES_AUTHORITATIVE=true`.
- `WorkbenchTaskExecutor.ts` also skips promotion when the same env var is true,
  but its comments state that the NodeInspector legacy accordion form is not yet
  rewired to mutate via the WorkbenchDefinition API and blueprint-workbench still
  reads `loopDefinition` from URL params.
- `workbenchLaunch.ts` in both WorkGraph web and Platform Web builds `/workbench`
  URLs by serializing `goal`, `sourceUri`, `sourceRef`, `capabilityId`, and
  `loopDefinition` into query parameters.
- The unified Platform Web cockpit mounts `blueprint-workbench/App` directly and
  relies on that app's client-side URL parsing/bootstrap behavior.

Impact:

- Operators can see different Workbench behavior depending on whether the node
  was edited through the legacy JSON inspector, the WorkbenchDefinition API, a
  lazy promotion path, or a URL-encoded launch snapshot.
- Turning on `WORKBENCH_TABLES_AUTHORITATIVE=true` before every editor and
  cockpit launch path is rewired can make the table view, runtime activation,
  and Workbench UI diverge.
- Large or stale `loopDefinition` query strings are fragile, hard to audit, and
  can omit later server-side changes to stages, governance, agent bindings, or
  source details.

Required fixes:

- Make `WorkbenchDefinition` the only source of truth for runtime activation,
  designer edits, cockpit launch, exports, and audit.
- Replace URL-encoded `loopDefinition` launch state with a server-side
  `workflowNodeId`/`workbenchDefinitionId` fetch guarded by workflow access.
- Keep legacy JSON import/export as an explicit migration compatibility path,
  not as normal runtime launch state.
- Add a startup/preflight check that refuses
  `WORKBENCH_TABLES_AUTHORITATIVE=true` until the legacy inspector, launch URL,
  runtime executor, and blueprint-workbench bootstrap all read/write the table
  API.
- Add E2E tests proving an edit in the designer appears in Workbench Neo, runtime
  activation, exports, and audit without relying on query-string snapshots.

### 22. Governance Gate formal verification is topology-only, not design/code proof

Evidence:

- `GovernanceGateExecutor.ts` turns `runFormalVerifier=true` into a local
  `FORMAL_VERIFICATION` control with a `formal` binding.
- `resolveSatisfiedControls.ts` satisfies that `formal` binding by calling
  `analyzeWorkflowInstance(instance.id, actorId, node.id, tenantId)`.
- `formal-verification.ts` builds its payload from `inferGraphFacts(...)` and
  `baseConstraints()`, which currently reason about graph topology facts such as
  deployment/gate presence and QA/final approval presence.
- The formal payload sets `artifactRefs: []` and does not include design-document
  facts, extracted rules, code diff facts, generated Z3 constraints, or
  artifact content hashes.
- `diffVsDesign.ts` is a separate path-based check: it can require tests,
  required path patterns, and forbidden paths, but it does not formalize whether
  the produced code satisfies the previous design document.
- `NodeInspector.tsx` and the unified designer expose `runFormalVerifier` as a
  Governance Gate option, so users can reasonably assume the gate verifies the
  document/code contract rather than only checking workflow graph safety.

Impact:

- A run can show a Governance Gate with formal verification enabled while the
  Z3-backed call is proving only workflow topology properties, not the actual
  SDLC claim "the code produced satisfies the design/specification document."
- This weakens the proposed neuro-symbolic validation path: facts/rules derived
  from design artifacts are not yet compiled into the formal verifier request,
  and code-diff facts are not fed back into that proof.
- Enterprise users may over-trust the "formal verifier" label in release
  readiness or git-diff gates.

Required fixes:

- Add a Governance Gate formal payload builder for design/document/code checks:
  input artifact refs, extracted facts, extracted rules, code-diff facts,
  expected output schema, and provenance hashes.
- Let Governance Gate controls choose a formal profile such as
  `WORKFLOW_TOPOLOGY`, `DESIGN_VS_CODE`, `POLICY_FACTS`, or `CUSTOM_FACT_RULES`.
- Persist formal inputs and verifier outputs as evidence with trace ID,
  artifact hashes, generated Z3 code/hash, result, unknown reason, and model/tool
  provenance for extraction.
- Add tests where contradictory design/code facts return `UNSAT`/blocked, valid
  facts pass, and missing/invalid fact extraction fails closed in hard mode.

### 23. Formal verifier is an unauthenticated sidecar with no tenant boundary

Evidence:

- `context-fabric/services/formal_verifier_service/app/main.py` defines
  `/api/v1/verification/verify`, `/workflows/analyze`, `/agents/analyze`,
  `/specs/analyze`, and `/deployment-policies/analyze` without FastAPI
  dependencies for bearer tokens, service-token validation, caller identity, or
  tenant checks.
- `VerificationRequest` accepts `capabilityId`, `workflowId`, and
  `workflowInstanceId`, but no `tenantId`.
- `storage.py` persists `requested_by`, `capability_id`, `workflow_id`, and
  `workflow_instance_id`, but no tenant column and no service decision/audience
  metadata.
- WorkGraph `formal-verification.ts` calls the verifier with only
  `content-type` and `accept` headers.
- MCP `formal-verify.ts` and `git-workspace.ts` also call
  `/api/v1/verification/verify` without an authorization header.
- `docker-compose.yml` exposes the verifier on `"8010:8010"` when the
  verification profile is enabled.

Impact:

- In a cloud or shared network deployment, any process that can reach the
  verifier can submit proof jobs and receive counterexamples/results.
- Persisted verification evidence cannot be safely partitioned by tenant or
  correlated to an authorized service principal.
- Solver capacity can be abused as an internal denial-of-service target, and
  formal receipts are weaker as audit evidence because caller identity is
  caller-supplied metadata rather than authenticated context.

Required fixes:

- Require an IAM service token or mTLS identity for all non-health verifier
  endpoints.
- Add tenant ID, caller service principal, audience, policy decision ID, and
  trace ID to the verifier request and persistence schema.
- Make WorkGraph and MCP send verifier service-token headers and fail closed
  when the token is missing in production.
- Do not publish `8010` to the host by default in production profiles; expose
  through the platform gateway or internal network only.
- Add tests proving unauthenticated verifier requests are rejected and
  cross-tenant request/result reads cannot occur once persistence is enabled.

### 24. Verification evidence APIs are tenant-scoped but not resource-authorized

Evidence:

- `app.ts` mounts `/api/verifications` behind `authMiddleware`, but the
  verification router does not call workflow instance, WorkItem, node, or
  audit/evidence authorization helpers.
- `GET /api/verifications`, `GET /api/verifications/grounding`, and
  `GET /api/verifications/code-impact` list rows by tenant plus optional
  caller-supplied `instanceId`, `nodeId`, or `commitSha`.
- `POST /api/verifications/grounding` accepts caller-supplied `instanceId`,
  `nodeId`, and `agentRunId`, then `recordGroundingEvidence` writes a
  `GroundingEvidence` row with those ids and the current tenant.
- `POST /api/verifications/code-impact` accepts caller-supplied `instanceId`,
  `nodeId`, `workItemId`, `commitSha`, files, call graph, matches, and risk
  score, then stores a `CodeImpactSnapshot`.
- Independent verification start/complete routes update and write findings after
  checking tenant row existence, but not whether the caller is the assigned
  runner/service principal, verifier, workflow operator, or auditor.

Impact:

- Any authenticated tenant user can potentially list verification, grounding,
  and code-impact evidence for workflow runs or WorkItems they cannot otherwise
  view.
- A caller can append evidence-like rows to another run/node/agentRun inside the
  tenant, weakening the trustworthiness of grounding, risk, and verification
  timelines.
- Verification findings can become an untrusted side channel into evidence packs,
  governance dashboards, and release decisions unless every consumer
  independently re-authorizes and validates provenance.

Required fixes:

- Add typed permissions for verification evidence: `verification:view`,
  `verification:request`, `verification:append_grounding`,
  `verification:append_code_impact`, `verification:run`, and
  `verification:audit_view`.
- Resolve each supplied instance/node/workItem/agentRun id to its owning tenant
  and capability, then enforce workflow/resource access before list or append.
- Restrict start/complete to a verifier service principal, assigned runner, or
  explicitly authorized operator; bind completions to leases/commands.
- Mark externally supplied grounding/code-impact rows as untrusted until a
  governed verifier signs them with trace id, service identity, and source hash.
- Add IDOR tests for cross-run, cross-capability, and cross-tenant reads/appends.

### 25. Dynamic reconciliation still carries command strings in test obligations

Evidence:

- `reconciliation.dynamic.ts` includes `command?: string` in `TestPlanEntry`.
- `reconciliations.service.ts` maps stored test obligations into plans with
  `command: t.command`.

Impact:

- This conflicts with the contract-bound execution goal to replace shell command
  strings with validated runner plus argument arrays in strict mode.

Required fixes:

- Introduce a strict `runner` plus `args` schema for test obligations.
- Reject shell command strings in production/strict mode.
- Add migration/backfill or compatibility conversion for old specs.

### 26. WorkItem list/detail authorization is post-query in places

Evidence:

- `work-items.router.ts` list query fetches candidate WorkItems broadly, then
  filters each row through `canViewWorkItem`.
- Detail fetches by global ID first, then calls `assertCanViewWorkItem`.

Impact:

- Responses are protected, but broad reads can under-fill pagination, waste work,
  and are weaker than tenant/capability-scoped database queries.

Required fixes:

- Push tenant and effective capability filters into the database query wherever
  possible.
- Keep post-query authz as defense in depth, not the primary filter.

### 27. Reconciliation runner queue is principal-scoped, not tenant-query-scoped

Evidence:

- `reconciliation-jobs.router.ts` requires an allowed runner principal in strict
  mode.
- The poll route calls `assertRunnerPrincipal(req)` without a job tenant, then
  returns `listPendingReconciliationJobs(...)` across the pending queue.
- Tenant matching is checked after an individual job is selected/read/claimed,
  but not as a database filter for the queue poll itself.

Impact:

- A shared runner principal can see pending reconciliation work across all
  tenants it is allowed to operate, which may be intentional for a platform
  runner but is not yet explicit in the API contract or UI.

Required fixes:

- Add a required tenant selector for tenant-specific runners, or model shared
  runners as tenant-allowlisted service principals with redacted queue metadata.
- Add tests for tenant-specific runner poll, shared runner poll, and cross-tenant
  claim denial.

### 28. Workflow debug compensation execution skips operate authorization

Evidence:

- `workflowDebugRouter.get('/instances/:id/compensations', ...)` checks
  `assertInstancePermission(..., 'operate', ...)` before listing compensation
  executions.
- `workflowDebugRouter.post('/instances/:id/nodes/:nodeId/compensate', ...)`
  checks only `assertWorkflowInstanceTenant(...)` before calling
  `executeCompensation(...)`.
- `executeCompensation(...)` can execute configured compensation actions:
  `EMIT_EVENT` publishes an outbox event and `RESTORE_CONTEXT` mutates the
  workflow instance context.

Impact:

- Any authenticated user who passes tenant scope, but lacks workflow operations
  permission, may be able to trigger compensation side effects for a workflow
  node if they know the instance and node IDs.
- Compensation is an operator-grade recovery action and should be protected at
  least as strongly as listing compensation history.

Required fixes:

- Add `assertInstancePermission(req.user!.userId, req.params.id, 'operate',
  resolveTenantFromRequest(req))` to the compensate POST route before executing
  the action.
- Add a direct-ID test proving a viewer can read only what their permissions
  allow and cannot execute compensation without `workflow:operations:view` or a
  stronger explicit operation permission.

### 29. Studio agent-principal API uses a raw internal token

Evidence:

- `/api/studio-agent` is service-token protected, but
  `board-verdicts.router.ts` checks only equality against
  `WORKGRAPH_INTERNAL_TOKEN`.
- The agent verdict writer does not receive or enforce tenant/capability-scoped
  service-token claims.

Impact:

- It is a machine boundary, but weaker than the hardened IAM service-token paths.
  A leaked internal token would be broad for Studio agent verdicts.

Required fixes:

- Replace raw shared-token auth with an IAM service principal carrying tenant,
  allowed agent roles, and Studio verdict scopes.
- Record decision IDs for agent verdict create/concede/reopen events.

### 30. Personal tenantless runtimes are supported, but enterprise semantics need clarity

Evidence:

- Context Fabric runtime bridge takes identity from verified JWT claims, not the
  hello frame, which is correct.
- Shared runtimes must match the tenant exactly.
- A user's own tenantless device/runtime token can still serve that user's
  tenant-scoped work for compatibility with laptop device tokens.

Impact:

- This is useful for laptop developer workflows, but enterprise operators need
  a clear distinction between personal tenantless runtimes, tenant-shared
  runtimes, and server-hosted shared runtimes.

Required fixes:

- Show runtime scope explicitly in `/llm-settings` and Operations:
  `personal-device`, `tenant-runtime`, or `shared-runtime`.
- Prefer tenant-bound `kind=runtime` tokens for server MCP+LLM deployment.
- Add a production policy toggle that can reject tenantless personal runtimes if
  an organization wants tenant-bound runtimes only.

### 31. Runtime bridge registry is process-local, so Context Fabric is not HA-safe

Evidence:

- `laptop_registry.py` says the connected runtime registry is in-memory and
  stateless across process restarts.
- The singleton `REGISTRY` stores active WebSockets, pending request futures, and
  heartbeat state in Python process memory.
- `main.py` includes the runtime bridge router directly in the Context Fabric
  API process; status and dispatch endpoints read `REGISTRY.status_snapshot()`
  and send frames through that local singleton.
- There is no shared registry, broker, sticky-session enforcement, or
  cross-replica runtime dispatch path in the runtime bridge code.

Impact:

- If Context Fabric is scaled to multiple replicas, a runtime WebSocket connected
  to replica A is invisible to dispatch requests landing on replica B.
- A Context Fabric restart drops all pending runtime requests and makes every
  runtime appear disconnected until clients reconnect to that specific process.
- Operations `/runtime-bridge/status` can show only the runtimes connected to
  the queried replica, which makes cloud deployment diagnostics misleading.

Required fixes:

- Decide and document the v1 production posture: single Context Fabric replica
  with sticky WebSocket routing, or a real runtime broker.
- If HA is required, move runtime connection metadata and pending dispatch
  routing to Redis/NATS/Postgres leases plus a WebSocket worker ownership model.
- Add readiness checks that fail when multiple Context Fabric replicas are
  configured without sticky routing or a shared runtime broker.
- Add chaos tests for Context Fabric restart, runtime reconnect, pending request
  cancellation, and load-balanced dispatch.

### 32. Workflow Operations has at least one stale fix route

Evidence:

- `workflow-operations.router.ts` still emits `fixRoute: '/workflows/triggers'`
  for routing policy readiness.
- The Platform Web route list and navigation use
  `/workflows/control-plane?tab=event-intake` and
  `/workflows/routing-policies`; no `/workflows/triggers` page is visible.

Impact:

- Operators following a readiness fix can land on a missing or wrong route.

Required fixes:

- Replace stale fix routes with the canonical Control Plane or Routing Policies
  route.
- Add a route-contract test for every `fixRoute` emitted by adoption health and
  workflow operations APIs.

### 33. Operations health is useful but still has auth/noise mismatch

Evidence:

- Adoption health warns that runner queue, event workflow routing, seeded
  workflows, and common agent templates cannot be inspected without login.
- The same screen is intended as first-run guidance, when users may not yet be
  authenticated.

Impact:

- First-run readiness mixes "not logged in" with real missing seeds/runtime
  issues.

Required fixes:

- Split checks into anonymous infrastructure checks and authenticated user-scope
  checks.
- Show "sign in to inspect" as a separate state, not warning noise.

### 34. Prompt Composer prompt assembly and stage prompt reads are not resource-authorized

Evidence:

- `prompt.routes.ts` protects `/api/v1/prompt-assemblies` with `requireAuth`,
  but `prompt.controller.ts` calls `promptAssemblyService.assemble(req.body)`
  without passing `req.user`.
- `prompt-assembly.service.ts` accepts caller-provided `agentTemplateId` and
  `capabilityId`, then reads the agent template, capability context,
  capability knowledge artifacts, distilled memory, workflow phase layers, and
  tool grants by raw IDs.
- `GET /api/v1/prompt-assemblies/:id` fetches by assembly ID and returns
  `finalPromptPreview` plus layer snapshots without checking the caller's
  capability access.
- `PromptAssembly` has `traceId` and `capabilityId`, but no `tenantId` column in
  `agent-and-tools/apps/prompt-composer/prisma/schema.prisma`.
- `stage-prompts.routes.ts` also uses only `requireAuth`; `resolve` can accept a
  caller-provided `capabilityId` and append that capability's long-term memory,
  while `GET /stage-prompts` lists active bindings for any authenticated caller.
- Platform Web proxies these routes through `/api/composer` after proving the
  browser bearer belongs to a user, but it does not perform resource/capability
  authorization before forwarding.

Impact:

- Any authenticated user with access to Platform Web could potentially assemble
  or retrieve prompt previews and capability memory for capabilities they should
  not be able to inspect.
- Prompt assemblies are evidence artifacts; without tenant metadata and
  resource guards, trace and run insight views cannot reliably enforce
  enterprise access boundaries.

Required fixes:

- Add `tenantId`, actor ID, and owning capability/resource metadata to
  `PromptAssembly` and its retrieval APIs.
- Pass `req.user` into assembly and stage-prompt services and enforce
  capability membership/ownership or service-token-only access for raw
  assembly and stage resolution.
- Make Platform Web prompt assembly routes use WorkGraph/Agent Runtime
  effective access before forwarding user requests.
- Add direct-ID tests for prompt assemblies, stage-prompt resolution, and
  capability memory leakage across users/tenants.

### 35. Immutable prompt contracts are minted, but normal executions do not consume them

Evidence:

- `agent-runtime/src/modules/agents/agent.service.ts` mints an
  `ImmutableContract` when an agent template transitions to `ACTIVE`, then
  records `contractId` and `contractHash` on `AgentTemplateVersion`.
- Prompt Composer's schema includes `ImmutableContract` and a nullable
  `PromptAssembly.immutableContractId`, with comments saying replay should
  hydrate frozen layer snapshots instead of live prompt rows.
- The normal Prompt Composer assembly paths create `PromptAssembly` rows with
  live profile/layer/knowledge snapshots, but do not set
  `immutableContractId`.
- WorkGraph's `/api/contracts/:contractId/replay` route renders a frozen replay
  prompt from the bundle, but that is a separate replay surface, not the normal
  `AgentTaskExecutor` or Direct LLM execution path.
- WorkGraph and Context Fabric normal agent execution carry `promptAssemblyId`
  and prompt hashes, but do not pass a pinned contract ID to Prompt Composer or
  require the assembly to match the agent template's published contract.

Impact:

- Published agent templates can have an immutable contract pin, while the
  actual workflow run still executes against live Composer/read-model state.
- Replay can prove what a contract bundle would have run, but not necessarily
  that the original production run consumed that exact bundle.
- This weakens regulated evidence: auditors need one stable "agent version +
  prompt contract + tool contract + model alias" execution key on every run.

Required fixes:

- Resolve the active `AgentTemplateVersion.contractId` at run start and include
  it in the authorization/run snapshot.
- Make Prompt Composer assembly accept and enforce `immutableContractId` for
  production-class executions; fail closed when the contract is missing or does
  not match the selected agent/template/capability.
- Set `PromptAssembly.immutableContractId` on normal executions and include the
  contract ID/hash in Context Fabric receipts, run cockpit evidence, and the
  unified trace API.
- Add regression tests proving normal Agent Task and Direct LLM harness paths
  use the pinned contract in strict mode and cannot silently fall back to live
  prompt rows.

### 36. Legacy workflow webhook path can still create tenantless runs

Evidence:

- `workgraph-studio/apps/api/src/modules/workflow/triggers/triggers.router.ts`
  correctly treats the webhook secret as the authority and never lets the public
  payload choose the tenant.
- The legacy `WorkflowTrigger` path sets `payloadTenantId = match.tenantId ??
  undefined`, then creates the `WorkflowInstance` with
  `tenantId: tenantIdForCreate(context)`.
- The inline comment says public webhook runs without a request tenant and that
  `NULL` tenant instances still need the trigger-tenant gap resolved before
  forced RLS.
- The newer WorkItem trigger path uses `workItemMatch.tenantId` directly and is
  safer.

Impact:

- Old trigger rows with missing tenant IDs can still create tenantless workflow
  instances. That conflicts with strict tenant isolation and makes event-driven
  workflow behavior dependent on historical row quality.

Required fixes:

- Backfill every `workflow_triggers.tenantId` from its owning workflow.
- In strict mode, reject legacy webhook triggers whose row or template lacks a
  tenant before creating an instance.
- Add tests for public webhook event creation in strict mode, including legacy
  rows with missing tenant IDs.

### 37. Tenant isolation coverage needs a table-by-table classification

Evidence:

- A Prisma schema scan found 207 models.
- 91 models have no direct `tenantId` column. Some are correct global or child
  tables, but the classification is implicit.
- 5 models have a direct `tenantId` but no obvious tenant index:
  `ArchiveCellState`, `TenantBudgetEnvelope`, `BoardEvent`, `BoardSnapshot`,
  and `LaptopInvocation`.

Impact:

- Production strict mode has startup guardrails, but enterprise certification
  still needs an explicit proof that every table is either tenant-scoped,
  inherited from a tenant-scoped parent, globally safe, or protected by RLS.

Required fixes:

- Add a generated tenant-isolation manifest for every Prisma model:
  `direct`, `parent-inherited`, `global-reference`, `service-internal`, or
  `legacy-exempt`.
- Add a CI check that fails when a new model lacks classification.
- Add tenant indexes or documented parent-scope proof for the five direct
  tenant models without obvious tenant indexes.

### 38. Git push still has a direct MCP/static-token fallback path

Evidence:

- `GitPushExecutor.ts` first calls Context Fabric
  `/api/runtime-bridge/work/finish-branch`, which is the desired dial-in route.
- If Context Fabric is missing, unreachable, or returns an error, the executor
  falls back to direct `MCP_SERVER_URL /mcp/work/finish-branch`.
- Comments in the same executor state that broker identity is best-effort and
  that missing repo/tenant leaves the legacy static-token push path intact.

Impact:

- In cloud + laptop/server runtime deployments, Git push can silently shift from
  governed runtime-bridge credentials to legacy direct MCP/static-token behavior
  unless operators inspect the receipt details.

Required fixes:

- In production/strict mode, require Context Fabric runtime-bridge Git push and
  fail closed when repo, tenant, user, capability, or brokered credential context
  cannot be resolved.
- Keep direct MCP fallback only behind an explicit debug flag.
- Record credential provenance in every Git push receipt and surface it in the
  run cockpit.

### 39. Event emit can advance best-effort without delivery

Evidence:

- `EventEmitExecutor.ts` defaults `failOnError` to `true`, which is good.
- When a workflow author sets `failOnError=false`, runtime delivery errors return
  `{ passed: true }` with the error recorded in node output.
- This is useful for noncritical notifications, but the authoring UI does not
  clearly distinguish soft delivery from required business events.

Impact:

- Status callbacks to an external event bus can become advisory without an
  operator noticing, while downstream systems believe the workflow has sent
  mandatory stage updates.

Required fixes:

- Add explicit event criticality: `required`, `best_effort`, or `audit_only`.
- Make status/progress callbacks required by default for event-driven WorkItems.
- Show soft event delivery as a warning in the run cockpit and Workflow
  Operations delivery table.

### 40. Browser session tokens are still stored in localStorage

Evidence:

- `agent-and-tools/web/src/lib/api.ts` persists the IAM bearer token in
  `agent-tools-token`, `iam-auth`, `singularity-portal.auth`, and
  `workgraph-auth`.
- `agent-and-tools/web/src/lib/identity/idleSession.ts` explicitly documents
  that the IAM JWT is long-lived, stored in localStorage, and guarded only by a
  client-side idle deadline.
- `workgraph-studio/apps/web/src/lib/sharedAuth.ts` reads the same shared
  localStorage token for cross-app SSO.

Impact:

- Any XSS in the unified origin can steal long-lived IAM bearer tokens for the
  whole platform. Multiple legacy keys also make revocation, rotation, and
  incident response harder to prove.

Required fixes:

- Move browser auth to an HttpOnly, Secure, SameSite session cookie or BFF
  session model.
- Keep access tokens server-side; use short-lived anti-CSRF tokens for browser
  mutations.
- Collapse legacy localStorage token keys after migration and add a token
  storage contract test that prevents new bearer-token localStorage usage.

### 41. Unified web lacks baseline browser security headers

Evidence:

- `agent-and-tools/web/next.config.mjs` defines redirects and rewrites but no
  `headers()` policy for security headers.
- A repository scan finds no Platform Web `Content-Security-Policy`,
  `Strict-Transport-Security`, `X-Frame-Options`/`frame-ancestors`,
  `Referrer-Policy`, or `Permissions-Policy` configuration.
- Runtime header check against `http://localhost:5180/` returns `X-Powered-By:
  Next.js` and no baseline security headers. The proxied WorkGraph health
  route similarly exposes `x-powered-by: Express` without those headers.
- Platform Web proxies WorkGraph, audit-governance, Context Fabric, IAM health,
  Workbench, Prompt Composer, and runtime surfaces under one origin, so one
  browser shell now carries many sensitive operational capabilities.

Impact:

- Any UI injection bug has fewer browser-level guardrails against script
  execution, data exfiltration, clickjacking, iframe abuse, permissive
  referrers, or unnecessary browser APIs.
- This compounds the current localStorage-token and SSE-query-token findings
  because stolen or leaked tokens have broad platform reach.

Required fixes:

- Add a central Platform Web security-header policy with environment-aware CSP,
  `frame-ancestors 'none'` or an explicit allowlist, `Referrer-Policy:
  no-referrer`/`strict-origin-when-cross-origin`, `Permissions-Policy`, and
  HSTS for TLS deployments.
- Add CSP nonces/hashes for any intentional inline scripts and avoid allowing
  `unsafe-inline` in production-class mode.
- Add browser/security-header smoke checks for `/`, `/runs/:id`,
  `/workflows/design/:id`, `/synthesis`, `/identity`, and proxied API routes.

### 42. Agent Runtime and Prompt Composer use wildcard CORS on exposed ports

Evidence:

- `agent-and-tools/apps/agent-runtime/src/app.ts` calls `app.use(cors())` with
  default wildcard behavior.
- `agent-and-tools/apps/prompt-composer/src/app.ts` also calls
  `app.use(cors())` with default wildcard behavior.
- `docker-compose.yml` publishes Agent Runtime on `3003:3003` and Prompt
  Composer on `3004:3004`; the platform handbook also documents these as
  reachable service ports.
- Runtime checks with `Origin: https://evil.example` show both services return
  `Access-Control-Allow-Origin: *`.
- Agent Service and WorkGraph have explicit origin allowlists, so the behavior
  is inconsistent across the backend boundary.

Impact:

- Any website can make browser requests to these directly exposed sensitive
  APIs if it obtains or tricks a user into providing a bearer token. This is
  especially risky while browser sessions are still localStorage-backed.
- The intended unified same-origin Platform Web path is weakened because
  sensitive backend APIs remain browser-callable from arbitrary origins.
- Enterprise deployments cannot easily prove a single browser/API boundary when
  some services are locked to known origins and others are wildcard-open.

Required fixes:

- Replace default `cors()` in Agent Runtime and Prompt Composer with an
  allowlist matching Platform Web and approved operator origins.
- In production-class mode, fail startup if `CORS_ORIGINS` is unset, empty,
  contains `*`, or contains broad development origins.
- Stop publishing `3003` and `3004` by default in production-style compose; make
  direct host ports a debug profile behind explicit operator opt-in.
- Add CORS contract tests for WorkGraph, Agent Runtime, Prompt Composer,
  Agent Service, and audit-governance.

### 43. Agent source URL fetches validate the first hop but not redirects

Evidence:

- `agent-source-url-policy.ts` blocks non-http(s), embedded credentials,
  localhost/private/metadata hostnames, and private DNS results for the original
  URL.
- `agent.service.ts` uses that guard for provider manifests in
  `fetchJsonWithTimeout`, then calls `fetch(url)` with the default redirect
  behavior.
- The URL document preview path validates the original URL, then also calls
  `fetch(url)` with default redirect following.
- The Direct LLM prompt URL fetch path handles redirects manually and revalidates
  every hop, so the safer pattern already exists elsewhere in WorkGraph.

Impact:

- A public URL document or provider manifest can redirect to an internal,
  localhost, or cloud metadata address after the first-hop check.
- Provider manifests are later resolved live at runtime, so this can become a
  repeated server-side request path, not just a one-time preview issue.
- This is especially risky because source-backed skills are intended to accept
  user-provided URLs by design.

Required fixes:

- Change Agent Runtime source/manifest fetches to `redirect: "manual"`.
- Revalidate each redirect target with `assertAgentSourceUrlAllowed`, enforce a
  bounded redirect count, and keep the final URL/digest in source metadata.
- Add contract tests for public-to-private redirects for provider manifests and
  URL document previews.

### 44. Tool Registry execution path is still mock-only

Evidence:

- `workgraph-studio/apps/api/src/modules/tool/gateway/ToolGatewayService.ts`
  imports `mockExecute` and uses it for auto-approved tool execution.
- `MockExecutionRunner.ts` says it "NEVER makes real external calls" and returns
  synthetic successful output.

Impact:

- A tool run can show `COMPLETED` and emit receipts while no real Jira/Git/API
  operation happened. This undermines adoption because operators cannot tell
  whether the Tool Registry is a real execution surface or only a demo facade.

Required fixes:

- Split tool gateway runners into explicit `mock`, `mcp_runtime`, and
  `provider_connector` modes.
- Make mock execution visibly labelled in run receipts, tool runs, and the UI.
- Refuse mock execution outside demo mode unless a tool is explicitly marked
  `simulationOnly`.

### 45. Code-context can still use identity-less direct MCP HTTP

Evidence:

- `context-fabric/services/context_api_service/app/governed/code_context.py`
  routes runtime-placed calls through the runtime bridge and respects
  `RUNTIME_HTTP_FALLBACK_ENABLED`.
- The same function still says identity-less legacy callers use the static
  `MCP_SERVER_URL` best-effort path because there is no runtime identity to
  route.

Impact:

- Some code-context construction can bypass the runtime bridge identity model
  and become best-effort direct HTTP. That weakens the clean dial-in model and
  makes tenant/user/runtime evidence inconsistent.

Required fixes:

- In production-class mode, require tenant, actor, workflow/run, and runtime
  placement context for code-context.
- Treat identity-less code-context calls as development-only and return a clear
  `RUNTIME_CONTEXT_REQUIRED` error otherwise.
- Add a Context Fabric test proving `MCP_SERVER_URL` is not used for
  identity-less code-context in strict mode.

### 46. GitHub App private keys are plaintext in IAM v0

Evidence:

- `singularity-iam-service/app/models.py` stores
  `GitProviderConnection.private_key` as `Text` with the comment:
  "plaintext v0 — KMS/Vault is the blocking pre-prod item."
- `singularity-iam-service/app/git/github_app.py` logs that GitHub App private
  keys are stored plaintext and has a production-class refusal helper.
- GitHub App connection UI correctly treats the key as write-only, but the
  backing storage remains plaintext.

Impact:

- A database leak or broad database operator access exposes GitHub App signing
  keys, enabling repository token minting across connected tenants.

Required fixes:

- Store GitHub App private keys as encrypted secret refs backed by KMS/Vault.
- Keep key material out of ORM result rows by default and load it only inside
  the credential minting boundary.
- Keep the current production-class refusal until encrypted storage is proven by
  integration tests.

### 47. CI does not yet prove enterprise readiness

Evidence:

- `.github/workflows/ci.yml` has one repo workflow.
- `workgraph-studio/package.json` is pnpm-based and
  `workgraph-studio/pnpm-lock.yaml` is committed, but CI installs Workgraph with
  `npm install --no-audit --no-fund`.
- The WorkGraph integration job runs only
  `test/workflow-runtime.integration.test.ts`; the CI comment says broadening to
  the full vitest suite is a follow-up.
- Python services are only byte-compiled with `compileall`; no IAM or Context
  Fabric pytest suite runs with Postgres in CI.
- `bin/check-secret-guardrails.sh` is run with `continue-on-error: true`.
- Browser hydration, lifecycle smoke, audit smoke, trace-spine smoke, RLS
  enforcement, and deep route/API parity checks exist in scripts/docs but are
  opt-in doctor/deep-smoke flows, not required CI gates.

Impact:

- A green CI run can still miss dependency drift, cross-service auth/tenant
  regressions, Python runtime regressions, UI hydration failures, trace-spine
  breaks, strict RLS failures, and secret hygiene issues.
- The repo has many enterprise guard scripts, but they are not yet assembled
  into a blocking release gate.

Required fixes:

- Use lockfile-consistent installs in CI: `pnpm install --frozen-lockfile` for
  Workgraph or intentionally switch Workgraph to npm with a committed
  `package-lock.json`.
- Promote a curated authz/tenant/runtime/contract-bound vitest matrix to CI, not
  only one runtime integration test.
- Add IAM and Context Fabric pytest jobs backed by Postgres where needed.
- Run lightweight browser hydration/API parity checks on every PR and reserve
  heavier deep smokes for nightly or release branches.
- Make secret guardrails blocking after the existing baseline is cleaned.

### 48. Observability is real but not uniformly deployed or enforced

Evidence:

- `audit-governance-service/src/routes-logs.ts` provides `/logs`,
  `/logs/batch`, `/logs/search`, `/logs/facets`, `/logs/health`, and
  `/traces/:traceId/timeline`.
- `audit-governance-service/src/log-operations.ts` adds retention sweeps,
  alert rules, and Datadog/Splunk/http-json export queues.
- `bin/log-forwarder.py` tails bare-metal `logs/*.log`, `*.out`, and `*.err`
  into `/api/v1/logs/batch`; `bin/bare-metal.sh` starts it automatically.
- `docs/observability-log-lake.md` says Docker/Kubernetes should use the
  deployment's stdout collector or OTLP agent.
- `bin/docker-core.sh --with-audit` configures audit-governance log storage but
  does not start a log-forwarder/collector equivalent for the other containers.
- `/api/platform-logs` still merges central log-lake search with local bounded
  file tails, which is useful for boot failures but means operator visibility
  depends on deployment mode and host-local files.

Impact:

- `/operations/logs` can look Datadog/Splunk-like in bare-metal, while plain
  Docker/cloud deployments may only have audit-governance's own storage/export
  unless an external collector is separately configured.
- There is no blocking deployment check proving every core service emits
  structured logs with `traceId`, tenant, user, workflow, WorkItem, node, model,
  and tool correlation.

Required fixes:

- Add a first-class collector story for Docker/cloud: stdout collector sidecar,
  OTLP endpoint, or documented vendor-agent recipe with smoke verification.
- Add a producer contract test for required structured log fields on core
  workflow/runtime paths.
- Extend doctor/smoke to ingest a synthetic correlated log from each core
  service and verify it appears in `/operations/logs` and
  `/audit/trace/:traceId`.
- Clearly label local-tail results versus durable central log-lake results in
  the UI and make central ingestion readiness a deployable health check.

### 49. Artifact store readiness is detected but not wired into normal deployment health

Evidence:

- `workgraph-studio/apps/api/src/index.ts` attempts `ensureBucket()` at startup,
  but catches timeout/failure and continues with the warning "documents will be
  unavailable."
- `workgraph-studio/apps/api/src/healthz-strict.ts` has a real
  `artifact_store_reachable` check that calls MinIO `bucketExists`, so the
  platform can detect the problem.
- In the current runtime, `GET http://localhost:8080/healthz/strict` returns
  `artifact_store_reachable: false` with `MinIO unreachable`, while
  `GET http://localhost:8080/health` still returns `{"status":"UP"}`.
- `docker-compose.yml` healthcheck for `workgraph-api` calls `/health`, not
  `/healthz/strict`.
- `bin/bare-metal.sh`, `bin/docker-core.sh`, `bin/demo-up.sh`,
  `bin/doctor.sh`, README smoke checks, and the platform handbook all use
  `http://localhost:8080/health` for WorkGraph readiness.

Impact:

- The platform can report WorkGraph healthy while document uploads, artifact
  fetches, evidence packs, Workbench artifacts, Prompt Composer artifact-body
  injection, and run evidence retrieval are broken.
- SDLC runs may proceed until a later artifact/document node fails, producing a
  confusing runtime error instead of a launch/readiness blocker.
- Operators have to know to manually call `/healthz/strict` to see the real
  artifact-store failure.

Required fixes:

- Use `/healthz/strict` for WorkGraph container health, bare-metal waits,
  doctor, docker-core smoke, demo-up smoke, and readiness/adoption health.
- In production-class mode, either fail startup or mark WorkGraph unready when
  `artifact_store_reachable` is false.
- Add a readiness card that distinguishes "API process up" from "artifact
  evidence store ready" and blocks evidence-heavy launches when storage is down.

### 50. Shared LLM routing ignores tenant scope and fails open to defaults

Evidence:

- `llm-routing.router.ts` applies `tenantFilter(req)` for the HTTP
  `/api/llm-routing/*` routes.
- `llm-routing/resolve.ts`, the shared resolver used by Workbench, Discovery,
  Event Horizon chat, governed Agent Task nodes, and audit/consumable
  verification, queries `prisma.llmRouting.findMany({ where: { touchPoint,
  enabled: true } })` with no tenant filter.
- The same resolver comments that it is "Best-effort" and returns `null` on any
  error so surfaces fall back to their own defaults.
- `llm-routing.router.ts` `GET /resolve` accepts arbitrary `userId` and
  `capabilityId` query parameters for resolution and returns a matched
  `modelAlias`/`ruleId`; it does not bind a USER-scope resolution to the caller.

Impact:

- In a multi-tenant deployment, runtime surfaces can pick the wrong tenant's
  LLM routing rule or silently ignore routing failures and fall back to a
  default model.
- Operators cannot prove that a workflow, chat, workbench, or audit judge used
  the tenant/capability-approved model route.

Required fixes:

- Change `resolveLlmRouting` to require tenant context in strict mode and filter
  by tenant consistently with the router.
- Return a typed routing error in production-class mode instead of `null`
  fallback when tenant/routing resolution fails.
- Bind USER-scoped resolution to the authenticated subject unless a scoped
  service token is explicitly asking on behalf of another user.
- Verify the selected `modelAlias` maps to an enabled `LlmConnection` with
  credential readiness before a workflow or governed surface launches.

### 51. LLM routing read APIs expose provider metadata without an explicit permission

Evidence:

- `app.ts` mounts `/api/llm-routing` behind `authMiddleware` only.
- `llm-routing.router.ts` requires `requireAdmin` for `POST` and `DELETE`
  connection/rule mutations, but `GET /connections`, `GET /rules`, and
  `GET /resolve` do not require an LLM-routing view/admin permission.
- `GET /connections` returns alias, label, provider, model, baseUrl,
  credentialEnv, credential presence, cost tier, and source for tenant DB rows
  or the fallback catalog.
- `GET /rules` returns all tenant routing rows, including touch point, scope
  type, scope id, modelAlias, positions, ids, and createdById.
- Platform Web `/workflows/control-plane`, run launch, the legacy WorkGraph
  LLM routing page, and Direct LLM node editors all consume these routes.

Impact:

- Any authenticated tenant user can enumerate model-routing policy, provider
  hostnames, env-var names, user/capability scoped rule ids, and credential
  readiness even if they cannot administer LLM routing.
- User-scoped routing rules can disclose that specific users or capabilities
  have different model policies.
- Treating the same payload as both admin-canvas config and normal launch
  metadata makes it hard to hide sensitive fields while still letting workflow
  authors choose an approved alias.

Required fixes:

- Add explicit permissions such as `workflow:llm_routing:view`,
  `workflow:llm_routing:admin`, and `workflow:llm_connection:view_sensitive`.
- Return a reduced alias catalog for normal workflow authors: alias, label,
  provider family, readiness, and cost tier only.
- Keep baseUrl, credentialEnv, scope ids, rule ids, and createdById behind
  admin/sensitive config permission.
- Add browser/API tests for viewer, workflow author, and admin LLM-routing
  responses.

### 52. Outbound event dispatcher failure is non-fatal and not health-gated

Evidence:

- `workgraph-studio/apps/api/src/index.ts` starts the event-bus dispatcher with
  `await startEventDispatcher().catch(...)`, logs a warning, then continues to
  start the API.
- `eventbus/publisher.ts` persists `event_outbox` rows and relies on the
  dispatcher safety sweep to deliver them to `EventSubscription` webhooks.
- `eventbus/dispatcher.ts` owns LISTEN/NOTIFY, retry, HMAC signing, and delivery
  row updates, but it does not persist a dispatcher heartbeat/readiness record.
- The dispatcher now keeps the aggregate `event_outbox.status` as `failed` when
  any subscriber delivery is failed, so failed subscriber delivery is no longer
  hidden behind an aggregate `dispatched` row.
- Workflow Operations exposes queued/failed deliveries and active subscription
  counts, but no explicit dispatcher liveness/readiness check is evident.

Impact:

- WorkGraph can appear healthy while external status callbacks and event-bus
  subscribers are not being delivered.
- EVENTBUS emit nodes may publish durable outbox rows and advance the workflow,
  but downstream systems see no callback until an operator notices pending
  deliveries.

Required fixes:

- In production-class mode, fail startup or mark `/healthz/strict` unhealthy when
  the dispatcher cannot start.
- Persist dispatcher heartbeat, last sweep time, last error, and pending age
  metrics, then show them in Workflow Operations.
- Add a smoke test that publishes a synthetic event, waits for a test
  subscription delivery, and fails if dispatch is not active.

### 53. SSE live streams put bearer tokens in URL query strings

Evidence:

- `workgraph-studio/apps/api/src/middleware/auth.ts` accepts
  `req.query.access_token` whenever the request path ends with
  `/events/stream`.
- `workgraph-studio/apps/web/src/features/runtime/LiveEventsPanel.tsx` builds
  the run live-events `EventSource` URL and sets `access_token` to the shared
  user bearer token.
- `workgraph-studio/apps/web/src/features/runtime/CopilotActivityPanel.tsx`
  does the same for Copilot progress events.
- `workgraph-studio/apps/api/src/modules/workflow/insights.router.ts`
  explicitly documents that `/events/stream` paths authenticate via
  `?access_token` because browser `EventSource` cannot set custom headers.

Impact:

- Full user bearer tokens can appear in browser history, reverse-proxy logs,
  application access logs, monitoring traces, screenshots, and referrer chains.
- The stream token is the same broad platform user token, not a short-lived,
  stream-scoped ticket, so leakage impact is much larger than one run timeline.
- Because the middleware key is path-suffix based, future `/events/stream`
  routes inherit query-token auth unless they explicitly avoid the global
  middleware behavior.

Required fixes:

- Replace browser-to-WorkGraph query-token SSE with a same-origin BFF stream
  route that authenticates the browser via HttpOnly session/cookie and injects
  the service or user token server-side.
- Or mint one-time, short-lived stream tickets scoped to tenant, run id, route,
  and read-only event access; never accept the normal user JWT in
  `access_token` outside local development.
- Redact `access_token` from every platform/proxy/access log and add a route
  contract test proving production-class mode rejects full bearer tokens in SSE
  query parameters.
- Consider replacing `EventSource` with a fetch/ReadableStream client where
  supported so normal `Authorization` headers can be used.

### 54. Copilot handoff exports expose full prompt and artifact content with only run view permission

Evidence:

- `workflowInstancesRouter.get('/:id/export/copilot-yaml')` and
  `workflowInstancesRouter.get('/:id/export/copilot-runner.sh')` call
  `assertInstancePermission(req.user!.userId, id, 'view')` before serving the
  handoff.
- `workflowInstancesRouter.get('/:id/nodes/:nodeId/composed-prompt')` also uses
  only run `view` permission before returning the full composed prompt.
- `loadCopilotExportData` loads completed phase consumables and agent-run
  outputs, then `buildCopilotWorkflowExport` documents that completed phases
  include "full artifact content + diffs" in the YAML.
- The Platform Web run cockpit renders direct download links for Copilot YAML and
  runner script from `/runs/:id`.

Impact:

- A user who can view a run can export stage prompts, upstream document content,
  generated artifact content, changed paths, diffs, and summaries without a
  separate sensitive-evidence or handoff-export permission.
- The composed prompt endpoint can reveal repository world-model context,
  prompt overrides, work-item context, and document excerpts even when the user
  only needs operational run status.
- Redacting normal run views is not enough if the export endpoints remain a
  broad read side door for the same sensitive payloads.

Required fixes:

- Add explicit permissions such as `workflow:handoff:export` and
  `workflow:sensitive_evidence:view`, and require them for full prompt/artifact
  exports and composed prompt reads.
- Default exports to metadata-only/redacted mode unless the caller has the
  sensitive permission; include hashes, citations, artifact ids, and trace ids
  instead of raw document or diff content.
- Audit every export/download event with trace id, actor, run id, selected phase,
  redaction mode, and source counts.
- Add negative tests proving a run viewer can see cockpit status but cannot
  download full Copilot handoff content or composed prompts.

### 55. Copilot runner postback uses a broad user bearer token instead of a scoped run token

Evidence:

- The generated runner script tells users to set
  `SINGULARITY_TOKEN="<your platform bearer token>"`; YAML metadata also sets
  `platform.tokenEnv: "SINGULARITY_TOKEN"`.
- The runner posts results to
  `/api/workgraph/workflow-instances/:id/export/copilot-results`, signals to
  `/api/workgraph/workflow-instances/:id/signals/:name`, and progress to
  `/api/workgraph/workflow-instances/:id/copilot-progress` using that bearer
  token.
- `POST /:id/export/copilot-results` requires only workflow `edit`, accepts a
  generic payload with arbitrary source/status/git/metrics/stage/artifact rows,
  stores the payload in `WorkflowEvent`, writes a receipt, and creates
  `UNDER_REVIEW` consumables.
- `POST /:id/signals/:name` advances matching `SIGNAL_WAIT` nodes and event-start
  nodes from the same authenticated caller context.
- `POST /:id/copilot-progress` uses workflow `edit` and persists live mirror
  progress events.

Impact:

- The off-platform runner needs a full user token even though it only needs
  narrowly scoped rights to upload results for one run, emit allowed signals, and
  send progress ticks.
- If the token is copied into a shell, terminal history, logs, CI variables, or a
  compromised workstation, the blast radius is the user's full platform access,
  not just that exported run.
- Result postbacks are not bound to an export id, nonce, artifact allowlist, or
  handoff digest, so an edit-authorized caller can forge or replay Copilot result
  imports and create evidence-like artifacts for the run.
- Signal postbacks can advance parked workflow barriers, so a leaked token can
  affect control flow, not only upload passive evidence.

Required fixes:

- Mint a short-lived runner token at export time scoped to tenant, run id,
  export id, permitted endpoints, permitted signal names, expected stage ids, and
  artifact output allowlist.
- Bind every result/progress/signal postback to the export id, nonce, handoff
  digest, and stage digest; reject stale, replayed, or out-of-contract uploads.
- Keep the normal user JWT out of the shell path; use one-time token exchange or
  device-flow approval for the runner.
- Add receipt fields for export id, token scope id, handoff digest, postback
  digest, and validation outcome.
- Add tests proving a scoped runner token cannot read other APIs, cannot post to
  another run, cannot emit undeclared signals, and expires/revokes cleanly.

### 56. Platform Web still has broad raw backend rewrites outside the verified BFF

Evidence:

- `agent-and-tools/web/next.config.mjs` rewrites `/api/runtime/:path*`,
  `/api/agents/:path*`, `/api/client-runners/:path*`, `/api/tools/:path*`, and
  `/api/cf/:path*` directly to upstream services.
- `agent-and-tools/web/src/app/api/_proxy.ts` has the stronger Platform Web BFF
  contract: `requireVerifiedCallerBearer`, optional server-side service
  credentials, hop-by-hop header stripping, and JSON error normalization.
- WorkGraph, Audit Governance, Prompt Composer, LLM Settings, topology, logs,
  and runtime-infrastructure routes use this BFF contract, but the raw rewrites
  above do not.
- Runtime probes show `/api/runtime/...`, `/api/agents/...`, and `/api/tools/...`
  do reject missing browser bearers, so this is not currently an open endpoint
  finding. The gap is that auth, headers, request IDs, error normalization, and
  service-token behavior are delegated differently for these domains.
- `agent-and-tools/web/src/app/api/start/_shared.ts` calls
  `/api/runtime/capabilities` through the same-origin raw rewrite during start
  preview, while `/api/llm-settings` and `/api/workgraph/...` use typed BFF
  route handlers.
- `/api/cf/health` is directly reachable through the raw Context Fabric rewrite
  and returns upstream `uvicorn` headers/body shape; protected Context Fabric
  runtime-bridge paths then fail with service-token-specific errors rather than
  the Platform Web caller-verification envelope.

Impact:

- The unified frontend still has two API boundary models: verified Platform Web
  BFF routes for some domains and raw upstream rewrites for others.
- A future upstream route added under Agent Runtime, Agent Service, Tool
  Service, or Context Fabric is automatically surfaced under the browser origin
  without a Platform Web code review for caller verification, service-token
  injection, redaction, rate limits, or normalized error handling.
- Operators cannot prove one consistent browser/API trust boundary while some
  sensitive domains depend on upstream-specific CORS, auth, and header behavior.

Required fixes:

- Replace broad raw rewrites with typed Next route handlers for Agent Runtime,
  Agent Service, Tool Service, and Context Fabric domains.
- Allow only explicit health/debug rewrites, and gate debug rewrites behind
  development-only configuration.
- Require `requireVerifiedCallerBearer` before Platform Web talks to sensitive
  backend routes, and inject server-side service credentials only after caller
  verification succeeds.
- Add a production contract test that fails if `next.config.mjs` exposes broad
  `/api/<service>/:path*` rewrites to internal services.

### 57. Legacy WorkflowTrigger path still bypasses WorkItem-centered execution

Evidence:

- `/api/workflow-triggers` is still mounted and the legacy React designer still
  creates triggers through that route.
- `triggers.router.ts` creates template-owned `WorkflowTrigger` records; its
  public webhook path creates a `WorkflowInstance` directly and then starts it
  fire-and-forget.
- `TriggerScheduler.runEventTriggers` scans outbox events and calls
  `spawnInstance`, which creates a workflow instance directly rather than
  creating/attaching a WorkItem and routing through WorkItem policies.
- The newer WorkItem-trigger path has a richer model: it creates or attaches a
  WorkItem, records trigger evidence, performs per-event dedupe, and calls
  `routeWorkItem`.

Impact:

- Event-driven execution has two product paths with different tenant,
  idempotency, replay, WorkItem, and operations semantics.
- A user can configure a workflow trigger that does not participate in the
  WorkItem-centered SDLC lifecycle, so runs may be harder to trace back to
  capability work, approvals, and evidence.

Required fixes:

- Make WorkItem triggers the canonical event/schedule/webhook trigger model.
- Convert `/api/workflow-triggers` into a compatibility facade that creates
  WorkItem triggers plus routing policies, or hide it behind an explicit legacy
  flag.
- Migrate existing `WorkflowTrigger` rows into WorkItem triggers where possible.
- Require every event-driven workflow launch to create/attach a WorkItem and
  write a Workflow Operations record.

### 58. Event intake idempotency is still optional on user/webhook paths

Evidence:

- The canonical authenticated event intake schema marks `deliveryId` optional.
- `fanOutToWorkItemTriggersDetailed` uses `deliveryId` when present, otherwise
  falls back to a trigger correlation key.
- `claimTriggerEvent` explicitly returns `claimed` when no dedupe value exists,
  meaning retries without a delivery id or correlation key can create and route
  duplicate WorkItems.
- The WorkItem webhook path uses the same correlation-based claim and has the
  same duplicate behavior when the payload has no configured correlation key.

Impact:

- External event producers can accidentally double-create WorkItems and
  auto-start duplicate workflows if they omit idempotency keys.
- Enterprise event ingestion needs predictable producer feedback and retry
  safety by default.

Required fixes:

- Require `deliveryId` or a configured trigger-level correlation key for
  `AUTO_START` and other side-effecting event triggers.
- Reject or quarantine non-idempotent events with a dead-letter reason that the
  producer/operator can fix.
- Show idempotency readiness in trigger configuration and Workflow Operations.
- Add tests proving retried ingest/webhook events do not double-create
  WorkItems or runs.

### 59. Event trigger fan-out and replay are not query-scoped by tenant

Evidence:

- `fanOutToWorkItemTriggersDetailed` queries active `workItemTrigger` rows by
  trigger type, activity, event type, and optional capability, but not by
  `tenantId`.
- The same fan-out helper calls `findAttachableWorkItemForTrigger`, whose
  `workItemId`, `workCode`, and correlation-key lookups filter by status and
  capability only; they do not include the event/request tenant.
- `WorkItemEventDedup` has no `tenantId` column, no RLS policy, and a global
  unique key on `(triggerId, dedupeValue)`.
- `claimTriggerEvent` and `recordTriggerEventWorkItem` create, read, and update
  dedupe rows through that global key.
- Workflow Operations replay first loads the requested event with a tenant
  filter, but its replay-loop check reads recent `WorkflowInboundEventReplayed`
  rows without a tenant filter before comparing payload metadata.
- `runWithTenantDbContext` stores tenant in `AsyncLocalStorage`; it does not
  automatically inject `tenantId` filters into Prisma queries. `set_config` is
  installed only inside `withTenantDbTransaction`.

Impact:

- If the app role bypasses RLS, or if a direct Prisma call runs outside a
  tenant-scoped transaction, event fan-out can see triggers or attachable
  WorkItems outside the intended tenant.
- If the app role does not bypass RLS, the same direct fan-out path can fail
  closed in confusing ways because `app.tenant_id` was never set for those
  queries.
- The dedupe race guard is not tenant-partitioned. A replay or duplicate
  delivery collision is currently keyed by trigger id and dedupe value only,
  so the platform lacks a clear tenant-scoped idempotency invariant.
- Replay safety checks can be affected by recent replay rows outside the
  request tenant, or miss tenant-local replay rows if RLS context is absent.

Required fixes:

- Thread an explicit `tenantId` through event intake, signed ingress, replay,
  scheduler fan-out, `findAttachableWorkItemForTrigger`, `claimTriggerEvent`,
  and `recordTriggerEventWorkItem`.
- Filter `WorkItemTrigger`, attachable `WorkItem`, and replay event queries by
  tenant in application-level `where` clauses, not only by ambient DB state.
- Add `tenantId` to `WorkItemEventDedup`, backfill from the trigger tenant, and
  change the unique key to `(tenantId, triggerId, dedupeValue)`.
- Wrap event fan-out in a tenant-scoped transaction, or prove every direct
  query is explicitly tenant-filtered and safe under forced RLS.
- Add tenant A/B tests for identical event type, delivery id, trigger
  correlation key, replay source, and attachable WorkItem id/code.

### 60. Signed cross-service events are not first-class Workflow Operations events

Evidence:

- The canonical authenticated user event intake logs
  `WorkflowInboundEventReceived`, `WorkflowInboundEventFailed`, or
  `WorkflowInboundEventDeadLettered`, and Workflow Operations reads exactly
  those event types.
- The signed cross-service receiver at `/api/events/incoming` verifies HMAC,
  persists `eventType: incoming.<eventName>`, then fans out to WorkItem triggers.
- Workflow Operations' `INBOUND_EVENT_TYPES` does not include `incoming.*`
  records, so those events do not appear in `/api/workflow-operations/events`.
- The replay endpoint only accepts `WorkflowInboundEvent*` rows, so a signed
  server-to-server event that created a WorkItem/run cannot be replayed from the
  same operator center.
- The signed receiver calls the simpler `fanOutToWorkItemTriggers` helper, which
  returns only WorkItem ids; per-trigger routing failures are not logged as the
  detailed `triggerResults` used by canonical event intake.

Impact:

- A cloud/server event can create or attach a WorkItem and possibly start a
  workflow, while the event lifecycle table and replay center do not show the
  same record operators need to troubleshoot it.
- Cross-service events have weaker operational evidence than browser/user
  posted events, even though they are likely to be the production integration
  path.

Required fixes:

- Normalize signed cross-service ingress into the same `WorkflowInboundEvent*`
  operations record model, preserving source service and upstream outbox id.
- Use `fanOutToWorkItemTriggersDetailed` in the signed receiver and store
  trigger results, matched trigger ids, WorkItem ids, workflow ids, status, and
  last error.
- Make replay support signed ingress events using the original event payload and
  a new replay delivery id, with replay-loop protection and tenant checks.
- Add tests proving `/api/workflow-operations/events` and replay cover both
  authenticated user intake and signed cross-service ingress.

### 61. EVENT_GATEWAY is exposed but intentionally fails at runtime

Evidence:

- `templates.router.ts` maps BPMN `eventBasedGateway` to the `EVENT_GATEWAY`
  workflow node type, and `instances.router.ts` includes `EVENT_GATEWAY` in the
  allowed runtime node type list.
- `EventGatewayExecutor.ts` documents first-to-fire semantics where the first
  downstream signal/timer branch should advance and mark siblings `SKIPPED`.
- The same executor currently only logs `EventGatewayActivated`.
- `WorkflowRuntime.ts` calls `activateEventGateway`, then immediately fails the
  node with `EVENT_GATEWAY_NOT_IMPLEMENTED` and guidance to remodel the race
  manually.

Impact:

- Users can import, create, or see an event gateway node that looks like a real
  enterprise event-driven construct, but every run using it fails by design.
- Event-driven workflows lack a safe native race pattern for "wait for event A
  or timeout B" without manual parallel branches and custom decisions.

Required fixes:

- Either hide `EVENT_GATEWAY` from normal authoring/import unless an
  experimental flag is enabled, or implement first-to-fire semantics fully.
- If implemented, add sibling branch cancellation, active wait claiming,
  timeout/event race fencing, deterministic winner evidence, and run cockpit
  rendering.
- Add import/authoring validation so BPMN event gateways do not silently create
  workflows that are guaranteed to fail at runtime.

### 62. Workflow node config validation misses operational node contracts

Evidence:

- The design node API accepts `config` as `z.record(z.unknown())`, so the
  backend shape gate is intentionally broad.
- `validateNodeConfig` only resolves a small reference set plus the
  `DIRECT_LLM_TASK` structure. It validates capability, agent, prompt, tool,
  Workbench, WorkItem target, user, team, and role references.
- The same validator does not validate operational contracts for
  `CALL_WORKFLOW`, `EVENT_EMIT`, `DATA_SINK`, `SET_CONTEXT`, `SIGNAL_WAIT`,
  `SIGNAL_EMIT`, `TIMER`, `CREATE_BRANCH`, or `RAISE_PR`.
- `CALL_WORKFLOW` can be saved without `templateId` and then stays active with
  no child workflow; a stale template id fails only at runtime.
- `SIGNAL_EMIT` returns without doing anything when `signalName` is missing,
  and `TIMER` fires immediately when its config cannot be parsed.
- `EVENT_EMIT` has useful runtime validation for transport/topic/queue/ARN
  fields, but bad config is discovered only when the run reaches that node.

Impact:

- Workflow authors can save graphs that look complete but fail late, no-op, or
  take a surprising default path during execution.
- Enterprise template approval cannot reliably prove that a workflow is
  launchable from the saved design alone.
- Typed UI editors help, but API imports, metadata-driven node authoring, and
  stale saved configs still bypass a complete server-side node contract.

Required fixes:

- Introduce per-node-type config schemas at save/import/publish time, not only
  inside executors.
- Validate required fields, enum values, JSON object fields, template paths,
  connector references, signal names, timer bounds, and branch/PR repo scope
  before a workflow can be published or launched.
- Add a `validate workflow` API that returns node-by-node blocking issues and
  warnings, and wire it into the designer, gallery, import, and launch flows.
- Keep runtime validation as defense in depth, but make bad authoring
  configurations visible before execution.

### 63. Create Branch and Raise PR choose the newest Git connector globally

Evidence:

- `Connector` has `type`, `name`, `config`, `credentials`, and archive metadata,
  but no tenant, capability, repository, or workflow ownership fields.
- `CreateBranchExecutor` selects `prisma.connector.findFirst({ where: { type:
  'GIT', archivedAt: null }, orderBy: { createdAt: 'desc' } })`.
- `RaisePrExecutor` uses the same newest-active `GIT` connector selection when
  opening a pull request.
- The branch-list connector fallback also selects the newest active `GIT`
  connector, while connector list/get routes query connectors without tenant or
  capability filtering.

Impact:

- In a multi-team or multi-repository deployment, a workflow run can use the
  wrong Git credential simply because another connector was created later.
- Capability repository routing can be correct while branch creation or PR
  creation still uses unrelated connector credentials.
- Connector credentials become a platform-global mutable side effect surface
  rather than a scoped resource attached to a capability, repository, tenant,
  or workflow.

Required fixes:

- Make connectors tenant-scoped and optionally capability/repository-scoped.
- Require branch/PR nodes to resolve a connector from the run's capability and
  repository target, with explicit fallback disabled in production.
- Add authorization checks for connector list/get/use and redact connector
  presence where the caller lacks access.
- Store connector id and repo target in run evidence so branch and PR side
  effects are auditable and replayable.

### 64. Specification bindings can be created from caller-supplied resolved packages

Evidence:

- `POST /work-items/:workItemId/specification-bindings` loads an approved or
  locked `SpecificationVersion`, then parses `input.resolvedPackage ??
  version.package`.
- The resulting `resolvedContentHash` is computed from that caller-supplied
  package when present.
- There is no visible server-side check that the supplied resolved package is a
  deterministic subset/merge of the approved specification version.

Impact:

- A user with WorkItem edit permission can bind execution to a package whose
  content does not match the approved specification version, while still
  recording the approved version id.
- Reconciliation and finalization evidence can appear formally bound to an
  approved spec while actually validating against a mutated package.

Required fixes:

- Make the server derive the resolved binding package from the approved version,
  requirement subset, baseline, and governed overrides.
- If overrides are needed, store them as explicit reviewed inputs and verify the
  derived hash against a deterministic resolver.
- Add tests that malicious or accidental `resolvedPackage` drift is rejected.

### 65. DevelopmentScope acceptance is required but no normal transition path exists

Evidence:

- `WorkItemFinalizer` requires every mandatory `DevelopmentScope` to have status
  `ACCEPTED`.
- The contract-bound router creates scopes in the default `DRAFT` state and
  moves them to `HANDOFF_PUBLISHED` when a handoff is published.
- Dynamic reconciliation completion updates `ReconciliationRun` and
  `WorkItem.reconciliationState`, but does not update the corresponding
  `DevelopmentScope` to `ACCEPTED`.
- The integration test manually updates a scope status to set up finalization,
  rather than exercising a product API transition.

Impact:

- The new finalization contract can dead-end: generated or manually created
  scopes may verify successfully but remain non-accepted, preventing final
  WorkItem completion.
- Operators lack a clear governed action for accepting a scope, rejecting it, or
  requesting rework after reconciliation evidence is available.

Required fixes:

- Add explicit scope transition APIs/actions: submit, accept, reject, request
  rework, cancel.
- Decide whether `VERIFIED_PASS` can auto-accept a scope under policy, or whether
  human approval must accept it.
- Record scope acceptance evidence, actor, policy version, reconciliation run,
  handoff generation, and binding generation.
- Add E2E tests that go from handoff publication through submission,
  reconciliation, scope acceptance, and finalization without manual DB updates.

### 66. WorkItem target start derives tenant from mutable input instead of the row tenant

Evidence:

- `createWorkItem` stores the persisted `tenantId` on the WorkItem row but does
  not inject tenant metadata into `input`.
- `startWorkItemTarget` has `target.workItem.tenantId`, yet computes the launch
  tenant via `tenantIdForCreate({ _vars, _workItem: { input, details } })`.
- In strict tenant isolation, `startWorkItemTarget` throws unless tenant metadata
  exists in the WorkItem input/context.

Impact:

- A valid tenant-scoped WorkItem can fail to launch a child workflow in strict
  mode simply because its business input lacks a tenant field.
- The tenant authority for execution is ambiguous: a persisted row tenant exists,
  but launch logic gives precedence to caller/input context.

Required fixes:

- Use the persisted WorkItem tenant as the authoritative child-run tenant.
- Include the tenant in the cloned run context as evidence, not as the source of
  truth.
- Reject mismatches if caller-provided variables or globals try to name a
  different tenant.
- Add strict-mode tests for generated WorkItems, event-created WorkItems, and
  manual WorkItem target starts.

### 67. Core WorkItem lifecycle events can fall into the default tenant

Evidence:

- `WorkItemEvent.tenantId` is optional and defaults to `"default"` in Prisma.
- `createWorkItem` writes the `CREATED` event without setting `tenantId`.
- Scheduled WorkItems also write the `SCHEDULED` event without setting
  `tenantId`.
- `startWorkItemTarget` writes the `STARTED` event without setting `tenantId`,
  even though it has already loaded `target.workItem.tenantId`.
- Newer contract-bound events such as `SPECIFICATION_BOUND` and
  `HANDOFF_PUBLISHED` explicitly pass the WorkItem or plan tenant, so the newer
  paths are not consistently following the older lifecycle event pattern.

Impact:

- In a multi-tenant deployment, the WorkItem row can be correctly tenant-scoped
  while its core audit/event timeline is stored under the `"default"` tenant.
- Tenant-filtered event views, evidence packs, audit exports, and RLS checks can
  miss the very events that prove creation, scheduling, and child workflow start.
- A strict production tenant posture is weakened by defaulted evidence rows even
  when the business entity itself is scoped.

Required fixes:

- Make every WorkItem event writer pass the authoritative WorkItem or target row
  tenant explicitly.
- Make `WorkItemEvent.tenantId` non-null after backfilling historical rows from
  the parent WorkItem tenant.
- Add a shared `recordWorkItemEvent` helper that requires tenant context and
  rejects mismatches.
- Add regression tests for manual, generated, scheduled, event-created, started,
  clarification, submission, approval, and finalization events.

### 68. Public WorkItem creation can spoof system-owned lineage

Evidence:

- The public `POST /work-items` schema accepts `originType` values including
  `PARENT_DELEGATED` and `SPEC_GENERATED`.
- The same schema accepts `sourceWorkflowInstanceId`, `sourceWorkflowNodeId`,
  and `parentCapabilityId`.
- Before calling `createWorkItem`, the router validates Agent Runtime capability
  existence and calls `assertCanClaimWorkItemTarget`, which maps to
  `workflow:assign`; it does not require a WorkItem creation permission, source
  workflow permission, or a system/service principal for reserved origins.
- `createWorkItem` then persists `originType`, `parentCapabilityId`,
  `sourceWorkflowInstanceId`, and `sourceWorkflowNodeId` from caller input.

Impact:

- A normal authenticated caller with queue/assignment rights can create a
  WorkItem that appears parent-delegated or specification-generated even when no
  parent workflow or generation plan created it.
- WorkItem lineage, evidence packs, approval routing, detach/rework behavior, and
  reports can trust source fields that were supplied by the caller rather than
  derived by the platform.
- This weakens the contract-bound execution model, where generated and delegated
  work should be system-owned transitions with validated source artifacts.

Required fixes:

- Restrict public WorkItem creation to `CAPABILITY_LOCAL` and set that origin on
  the server instead of accepting caller-supplied reserved origins.
- Move `PARENT_DELEGATED` and `SPEC_GENERATED` creation behind internal/service
  APIs that validate the source workflow, node, generation plan, specification
  binding, tenant, and authorization snapshot.
- Use explicit WorkItem creation permission for manual creation, not the target
  claim/assignment permission.
- Add tests proving public callers cannot set reserved origins or source workflow
  lineage, and that internal delegated/generated creation validates all source
  references.

### 69. WorkItem target template references are validated and diagnosed globally

Evidence:

- Public WorkItem creation accepts `targets[].childWorkflowTemplateId`.
- `createWorkItem` calls `assertStartableWorkItemTemplate` before persisting the
  target, but that helper uses `prisma.workflow.findUnique({ where: { id } })`
  without tenant filtering.
- `withTargetTemplateDiagnostics` later loads referenced templates with
  `prisma.workflow.findMany({ where: { id: { in: ids } } })`, also without tenant
  filtering, and returns template name, status, profile, workflow type, and
  capability metadata in the WorkItem response.
- `startWorkItemTarget` later calls `assertTemplatePermission`, which is
  tenant-aware, so the reference may persist and render before it fails at start.

Impact:

- If a caller knows or guesses another tenant's template id, they can create or
  inspect a WorkItem target that references it and may receive template metadata
  through diagnostics.
- WorkItem targets can become permanently unstartable because they passed a
  global shape check but fail the later tenant-aware start permission check.
- This is a small but concrete IDOR-style leak around workflow template metadata.

Required fixes:

- Make `assertStartableWorkItemTemplate` require tenant context and filter the
  workflow lookup by tenant before returning any result.
- Require `assertTemplatePermission(user, templateId, 'start')` during manual
  WorkItem creation when a child template id is supplied.
- Make `withTargetTemplateDiagnostics` tenant-filtered and redact/mask missing
  or unauthorized template ids without revealing names or statuses.
- Add cross-tenant tests for create, list/detail diagnostics, and start.

### 70. WorkGraph local identity CRUD remains writable in IAM mode

Evidence:

- `app.ts` mounts `/api/users`, `/api/teams`, `/api/roles`, `/api/skills`, and
  `/api/permissions` behind only `authMiddleware`.
- `users.router.ts` allows any authenticated caller to create users, update
  users, assign roles, and assign skills in the WorkGraph local tables.
- `roles.router.ts`, `permissions.router.ts`, and `skills.router.ts` allow any
  authenticated caller to create local authorization catalog entries.
- `teams.router.ts` allows any authenticated caller to create teams and add or
  remove team members. Only team-variable edits have a member/admin check.
- These routes do not call IAM `/authz/check`, `isAdminUser`, or a dedicated
  identity-administration permission in IAM mode.

Impact:

- IAM is intended to be the source of truth, but WorkGraph still exposes a
  second writable identity and authorization plane.
- A non-admin tenant user may be able to mutate local WorkGraph users, teams,
  roles, permissions, and skill assignments that downstream legacy helpers still
  consult for routing, UI eligibility, and local admin checks.

Required fixes:

- In `AUTH_PROVIDER=iam`, make these routes read-only mirrors or proxy them to
  IAM with IAM authorization.
- Gate any remaining local-mode writes with explicit admin permissions such as
  `identity:user:create`, `identity:role:manage`, `identity:team:manage`, and
  `identity:permission:manage`.
- Add tests proving a normal IAM-authenticated user cannot create local users,
  roles, permissions, skills, or team memberships through WorkGraph.

### 71. Locally granted WorkGraph admin roles can outlive IAM demotion

Evidence:

- `auth.ts` mirrors IAM `is_super_admin` by adding or deleting `UserRole` rows
  where `source = 'IAM'`.
- The demotion path intentionally leaves non-IAM role grants untouched.
- `users.router.ts` lets an authenticated caller upsert a role assignment with
  `source: 'LOCAL'`.
- `isAdminUser` checks local WorkGraph roles and permissions, not live IAM
  authorization.

Impact:

- If a user receives a local `ADMIN` role grant through WorkGraph, IAM demotion
  will not remove that local grant.
- Admin-only local checks can keep treating the user as an administrator even
  after IAM has revoked super-admin status.
- This is especially risky because the local role grant route itself is not
  admin/IAM-authorized.

Required fixes:

- In IAM mode, reject local role grants entirely or require an IAM
  `identity:role:manage` decision and record the grant as IAM-governed.
- Make `isAdminUser` consult IAM for IAM-authenticated requests, or separate
  local-development admin checks from enterprise admin checks.
- Add revocation tests: grant IAM admin, demote in IAM, verify all WorkGraph
  admin-only actions fail unless a separately authorized enterprise grant still
  exists.

### 72. Rooms and claims bypass the Studio authorization boundary

Evidence:

- `app.ts` mounts projects, portfolio execution, business alignment,
  experience, boards, and board verdicts with `authMiddleware, studioAuthz`.
- The same file mounts `roomsRouter` at `/api/studio` with only
  `authMiddleware`.
- `rooms.router.ts` exposes room, claim, estimate, copilot, probe, abandon, and
  registry endpoints without calling `assertStudioPermission`.
- `rooms.service.ts` direct-ID reads and writes such as `getRoom`, `getClaim`,
  `estimateClaim`, and `getRegistryClaims` do not include tenant/project filters
  in the query.
- `probes.service.ts` direct-ID operations such as `createProbe`,
  `resolveProbe`, `abandonProbe`, and `getRoomConvergence` do not perform
  project/capability authorization and often do not filter by tenant.

Impact:

- The board "Promote to governed claims" path writes into an epistemic model
  whose API is less protected than the Studio board and project APIs.
- A user who passes generic WorkGraph authentication may be able to read or
  mutate claims, probes, estimates, and registry entries by direct ID unless
  database-level RLS catches the access.
- Claims feed specification compilation, generation-plan validation, and
  reconciliation policy references, so this is not just a collaboration feature.

Required fixes:

- Mount `roomsRouter` behind `studioAuthz` immediately, then replace the broad
  check with resource-aware project/capability permissions.
- Add tenant and project/capability filters to every direct-ID room, claim,
  estimate, probe, evidence, convergence, and registry query.
- Add direct-ID and cross-capability tests for rooms, claims, estimates, probes,
  evidence promotion, registry reads, and copilot claim acceptance.

### 73. Board event append accepts arbitrary event names and payload shapes

Evidence:

- `appendEventSchema` accepts `eventType` as any non-empty string up to 64
  characters and `payload` as `z.record(z.unknown())`.
- `appendEvent` persists the supplied `eventType`, `objectIds`, and `payload`
  directly into `BoardEvent`.
- `applyEvent` only materializes `OBJECT_CREATED`, `OBJECT_EDITED`,
  `OBJECT_MOVED`, `OBJECT_DELETED`, and `OBJECT_RESTORED`.
- The reducer explicitly treats unknown event types as forward-compatible no-ops.

Impact:

- A caller can append malformed or unknown events that become part of durable
  board history, outbox delivery, replay streams, and snapshots, but do not alter
  materialized board state.
- Structural event mistakes are discovered only indirectly when the board looks
  wrong; there is no server-side contract saying an `OBJECT_CREATED` must include
  a typed object, an `OBJECT_MOVED` must include numeric coordinates, or an
  unknown semantic event must be registered.
- Evidence reviewers can see a durable event log that contains actions the board
  state never reflects.

Required fixes:

- Add per-event-type schemas for structural board events and registered semantic
  events, and reject unknown event types unless an explicit experimental flag is
  enabled.
- Validate object ids, object payload type, patch keys, position shape, and
  provenance before appending.
- Return field-level validation errors to the board UI so malformed producer
  calls do not become silent no-ops.
- Add reducer/API tests proving malformed structural events are rejected and
  registered semantic events remain intentional no-ops where appropriate.

### 74. Board ingestion and moment services skip tenant-scoped board lookups

Evidence:

- `board.service` uses `loadBoard` with `id` plus current `tenantId` before normal
  board state, branch, and event operations.
- `board-ingestion.service` uses `prisma.board.findUnique({ where: { id:
  boardId } })` in `boardOr404` and `prisma.boardBranch.findFirst({ where: {
  boardId, name } })` in `branchOr404`, without tenant filtering.
- The same ingestion service lists artifacts by `{ boardId }` and loads artifacts
  by `{ id, boardId }`, also without tenant filtering.
- `board-moments.service` loads boards and branches by `id`/`boardId`/`name`
  without tenant filtering before detecting, listing, editing, or rejecting
  board moments.
- The router is behind `studioAuthz`, but that middleware checks broad
  `workflow:view`/`workflow:update` against `__platform__`, not a board/project
  tenant/capability decision.

Impact:

- Source-document ingestion, extracted claims, and board moments are evidence
  paths; direct board ids should not be enough to reach them across tenant or
  capability boundaries.
- Normal board state APIs can be tenant-scoped while adjacent artifact/moment
  APIs for the same board are not, creating inconsistent protection around the
  same surface.
- Cross-tenant or cross-capability IDOR tests may pass for `/state` but fail for
  `/ingest`, `/artifacts`, `/moments`, or moment edit/reject paths.

Required fixes:

- Reuse one tenant- and project-aware board loader for state, event, ingestion,
  artifacts, moments, and merge services.
- Include tenant filters on `BoardBranch`, `IngestedArtifact`, and `BoardMoment`
  reads/writes, and reject mismatched board/project ownership before returning
  metadata.
- Replace broad Studio permission checks with resource-aware
  synthesis-board/source-document permissions.
- Add cross-tenant and cross-capability tests for ingestion, artifact claims,
  moment detect/list/edit/reject, and board state reads.

### 75. Idea Board live co-edit is not durably reconciled with board history

Evidence:

- `useBoardDoc.ts` keeps the live board object map in a Yjs CRDT and syncs
  opaque updates through `/studio/projects/:projectId/coedit`.
- `studio-coedit.service.ts` stores those Yjs updates in an in-memory `Map` and
  explicitly says it is ephemeral and single-instance only.
- The durable board state endpoint `/studio/boards/:boardId/state` is materialized
  from `BoardEvent` and `BoardSnapshot`, not from the Yjs co-edit log.
- `useBoardProducer.ts` separately posts semantic `OBJECT_CREATED`,
  `OBJECT_MOVED`, `OBJECT_EDITED`, and `OBJECT_DELETED` events to the durable
  board event log, but comments mark that path best-effort and browser-local
  queued.
- No server code reconciles persisted Yjs updates back into `BoardEvent` or
  `BoardSnapshot`.

Impact:

- Users can see live board changes through co-edit that are not guaranteed to
  survive reload, server restart, browser storage loss, or multi-instance
  deployment if the semantic event queue failed.
- Time travel, branching, merge, synthesis, export, and evidence history all use
  the event log, so a divergence between Yjs live state and board events makes
  the board feel flaky and undermines auditability.

Required fixes:

- Make the semantic event log the transactional write path for persisted board
  object changes, with Yjs used as a transport/merge aid rather than a second
  source of truth.
- Persist co-edit updates in a shared store or remove the promise that co-edit is
  durable.
- Add a reconciliation monitor that detects CRDT/event-log drift and blocks
  synthesis/export until the durable event log catches up.
- Add tests for event-post failure, browser reload, server restart, and
  multi-tab concurrent edits.

### 76. Workflow run initiative linkage still points at the legacy Initiative model

Evidence:

- `app.ts` explicitly comments that the legacy Initiatives router is no longer
  mounted.
- The legacy `Initiative` Prisma model still exists without tenant or capability
  ownership fields, and its router can create/list/update initiative rows if
  remounted.
- `WorkflowInstance` creation and listing still accept/filter `initiativeId`.
- `cloneDesignToRun` persists `initiativeId` on the run row.
- Runtime budget controls no longer use that field. They resolve the initiative
  budget through `WorkItem.projectId -> SpecificationProject`.

Impact:

- Run lists can be filtered by an initiative id that is not the user-facing
  Synthesis initiative/specification project id.
- A run can carry legacy initiative metadata while budget, evidence, and
  portfolio screens derive initiative context from the WorkItem's
  `SpecificationProject`.
- Operators may see apparently related run, budget, and initiative data that are
  actually backed by different domain roots.

Required fixes:

- Deprecate or remove `WorkflowInstance.initiativeId` from new writes, or rename
  it to an explicit legacy field.
- Add `specificationProjectId` or require all run-to-initiative correlation to
  flow through WorkItem/project links.
- Reject API inputs that pass legacy `initiativeId` in production mode, with a
  migration warning and documented compatibility path.
- Add tests proving run list filters, budget controls, evidence packs, and
  Synthesis project pages all use the same initiative identity.

### 77. Closed: generation plans no longer route work outside the initiative capability

Current evidence:

- Synthesis initiative creation now requires `primaryCapabilityId` and rejects
  secondary capability arrays.
- `SpecificationProject` stores a required `primaryCapabilityId`, and the
  capability-link table now has a one-link-per-project invariant.
- `ProjectGeneration` now loads the initiative's assigned capability and no
  longer exposes an arbitrary per-row target capability picker.
- `POST /generation-plans` resolves the project's primary capability through the
  Agent/Tools capability lookup and rejects any generation row whose
  `targetCapabilityId` differs from the project's `primaryCapabilityId`.
- `POST /generation-plans/:planId/validate` and
  `POST /generation-plans/:planId/apply` now re-check stored plan rows against the
  owning capability, so legacy/stale rows cannot be validated or executed.
- The validation message directs cross-capability work to a separate initiative
  or to claims/evidence/recommendations rather than hidden execution targeting.

Remaining risk:

- Existing persisted generation plans created before this guard may still contain
  mismatched row capabilities and should be reported or quarantined for operator
  cleanup, even though runtime validation/apply now blocks them.
- Cross-capability impact still needs a first-class recommendation/claim workflow
  so users understand how to represent downstream effects without violating the
  single-capability ownership rule.

Follow-up fixes:

- Add a migration/report that finds and either rewrites or quarantines
  pre-existing mismatched `GenerationPlanRow` records.
- Add a dedicated cross-capability impact flow that creates reviewed claims,
  recommended initiatives, or dependency signals without generating WorkItems
  under another capability.

### 78. Generation can create SPEC_GENERATED WorkItems without a locked specification binding

Evidence:

- `planSchema` makes `specificationVersionId` optional for generation plans.
- `POST /generation-plans` only verifies specification version status when
  `input.specificationVersionId` is present.
- `ProjectGeneration` exposes the option "No locked version - generation will
  not create immutable bindings" as the first dropdown choice.
- `POST /generation-plans/:planId/apply` still creates WorkItems with
  `originType: 'SPEC_GENERATED'`, `projectId`, `parentCapabilityId`, and
  `workItemTypeKey: 'SPEC_GENERATED'` even when the plan has no specification
  version.
- `WorkItemSpecificationBinding`, `DevelopmentScope`, and `HandoffGeneration`
  are created only inside branches guarded by `plan.specificationVersion`.

Impact:

- A generated WorkItem can look contract-bound in its origin/type while having
  no immutable specification package, no binding generation, no scope, and no
  handoff evidence.
- Reconciliation and finalization cannot reliably prove which approved
  requirements the WorkItem was supposed to satisfy.
- Users get a convenient "generate now" path that bypasses the central
  requirements-first model the platform is trying to enforce.

Required fixes:

- In contract-bound mode, require a `LOCKED`, `ACTIVE`, or `APPROVED`
  `specificationVersionId` before a generation plan can be validated or applied.
- If draft decomposition without a locked spec is still useful, represent it as
  an explicit unbound planning draft and do not create `SPEC_GENERATED`
  WorkItems from it.
- Make the UI block Apply until a locked specification version is selected, with
  a clear explanation of how to lock the spec first.
- Add tests for generation plan create, validate, and apply with missing,
  malformed, unlocked, and locked specification versions.

### 79. Idea Board claim promotion is not server-idempotent

Evidence:

- `BoardCanvas.promoteToClaims` decides candidates by checking the local canvas
  object's `promotedClaimId`.
- For every candidate it posts a new `/studio/projects/:projectId/claims`
  request, then annotates the board object with `promotedClaimId` and
  `promotedAt`.
- The `Claim` Prisma model has indexes for project, room, context, capability,
  status, and tenant, but no uniqueness constraint for an idea-board promotion
  identity such as `(projectId, boardId, objectId, sourceVersion)`.
- `addClaim` always creates a new claim and stores arbitrary provenance JSON; it
  does not upsert or deduplicate by idea-board source.
- Copy/paste and duplicate explicitly clear `promotedClaimId`, so users can
  create near-duplicate claims from the same semantic source.

Impact:

- Double-clicks, retries, multiple collaborators, stale browsers, or failed
  board-object annotation can create duplicate governed claims from one idea.
- The room/claim layer then treats duplicates as independent beliefs, skewing
  confidence, disagreement, readiness checks, and specification lock gates.
- Operators cannot tell whether duplicate claims represent real independent
  evidence or client-side promotion races.

Required fixes:

- Move promotion into a server-side endpoint such as
  `POST /studio/boards/:boardId/objects/:objectId/promote-claim`.
- Add an idempotency key and/or unique promotion record keyed by tenant,
  project, board, branch, object id, and source event/state version.
- Return the existing claim when the same source object is promoted again.
- Add tests for repeated promotion, multi-user promotion races, failed canvas
  annotation, and duplicate/paste behavior.

### 80. Synthesis-to-spec lineage loses the immutable board source

Evidence:

- `synthesizeBoardObjects` produces source-linked insights, but the source link
  is only an array of source object ids.
- `placeSynthesis` writes those source ids back into mutable canvas objects.
- `promoteToClaims` stores claim provenance as `{ origin: "idea-board", boardId,
  objectId }`.
- `addClaim` accepts that provenance as arbitrary JSON without verifying the
  board id, branch, object id, board event sequence, state hash, or source text
  hash.
- Specification compilation emits sources from accepted claims as
  `/synthesis/rooms?claim=...`; it does not carry the originating board event,
  source card content, synthesis hash, or board state hash into the immutable
  specification package.

Impact:

- A generated specification can cite a claim, but cannot prove the exact board
  state, source note, synthesis result, or human promotion moment that created
  it.
- The source canvas object can be edited after promotion, so audit reviewers may
  see a different idea than the one that originally produced the claim.
- Evidence packs cannot reconstruct a trustworthy idea -> claim -> requirement
  chain without replaying mutable board state heuristically.

Required fixes:

- At promotion time, pin branch, head event sequence, board state hash, source
  object payload hash, synthesis result hash where applicable, and source event
  references.
- Store those fields in a typed claim provenance table or structured provenance
  schema, not freeform JSON only.
- Include pinned provenance in `SpecificationVersion.sources` and evidence pack
  exports.
- Add a traceability view that opens the exact board snapshot used for each
  claim and requirement.

### 81. Idea Board upload bypasses governed document ingestion

Evidence:

- The Idea Board toolbar `Upload` action handles files in `BoardCanvas` and
  creates canvas `image` or `file` objects directly.
- Small images are embedded as `dataUrl` values in the board object; non-image
  files become metadata-only cards with filename, type, and size.
- This path does not call `/studio/boards/:boardId/ingest`.
- The separate `board-ingestion.service` path does perform URL SSRF checks,
  content hashing, parsing, source-span extraction, staged-claim extraction, and
  `IngestedArtifact` persistence.

Impact:

- Users can drag or upload a source file to the visual board and believe it is
  part of governed evidence, while it is actually either embedded canvas data or
  a file-name card.
- Non-image files lose their content entirely in this path, so they cannot
  become source spans, staged claims, specification sources, or evidence pack
  artifacts.
- Image data URLs can inflate board events/co-edit payloads instead of using the
  artifact store and retention controls.

Required fixes:

- Route Idea Board uploads through the governed ingestion/artifact pipeline by
  default.
- Store binary content in the artifact store and place only source-linked preview
  cards on the board.
- Clearly distinguish "visual attachment" from "governed source" if both modes
  remain available.
- Add tests for text, URL, image, PDF/Office, oversized file, and unsupported
  file behavior from the Idea Board upload toolbar.

### 82. Accepted extracted document claims do not become governed claims

Evidence:

- `ingest` stores extracted document claims as JSON inside
  `IngestedArtifact.extractedClaims`.
- `acceptExtractedClaim` calls `setClaimStatus`, which only changes one staged
  claim's status to `ACCEPTED` inside that JSON array.
- `setClaimStatus` logs `ExtractedClaimAccepted`, but it does not call
  `addClaim`, create a `Claim`, create a probe/evidence record, or append a board
  provenance event.
- Synthesis fact review reads governed claims through the
  `/studio/projects/:id/claims` path, which is backed by the separate Rooms/Claims
  model.

Impact:

- A user can ingest a source document, accept extracted claims, and still not see
  those accepted claims in the governed fact/claim set used by specification
  compilation, generation-plan validation, traceability, and evidence packs.
- The platform presents "accepted" as a human decision, but the decision remains
  inside an artifact-local JSON rail rather than becoming an auditable,
  queryable claim.
- Source-document validation and manual board-note promotion produce different
  downstream semantics.

Required fixes:

- Add a first-class "promote accepted extracted claim" path that creates or
  upserts governed `Claim` records with artifact id, span ref, content hash,
  board id, branch, event seq, actor, and accepted timestamp.
- Make `acceptExtractedClaim` either explicitly "stage only" in the UI or perform
  governed claim promotion transactionally.
- Include accepted source-document claims in specification sources and evidence
  packs only after governed promotion.
- Add tests proving accepted extracted claims appear in
  `/studio/projects/:id/claims` with immutable source-span provenance and are
  deduplicated on repeated accepts.

## P2 Gaps

### 83. Bare-metal status output is not operator grade

Evidence:

- `bin/bare-metal-apps.sh status` prints service names like
  `DATABASE_URL_CLAIM_REGISTRY="postgresql:` and `ashokr`.
- `bin/bare-metal.sh` records only PIDs in `.pids`, then guesses service names
  by parsing the command tail.

Impact:

- Operators cannot quickly tell which service is actually running or failed.

Required fixes:

- Store explicit service IDs in pid metadata and render those IDs instead of
  parsing command lines.

### 84. Setup/seed warnings still require too much manual recovery

Evidence:

- Bare-metal setup applies many Prisma and SQL seeds, but some failures are
  collapsed to warnings with manual commands.
- Past local runs hit `DATABASE_URL` missing for `prisma:seed`; the script now
  sets `DATABASE_URL_WORKGRAPH_ADMIN` in most paths, but warning recovery still
  asks the operator to reconstruct environment state.

Impact:

- Fresh clone success is brittle when a seed partially fails. Users see the app,
  but workflows/templates/capabilities may be missing or invisible.

Required fixes:

- Write a single replayable seed command file after setup with fully expanded
  non-secret environment values.
- Add a `bin/repair-seeds.sh` that reruns every idempotent seed and reports
  exactly which seed remains failed.
- Make setup fail hard when critical seed sets are absent unless explicitly run
  in demo/partial mode.

### 85. MCP registry secret storage still has dev-only plaintext paths

Evidence:

- `singularity-iam-service/app/models.py` documents `McpServer.bearer_token` as
  plaintext in v0/dev and says production must encrypt via KMS/Vault.

Impact:

- Enterprise deployments need secret-at-rest hardening before production trust.

Required fixes:

- Replace plaintext bearer storage with encrypted secret refs or Vault/KMS backed
  values.
- Add production preflight refusal when plaintext secret storage is configured.

### 86. Synthesis board save state is not strongly visible

Evidence:

- Synthesis shell status now says Online/Offline based on browser connectivity.
- Board event producer persists failed semantic events to localStorage and flushes
  best-effort.

Impact:

- Online does not mean board state or event semantics are durably saved.

Required fixes:

- Add board-level "Saving / Saved / Pending retry / Conflict" status.
- Surface durable outbox count and retry failures in the board UI.

### 87. Several Synthesis artifacts are browser-local instead of governed project evidence

Evidence:

- `useLocalWorkspace` stores state in `window.localStorage`.
- Fact votes, Journey Map, Pseudocode, and System Diagrams use
  `useLocalWorkspace` keys under the selected project id.
- Journey Map observations, Pseudocode edits, and Diagram React Flow nodes/edges
  are not posted to a WorkGraph API when edited.
- WorkGraph has specification schemas for diagrams and pseudocode on
  specification versions, but these Synthesis screens do not write those
  structures into the project specification or versioned evidence path.

Impact:

- A user can create useful synthesis artifacts that disappear on another browser,
  another device, private browsing, or local storage cleanup.
- These artifacts do not participate in project traceability, approval,
  generation-plan validation, evidence packs, or audit history.
- The Synthesis experience looks like a shared studio, but several surfaces are
  personal scratchpads unless the user manually exports or transcribes them.

Required fixes:

- Add persisted project artifact APIs for journey maps, pseudocode drafts, and
  diagrams, with revisions and project/capability authorization.
- Connect accepted artifacts to `ProjectSpecification`, `SpecificationVersion`,
  or a governed evidence table instead of only local browser state.
- Show clear "local draft" versus "saved to project" status on every Synthesis
  creative surface.
- Add tests proving artifacts survive reload, different browser sessions, and
  server restart, and can be included in evidence packs.

### 88. Workflow trigger scheduling has no durable scheduler lease or health record

Evidence:

- `workgraph-studio/apps/api/src/index.ts` starts `startTriggerScheduler()` in
  every WorkGraph API process.
- `TriggerScheduler.startTriggerScheduler()` installs a process-local
  `node-cron` callback every 30 seconds and runs scheduled WorkItems, WorkItem
  triggers, legacy workflow schedule triggers, and legacy workflow event
  triggers in sequence.
- The scheduler uses row-level compare-and-set on `lastFiredAt` or WorkItem
  status, but there is no cluster-wide scheduler lease, heartbeat, scheduler
  identity, last successful sweep timestamp, or durable per-sweep error record.
- Errors from scheduled WorkItem, WorkItem schedule, WorkItem event, schedule,
  and event sweeps are logged to `console.error`, while Workflow Operations
  summary only reports trigger counts, routing policy counts, deliveries, LLM
  config, and runner backlog.

Impact:

- In a multi-instance WorkGraph deployment, duplicate scheduler processes race
  each other. The compare-and-set fences reduce double firing, but operators
  cannot tell which scheduler is active, stalled, or repeatedly failing.
- If every WorkGraph API instance loses its scheduler loop, the platform can
  still look broadly healthy while scheduled and internal event-triggered work
  stop launching.
- Failures can be visible only in process logs, not in `/workflows/control-plane`
  or a health endpoint.

Required fixes:

- Introduce a durable scheduler lease or DB-backed job queue for trigger sweeps,
  with one active leader per tenant or partition.
- Persist scheduler heartbeat, last sweep start/end, last error, scan counts,
  fired counts, skipped counts, and retry counts.
- Add Workflow Operations readiness for scheduler health, including stale
  heartbeat and repeated sweep failures.
- Add tests with two WorkGraph API processes proving no duplicate scheduled
  starts, and tests proving scheduler failure is surfaced as blocked readiness.

### 89. Cron trigger matching can miss valid or delayed schedule firings

Evidence:

- WorkItem and legacy schedule triggers validate cron expressions with
  `cron.validate(cronExpr)`, then call local `matchesCronNow()`.
- `matchesCronNow()` comments that `node-cron` has no exposed "matches now"
  helper and approximates by parsing fields itself.
- The local `fieldMatches()` implementation supports only `*`, `*/step`, plain
  numbers, comma lists, and simple numeric ranges.
- Trigger rows store `lastFiredAt`, but there is no persisted `nextFireAt`,
  schedule execution row, missed-run policy, or backfill window. If the
  scheduler is down or late when a cron minute matches, the code simply waits for
  the next future match.
- Legacy `spawnInstance()` updates `lastFiredAt`, creates a DRAFT instance, and
  starts it fire-and-forget; comments state the trigger will not re-fire next
  tick even if start fails.

Impact:

- A cron expression can pass validation but fail the platform's narrower local
  matcher, or behave differently around names, stepped ranges, timezone
  fallbacks, and parser edge cases.
- Scheduled workflows and WorkItems have no explicit "missed", "skipped",
  "backfilled", or "failed to start after fire" state for operators.
- Recovery from outage is ambiguous: the platform cannot distinguish an
  intentional skip from a scheduler gap.

Required fixes:

- Use a proven cron occurrence parser as the single source of truth for
  validation, next-fire calculation, timezone handling, and matching.
- Persist `nextFireAt`, `lastAttemptAt`, `lastAttemptStatus`, `lastError`, and a
  durable schedule execution id for every fired trigger.
- Add trigger-level misfire policy: skip, fire once, backfill all, or require
  operator review.
- For legacy workflow triggers, do not mark a schedule fire as complete until
  the workflow instance start is confirmed or a durable retry/dead-letter record
  is written.
- Add tests for downtime/backfill, timezone behavior, legal cron expressions
  outside the local parser subset, and start failure recovery.

### 90. Direct LLM read-only tool loops can over-read workflow context

Evidence:

- `direct-llm-tools.ts` documents the Direct LLM tool path as a Context
  Fabric/MCP bypass that runs in-process inside WorkGraph API.
- The default tool set is every registered Direct LLM tool:
  `DEFAULT_DIRECT_LLM_TOOLS = Object.keys(DIRECT_LLM_TOOL_REGISTRY)`.
- `resolveDirectLlmTools()` enables that full default set when the node has no
  explicit `toolLoopTools` list.
- `read_context` accepts any dotted path and resolves it against the whole
  `WorkflowInstance.context`.
- `list_context_keys` tells the model the top-level context keys and keys under
  `vars`, `globals`, `_vars`, and `_globals`.
- `DirectLlmTaskExecutor.ts` passes the full `instance` into the tool context
  when `llm.toolLoop.enabled` is true.

Impact:

- "Read-only" is being treated as safe, but the model can inspect context values
  that were not explicitly bound into the Direct LLM node's input contract.
- Event payloads, prior node outputs, globals, or operator-provided runtime
  values can be pulled into a direct provider call and then persisted as normal
  AgentRun evidence.
- This weakens the visual input-binding contract: reviewers may think only
  declared variables/documents were sent to the model.

Required fixes:

- Default Direct LLM tool loops to no context-reading tools unless an explicit
  allowlist is attached to the node or published loop strategy.
- Restrict `read_context` to paths derived from `inputBindings`,
  `inputDocumentsPath`, upstream artifact bindings, or an audited
  `readContextAllowlist`.
- Redact or classify sensitive context before returning tool results to the
  model, and store only path/citation/hash evidence by default.
- Add tests proving `read_context` cannot fetch arbitrary `globals`,
  credentials, unbound event payloads, or unrelated prior outputs.

### 91. Direct LLM prompt-composer failures fail open to node prompts

Evidence:

- `direct-llm-config.ts` sets `composeWithPromptComposer` to true by default
  when an agent template is configured.
- `DirectLlmHarness.ts` calls Prompt Composer when
  `options.enabled && options.composeWithPromptComposer && options.agentTemplateId`.
- If Prompt Composer composition fails, the harness catches the error, appends a
  warning, and continues with `basePrompt = args.llm.prompt`.
- Stage prompt resolution inside loop mode also catches Prompt Composer failure,
  appends a warning, and falls back to generic phase prompts.
- The receipt records `promptSource`, warnings, and prompt hashes, but the model
  call has already proceeded with a different prompt source.

Impact:

- A Direct LLM node configured to use an agent/profile prompt can silently run
  with a node-authored prompt when Prompt Composer is down, unauthorized, or
  misconfigured.
- This undermines the "prompt comes from the agent/profile/URL and no one should
  change it" control because fallback behavior changes the authoritative prompt
  source from governed profile assembly to editable node text.
- Evidence later shows a warning, but downstream workflow decisions and artifacts
  may already have been produced from the wrong prompt contract.

Required fixes:

- Add an explicit prompt fallback policy: `fail_closed`, `warn_and_continue`, or
  `demo_only`, with `fail_closed` as the production default.
- When `promptSource = AGENT_PROFILE` or a node requires Prompt Composer, fail
  before provider invocation if composition or stage prompt resolution fails.
- Persist the requested prompt source, resolved prompt source, assembly id, and
  fallback policy in the Direct LLM receipt.
- Add regression tests for Prompt Composer unavailable, unauthorized template,
  missing stage prompt, explicit fallback, and production fail-closed behavior.

### 92. WorkItem finalization side effects are post-commit and not recoverable

Evidence:

- `WorkItemFinalizer` performs the guarded database transition to `COMPLETED`,
  creates `WorkItemFinalizationRecord`, and writes `WORK_ITEM_FINALIZED` inside
  one transaction.
- After that transaction commits, it separately calls `logEvent`,
  `publishOutbox`, `releaseDependents`, `reconcileWorkProgramForWorkItem`, and
  `advanceSourceWorkflow`.
- `releaseDependents()` writes successor `TRIGGERED` events and may auto-route or
  auto-start successor WorkItems.
- `advanceSourceWorkflow()` calls workflow runtime `advance(...)` so the parent
  workflow can continue from the WorkItem node.
- There is no durable finalization side-effect command, retry state,
  completion-program outbox row, or "parent workflow advance pending/failed"
  marker tied to the finalization record.

Impact:

- A process crash or transient failure after the WorkItem commit can leave the
  WorkItem completed while dependents are not released, completion programs are
  not reconciled, or the source workflow node is not advanced.
- Retrying `finalizeWorkItem()` on an already completed WorkItem returns
  idempotently before replaying those missing side effects.
- Operators may see the authoritative finalization event but still have a stuck
  workflow or blocked successor WorkItems with no obvious recovery command.

Required fixes:

- Move dependent release, completion-program reconciliation, and source workflow
  advancement behind durable transactional outbox/command rows created in the
  same transaction as `WorkItemFinalizationRecord`.
- Make idempotent finalization retry inspect and resume incomplete side-effect
  commands instead of returning immediately.
- Add Operations/readiness visibility for finalization side-effect failures and
  replay controls.
- Add crash-after-finalization tests proving dependent WorkItems and source
  workflow advancement eventually complete after process restart.

### 93. WorkItem dependency outcomes are stringly typed and only partially enforced

Evidence:

- `WorkItemDependency.dependencyType` is a free `String` with default `BLOCKS`,
  not an enum or governed outcome model.
- The WorkItem dependency API accepts any non-empty string up to 40 characters
  and stores `String(input.dependencyType ?? 'BLOCKS').toUpperCase()`.
- Generation plan rows accept optional `dependencyType` strings and apply them
  directly when creating `WorkItemDependency` rows.
- `releaseDependents()` only queries dependencies whose type is `BLOCKS` or
  `BLOCKS_UNTIL_SUCCESS`.
- Remaining-blocker checks also only consider `BLOCKS` and
  `BLOCKS_UNTIL_SUCCESS`, with predecessor statuses outside `COMPLETED` or
  `ARCHIVED` treated as blocking.

Impact:

- Dependency policies such as `TRIGGERS_ON_FAILURE`, `CANCELS_ON_FAILURE`, or
  `REQUIRES_MANUAL_DECISION` can be entered as strings but have no visible
  finalizer behavior.
- Typos or unsupported dependency types are silently stored and then ignored by
  dependent release.
- Generation-plan validation can look dependency-aware while runtime semantics
  are effectively limited to basic blocking dependencies.

Required fixes:

- Replace free-form dependency type strings with an enum or policy table that
  lists supported outcomes and allowed transitions.
- Validate WorkItem dependency APIs and generation plans against the supported
  dependency outcome set.
- Teach finalization/cancellation/rework paths how to handle each outcome:
  block-until-success, trigger-on-failure, cancel-on-failure, and manual-decision.
- Add tests for unsupported dependency types, failure-triggered dependents,
  cancellation propagation, and manual-decision dependencies.

### 94. Runtime finish-branch tenant routing ignores tenant from normal run context

Evidence:

- WorkGraph's `GitPushExecutor` builds `userId`, `tenantId`, `capabilityId`,
  and repo identity inside `runContext`, then posts only that payload to Context
  Fabric `/api/runtime-bridge/work/finish-branch`; it does not send top-level
  `user_id` or `tenant_id`.
- Context Fabric's finish-branch endpoint correctly authorizes using
  `req.tenant_id || runContext.tenant_id || runContext.tenantId`.
- The same endpoint then dispatches to the runtime registry with
  `tenant_id=req.tenant_id`, discarding the tenant it just resolved from
  `runContext`.
- The runtime registry only searches tenant/shared runtimes when the dispatch
  call includes a non-empty `tenant_id`, and shared runtime selection requires
  an exact tenant match.
- Existing dispatch tests exercise `dispatch_work_finish_via_laptop()` with an
  explicit top-level tenant, but the endpoint test for finish-branch posts an
  empty `runContext` and does not cover the WorkGraph-shaped payload where tenant
  lives only inside `runContext`.

Impact:

- A personal user-owned runtime can mask the issue because user runtime
  selection does not require the top-level tenant.
- A server-hosted tenant/shared MCP+LLM runtime can be skipped even after the
  request passes authorization for that tenant.
- With HTTP fallback disabled, Git push can fail as `RUNTIME_NOT_CONNECTED` even
  though the correct tenant runtime is connected.
- With HTTP fallback enabled, the system can silently take the debug/direct MCP
  path instead of the canonical runtime bridge path, weakening routing evidence
  and making runtime status misleading.

Required fixes:

- Normalize runtime identity once in the finish-branch endpoint:
  `resolved_user_id`, `resolved_tenant_id`, and `resolved_capability_id`.
- Pass the resolved tenant to both `authorize_runtime_target()` and
  `dispatch_work_finish_via_laptop()`.
- Add a regression test that registers a tenant-shared runtime, sends the same
  WorkGraph-shaped payload as `GitPushExecutor` (`runContext.tenantId` and
  `runContext.userId`, no top-level tenant/user fields), and proves the runtime
  is selected.
- Consider applying the same single normalization helper across runtime-bridge
  endpoints so future worktree, code-context, and tool-run routes cannot
  diverge between authorization identity and dispatch identity.

### 95. Generation plan apply creates draft handoffs but does not publish them

Evidence:

- `ProjectGeneration` lets users create, validate, and apply a generation plan;
  the UI shows resulting WorkItems and links to them, but does not expose a
  handoff publish action.
- `POST /generation-plans/:planId/apply` creates a `DevelopmentScope` when a
  locked specification version and repo/base commit are present.
- The same apply path creates a `HandoffGeneration`, but it does not set
  `status = PUBLISHED`, `publishedById`, `publishedAt`, or
  `DevelopmentScope.currentHandoffGenerationId`.
- The only code path that marks a handoff published is
  `POST /handoffs/:handoffId/publish`.
- `submissions.service.ts` rejects implementation submission registration until
  a scoped handoff is `PUBLISHED` and is the scope's current handoff.
- `WorkItemFinalizer` rejects finalization when any mandatory
  `DevelopmentScope` lacks a current published handoff.
- `WorkItemsConsole` displays "handoff pending" and counts published handoffs,
  but does not provide a guided publish/repair action.

Impact:

- The normal Synthesis "generate work" path can create WorkItems that look
  contract-bound but cannot accept implementation submissions, reconcile, or
  finalize until an operator knows to call a hidden API or alternate surface.
- Users experience an invisible stop between "Apply -> generate" and executable
  delivery, which weakens the promised idea/spec -> WorkItem -> evidence flow.
- Generated WorkItems can accumulate mandatory draft scopes, producing
  finalization failures that are technically correct but hard to recover from in
  the UI.

Required fixes:

- Decide whether generation-plan apply should auto-publish initial handoffs after
  validation or require an explicit "Review and publish handoffs" step.
- If explicit, add a first-class UI action and route from the generated plan row
  and WorkItem Contract panel to publish/replace a handoff.
- If automatic, publish in the same guarded transaction that creates the
  DevelopmentScope and HandoffGeneration, including event/audit records.
- Add tests proving generated WorkItems with repo/base metadata end with a
  current published handoff or show a required publish action before submission,
  reconciliation, and finalization are attempted.

### 96. Human approval and task completion advancement is non-durable best effort

Evidence:

- `POST /approvals/:id/decision` records the `ApprovalDecision`, changes the
  `ApprovalRequest` status, writes an `APPROVAL_DECISION` receipt, and publishes
  `ApprovalDecided` inside the first transaction.
- For a normal workflow-node approval, the route calls `advance(...)` only after
  that transaction has completed.
- If `advance(...)` throws, the route catches the error, logs
  `Workflow advance failed after approval`, and still returns the approval
  decision response.
- `POST /tasks/:id/complete` and approval form completion follow the same
  pattern: task status, receipt, and outbox event are committed first; workflow
  `advance(...)` runs afterward and failures are swallowed with
  `Workflow advance failed after task completion` or
  `Workflow advance failed after form submission`.
- The task routes explicitly comment that they have no `assertTaskTenant`-style
  guard and that the tenant argument is RLS plumbing, not an authorization claim.
- No searched API tests assert recovery after a successful approval/task
  completion whose workflow advancement fails.

Impact:

- A user can see a successful approval or completed human task while the workflow
  node remains active or blocked.
- Evidence packs can show completed human decisions without a matching workflow
  state transition.
- Operators have no durable retry command or pending side-effect record to replay
  the missed advancement.
- Because the API returns success, the UI may not tell the approver that the run
  still needs repair.

Required fixes:

- Replace post-response best-effort `advance(...)` calls with a transactional
  outbox/command such as `WorkflowAdvanceCommand` keyed by approval/task id,
  node id, and decision generation.
- Make the command idempotent and replayable, with visible status in Operations
  and run cockpit.
- Do not swallow advancement failures silently; return a warning state or persist
  a repair-required command when advancement cannot be completed synchronously.
- Add authorization guards for task completion/form submission that bind the task
  to tenant, workflow instance, assignee/team/role, and capability permission.
- Add tests for approval success + advance failure, task completion + advance
  failure, replay of the durable command, duplicate replay idempotency, and
  unauthorized task completion.

### 97. Platform Log Explorer is authenticated-only and exposes broad local logs

Evidence:

- `GET /api/platform-logs` only calls `requireVerifiedCallerBearer(...)` unless
  local development anonymous reads are allowed by `PLATFORM_LOGS_AUTH_REQUIRED`
  or `AUTH_OPTIONAL`.
- `requireVerifiedCallerBearer(...)` verifies that a bearer token maps to a
  user-like IAM subject, but it does not check a logs, audit, operations, tenant,
  or sensitive-data permission.
- The route discovers local log directories from `SINGULARITY_LOG_DIR`, relative
  repo `logs` paths, and `/app/logs`, tails every `.log`, `.out`, and `.err`
  file, parses rows, and returns local log items with source, service,
  lineNumber, correlation ids, and messages.
- The JSON response includes the absolute `logDir`, visible file names, sizes,
  update times, local rows, central audit rows, and source summaries.
- The UI copy says the screen searches local logs across WorkGraph, Context
  Fabric, IAM, LLM Gateway, MCP, Prompt Composer, Agent Runtime, and Platform
  Web, with secrets redacted at the server boundary.
- Redaction is regex-based best effort for common token/password/API-key strings;
  it is not a permission boundary and does not classify tenant payloads,
  filesystem paths, request bodies, provider diagnostics, model prompts, or
  third-party error payloads.

Impact:

- Any authenticated platform user can inspect cross-service operational logs even
  if they are not an operator, auditor, workflow owner, or tenant administrator.
- Logs can reveal tenant ids, user ids, workflow ids, repository paths, host
  filesystem locations, provider/runtime diagnostics, request fragments, and
  stack traces that are not caught by simple secret regexes.
- The absolute `logDir` and file listing leak deployment layout and local
  machine paths.
- In relaxed development mode the endpoint can become anonymous, which is risky
  for office-laptop or shared-network demos.
- Because `/api/traces/:traceId` calls `/api/platform-logs?...backend=local`,
  trace investigation inherits the same broad local-log visibility.

Required fixes:

- Gate `/api/platform-logs`, `/operations/logs`, and audit log views with
  explicit permissions such as `platform:logs:view`,
  `platform:logs:tail_local`, `platform:logs:export`, and
  `platform:logs:sensitive`.
- Default users to a central structured log lake with field-level redaction;
  require elevated operator permission for local file tailing.
- Do not return absolute `logDir` or host paths unless the caller has a local
  operator/debug permission.
- Treat regex redaction as defense in depth only; add structured log
  classification at emit/ingest time and redact tenant payloads, prompts,
  provider errors, filesystem paths, request bodies, and credentials by field.
- Add regression tests for viewer vs auditor/admin access, local-tail denial,
  anonymous-read denial outside true local development, logDir suppression, and
  trace API behavior when local logs are not authorized.

### 98. Context Fabric direct Agent Task can drift from LLM routing evidence

Evidence:

- WorkGraph LLM routing connection rows store `provider`, `model`, `baseUrl`,
  `credentialEnv`, and readiness metadata, but the shared `resolveLlmRouting(...)`
  helper returns only `match.modelAlias`.
- `AgentTaskExecutor` resolves the `GOVERNED_AGENT` or `COPILOT_SDLC` routing
  alias and places it into `model_overrides.modelAlias`.
- When an Agent Task is configured with `llmRoute=context_fabric_direct`, the
  executor sends `run_context.llm_route=context_fabric_direct` and a
  `direct_llm` object containing only ad-hoc node fields:
  `provider`, `model`, `base_url`, and `credential_env`. It does not resolve the
  routed alias into its connection record before calling Context Fabric.
- Context Fabric direct LLM then chooses provider from `direct_llm.provider`,
  `CONTEXT_FABRIC_DIRECT_LLM_PROVIDER`, or `"mock"`; it chooses model from
  `direct_llm.model`, `CONTEXT_FABRIC_DIRECT_LLM_MODEL`, or the `model_alias`
  string. A routing alias can therefore become a model name while provider,
  base URL, and credential env come from unrelated Context Fabric defaults.
- The governed-stage adapter computes `executionPosture =
  "context-fabric-direct"` when the final turn reports
  `llm_route="context-fabric-direct"` and stores that in
  `correlation.executionPosture`.
- The same adapter also returns top-level `executionPosture: "governed"`.
  `AgentTaskExecutor` persists `result.executionPosture ??
  result.correlation.executionPosture`, so the top-level `"governed"` masks the
  direct-route evidence.
- Existing `governed-execute-adapter.test.ts` covers governance mode, status
  mapping, token totals, warnings, and receipt digests, but no searched test
  asserts that a Context Fabric direct turn remains visible as
  `context-fabric-direct` in the final `AgentRun` correlation.

Impact:

- Operators can configure a routed LLM connection and believe the Agent Task is
  using that provider/model, while Context Fabric may call a different env
  default or mock provider.
- Cost, readiness, evidence packs, and run insights can report an alias without
  proving which provider credential and base URL were actually used.
- Direct-provider execution is an explicit governance posture because it bypasses
  MCP and the LLM gateway, but the persisted AgentRun evidence can label it as
  plain `governed`.
- Auditors cannot reliably distinguish normal governed gateway/runtime calls from
  Context Fabric direct calls by reading the WorkGraph-side execution posture.

Required fixes:

- Resolve LLM routing to an immutable connection snapshot, not just an alias,
  before any direct-provider Agent Task call.
- Pass provider, model, base URL, credential env name, connection id, routing rule
  id, tenant id, and configuration digest to Context Fabric; never rely on
  unrelated Context Fabric env defaults unless the node explicitly selected a
  named default.
- Fail closed when the selected routing alias is missing, disabled, cross-tenant,
  not ready, or incompatible with `context_fabric_direct`.
- Preserve `context-fabric-direct` as both top-level and correlation
  `executionPosture` in `governedStageRespToExecuteResp(...)`.
- Add tests for routed direct Agent Task execution, missing alias, alias/provider
  mismatch, mock fallback prevention, and persisted run evidence showing the
  direct route, provider, model, credential env name, and routing snapshot.

### 99. Single-capability initiatives need rollout and drift visibility

Evidence:

- `SpecificationProject` now stores required `primaryCapabilityId` and
  `primaryCapabilityName`.
- `SpecificationProjectCapability` stores its own `capabilityId` and
  `capabilityName`, and now has a unique `projectId` relation so each initiative
  can have at most one persisted capability link.
- The single-capability migration backfills `primaryCapabilityId`, deletes
  non-primary relation rows, enforces `role = PRIMARY`, and creates a unique
  index on `specification_project_capabilities(projectId)`.
- The current working tree adds deferred database triggers
  `trg_specification_projects_single_capability` and
  `trg_specification_project_capabilities_single_capability`. At commit time
  they require exactly one `PRIMARY` link and require that link's `capabilityId`
  to equal the parent project's `primaryCapabilityId`.
- Prisma has no foreign key from `SpecificationProject.primaryCapabilityId` or
  `SpecificationProjectCapability.capabilityId` to `capabilities_cache` or IAM,
  so catalog existence/active-state is still enforced in the API path rather
  than directly by the database.
- `shapeProject(...)` filters `capabilityLinks` and `impactAssessments` down to
  rows matching `primaryCapabilityId`, then returns
  `assignedCapability` directly from the project row. The new trigger prevents
  future relation drift once the migration is applied, but existing deployments
  need an explicit health check to prove they have the trigger installed and no
  historical drift remains.
- `runCapabilityImpactAssessments(...)` also falls back to the project row's
  `primaryCapabilityId` when the matching relation row is absent, masking the
  missing/mismatched link in databases where the new migration has not yet been
  applied.
- Existing schema/migration tests now assert one project link, primary-only
  role, the deferred trigger names, and the equality check, but there is not yet
  an integration test that applies the migration to a live Postgres instance and
  proves mismatched writes fail at commit.

Impact:

- Freshly migrated databases should reject future initiative/capability drift,
  but old local/cloud databases may still be missing the trigger until migrations
  are applied.
- Capability impact assessment, WorkItem generation, routing, and audit evidence
  can still be confusing if old impact assessment rows or WorkItems disagree
  with the initiative's assigned capability.
- Operators do not yet have a doctor/readiness check that says "all initiatives
  are single-capability clean" or identifies records that need repair.

Required fixes:

- Apply the new single-capability migration everywhere before treating the
  Synthesis Studio model as enterprise-ready.
- Add a health/doctor check that reports initiatives whose project primary
  capability, relation row, impact assessment row, generated WorkItems, and
  generation-plan target scopes disagree.
- Change API shaping to surface invariant violations as an operator-visible
  `dataIntegrityWarnings` field instead of silently filtering mismatched rows.
- Add live Postgres integration tests for mismatched relation rows, missing
  relation rows, stale impact rows, and update transactions that change the
  primary capability.

### 100. Manual WorkItem attachment can bypass the initiative capability boundary

Evidence:

- `POST /studio/projects/:projectId/work-items/:workItemId` calls
  `attachWorkItem(projectId, workItemId, userId)`.
- `attachWorkItem(...)` loads the project only through `getProject(projectId)`,
  then loads the WorkItem by id and tenant with a select containing only
  `{ id, projectId }`.
- The attachment guard only rejects a WorkItem that is already attached to a
  different project.
- The update then sets `WorkItem.projectId = projectId` without comparing the
  WorkItem's `parentCapabilityId` or any `WorkItemTarget.targetCapabilityId`
  with the project's `primaryCapabilityId`.
- `workItemCardSelect` used by Synthesis project WorkItem lists includes id,
  workCode, title, status, urgency, projectId, and timestamps, but not
  parent/target capability information.
- The portfolio landing also exposes `standaloneWorkItems` from all unattached
  tenant WorkItems with the same limited card shape.
- Finding #77 already covers generation plans routing new work outside the
  initiative capability; this is a separate manual attachment path for existing
  WorkItems.

Impact:

- A single-capability initiative can manually collect WorkItems owned by or
  targeted at other capabilities.
- Synthesis budget, claims, impact assessment, traceability, and WorkItem
  evidence can appear under the initiative while execution and authorization
  belong to a different capability.
- The UI has too little capability metadata to warn the user before or after
  attachment.
- Capability-scoped dashboards and audits may count work under the wrong
  initiative/capability relationship.

Required fixes:

- On attach, load the project `primaryCapabilityId` and the WorkItem's
  `parentCapabilityId` plus all target capabilities in the same tenant-scoped
  transaction.
- Reject mismatches by default, or require an explicit governed
  cross-capability exception record with reason, approver, expiry, and evidence.
- Include parent/target capability labels in `workItemCardSelect` so Synthesis
  can show compatibility and warnings.
- Add tests for attaching a matching WorkItem, mismatched parent capability,
  mismatched target capability, multi-target WorkItems, already-attached
  WorkItems, and cross-tenant direct ids.

### 101. Portfolio execution writes use generic Studio permissions for financial and approval-sensitive actions

Evidence:

- `app.ts` mounts `portfolioExecutionRouter` at `/api/studio` behind
  `authMiddleware, studioAuthz`.
- `studio-authz.ts` maps every Studio write to `workflow:update` on
  `__platform__`; it does not evaluate the target initiative, owning capability,
  budget authority, sponsor role, or decision-resource grant.
- `portfolio-execution.router.ts` exposes high-impact write routes under that
  generic gate:
  - `POST /projects/:projectId/decisions`
  - `POST /decisions/:dossierId/options`
  - `POST /projects/:projectId/compile`
  - `POST /change-requests/:changeRequestId/transition`
  - `PUT /tenant-budget`
  - `PUT /projects/:projectId/budget-envelope`
- `requestDecisionReviewInternal(...)` calls `assertCanRequestApproval(...)`, but
  the other routes listed above do not call a resource-specific authorization
  helper before mutating decision dossiers, compiling a specification version,
  approving/rejecting/applying a change request, or changing budget limits.
- `transitionChangeRequestInternal(...)` prevents author self-approval, but it
  does not prove the actor has sponsor, portfolio, finance, or capability-owner
  permission for the change request's initiative.
- `upsertTenantBudgetInternal(...)` can change tenant-wide cost/token limits and
  model fallback aliases after only the generic Studio write gate.
- Tests cover decision self-approval, approved change-request coverage, pilot
  readiness, and budget-control math, but no searched test exercises unauthorized
  tenant-budget updates, project budget envelope updates, compile requests, or
  change-request transitions by a normal Studio editor.

Impact:

- A user who can broadly edit Studio/workflow content may be able to alter
  tenant-level budgets, project budget envelopes, sponsor-sensitive change
  requests, and compiled execution contracts.
- Budget thresholds and model-economy aliases affect runtime behavior and cost
  posture; they should not share the same permission as editing a Synthesis
  board or initiative text.
- Change-request approval and specification compilation are governance acts, but
  the current route layer does not enforce independent sponsor/portfolio
  authority except in the separate decision-review request path.
- Enterprises cannot clearly separate product authors, workflow designers,
  finance controllers, sponsors, approvers, and auditors.

Required fixes:

- Add explicit portfolio permissions such as `portfolio:budget:view`,
  `portfolio:budget:manage`, `portfolio:decision:create`,
  `portfolio:decision:review_request`, `portfolio:specification:compile`,
  `portfolio:change_request:approve`, and
  `portfolio:change_request:apply`.
- Resolve the project/change-request/dossier before mutation, then authorize
  against the initiative's tenant and `primaryCapabilityId`.
- Require finance or tenant-admin authority for `PUT /tenant-budget`; require
  project owner/capability owner or finance authority for project budget
  envelopes.
- Route change-request approval/rejection through the same approval-request
  machinery used elsewhere, or add an equivalent live authorization decision and
  audit record.
- Add route-level negative tests for ordinary viewer/editor users attempting
  tenant-budget changes, project budget updates, spec compilation, decision
  mutation, and change-request transitions.

### 102. Business Alignment exports expose sponsor, spend, and decision evidence through broad view access

Evidence:

- `app.ts` mounts `businessAlignmentRouter` behind `authMiddleware,
  studioAuthz`.
- `studio-authz.ts` maps every Studio read to `workflow:view` on `__platform__`;
  it does not evaluate finance, sponsor, audit, export, or owning-capability
  permissions.
- `business-alignment.router.ts` exposes export endpoints under that broad read
  gate:
  - `GET /business-alignment/projects/:projectId/exports/jira.csv`
  - `GET /business-alignment/projects/:projectId/exports/traceability.xlsx`
  - `GET /business-alignment/projects/:projectId/exports/spend.xlsx`
  - `GET /business-alignment/projects/:projectId/exports/signed-readouts.:format`
  - `GET /business-alignment/projects/:projectId/exports/decision-log.:format`
- `business-alignment.exports.ts` writes sensitive business data into those
  artifacts:
  - traceability export includes objectives, value scores, funding lines,
    WorkItem ids/status, reconciliation status, verdicts, and evidence JSON.
  - spend export includes objective owners, funding lines, estimated/actual cost,
    token totals, and plan rows.
  - signed-readout export includes content hash, signer/approver id, approval
    request id, signed timestamp, and the full signed readout markdown.
  - decision-log export includes decision authors, decision owners, approval
    ids/statuses, rejected alternatives, trade-offs, and approval decision rows.
- The export code tenant-filters by project, but it does not redact fields or
  require a stronger export/audit/finance/sponsor permission.
- Existing searched tests cover business-alignment calculations and document
  generation helpers, but not role-based export denial, redacted export variants,
  or audit events for downloading signed business evidence.

Impact:

- A broad Studio viewer may download finance, sponsor, decision, and delivery
  evidence that should often be restricted to sponsors, auditors, portfolio
  leads, finance controllers, or owning-capability members.
- Exported files leave the platform boundary, so missing read authorization and
  download auditing are more serious than an on-screen table leak.
- Signed readouts and decision logs are intended as evidence, but the platform
  cannot prove who was authorized to export them or whether a redacted view would
  have been sufficient.

Required fixes:

- Add explicit export permissions such as `business:export:traceability`,
  `business:export:spend`, `business:export:signed_readouts`, and
  `business:export:decision_log`.
- Resolve project ownership and authorize exports against tenant,
  `primaryCapabilityId`, sponsor/finance/auditor role, and export type before
  generating the artifact.
- Add redacted/default export modes for normal viewers, with full evidence
  exports reserved for privileged roles.
- Record audit events containing actor, tenant, project, export type, format,
  row/document counts, and trace id for every export download.
- Add browser/API tests proving normal viewers cannot export sensitive business
  artifacts while authorized sponsors/auditors can.

### 103. Runtime input contracts are presence-only and not uniformly collected

Evidence:

- `runtime-inputs.ts` derives workflow launch inputs from node placeholders and
  workflow variables, including semantic kinds such as `user`, `team`, `role`,
  and `skill`.
- `cloneDesignToRun.ts` now calls `missingRuntimeInputs(...)` before cloning a
  workflow run, so missing launch values fail before the run is created.
- `missingRuntimeInputs(...)` only checks for `undefined`, `null`, or empty
  strings. It does not validate the value type, dotted-path shape, user/team
  existence, IAM role membership, skill existence, capability scope, or whether
  the selected value is usable by the node that requested it.
- `assignment.ts` resolves placeholders for Human Task, Approval, and
  Consumable routing, but it explicitly stamps the resolved user/team/role/skill
  values and leaves eligibility to inbox/decision-time resolution.
- `TaskAssignment.assignedToId` has no Prisma relation to a user, and
  `TeamQueueItem` stores `roleKey`, `skillKey`, and `capabilityId` as free
  strings.
- Several start surfaces still post only `childWorkflowTemplateId`:
  - Platform Web `WorkflowManager.tsx`
  - WorkGraph `WorkItemsPage.tsx`
  - WorkGraph `RunViewerPage.tsx`
- Event fan-out creates WorkItems from payload mapping and calls
  `routeWorkItem(...)`; there is no checked mapping from incoming event fields
  into the derived workflow launch-input contract before `AUTO_START`.

Impact:

- A run can be blocked before creation with a raw missing-input error, but the
  normal UI still does not consistently provide the generated launch form that
  would let the operator fill every node-specific value.
- A run can start with syntactically present but invalid selectors, then later
  create an approval/task that nobody can see or approve until an operator
  diagnoses the bad user/team/role/skill value.
- Event-driven `AUTO_START` workflows can fail or stall when the inbound event
  does not satisfy the workflow's runtime input contract, even though the trigger
  itself matched.

Required fixes:

- Add a server validator for runtime inputs that checks kind-specific values:
  user/team/role/skill existence, tenant membership, capability scope, JSON
  validity, numeric/boolean coercion, and dotted-path syntax.
- Expose validation errors from `GET /workflow-templates/:id/runtime-inputs` or
  a companion `POST /runtime-inputs/validate` endpoint so the UI can validate
  before start.
- Wire every start surface to the runtime-input contract endpoint and submit
  captured `vars`, `globals`, and `params`, grouped by node.
- Require WorkItem triggers/routing policies in `AUTO_START` mode to map event
  payload fields into the required launch inputs, or dead-letter the event with a
  clear `MISSING_RUNTIME_INPUT` / `INVALID_RUNTIME_INPUT` reason.
- Add tests for valid launch inputs, invalid users/teams/roles/skills, invalid
  JSON/number/boolean values, UI start payloads, and event-driven auto-start
  payload mapping.

### 104. URL-document agent skills are locked but not content-pinned

Evidence:

- `agent.service.ts` correctly validates `url_document` source URLs and forces
  URL/uploaded-document profile bindings into read-only/provider-locked
  permissions.
- For uploaded documents, `createProfile(...)` extracts file text and persists a
  `CapabilityKnowledgeArtifact` with `contentHash`, so Prompt Composer can
  retrieve actual document content later.
- For URL documents, `createProfile(...)` only calls
  `persistProfileKnowledgeSource(...)`, stores a `CapabilityKnowledgeSource`,
  and records `sourceArtifact = { kind: "knowledge_source", id, sourceRef }` on
  the skill binding.
- `persistProfileKnowledgeSource(...)` writes `pollIntervalSec: null` for these
  source-backed agent URLs and also resets existing rows back to `null`.
- The capability poll worker only fetches URL knowledge rows where
  `CapabilityKnowledgeSource.pollIntervalSec IS NOT NULL`.
- Prompt Composer's semantic knowledge retrieval reads from
  `CapabilityKnowledgeArtifact`; it does not fetch from
  `CapabilityKnowledgeSource` during prompt assembly.
- The `AGENT_SKILL_SOURCES` layer shows the source type/ref and permissions, but
  it does not include fetched URL-document content, a content hash, final URL, or
  source version.

Impact:

- A URL-backed agent skill can appear correctly attached, read-only, and
  provider-locked while the model only receives a URL reference rather than the
  document content the user expected the agent to read.
- Because no content snapshot/hash is pinned for URL-document skills, a later
  document change can silently change what the URL means without an agent-profile
  version, receipt, or prompt-contract change.
- The UI can imply "read-only knowledge" while runtime evidence cannot prove
  which URL body, redirect target, or extracted text influenced the agent.

Required fixes:

- On URL-document profile creation, fetch and extract the document into a
  `CapabilityKnowledgeArtifact` snapshot or immediately call a guarded
  `syncKnowledgeSourceNow(...)` path before returning success.
- Store final URL, fetch timestamp, media type, extraction status,
  `contentHash`, artifact id, and source version in the agent skill binding
  metadata and in `resolveProfile(...)` evidence.
- Decide whether URL profile sources are static snapshots or polled sources; if
  they are polled, require an explicit poll interval and record each refresh as a
  new version with audit evidence.
- Make Prompt Composer surface a warning or block when an agent has a
  URL-document binding whose referenced content has not been materialized.
- Add tests proving a URL-document profile creates readable prompt context,
  emits content-hash evidence, and fails closed or clearly warns when extraction
  has not completed.

### 105. Idea Board collaboration controls are not first-class governed records

Evidence:

- `BoardCanvas.tsx` exposes Miro-like collaboration controls: `Private`,
  `Collaborate`, `Vote`, `Facilitate`, `Details`, comments, replies, and
  printable/export actions.
- Board comments and replies are stored by patching the selected board object
  with a free-form `comments` array; there is no `BoardComment` Prisma model,
  comment thread route, mention route, notification route, or per-comment
  authorization/audit row.
- The comment author is hard-coded in the client as `"You"` for both new
  comments and replies, instead of using the authenticated actor identity from
  the API.
- Dot voting in the board increments a free-form `votes` property on board
  objects. `BoardEvent` can persist the resulting object patch, but the platform
  does not know which user voted, whether a user voted twice, whether a vote was
  withdrawn, or whether a voting session was open.
- `FacilitationDrawer` timer state and `voteMode` are component state in
  `BoardCanvas`; they are not persisted as board/session events and are not
  visible to a user who reloads, joins another browser, or lands on another API
  instance.
- `studio-presence.service.ts` explicitly stores presence in an in-memory,
  per-process `Map` and notes that multi-instance deployments would need a
  shared store.
- Prisma contains durable `ConceptCardVote`, `SpecComment`, `TaskComment`, and
  `WorkComment` models for adjacent domains, but the Idea Board collaboration
  surface does not use equivalent board-scoped collaboration records.

Impact:

- The Idea Board looks like a collaborative workshop surface, but key workshop
  artifacts are either opaque board-object JSON or process/browser-local state.
- Operators cannot audit who commented, replied, voted, started a timer, opened
  a voting session, or changed consensus.
- Mentions and comments cannot drive notifications, task assignments, approval
  requests, or evidence packs because they are not first-class records.
- Multi-instance or cloud deployments can show inconsistent live collaborators
  and facilitation state even while the board content itself is durable.
- Voting results can be skewed by repeated clicks or object edits because votes
  are a scalar property, not actor-scoped decisions.

Required fixes:

- Add board-scoped collaboration models and APIs for comments, replies,
  mentions, reactions/votes, voting sessions, facilitation timers, and session
  decisions.
- Store actor id, tenant id, board id, branch/head event sequence, object id,
  created/edited/deleted timestamps, and trace id for each collaboration record.
- Make board votes actor-scoped and session-scoped with server-side uniqueness,
  withdrawal, and immutable tally evidence.
- Persist facilitation state as board events or session records so late joiners,
  reloads, and multi-instance deployments see the same timer/voting state.
- Back presence with Redis/Postgres pub-sub or another shared runtime store for
  multi-instance deployments, while keeping it explicitly ephemeral in evidence.
- Wire comment mentions to platform notifications/access checks and include
  accepted comments/voting-session summaries in Synthesis evidence packs.
- Add tests for comment identity, mention notification, vote uniqueness,
  timer persistence, reload behavior, multi-instance presence, and evidence
  export inclusion.

### 106. Runtime setup scripts disagree about LLM secret loading and provider readiness

Evidence:

- `bin/mcp-runtime-setup.sh connect` treats `.env.llm-secrets` as the client-side
  provider secret store. It writes `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `OPENROUTER_API_KEY`, and legacy `COPILOT_TOKEN` there, then starts the laptop
  LLM Gateway by explicitly injecting those variables into the gateway process.
- `bin/laptop-bridge.sh` and `bin/laptop.sh` also load `.env.llm-secrets` before
  starting the local gateway/MCP runtime.
- `bin/check-deployment-env.sh` loads `.env`, `.env.local`, `.env.laptop`, and
  `.env.llm-secrets`, then validates `DEFAULT_PROVIDER`: `mock` requires no key,
  while `anthropic`, `openai`, and `openrouter` require their matching secret.
- `bin/runtime-preflight.sh` only loads `.env.laptop` and `.env.local`. It marks
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `COPILOT_TOKEN` as optional and does
  not validate the selected `DEFAULT_PROVIDER` against the key store.
- `bin/bare-metal-runtime.sh` also loads only `.env.local` / runtime env state
  for its normal `up` path, while it is still documented and exposed as a way to
  start the optional local LLM Gateway and MCP runtime.
- `bin/mcp-runtime-setup.sh` can silently fall back to another enabled provider
  or `mock` when the requested `DEFAULT_PROVIDER` is absent from the generated
  provider catalog. That is convenient for demos, but dangerous for a user trying
  to prove Copilot/Anthropic/OpenAI-compatible readiness from a fresh clone.

Impact:

- The same laptop can pass one deployment check and fail another depending on
  which script the operator used, because the scripts do not share one secret
  loading and provider-readiness contract.
- A user can run `bin/mcp-runtime-setup.sh connect --default-provider anthropic`
  without a usable Anthropic key, then accidentally run with `mock` or another
  provider while believing the requested provider is active.
- `bin/bare-metal-runtime.sh up` can start a local LLM Gateway without the
  provider keys that `bin/mcp-runtime-setup.sh` previously wrote to
  `.env.llm-secrets`, unless those keys also happen to be exported in the shell.
- Fresh-clone, two-terminal tests for “server apps in one terminal, MCP+LLM in
  another” remain brittle because the setup, preflight, and runtime launchers do
  not validate the same inputs or fail for the same reasons.

Required fixes:

- Introduce one shared runtime env loader contract for `.env.laptop`,
  `.env.llm-secrets`, and `.env.local`, with deterministic precedence and no
  secret value printing.
- Make `bin/runtime-preflight.sh` provider-aware: validate `DEFAULT_PROVIDER`,
  required provider key, provider catalog entry, model catalog alias, runtime
  JWT claims, and Context Fabric bridge status consistently.
- Make `bin/bare-metal-runtime.sh up` load `.env.llm-secrets` for the LLM Gateway
  process while keeping provider secrets out of server-app env files.
- Make `bin/mcp-runtime-setup.sh connect --default-provider <provider>` fail
  closed if the selected provider key is missing, unless the user passes an
  explicit demo flag such as `--allow-mock-fallback`.
- Add script contract tests that exercise `mock`, `anthropic`, `openai`, and
  `openrouter` across `mcp-runtime-setup`, `bare-metal-runtime`,
  `runtime-preflight`, and `check-deployment-env`.

### 107. Demo launcher still points users at Postgres 14 while the platform standard is PG16/pgvector

Evidence:

- `bin/setup.sh` tells bare-metal users the platform needs "PG 16 + pgvector"
  and suggests `brew services start postgresql@16` when the configured database
  cannot be reached.
- Docker core and Compose use `pgvector/pgvector:pg16` for the shared
  application/IAM Postgres image, and `bin/docker-core.sh` preflights the same
  PG16 pgvector image.
- `bin/bare-metal.sh` creates the application databases and immediately enables
  `vector` in `singularity`, `singularity_composer`,
  `singularity_context_fabric`, and `singularity_claim_registry`.
- `bin/demo-up.sh` still auto-starts `brew services start postgresql@14` when
  `localhost:5432` is unavailable.
- `bin/demo-down.sh` says it leaves "Homebrew Postgres@14" running and tells
  users to stop it with `brew services stop postgresql@14`.

Impact:

- Fresh-clone demo users get conflicting installation guidance: the normal setup
  path says PG16, while the demo path tries to revive PG14.
- An office laptop can accidentally run the demo against a different Homebrew
  major version than the one used by Docker, setup docs, and pgvector testing.
- Failures from missing pgvector, version-specific extension packaging, or a
  shadowed local `:5432` database look like seed/app/runtime bugs instead of a
  clear database-prerequisite mismatch.
- The demo scripts can make troubleshooting worse by starting the wrong local
  Postgres service behind the operator's back.

Required fixes:

- Remove hard-coded `postgresql@14` from `bin/demo-up.sh` and `bin/demo-down.sh`.
- Reuse the same Postgres prerequisite detection as `bin/setup.sh`, including
  configured host/port/user and pgvector extension readiness.
- Prefer `postgresql@16` in Homebrew suggestions, while explicitly allowing PG17
  only after a live pgvector + schema smoke passes.
- Refuse to auto-start an unconfigured database major version; print the exact
  command based on detected/installable Homebrew services instead.
- Add a setup contract check that fails when setup docs, demo scripts, Docker
  images, and topology checks disagree on the supported Postgres major/version
  family.

### 108. Platform notifications have durable backend records but the web shell mostly uses local fallback state

Evidence:

- WorkGraph has durable notification tables and routes:
  `WorkNotification`, `NotificationPreference`, `NotificationSubscription`,
  `NotificationDelivery`, and `NotificationAudit`, plus
  `/api/notifications` and `/api/collaboration/preferences`.
- Platform Web normally reaches WorkGraph through the catch-all Next proxy under
  `/api/workgraph/:path*`.
- `NotificationCenter.tsx` fetches durable notifications from
  `/api/notifications?status=UNREAD&limit=50`, and posts read/resolve/snooze
  actions to `/api/notifications/:id/...`.
- Platform Web has no local `src/app/api/notifications` route, and
  `next.config.mjs` has no rewrite for `/api/notifications`. Therefore those
  topbar durable-inbox calls can return the Next 404 route instead of WorkGraph.
- The notification center swallows durable inbox failures and falls back to
  adoption-health-derived notifications, so the bell can look alive while hiding
  real workflow/approval/mention notifications.
- `SettingsPage` saves notification category toggles locally via
  `saveNotificationPreferences(next)` and then posts `{ categories: next }` to
  `/api/workgraph/collaboration/preferences`.
- WorkGraph `collaboration.router.ts` validates preferences with a schema that
  accepts `channels`, `digestMode`, `quietHours`, `severityMin`, and `timezone`,
  but not `categories`. Category toggles therefore remain browser-local or are
  silently discarded/ignored by the server validation path.
- Existing Platform Web contract tests assert that notification state uses stable
  `localStorage` keys and that the drawer reacts to local state, but they do not
  assert a working durable `/api/workgraph/notifications` path or server-persisted
  category preferences.

Impact:

- Users can miss approval, mention, escalation, WorkItem finalization, and
  governance notifications even though WorkGraph created durable records.
- Read, snooze, and resolve actions may update local browser state only; another
  browser, device, or refresh after storage reset can show stale notification
  state.
- Settings imply platform-level notification preferences, but category toggles
  are not reliably tenant/user durable.
- Operators cannot trust the topbar unread count as an enterprise inbox signal.

Required fixes:

- Route durable notification reads and mutations through
  `/api/workgraph/notifications` or add explicit Next proxy routes for
  `/api/notifications`.
- Update `NotificationCenter.tsx` to fail visibly when durable inbox access fails
  after auth succeeds, while still showing health-derived setup signals as a
  separate section.
- Add `categories` to the WorkGraph notification preference schema and persist
  category preferences in `NotificationPreference.categories`.
- Load notification preferences from WorkGraph first, then mirror to localStorage
  only as an offline cache.
- Add tests proving unread count, read/resolve/snooze, category preferences, and
  mention/approval notifications survive reloads and work through Platform Web's
  Next proxy.

### 109. Notification delivery rows have no channel dispatcher

Evidence:

- `createNotification(...)` creates durable `NotificationDelivery` rows for the
  resolved channel list, defaulting to `IN_APP` and accepting policy/preference
  channels such as `EMAIL`, `SLACK`, `TEAMS`, `WEBHOOK`, and `MOBILE`.
- The Prisma schema stores delivery state in `notification_deliveries` with
  `status`, `attempts`, `providerId`, `lastError`, `nextAttemptAt`, and
  `deliveredAt`.
- `retryNotificationDelivery(...)` only updates a delivery back to `PENDING`,
  clears `lastError`, increments `attempts`, and writes a `DELIVERY_RETRY`
  audit row.
- Repository search finds no worker/processor that queries pending
  `NotificationDelivery` rows, claims them, invokes connector adapters, marks
  them delivered/failed, schedules retries, or writes delivery audit entries.
- `notify.router.ts` has direct fire-and-forward endpoints for
  `/api/notify/email` and `/api/notify/teams`, but those endpoints call
  connector adapters synchronously from the request and do not consume
  `notification_deliveries`.
- `docs/roadmap-gap-closure.md` describes delivery rows as claimable by channel
  workers, but those workers are not present in the current WorkGraph API source.

Impact:

- Users can configure non-`IN_APP` notification channels and believe approvals,
  escalations, mentions, or governance notices will reach email/Teams/Slack/etc.,
  while the platform only stores pending rows.
- Operator retry controls may give false confidence: retrying a failed delivery
  simply returns it to a queue that no process drains.
- There is no at-least-once delivery evidence, backoff, dead-lettering,
  provider-id capture, or delivered timestamp for enterprise notification
  channels.
- Approval/escalation SLAs can be missed because out-of-app delivery is not
  actually connected to the durable notification model.

Required fixes:

- Add a `NotificationDeliveryDispatcher` with lease/claim fencing,
  `nextAttemptAt` scheduling, max-attempt handling, dead-letter status, and
  per-delivery audit events.
- Route `EMAIL`, `TEAMS`, `SLACK`, and `WEBHOOK` deliveries through the existing
  connector adapters, and explicitly mark unsupported channels such as `MOBILE`
  as disabled or pending-platform-support.
- Make retry move a failed/dead-lettered row into the dispatcher queue without
  incrementing attempts until the next send attempt is actually claimed.
- Surface delivery health in Operations and notification detail UI, including
  pending/failed/dead-lettered counts by channel and tenant.
- Add tests that create an approval/mention notification with external channels,
  prove a dispatcher sends or fails it deterministically, and prove retry does
  not duplicate already delivered messages.

### 110. Collaboration and notification operations are authenticated but not resource-authorized

Evidence:

- `app.ts` mounts `/api/collaboration` with `authMiddleware` only, unlike Studio
  routes that also use `studioAuthz` or workflow routes that call typed
  workflow/capability permission helpers.
- `collaboration.router.ts` exposes comment read/write/resolve, notification
  preferences, subscriptions, delegations, notification audit, and delivery retry
  under that authenticated router.
- `assertCommentEntity(...)` checks that a target `WorkflowInstance`,
  `WorkItem`, `WorkflowNode`, `ApprovalRequest`, or `Document` row exists in the
  tenant context, but it does not check `workflow:view`, `artifact:view`,
  `approval:view`, `workflow:comment`, or any equivalent resource permission.
- `listComments(...)` returns every comment for the entity after the existence
  check, and `createComment(...)` writes a comment and mention notifications
  without proving the caller can view or comment on that entity.
- Mention notification creation resolves users by id/email and creates a
  notification with the entity type/id route, but it does not verify that the
  mentioned user is allowed to view the underlying entity.
- `createSubscription(...)` accepts arbitrary `teamId`, `entityType/entityId`,
  `capabilityId`, or `workflowId` and persists a subscription for the caller
  without validating target existence, caller access to the target, or caller
  authority to subscribe a team.
- `notificationAudit(...)` and `retryNotificationDelivery(...)` allow access when
  a notification has `userId = null`; they do not check team membership,
  operations permission, or a notification-administration permission.
- `createDelegation(...)` only checks date ordering and self-delegation. It does
  not verify the delegate user exists, belongs to the same tenant, or is eligible
  to receive delegated approvals/tasks.

Impact:

- Any authenticated tenant user may be able to infer or participate in comments
  on workflow resources they should not see, as long as they know or guess the
  entity id.
- Mentions can leak private run/work-item/document identifiers to users who do
  not have access to the underlying resource.
- Team or capability notification subscriptions can be created without the
  authority to administer that team/capability, causing notification spam or
  visibility drift.
- Delivery retry and notification audit can become operational controls exposed
  to broad users instead of notification/workflow operators.
- Out-of-office delegation can point to invalid or unauthorized users, then later
  make approval routing ambiguous or unsafe.

Required fixes:

- Add a collaboration authorization service that maps
  `entityType/entityId + action` to the existing workflow, WorkItem, approval,
  artifact/document, and capability permission helpers.
- Require explicit actions such as `comment:view`, `comment:create`,
  `comment:resolve`, `notification:subscribe`, `notification:audit_view`,
  `notification:retry_delivery`, and `delegation:manage`.
- Validate subscription targets and team/capability administration authority
  before creating or listing subscriptions.
- Verify mentioned users and delegated users are active members of the same
  tenant and have at least view/inbox eligibility for the referenced resource
  before sending them entity-linked notifications.
- Add IDOR tests for comments, subscriptions, notification audit, delivery retry,
  and delegation across two users, two teams, two capabilities, and two tenants.

### 111. Platform settings and onboarding state are browser-local, not account or tenant durable

Evidence:

- `SettingsPage` defines `SETTINGS_KEY = "singularity.platform.settings.v1"`
  and stores `deploymentMode`, `defaultStartRoute`, and `evidenceMode` through
  `window.localStorage`.
- The settings UI presents those values under "Platform Settings", including
  deployment mode and workflow evidence defaults, but the backing type is
  `LocalSettings` and `saveSettings(...)` only writes browser storage.
- The page text explicitly says deployment mode is "used by setup copy and
  onboarding hints in this browser" and evidence mode is "stored locally for
  launch defaults while backend workflow preferences are introduced."
- `/api/onboarding/state` stores onboarding state in a base64url cookie named
  `singularity_onboarding_state`. It tracks `deploymentMode`,
  `completedSteps`, `dismissedTips`, `preferredIntent`, and
  `preferredModelAlias`, but it is not bound to a user/tenant settings record.
- `/start` posts onboarding state to `/api/onboarding/state`; if persistence
  fails, it catches the error and keeps only in-memory state.
- Repository search finds no general `PlatformSetting`, `UserSetting`,
  onboarding, deployment-mode, default-start-route, or evidence-mode model in
  WorkGraph or IAM. The only durable preference model found in this area is the
  notification-specific `NotificationPreference`.
- `NotificationPreference` does not cover platform launch defaults, setup mode,
  evidence strictness, dismissed onboarding steps, or preferred model/intent.

Impact:

- A user's setup mode, launch default, evidence mode, and onboarding completion
  can differ by browser, tab profile, or cookie/localStorage reset.
- Admins cannot preconfigure tenant defaults for Docker, bare-metal, or
  split-runtime deployment guidance.
- Strict evidence mode can appear selected in the UI without becoming an
  authoritative workflow launch policy or auditable tenant preference.
- Support and onboarding flows cannot reliably know whether a user has completed
  setup, dismissed a warning, or intentionally selected a provider/model path.
- The settings surface looks like a platform control plane but currently mixes
  durable backend health with local-only preferences, which creates operator
  trust drift.

Required fixes:

- Add tenant/user durable settings records, separating personal preferences from
  tenant/admin policy.
- Move `deploymentMode`, `defaultStartRoute`, `evidenceMode`,
  `preferredIntent`, `preferredModelAlias`, completed setup steps, and dismissed
  tips behind authenticated settings APIs.
- Keep localStorage/cookies only as short-lived UI caches, with server state as
  the source of truth after sign-in.
- Make strict evidence mode a real workflow launch option or remove it from
  platform-level settings until the backend enforces it.
- Add admin-managed tenant defaults for setup/deployment mode and user-level
  overrides where safe.
- Add cross-browser tests proving settings and onboarding state survive reloads,
  a different browser session, and localStorage/cookie deletion after login.

### 112. Synthesis capability impact briefs are not strictly bound to a real active capability agent

Evidence:

- The Synthesis hub labels the assessment action as "Refresh
  capability-agent assessment" and tells users that "the assigned capability
  agent is preparing an impact brief."
- `runCapabilityImpactAssessments(...)` selects the initiative's stored primary
  capability link, then calls `listAgentTemplates(authHeader, { capabilityId,
  limit: 100 })`.
- If no exact active template is returned, it falls back to any active template
  from that response; if no template is found at all, it still creates or updates
  `CapabilityImpactAssessment` with `agentTemplateId: undefined` and
  `agentTemplateName` set to a synthetic
  `${capabilityName} impact analyst` label.
- The assessment then calls `contextFabricClient.executeGovernedTurn(...)` with
  `agent_template_id: input.agentTemplateId`, which can be absent.
- The prompt still says `You are ${agentName}, representing the
  ${capabilityName} capability`, even when `agentName` is not a real published
  agent template.
- `CapabilityBrief` renders `item.agentTemplateName` when present, so the UI can
  show a plausible "impact analyst" identity that was not actually resolved to a
  governed agent profile/template.
- Existing `studio-impact-assessment.test.ts` covers JSON parsing only. It does
  not assert that a missing/inactive agent template blocks the assessment or is
  rendered as an explicit fallback mode.

Impact:

- Users can believe a capability-owned agent reviewed the initiative when the
  platform actually ran a generic governed turn with a synthetic role label.
- Capability impact evidence lacks a strong link to the agent profile,
  instructions, skills, permissions, and version that supposedly produced the
  assessment.
- A capability with no active agent template can still produce recommendations,
  risks, and suggested claims, making adoption demos look smoother but weakening
  enterprise auditability.
- Later disputes cannot prove which agent contract, prompt profile, or skill
  policy was responsible for a capability suggestion.

Required fixes:

- Decide and encode the product rule: either capability impact assessment
  requires an active published agent template, or it is explicitly a generic
  fallback assessment.
- In strict/enterprise mode, fail closed before the LLM call when no active
  template is resolved for the assigned capability.
- If fallback mode remains allowed for demos, store `assessmentMode =
  GENERIC_FALLBACK`, render that visibly in the UI, and exclude it from
  capability-agent evidence claims.
- Persist the resolved agent template/profile version, prompt source, skill
  source metadata, and permission snapshot on `CapabilityImpactAssessment`.
- Add tests for exact template match, inactive template, no template, fallback
  demo mode, and strict-mode failure before Context Fabric invocation.

### 113. Synthesis promotion stops at claims/free-form refs instead of creating a governed execution handoff

Evidence:

- The Miro-like board toolbar has a `Promote` action.
- `BoardCanvas.promoteToClaims(...)` creates or reuses an "Idea Board" room and
  posts each selected board object to `/studio/projects/:projectId/claims` with
  provenance `{ origin: "idea-board", boardId, objectId }`.
- After promotion, the board object is only updated with `promotedClaimId` and
  `promotedAt`; the user-facing notice says the ideas were "promoted to
  governed claims."
- The Synthesis idea wall copy also says promoted board notes become governed
  claims that feed discovery and specification.
- The Concept Archive path has a different `Promote`: `promoteSchema` accepts a
  free-form `promotedRef: z.record(z.unknown()).default({})`.
- `promoteCard(...)` requires an elite or pinned card, creates `Claim` rows for
  body assumptions, marks the card `PROMOTED`, stores the caller-provided
  `promotedRef`, and publishes `ConceptCardPromoted`.
- `decideProposal(...)` for proposal kind `PROMOTE` updates a card to
  `PROMOTED` and stores `promotedRef`, but it does not create a WorkItem,
  GenerationPlan row, DevelopmentScope, HandoffGeneration, WorkflowStartCommand,
  or workflow run.
- Repository search under `concept-archive` and the Synthesis board promotion
  path finds claim/promotion writes, but no call to WorkItem creation or the
  contract-bound execution APIs.

Impact:

- Users can promote an idea and believe it is now moving toward delivery, while
  the system has only created epistemic evidence or a tagged card.
- The critical transition from selected concept to executable scope remains
  manual and ambiguous.
- `promotedRef` can point at anything or nothing, so promotion is not an
  auditable contract for which capability owns execution, which requirements are
  in scope, or which workflow should start.
- There is no enforced handoff from idea evidence to WorkItem/spec binding,
  budget reservation, human approval, or event-driven workflow launch.
- Reporting can count promoted concepts without proving that any governed
  delivery work was created or linked.

Required fixes:

- Split the language and model into explicit stages: `Promote to Claim`,
  `Promote to Candidate Work`, and `Approve for Execution`.
- Replace free-form `promotedRef` as the primary authority with a typed
  `ConceptExecutionHandoff` or `WorkItemCreationCommand` reference.
- Add a promotion wizard that selects or confirms requirement subset, owning
  capability, WorkItem type, generation plan row, budget reservation, and launch
  policy.
- Enforce that candidate work inherits the initiative's single assigned
  capability unless a reviewed cross-capability exception exists.
- Make accepted execution promotions create an idempotent WorkItem/spec binding
  or GenerationPlan row, then optionally start the routed workflow.
- Add tests proving board-object promotion to claims does not imply delivery,
  and execution promotion creates exactly one governed handoff/work item with
  traceable provenance back to the board object or concept card.

### 114. Governed Synthesis source intake does not yet support real file or Office/PDF ingestion

Evidence:

- `ArtifactPile` in the Synthesis intake screen offers only two source types:
  `MARKDOWN` ("Markdown or text") and `URL`.
- The UI posts `/studio/boards/:boardId/ingest` with either inline `content` or
  a `url`; it does not provide a file picker, upload artifact id, `storageRef`,
  MIME type, or binary payload path.
- `board-ingestion.ts` explicitly says binary parsers for `PPTX/PDF/DOCX/XLSX`
  and Figma "plug in later" and that the default handles only
  text/markdown/url.
- `board-ingestion.service.ts` has the same comment, and parser validation
  throws `No parser is registered... Supported kinds are TEXT, MARKDOWN, MD,
  and URL`.
- The service type accepts `storageRef`, and `IngestedArtifact` has a
  `storageRef` column, but `resolveIngestContent(...)` throws
  `storageRef ingestion is not configured for this deployment`.
- The separate Idea Board upload path can create visual/file cards, but gap #81
  documents that those uploads bypass this governed ingestion/artifact pipeline.

Impact:

- A team cannot drop a real design document, BRD, spreadsheet, deck, PDF, or
  exported artifact into the governed source-intake flow and get source spans,
  extracted claims, content hashes, and validation reports from the actual file.
- Users may see "Document pile" and assume Office/PDF evidence is supported, but
  the only governed choices are pasted text/Markdown and URL text.
- File evidence can split into two weak paths: visual board attachments with no
  content extraction, or governed ingestion with no binary/file support.
- The SDLC story-to-spec workflow cannot reliably derive facts from the common
  enterprise document formats that usually hold requirements and design intent.

Required fixes:

- Add a real upload route that stores file bytes/artifacts and passes a
  `storageRef` or artifact id into governed ingestion.
- Implement deterministic extractors for PDF, DOCX, XLSX, PPTX, and common text
  formats, preserving page/sheet/slide/paragraph span references.
- Keep URL ingestion SSRF-guarded, but separate URL-source extraction from
  uploaded-file extraction and show both states clearly in the UI.
- Route Idea Board upload through the same artifact-backed ingestion path when a
  user marks a file as governed source evidence.
- Add tests for supported Office/PDF files, image-only PDFs, large files,
  unsupported MIME types, duplicate content hashes, storage backend failure, and
  source-span provenance in validation reports.

### 115. Canonical source briefs are generated ephemerally instead of persisted as governed evidence

Evidence:

- `validateBoardArtifacts(...)` persists an `ArtifactValidationReport` with
  cited findings, tensions, sources, and a content hash.
- `generateCanonicalArtifactDocument(reportId)` then reloads the report and
  returns `{ reportId, filename, contentType, markdown, sentences }`, but it
  does not create a durable `BusinessReadout`, artifact, document, source-brief,
  `SpecificationVersion`, or project-specification record.
- The Synthesis intake UI calls
  `/studio/experience/validation-reports/:reportId/canonical-document`, stores
  only `result.markdown` in React state via `setCanonical(...)`, and renders it
  inside a `<pre>`.
- `transmuteValidationReport(...)` creates an `ARTIFACT_SCAFFOLD_BATCH`
  `StudioProposal` with staged claims and draft requirements, but it does not
  store the generated canonical source brief or link a signed brief into the
  specification/evidence spine.
- Other generated communications, such as morning and sponsor readouts, do have
  durable `BusinessReadout` rows with `renderedMarkdown`, citations, and
  `contentHash`, which shows the platform already has a stronger pattern for
  governed generated documents.

Impact:

- A user can click "Generate brief" and see an apparently authoritative
  canonical source brief, but it disappears on refresh, navigation, or another
  browser session.
- The brief cannot be signed, reviewed, versioned, exported in an evidence pack,
  linked to a `SpecificationVersion`, or cited as immutable input for generated
  WorkItems.
- Re-running generation later can produce a different markdown rendering from
  the same validation report without any durable comparison, approval, or
  supersession record.
- The platform can prove that a validation report existed, but not which exact
  canonical source brief humans saw and relied on before promoting claims or
  requirements.

Required fixes:

- Add a durable `SourceBrief`/`ProjectDocument`/`BusinessReadout`-style record
  for canonical source briefs with `reportId`, source artifact refs,
  `renderedMarkdown`, citations, `contentHash`, generatedById, status, and
  timestamps.
- Make generation idempotent by content hash and expose brief history from the
  validation-report UI.
- Add explicit actions to save/publish/attach a brief to the project
  specification or evidence pack after review.
- Include canonical source brief ids and hashes in `ARTIFACT_SCAFFOLD_BATCH`
  proposals and downstream spec/work-item provenance.
- Add tests proving brief generation persists, reloads, deduplicates by hash,
  preserves citation refs, and survives refresh before promotion to claims or
  requirements.

### 116. Capability world-model maintenance routes can be called by normal authenticated users

Evidence:

- Agent Runtime mounts all capability routes under the global
  `optionalAuth/requireAuth` middleware, but there is no route-level capability
  edit, grounding-maintenance, runtime-service, or MCP provenance check for
  world-model maintenance calls.
- `capability.routes.ts` exposes
  `POST /:id/world-model/redistill`,
  `POST /:id/world-model/fingerprint`,
  `POST /:id/world-model/ast-index-built`, and
  `POST /:id/world-model/probe-command` on the normal capability router.
- `redistillWorldModel(...)`, `checkWorldModelFingerprint(...)`,
  `reportAstIndexBuilt(...)`, and `probeWorldModelCommand(...)` all call
  `assertCapabilityMutable(...)`, which only loads the capability and rejects
  archived capabilities.
- `reportAstIndexBuilt(...)` accepts caller-supplied `astIndexFiles` and stamps
  `astIndexedAt` plus `astIndexFiles` into `CapabilityWorldModel` through
  `upsertWorldModel(...)`; it does not prove that MCP actually built an index
  for that capability workspace.
- `checkWorldModelFingerprint(...)` accepts caller-supplied fingerprint/build
  metadata and records drift state with `actorId: req.user?.user_id`.
- `probeCommand(...)` runs a caller-supplied shell string through
  `/bin/sh -c` in a temporary directory. The service comment explicitly says
  probes have full host network access and that the 10-second timeout is the
  only governor.

Impact:

- Any authenticated caller who can reach Agent Runtime and guess or see a
  capability id can potentially mutate capability grounding state unless other
  unverified upstream controls block them.
- Capability prompts can treat a world model as indexed, fresh, or drifted based
  on user-supplied callback metadata rather than a signed runtime/MCP receipt.
- The command probe is not a full sandbox and can execute shell/network actions
  on the Agent Runtime host; this is too much authority for a generic
  capability-maintenance UI endpoint.
- Evidence and audit can show that "someone" stamped grounding metadata, but not
  that the correct runtime built the index from the approved repository source.

Required fixes:

- Split these routes into explicit authorities:
  human capability-maintainer actions, runtime/MCP callbacks, and diagnostic
  probes.
- Require IAM permissions such as `capability:world_model:maintain`,
  `capability:world_model:probe`, and a scoped runtime/service token for
  `ast-index-built`.
- Bind runtime callbacks to tenant id, capability id, source repository id,
  runtime id, trace id, content/source fingerprint, and a signed receipt.
- Move `probe-command` behind the same sandbox runner used for workflow test
  execution, or restrict it to a vetted command catalog with argv arrays and no
  shell.
- Add tests proving ordinary viewers cannot mutate world-model state, archived
  capabilities remain read-only, runtime callbacks fail without a scoped token,
  and probe commands cannot use shell/network behavior outside policy.

### 117. Prompt Composer can silently omit non-input artifact evidence from governed prompts

Evidence:

- `compose.service.ts` iterates over `input.artifacts`, calls
  `renderArtifact(...)`, and simply `continue`s when it returns `null`; only
  successfully rendered artifacts become `ARTIFACT_CONTEXT` layers.
- `renderArtifact(...)` fails closed only when `art.role === "INPUT"` and the
  artifact body cannot be fetched. For every other role, a failed fetch returns
  `null`, so the artifact is omitted from the final prompt.
- `fetchArtifactContent(...)` pushes warnings when
  `WORKGRAPH_ARTIFACT_FETCH_URL` is missing, the fetch returns non-OK, no text
  content is returned, or the request throws, but the caller still sends the
  prompt to Context Fabric for non-input artifacts.
- Warnings are included in the prompt assembly response and audit event, but
  omitted artifacts are not represented as typed excluded-context entries in
  the context plan, nor are they tied to a policy gate that can decide whether
  evidence/document/governance artifacts are mandatory for the node.

Impact:

- A workflow stage can appear to be using governed prompt composition while the
  model never sees referenced evidence, design docs, validation reports, or
  prior artifacts unless they were marked exactly as `INPUT`.
- Human reviewers and downstream gates may see a prompt assembly and warning
  record, but the run can still progress from an under-informed model response.
- Whether missing artifact evidence blocks execution depends on the caller's
  artifact role convention rather than on node policy, artifact criticality, or
  the workflow's governance requirements.

Required fixes:

- Add artifact criticality/required semantics separate from the broad
  `role === "INPUT"` check, and make required evidence/document/governance
  artifacts fail closed when their bodies cannot be fetched.
- Record omitted artifacts in `ContextPlan.excludedContext` with artifact id,
  role, consumable type, source reference, reason, and whether omission was
  policy-allowed.
- Add a node/profile policy flag such as `requiredArtifactRoles` or
  `artifactEvidenceMode: hard | soft | warn` so governance-heavy stages can
  block on missing evidence while lightweight stages may warn.
- Surface omitted-artifact decisions in run cockpit/evidence packs, not only as
  generic prompt warnings.
- Add tests for missing `WORKGRAPH_ARTIFACT_FETCH_URL`, non-OK artifact fetch,
  no text content, and optional versus required non-input artifact roles.

### 118. Workflow Operations replay uses redacted event payloads instead of the original event body

Evidence:

- The canonical authenticated event intake validates the incoming payload, then
  computes `safePayload = redactEventPayload(body.payload)`.
- The same route logs the operator-visible inbound event with
  `payload: safePayload` inside the `WorkflowInboundEventReceived`,
  `WorkflowInboundEventFailed`, or `WorkflowInboundEventDeadLettered` event-log
  payload.
- `redactEventPayload(...)` replaces any key matching token, secret,
  credential, password, private key, cookie, authorization, API key, and similar
  names with `[REDACTED:SENSITIVE]`; it also truncates very deep or very large
  structures into redaction markers.
- Workflow Operations replay loads the event-log row, reads
  `const payload = asRecord(source.payload)`, and passes that value to
  `fanOutToWorkItemTriggersDetailed(...)`.
- The replay path does not have a separate encrypted original-payload reference,
  payload hash binding, or policy-controlled restore step. It therefore cannot
  faithfully replay events whose original payload contained redacted fields or
  structures.

Impact:

- Replay can create a different WorkItem, attach to a different WorkItem, fail a
  trigger mapping, or route differently from the original event if mappings,
  selectors, document paths, or correlation keys referenced a redacted field.
- Operators may think replay is "same event, new delivery id" while the system
  is actually replaying a sanitized projection.
- The platform lacks a clean split between safe operations display payloads and
  restricted replay-authority payloads.

Required fixes:

- Store the original event body in a restricted, encrypted event-ingress record
  or object-store artifact with content hash, tenant id, source, delivery id,
  retention policy, and replay permission guard.
- Keep `EventLog.payload` redacted for broad operations visibility, but include
  an `originalPayloadRef`, `payloadHash`, and redaction summary.
- Make replay load the original payload only after `workflow:operations:replay`
  plus sensitive-data authorization; otherwise block with a clear reason.
- Record in the replay event whether the replay used original payload,
  redacted-only payload, or an operator-supplied override.
- Add tests proving sensitive fields are hidden in `/workflow-operations/events`
  but preserved for authorized replay, and that replay reproduces trigger
  correlation, document extraction, and routing policy selection.

### 119. Context Fabric strict health passes when audit-governance URL is unset

Evidence:

- `context_api_service/app/config.py` production-class import guards require
  strong `JWT_SECRET`, `IAM_SERVICE_TOKEN`, `MCP_BEARER_TOKEN`,
  `AUDIT_GOV_SERVICE_TOKEN`, `DEFAULT_GOVERNANCE_MODE=fail_closed`,
  `CF_TOOL_GRANT_ENABLED=true`, and `REQUIRE_TENANT_ID=true`, but there is no
  production invariant requiring `AUDIT_GOV_URL`.
- `/healthz/strict` is documented in `main.py` as returning 200 only when
  "audit-gov reachable", but `_check_audit_gov_reachable()` returns
  `ok=True` when `AUDIT_GOV_URL` is unset, with a note saying emits become
  no-ops.
- The default `emit_audit_event(...)` path in `audit_gov_emit.py` is
  fire-and-forget and returns immediately when `AUDIT_GOV_URL` is empty.
- `emit_audit_event_strict(...)` does fail when `AUDIT_GOV_URL` is unset, but
  only callers that explicitly run the fail-closed strict path discover that at
  execution time; the service can still start and pass strict health first.
- The platform handbook says production deploy preflight requires
  `AUDIT_GOV_URL` and verifies audit-governance `/health`, but the Context
  Fabric service's own strict health/startup code does not enforce that claim.

Impact:

- A production-class Context Fabric process can advertise strict health while
  ordinary governed-loop audit events are silently dropped.
- Operators can pass service-level readiness checks and then see fail-closed
  workflow nodes fail later with `AUDIT_GOV_URL is unset`, shifting a deployment
  invariant into runtime execution.
- Evidence completeness depends on every caller using strict emission rather
  than the platform proving the central audit dependency is configured before
  accepting traffic.

Required fixes:

- Add a production-class startup invariant requiring non-empty
  `AUDIT_GOV_URL`.
- Change `/healthz/strict` so unset `AUDIT_GOV_URL` is a failing
  `audit_gov_reachable` check, not an OK note.
- Keep local/dev no-op behavior only behind an explicit development mode label,
  and surface that status in Operations readiness.
- Add tests for production import/startup refusal, strict health failure when
  unset, strict health failure when `/health` is non-200, and dev-mode warning
  behavior.
- Update docs/preflight so the service-level guard, doctor, and deploy script
  all enforce the same audit-governance dependency.

### 120. Concept Archive freeze is not enforced across proposal and card mutation paths

Evidence:

- `freezeArchive(...)` sets `ConceptArchive.status = 'FROZEN'`, stores
  `frozenAt`, and computes a `contentHash` over the archive axes, revision, and
  selected frozen cards.
- Some direct mutation paths clearly treat non-`ACTIVE` archives as immutable:
  `stageCard(...)` rejects frozen archives, `confirmCardCoords(...)` rejects
  coordinate changes when `card.archive.status !== 'ACTIVE'`,
  `killCell(...)` rejects cell changes on frozen archives, and
  `recutArchive(...)` rejects recuts on frozen archives.
- Other mutation paths do not enforce the same lifecycle boundary:
  `voteCard(...)` can update card `fitness` and `compositeScore`,
  `pinCard(...)` can change pin state, and `promoteCard(...)` can update card
  status, `promotedRef`, `claimRefs`, and create claims without checking the
  parent archive status.
- `decideProposal(...)` checks only proposal status, expiry, archive ownership,
  and `axesRevision`. If the archive revision matches, accepting proposal kinds
  `CREATE`, `UPDATE`, `MUTATE`, `PROMOTE`, or `SWAP` can call `stageCardInTx`,
  update card bodies/scores/status, or move a cell elite even after the archive
  has been frozen.
- `rebaseProposal(...)` can create a new proposal against a frozen archive and
  increments archive proposal usage without checking archive status.
- The Prisma model stores `ConceptArchive.status`, `contentHash`, and
  `frozenAt`, but there is no database constraint or trigger preventing
  `ConceptCard`, `ArchiveCellState`, or `StudioProposal` mutations after
  freeze.

Impact:

- A frozen concept portfolio can continue changing through proposal acceptance,
  direct promotion, voting, or pinning, while the stored `contentHash` still
  represents the pre-mutation snapshot.
- Reviewers may treat "frozen" as an immutable selection for downstream
  specification, claims, or evidence packs, but the archive can drift after the
  fact.
- Accepted proposals can create new cards or swap elites after freeze, which
  blurs the boundary between an approved concept set and ongoing ideation.
- Audit evidence becomes ambiguous because `ARCHIVE_FROZEN` does not guarantee
  that the cards, cell elites, scores, and promoted refs remained stable.

Required fixes:

- Introduce a shared `assertArchiveMutable(...)` guard and call it from every
  archive/card/cell/proposal write path, including proposal accept/rebase,
  vote, pin, direct promote, and pathfinder budget updates where appropriate.
- Decide which actions are allowed after freeze. If review-only actions such as
  votes/comments are intentionally allowed, store them outside the frozen
  content surface and make the UI label them as post-freeze annotations.
- Block executable proposal acceptance/rebase for frozen archives unless the
  operator explicitly creates a new archive revision or governed thaw/amendment.
- Add a database-level safety net, such as triggers that reject content-affecting
  card/cell/proposal writes when the parent archive is frozen.
- Recompute or supersede `contentHash` only through a governed amendment path;
  never allow silent drift under the original frozen hash.
- Add tests for each mutation route proving frozen archives reject card
  creation, card update, mutation, promotion, swap, cell changes, recut,
  proposal rebase, and any content-affecting vote/score updates.

### 121. Concept Archive budgets are best-effort JSON counters, not hard concurrency limits

Evidence:

- `ConceptArchive` stores `budgetConfig` and `budgetUsage` as JSON fields, with
  counters for cards, proposals, embedding calls, and search expansions.
- `stageCardInTx(...)` reads `archive.budgetUsage`, checks
  `usage.cards >= budget.maxCards`, creates a `ConceptCard`, then updates
  `budgetUsage` to `{ ...usage, cards: usage.cards + 1, ... }`.
- Swap proposal creation in `confirmCardCoords(...)`, explicit
  `createProposal(...)`, and `rebaseProposal(...)` follow the same
  read-check-create-update pattern for `usage.proposals`.
- `pathfinder(...)` reads search-expansion usage outside the write transaction,
  runs the search, then writes back
  `searchExpansions: usage.searchExpansions + ranked.expansions`.
- Embedding budget is checked in `stageCard(...)` before the transactional card
  create, so concurrent staging can all decide an embedding call is still within
  budget.
- There is no row-level lock, `SELECT ... FOR UPDATE`, serializable isolation,
  compare-and-set predicate, unique budget ledger, or database constraint that
  ties the number of created cards/proposals/searches to the configured limits.

Impact:

- Concurrent card staging can exceed `maxCards` while the JSON usage counter
  undercounts because two transactions can read the same starting usage and both
  write back the same incremented value.
- Concurrent proposal creation/rebase can exceed `maxProposals` and still report
  usage below the real proposal count.
- Pathfinder and embedding budgets can be exceeded under parallel agent searches
  or bulk idea generation.
- Operators may trust budget widgets and freeze/recut decisions that are based
  on stale or undercounted usage rather than actual archive activity.

Required fixes:

- Move archive usage into a transactional ledger or dedicated counter rows keyed
  by archive id and counter type.
- Enforce hard limits with row locks or atomic conditional updates, e.g. update
  only when `used + delta <= limit` and reject when the affected row count is
  zero.
- Count existing cards/proposals as a reconciliation check and surface drift if
  ledger totals and materialized rows diverge.
- Reserve embedding/search budget before the external call, then settle or
  release the reservation after success/failure.
- Add concurrency tests that run parallel card staging, proposal creation,
  rebase, pathfinder searches, and embedding requests against tiny budgets and
  prove the configured limit cannot be exceeded.

### 122. Portfolio readiness can mark WorkItem lineage complete without verifying contract-bound records

Evidence:

- `getProjectTraceabilityInternal(...)` builds traceability nodes for boards,
  claims, requirements, decisions, specifications, generation plans, plan rows,
  WorkItems, submissions, reconciliations, and finalizations.
- The `completeChains` summary is not derived from that graph. It is computed
  by counting generation-plan rows where `row.workItemId` is present and
  `requirementIds`, `decisionRefs`, and `claimRefs` are non-empty.
- That calculation does not verify that the referenced requirement, decision,
  or claim ids exist, belong to the same project, are accepted/current, or are
  connected to the specification version used by the generation plan.
- The traceability query includes each row's WorkItem with submissions,
  reconciliation runs, specification bindings, and finalization records, but it
  does not include `DevelopmentScope` or `HandoffGeneration` records and does
  not require a current binding, accepted mandatory scope, published handoff,
  accepted submission, dynamic verified reconciliation, or completed
  finalization for `completeChains`.
- `evaluatePilotReadiness(...)` labels the lineage check as "Every generated
  WorkItem has a complete evidence chain" and marks it OK when
  `evidence.workItems > 0 && evidence.completeChains === evidence.workItems`.
- `getProjectPilotReadinessInternal(...)` feeds that check directly from
  `traceability.summary.completeChains` and `traceability.summary.workItems`.

Impact:

- A Synthesis project can receive a green "complete evidence chain" readiness
  check when each generation-plan row merely has non-empty reference arrays and
  a WorkItem id.
- Operators may trust the pilot/readiness score even though generated WorkItems
  still lack current `WorkItemSpecificationBinding`, `DevelopmentScope`,
  published `HandoffGeneration`, submission, dynamic verification, or
  finalization evidence.
- Broken or stale references inside `requirementIds`, `decisionRefs`, and
  `claimRefs` can satisfy the chain count because the readiness calculation does
  not resolve them.
- This weakens the platform's promised idea -> specification -> WorkItem ->
  verified check-in story: the visual traceability graph may show edges while
  the readiness headline overclaims the contract-bound chain.

Required fixes:

- Replace the current `completeChains` formula with a per-WorkItem contract
  verifier that resolves every referenced requirement, decision, claim,
  specification version, binding, scope, handoff, submission, reconciliation,
  and finalization record.
- Require the generation plan's `specificationVersionId` to match each current
  WorkItem binding and each published handoff's `specificationBindingId`.
- Require mandatory `DevelopmentScope` rows to be `ACCEPTED`, their current
  handoffs to be `PUBLISHED`, submissions to reference that handoff, and dynamic
  reconciliation to produce `VERIFIED_PASS` before calling the chain complete.
- Return failed-chain diagnostics per WorkItem, including the missing or stale
  record type and the exact fix route.
- Add readiness tests with fake non-empty `requirementIds`, `decisionRefs`, and
  `claimRefs` but missing bindings/handoffs/reconciliation to prove the lineage
  check stays red.

### 123. Rejected project specification reviews can leave the initiative stuck in review

Evidence:

- `compileProjectSpecificationInternal(...)` creates a project-owned
  `SpecificationVersion` and updates the parent `SpecificationProject.status`
  to `IN_REVIEW`.
- `requestSpecificationReview(...)` updates the stored `SpecificationVersion`
  to `IN_REVIEW` when it creates the approval request.
- The happy-path approval finalizer updates the `SpecificationVersion` to
  `APPROVED` and updates the owning `SpecificationProject.status` back to
  `ACTIVE`.
- `applySpecificationReviewRejection(...)` handles `REJECTED` and
  `NEEDS_MORE_INFORMATION` decisions by updating only the
  `SpecificationVersion.status` to `REJECTED` or `CHANGES_REQUESTED`.
- The rejection path does not update `SpecificationProject.status`, does not
  clear or mark the project-level review state, and does not publish a project
  status event.
- `SpecificationProjectStatus` has `DRAFT`, `IN_REVIEW`, `LOCKED`,
  `GENERATING`, `ACTIVE`, `CHANGE_REQUESTED`, and `ARCHIVED`; there is no
  project-level `REJECTED` terminal state.

Impact:

- After a specification rejection or needs-more-information decision, the
  initiative can remain `IN_REVIEW` even though the reviewed version is no
  longer in review.
- Synthesis hub and generation screens can show the initiative as awaiting
  review, while the actual next action is revise/compile again or reopen a
  change request.
- Automation that keys off project status may block generation, readiness, or
  routing because the project state and latest specification-version state
  disagree.
- Audit timelines have a `SpecificationReviewRejected` event for the version,
  but no authoritative project-level transition explaining what happened to the
  initiative lifecycle.

Required fixes:

- On rejection, update the parent project status in the same transaction as the
  version status.
- Map `REJECTED` for a first/only version to `DRAFT` or a clear project-level
  revise state; map `NEEDS_MORE_INFORMATION` to `CHANGE_REQUESTED` or another
  explicit revision-required state.
- If an existing active approved version remains valid while an amendment is
  rejected, restore the project to `ACTIVE` and mark only the attempted version
  as rejected.
- Emit a project-level audit/outbox event such as
  `SpecificationProjectReviewRejected` with version id, approval request id,
  reviewer, decision, and next required action.
- Add tests for first-version rejection, amendment rejection with prior active
  spec, needs-more-information, and UI/readiness behavior after each transition.

### 124. Pinned Direct LLM loop strategy versions are not cryptographically re-verified at runtime

Evidence:

- `LoopStrategyVersion` stores `definition`, `contentHash`, `publishedAt`, and
  `version`, and Direct LLM runtime records the strategy id, version, and
  content hash as execution evidence.
- `loopStrategyDigest(...)` hashes the normalized strategy definition when a
  version is created, but `resolveLoopStrategyVersion(...)` returns the stored
  JSON definition without recomputing the digest or checking it against
  `contentHash`.
- `publishLoopStrategy(...)` updates `publishedAt` unconditionally for the
  current version. Re-publishing an already published version can change the
  publication timestamp for the same pinned version.
- The Prisma schema and `20260714100000_direct_llm_loop_strategies` migration
  create ordinary mutable rows for `loop_strategy_versions`; there is no
  database trigger or constraint preventing updates to `definition`,
  `contentHash`, `version`, or `publishedAt` after publication.
- Service routes do not expose a direct "edit version definition" endpoint, but
  the evidence invariant depends on all writers, scripts, migrations, and admin
  maintenance paths preserving the row exactly.

Impact:

- A workflow can claim it executed pinned strategy `S@N` with hash `H` while the
  runtime actually executes a mutated stored `definition`.
- Historical run evidence and receipts become weaker because the runtime trusts
  the row instead of proving the definition still matches the recorded digest.
- Re-publishing a version can rewrite the original publication time, making
  approval/audit timelines less deterministic.
- A future maintenance script, migration, or privileged bug could silently
  mutate published loop behavior without creating a new immutable version.

Required fixes:

- Make `LoopStrategyVersion` append-only once `publishedAt` is set. Enforce this
  in both service code and a database trigger/constraint.
- Make publish idempotent: if `publishedAt` is already set, return the existing
  value instead of overwriting it.
- Recompute `loopStrategyDigest(definition)` in `resolveLoopStrategyVersion(...)`
  and fail closed if it does not equal `contentHash`.
- Record the verified digest, publication timestamp, and validation result in
  Direct LLM receipts.
- Add tests that mutate a published row in a transaction and prove runtime
  resolution fails before any provider call.

### 125. Synthesis has two separate idea surfaces with no explicit bridge or source-of-truth rule

Evidence:

- `/synthesis/ideas` renders `IdeaWallScreen`, whose board view mounts
  `IdeaBoardWorkspace` and `BoardCanvas` backed by `/studio/projects/:id/boards`
  and `/studio/boards/:boardId/*`.
- `/concept-studio` and `/concept-archive` both render
  `ConceptArchiveConsole`, backed by `/concept-archive/*` APIs,
  `ConceptArchive`, `ConceptCard`, `ArchiveCellState`, and `StudioProposal`.
- The navigation marks `Concept Maps` as an advanced Discover surface "outside
  the broader Synthesis workspace", while the primary Synthesis route labels
  `/synthesis/ideas` as the `Idea Board`.
- The Idea Board can synthesize board objects and promote selected content to
  claims, but it does not create Concept Archive cards/cells or show concept
  archive proposals.
- Concept Maps can stage concepts, confirm coordinates, freeze portfolios, and
  manage proposal inbox decisions, but these cards/cells do not appear on the
  Miro-like Idea Board canvas.
- Both surfaces use similar language: ideas, concepts, proposals, boards,
  claims, and synthesis. There is no visible rule that says which surface is the
  canonical source for early ideation, which one is optional, or how an object
  moves between them.

Impact:

- Users can reasonably ask where "cells" are created and why they are not on
  the main Idea Board, because cells belong to Concept Maps while notes/shapes
  belong to the Miro-like BoardCanvas.
- Teams can split ideation artifacts across two stores and lose the thread from
  raw board notes to concept portfolio decisions, claims, and generated
  specifications.
- Proposal inboxes become confusing: Concept Archive proposals are separate
  from the Synthesis intake/scaffold proposal model and from board synthesis.
- The platform feels harder to adopt because the same lifecycle phase has two
  creation experiences with different visual language, routes, and persistence.

Required fixes:

- Choose one canonical Discover creation surface. The simplest path is to make
  `/synthesis/ideas` the default Miro-like surface and expose Concept Maps as an
  explicit `Evaluate as concept map` mode inside that workspace.
- Add a governed bridge command from selected Idea Board objects to Concept Map
  cards, preserving board object ids, source spans, citations, creator, and
  trace id.
- Add reverse links from every Concept Card/cell/proposal to its originating
  board object or source artifact.
- Show a single proposal/inbox rail in Synthesis that groups board synthesis,
  concept-map proposals, intake scaffolds, and validation proposals by source.
- Add copy and route names that distinguish `Idea Board` from `Concept Map`
  without using "Archive" as the main user-facing concept.
- Add browser tests that create an idea on `/synthesis/ideas`, promote or map it
  into Concept Maps, accept/reject the resulting proposal, and verify provenance
  is visible in claims/specification traceability.

### 126. Workflow launch inputs ignore branch-condition parameters

Evidence:

- The WorkGraph designer tells authors to define workflow parameters and
  reference them in branch conditions as `params.key`.
- Branch conditions are stored on `WorkflowDesignEdge.condition`, cloned into
  `WorkflowEdge.condition`, and evaluated by `EdgeEvaluator` and
  `GraphTraverser`.
- `EdgeEvaluator` treats `params.X`, `vars.X`, and `globals.X` as first-class
  runtime references. If `params.X` is absent, the condition resolves to
  `undefined`, which can skip the branch or cause a path stall.
- `GET /workflow-templates/:id/runtime-inputs` selects only workflow design
  nodes with `{ id, label, nodeType, config }` and passes those nodes to
  `collectRuntimeInputRequirements(...)`.
- `cloneDesignToRun(...)` uses the same node-only call before creating a run.
  The missing-input guard therefore checks node `config` placeholders and
  variable definitions, but it does not scan edge conditions.
- The runtime-input tests cover placeholders in node config and output
  references, but not `WorkflowDesignEdge.condition` references.

Impact:

- A workflow can launch without a required branch parameter such as
  `params.tier`, `params.region`, or `vars.riskClass`, even though routing logic
  depends on it.
- Decision and inclusive gateways can take the wrong default branch or pause as
  `PATH_STALL` after work has already started.
- Event-driven and scheduled launches can match a trigger and create a run
  without proving the event payload supplies the routing parameters needed for
  later branch decisions.
- The launch form, if wired to `/runtime-inputs`, still presents an incomplete
  contract because edge-level runtime values are missing.

Required fixes:

- Extend `collectRuntimeInputRequirements(...)` to scan edge conditions as well
  as node configs, preserving edge id, source node, target node, and branch label
  in the `nodes`/usage metadata or a new `edges` usage field.
- Include design edges in `GET /workflow-templates/:id/runtime-inputs` and in
  `cloneDesignToRun(...)` preflight validation.
- Treat missing required branch parameters as launch-blocking unless the
  condition has a safe default branch and the parameter is explicitly marked
  optional.
- Add runtime-input tests for `params.*`, `vars.*`, and `globals.*` references in
  edge conditions, plus event-trigger tests that dead-letter missing routing
  parameters before run creation.
- Surface branch-parameter fields in the launch UI under a clear "Routing
  decisions" group.

### 127. SAGA compensation configuration has split save and execution models

Evidence:

- The WorkGraph React Flow inspector exposes `SAGA Compensation` with only two
  user-facing action types: `tool_request` and `human_task`.
- The inspector stores that editor state as `config.compensationConfig`.
- `WorkflowStudioPage.handleInspectorSave(...)` lifts `executionLocation` out of
  `config` into the top-level node column, but it does not lift
  `compensationConfig`; the patch mutation sends the whole edited object as
  `config`.
- The template API schema and persistence model expect compensation to be saved
  as a separate top-level `compensationConfig` field/column.
- `cloneDesignToRun(...)` copies `n.compensationConfig` from the design node into
  the runtime node. It does not read `n.config.compensationConfig`.
- Automatic runtime compensation in `WorkflowRuntime.runCompensations(...)`
  reads `node.compensationConfig` and executes `tool_request` or `human_task`.
- Manual/debug compensation in `executeCompensation(...)` also reads
  `node.compensationConfig`, but it interprets the action type as
  `LOG`, `EMIT_EVENT`, or `RESTORE_CONTEXT`. A designer-created
  `tool_request` compensation would be rejected there as an unsupported action
  type.

Impact:

- A workflow author can configure SAGA compensation in the node inspector and see
  it retained in the UI config blob, but the runtime activation path may not get
  any compensation action because the authoritative column remains null.
- Even if compensation is written directly into the column, automatic failure
  compensation and manual operator compensation do not agree on the action
  vocabulary.
- Recovery testing can produce false confidence: the workflow looks
  compensation-aware in the designer while failed runs either skip compensation
  or make manual compensation fail.
- This weakens enterprise recovery semantics for nodes that perform external
  side effects, especially Git, event bus, artifact publication, and direct LLM
  tasks.

Required fixes:

- Treat compensation as a first-class node field everywhere, like
  `executionLocation`: load it from the top-level node field into inspector
  state, lift it back out on save, and update the mutation payload type to carry
  `compensationConfig`.
- Add a single canonical compensation action contract shared by the designer,
  template API, runtime automatic compensation, and debug/manual compensation.
- Either migrate `LOG`, `EMIT_EVENT`, and `RESTORE_CONTEXT` into the same action
  enum as `tool_request`/`human_task`, or expose them as explicit operator-only
  actions with separate UI labels and authorization.
- Add integration tests that save compensation through the designer payload,
  clone the design into a run, fail a completed node, and verify the expected
  compensation task/tool/event is produced.
- Add a debug compensation test proving every designer-supported compensation
  action can be invoked or is clearly rejected before save.

### 128. Workflow design node validation can be bypassed by a client-supplied header

Evidence:

- `validateNodeConfig(...)` now performs important write-time checks: it resolves
  cross-service references and runs the richer `DIRECT_LLM_TASK` validator,
  including prompt URL, credential env allowlist, schema, input path, and loop
  strategy version checks.
- `POST /workflow-templates/:id/design/nodes` skips that validator whenever the
  request includes `x-skip-ref-validation: 1`.
- `PATCH /workflow-templates/:id/design/nodes/:nodeId` has the same skip header
  for node type/config edits.
- The comment says the header is used by tests and bulk imports, but the design
  node endpoints are normal authenticated API routes. They check template edit
  permission; they do not require a service token, import route, debug profile,
  or elevated bulk-import permission before honoring the header.
- `POST /workflow-templates/:id/publish-version` snapshots the current design
  graph without re-running `validateNodeConfig(...)` across nodes.
- `POST /workflow-templates/:id/publish` and `mark-final` only update template
  status after a publish permission check; they do not perform a final
  launchability or node-contract validation sweep.

Impact:

- Any caller that can edit a workflow template can persist nodes with invalid
  agent/capability references, disallowed Direct LLM credential env names,
  credential-bearing prompt URLs, invalid output schemas, or missing loop
  strategy versions by sending the skip header.
- Enterprise template approval can mark a workflow as published/final even though
  the graph would have failed write-time validation without the header.
- Runtime still has some defense in depth for Direct LLM, but the failure moves
  from design/publish time to execution time, which is exactly where operators
  expect approved templates to be stable.
- Import and automation clients can accidentally normalize on the bypass path and
  create templates that look official but fail late.

Required fixes:

- Do not trust `x-skip-ref-validation` from ordinary user/API clients. Restrict
  it to a scoped service token, test-only environment, or a dedicated bulk-import
  endpoint with its own permission and audit event.
- Keep reference checks skippable only for explicit offline import staging; require
  a validation pass before publish, finalization, or launch.
- Add a `validateWorkflowDesign(...)` sweep used by publish-version, publish,
  mark-final, duplicate/import finalization, and run cloning.
- Log validation bypass attempts with actor, tenant, template id, node id, and
  reason; reject the header in production strict mode unless the caller has the
  dedicated import authority.
- Add regression tests proving a normal template editor cannot bypass Direct LLM
  validation with `x-skip-ref-validation`, and that publish fails if any node
  violates the canonical node contract.

### 129. Event-created WorkItems are stored as local capability work

Evidence:

- `WorkItemOriginType` currently has only `PARENT_DELEGATED`,
  `CAPABILITY_LOCAL`, and `SPEC_GENERATED`.
- Canonical event intake calls `fanOutToWorkItemTriggersDetailed(...)`, which
  creates a new WorkItem with `sourceEventTypeKey`, event payload/details, and
  `input.triggerType = 'EVENT'`, but it explicitly sets
  `originType: 'CAPABILITY_LOCAL'`.
- The event verifier demo ingest path follows the same pattern and also creates
  event-originated WorkItems as `CAPABILITY_LOCAL`.
- `createWorkItem(...)` would normally infer `PARENT_DELEGATED` when
  `parentCapabilityId` is present, but event fan-out overrides that inference
  with `CAPABILITY_LOCAL`.
- WorkItem routing stamps `originType` into child workflow context, so downstream
  nodes see event-created work as local capability work.
- Runtime WorkItem UI labels anything except `PARENT_DELEGATED` as "Local work"
  or "Local capability"; archive/detach affordances also branch on
  `CAPABILITY_LOCAL`.

Impact:

- Operators cannot reliably distinguish manually-created local work from
  externally-triggered/event-created work using the primary origin field.
- Event-driven obligations such as callback delivery, source-system correlation,
  replay eligibility, retention, and SLA ownership become inferred from nested
  payload/details instead of modeled explicitly.
- Audit, dashboards, inboxes, and WorkItem filters can undercount event-driven
  work or present it under the wrong "local work" label.
- Policy cannot cleanly distinguish "a capability created this itself" from
  "an external event caused this capability to act", even though those have
  different approval, replay, and cancellation expectations.

Required fixes:

- Add first-class WorkItem origins such as `EVENT_TRIGGERED` or
  `EXTERNAL_EVENT`, and use them from canonical event intake, signed incoming
  events, scheduler fan-out, and the event verifier demo.
- Keep `sourceEventTypeKey`, delivery id, trigger id, correlation key, source
  system, and replay source as indexed fields or a typed event-origin relation,
  not only nested JSON.
- Update UI labels, filters, work item badges, archive/detach affordances, and
  run context rendering to show event-created work separately from local work.
- Add migration/backfill rules for existing `CAPABILITY_LOCAL` rows that have
  `sourceEventTypeKey` or `details.source = 'incoming-event'`.
- Add tests that ingest an event, create/attach a WorkItem, auto-start a workflow,
  and verify origin, labels, callback obligations, replay eligibility, and
  cancellation policy all reflect event-driven work.

### 130. Approval quorum can be collapsed by a hidden default admin override

Evidence:

- `evaluateApprovalQuorum(...)` finalizes any positive vote when
  `isAdmin && adminOverride`, even if `quorumRequired` is greater than one.
- The quorum tests explicitly prove this behavior: a single admin approval with
  `quorumRequired: 3` and `adminOverride: true` is final, while
  `adminOverride: false` keeps the request pending.
- Runtime Approval nodes derive quorum from `quorumRequired`, `approvalQuorum`,
  `minVotes`, or `standard.*`, but then default `adminOverride` with
  `cfg.adminOverride !== false`.
- Governance Gate automatic/manual approval creation uses the same default:
  `cfg.adminOverride !== false`.
- The normal Workflow Designer Approval fields expose `Min approvals`, due date,
  and escalation fields, but do not expose an `adminOverride` control in the
  standard field list.
- Governance Gate standard fields likewise expose mode, formal verifier, artifact
  requirements, controls, and bindings, but not the admin-override quorum escape.

Impact:

- Designers can configure what appears to be a two-person or committee gate, but
  the effective runtime policy can still be satisfied by one platform admin unless
  a hidden/raw config field is set to `false`.
- Evidence packs and approval receipts may claim quorum policy was configured
  while the decisive condition was actually an override path the designer never
  reviewed.
- Governance waivers become especially risky because a hard/automatic gate can be
  converted from "role-based multi-approver governance" into "one admin can pass"
  without a first-class policy decision.
- This weakens separation-of-duty expectations for regulated workflows and makes
  it hard to explain why `Min approvals > 1` did not require multiple positive
  approvers.

Required fixes:

- Default `adminOverride` to `false` for production/runtime-created Approval and
  Governance Gate requests unless a workflow policy explicitly enables it.
- Expose admin override as a visible, permission-gated setting with explanatory
  copy near quorum controls.
- Record `adminOverrideUsed`, `quorumRequired`, `approvalsReceived`, and
  `overridePolicyId` in the approval receipt and run cockpit.
- Add publication validation that flags `quorumRequired > 1` with
  `adminOverride = true` unless the template has an explicit separation-of-duty
  waiver.
- Add regression tests for Approval node activation and Governance Gate approval
  creation proving the default is fail-closed and that explicit override is
  auditable.

### 131. LLM connection credential envs bypass the Direct LLM credential allowlist

Evidence:

- `direct-llm-config.ts` validates node-supplied `credentialEnv` against
  `WORKGRAPH_DIRECT_LLM_ALLOWED_CREDENTIAL_ENVS`, defaulting to
  `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, and `ANTHROPIC_API_KEY`.
- `llm-routing.router.ts` connection creation validates `credentialEnv` only as
  an environment variable name. It does not apply the same Direct LLM
  allowlist, provider-specific credential rules, or host binding before storing
  the row.
- `GET /api/llm-routing/connections` reports `credentialStatus` as
  `configured` for any named server env var with a value, regardless of whether
  that env var is approved for Direct LLM use.
- `DirectLlmTaskExecutor.ts` validates the node config before resolving the
  alias, then prefers `connection.credentialEnv` over the node config value.
- The same executor reads `process.env[args.credentialEnv]` and sends it as a
  bearer token or Anthropic `x-api-key` to the selected provider URL.
- Direct LLM base URL safety is checked at runtime by
  `validateDirectLlmBaseUrl(...)`, but connection creation accepts any syntactic
  URL and leaves unsafe or unapproved connection rows enabled until a node runs.

Impact:

- The node-level credential allowlist gives a false sense of control: a Direct
  LLM node using an alias can still inherit an unallowlisted server env var from
  the LLM connection registry.
- An LLM-routing admin, compromised admin session, or unsafe seed/catalog entry
  can turn unrelated process env vars into outbound LLM credentials if the
  provider host is otherwise allowed.
- Provider readiness can show `configured` for env vars the Direct LLM node
  validator would reject, so workflow authors can launch a node that fails late
  or uses a credential outside the intended boundary.
- Tenant-scoped LLM routing still points at process-wide env var names, making
  per-tenant credential policy hard to enforce or audit.

Required fixes:

- Apply the same `WORKGRAPH_DIRECT_LLM_ALLOWED_CREDENTIAL_ENVS` allowlist to
  LLM connection create/update, catalog ingestion, and runtime alias resolution.
- Prefer named secret references over arbitrary process env var names, with
  provider, tenant, and allowed-host binding on the secret reference.
- Validate connection base URLs at save time with the same host, private-network,
  custom-host, and production allowlist logic used at runtime.
- Return `credentialStatus: configured` only when the env var is present and
  allowed for that provider/tenant/host combination.
- Add tests proving an unallowlisted credential env cannot be saved, cannot be
  loaded from a catalog as enabled, cannot be used through an alias at runtime,
  and is not reported as configured.

### 132. Generation plan capability checks lack durable target snapshots and defensive internal enforcement

Evidence:

- `planRowSchema` accepts `targetCapabilityId` as any non-empty string.
- `POST /generation-plans` authorizes only the parent specification project via
  `assertGenerationProjectAccess(...)`, which checks the project's
  `primaryCapabilityId`.
- New create/validate/apply guards now resolve the initiative primary capability
  through the Agent and Tools capability catalog, require `ACTIVE`, and reject
  generation rows whose `targetCapabilityId` differs from the owning
  `SpecificationProject.primaryCapabilityId`.
- Those checks do not persist a resolved capability snapshot, IAM decision id,
  catalog version, or visibility/tenant context onto the generation plan row.
- `POST /generation-plans/:planId/apply` calls `createWorkItem(...)` directly
  with `parentCapabilityId: row.targetCapabilityId` and a target using the same
  id.
- The public WorkItem create route has a stronger guard: it calls
  `assertAgentRuntimeTargets(...)` against the Agent and Tools capability catalog
  and then `assertCanClaimWorkItemTarget(...)` for every target. Generation-plan
  apply bypasses that router guard.
- `createWorkItem(...)` itself only checks that any supplied child workflow
  template is available and matches the target capability. If an internal caller
  passes a forged or stale target and no higher-level route has validated it,
  `createWorkItem(...)` can still persist that target directly.

Impact:

- The current generation-plan routes enforce the single-capability initiative
  rule, but the enforcement is recomputed rather than evidenced through immutable
  row-level target snapshots.
- A future internal caller to `createWorkItem(...)` can accidentally bypass the
  public WorkItem target guard unless every caller repeats the same catalog and
  permission checks.
- Audit, replay, and dispute reviews cannot prove exactly which capability record
  and IAM policy decision authorized a generated row at plan time.

Required fixes:

- Add a shared `assertActiveAuthorizedWorkItemTargets(...)` helper used by both
  the WorkItem router and generation-plan create/validate/apply paths.
- Snapshot the resolved capability name, status, tenant/visibility context,
  catalog version, and IAM decision id for every generation row.
- Require an explicit generated-work create/route decision for the owning
  capability, not only generic edit permission on the specification project.
- Make `createWorkItem(...)` defensively reject unresolved target capabilities
  when called from internal automation, unless a trusted internal actor supplies
  a previously validated target snapshot.
- Add regression tests for fake, inactive, unauthorized, cross-tenant, stale
  snapshot, project-primary, and defensive internal-call generation targets.

### 133. Generation plan apply trusts stale validation state

Evidence:

- `POST /generation-plans/:planId/validate` derives errors and warnings from
  mutable state: accepted decision dossiers, project claims, the selected
  specification version package, project budget envelope, token budget, capacity
  calendars, and row schedules.
- The validate route stores the computed result in `GenerationPlan.validation`
  and sets `GenerationPlan.status` to `VALIDATED` when there are no errors.
- `GenerationPlan` has `contentHash`, `validation`, `status`, `createdAt`, and
  `updatedAt`, but no explicit `validatedAt`, `validatedById`,
  `validatedContentHash`, `validatedPolicyVersion`, or prerequisite snapshot
  digest.
- `POST /generation-plans/:planId/apply` checks only that `plan.status` is
  `VALIDATED` or `PARTIAL` before creating WorkItems.
- The apply route does not recompute the generation plan digest, re-run the
  validation checks, require `validation.valid === true`, compare against a
  validation snapshot, or verify that referenced decisions, claims, budget
  envelope, capacity calendars, and specification version status/content are
  still the same facts that were validated.
- The apply route then creates `SPEC_GENERATED` WorkItems, optional
  `WorkItemSpecificationBinding`, `DevelopmentScope`, `HandoffGeneration`,
  dependencies, and capacity allocations from the current rows.

Impact:

- A plan can be validated, then applied after its governing facts have changed:
  decisions can be rejected, claims can be removed or superseded, budget limits
  can tighten, capacity calendars can change, or a specification version can be
  superseded.
- Generated WorkItems may carry references that were true at validation time but
  are stale at apply time, while the UI and evidence still imply the plan was
  valid.
- This weakens the contract-bound story because WorkItem creation is not tied to
  a fresh, immutable proof of the exact plan and prerequisite state used at
  apply.

Required fixes:

- Persist a validation snapshot with `validatedAt`, `validatedById`,
  `validatedContentHash`, `validatedPolicyVersion`, prerequisite digests, and
  resolved referenced ids.
- On apply, compare the current plan rows and prerequisites against that snapshot
  and fail closed when anything has drifted.
- Alternatively, run validation inside the apply transaction immediately before
  acquiring the apply fence and creating WorkItems.
- Make `PARTIAL` apply semantics explicit: only rows with fresh valid row-level
  validation should be eligible, and failed/stale rows should stay unapplied.
- Add tests where a plan validates, then a decision, claim, specification
  version, budget envelope, capacity calendar, or row digest changes before
  apply; apply must fail with a clear stale-validation error.

### 134. Generation plan amendments do not verify the approved baseline before applying

Evidence:

- `GenerationPlanAmendment` stores both `previousScheduleHash` and
  `proposedScheduleHash`.
- `POST /generation-plans/:planId/amendments` computes
  `previousScheduleHash` from each current row's `rowKey`, projected dates,
  `criticalPath`, and `capacityCalendarId`, then stores a proposed schedule for
  review.
- `POST /generation-plans/:planId/amendments/:amendmentId/transition` allows
  `IN_REVIEW -> APPROVED` and `APPROVED -> APPLIED`.
- On `APPLIED`, the transition route iterates `amendment.proposedSchedule` and
  updates `GenerationPlanRow.projectedStartAt`, `projectedFinishAt`,
  `criticalPath`, matching capacity allocations, and WorkItem due dates.
- The apply branch never recomputes the current plan schedule hash and compares
  it with `amendment.previousScheduleHash`.
- The route also does not compare the stored proposed schedule with
  `proposedScheduleHash` before applying it.

Impact:

- An amendment can be approved against one schedule baseline and later applied
  after another amendment, validation run, capacity update, or manual row update
  changed that baseline.
- A stale amendment can silently overwrite newer projected dates, critical-path
  flags, capacity allocation dates, and generated WorkItem due dates.
- The stored hash fields look like a baseline-integrity mechanism, but operators
  do not actually receive drift protection when the amendment is applied.

Required fixes:

- Recompute the current schedule hash inside the same transaction used to apply
  the amendment and reject the apply if it differs from
  `previousScheduleHash`.
- Recompute `digest(amendment.proposedSchedule)` and reject if it differs from
  `proposedScheduleHash`.
- Add compare-and-set protection so only one approved amendment can apply to a
  given plan generation/baseline.
- After apply, store the new schedule hash on the plan or amendment and emit a
  baseline-superseded event.
- Add tests for applying an approved amendment after another amendment, a
  revalidation, a capacity-calendar change, and a row-level schedule edit.

### 135. WorkItem approval can become final before WorkItem finalization succeeds

Evidence:

- `POST /approvals/:id/decision` decides an approval in one transaction: it
  creates `ApprovalDecision`, updates `ApprovalRequest.status` to the final
  decision when quorum is met, logs `ApprovalDecided`, creates an
  `APPROVAL_DECISION` receipt, and publishes the approval outbox event.
- After that transaction commits, the route handles `subjectType === 'WorkItem'`
  by calling `approveWorkItem(...)` for positive decisions.
- `approveWorkItem(...)` calls `finalizeWorkItem(...)`, which starts a separate
  transaction and can still reject finalization because the WorkItem is not
  awaiting approval, lacks an approved request, has unfinished targets, has
  mandatory scopes without current bindings or published handoffs, lacks dynamic
  verification, has unresolved dependencies, has open clarifications, or has a
  stale finalization generation.
- If any of those finalizer checks fail, the approval decision and
  `ApprovalRequest.status = APPROVED` remain committed while the WorkItem stays
  unfinalized.
- The approval decision endpoint cannot be retried normally after this state
  because it rejects non-`PENDING` approval requests before attempting subject
  handling.
- The separate `/work-items/:id/approve` endpoint can call the finalizer later,
  but the original approval request is already final and there is no durable
  "approved but finalization failed" repair command or visible subject-handling
  state.

Impact:

- Operators can see a final approved WorkItem approval while the WorkItem remains
  `AWAITING_PARENT_APPROVAL` or otherwise uncompleted.
- Evidence and notifications can claim approval success without the authoritative
  `WORK_ITEM_FINALIZED` event, `WorkItemFinalizationRecord`, dependency release,
  source workflow advancement, or completion-program reconciliation.
- A transient missing prerequisite, stale generation, or finalizer bug can create
  a half-decided state that requires a non-obvious alternate endpoint to repair.
- Audit ordering becomes misleading: the final human decision is durable, but
  the delivery state it was supposed to authorize did not happen.

Required fixes:

- Treat WorkItem approval and finalization as one subject-handling command:
  either validate finalization prerequisites before marking the approval final,
  or persist a durable `WorkItemFinalizationCommand` in the same transaction as
  the approval decision.
- Store subject-handling status on the approval request, e.g.
  `SUBJECT_PENDING`, `SUBJECT_APPLIED`, `SUBJECT_FAILED`, with error details and
  retry controls.
- Make the approval decision route idempotently resume subject handling for
  already-final requests instead of rejecting them before checking repair state.
- Surface approved-but-not-finalized WorkItems in Operations and the run cockpit.
- Add tests where a WorkItem approval reaches quorum but finalization fails for
  missing handoff, missing dynamic verification, stale generation, or source
  workflow failure; verify the system records and can replay the subject action.

### 136. Approval delegation lookup is not tenant-scoped at decision time

Evidence:

- `OutOfOfficeDelegation` has `tenantId` and tenant-aware indexes for principal
  and delegate lookups.
- `listDelegations(...)`, `createDelegation(...)`, and `revokeDelegation(...)`
  use `currentTenantIdForDb()` and include `tenantId` in their normal
  collaboration-service queries.
- `canDecideApproval(...)` comments that direct-user delegation is
  "tenant-scoped and time-bounded".
- The actual decision-time delegation lookup only filters by
  `principalUserId`, `delegateUserId`, `status = ACTIVE`, `startsAt <= now`, and
  `endsAt >= now`. It does not filter by `tenantId`.
- When that lookup finds a row, it rewrites `decisionRouting.assignedToId` to the
  delegate user before local or IAM authorization checks run.
- The existing collaboration finding covers delegation creation not validating
  delegate existence/tenant membership; this is the separate runtime check that
  consumes those delegation rows during approval decisions.
- No searched API tests exercise `outOfOfficeDelegation` through
  `canDecideApproval(...)` or `POST /approvals/:id/decision`.

Impact:

- A delegation created in one tenant, migrated from old data, or inserted by a
  broad admin can be honored while deciding a direct-user approval in another
  tenant.
- In local-auth deployments, a delegate with the generic approval permission can
  satisfy the direct assignment after the routing rewrite, even if the delegation
  was not created for that tenant.
- In IAM mode, the later capability authz still helps, but the direct-user
  assignment constraint has already been weakened by an unscoped delegation row;
  this is especially risky for shared service/admin users across tenants.
- The code comment promises tenant-scoped delegation, so operators may believe a
  boundary is enforced when it is not.

Required fixes:

- Pass the approval request tenant into `canDecideApproval(...)` and include it
  in the `outOfOfficeDelegation.findFirst(...)` predicate.
- Store and check delegation scope explicitly: tenant, optional capability,
  optional approval surface, and optional maximum decision types.
- Reject or ignore delegation rows whose principal/delegate users are not active
  members of the approval tenant at decision time.
- Record the delegation id used in `ApprovalDecision` receipts and audit events.
- Add tests for direct-user approval with same-tenant delegation, cross-tenant
  delegation, expired delegation, revoked delegation, inactive delegate, and IAM
  capability denial after delegation.

### 137. Direct LLM review approvals can bind to stale AgentRun output

Evidence:

- `activateDirectLlmTask(...)` creates a fresh `AgentRun`, executes the provider,
  persists the LLM response, and builds `directOutput.directLlm.agentRunId` from
  the current run id.
- When review is required, it calls `ensureDirectLlmApprovalRequest(...)` with
  that current run id and output.
- `ensureDirectLlmApprovalRequest(...)` first looks for any existing pending
  `ApprovalRequest` with the same `instanceId`, `nodeId`,
  `subjectType = DirectLlmTask`, `subjectId = node.id`, and `status = PENDING`.
- If such a row exists, the function immediately returns `existing.id`; it does
  not verify that the existing request's `formData.agentRunId`,
  `workflowInstanceId`, `workflowNodeId`, trace id, or stored
  `directLlmOutput` matches the current AgentRun attempt.
- Only newly created requests receive fresh `formData.agentRunId` and fresh
  `directLlmOutput`, and only newly created requests get a new
  `AgentRunOutput` row of type `APPROVAL_REQUIRED`.
- The approval decision route later handles `subjectType === DirectLlmTask` by
  reading `agentRunId` and `directLlmOutput` from `approvalRequest.formData`.
  It updates that stored AgentRun id and advances or fails the workflow node with
  that stored output.

Impact:

- Retrying or reactivating a Direct LLM node while an older pending review exists
  can cause the human to approve stale LLM output from a previous AgentRun.
- The latest AgentRun can remain `AWAITING_REVIEW` while the approval decision
  marks an older AgentRun `APPROVED` or `REJECTED`.
- The workflow node can advance with stale prompt variables, stale event
  documents, stale structured output, stale model metadata, and stale artifact
  references.
- Co-work review evidence becomes unreliable: the approval request id is tied to
  the node, but not to the exact provider call/attempt being reviewed.

Required fixes:

- Make Direct LLM approval requests attempt-scoped: include `agentRunId`,
  runtime attempt, trace id, and output digest in the request identity.
- On retry, cancel or mark stale any previous pending Direct LLM approval for the
  same node before creating a new one.
- If request reuse is intentional, update `formData`, `APPROVAL_REQUIRED`
  output, and audit/outbox records atomically with a new attempt generation.
- In `POST /approvals/:id/decision`, verify the approval request's
  `agentRunId`, node id, instance id, output digest, and current `AgentRun.status`
  before updating the run or advancing the node.
- Add tests for retrying a Direct LLM node with a pending review, approving the
  stale request, approving the latest request, and ensuring the node advances
  only with the latest reviewed output.

### 138. AgentRun review bypasses the ApprovalRequest/quorum decision model

Evidence:

- `agent-runs.router.ts` exposes `POST /agent-runs/:id/review` for runs in
  `AWAITING_REVIEW`.
- The route loads the `AgentRun`, tenant-checks it, checks a synthetic
  capability routing object with `assertCanDecideApproval(...)`, then creates an
  `AgentReview` row and directly updates `AgentRun.status` to `APPROVED` or
  `REJECTED`.
- It logs `AgentRunReviewed`, creates an `AGENT_REVIEW` receipt, and publishes
  an `AgentRunReviewed` outbox event.
- The route does not load, create, or require an `ApprovalRequest`, and it does
  not write an `ApprovalDecision` row.
- The canonical `/approvals/:id/decision` path checks the pending
  `ApprovalRequest`, enforces duplicate-vote protection and quorum through
  `evaluateApprovalQuorum(...)`, updates `ApprovalRequest.status`, logs
  `ApprovalDecided` or `ApprovalVoteRecorded`, creates an
  `APPROVAL_DECISION` receipt, and publishes approval events.
- The `POST /agent-runs/:id/approve` resume path has the same shape for paused
  governed turns: it checks `assertCanDecideApproval(...)`, resumes
  Context Fabric, writes an `AGENT_APPROVAL` receipt, and updates the AgentRun,
  but still does not bind the decision to an `ApprovalRequest` or
  `ApprovalDecision`.

Impact:

- Agent review decisions can look governed while missing the platform's
  authoritative approval-request id, vote ledger, quorum evidence, and approval
  decision receipt.
- Multi-approver or separation-of-duty policies represented by
  `ApprovalRequest.quorumRequired`, `adminOverride`, routing history, escalation,
  and decision rows do not apply to AgentRun review endpoints.
- Approval inboxes, evidence packs, audit timelines, and access reviews cannot
  treat these decisions consistently with workflow, Direct LLM, specification,
  or business approvals.
- A future revocation, delegation, or quorum hardening change in the approval
  module can leave AgentRun review behavior unchanged, creating two approval
  semantics for agent work.

Required fixes:

- Create or require an `ApprovalRequest` for AgentRun review, with
  `subjectType = AgentRun`, the run id, tenant id, capability id, assignment
  routing, quorum policy, and current output digest.
- Make `POST /agent-runs/:id/review` a compatibility wrapper that resolves the
  request and delegates to `/approvals/:id/decision`.
- For paused governed turns, persist the pending approval as an `ApprovalRequest`
  instead of only an `AgentRunOutput` payload, and resume Context Fabric only
  after the approval decision reaches final quorum.
- Keep `AgentReview`, `AGENT_REVIEW`, and `AGENT_APPROVAL` as derived evidence
  if useful, but make `ApprovalRequest`/`ApprovalDecision` the source of truth.
- Add tests for direct-user, role, team, skill, quorum, duplicate vote,
  unauthorized user, stale run status, approved resume, and rejected resume.

### 139. AgentRun review queues are tenant-wide, not reviewer-eligible

Evidence:

- `agent-runs.router.ts` exposes `GET /agent-runs/pending-review`.
- The route builds a query of `status = AWAITING_REVIEW` plus tenant filtering
  when strict isolation is enabled, then returns matching runs with
  `include: { agent: true, outputs: true }`.
- It does not call `assertCanDecideApproval(...)`, `canDecideApproval(...)`, or
  any AgentRun view permission before returning those review candidates.
- `GET /agent-runs/pending-approval` has the same shape for `status = PAUSED`
  and includes the latest `AgentRunOutput` where
  `outputType = APPROVAL_REQUIRED`.
- The actual decision endpoints later call `assertCanDecideApproval(...)`, so
  the read queue and write decision semantics are inconsistent.
- `AgentTaskExecutor.ts` comments say the `APPROVAL_REQUIRED` output lets an
  operator locate the continuation token and call `/agent-runs/:id/approve`,
  which confirms the queue output is operationally sensitive.

Impact:

- Any authenticated tenant user can list pending agent reviews and paused
  governed approvals even when they are not the assigned reviewer, team member,
  role holder, skill holder, or capability approver.
- Queue rows can expose agent identity, output payloads, pending-approval
  metadata, continuation context, model results, and review timing before the
  user passes the decision authorization gate.
- The UI can show actionable-looking approval items that later fail on decision,
  creating poor operator experience and leaking sensitive workflow state.
- This weakens separation between reviewer inbox, auditor view, and tenant-wide
  operations view.

Required fixes:

- Make pending AgentRun review queues eligibility-filtered by the same routing
  logic used to decide the approval.
- Return direct/delegated actionable rows by default, and require an explicit
  `workflow:audit:view` or `agent:review:audit_view` permission for tenant-wide
  queues.
- Redact `outputs`, continuation payloads, prompt/model context, and raw
  approval metadata unless the caller can decide or audit that AgentRun.
- Prefer representing paused AgentRun approval as `ApprovalRequest` rows so the
  existing approval inbox and quorum logic can serve these queues.
- Add tests for direct assignee, role/team/skill reviewer, unauthorized tenant
  user, auditor read-only user, and redaction of `APPROVAL_REQUIRED` payloads.

### 140. ToolRun approval bypasses the ApprovalRequest/quorum decision model

Evidence:

- `tool-runs.router.ts` exposes `POST /tool-runs/:id/approve` and
  `POST /tool-runs/:id/reject` for rows in `PENDING_APPROVAL`.
- Both routes tenant-check the `ToolRun`, call `assertCanDecideApproval(...)`
  with `approvalPermission('tool')`, and then write a `ToolRunApproval` row.
- The approval route logs `ToolRunApproved`, creates a `TOOL_RUN_APPROVAL`
  receipt, publishes a `ToolRunApproved` outbox event, and returns the original
  `ToolRun`.
- The reject route writes `ToolRunApproval`, directly updates
  `ToolRun.status = REJECTED`, logs `ToolRunRejected`, and publishes a
  `ToolRunRejected` outbox event.
- Neither route loads or requires an `ApprovalRequest`, writes an
  `ApprovalDecision`, or calls `evaluateApprovalQuorum(...)`.
- The schema has `ToolRunApproval.approvalRequestId`, but the current approval
  and rejection paths leave the canonical approval request model unused.
- The canonical `/approvals/:id/decision` path performs duplicate-vote
  protection, quorum calculation, `ApprovalRequest.status` updates,
  `APPROVAL_DECISION` receipts, and `ApprovalDecided` /
  `ApprovalVoteRecorded` outbox events.

Impact:

- Tool approvals can approve external side effects while missing the platform's
  authoritative approval-request id, vote ledger, quorum evidence, and approval
  decision receipt.
- Separation-of-duty, multi-approver, escalation, delegation, and admin-override
  rules represented in `ApprovalRequest` and `ApprovalDecision` do not govern
  tool approvals.
- Evidence packs and audit timelines get a separate approval semantic for tools,
  even though tools are often the highest-risk actions because they reach
  external systems.
- Future hardening in the approval module can leave ToolRun behavior unchanged,
  creating a security fork between human approvals and tool approvals.

Required fixes:

- Represent pending tool approvals as `ApprovalRequest` rows with
  `subjectType = ToolRun`, tenant id, capability id, action/tool metadata,
  output/input digest, assignment route, and quorum policy.
- Make `/tool-runs/:id/approve` and `/tool-runs/:id/reject` compatibility
  wrappers that resolve the request and delegate to `/approvals/:id/decision`.
- Keep `ToolRunApproval` and `TOOL_RUN_APPROVAL` only as derived compatibility
  evidence, or remove them after migration.
- Add tests for direct approver, role/team/skill approver, quorum, duplicate
  vote, unauthorized user, stale run status, and rejected tool execution.

### 141. ToolRun approval queues and detail reads are tenant-wide, not reviewer-eligible

Evidence:

- `GET /tool-runs/pending-approval` builds a query for
  `status = PENDING_APPROVAL` plus tenant filtering, then returns matching rows
  with `include: { tool: true }`.
- The pending queue does not call `assertCanDecideApproval(...)`,
  `canDecideApproval(...)`, or a ToolRun view/audit permission before returning
  approval candidates.
- `GET /tool-runs/:id` calls `assertToolRunTenant(...)`, then returns the row
  with `include: { tool: true, approvals: true }`.
- The detail route does not require the caller to be the requested user, assigned
  reviewer, capability approver, auditor, or workflow operator.
- The decision endpoints later call `assertCanDecideApproval(...)`, so read
  access and decision access are inconsistent.

Impact:

- Any authenticated tenant user can list pending tool approvals and inspect tool
  details even when they cannot approve, reject, audit, or operate the tool run.
- Tool inputs, action names, requested user, approval history, and external-side
  effect context can leak through the pending queue or detail route.
- Operators can see actionable-looking approvals that fail only when clicked,
  which makes the approval inbox unreliable.
- This weakens the boundary between reviewer inbox, workflow operations view,
  and read-only audit view.

Required fixes:

- Filter pending ToolRun approval queues by the same eligibility logic used for
  the approval decision.
- Add explicit permissions such as `tool_run:view`, `tool_run:approve`, and
  `tool_run:audit_view`; require audit permission for tenant-wide queues.
- Redact tool input payloads, action metadata, approval identities, and external
  destination details unless the caller can approve or audit that row.
- Add tests for direct approver, role/team/skill approver, unauthorized tenant
  user, auditor read-only user, and sensitive payload redaction.

### 142. Approving a ToolRun creates a second execution row and leaves the pending row open

Evidence:

- `requestToolRun(...)` creates the original pending row with
  `status = PENDING_APPROVAL` when policy requires approval.
- `POST /tool-runs/:id/approve` records a `ToolRunApproval` for that pending row,
  then calls `executeToolRun(run.toolId, run.actionId, run.instanceId,
  run.inputPayload, userId, actionName)`.
- `executeToolRun(...)` does not accept an existing `ToolRun` id. It creates a
  new `ToolRun` row with `status = RUNNING`, executes the mock runner, updates
  that new row to `COMPLETED`, writes a `TOOL_RUN_EXECUTION` receipt, and
  publishes `ToolExecuted`.
- The approval route does not update the original pending row to `APPROVED`,
  `RUNNING`, or `COMPLETED`; it returns
  `prisma.toolRun.findUnique({ where: { id: run.id } })` for the original row.
- Because the pending queue lists rows where `status = PENDING_APPROVAL`, the
  original approved row can remain visible as still pending.
- The `ToolRun` model has a unique `(toolId, idempotencyKey)` constraint, but
  the approval path does not pass the pending row's idempotency key to
  `executeToolRun(...)`, so the execution row is not tied to the original
  idempotent request.

Impact:

- Approval evidence is attached to one `ToolRun`, while execution evidence and
  output are attached to a different `ToolRun`.
- Pending queues can continue showing already approved rows, inviting repeated
  approval attempts and confusing operators.
- Idempotency, retry, replay, and audit reconstruction become unreliable because
  the approved request and executed side effect are split across rows.
- A failure during execution can leave the original pending row unchanged while a
  second row records `FAILED`, making the user-facing status misleading.

Required fixes:

- Change tool execution after approval to transition the existing row with a
  compare-and-set update from `PENDING_APPROVAL` to `RUNNING` to a terminal
  status.
- If separate execution attempts are required, add an explicit execution-attempt
  model linked to the original ToolRun and mark the original row terminal.
- Preserve and enforce the original idempotency key during approval execution.
- Write approval, execution, receipts, and outbox records in a transaction or
  transactional outbox flow so evidence cannot split across rows.
- Add regression tests proving an approved pending ToolRun disappears from the
  pending queue, has one canonical run id, and records both approval and
  execution evidence under that id.

### 143. Canonical ApprovalRequest list and detail routes expose tenant-wide approval evidence

Evidence:

- `GET /approvals` accepts optional `status`, `instanceId`, and `nodeId`
  filters, requires only tenant context, and returns `ApprovalRequest` rows with
  `include: { decisions: true }`.
- In strict tenant mode, when no `instanceId` filter is supplied, the route
  scopes by workflow instance ids in the tenant. It does not filter by direct
  assignee, team, role, skill, capability membership, requester, owner, auditor,
  or workflow operator permission.
- `GET /approvals/:id` calls `assertApprovalRequestTenant(...)` and returns the
  request with decisions.
- `GET /approvals/:id/decisions` calls the same tenant assertion and returns all
  decision rows.
- The actionable inbox route `/approvals/my-approvals` has separate logic that
  resolves direct and delegated eligibility through `canDecideApproval(...)`,
  which confirms the generic list/detail routes are broader than the approval
  decision model.

Impact:

- Any authenticated tenant user with access to these routes can inspect approval
  requests and vote history that they are not assigned to, cannot decide, and may
  not be allowed to audit.
- Approval `formData`, subject ids, capability ids, assignee/team/role routing,
  notes, conditions, and decision identities can leak through general list or
  detail reads.
- Operators can see approval records that do not belong in their inbox, while
  the actual decision endpoint later denies them.
- The approval module has one strong actionable inbox and one broad evidence
  read path, making RBAC behavior inconsistent.

Required fixes:

- Split approval reads into explicit surfaces: actionable inbox, requester view,
  workflow/operator view, and audit view.
- Require `approval:view`, `approval:audit_view`, workflow-instance view, or
  subject-resource view permission before returning generic list/detail rows.
- Redact `formData`, decision notes/conditions, assignee identities, and subject
  metadata unless the caller can decide or audit the approval.
- Add tests for direct assignee, delegated role/team/skill approver, requester,
  workflow viewer, read-only auditor, and unrelated tenant user.

### 144. Strict tenant isolation rejects tenant-scoped approvals that are not linked to workflow instances

Evidence:

- `ApprovalRequest` has both `instanceId String?` and `tenantId String?`, with
  `tenantId` documented as the standalone-row tenant.
- `assertApprovalRequestTenant(...)` reads only `instanceId` for the approval and
  then calls `assertLinkedWorkflowInstanceTenant(...)`.
- `assertLinkedWorkflowInstanceTenant(...)` fails in strict mode when
  `instanceId` is missing, regardless of the approval row's `tenantId`.
- Multiple approval producers intentionally create non-workflow-instance
  approvals:
  - `portfolio-execution.service.ts` creates `DecisionDossier` approvals with
    `subjectType = DecisionDossier` and a tenant id, but no workflow instance.
  - `business-alignment.service.ts` creates `BusinessReadout` and
    `SpecificationChangeRequest` approvals with tenant id and capability id, but
    no workflow instance.
  - Specification review services create `SpecificationVersion` approval
    requests scoped by tenant and specification version, not necessarily by
    workflow instance.
- `POST /approvals/:id/decision`, `GET /approvals/:id`,
  `GET /approvals/:id/decisions`, and form submission all call
  `assertApprovalRequestTenant(...)`.

Impact:

- In the enterprise strict-isolation mode, portfolio, business, and
  specification approvals can become impossible to view, decide, or attach
  forms through the canonical approval API even though they carry a valid
  tenant id.
- Operators may see approvals created by domain services but receive
  `ApprovalRequest ... not linked to a workflow instance` style denials when
  acting on them.
- Teams can be pushed toward bypass/service-specific approval paths, weakening
  the unified approval model.
- Tenant isolation is over-fit to workflow runs instead of all approval
  resources, which contradicts the schema's standalone tenant support.

Required fixes:

- Change `assertApprovalRequestTenant(...)` to first enforce
  `ApprovalRequest.tenantId` against the request tenant.
- When `instanceId` is present, also verify the linked workflow instance belongs
  to the same tenant.
- Add subject-specific tenant assertions for `WorkItem`, `SpecificationVersion`,
  `DecisionDossier`, `BusinessReadout`, `SpecificationChangeRequest`,
  `DirectLlmTask`, and other approval subject types.
- Add strict-mode tests for approving tenant-scoped non-instance approvals and
  rejecting cross-tenant subject ids.

### 145. Approval escalation can assign the next request to an arbitrary user id

Evidence:

- `decisionSchema` accepts `decision = ESCALATED` with
  `escalateToId: z.string().uuid().optional()`.
- After the current approval decision is finalized as `ESCALATED`,
  `POST /approvals/:id/decision` creates a new `ApprovalRequest` with
  `assignedToId = escalateToId` and `assignmentMode = DIRECT_USER`.
- The route reuses the original request's tenant id, subject, routing metadata,
  quorum, and admin override, but it does not verify that `escalateToId` exists,
  belongs to the same tenant, holds the required approval permission, is a valid
  team/role/skill/capability approver, or is not disallowed by
  separation-of-duty policy.
- `assertCanDecideApproval(...)` authorizes the actor who is escalating the
  current request; it does not authorize the target user as an eligible
  recipient for the newly created request.
- There is an `ApprovalEscalation` model, but this route creates a new
  `ApprovalRequest` directly and does not write an escalation ledger row.

Impact:

- A valid approver can escalate an approval into a dead inbox by choosing a
  nonexistent or inactive user id.
- In local or mixed identity modes, the next request can target a user outside
  the intended tenant/team/capability routing boundary.
- Separation-of-duty and policy routing can be bypassed at assignment time and
  only partially caught later when the target tries to decide.
- Escalation evidence is split: the original request says `ESCALATED`, but the
  escalation chain is not consistently represented in `ApprovalEscalation`.

Required fixes:

- Validate escalation targets against IAM/local identity before creating the next
  request: active user, tenant membership, required capability permission,
  assignment policy, and separation-of-duty constraints.
- Support escalation to user, team, role, or skill using the same routing
  contract as initial approval assignment.
- Persist an `ApprovalEscalation` record linking source request, target request,
  actor, reason, target routing, and policy decision id.
- Add tests for missing user, cross-tenant user, inactive user, unauthorized
  recipient, self-escalation where disallowed, valid manager escalation, and
  escalation ledger continuity.

### 146. Pending-execution runners are not first-class identities

Evidence:

- The Prisma `ExecutionRunner` model only has `id`, `name`, `runnerType`,
  `config`, and `isActive`; it has no tenant, runtime id, user binding,
  service-principal binding, capability tags, execution location, token digest,
  heartbeat, lease, or pending-execution relation.
- `PendingExecution` stores `claimedBy` as a nullable string, not a foreign key
  to `ExecutionRunner`, runtime bridge identity, IAM service principal, or
  runner lease.
- Cross-instance pending-execution polling uses
  `assertInstancePermission(req.user!.userId, exec.instanceId, 'claim', ...)`
  before returning work, so the claimant is a WorkGraph user/session with
  workflow claim permission, not a registered runner identity.
- Claim and complete use the same human/user permission check:
  `assertInstancePermission(req.user!.userId, pendingForAuth.instanceId,
  'claim', ...)`.
- Workflow Operations can show queue counts and `claimedBy`, and can requeue a
  pending execution, but there is no corresponding runner enrollment,
  capability/location binding, heartbeat, or revocation lifecycle.

Impact:

- A browser/user JWT with workflow claim permission effectively becomes the
  runner identity for `CLIENT`, `EDGE`, and `EXTERNAL` nodes.
- The platform cannot distinguish laptop, edge, shared server, or third-party
  runners in policy, audit, revocation, or operations health.
- A shared runner cannot be safely scoped to one tenant, one capability, one
  execution location, or one allowed node class.
- Enterprise operations can see stuck queues, but cannot answer the harder
  questions: which registered runner owns this claim, is it still alive, what
  is it allowed to run, and should it be revoked?

Required fixes:

- Promote `ExecutionRunner` into a tenant-scoped runtime identity model with
  runtime id, owner user/team/service principal, supported locations, capability
  tags, token digest/key id, heartbeat, lease, status, and revocation metadata.
- Add `runnerId` and `claimLeaseId` to `PendingExecution`; keep `claimedBy` only
  as display/audit metadata.
- Require runner-scoped tokens for poll/claim/complete. Human users should
  manage/requeue runners, not execute queued runner work unless explicitly
  acting through a registered local runner.
- Filter queued work by runner tenant, location, capability tags, node type, and
  policy before returning node configuration.
- Add tests for runner enrollment, tenant/capability/location filtering,
  heartbeat expiry, revocation, and denied cross-runner claim/complete.

### 147. Pending-execution completion is claim-token gated but not owner-bound

Evidence:

- Claim writes both a fresh `claimToken` and `claimedBy: req.user?.userId`.
- Completion requires a `claimToken`, and the update is single-shot, but the
  update condition is only `{ id: req.params.execId, claimToken,
  completedAt: null }`.
- Completion does not require `claimedBy` to equal the caller, and there is no
  runner id or lease id to bind completion to the actor that won the claim.
- The route records `completedAt`, `result`, and `error`, but not
  `completedBy`, completed runner id, completion lease id, or runner token id.
- The source-level pending-execution contract test asserts token gating and
  token stripping, but it does not assert owner binding or runner identity
  continuity from claim to complete.

Impact:

- A leaked, copied, or forwarded claim token is a bearer capability: any caller
  that also has workflow `claim` permission can complete the execution.
- Audit evidence can say one user claimed the execution while a different user
  or runner completed it without that distinction being recorded.
- Requeue/revocation cannot invalidate a specific runner lease beyond rotating
  the token, because there is no lease owner in the completion predicate.
- This is acceptable for a small dev runner protocol, but too weak for
  enterprise edge/shared runner execution where queue ownership and result
  provenance matter.

Required fixes:

- Add `completedBy`, `runnerId`, and `claimLeaseId` to the completion path.
- Include runner/user owner and lease predicates in the completion `where`
  clause, for example `{ id, claimToken, runnerId, claimLeaseId,
  completedAt: null }`.
- Rotate claim tokens on every requeue and mark old leases revoked/expired with
  explicit audit events.
- Record claim and completion authorization decision ids, runner identity,
  token key id, and source IP/device metadata in the receipt/event stream.
- Add tests proving a different authorized claimant cannot complete another
  runner's claim, stale leases fail, revoked runners fail, and owner-bound
  completion still advances the workflow exactly once.

### 148. Runtime source discovery is not repository- or capability-scoped

Evidence:

- Context Fabric exposes `/api/runtime-bridge/source/tree`,
  `/api/runtime-bridge/source/file`, and `/api/runtime-bridge/source/branches`
  behind `X-Service-Token`.
- Those endpoints accept `user_id`, optional `tenant_id`, `repoUrl`, branch, and
  path, then call `authorize_runtime_target(user_id, tenant_id)` without a
  capability id or repository binding.
- When production actor authorization is enabled and `capability_id` is absent,
  `authorize_runtime_target()` checks IAM action `workflow:runtime:dispatch`
  against `capability_id="__platform__"`.
- Agent Runtime capability discovery calls the source bridge with
  `{ user_id: routeUserId, ...body }`, where `body` is just repo URL, branch, and
  optional path.
- WorkGraph connector branch discovery calls
  `/api/runtime-bridge/source/branches` with only `{ user_id: iamUserId,
  repoUrl }`.

Impact:

- A service-token caller can route arbitrary repo source reads through a user's
  connected runtime once that user has broad runtime dispatch permission.
- IAM is not asked whether the requested repo belongs to the selected
  capability, whether the user has access to that capability repository, or
  whether the source path is allowed for onboarding.
- Operations/audit cannot distinguish valid capability bootstrap source reads
  from unrelated repository probing performed through the same runtime.
- This weakens the intended model that GitHub/source egress is governed through
  MCP/runtime placement and capability ownership.

Required fixes:

- Require source discovery requests to carry `tenant_id`, `capability_id`, and a
  resolved repository id or registered source binding.
- Authorize against a source-specific action such as
  `capability:repository:read` or `workflow:source:discover`, not the generic
  platform runtime dispatch action.
- Validate `repoUrl`, branch, and path against the capability's active linked
  repository/source policy before dispatching a runtime frame.
- Include capability id, repository id, source path, runtime id, and authz
  decision id in source-discovery receipts or audit events.
- Add tests proving unrelated repo URLs, missing tenant, missing capability,
  cross-tenant capability, and unauthorized source paths fail closed.

### 149. Runtime worktree writes do not carry workflow/capability authorization context

Evidence:

- Context Fabric `/api/runtime-bridge/worktree/file` accepts `user_id`,
  optional `tenant_id`, `workItemCode`, `path`, `content`, commit message, and
  author fields.
- The endpoint authorizes with `authorize_runtime_target(user_id=req.user_id,
  tenant_id=req.tenant_id)` and does not accept or derive `capability_id`,
  workflow instance id, work item id, run id, artifact id, trace id, or an
  evidence-publisher action.
- Without a capability id, the IAM check uses the generic `__platform__`
  capability context.
- The WorkGraph evidence materializer calls this endpoint with only
  `{ workItemCode, path, content, message, authorEmail, authorName }`; it does
  not send user id, tenant id, capability id, workflow instance id, or trace id.
- The direct fallback path writes the same file through
  `MCP_SERVER_URL /mcp/worktree/:code/file`.
- The current runtime-bridge test for worktree write only proves HTTP fallback is
  explicit when no runtime is connected; it does not prove workflow/capability
  authorization or scoped evidence publication.

Impact:

- Evidence publication into a work-item branch is not bound to the workflow run
  that produced the evidence or to the capability that owns the work item.
- In production authorization-required mode, legitimate evidence materialization
  can fail because the caller omits required actor/tenant context.
- In relaxed/development mode, a service-token caller can request writes by
  `workItemCode/path` without proving ownership of that work item or artifact.
- Audit evidence for branch mutations lacks the authorization snapshot, trace id,
  workflow instance id, and publishing actor needed for enterprise evidence
  packs.

Required fixes:

- Extend the worktree-write bridge request with tenant id, actor id,
  capability id, workflow instance id, work item id/code, trace id,
  authorization snapshot id, artifact/evidence id, and intended write purpose.
- Authorize with a specific action such as `workflow:evidence:publish` or
  `work_item:artifact:publish` against the owning capability/work item.
- Resolve `workItemCode` server-side to tenant, work item, capability, and
  repository before dispatch; reject mismatches and missing mappings.
- Require the evidence materializer to pass the current instance/work-item
  context and to fail closed instead of silently falling back to direct MCP when
  strict runtime routing is expected.
- Add tests for missing context, wrong tenant, wrong capability, wrong
  work-item code, stale authorization snapshot, blocked artifact publication,
  and successful scoped evidence writes.

### 150. Trace cockpit can silently under-report Context Fabric and MCP receipts

Evidence:

- WorkGraph `/api/receipts?trace_id=...` is the Platform Web trace API's primary
  receipt source.
- `receipts.router.ts` fetches Context Fabric `/receipts?trace_id=...` in
  `cfReceipts()`, but returns `[]` when Context Fabric is unreachable, returns a
  non-2xx status, returns invalid JSON, or returns a body without a `receipts`
  array.
- The public response only includes source counts for `workgraph-api`,
  `context-api`, and `mcp-server`; it does not include a `warnings` or
  `sourceErrors` field explaining that Context Fabric receipt fetch failed.
- Platform Web `/api/traces/:traceId` calls WorkGraph receipts, audit-governance
  timeline, and platform logs. It can warn when the WorkGraph receipts endpoint
  itself fails, but it cannot see an inner Context Fabric receipt-fetch failure
  because WorkGraph has already normalized that failure to an empty `cf` array.

Impact:

- Operators can inspect a trace that shows WorkGraph receipts and zero
  Context Fabric/MCP receipts without knowing whether the runtime produced no
  evidence or the trace merge silently lost a source.
- Evidence-pack and governance investigations can miss MCP/tool/model receipts
  while still rendering a valid-looking unified trace response.
- This weakens the intended trace spine because source coverage is not
  fail-visible at the exact boundary where cross-service evidence is merged.

Required fixes:

- Change `cfReceipts()` to return `{ receipts, warning/sourceError }` instead of
  only an array.
- Surface Context Fabric fetch status, parse errors, timeout, and service-token
  denial in `/api/receipts` response metadata.
- Teach `/api/traces/:traceId` and `/audit/trace/:traceId` to display per-source
  status: `loaded`, `empty`, `unavailable`, `unauthorized`, or `parse_error`.
- Add a trace-spine smoke where WorkGraph has a local receipt, Context Fabric is
  unreachable, and the UI/API response explicitly reports the missing CF/MCP
  source instead of treating it as zero evidence.

### 151. Workflow designer edge edits bypass optimistic design-revision checks

Evidence:

- `WorkflowStudioPage.tsx` tracks `designRevision` from
  `/workflow-templates/:id/design-graph`.
- The same page builds `designRequestConfig()` to send `If-Match:
  <designRevision>` for design-mode mutations.
- Node creation, node patching, node deletion, and edge creation use
  `designRequestConfig()`.
- The `patchEdge` mutation calls `api.patch(url, payload)` without
  `designRequestConfig()`.
- `handleDeleteBranch()` calls `api.delete(url)` directly without
  `designRequestConfig()`.
- The API-side `bumpDesignRevision()` can enforce an expected revision when
  `If-Match` or `x-workflow-design-revision` is present, but when the header is
  absent it increments any DRAFT workflow revision.

Impact:

- Two designers can concurrently edit branch labels or conditions and the later
  edge edit wins instead of failing with "Workflow design changed while saving".
- Branch-condition edits are runtime-significant: they can change which
  approval, governance gate, Direct LLM task, or Git push path executes.
- The UI can optimistically display an edge condition that overwrote a newer
  graph state without forcing the author to refresh and reconcile.

Required fixes:

- Pass `designRequestConfig()` for edge patch and delete mutations in design
  mode.
- Update `designRevision` from `X-Workflow-Design-Revision` after every
  successful design mutation, including edge edits.
- Add browser or component tests proving stale edge condition updates/deletes
  fail and surface the conflict message.
- Consider making `If-Match` mandatory for all DRAFT design mutations once the
  UI is consistently sending it.

### 152. IAM organization hierarchy is not tenant-bound end to end

Evidence:

- `BusinessUnit` has no `tenant_id` column in `singularity-iam-service/app/models.py`.
- `/business-units` lists every business unit and `create_bu()` writes only
  `bu_key`, `name`, `description`, `parent_bu_id`, metadata, and tags.
- `Team` has a nullable `tenant_id`, but `CreateTeamRequest` has no tenant field
  and `create_team()` never sets `tenant_id`.
- `TeamOut` does not return `tenant_id`, so Platform Web cannot display or filter
  team ownership even if a row was tenant-bound by another path.
- Team membership routes list by `team_id` or `user_id` without tenant filters.
  `add_team_member()` verifies the team exists, but not that the user is an
  active member of the same tenant or that the team is tenant-scoped.
- The Identity console loads business units and teams with generic
  `listIdentity(...)` calls and uses the returned rows directly for parent,
  team, and membership dropdowns.

Impact:

- A super-admin can build an organization hierarchy that looks tenant-local in
  the UI but is actually global or null-tenant in IAM storage.
- Team-based capability authorization can inherit from teams that are not
  reliably owned by the tenant being authorized.
- Multi-tenant operators cannot reason about which tenant owns a business unit,
  team, parent relationship, or team membership.
- User/team pickers can show cross-tenant org data in the same list, increasing
  the chance of accidental grants and confusing access-debug output.

Required fixes:

- Add tenant ownership to `BusinessUnit` and make `Team.tenant_id` non-null in
  strict/production mode.
- Include `tenant_id` in business unit/team create/update/list APIs and filter
  reads by the caller's active tenant unless an elevated cross-tenant admin
  permission is present.
- Require parent business units, parent teams, owning business units, members,
  and child teams to belong to the same tenant unless an explicit cross-tenant
  relationship model permits it.
- Return tenant metadata in `BusinessUnitOut` and `TeamOut`; make Platform Web
  dropdowns tenant-filtered and clearly labeled.
- Add tests proving tenant A cannot see, parent under, or add members to tenant
  B business units/teams.

### 153. IAM platform-role assignment is effectively global despite tenant-aware authz

Evidence:

- `PlatformRoleAssignment` has a nullable `tenant_id`, and the authz resolver
  reads assignments where `tenant_id == requested tenant` or `tenant_id IS NULL`.
- The database uniqueness constraint is only `(user_id, role_id)`, so the same
  user cannot hold the same role separately in two tenants with different grant
  metadata.
- `GET /users/{user_id}/roles` lists assignments by user only.
- `POST /users/{user_id}/roles` accepts only `role_key`, checks only
  `(user_id, role_id)`, and creates `PlatformRoleAssignment(user_id, role_id,
  granted_by)` with no `tenant_id`.
- `DELETE /users/{user_id}/roles/{role_key}` also deletes by user and role only.
- Platform Web's user management modal calls `assignUserRole(userId, roleKey)`
  with no tenant selection and labels the section "Platform roles".

Impact:

- Any role assigned through the normal IAM admin UI/API becomes a null-tenant
  platform role that applies to every tenant where the user is an active member.
- Operators cannot grant the same role to one user in tenant A but withhold it
  in tenant B using the current UI/API path.
- Audit records for `platform_role_assigned` contain only `role_key`, so they do
  not prove which tenant received the grant.
- This weakens the otherwise improved `/authz/check` tenant binding because the
  role data being evaluated is commonly global by construction.

Required fixes:

- Require `tenant_id` for tenant-scoped platform role assignments in production;
  reserve null-tenant assignments for explicit platform-super-admin grants.
- Change the uniqueness invariant to include `tenant_id` or introduce a separate
  global-platform-role model for true global grants.
- Update list, assign, and revoke role endpoints to require tenant context and
  verify active user membership in that tenant.
- Add tenant selection and tenant labels in the Identity console user role
  manager.
- Include `tenant_id`, grant source, actor, and decision id in role-assignment
  audit events.

### 154. IAM role and permission taxonomies are UI-suggested but not server-enforced

Evidence:

- Platform Web provides fixed options for permission categories and role scopes:
  `workflow`, `agent`, `tool`, `context`, `model`, `capability`, `governance`,
  `admin`, and `platform`/`capability`.
- `CreateRoleRequest.role_scope` is a plain string with default `capability`,
  and `create_role()` stores it without checking an allowed enum.
- `CreatePermissionRequest.category` and `UpdatePermissionRequest.category` are
  optional strings, and create/update routes store the provided value without
  checking the platform taxonomy.
- The permissions table stores `category` as a nullable string and roles store
  `role_scope` as a string; no database check constraint enforces the accepted
  vocabulary.

Impact:

- Direct API clients can create roles with typo or unknown scopes such as
  `capabilty`, `tenant-admin`, or `global`, and the UI may later display them as
  normal choices.
- Permission categories can drift away from the taxonomy used by navigation,
  role builders, documentation, and security reviews.
- Enterprise access reviews become harder because "scope" and "category" values
  are not canonical evidence; they are only operator-entered labels.
- Future authorization code may accidentally depend on non-normalized strings.

Required fixes:

- Use server-side enums or validated literals for role scopes and permission
  categories, with an explicit extension path for custom taxonomy values.
- Add database check constraints or reference tables for the approved taxonomy.
- Normalize values on write and reject unknown values with field-level errors.
- Add migration/backfill checks to flag existing unknown role scopes and
  permission categories before strict mode is enabled.

### 155. Agent template/profile read APIs are not resource-authorized

Evidence:

- `agent.routes.ts` protects the agents router with `requireAuth`, then exposes
  `GET /templates`, `GET /templates/:id`, and `GET /templates/:id/versions`.
- `agent.controller.ts` calls `agentService.listTemplates(...)`,
  `agentService.getTemplate(...)`, and `agentService.listTemplateVersions(...)`
  without passing `req.user` into the service.
- `listTemplates()` filters only by caller-supplied role/status/scope/capability
  query values and returns matching `AgentTemplate` rows with skill links.
- `getTemplate()` fetches by raw template id and includes the template's skill
  bindings.
- `listTemplateVersions()` fetches the template by id, then returns every
  `AgentTemplateVersion` row for that id.
- By contrast, mutation and profile-source/resolve paths do enforce platform
  admin or capability ownership through `requirePlatformAdmin(...)` and
  `requireCapabilityOwner(...)`.
- `listSkills()` also returns all active `AgentSkill` rows to any authenticated
  caller.

Impact:

- A user who cannot edit or resolve another capability's profile can still list
  or directly fetch its agent template metadata, instructions, skill links,
  prompt layer references, and version snapshots.
- Template version history can disclose older prompt/instruction text that may
  have been removed from the active profile.
- Platform Web can mark a profile as non-editable, but the API still exposes
  read surfaces without the same resource boundary.
- This weakens the "agent profile as governed execution contract" model because
  template/profile reads are not tied to capability membership, workflow access,
  or audit-view permission.

Required fixes:

- Pass the authenticated actor into template list/detail/version services.
- Filter list results to common templates plus capability templates the caller can
  view, or require platform admin for cross-capability reads.
- Add a dedicated read permission such as `agent_template:view` or
  `capability:agent_profile:view` and enforce it consistently.
- Treat version snapshots and source/skill metadata as evidence objects; require
  stronger audit/sensitive permission for historical prompt text if needed.
- Add direct-ID tests proving an unrelated capability user cannot fetch another
  capability's template, skill links, or version snapshots.

### 156. Context Fabric profile resolution cannot use capability-scoped profiles reliably

Evidence:

- WorkGraph `AgentTaskExecutor` sends `run_context.agent_template_id` to Context
  Fabric, but does not pre-resolve or pass `effective_capabilities`.
- Context Fabric `_resolve_agent_profile_capabilities()` calls
  `POST /api/v1/agents/profiles/:id/resolve` using an IAM service token.
- Agent Runtime's `resolveProfile()` allows common templates for any
  authenticated caller, but capability-scoped profiles require
  `requireCapabilityOwner(actor, template.capabilityId, "Resolving an agent
  profile")`.
- Agent Runtime service-token authentication creates an actor with service
  scopes and an empty `capability_ids` list; `requireCapabilityOwner(...)` only
  accepts platform admin flags/permissions, `capability_ids`, or owner role
  strings.
- In Context Fabric `/execute`, a profile resolution exception fails closed in
  `governance_mode=fail_closed`, otherwise records a warning. In the governed
  stage path, profile resolution failure sets an empty effective-capability set
  with `effective_capabilities_required=true`.

Impact:

- Capability-scoped agent profiles can be created successfully in Agent Studio
  but fail at runtime when Context Fabric resolves them with the platform service
  token.
- Teams may fall back to common templates because those resolve, defeating the
  user-facing promise that each capability can bind its own source-backed
  profile.
- Empty effective capability sets then hide all profile-scoped tools, creating
  confusing `EFFECTIVE_CAPABILITY_DENIED` or "no tools available" failures even
  when the profile itself is correctly configured.
- The runtime identity model is muddled: service-to-service resolution needs a
  scoped read authority, while user-driven profile inspection/editing needs
  human capability permissions.

Required fixes:

- Introduce a service-token scope such as `agent_profile:resolve` or
  `agent_template:runtime_resolve`, tenant-bound and optionally capability-bound.
- Let `resolveProfile()` accept either human capability ownership/view permission
  or a scoped service principal, and record the delegated run actor/capability in
  resolution evidence.
- Alternatively, make WorkGraph pre-resolve the profile at workflow start with
  the launching user's authorization snapshot and pass the pinned effective
  capability set to Context Fabric.
- Add an integration test for a capability-scoped profile used by an Agent Task:
  WorkGraph -> Context Fabric -> Agent Runtime resolve -> tool gate.
- Surface profile-resolution failures in the run cockpit as a first-class
  blocked stage with profile id, capability id, caller type, and missing
  permission/scope.

### 157. Fresh-clone setup can report completion even after smoke failure

Evidence:

- `bin/setup.sh` treats `bin/bare-metal-apps.sh smoke` and
  `bin/bare-metal-runtime.sh smoke` failures as warnings, then still prints
  `setup complete. Open:` with the normal route list.
- `bin/bare-metal.sh smoke` itself exits nonzero when any endpoint fails, so the
  failing signal exists but is intentionally downgraded by the wrapper.
- The normal smoke list includes backend health endpoints, Platform Web routes,
  Agent Studio, Workflows, Workbench, Foundry, Identity, and strict Agent Runtime
  health; a 000/500/404 here usually means the fresh clone is not usable yet.

Impact:

- Users can see "setup complete" while `/workflows`, Agent Studio, Workbench, or
  strict service health is already known to be broken.
- Office-laptop/fresh-clone runs become hard to triage because the first command
  ends with success language instead of a failed setup state and exact next
  command.
- Automation cannot reliably treat `bin/setup.sh --yes` as a readiness gate.

Required fixes:

- Make smoke failure a blocking setup failure by default.
- Add an explicit `--allow-unhealthy` or `SINGULARITY_SETUP_ALLOW_UNHEALTHY=1`
  escape hatch for developer bootstrapping.
- Print a compact failure summary with failed URL, expected status, log file, and
  retry command, then exit nonzero.
- Keep the final "Open:" route list only for passing smoke or clearly label it
  as "services started, smoke failed".
- Add setup-script tests that simulate a failing smoke command and assert the
  wrapper exits nonzero unless the escape hatch is set.

### 158. Runtime-Bridge-first production still requires a direct MCP bearer secret

Evidence:

- `docs/runtime-dial-in-fabric.md` says the normal path is MCP outbound
  WebSocket dial-in and direct HTTP fallback is only used when
  `RUNTIME_HTTP_FALLBACK_ENABLED=true`.
- `context-fabric/services/context_api_service/app/config.py` still enforces a
  production-class `MCP_BEARER_TOKEN` unconditionally at import time.
- `bin/check-deploy-env.sh` also treats `MCP_BEARER_TOKEN` as a mandatory rotated
  production secret, and `docs/deploy-required-secrets.json` lists it as a
  required GitHub Environment secret.
- `bin/check-deployment-env.sh` is more nuanced for split runtime: it only
  requires `MCP_BEARER_TOKEN` when HTTP fallback is explicitly enabled.

Impact:

- Operators deploying the intended Runtime Bridge architecture are still forced
  to mint and distribute a secret for a debug/compatibility HTTP path.
- The platform sends mixed guidance: "do not rely on direct MCP HTTP" but also
  "production cannot start without the direct MCP HTTP bearer token."
- Extra unused bearer secrets increase rotation burden and can become accidental
  fallback credentials if someone enables HTTP fallback later.

Required fixes:

- Require `MCP_BEARER_TOKEN` only when `RUNTIME_HTTP_FALLBACK_ENABLED=true` or
  another explicit direct-MCP debug mode is enabled.
- For bridge-only production, replace the bearer invariant with Runtime Bridge
  token verification, tenant allowlist, and connected-runtime readiness checks.
- Update `bin/check-deploy-env.sh`, `docs/deploy-required-secrets.json`, Context
  Fabric production startup, and Operations readiness to use the same rule.
- Add tests for production startup with bridge-only mode and no
  `MCP_BEARER_TOKEN`, and for debug fallback mode where the token is mandatory.

### 159. Deployment env checks do not share one source-of-truth contract

Evidence:

- `bin/check-deploy-env.sh` is the production/remote Docker deploy guard. It
  reads `.env`, `.env.local`, `.env.deploy`, `.env.production`, component env
  files, shell env, and `.singularity/config.local.json`, then enforces
  production guardrails such as manifest signing, tenant-scoped service tokens,
  WorkGraph RLS posture, and rotated secrets.
- `bin/check-deployment-env.sh` is the split runtime/client-server checker. It
  sources `.env`, `.env.local`, `.env.laptop`, `.env.llm-secrets`, reads the
  runtime CLI config, and checks a different client/server variable set.
- `bin/bare-metal-apps.sh env-check` delegates only to
  `bin/check-deployment-env.sh server`; `bin/setup.sh` does not run either check
  before boot and only points users to `bin/doctor.sh` after setup output.
- `docs/deploy-required-secrets.json` is a third declarative manifest for GitHub
  Environment secrets, but the split-runtime checker does not consume it.

Impact:

- A configuration can pass the local split-runtime check and still fail the
  production deploy guard, or pass a deploy-preflight file merge that the
  bare-metal/server checker never loads.
- Operators need to remember which checker applies to Docker, bare metal,
  server-only, client runtime, split runtime, GitHub Actions, and production.
- Fresh-clone usability remains fragile because the setup path and deployment
  path validate different contracts at different times.

Required fixes:

- Create a single typed deployment contract manifest with environment groups:
  `server`, `client-runtime`, `docker-deploy`, `bare-metal`, `production`, and
  `debug-fallback`.
- Make `check-deploy-env.sh`, `check-deployment-env.sh`, `doctor.sh`, `setup.sh`,
  GitHub secret validation, and Operations readiness consume the same manifest.
- Define one deterministic env-loader precedence per boundary and document it in
  the generated check output.
- Run the relevant preflight before `bin/setup.sh` starts services, with an
  explicit developer override for warnings.
- Add contract tests that compare every checker against the manifest so new env
  names cannot drift silently.

### 160. Agent Task governance overlay resolution fails open before Context Fabric

Evidence:

- `governance.service.ts` describes `enrichStageRequestWithGovernance(...)` as the
  chokepoint for governed-stage dispatch, but its header explicitly says
  `Best-effort + FAIL-OPEN`.
- If `resolveGovernance(...)` returns no overlay, the function returns without
  changing the `GovernedStageRequest`.
- If IAM/governance resolution throws, the catch block only logs
  `continuing without enforcement`.
- Context Fabric's governed-stage request treats `governance_overlay` as optional:
  absent/advisory means no G4 enforcement.
- The standalone `GovernanceGateExecutor` does have a fail-closed path for hard
  gates when policy or overlay resolution fails, so the platform currently has
  two different governance enforcement postures depending on whether designers
  used a separate Governance Gate node or relied on Agent Task stage governance.

Impact:

- A capability-governed Agent Task can execute without its BLOCKING/REQUIRED
  governance controls if IAM or governance resolution is unavailable at dispatch
  time.
- Evidence may show a governed-stage run while the actual overlay was never
  attached, making run receipts weaker than the enterprise policy model implies.
- Designers can believe governance is centrally attached to the capability, but
  enforcement becomes optional unless they also model an explicit Governance Gate.

Required fixes:

- Make governance overlay resolution fail closed for production and for any stage
  whose policy says controls are mandatory.
- Add an explicit per-template/stage override such as
  `governanceResolutionMode = fail_closed | advisory | disabled`, defaulting to
  `fail_closed` outside local demo mode.
- Persist a governance resolution receipt for every governed Agent Task, including
  `overlayHash`, source, waiver keys, resolution mode, and failure reason.
- Make Context Fabric reject `governance_required=true` requests that omit
  `governance_overlay`.
- Add tests for IAM unavailable, no overlay, advisory overlay, blocking overlay,
  waiver present, and waiver absent across both Agent Task and Governance Gate
  execution paths.

### 161. Human Task APIs are not assignment-aware authorization boundaries

Evidence:

- `/api/tasks` is behind `authMiddleware`, but `tasks.router.ts` does not call a
  task/capability permission helper before list, get, create, claim, assign,
  complete, comment, or form-submission routes.
- `GET /api/tasks` lists all visible tenant tasks for any authenticated tenant
  user, without filtering to assigned user, eligible team/role/skill, owning
  capability, workflow operator role, or auditor role.
- `GET /api/tasks/team-queue/:teamId` queries `prisma.teamQueueItem` directly
  outside `withTenantDbTransaction` and without proving the caller belongs to
  that team.
- `POST /api/tasks/:id/claim` first loads an unclaimed queue item by `taskId`
  without tenant transaction or team-membership check, then stamps the current
  user as claimant.
- `POST /api/tasks/:id/complete` and `POST /api/tasks/:id/form-submission` mark
  tasks completed and advance workflow nodes without checking that the caller is
  the assignee, eligible team member, required role/skill holder, task creator,
  workflow operator, or approved delegate.
- Document upload/link attachment checks only direct assignments, creator, or
  admin; they do not match the richer Human Task assignment modes such as
  `TEAM_QUEUE`, `ROLE_BASED`, or `SKILL_BASED`.

Impact:

- Human Task can become a weak point in enterprise workflows: any tenant user may
  inspect, claim, complete, or submit data for tasks they should only see through
  assignment or delegated approval.
- Runtime placeholders for per-node approvers are safer at activation time, but
  the resulting task rows are not protected by the same assignment contract at
  interaction time.
- Attachments and form answers can be supplied by the wrong user and then drive
  downstream workflow decisions, evidence packs, or approvals.
- Team queues can leak or be claimable across teams if the request tenant/RLS
  context is absent or the app role bypasses RLS.

Required fixes:

- Add a centralized `assertTaskAccess(...)` / `assertHumanTaskAction(...)` helper
  covering `view`, `claim`, `assign`, `complete`, `comment`, `attach_document`,
  and `submit_form`.
- Resolve eligibility from the same assignment model used at activation:
  direct user, team membership, role on capability, skill, creator, workflow
  operator, auditor, admin override, and delegation.
- Put every task, queue, comment, history, and attachment query/write inside
  tenant-scoped transactions and add explicit tenant filters where possible.
- Filter task listing routes by effective access unless the caller has an
  operator/auditor permission.
- Align document attachment authorization with task assignment modes instead of
  direct-assignment-only checks.
- Add IDOR tests for task list/get/claim/complete/form/attachment across two
  tenants, two teams, role/skill assignments, admin override, and revoked users.

### 162. Synthesis attention desk can resolve or auto-confirm projected work without source authority

Evidence:

- `AttentionItem` is explicitly modeled as a projection whose source record
  remains authoritative, but the row stores `assignedToId`, `autoConfirmAt`,
  `resolution`, `resolvedById`, and `resolvedAt`.
- `attentionCanAcknowledge(...)` allows only `REVIEW` and `DIGEST` bands to be
  acknowledged, which is a useful band-level guard but not a source-level
  authorization check.
- `POST /experience/attention/:itemId/resolve` accepts only an attention item id,
  resolution, and optional note. It does not include project id, source type, or
  an expected source revision.
- `resolveAttentionItem(...)` loads the item by `{ id, tenantId }`, verifies only
  `status === 'OPEN'` and `attentionCanAcknowledge(item.band)`, then writes
  `status = 'RESOLVED'`, `resolution`, `resolvedById`, and `resolvedAt`.
- The same function does not verify `assignedToId`, team/role/capability
  membership, project access, or the caller's ability to view/decide the
  underlying `STUDIO_PROPOSAL`, `AGENT_VERDICT`, `BUSINESS_RISK`, `APPROVAL`, or
  `VALIDATION_REPORT` source.
- `autoConfirmDueAttention(...)` resolves every due tenant `DIGEST` item as
  `CONFIRMED` using actor `attention-auto-confirm`; it does not re-check the
  source state, project status, assignment, source-specific auto-confirm policy,
  or whether the item became sensitive after it was projected.
- The scheduler calls `autoConfirmDueAttention()` per tenant before running the
  overnight shift, so this can happen without a human request path.
- Searches found no tests for `AttentionItemResolved`,
  `AttentionItemAutoConfirmed`, `resolveAttentionItem(...)`, or
  `autoConfirmDueAttention(...)`.

Impact:

- Any broadly authorized Studio user in the tenant can resolve review/digest
  attention items by id even when the item is assigned to another owner or points
  at a source they should not be allowed to decide.
- Auto-confirmed digest items contribute to readiness calibration and morning
  brief evidence without proving the source is still eligible for silent
  confirmation.
- The attention desk can appear to close work while the authoritative source
  remains undecided, stale, or permission-sensitive, creating misleading adoption
  health and portfolio readiness signals.
- Audit evidence records that the projection was resolved, but not the source
  authorization decision that made that resolution legitimate.

Required fixes:

- Add a source-aware `assertAttentionAction(...)` helper that resolves the
  attention source and enforces project/capability access, assignment,
  role/team/skill eligibility, and source-specific decision permission before
  manual resolution.
- Require attention resolution requests to carry `projectId`, `sourceType`,
  `sourceId`, and expected `lastProjectedAt` or source revision, then fail closed
  on stale projections.
- Make auto-confirm policy source-specific and re-evaluate the source immediately
  before confirmation; disable auto-confirm for items with assignment,
  sensitivity, approval, conflict, or changed source state.
- Record the source authorization decision id, policy version, source revision,
  and auto-confirm policy version on every resolution.
- Add tests for assigned vs unassigned attention items, unauthorized project
  users, stale projections, source-state changes, auto-confirm eligibility, and
  cross-tenant item ids.

### 163. Editable project specifications are not frozen by initiative or review state

Evidence:

- `ProjectSpecification` is the editable draft buffer for a
  `SpecificationProject`; `SpecificationVersion` is the approved/locked immutable
  version with `contentHash` and approval metadata.
- `patchProjectSpecSection(...)` validates the section payload and checks only
  `expectedRevision` against the current draft revision before updating
  `ProjectSpecification.package`, incrementing `revision`, and writing
  `updatedById`.
- The same patch path does not inspect `SpecificationProject.status`, latest
  `SpecificationVersion.status`, pending approval requests, active generation
  plans, or existing WorkItem specification bindings before mutating the draft
  package.
- `compileProjectSpecificationInternal(...)` creates a project-owned
  `SpecificationVersion` from the current draft and moves the project to
  `IN_REVIEW`.
- `finalizeProjectSpecificationVersion(...)` approves a version, stores the
  approved `contentHash`, supersedes older approved versions, and moves the
  project back to `ACTIVE`.
- `SpecificationProjectStatus` includes `DRAFT`, `IN_REVIEW`, `LOCKED`,
  `GENERATING`, `ACTIVE`, `CHANGE_REQUESTED`, and `ARCHIVED`, but
  `patchProjectSpecSection(...)` does not enforce any of those lifecycle states.
- Searches found only schema-level tests for `patchProjectSpecSchema`; no tests
  prove project-spec patching is blocked during `IN_REVIEW`, after approval,
  while generation plans exist, or when WorkItems are bound to an approved
  specification version.

Impact:

- A user can continue editing the project draft while another user is reviewing a
  compiled `SpecificationVersion`, causing the draft shown in Synthesis to drift
  from the exact version under approval.
- After approval, later generation can be based on a draft that changed after the
  approved content hash, unless users explicitly recompile and reapprove.
- WorkItem bindings and handoffs can point to an approved immutable package while
  the Synthesis editor shows a different mutable package, making source-of-truth
  questions hard to answer in audits.
- The platform has lifecycle names for governed spec changes, but the central
  editor path still behaves like a free-form draft buffer.

Required fixes:

- Add a project-spec write gate that allows direct section patches only in
  `DRAFT` or explicit `CHANGE_REQUESTED` states, and rejects or redirects writes
  in `IN_REVIEW`, `LOCKED`, `GENERATING`, `ACTIVE`, `ARCHIVED`, or while approval
  requests are pending.
- When an approved version exists, require edits to create a
  `SpecificationChangeRequest` or new draft generation rather than mutating the
  currently displayed package without a change-control record.
- Store a `baseSpecificationVersionId`, base content hash, and base draft
  revision for every change request or recompile so impact analysis can compare
  the exact before/after packages.
- Surface the draft/approved-version divergence in Synthesis with explicit
  labels such as "Approved version" and "Working draft".
- Add tests for patching in every `SpecificationProjectStatus`, pending review,
  approved version present, active generation plan present, and bound WorkItems
  present.

### 164. Event document links are not governed source artifacts before Direct LLM validation

Evidence:

- Canonical event intake accepts arbitrary event payload objects and passes the
  original payload into `fanOutToWorkItemTriggersDetailed(...)` after only payload
  size validation.
- `triggerDocumentsFromPayload(...)` extracts document values from configured
  `documentsPath`, `documentLinksPath`, `documentUrlsPath`, `documentUrlPath`, and
  payload keys such as `documents`, `documentLinks`, `documentUrls`,
  `documentUrl`, and `document`.
- `normalizeTriggerDocument(...)` treats any string beginning with `http://` or
  `https://` as a document URL and records it as `{ url, mediaType:
  'text/uri-list' }`. It does not validate the URL host, reject credentials,
  block private/reserved networks, fetch content, compute a content hash, or
  create an `IngestedArtifact`.
- The current tests assert that an event payload value such as
  `https://docs.example/design.md` becomes a normalized document link.
- Event fan-out stores the extracted `documents` array in WorkItem `input`,
  `details`, and `TRIGGERED` event payloads; the internal `TriggerScheduler` uses
  the same `triggerDocumentsFromPayload(...)` helper for outbox-triggered work.
- `DirectLlmTaskExecutor.eventArtifactsForInstance(...)` later reads these event
  documents from `_workItem.input.documents`, `_workItem.details.documents`, and
  event payload document fields.
- `normalizeDocumentArtifact(...)` converts a URL-bearing document to prompt
  content like `Document link:\n<url>`; it does not fetch or pin the document.
- `documentPromptSection(...)` explicitly tells the model that if a document is
  only a link, it should state what can be verified from the link/reference and
  what requires fetching or access.

Impact:

- An event-driven verifier workflow can appear to validate submitted documents
  while the Direct LLM only saw URL strings, not the document body.
- There is no artifact id, content hash, final URL, fetch timestamp, media type,
  extraction status, or retention record proving what document version influenced
  a workflow run.
- If a later node or future enhancement fetches these URLs, the URLs were not
  pre-vetted by the same SSRF and source-ingestion controls used by board
  ingestion or outbound webhook guards.
- Operators cannot reliably replay, dispute, or audit event-document validation
  because the event route preserves a redacted projection and a URL reference,
  not a governed source artifact.

Required fixes:

- Route event-carried document URLs and inline document bodies through the same
  guarded source-ingestion pipeline used by board artifacts before WorkItem
  routing or Direct LLM validation.
- Persist `IngestedArtifact` or equivalent event-source artifact rows with final
  URL, content hash, extraction result, source event id, WorkItem id, and trace id.
- Fail closed or mark the WorkItem as blocked when required event documents
  cannot be fetched, are unsafe, exceed limits, or produce no extractable content.
- Pass artifact ids and extracted text/citations to Direct LLM and Governance Gate
  nodes instead of raw URL strings.
- Add tests for safe URL, private URL, credentialed URL, redirect-to-private URL,
  inline document, oversized document, unsupported media type, replay, and
  evidence-pack provenance.

### 165. IAM user onboarding does not atomically place users into a tenant

Evidence:

- `UserTenantMembership` is the table that makes a user an active member of a
  tenant, and local/OIDC login tokens include only tenant ids returned by
  `active_tenant_ids(...)`.
- IAM authorization now rejects checks when the requested user has no active
  `UserTenantMembership` for the requested tenant.
- `create_user(...)` creates only the `User` row with email, display name,
  `auth_provider`, `external_subject`, metadata, and tags. It does not accept a
  `tenant_id`, create a `UserTenantMembership`, or create team/capability
  placement in the same transaction.
- OIDC auto-provisioning creates or updates the `User` row and then immediately
  mints a token from `active_tenant_ids(...)`; it also does not create a tenant
  membership.
- The Identity console's user creation flow can apply team and role links after
  the user is created, but those relationship calls are not part of the same
  transaction. A relationship failure leaves a user row behind.
- `add_team_member(...)` creates a `TeamMembership`, not a
  `UserTenantMembership`, and `add_member(...)` creates a `CapabilityMembership`,
  not a tenant membership.
- Searches found tenant membership creation in the seed runner, but no ordinary
  IAM admin route that provisions or repairs a user's tenant membership.

Impact:

- A user can appear in IAM, be assigned to a team or capability, and still receive
  login tokens with an empty tenant list.
- WorkGraph/Context Fabric authorization checks for workflow launch, approval,
  routing, and capability-scoped actions can fail with "not an active member of
  this tenant" even though the operator sees team/capability assignments in the
  Identity UI.
- OIDC first login can create an active account with no usable tenant placement,
  which is a confusing enterprise onboarding failure mode.
- Because user creation and relationship linking are split across requests,
  partial failures can leave orphaned or half-configured principals that later
  break SDLC execution.

Required fixes:

- Add first-class tenant membership management APIs and UI, including default
  tenant selection during user creation and OIDC invite/provisioning.
- Make user onboarding transactional for the common path: create user, active
  tenant membership, initial teams, roles, and optional capability memberships.
- When assigning a user to a tenant-owned team or capability, validate or create
  the matching tenant membership according to policy; fail closed when the target
  tenant is ambiguous.
- Add an "onboarding health" indicator for users with no active tenant, no usable
  capability membership, or failed relationship links.
- Add tests for local user create, OIDC auto-provision, team assignment,
  capability assignment, role assignment, token tenant claims, and downstream
  `/authz/check` behavior.

### 166. Effective Access shows only platform permissions, not real workflow access

Evidence:

- `GET /authz/effective-access` verifies the caller's tenant membership, then
  returns only `sorted(await _get_platform_permissions(db, user_id, tenant_id))`.
- The endpoint does not call the full `check_authorization(...)` resolver, and it
  does not include direct capability memberships, team capability memberships,
  capability relationship inheritance, sharing grants, workflow resource grants,
  approval assignments, or runner/auditor permissions.
- `agent-and-tools/web/src/app/identity/effective-access/page.tsx` renders only a
  tenant id input and a flat list of `permissions`.
- The page text says workflow actions still evaluate capability/resource context
  at request time, but there is no capability/resource selector or explanation of
  which workflow/capability actions the signed-in user can actually perform.
- The separate Identity console `AuthzPanel` can call `/authz/check`, but it
  requires raw user id, capability id, action, tenant id, resource type, and
  resource id inputs instead of being a guided effective-access explorer.

Impact:

- Operators troubleshooting "why can't I launch/edit/approve this workflow?" see
  an incomplete access picture and may miss the actual source of allow/deny:
  capability membership, team membership, sharing, inheritance, resource grant,
  approval assignment, or missing tenant placement.
- The page can falsely look empty for users whose access is primarily
  capability/team-scoped, even though those users may have valid workflow
  permissions in specific capabilities.
- Support and audit teams still need to know internal ids and permission strings
  to debug real decisions, which undercuts the platform's enterprise access UX.

Required fixes:

- Expand `GET /authz/effective-access` to return grouped effective access:
  platform roles, tenant memberships, teams, capability memberships, inherited
  permissions, sharing grants, workflow grants, approval eligibility, and recent
  decision ids.
- Add filters for capability, workflow template, workflow instance, WorkItem, and
  action, using the same resolver as runtime `/authz/check`.
- Replace raw-id-only UI with dropdowns for tenant, capability, action, workflow,
  and user/team where the current actor has permission to inspect them.
- Show allow/deny reasons and policy version for every checked action, plus
  missing prerequisites such as tenant membership or inactive capability.
- Add contract tests proving the endpoint covers platform, direct capability,
  team, inherited, sharing, and resource-grant access instead of only platform
  role permissions.

### 167. Idea Board exports are client-only and not governed evidence artifacts

Evidence:

- `BoardCanvas.exportBoard(...)` creates JSON, SVG, and printable-PDF exports
  entirely in the browser from `baseShown`.
- JSON/SVG exports call `downloadText(...)`, which creates a browser `Blob`, a
  temporary object URL, and an `<a download>` click.
- Printable PDF opens a new `window`, writes an HTML document containing the SVG,
  and relies on browser print/save.
- The toolbar exposes `SVG export`, `PDF export`, and `JSON export` buttons
  directly from the board UI.
- The Studio board API exposes board creation, events, state, branches, ingest,
  artifacts, moments, diff, and merge, but no `/boards/:id/export` route.
- The export payload contains `boardId`, `exportedAt`, and objects, but does not
  include branch name, head event sequence, state hash, tenant id, actor id,
  export id, policy decision id, or evidence/artifact reference.
- Searches found no server route, audit event, artifact-store write, retention
  record, or permission check tied to Idea Board JSON/SVG/PDF export.

Impact:

- A board export can be shared as SDLC evidence without any platform record of who
  exported it, what permission authorized it, or which exact board event sequence
  it represents.
- Exported JSON can include free-form board object content, comments, embedded
  image data URLs, file names, votes, and promoted claim ids without redaction or
  a dedicated `synthesis:board:export` / sensitive-evidence permission.
- PDF/SVG exports are useful for workshops, but they are not reproducible from an
  immutable server-side snapshot unless the recipient also knows the branch/head
  state that produced them.
- Evidence packs and traceability views cannot cite a governed board export
  artifact because none is created.

Required fixes:

- Add server-side board export endpoints for JSON, SVG, and PDF that resolve the
  board, branch, and `atEventSeq`, materialize state, compute the state hash, and
  enforce an explicit export permission.
- Store export records/artifacts with actor, tenant, project, board id, branch,
  event sequence, state hash, format, redaction mode, byte hash, and trace id.
- Default normal users to redacted/metadata export and require stronger
  permissions for comments, embedded images, source links, and promoted claim
  metadata.
- Make the toolbar call the governed export route and show the resulting artifact
  id/link, not just a local browser download.
- Add tests for current-head export, historical snapshot export, redaction,
  permission denial, audit event creation, and evidence-pack inclusion.

### 168. Initiative capability reassignment is not governed after execution artifacts exist

Evidence:

- The Synthesis create flow now correctly attaches an initiative to one platform
  capability, and generated rows inherit that assigned capability.
- `updateProjectSchema` still accepts optional `primaryCapabilityId` on
  `PATCH /studio/projects/:projectId`.
- `updateProject(...)` writes the new `primaryCapabilityId` and
  `primaryCapabilityName`, deletes all existing `SpecificationProjectCapability`
  rows for the project, recreates the single primary link, upserts the new
  `CapabilityImpactAssessment`, and deletes impact assessments not matching the
  new capability.
- That update path does not inspect existing `WorkItem` rows attached through
  `projectId`, `GenerationPlan` / `GenerationPlanRow` rows,
  `WorkItemTarget.targetCapabilityId`, `DevelopmentScope.targetCapabilityId`,
  `WorkItemSpecificationBinding`, published handoffs, active workflow runs, or
  finalization records before changing the initiative owner capability.
- `GenerationPlanRow.targetCapabilityId`, `WorkItem.parentCapabilityId`,
  `WorkItemTarget.targetCapabilityId`, and `DevelopmentScope.targetCapabilityId`
  are stored independently from `SpecificationProject.primaryCapabilityId`.
- The generation-plan create/validate/apply paths reject rows that differ from
  the current project primary capability, but that check happens only when those
  routes are called. Existing applied rows and generated WorkItems are not
  rebased, blocked, or marked stale when the project capability changes later.
- The single-capability database trigger proves the project has exactly one
  matching primary capability link; it does not prove that all downstream
  execution artifacts still belong to that same capability.

Impact:

- An initiative can remain "single capability" at the project row level while its
  generated WorkItems, targets, scopes, handoffs, and budget evidence still point
  to the old capability.
- Capability dashboards, agent impact briefs, authorization decisions, and
  evidence packs can disagree about which capability owns the initiative and the
  resulting execution work.
- A later validation/apply can fail with target-capability mismatch while older
  generated rows remain applied, creating confusing partial execution history.
- Reassigning a capability can silently delete the old impact assessment context
  even though old generated work may still depend on it.
- Enterprise users need a governed ownership-transfer workflow, not a simple
  mutable field update, once work has been planned, approved, generated, or run.

Required fixes:

- Treat capability reassignment as a governed change request after an initiative
  has any generated plan, WorkItem, scope, handoff, approval, run, or finalization
  evidence.
- Before allowing reassignment, compute impact across generation plans, WorkItems,
  targets, scopes, bindings, handoffs, active runs, approvals, budget allocations,
  and evidence packs.
- Block reassignment by default when generated work exists, or require explicit
  approval plus a rebase/transfer plan that updates or supersedes downstream
  artifacts transactionally.
- Store an immutable `capabilityAssignmentVersion` or ownership-transfer record
  on the initiative and pin generated work to the version it was created under.
- Surface stale capability ownership in Synthesis and Operations readiness when
  project primary capability, generated rows, WorkItems, targets, or scopes no
  longer agree.
- Add tests for reassignment before any work exists, reassignment after draft
  generation plan, after applied rows, after active workflow run, after published
  handoff, after finalization, and with/without approved transfer plan.

### 169. Context optimization cost savings use hard-coded placeholder pricing

Evidence:

- `context_fabric_shared/costs.py` states that its prices are placeholders and
  should be replaced with an enterprise pricing table.
- The same module hard-codes default USD-per-million-token rates for `mock`,
  `ollama`, `openrouter`, and `openai_compatible`, plus two `gpt-4o-mini`
  overrides. Unknown providers fall back to `{"input": 1.0, "output": 3.0}`.
- `context_memory_service/app/context_compiler.py` calls
  `estimate_input_cost(provider, model, raw_tokens)` and
  `estimate_input_cost(provider, model, optimized_tokens)` to populate
  `estimated_raw_cost`, `estimated_optimized_cost`, and `estimated_cost_saved` in
  the context optimization result.
- `context_api_service/app/main.py` posts those three estimated values to
  `/metrics/token-savings`, where they become token-savings ledger data.
- `context_fabric_shared/schemas.py` exposes these fields as normal
  `OptimizationStats` values, not as explicitly unpriced or placeholder-priced.
- LLM Gateway has a stronger path:
  `provider_config.compute_estimated_cost(...)` returns `None` when the
  UI-managed model catalog lacks `inputPricePerMtok` and
  `outputPricePerMtok`, avoiding fake `$0.00` or guessed costs.
- The context optimization estimator does not use that LLM Gateway catalog,
  model alias snapshot, tenant pricing override, effective date, or
  `pricingStatus`.

Impact:

- Evidence packs, economics screens, and optimization reports can show apparent
  cost savings based on placeholder prices that do not match the active
  Copilot/OpenAI/Anthropic/OpenRouter contract.
- Tenant admins can configure model prices in `/llm-settings`, but Context Fabric
  token-savings math can still use a separate stale table.
- Unknown providers get a guessed positive price instead of `UNPRICED`, so
  operators may believe savings are financially meaningful when the platform has
  no authoritative price.
- Budget governance can mix real LLM Gateway call costs with placeholder Context
  Fabric optimization costs, making run-level and initiative-level economics hard
  to audit.

Required fixes:

- Replace `context_fabric_shared.costs` placeholder lookup with the same
  tenant/model-alias pricing catalog used by LLM Gateway, or expose a shared
  pricing service with versioned price snapshots.
- Return `pricingStatus = UNPRICED` and null cost fields when no authoritative
  price exists; do not guess a provider default.
- Persist pricing source, alias, provider, model, input/output rates, effective
  date, and catalog/version digest with every optimization ledger row.
- Update UI/evidence copy to distinguish token savings from verified USD savings.
- Add tests for configured catalog price, missing price, unknown provider,
  tenant override, price version change, and mixed real/unpriced optimization
  ledger rollups.

### 170. Context optimization token-savings ledger writes fail silently

Evidence:

- `context_api_service/app/main.py` posts each optimized chat response to
  `/metrics/token-savings` with session id, agent id, context package id,
  model call id, token counts, estimated costs, provider, model, and latency.
- The write is wrapped in `try/except Exception`; on any failure the code sets
  `metrics_run_id = None` and continues.
- The exception handler does not log the failure, emit an audit event, enqueue a
  retry/outbox item, attach a warning to the response, or mark the context package
  as missing ledger materialization.
- `ChatRespondResponse` includes `metrics_run_id`, so callers can technically see
  null, but the response does not include a reason or a `metricsStatus` field.
- `metrics_ledger_service/DEPRECATED.md` says token-savings writes should now be
  emitted as audit events and populated by a cost worker, but this chat path still
  directly posts to a metrics URL and suppresses any delivery failure.

Impact:

- Context optimization can appear to work while token-savings economics disappear
  from the ledger.
- Evidence packs and economics screens can under-report context usage or savings
  without showing operators that ledger delivery failed.
- If the metrics ledger or audit-cost worker is unavailable during a run, there is
  no durable replay source to backfill the missing row.
- Support teams have no traceable error, retry count, or dead-letter queue for
  failed optimization metrics.

Required fixes:

- Replace the direct best-effort POST with a durable outbox/audit event path, or
  at minimum log failures with trace id, session id, context package id, and model
  call id.
- Add `metricsStatus`, `metricsErrorCode`, and `metricsRetryable` to the response
  or context package metadata when ledger materialization fails.
- Add a retry worker/dead-letter table for failed optimization metrics, with an
  operator replay action.
- Make evidence/economics screens distinguish `NO_METRICS`, `PENDING_METRICS`,
  `FAILED_METRICS`, and `RECORDED`.
- Add tests for metrics ledger unavailable, malformed response, retry success,
  dead-letter exhaustion, and UI/evidence warnings when `metrics_run_id` is null.

### 171. Context Fabric MCP event evidence can disappear without a run-visible error

Evidence:

- `context_api_service/app/execute_modules/event_collector.py` documents both
  MCP event collection paths as best-effort and says any failure can leave
  `events_store` empty for that trace without surfacing an error to the caller.
- `drain_mcp_events(...)` catches every exception from the MCP `/mcp/events`
  drain and returns `0`, making "no events existed", "MCP was unreachable",
  "MCP returned malformed JSON", and "the store failed" indistinguishable.
- `live_subscribe(...)` catches subscriber failures and simply returns the count
  persisted so far; the caller sees no reason code for WebSocket auth, network,
  protocol, or store failures.
- `events_store.upsert_many(...)` catches every per-event insert exception and
  silently skips the event with a comment that it is most likely a duplicate id.
  A malformed event, schema mismatch, missing primary key, database write error,
  or true duplicate all collapse into the same skipped-write behavior.
- The main `/execute` response records only
  `metrics.eventsPersistedLive` and `metrics.eventsPersistedFinalDrain`; it does
  not include collection status, missing-event warnings, drain errors, duplicate
  counts, malformed-event counts, or store failure counts.
- `/execute/events`, `/execute/events/stream`, and `/receipts` read whatever is
  present in `events_store`; the receipt response does not warn when a CallLog
  exists for a trace but no MCP LLM/tool/artifact/approval events were captured.
- The refresh endpoint `/execute/calls/{call_id}/refresh-events` re-drains and
  returns counts, but if the MCP ring has rotated or the drain still fails, there
  is no durable failure record explaining why the timeline remains incomplete.

Impact:

- A successful workflow run can have missing model-call, tool-call, artifact, or
  approval evidence even though receipts and run timelines look merely quiet.
- Operators cannot tell the difference between an agent that did nothing and a
  broken event collection path.
- Evidence packs can be incomplete after MCP restart, ring rotation, network
  hiccups, schema drift, or database write failure, with no audit-grade missing
  source warning.
- Replay/refresh can give a false sense of recovery because it reports counts
  rather than collection health, loss windows, or terminal dead-letter state.
- Enterprise audit cannot prove negative facts such as "no tools were invoked"
  when the event collector itself is allowed to fail silently.

Required fixes:

- Return structured collection status from live subscription and final drain:
  `OK`, `PARTIAL`, `FAILED`, `NOT_SUPPORTED`, `RING_EXPIRED`, and `STORE_FAILED`.
- Make `events_store.upsert_many(...)` distinguish inserted, duplicate,
  malformed, rejected, and failed rows; log/store failed rows with reason and
  trace id.
- Persist an event-collection summary on the CallLog row or a companion table with
  attempted paths, counts, errors, timestamps, MCP ring cursor/window, and retry
  state.
- Make `/execute`, `/execute/events`, `/receipts`, run cockpit, and evidence pack
  surfaces show missing-source warnings when a CallLog exists but expected MCP
  event evidence is absent or partially collected.
- Add an operator-visible retry/dead-letter workflow that records why backfill
  could not recover events.
- Add tests for MCP events endpoint unavailable, malformed MCP event payload,
  duplicate id, missing id, database insert failure, ring rotation after refresh,
  and receipts warning when event evidence is incomplete.

### 172. Workflow Operations event status filters run after page truncation

Evidence:

- `workflow-operations.router.ts` handles `GET /api/workflow-operations/events`
  by reading `limit = min(200, max(1, query.limit ?? 75))`.
- The same route queries `eventLog.findMany(...)` with only event type and tenant
  filters, orders by `occurredAt desc`, and applies `take: limit` before any
  requested lifecycle status is considered.
- Each row is then serialized by `serializeInboundEvent(...)`, which derives
  status dynamically from payload fields, trigger results, WorkItem routing state,
  and linked workflow-instance state.
- Only after serialization does the endpoint apply
  `items.filter(item => item.status === status)`.
- Because status is derived after the first page is truncated, a request such as
  `?status=failed` or `?status=dead_lettered` searches only the latest N inbound
  events, not all matching failed/dead-lettered events.
- The operations contract tests cover tenant checks, redaction, replay trace,
  requeue token rotation, and dispatcher failure aggregation, but do not assert
  that status-filtered event lists are complete or cursor-stable.

Impact:

- Operators can open the Replay Center with a `failed`, `dead-lettered`, or
  `unmatched` filter and see an empty table while older matching events still
  exist.
- Recovery work becomes dependent on arbitrary page size and event arrival order
  instead of actual lifecycle status.
- Readiness counts and event tables can disagree, undermining trust in the
  operations center during incident response.
- Cursor pagination cannot be made correct while the filter is applied after
  status derivation and page truncation.
- Large tenants with many inbound events are most likely to lose visibility into
  the exact dead-letter rows they need to replay.

Required fixes:

- Persist normalized operation lifecycle status on ingestion/replay records, or
  store a dedicated `workflow_event_operations` projection with status,
  capability id, trigger ids, WorkItem ids, workflow instance ids, trace id,
  retry count, and last error as indexed columns.
- Apply `status`, `capabilityId`, `eventType`, `traceId`, and cursor filters in
  the database before limiting results.
- Keep derived status as a reconciliation check, not the only query source; update
  the persisted projection transactionally when WorkItems route, runs start,
  complete, fail, or are replayed.
- Return pagination metadata that distinguishes `totalMatching`,
  `returnedCount`, `nextCursor`, and `statusProjectionFreshness`.
- Add tests with more than one page of inbound events proving `status=failed`,
  `status=dead_lettered`, and `status=completed` return matching older rows and
  remain stable across new event arrivals.

### 173. Idea Board branch merge mutates the target before review is complete

Evidence:

- `board-merge.ts` describes merge as a three-way semantic diff where material
  changes become a reviewable proposal batch, but it classifies position, style,
  and cluster membership as `SPATIAL`.
- `board-merge.service.ts` implements `mergeBranch(...)` by splitting diff items
  into `spatial` and `material`.
- The same function calls `applyItems(...)` for every `spatial` item before
  returning the material review batch.
- `applyItems(...)` calls `appendEvent(...)` against the target branch with
  `OBJECT_MOVED` or `OBJECT_EDITED`, so the merge-preview action can immediately
  write new durable events to `main`.
- The router exposes this as `POST /boards/:boardId/merge`; there is no
  `BoardMergeProposal`, merge session, accepted-item ledger, reviewer decision,
  or dry-run-only proposal record in Prisma.
- `applyMergeItems(...)` later applies selected material items, but the earlier
  spatial changes have already landed and cannot be reviewed, rejected, or rolled
  back as one governed merge unit.
- Searches found no tests covering rejected merges, partial merge rollback,
  reviewer identity for the auto-applied spatial subset, or branch merge proposal
  immutability.

Impact:

- A user can click a merge/review action expecting a proposal, but the target
  board can already be changed before the proposal is accepted.
- In a Miro-like board, spatial layout is not always cosmetic: proximity, frames,
  clusters, and ordering can encode priority, dependency, ownership, or causal
  relationships.
- If the material batch is rejected or abandoned, `main` may still contain layout
  and style changes from the rejected branch, creating a mixed state that no
  reviewer approved.
- Audit evidence records `BoardBranchMerged` and low-level object events, but does
  not preserve one immutable merge decision showing what changed, who reviewed it,
  what was auto-applied, and what was rejected.
- Branch merge is not replayable as a single governed transaction, which weakens
  time-travel debugging and concept-evidence traceability.

Required fixes:

- Make `mergeBranch(...)` a pure proposal creation endpoint by default. It should
  compute spatial/material/conflict items and store a `BoardMergeProposal` with
  base, source head, target head, state hashes, diff items, actor, tenant, and
  trace id.
- Require an explicit accept/apply action for spatial changes too, or at minimum
  show them as auto-eligible items that are still part of the reviewer decision.
- Apply accepted merge items in one fenced transaction against the expected target
  head and store the resulting event ids on the merge proposal.
- Add reject/abandon/rollback semantics for unaccepted proposals without mutating
  `main`.
- Treat frames, clusters, ordering, and style as configurable semantic dimensions
  instead of globally auto-merging every non-content change.
- Add tests for preview-no-mutation, accept-all, accept-subset, reject, stale
  target head, conflict, spatial-as-semantic, and evidence replay.

### 174. Workflow metadata definitions are tenantless mutable control-plane records

Evidence:

- `app.ts` mounts `/api/metadata-definitions` with `authMiddleware` only.
- `metadata.router.ts` exposes `GET /`, `POST /`, and `PATCH /:id` without
  `requireAdmin`, typed workflow authorization, tenant checks, or resource
  grants.
- `POST /api/metadata-definitions` defaults new rows to `status: ACTIVE` and
  accepts arbitrary JSON records for `schema`, `defaults`, `policy`, `ui`, and
  `compatibility`.
- `PATCH /api/metadata-definitions/:id` can mutate `status`, `schema`,
  `defaults`, `policy`, `ui`, and `compatibility` on an existing row in place.
- `MetadataDefinition` has no `tenantId`, owner, created-by, updated-by,
  approved-by, published-at, digest, or immutable-version fields. Its uniqueness
  constraint is only `(kind, key, version, scopeType, scopeId)`.
- `resolveMetadataDefinition(...)` resolves active definitions by caller-supplied
  node, workflow, capability, and global scope ids, then falls back to the newest
  global active row. It does not filter by tenant.
- Platform Web's metadata registry is currently read-only, but the routing-policy
  console can create new active metadata-backed work-item and workflow types
  through the same API.

Impact:

- Any authenticated WorkGraph caller can create or alter global
  `WORK_ITEM_TYPE`, `WORKFLOW_TYPE`, `NODE_TYPE`, `EVENT_TYPE`, or
  `TRIGGER_PROFILE` records that affect future authoring, routing, validation,
  and UI behavior.
- A tenant or team can unintentionally change the metadata catalog used by another
  tenant because the table has no tenant boundary and global definitions are the
  normal fallback.
- Active metadata can change without a publish/review event, immutable digest, or
  snapshot approval, so operators cannot prove which control-plane taxonomy was
  approved at a given time.
- Routing policies, launch forms, node inspectors, and trigger profiles can drift
  from the catalog used when earlier workflows were designed.
- This undercuts enterprise workflow stability because the data that defines
  "types" behaves like mutable user-entered content instead of governed platform
  configuration.

Required fixes:

- Add tenant ownership, created/updated actor fields, approval metadata, and a
  content digest to metadata definitions.
- Require explicit permissions such as `workflow:metadata:view`,
  `workflow:metadata:create`, `workflow:metadata:publish`, and
  `workflow:metadata:edit` before list/create/update operations.
- Split draft edits from published active versions. Published versions should be
  immutable, and runtime/design snapshots should record the version id and digest.
- Validate `schema`, `defaults`, `policy`, `ui`, and `compatibility` by metadata
  kind using server-side JSON Schema, not only "object root" checks.
- Make global/platform definitions read-only to tenants unless an elevated
  platform-admin grant is present; tenant/capability overrides should be scoped
  and auditable.
- Add tests proving normal authenticated users cannot mutate global metadata,
  tenant A cannot see or alter tenant B metadata, published definitions cannot be
  edited in place, and workflow/routing snapshots preserve the approved digest.

### 175. Custom workflow node types are global mutable executor wrappers

Evidence:

- `app.ts` mounts `/api/custom-node-types` with `authMiddleware` only.
- `custom-node-types.router.ts` exposes list, create, get, patch, and delete
  routes without admin checks, workflow permissions, tenant checks, or resource
  grants.
- The create schema allows a custom type to wrap sensitive built-in executor
  bases including `DIRECT_LLM_TASK`, `AGENT_TASK`, `TOOL_REQUEST`,
  `CREATE_BRANCH`, `GIT_PUSH`, `RAISE_PR`, `POLICY_CHECK`, `EVAL_GATE`,
  `VERIFIER`, `GOVERNANCE_GATE`, `CALL_WORKFLOW`, and `FOREACH`.
- `CustomNodeType` has no `tenantId`, owning capability, owner team,
  approval state, published version, immutable digest, or archived-by metadata.
  The `name` field is globally unique.
- `WorkflowStudioPage` loads `/custom-node-types` and shows active custom types in
  the normal workflow node palette.
- `CustomNodeTypesPage` can create, patch, and delete records through the same
  endpoints, and it fetches `active=false`, which returns active and inactive
  custom types.
- The custom type `fields` payload is only an array of labels/placeholders; it is
  not a server-validated per-executor config schema.

Impact:

- Any authenticated caller can add a globally visible custom node type that looks
  like an approved platform extension and appears in other authors' palettes.
- A custom type can disguise a high-impact base executor behind a benign label or
  color while still relying on the wrapped runtime behavior.
- Deleting or patching a global custom type can break existing workflow designs
  that reference its id, because there is no published-version pin or immutable
  design snapshot for the type definition.
- Multi-tenant and regulated deployments cannot restrict custom extensions to one
  tenant, capability, or workflow domain.
- The node type registry is not an enterprise extension marketplace yet; it is a
  mutable shared table that can change authoring and runtime semantics without a
  governed review.

Required fixes:

- Add tenant ownership, owning capability/team, created/updated actor, approval
  state, version, published digest, and archived metadata to custom node types.
- Require explicit permissions such as `workflow:custom_node:view`,
  `workflow:custom_node:create`, `workflow:custom_node:publish`, and
  `workflow:custom_node:delete`.
- Make published custom type versions immutable and pin workflow design nodes to a
  version id/digest, not only the mutable custom type id.
- Restrict which base executor types a tenant can wrap, and require elevated
  review for side-effecting bases such as Git, PR, Tool Request, Direct LLM, and
  Governance Gate.
- Replace free-form field labels with a validated config schema per custom type,
  plus compatibility checks against the selected base executor.
- Add tests proving normal users cannot create global custom nodes, tenant A
  cannot see tenant B custom nodes, published custom nodes cannot be edited in
  place, and deleting a draft does not break published workflow snapshots.

### 176. Connector CRUD and direct invocation are authenticated-only side-effect APIs

Evidence:

- `app.ts` mounts `/api/connectors` with `authMiddleware` only.
- `connectors.router.ts` exposes connector list, archived list, get,
  operations, create, patch, test, invoke, archive, restore, and delete routes
  without tenant filters, workflow/capability permissions, connector grants, or
  operation-level authorization.
- `Connector` has no `tenantId`, owning capability, owning team, repository
  binding, secret reference, approved operation policy, or environment boundary.
- `POST /api/connectors` accepts arbitrary `config` and `credentials` JSON for
  connector types including `HTTP`, `EMAIL`, `TEAMS`, `SLACK`, `JIRA`, `GIT`,
  `CONFLUENCE`, `DATADOG`, `SERVICENOW`, `LLM_GATEWAY`, `S3`, `POSTGRES`, and
  `SHAREPOINT`.
- `PATCH /api/connectors/:id` merges new `credentials` into the stored credential
  JSON and returns the redacted connector, but does not perform a permission or
  approval check.
- `POST /api/connectors/:id/test` builds the adapter with stored credentials and
  runs `testConnection()`.
- `POST /api/connectors/:id/invoke` accepts a caller-provided `operation` and
  `params`, builds the adapter with stored credentials, and executes the adapter
  operation directly.
- Adapter operations include side effects such as sending email, posting Slack or
  Teams messages, creating Jira/ServiceNow/Confluence records, creating Git
  branches/issues/PR comments, creating/deleting S3 or SharePoint objects, and
  executing Postgres queries through `$queryRawUnsafe`.
- The Prisma schema comment says connector credentials are "Encrypted at rest",
  but the connector module stores them as a JSON field and searches found no
  connector-specific encrypt/decrypt wrapper before persistence or adapter use.

Impact:

- Any authenticated WorkGraph user can create or alter shared outbound
  integrations and then invoke them outside a workflow run, approval request,
  authorization snapshot, trace spine, governance gate, or runtime policy.
- The existing Git-specific gap is only one symptom; the same direct side-effect
  surface exists for ticketing, messaging, observability, storage, database, HTTP,
  SharePoint, Confluence, and LLM Gateway connectors.
- A tenant or team can accidentally or maliciously use another tenant's connector
  because connector rows have no tenant/resource boundary.
- Redacting `credentials` from responses is useful, but it does not prove secret
  custody if raw credential JSON is still stored in the primary WorkGraph
  database and mutable by broad callers.
- Connector invocation evidence is weaker than workflow execution evidence
  because direct invocations are not tied to a WorkItem, workflow instance,
  approval decision, governed tool grant, or trace id.

Required fixes:

- Add tenant ownership, connector owner, capability/repository scope, created and
  updated actor fields, secret reference ids, operation allowlists, and approval
  metadata to connectors.
- Replace raw credential JSON storage with references to a secret broker or
  encrypted envelope model with key ids, rotation state, and audit metadata.
- Require explicit permissions such as `connector:view`, `connector:create`,
  `connector:edit`, `connector:test`, `connector:invoke`, and
  `connector:delete`, plus operation-level grants for side-effecting operations.
- Route connector invocation through governed workflow/tool execution when it has
  side effects, or require an explicit break-glass/debug permission for direct
  invocation.
- Persist direct test/invoke audit events with tenant, actor, connector id,
  operation, params redaction hash, trace id, result summary, and approval or
  break-glass reason.
- Add tests proving tenant isolation, permission checks, secret redaction,
  immutable audit for test/invoke, and blocked direct invocation for high-risk
  connector operations.

### 177. Document reads issue presigned evidence URLs with only tenant checks

Evidence:

- `app.ts` mounts `/api/documents` with `authMiddleware` only.
- `documents.router.ts` implements `GET /api/documents` by requiring a tenant in
  strict mode, optionally checking the `instanceId` tenant, and returning matching
  `Document` rows by `taskId`, `nodeId`, or `instanceId`.
- The list route does not check `workflow:view`, `work_item:view`,
  `task:view`, `artifact:view`, `document:view`, assignment eligibility, owning
  capability membership, or sensitive-evidence permission.
- `GET /api/documents/:id` calls `assertDocumentTenant(...)`, then returns
  document metadata and a one-hour MinIO presigned URL for uploaded documents.
- `assertDocumentTenant(...)` only proves that strict-mode tenant context matches
  the linked workflow instance. It does not check whether the caller may view that
  workflow instance, task, node, WorkItem, or document.
- In non-strict tenant mode, `assertDocumentTenant(...)` returns without checking
  anything, so the direct document read path is effectively authenticated-only.
- `Document` rows can be attached to `taskId`, `nodeId`, `instanceId`, or stand
  alone with `tenantId`; the read route has no separate policy for standalone or
  task-only documents.

Impact:

- A tenant user who can guess or discover a document id can receive a presigned
  object-store URL for uploaded evidence even if they cannot view the underlying
  run, task, WorkItem, approval, or capability.
- Listing by `instanceId`, `taskId`, or `nodeId` can disclose filenames, MIME
  types, sizes, providers, and external document URLs for resources the caller is
  not assigned to.
- Direct document reads bypass the stricter sensitive-evidence posture described
  for Copilot exports, prompt context, Direct LLM receipts, and governance
  evidence.
- Evidence-pack and document-retention semantics become inconsistent: the run
  cockpit may hide or redact content while `/api/documents/:id` can still mint a
  raw download URL.

Required fixes:

- Add a document authorization helper that resolves document ownership through
  task, node, workflow instance, WorkItem, capability, approval, and tenant.
- Require explicit actions such as `document:view`, `document:download`,
  `document:attach`, and `document:delete`, with a stronger
  `workflow:sensitive_evidence:view` or equivalent for raw content.
- Filter document list routes by effective access, not only tenant and optional
  foreign keys.
- For presigned downloads, include actor, tenant, document id, source resource,
  permission decision id, trace id, expiry, and redaction mode in audit events.
- In strict mode, reject standalone documents without tenant/resource ownership;
  in development mode, label the relaxed behavior clearly.
- Add IDOR tests for document list/get/download across tenants, workflows, tasks,
  assignments, capabilities, standalone documents, and revoked users.

### 178. Deliverable template and consumable type catalogs are not governed contracts

Evidence:

- `app.ts` mounts `/api/artifact-templates` and `/api/consumable-types` with
  `authMiddleware` only.
- `artifact-templates.router.ts` exposes list, create, get, patch, publish,
  archive, duplicate, and delete routes without tenant checks, capability/team
  ownership checks, template permissions, or approval requirements.
- `ArtifactTemplate` has no `tenantId`, owning capability, owner team id,
  published-at, approved-by, content digest, immutable version row, or grant
  model. It stores `sections`, `parties`, and `metadata` as mutable JSON on the
  same row.
- `POST /api/artifact-templates/:id/publish` only flips `status` to
  `PUBLISHED`; it does not validate section/party schemas beyond the create/update
  shape, lock the content, record an approval decision, or create a version
  snapshot.
- `PATCH /api/artifact-templates/:id` can edit sections, parties, metadata, type,
  and team name in place even after publication.
- `DELETE /api/artifact-templates/:id` physically deletes the template row rather
  than archiving or preserving historical evidence.
- `consumable-types.router.ts` allows any authenticated caller to create a
  `ConsumableType` with arbitrary `schemaDef`, `ownerRoleId`, approval, and
  versioning settings. It exposes list/get for all types and has no tenant,
  owner, or permission checks.
- `ConsumableType` has a globally unique `name`, no tenant/capability boundary,
  no status, no immutable schema-version model, and no approval metadata.

Impact:

- Deliverable contracts, approval briefs, handoff templates, and consumable JSON
  schemas can change globally without a governed review or immutable version.
- A published artifact template can be edited after runs have used it, making it
  hard to prove what contract was approved when a document or evidence pack was
  generated.
- Deleting a template can orphan historical references or make old runs harder to
  explain.
- Consumable type schemas can drift after versions exist; validators may validate
  new payloads against a changed schema while old evidence has no pinned schema
  digest.
- Multi-tenant teams cannot keep separate deliverable taxonomies because names and
  templates are effectively global.

Required fixes:

- Add tenant ownership, capability/team scope, created/updated actor fields,
  approval metadata, content digests, and immutable published-version tables for
  artifact templates and consumable types.
- Require explicit permissions such as `artifact_template:view`,
  `artifact_template:create`, `artifact_template:publish`,
  `artifact_template:edit`, `consumable_type:view`, and
  `consumable_type:create`.
- Make published versions immutable. Edits should create a draft version and
  require review before activation.
- Store the template/type version id and digest on generated consumables,
  documents, approvals, and evidence packs.
- Replace physical deletes with archival plus impact checks when any run,
  consumable, or workflow references the template/type.
- Add tests for tenant isolation, published immutability, schema digest pinning,
  delete/archive behavior, and old-run replay using the original template/type
  version.

### 179. Governance policy authoring is authenticated-only despite controlling gates

Evidence:

- `app.ts` mounts `/api/governance/policies` with `authMiddleware` only.
- `governance-policy.router.ts` exposes list, coverage, create, get, patch,
  activate, and preview/evaluate routes without typed workflow authorization,
  governance-admin permission checks, capability owner checks, tenant membership
  checks, or approval requirements.
- `createGovernancePolicy(...)` stores caller-supplied `capabilityId`,
  `workflowId`, `workItemTypeKey`, `mode`, and rules as version 1 for the current
  DB tenant/default tenant.
- `updateGovernancePolicy(...)` creates a new version but can also change scope,
  mode, and rules; if an active policy is edited it moves the policy back to
  `DRAFT`, but there is no review state or approval request.
- `activateGovernancePolicy(...)` only sets `status: ACTIVE` and stamps
  `activatedAt` on the current version. It does not validate that the actor can
  govern the scoped capability/workflow or that a second approver accepted the
  policy.
- `evaluateGovernancePolicy(...)` persists the caller-supplied `evidence` JSON in
  `GovernancePolicyEvaluation` and returns the policy/version/result to the
  caller. The preview route accepts arbitrary evidence and optional instance,
  node, or WorkItem ids without checking resource access.
- `GovernancePolicy` and `GovernancePolicyVersion` have tenant fields, but no
  owner team, governing capability, reviewer, approval status, content digest, or
  immutable activation decision id.

Impact:

- Any authenticated WorkGraph user can create or activate blocking/advisory
  governance policy that affects future Governance Gate evaluations for a
  capability, workflow, WorkItem type, or global tenant scope.
- A user can preview a policy against evidence for a run or WorkItem they may not
  be allowed to inspect, then create persisted evaluation rows containing that
  evidence.
- Governance policies can become a mutable operational control rather than a
  reviewed compliance artifact.
- There is no strong proof that a blocking rule was authored by the owning
  capability, approved by governance, or active under an immutable digest at run
  time.
- Policy activation can silently change enterprise launch/runtime behavior for
  other teams.

Required fixes:

- Require explicit permissions such as `governance_policy:view`,
  `governance_policy:create`, `governance_policy:edit`,
  `governance_policy:activate`, and `governance_policy:evaluate`.
- Verify capability/workflow scope ownership before create/update/activate and
  filter list/coverage by effective access.
- Add review/approval workflow for `REQUIRED` and `BLOCKING` policies, with
  separation-of-duty and self-approval prevention.
- Store immutable policy version digests and activation decision ids; runtime
  evaluations should record the exact version/digest.
- Treat preview evidence as sensitive and require access to the referenced
  instance/node/WorkItem before evaluating or persisting it.
- Add tests for cross-tenant policy visibility, unauthorized blocking-policy
  activation, scope ownership, policy preview IDOR, immutable activation digest,
  and policy edit-after-activation behavior.

### 180. Runtime policy management lets users weaken their own runtime guardrails

Evidence:

- `app.ts` mounts `/api/runtime-policy` with `authMiddleware` only.
- `runtime-policy.router.ts` exposes `GET/POST/PATCH /policies` without admin,
  tenant-operator, runtime-security, or capability permission checks.
- `createRuntimePolicy(...)` accepts `allowedPaths`, `consentMode`,
  `autoUpdate`, and `killSwitch` from the caller. `consentMode` may be
  `ALWAYS_ALLOW`.
- `updateRuntimePolicy(...)` lets a caller patch `allowedPaths`, `consentMode`,
  `autoUpdate`, and `killSwitch` on any policy id in the current/default tenant.
- `enrollRuntimeDevice(...)` lets the current user attach their runtime to any
  enabled policy id in the tenant, without checking whether that policy is
  assigned to them or their team.
- `RuntimeDevice.runtimeId` is globally unique in the database, not unique by
  tenant and user, while enrollment upserts by `runtimeId` and rewrites `tenantId`
  and `userId`.
- `checkRuntimeAction(...)` uses the attached policy and user-owned consent rows,
  but it does not perform live IAM authorization for the workflow/capability/tool
  action being requested.
- `RuntimePolicy` has no owner, assigned users/teams, approval metadata,
  published version, digest, or scope beyond tenant.

Impact:

- A user can create a permissive runtime policy, attach their runtime to it, and
  set `ALWAYS_ALLOW` or broad `allowedPaths`, weakening the laptop/runtime guard
  that should protect tool and code execution.
- A user can flip `killSwitch` or policy path limits on shared policies without a
  runtime-security approval.
- Runtime ids can collide across tenants or be reused to move a device row between
  users because the upsert key is only `runtimeId`.
- Runtime consent becomes a local user setting instead of an enterprise-managed
  device policy tied to IAM membership, device trust, capability tags, and run
  authorization snapshots.
- Context Fabric and MCP may rely on runtime policy evidence that was authored or
  weakened by the same user whose runtime is being governed.

Required fixes:

- Require runtime-administration permissions for policy create/update/list, and
  separate user permissions for device enroll/revoke/consent.
- Model policy assignment to users, teams, tenants, runtime types, and capability
  tags; users should only enroll into policies assigned to them.
- Make runtime ids tenant/user scoped or enforce issuer-bound unique device ids
  from IAM-minted runtime tokens.
- Version and publish runtime policies with immutable digests, approval metadata,
  and audit events for every activation/change.
- During `checkRuntimeAction`, combine device policy with live IAM authorization
  and run authorization snapshot checks for the requested workflow/capability/tool
  action.
- Add tests for self-created permissive policy denial, unauthorized policy patch,
  runtime id collision, policy assignment, consent expiry, kill-switch behavior,
  and live revocation after IAM permission loss.

### 181. Event subscription registry bypasses Workflow Operations authorization

Evidence:

- `app.ts` mounts `/api/events/subscriptions` with only `authMiddleware` before
  entering `eventSubscriptionsRouter`.
- `event-subscriptions.router.ts` mutating routes call `requireAdmin(req)`, but
  that helper only calls the local WorkGraph `isAdminUser(...)` helper.
- `isAdminUser(...)` checks local role permissions for
  `PLATFORM_ADMIN_PERMISSION`; it does not call IAM `authz/check`, does not pass
  `tenant_id`, and does not distinguish subscription create/update/delete from
  workflow operations permissions such as `workflow:operations:retry_delivery`
  or `workflow:audit:view`.
- Subscription read routes do not call `requireAdmin(...)` or
  `assertWorkflowOperationsPermission(...)`:
  `GET /api/events/subscriptions`, `GET /api/events/subscriptions/:id`, and
  `GET /api/events/subscriptions/:id/deliveries` are available to any
  authenticated caller in the tenant.
- `GET /:id/deliveries` returns delivery rows with response status, last error,
  timestamps, and selected outbox subject/trace metadata. Subscription reads
  also reveal target URLs, event patterns, subscriber ids, and metadata through
  `publicSubscription(...)`.
- Workflow Operations has a stronger permission model in
  `workflow-operations.router.ts`, including explicit checks for `view`,
  `replay`, `retry_delivery`, `manage_runners`, and `audit_view`, plus payload
  redaction. The subscription registry does not reuse those checks.

Impact:

- A tenant user who cannot operate workflow events can still enumerate outbound
  subscribers and delivery failures through the lower-level registry API.
- Event subscription configuration depends on local admin state rather than the
  tenant-scoped IAM permission model selected for enterprise workflow
  operations.
- Outbound event delivery topology is sensitive operational data: target URLs,
  subscriber names, event patterns, and failure messages can disclose systems,
  routing strategy, and incident state.
- The platform has two different authorization stories for the same event-bus
  surface: the operator console is governed; the subscription registry is only
  locally admin/authenticated.

Required fixes:

- Replace `requireAdmin(...)` with explicit IAM-backed permissions such as
  `workflow:events:subscriptions:view`,
  `workflow:events:subscriptions:manage`, and
  `workflow:events:deliveries:view`.
- Reuse the Workflow Operations sensitive-data redaction path for subscription
  and delivery reads; hide target URLs, metadata, and failure details unless the
  caller has audit/operations authority.
- Make service-token and local-admin bypasses explicit development-only
  compatibility paths, not the normal production authorization path.
- Add tenant/capability-scoped audit events for subscription create, update,
  disable, delete, and secret rotation.
- Add IDOR tests proving non-operator users cannot list subscriptions, inspect
  deliveries, or mutate subscriber targets, and proving IAM-denied production
  requests fail closed even when the local WorkGraph role has admin-shaped data.

### 182. Capacity planning can be rewritten by any authenticated tenant user

Evidence:

- `app.ts` mounts `/api/planning/capacity` with only `authMiddleware`.
- `capacity.router.ts` exposes:
  `GET /calendars`, `PUT /calendars`, `GET /allocations`,
  `POST /allocations`, and `POST /forecast`.
- `capacity.service.ts` scopes reads/writes by tenant, but does not authorize by
  user, team, capability, calendar owner, workflow, WorkItem, or planning role.
- `PUT /calendars` upserts calendars for arbitrary `ownerType` values
  `USER`, `TEAM`, or `CAPABILITY` and arbitrary `ownerId` values supplied by the
  caller.
- `POST /allocations` creates allocations against any tenant calendar id and
  accepts caller-supplied `workItemId`, `programStepId`, `capabilityId`,
  `skillKey`, schedule window, and estimated hours.
- Generation planning consumes these records: `contract-bound.router.ts` looks
  up capability calendars for generation rows, validates schedule availability
  with `loadScheduleCapacity(...)`, and `ensurePlanRowAllocation(...)` writes or
  updates `CapacityAllocation` rows when generation plans are applied.
- `forecastCapacity(...)` persists forecast scenarios and results, but there is
  no permission or provenance boundary separating exploratory forecasts from
  authoritative capacity calendars and allocations.

Impact:

- Any authenticated tenant user can alter a team's, user's, or capability's
  working hours, holidays, and WIP limit, then influence generated delivery
  schedules and critical-path projections.
- A caller can create allocations for unrelated WorkItems or capabilities,
  poisoning capacity forecasts or crowding legitimate generated work.
- Capacity data becomes a mutable planning input without owner approval,
  versioning, effective dates, or immutable decision evidence.
- Enterprise roadmap and delivery commitments can drift because the scheduler
  reads live mutable capacity state rather than an approved planning snapshot.

Required fixes:

- Add IAM-backed permissions for capacity read, calendar manage, allocation
  manage, and forecast create, scoped by owner type and owner id.
- Verify `USER` calendars can only be changed by the user or an authorized
  capacity administrator; `TEAM` and `CAPABILITY` calendars should require team
  lead/capability owner or planning-admin authority.
- Validate allocation targets: `workItemId`, `programStepId`, and
  `capabilityId` must belong to the same tenant and authorized planning scope.
- Add capacity calendar/version snapshots to generation plans so schedule
  validation and later evidence can prove which capacity state was used.
- Make direct capacity edits audit-producing commands with effective dates,
  approver metadata for enterprise mode, and rollback/supersede semantics.
- Add tests for unauthorized calendar upsert, cross-owner allocation injection,
  stale capacity snapshot detection, and schedule changes after capacity
  mutation.

### 183. Work Programs can author and launch cross-capability fan-out without a policy contract

Evidence:

- `app.ts` mounts `/api/work-programs` with only `authMiddleware`; the router is
  not behind `studioAuthz`, workflow authorization, or a Work Program-specific
  IAM permission layer.
- `work-programs.router.ts` exposes create, list, get, update, execute, and run
  detail endpoints. Create accepts `status`, `capabilityId`, and up to 100 steps
  with each step's `targetCapabilityId`, optional `workflowTemplateId`,
  `routingMode`, input mapping, and dependencies.
- `createWorkProgram(...)` validates duplicate step keys and checks that an
  optional workflow template belongs to the same target capability, but it does
  not verify that the actor can create work for the program capability, target
  capability, workflow template, work item type, or routing mode.
- `listWorkPrograms(...)`, `getWorkProgram(...)`, and `updateWorkProgram(...)`
  are creator-scoped, not resource-grant or capability-scoped. A creator can set
  a program to `ACTIVE` at creation or update without publication review,
  approval, or immutable versioning.
- `executeWorkProgram(...)` only requires the creator-owned program to be
  `ACTIVE`. It then calls `runProgramFanout(...)`, which creates one WorkItem
  per step and may call `routeWorkItem(...)` with `startNow` when the step uses
  `AUTO_START`.
- `createWorkItem(...)` validates that targets exist syntactically and that
  child workflow templates match target capability, but the creation path itself
  does not call the WorkItem mutation authorization helpers before persisting
  cross-capability WorkItems.
- `executeWorkProgramAsSystem(...)` intentionally resolves an active program by
  tenant only for completion fan-out. If a WorkItem or initiative references an
  unsafe program, finalization can launch it as a system-initiated fan-out.
- The Prisma models store `WorkProgram.status` and `WorkProgramRunStep.status`
  as free strings and have no published-version digest, approval snapshot, owner
  grants, or immutable execution contract.

Impact:

- Any authenticated tenant user who can reach the endpoint may be able to author
  an active Work Program that spawns WorkItems for capabilities they do not own
  or operate, then rely on downstream routing failures as the only protection.
- Program fan-out can create noisy or misleading WorkItems before later route or
  start checks block execution.
- Completion-program fan-out can become a privileged system path: attaching a
  broad active program to a WorkItem/project can cause later finalization to
  create successor work across capabilities without rechecking the original
  author's authority.
- Operators lack evidence for which reviewed Work Program version, capability
  grants, and routing permissions were approved at execution time.

Required fixes:

- Add a typed Work Program authorization contract:
  `work-program:view`, `work-program:create`, `work-program:edit`,
  `work-program:publish`, `work-program:execute`, and
  `work-program:attach-completion`.
- Validate every step's target capability, workflow template, work item type,
  and routing mode against IAM/capability permissions before saving and again
  before execution.
- Introduce DRAFT -> REVIEW -> PUBLISHED/ACTIVE versioning with immutable step
  digests and publication approval; execution should require a pinned published
  version.
- Move completion-program attachment on WorkItems/projects behind live
  authorization and record an attachment snapshot.
- Make `executeWorkProgramAsSystem(...)` verify the stored attachment snapshot
  and recheck sensitive actions before creating or auto-starting successor work.
- Add tests for unauthorized cross-capability step creation, unauthorized
  `AUTO_START`, unsafe completion-program attachment, stale program version
  execution, and system fan-out after permission revocation.

### 184. IAM Git repository grants are not bound to active tenant subjects

Evidence:

- The Git broker correctly limits credential issuance to a service principal
  with `git:issue-credentials`, and it verifies the service token tenant allowlist
  against `IssueCredentialRequest.tenantId`.
- `GitRepositoryGrant` stores `tenant_id`, `subject_type`, `subject_id`, `repo`,
  operations, status, and approval metadata, but the model has no foreign keys to
  `User`, `Team`, `Capability`, `Tenant`, or membership tables.
- `CreateRepositoryGrantRequest` accepts plain `tenantId`, `subjectType`, and
  `subjectId`; the schema does not constrain operation names, subject existence,
  active status, tenant membership, or capability ownership.
- `create_repository_grant(...)` checks only that `subjectType` is one of
  `user|team|capability`, normalizes the repo, lowercases operations, and writes
  an active grant approved by the current super admin.
- `update_repository_grant(...)` can replace operations and status, but it does
  not revalidate the subject, tenant membership, repo allowlist, or supported
  operation vocabulary.
- `issue_credential(...)` authorizes by finding an active grant where
  `tenant_id == body.tenantId` and `repo == normalized(repo)`, then matching
  `(subject_type, subject_id)` against the caller-supplied `userId`,
  the user's team ids from `_user_team_ids(...)`, or caller-supplied
  `capabilityId`.
- `_user_team_ids(...)` queries all `TeamMembership` rows for the user without
  filtering by the requested tenant or team tenant before those team ids are
  compared to grants in `body.tenantId`.
- Searches found Git broker tests for helper functions, plaintext storage guard,
  token fingerprinting, and GitHub response validation, but no tests proving that
  repository grants reject nonexistent subjects, inactive users, users outside
  the tenant, teams from another tenant, inactive capabilities, or unsupported
  operations.

Impact:

- A stale or mistaken grant can remain active even after a user leaves a tenant,
  a team is moved, a capability is archived, or a subject id was mistyped.
- Shared/server MCP runtimes can receive GitHub App credentials for a repo
  because a grant row matches submitted ids, not because IAM revalidated the
  current user/team/capability relationship at issuance time.
- Cross-tenant team membership drift can authorize a tenant grant through a team
  that does not actually belong to that tenant.
- Unsupported or typo operations can be stored as policy intent, later falling
  through to least-privilege GitHub App token generation while audit records show
  a different intended operation.

Required fixes:

- Add tenant-bound subject validation on grant create/update: user must be active
  and a member of `tenantId`; team must belong to `tenantId`; capability must be
  active and owned by `tenantId`.
- Filter `_user_team_ids(...)` by the requested tenant and ignore suspended or
  cross-tenant teams.
- Revalidate the grant subject, tenant, capability, and operation at credential
  issuance time, not only when the grant is created.
- Replace free-form operations with an enum/allowlist such as
  `read`, `clone`, `push`, `pr`, and `comment`; reject unknown operations instead
  of storing them.
- Add expiry/review metadata for grants and fail closed when a grant is stale,
  revoked, or out of policy.
- Add tests for nonexistent/stale users, inactive users, tenant non-members,
  cross-tenant teams, inactive capabilities, unsupported operations, grant
  revocation, and credential issuance after membership revocation.

### 185. Legacy device-token minting can bypass runtime enrollment scope controls

Evidence:

- The newer runtime enrollment flow in
  `devices/enrollment_routes.py` correctly requires a real user, allows normal
  users to create user-scoped enrollments, and rejects `tenant` or `shared`
  enrollments unless the caller is a super admin.
- The older `/api/v1/auth/device-token` route in `devices/routes.py` also
  depends on `require_real_user`, but its `DeviceTokenRequest` accepts
  `token_kind: "device" | "runtime"`, optional `tenant_id`, optional
  `runtime_scope: "user" | "tenant" | "shared"`, caller-chosen
  `allowed_frame_types`, and caller-chosen `capability_tags`.
- `mint_device_token(...)` validates that requested scopes and frame types are
  in the static allowlists, but it does not restrict `token_kind="runtime"`,
  does not require super-admin for `runtime_scope="tenant"` or `"shared"`, and
  does not verify that `tenant_id` is one of the user's active tenant
  memberships.
- `create_device_token(...)` copies those runtime fields into the signed JWT:
  `kind="runtime"`, `tenant_id`, `runtime_scope`, `allowed_frame_types`, and
  `capability_tags`.
- The route persists only a `UserDevice` row keyed by user/device id and scopes;
  it does not persist runtime scope, tenant id, allowed frame types, capability
  tags, enrollment id, approval, or publication evidence with the device row.
- The test suite has runtime-enrollment code-format tests and service-token
  boundary tests, but no regression test proving that `/auth/device-token`
  rejects normal-user tenant/shared runtime claims or tenant ids outside the
  caller's membership.

Impact:

- A normal user can mint a JWT that advertises itself as a tenant or shared MCP
  runtime, bypassing the stricter browser-created runtime enrollment workflow.
- Context Fabric correctly trusts verified JWT claims over the hello frame, so
  overly broad runtime claims become authoritative once signed by IAM.
- Operations can show a runtime as tenant/shared even though no admin approved
  a tenant/shared runtime enrollment and no durable enrollment record exists for
  audit.
- Revocation and review are weaker because the persisted device row does not
  contain the runtime scope and tenant/frame metadata needed to explain what was
  actually minted.

Required fixes:

- Treat `/auth/device-token` as a personal device-token compatibility endpoint:
  only allow `token_kind="device"` or user-scoped `kind="runtime"` without a
  tenant/shared scope.
- Require the runtime enrollment flow for tenant/shared runtimes, or add the
  same super-admin and tenant-membership checks to `/auth/device-token`.
- Verify `tenant_id` against active `UserTenantMembership` for user-scoped
  tenant-bound runtimes; fail closed for unknown or inactive tenants.
- Persist runtime metadata on `UserDevice` or a `RuntimeDevice` table:
  runtime kind/scope, tenant id, frame types, capability tags, enrollment id,
  approval actor, issued-at, and token digest.
- Add tests proving normal users cannot mint tenant/shared runtime tokens through
  the legacy route, cannot set arbitrary tenant ids, and cannot request frame
  types or tags outside their policy.

### 186. LLM and runtime diagnostic reads can be anonymous and disclose platform topology

Evidence:

- `llm-settings/route.ts` has its own `localDevAllowsAnonymousRead()` helper.
  Unless `LLM_SETTINGS_REQUIRE_AUTH=true`, it returns true for every environment
  name outside production, staging, or perf.
- `GET /api/llm-settings` only calls `requireVerifiedCallerBearer(...)` when
  that helper returns false.
- The response includes `gatewayUrl`, `llmGatewayUrl`, `mcpUrl`,
  `contextFabricUrl`, auth mode flags, configured provider/model catalog paths,
  consumer service URLs, gateway health, MCP health, Context Fabric health,
  Runtime Bridge status, providers, models, and workspace stats.
- `platformServices.localDevAllowsAnonymousRead(...)` allows anonymous reads
  when `AUTH_OPTIONAL` is enabled and the environment is not production-like.
  `GET /api/platform-topology` and `GET /api/runtime-infrastructure` use that
  helper before caller verification.
- `platform-topology/route.ts` returns node URLs, env keys, service labels,
  health messages, and route/edge topology for IAM, Agent Runtime, Workgraph,
  Prompt Composer, Context Fabric, Runtime Bridge, MCP, LLM Gateway, Formal
  Verifier, and Audit Governance.
- `runtime-infrastructure/route.ts` returns runtime service URLs, env keys,
  strict-health failure details, Runtime Bridge status, MCP debug status, LLM
  Gateway readiness, and governance service readiness.
- The existing `server-jsonish-routes.contract.test.ts` and
  `health-probe-message.contract.test.ts` verify JSON/plaintext normalization,
  health-message shape, and timeout bounds, but they do not assert auth
  requirements, field redaction, or anonymous-read denial for these diagnostic
  routes.

Impact:

- On office laptops, demos, shared development servers, and accidentally exposed
  non-production stacks, unauthenticated callers can enumerate internal service
  addresses, runtime topology, model/provider readiness, credential presence,
  health errors, config file locations, and connected runtime metadata.
- The leak is broader than normal readiness: it reveals which deployment
  boundary owns MCP/LLM, whether bearer auth is configured, where provider
  catalogs live, which backend URLs Platform Web consumes, and which services
  are degraded.
- Because adoption/start flows call `/api/llm-settings`,
  `/api/runtime-infrastructure`, and `/api/platform-topology` as same-origin
  support routes, the platform has mixed expectations about whether these are
  public setup hints or operator-only diagnostics.
- Attackers can use the map to target weaker debug surfaces such as direct MCP
  HTTP fallback, LLM Gateway debug probes, or service-token backed health routes.

Required fixes:

- Make diagnostics authenticated by default in every environment; require an
  explicit one-shot demo flag for anonymous setup hints.
- Split public setup hints from operator diagnostics. Public hints should return
  only coarse states such as "sign in", "runtime needed", or "provider not
  configured".
- Gate full topology, runtime bridge status, model catalogs, provider readiness,
  config paths, service URLs, and strict-health details behind permissions such
  as `platform:diagnostics:view`, `platform:runtime:view`, and
  `platform:llm:view_sensitive`.
- Redact internal URLs, env key names, auth-mode flags, file paths, and backend
  health payloads unless the caller has sensitive diagnostic access.
- Add contract and browser tests proving anonymous users cannot read diagnostic
  detail in dev/staging-like modes, while signed-in operators can still debug.

### 187. Git History Explainer can run without an authenticated caller

Evidence:

- `POST /api/git-history/explain` parses the JSON body and validates only the
  `since` and `until` date range. It does not call `requireCallerBearer(...)` or
  `requireVerifiedCallerBearer(...)` before dispatch.
- `runtimeIdentity(...)` first tries the caller JWT, but then falls back to
  `envRuntimeIdentity()`, `devRuntimeOverride(...)`, and
  `singleConnectedRuntimeIdentity()` in non-production mode.
- `envRuntimeIdentity()` can use `GIT_HISTORY_RUNTIME_USER_ID`,
  `SINGULARITY_USER_ID`, `GIT_HISTORY_RUNTIME_TENANT_ID`,
  `SINGULARITY_TENANT_ID`, or the first `IAM_SERVICE_TOKEN_TENANT_IDS` entry,
  even when the request has no bearer token.
- `singleConnectedRuntimeIdentity()` calls Context Fabric
  `/api/runtime-bridge/status` with the Context Fabric service token and, in
  non-production mode, adopts the only connected runtime identity.
- `runViaRuntimeBridge(...)` sends a service-token backed
  `/api/runtime-bridge/tool-run` request for `tool_name="git_history_explain"`
  with `capability_tags=["mcp","tools","git"]`,
  `capability_id="operations.git-history"`, and `repo_access=true`.
- If the bridge path fails and `GIT_HISTORY_LOCAL_FALLBACK_ENABLED=true`,
  `POST` falls through to `runLocalFallback(...)`. That path finds a local git
  checkout and runs `python3 bin/explain-git-history.py` through `execFile(...)`
  without adding a caller-auth check.
- The existing `server-jsonish-routes.contract.test.ts` verifies that the route
  uses `readRequestJson(...)` and returns malformed-JSON errors, but it does not
  test missing bearer tokens, env-identity fallback, single-runtime fallback, or
  local fallback authorization.

Impact:

- A network caller can potentially trigger git-history analysis against the
  server checkout or a connected runtime workspace whenever demo/development
  identity fallbacks are configured.
- The runtime-bridge dispatch is service-token backed, so the action can be
  attributed to an env or connected-runtime identity instead of the real caller.
- The route can reveal commit history, author names, path-level change history,
  generated explanations, stderr, repo path, script path, and runtime identity.
- Local fallback keeps the execution on Platform Web itself, undermining the
  architecture goal that source-workspace operations go through a user-owned MCP
  runtime.
- Because this feature explains change history for arbitrary date/path filters,
  it needs at least the same authorization posture as repository read access,
  audit trace viewing, and runtime tool dispatch.

Required fixes:

- Require a verified human or scoped service bearer before any Git History
  Explainer path runs, including local fallback.
- Replace env and single-runtime identity fallback with explicit caller-bound
  routing: tenant id, user id, capability id, repository grant, and trace id
  must be derived from the authenticated subject or a scoped service delegation.
- Disable `GIT_HISTORY_LOCAL_FALLBACK_ENABLED` by default and require an
  operator-only permission for server-local git inspection.
- Bind runtime dispatch to a repository grant or capability-owned repository
  record; fail closed if the caller lacks read access to the selected repo/path.
- Add tests for missing bearer denial, env fallback denial, single-runtime
  fallback denial, local fallback denial, repository grant enforcement, and
  successful authorized runtime dispatch.

### 188. Platform topology does not enforce unique graph node identities

Evidence:

- `platform-topology/route.ts` builds `staticNodes` from a hardcoded route list.
  The list currently contains duplicate `["workbench-ui", "Workbench", ...]`
  entries in the same array.
- Later, the route creates `nodeMap = new Map(nodes.map((node) => [node.id,
  node]))`. Duplicate ids are collapsed in that map, so edge status is computed
  against only the last node for a duplicated id.
- The response still returns the duplicated node entries in `nodes`, and
  `edgeBase` creates duplicate `platform-workbench-ui` edges from
  `staticNodes.filter((node) => node.kind === "ui")`.
- The summary counts use `nodes.length`, `liveNodes`, and `edgeBase.length`, so
  duplicate ids inflate totals while downstream graph rendering treats ids as
  unique keys.
- `health-probe-message.contract.test.ts` checks strict-health message handling,
  timeout bounds, and specific required nodes, but it does not assert unique node
  ids, unique edge ids, or stable topology counts.

Impact:

- The Live App Map can show duplicate or unstable Workbench nodes/edges and
  inconsistent live-node/edge counts.
- Graph renderers commonly key nodes by id; duplicate ids can cause one node to
  disappear, inherit another node's status, or produce misleading edge state.
- Operators using the map to understand "which apps are live" can see confusing
  topology evidence even when the underlying services are healthy.
- The same pattern can recur as more routes are added because topology metadata
  is raw arrays with no validation contract.

Required fixes:

- Build topology nodes from a typed registry keyed by unique id, and fail the
  route or test suite on duplicate node or edge ids.
- Add a topology contract test that extracts every static/probed node id and
  every edge id and asserts uniqueness.
- Derive summary counts from the validated registry rather than raw arrays.
- Add a small UI fallback that warns if backend topology data contains duplicate
  ids instead of silently rendering a misleading map.

### 189. Initiative project codes are globally unique but generated from a tenant-local short space

Evidence:

- `SpecificationProject.code` is declared `@unique`, so the database uniqueness
  boundary is global across all tenants.
- `generateProjectCode()` creates `PRJ-${randomBytes(3).toString('hex').slice(0,
  5).toUpperCase()}`, which gives only five hex characters of entropy for the
  human-facing project code.
- The same function checks for an existing code with `where: { code, tenantId:
  tenantId() }`, so it only probes collisions inside the current tenant even
  though the unique constraint is global.
- After at most five attempts, the fallback code is based on the tail of
  `Date.now().toString(36)`, with no global retry around the actual insert.
- `createProject(...)` calls `generateProjectCode()` before the transaction and
  then performs the `specificationProject.create(...)`; a collision at insert
  time would surface as a raw database error, not as a controlled retry or
  user-facing conflict.
- Search found WorkItem and workflow-start idempotency command models, but no
  equivalent contract test for `SpecificationProject` code uniqueness,
  tenant-scoped code display, or collision retry behavior.

Impact:

- Multi-tenant installs can reject an initiative create because another tenant
  already owns the same short code, even though the code generator believed the
  value was available.
- Large demo or production portfolios have a realistic chance of code collisions
  because the random code space is small for a global key.
- Operators may see intermittent "failed to create initiative" errors that are
  hard to reproduce and unrelated to the user's input.
- If product intent is for codes to be tenant-local, the current schema prevents
  two tenants from using the same friendly code. If intent is global, the
  generator and retry logic are too weak.

Required fixes:

- Decide whether project codes are tenant-local or globally unique.
- If tenant-local, replace `code @unique` with a composite unique constraint on
  `(tenantId, code)` and update lookup/API routes accordingly.
- If globally unique, probe globally and wrap `specificationProject.create(...)`
  in a bounded retry loop that catches unique violations.
- Increase code entropy or use a sequence-backed per-tenant counter for
  predictable human-facing identifiers.
- Add collision tests for same-tenant and cross-tenant project creation.

### 190. Initiative creation is not backed by an idempotent command

Evidence:

- `WorkspaceHubPage.createProject()` posts directly to `/studio/projects` with
  the form payload; it relies on component `busy` state to reduce duplicate
  clicks, but it does not send an idempotency key.
- `studioProjectsRouter.post('/projects', ...)` validates the body, resolves the
  selected capability, and directly calls `createProject(...)`.
- `createProject(...)` inserts a `SpecificationProject`, creates the single
  capability link, creates a pending `CapabilityImpactAssessment`, emits
  `SpecificationProjectCreated`, and publishes an outbox event.
- After returning `201`, the router starts
  `runCapabilityImpactAssessments(...)` in the background and swallows failures
  from that detached promise.
- The schema has durable `WorkItemCreationCommand` and `WorkflowStartCommand`
  models with `idempotencyKey`, `requestHash`, state, error, and result links,
  but there is no `SpecificationProjectCreationCommand` or equivalent request
  fence for initiatives.
- Search did not find API or UI tests that retry the same initiative-create
  request and prove only one project, one capability link, one pending
  assessment, and one creation outbox event are produced.

Impact:

- A browser retry, network timeout, double submit from another tab, or reverse
  proxy replay can create duplicate initiatives with the same name, mission,
  capability, and budgets.
- Duplicate initiatives each schedule their own capability-impact assessment and
  outbox event, so downstream agents can spend tokens and create recommendations
  for work that the user intended to submit once.
- Unlike WorkItem creation and workflow start, the top-level Synthesis intake is
  not crash/retry safe, even though it is the root of the enterprise SDLC flow.
- Support teams cannot reconcile "did my initiative create?" from a durable
  command state when the client loses the response after the database write.

Required fixes:

- Add a `SpecificationProjectCreationCommand` or reuse a generalized
  `DomainCreationCommand` with `idempotencyKey`, request hash, tenant id, actor
  id, state, error, and created project id.
- Have the Synthesis UI generate and send an idempotency key for every create
  attempt, and reuse it while retrying the same draft.
- Move capability-link creation, pending assessment creation, audit/outbox
  publication, and background-assessment scheduling behind the command state or a
  transactional outbox worker.
- Return the previously created project when the same idempotency key/request
  hash is retried, and reject reused keys with a different request hash.
- Add API tests for duplicate submit, lost-response retry, conflicting key reuse,
  background assessment failure, and command recovery after a process restart.

### 191. Synthesis internal links use two incompatible initiative query parameters

Evidence:

- `ProjectPicker.useSelectedProjectId()` reads only `params?.get("project")`.
- `ProjectPicker.select(...)` writes only `?project=<id>` when a user changes the
  selected initiative.
- Most project-scoped Synthesis screens render `NoProjectSelected` whenever
  `useSelectedProjectId()` returns null.
- Several internal Synthesis links still navigate with `?projectId=<id>` instead
  of `?project=<id>`:
  - `SpecTraceabilityScreen` links "Generate tickets" to
    `/synthesis/generate?projectId=...`.
  - `OptionsPortfolioScreen` links "Govern decisions" to
    `/synthesis/decisions?projectId=...`.
  - `EconomicsWorkspaceScreen` links "Open generation" to
    `/synthesis/generate?projectId=...`.
  - `PilotProofScreen` links "Open lineage" to
    `/synthesis/spec?projectId=...`.
- Those target screens all use `useSelectedProjectId()`, so the initiative id is
  present in the URL but ignored by the page.
- `SynthesisShell` renders phase/sidebar/mobile navigation with `href={item.href}`
  for every `SYN_NAV` item, so using the main Synthesis navigation also drops the
  current `?project=<id>` selection.
- The only contract test found for Synthesis route state checks the legacy
  `/studio/:projectId` redirect to `/synthesis/overview?project=...`; it does not
  assert that every in-app Synthesis link preserves the selected initiative.

Impact:

- Users can click from one Synthesis workspace to another and land in a "Choose an
  initiative" empty state even though the source link carried an initiative id.
- The experience reinforces the user's earlier confusion that Synthesis cells,
  boards, specs, generation, and decisions are disconnected surfaces.
- Deep links shared from those buttons are not actually deep links to the intended
  initiative.
- Operators cannot rely on URL state to reproduce a user's journey through
  Synthesis because route parameters are not canonical.

Required fixes:

- Standardize on one query parameter, preferably `project`, for all Synthesis
  routes and links.
- Temporarily make `useSelectedProjectId()` accept `projectId` as a compatibility
  alias and rewrite the URL to the canonical parameter.
- Add a `synthesisProjectHref(path, projectId)` helper so links are generated from
  one place.
- Have `SynthesisShell` preserve the selected initiative across phase/sidebar and
  mobile navigation when the destination is project-scoped.
- Add a route/link contract test that searches Synthesis code for
  `?projectId=` in hrefs and verifies every project-scoped route preserves the
  selected initiative.
- Add a browser smoke path: open an initiative, click Spec -> Generate,
  Options -> Decisions, Economics -> Generate, and Pilot -> Spec, then assert the
  target page is not `NoProjectSelected`.

### 192. Direct LLM prompt profile selections are not consistently validated or applied

Evidence:

- The Direct LLM node editor exposes a Prompt Profile dropdown and stores the
  selected value as `promptProfileKey` in both `config.directLlm` and
  `config.standard`.
- The write-time reference resolver validates `promptProfileId` for
  `DIRECT_LLM_TASK`, but it does not inspect `direct.promptProfileKey` or
  `standard.promptProfileKey`.
- Loop strategy definitions also accept `promptProfileKey`, but
  `validateLoopStrategyDefinition(...)` only normalizes it as text; it does not
  resolve the key against Prompt Composer for the tenant.
- The base Direct LLM Prompt Composer path calls `composeAndRespond(...)` with
  the agent template, capability, task, artifacts, and model overrides, but it
  does not pass the selected `promptProfileKey`.
- Stage prompt resolution does pass `promptProfileKey`, so the same field affects
  loop-stage prompts but not the base agent-profile composition path.

Impact:

- A workflow designer can select or hand-edit a stale, unauthorized, or typoed
  prompt profile key and still save the node because the normal lookup validator
  is watching the wrong field name.
- Operators may believe a Direct LLM verifier is using a chosen prompt profile
  while the base prompt-composer call ignores that selection and uses the
  profile/template defaults.
- Loop strategies can be published with prompt profile keys that are not proven
  to exist or belong to the tenant, moving the failure to runtime and increasing
  the chance of generic prompt fallback.
- Evidence becomes ambiguous because receipts can show a Direct LLM node had a
  prompt profile key configured, but not prove that the base prompt was actually
  assembled from that profile.

Required fixes:

- Pick one canonical field name for Direct LLM prompt-profile references
  (`promptProfileId` or `promptProfileKey`) and use it consistently in the
  editor, config normalizer, lookup resolver, Prompt Composer client, receipts,
  and tests.
- Extend `refsForNodeConfig(...)` and `validateNodeConfig(...)` to validate the
  Direct LLM prompt profile reference, including strategy-defined prompt profile
  keys when a pinned strategy is attached.
- Pass the selected profile reference into the base `composeAndRespond(...)`
  request or remove the dropdown from base Direct LLM agent-profile mode if that
  API cannot honor it.
- Make loop strategy creation/publishing resolve Prompt Composer profile keys in
  the current tenant and fail closed when a referenced profile is unavailable.
- Add regression tests proving a Direct LLM node cannot save or publish a
  strategy with a missing prompt profile, and that a selected prompt profile
  appears in the Prompt Composer assembly evidence used by the provider call.

### 193. Direct LLM output field arrays can silently collapse duplicate names

Evidence:

- `normalizeFields(...)` accepts output fields as either an object or an array for
  legacy compatibility.
- When an array is provided, each item can carry its own `name`, but
  `normalizeFields(...)` writes every normalized entry into a
  `Record<string, DirectLlmOutputField>` as `fields[name] = ...` without a
  `seen` set or duplicate failure.
- The Direct LLM editor performs the same collapse for array-shaped legacy field
  data with `Object.fromEntries(...)`, so duplicate field names are already lost
  before client-side validation runs.
- `directLlmConfigErrors(...)` tries to detect duplicate output field names by
  iterating `Object.keys(...)`, but duplicate object keys cannot exist after the
  array-to-object collapse.
- The plan for Direct LLM structured output explicitly required duplicate field
  names to block save; this implementation does not enforce that for array input.

Impact:

- A legacy config, pasted JSON, generated workflow, or API caller can define two
  output fields with the same name and get a saved node where the later field
  silently overwrites the earlier one.
- The generated JSON Schema, prompt contract, downstream decision gates, and
  receipts can disagree with the author intent because one field definition
  disappeared without a validation error.
- This is especially risky for verifier-agent flows where fields such as
  `approved`, `riskLevel`, or `blockingReason` drive subsequent branching and
  human approval behavior.

Required fixes:

- Add duplicate detection to `normalizeFields(...)` before writing into the
  output record, mirroring the `normalizeInputBindings(...)` `seen` check.
- Preserve array index information in the validation failure, for example
  `outputContract.fields[3].name`, so users can fix the offending row.
- Update `DirectLlmTaskEditor.directFromConfig(...)` to preserve duplicate array
  rows until validation can report them, or normalize only after showing a clear
  error.
- Add unit tests for object fields, array fields, duplicate array names, empty
  names, enum type mismatch, and generated JSON Schema required-field behavior.
- Add a workflow design save regression proving duplicate output field arrays are
  rejected by the API, not only by browser UI.

### 194. Event-bus delivery retry is fixed-sweep retry, not exponential backoff

Evidence:

- `eventbus/dispatcher.ts` documents retry policy as "up to 5 times with
  exponential backoff".
- The `EventDelivery` schema has `status`, `attempts`, `lastAttemptAt`,
  `lastError`, `deliveredAt`, and `responseStatus`, but no `nextAttemptAt`,
  backoff bucket, lease, or dead-letter timestamp. The `nextAttemptAt` column in
  the schema belongs to `notification_deliveries`, not `event_deliveries`.
- On failed delivery, `deliverOne(...)` sets the delivery status back to `queued`
  when `shouldRetry(...)` returns true, increments `attempts`, and records
  `lastAttemptAt`.
- `processOutboxRow(...)` leaves the aggregate outbox row in `pending` while any
  delivery remains `queued`.
- `sweep()` selects all `eventOutbox` rows with `status = 'pending'` every 30
  seconds and reprocesses them immediately; it does not filter delivery rows by a
  computed backoff time.
- Manual retry resets `EventDelivery.attempts` to zero and sets the outbox row
  back to `pending`, but it does not create an explicit retry command or
  scheduled-at timestamp.

Impact:

- A failing subscriber can be retried on every safety sweep at a fixed cadence,
  despite the code claiming exponential backoff.
- During an outage, WorkGraph can repeatedly hit the same broken webhook endpoint
  across many outbox rows, increasing load and noise exactly when downstream
  systems are unhealthy.
- Operators cannot tell whether a queued delivery is waiting for a backoff window
  or merely waiting for the next sweep.
- Retry behavior is hard to test deterministically because the schedule lives in
  process timing rather than durable delivery state.

Required fixes:

- Add `nextAttemptAt`, `deadLetteredAt`, and optionally `lastClaimedBy` /
  `claimExpiresAt` to `EventDelivery`.
- Compute exponential backoff with jitter when a delivery fails, and query only
  queued deliveries whose `nextAttemptAt <= now`.
- Make max-attempt exhaustion transition to a terminal `dead_lettered` status
  instead of overloading `failed`.
- Make manual retry create a clear operator action that resets status and
  `nextAttemptAt`, while preserving prior attempt history in audit evidence.
- Add dispatcher tests for first failure, backoff scheduling, max-attempt
  dead-lettering, manual retry, and multiple failing subscribers on one outbox
  event.

### 195. Event subscription patterns are stored as unvalidated regular-expression fragments

Evidence:

- `event-subscriptions.router.ts` accepts `eventPattern` with only
  `z.string().min(1)` on create and patch.
- `dispatcher.ts` says a subscription pattern without `*` is a literal exact
  match.
- The non-`*` branch of `patternToRegex(...)` builds
  `new RegExp("^" + pattern.replace(/\./g, "\\.") + "$")`, escaping dots but not
  other regular-expression metacharacters such as `[`, `(`, `+`, `?`, `|`, `$`,
  or `\\`.
- The `*` branch does escape regex metacharacters before replacing `*`, so the
  two branches have different safety semantics.
- `findMatchingSubscriptions(...)` calls `patternToRegex(s.eventPattern).test(...)`
  for every active subscription during dispatch. A malformed exact pattern can
  throw while processing an outbox row.

Impact:

- A subscription that looks like an exact literal can match unintended events
  because regex metacharacters remain active.
- A malformed pattern such as an unmatched character class can throw inside the
  dispatcher, causing an outbox row to record sweep/listener errors instead of
  delivering to otherwise healthy subscribers.
- A single bad subscription can become an operational denial-of-delivery risk for
  matching event rows until an operator finds and fixes the pattern.
- This makes the event-bus contract harder to explain: exact patterns are not
  actually exact unless they avoid regex syntax by convention.

Required fixes:

- Use one `escapeRegExp(...)` helper in both `patternToRegex(...)` branches, then
  replace escaped `\\*` tokens with the supported glob fragment.
- Validate event patterns at subscription create/update time: allowed
  characters, max length, no empty segments, and a successfully compiled regex.
- Store a normalized pattern and expose pattern validation errors in the
  subscription UI before save.
- Make dispatcher matching isolate bad subscriptions: mark that subscription
  invalid/disabled or record a delivery-level failure without aborting the whole
  outbox row.
- Add tests for exact literal metacharacters, valid glob patterns, malformed
  patterns, long patterns, and one invalid subscription alongside one healthy
  subscription.

### 196. Runtime prompt override and refinement mutate active node config without governed approval

Evidence:

- `POST /workflow-instances/:id/nodes/:nodeId/refine`,
  `/prompt`, and `/answer-questions` require only
  `assertInstancePermission(..., 'edit')`.
- These routes mutate the active `WorkflowNode.config` by writing
  `_refineFeedback`, `_promptOverride`, or `_copilotAnswers`, then call
  `restartNode(...)`.
- Unlike node/edge topology CRUD, these routes do not call
  `assertInstanceGraphEditable(...)`; they are explicitly intended for active run
  rework.
- `AgentTaskExecutor` appends `_refineFeedback` and `_copilotAnswers` into the
  task text used by the agent.
- The same executor forwards `_promptOverride` into Context Fabric as
  `run_context.prompt_override`.
- Context Fabric's Copilot executor treats `prompt_override` as authoritative
  and returns it verbatim, skipping normal prompt composition.
- `restartNode(...)` records a `NODE_RESTARTED` workflow mutation with previous
  status and reset node ids, but it does not record the prompt override,
  reviewer feedback, question answers, old config, new config, approval request,
  policy decision, or prompt hash in that mutation.

Impact:

- A user with workflow edit permission can alter the exact prompt used by a live
  agent run and restart the node without the stronger approval, prompt-contract,
  or governance controls expected for SDLC evidence.
- The route comment says the operator edited the fully composed prompt, but the
  server does not prove which prompt was shown, whether it matched a Prompt
  Composer assembly id, or whether the edited prompt was reviewed.
- Evidence can show a node was restarted while omitting the most important
  semantic change: the task/prompt text that changed the agent's behavior.
- This weakens replay and audit because the active node config is the mutable
  carrier of human feedback and prompt override, not an immutable rework command
  with before/after hashes.

Required fixes:

- Split these actions into explicit permissions such as
  `workflow:node:restart`, `workflow:node:refine`,
  `workflow:node:answer_questions`, and `workflow:prompt_override`.
- Persist a `WorkflowNodeReworkCommand` or equivalent immutable command row with
  old config hash, new config hash, prompt assembly id, prompt hash, actor,
  reason, and approval/policy decision id.
- For prompt override, require a dedicated approval or governance gate in
  production mode unless the workflow/template explicitly allows operator prompt
  editing.
- Make Context Fabric receive prompt override evidence fields, not only the
  override text, and include them in receipts/evidence packs.
- Add tests proving generic workflow edit does not imply prompt override,
  restart/rework commands are idempotent and audited, and evidence contains the
  prompt hash used for the restarted attempt.

### 197. Runtime control endpoints bypass explicit workflow authorization

Evidence:

- `POST /workflow-instances/:id/signals/:name` persists a workflow signal, advances
  matching `SIGNAL_WAIT` nodes, and starts event-gated nodes without calling
  `assertInstancePermission(...)`.
- `POST /workflow-instances/:id/nodes/:nodeId/start` calls
  `startAwaitingNode(...)` directly without an instance permission check.
- `POST /workflow-instances/:id/nodes/:nodeId/create-branch` calls
  `provideCreateBranchInput(...)` directly without an instance permission check.
- `POST /workflow-instances/:id/nodes/:nodeId/fail` calls `failNode(...)`
  directly without an instance permission check.
- `POST /workflow-instances/:id/advance` calls `advance(...)` directly without
  an instance permission check.
- The service helpers are runtime mutation helpers, not authorization guards:
  `startAwaitingNode(...)` flips `_awaitingStart` and executes the server node;
  `provideCreateBranchInput(...)` writes branch/source choices into run globals
  and re-runs the `CREATE_BRANCH` node; `failNode(...)` retries, activates error
  boundaries, or pauses/fails workflow state; `advance(...)` marks node progress
  and activates downstream nodes.
- Neighboring routes such as node restart explicitly call
  `assertInstancePermission(req.user!.userId, id, 'edit')`, so the omission is
  not a router-wide pattern.

Impact:

- Any authenticated caller who can address a run and node id can potentially send
  signals, start a manual/event-gated stage, supply source branch/clone settings,
  or force a node into retry/failure behavior unless tenant/RLS alone blocks the
  row.
- Signal delivery can become an ungoverned control-plane API instead of a scoped
  event ingress contract, which is risky for human approvals, external callbacks,
  and event-driven WorkItem flows.
- Branch/source selection affects what code is read or changed downstream; it
  should not be writable by a user who merely has visibility into the run.
- Audit evidence records mutation events such as `NodeStartTriggered` and
  `CreateBranchInputProvided`, but it does not record an authorization decision id
  for those control actions.

Required fixes:

- Add explicit action checks before each route, for example `signal`, `start`,
  `operate`, `branch_input`, and `fail` / `retry`, mapped to real IAM workflow
  permissions rather than generic edit.
- Keep a defense-in-depth authorization guard in the service helpers for callers
  outside the HTTP router, or split internal trusted runtime calls from
  user-facing control APIs.
- For signal ingestion, validate allowed signal names, expected correlation keys,
  source identity, and replay policy against the workflow/run contract.
- Persist authorization decision ids and control-action payload hashes in
  `WorkflowMutation` / audit events for start, signal, branch input, and fail.
- Add direct-ID tests proving a run viewer, unrelated capability user,
  cross-tenant user, and stale runner token cannot use these control endpoints.

### 198. Workflow instance subresource reads and params writes bypass view/edit checks

Evidence:

- `GET /workflow-instances/:id/trust-summary` reads node configs and consumable
  verification data without `assertInstancePermission(..., 'view')`.
- `GET /workflow-instances/:id/nodes` and
  `GET /workflow-instances/:id/nodes/:nodeId` return node configs, decision
  records, AgentRun ids, document storage keys, and consumable verification data
  without a view check.
- `GET /workflow-instances/:id/mutations`,
  `GET /workflow-instances/:id/history`, and
  `GET /workflow-instances/:id/receipts` return workflow mutation/audit/evidence
  rows without a view check.
- The receipts route uses `prisma.receipt.findMany(...)` directly instead of
  `withTenantDbTransaction(...)`, so it is weaker than the tenant-scoped
  neighboring subresource queries.
- `GET /workflow-instances/:id/params` returns runtime parameter definitions and
  values without a view check.
- `PATCH /workflow-instances/:id/params` mutates `_paramDefs` and `_params` in
  the workflow instance context without an edit/operate permission check.
- `GET /workflow-instances/:id/globals` exposes visible TeamVariable defaults,
  current run-global values, and editability metadata without a view check.
- `POST /workflow-instances/:id/test-branches` evaluates branch conditions for a
  caller-provided sample context without checking that the caller can view or edit
  the run.
- `GET /workflow-instances/:id/pending-executions` returns live pending runner
  rows with node type, label, and config. It strips `claimToken`, but it does not
  check view/operate/manage-runner permission before disclosing the queue.

Impact:

- A caller who cannot fetch the main run detail can still learn graph structure,
  node configs, artifact/document identifiers, decision metadata, receipts,
  parameters, globals, and pending runner work by calling direct subresource URLs.
- Runtime params are executable context: changing them can alter later branch
  decisions, prompts, tool arguments, or workflow behavior without any matching
  authorization decision.
- The receipts endpoint is especially risky because it bypasses the tenant helper
  used by most adjacent routes and can expose evidence rows by direct
  `WorkflowInstance` id.
- Queue visibility leaks operational timing and node config for client/edge/
  external work even when runner management should be a separate permission.

Required fixes:

- Add `assertInstancePermission(..., 'view')` to every read subresource and
  `assertInstancePermission(..., 'edit'|'operate')` to params/test-branch writes,
  then migrate to explicit actions such as `view_evidence`, `view_runtime_state`,
  `edit_runtime_params`, and `manage_runner_queue`.
- Wrap receipts and every adjacent subresource query in `withTenantDbTransaction`
  or equivalent strict tenant scoping.
- Redact sensitive node config fields, document storage keys, param/global values,
  and pending-execution payload/config unless the caller has sensitive-evidence or
  runner-management permission.
- Treat `PATCH /params` as a governed runtime-input command with before/after
  hashes, actor id, authorization decision id, and stale-run fencing.
- Add direct-ID tests for a run viewer, non-viewer same-tenant user, cross-tenant
  user, and runner-scoped token across all workflow instance subresources.

### 199. Generation plan actuals can rewrite delivery economics without governed evidence

Evidence:

- `PATCH /generation-plans/:planId/rows/:rowId/actuals` requires only
  `assertGenerationProjectAccess(..., 'edit')`.
- The route writes `GenerationPlanRow.actualStartAt`, `actualFinishAt`,
  `actualHours`, and `actualCostUsd` directly from the request body.
- If the row has a `capacityAllocationId`, the same request updates the matching
  `CapacityAllocation.startAt`, `endAt`, `estimatedHours`, and status to
  `IN_PROGRESS` or `COMPLETED`.
- `GenerationPlanRow` stores actual hours/costs as mutable columns, with no
  actor, source, evidence id, approval id, row-version, or finalization reference
  attached to the actuals themselves.
- `CapacityAllocation` has metadata and `createdById`, but no updated-by,
  actuals-source, approval, or immutable adjustment history fields.
- The route emits `GenerationPlanActualsRecorded` via `logEvent(...)`, but it does
  not store before/after hashes, the previous row values, the capacity allocation
  before/after state, evidence source, or approval decision id.

Impact:

- A user who can edit the initiative/generation plan can rewrite realized hours,
  cost, dates, and capacity status without tying the numbers to a WorkItem
  finalization record, timesheet, CI evidence, invoice, approval, or audit-grade
  adjustment command.
- Business value dashboards, budget variance, milestone reports, and sponsor
  readouts can consume mutable actuals that are not provenance-bound.
- Capacity allocations can be marked complete through the plan row route even if
  the linked WorkItem is not finalized or the delivery evidence is contested.
- Because the event omits before/after values, investigators cannot reconstruct
  how actuals changed over time from durable evidence alone.

Required fixes:

- Replace direct actuals mutation with an append-only `GenerationPlanActualsEvent`
  or `DeliveryActualsAdjustment` table containing old values, new values, source,
  evidence refs, actor, approval decision id, and content hash.
- Gate actual-cost/hour changes behind finance or delivery-owner permissions,
  separate from general generation-plan edit.
- Derive capacity allocation status from WorkItem target/finalization state or
  require a governed capacity adjustment command before changing it.
- Link actuals to WorkItem finalization, reconciliation, artifact/evidence, or an
  explicit manual adjustment reason so sponsor readouts can explain provenance.
- Add tests proving a generic plan editor cannot rewrite actuals, completed
  WorkItems produce immutable actuals evidence, and repeated adjustments preserve
  a full before/after history.

### 200. WorkItem start commands are created before authorization and hash too little launch input

Evidence:

- `startWorkItemTarget(...)` creates or updates a `WorkflowStartCommand` with
  `state = IN_PROGRESS`, `requestHash`, `attempt`, and a ten-minute `leaseUntil`
  before it verifies template start permission.
- The same function calls `assertTemplatePermission(...)` and
  `assertStartableWorkItemTemplate(...)` only after the command row is already
  created or leased.
- Strict tenant validation via `tenantIdForCreate(...)` also happens after the
  command row is created.
- The failure cleanup that marks the command `FAILED` only wraps
  `cloneDesignToRun(...)`. Permission, template-scope, and tenant validation
  failures happen before that `try/catch`, so they can leave the command in
  `IN_PROGRESS` until its lease expires.
- While the command lease is live, a repeated call with the same idempotency key
  receives "already in progress"; a call with a different request hash receives
  "idempotency key was already used with a different workflow start request."
- The `requestHash` includes `workItemId`, `targetId`, `templateId`, `vars`,
  `globals`, and `params`, but it does not include launch options that materially
  change execution: `modelAlias`, `sourceRef`, `sourceType`, `sourceUri`,
  `cloneDir`, or `pushEachPhase`.
- Those omitted fields are later threaded into run globals before
  `cloneDesignToRun(...)`, so they do affect the launched workflow.

Impact:

- A failed unauthorized or mis-scoped start attempt can poison the idempotency key
  and block the user/operator from correcting the launch until the lease expires.
- Operations sees an `IN_PROGRESS` start command with no created run and no
  persisted failure reason for pre-clone authorization/template/tenant errors.
- Two launch requests that differ in source branch, repository/source URI, model,
  clone directory, or push behavior can be treated as the same idempotent request
  because those fields are excluded from the hash.
- A completed command can return an old child workflow run even when the caller
  retries with a different model/source selection under the same idempotency key,
  weakening replay and evidence about what was actually launched.

Required fixes:

- Perform template permission, template/capability scope validation, and tenant
  validation before creating or leasing `WorkflowStartCommand`, or wrap the whole
  pre-clone path in a command transaction that records failures immediately.
- Expand `requestHash` to include every execution-shaping launch field, including
  model, source, clone, and push options.
- Persist failed preflight reason, authorization decision id, template id,
  target capability id, and request hash on the command when any preflight fails.
- Add a recovery path that can safely clear or retry stale preflight-failed start
  commands without waiting for a generic lease expiry.
- Add tests for unauthorized template start, mismatched template capability,
  strict-tenant failure, reused idempotency key with different source/model
  options, and retry after a failed preflight command.

### 201. Legacy WorkGraph audit event and receipt routes bypass tenant/resource authorization

Evidence:

- `app.ts` mounts `auditRouter` at `/api/audit` behind `authMiddleware`, so the
  caller must be signed in, but the router itself is the final route-level
  policy gate for this surface.
- `audit.router.ts` implements `GET /api/audit/events` by building `where` from
  only optional `entityType` and `entityId` query parameters.
- The same route calls `prisma.eventLog.findMany(...)` and
  `prisma.eventLog.count(...)` directly; it does not add a tenant filter,
  resource permission check, capability/team check, or audit-view action check.
- `EventLog` has an optional `tenantId` column and indexed tenant field, but this
  endpoint never uses it.
- `GET /api/audit/receipts/:id` calls `prisma.receipt.findUnique({ where: { id }
  })` directly by receipt id.
- `Receipt` has no `tenantId` column, so the receipt route cannot enforce tenant
  scope from the row itself; it also does not join through `eventLogId`,
  `entityType`, or `entityId` to authorize the underlying resource.
- Neither route uses `withTenantDbTransaction`, `runWithTenantDbContext`,
  `assertInstancePermission`, WorkItem/capability access checks, or the newer
  unified `/api/receipts?trace_id=...` trace-spine redaction/warning logic.
- Raw `payload` and `content` JSON are returned as stored; there is no sensitive
  evidence redaction for event payloads, delivery metadata, documents, artifact
  references, code-change details, or external side-effect receipts.

Impact:

- Any authenticated WorkGraph user who can reach `/api/audit/events` can enumerate
  event metadata across tenants or resources by paging with no filters, or probe
  specific `entityType/entityId` pairs.
- Receipt ids become direct object references: a leaked or guessed id can expose
  the receipt content even if the caller cannot view the workflow instance,
  WorkItem, capability, artifact, or audit trace that produced it.
- Operations hardening and the unified trace cockpit can be bypassed by older UI
  clients, scripts, or direct API calls that still use the legacy `/api/audit`
  endpoints.
- Sensitive delivery evidence can leak in environments where audit rows contain
  prompt snippets, document references, event payloads, repository metadata, or
  external delivery details.
- Tenant isolation depends on every writer filling tenant fields and every
  reader avoiding this legacy route, which is not an enterprise-ready safety
  boundary.

Required fixes:

- Route `/api/audit/events` through tenant-scoped database context and require
  `workflow:audit:view` or an equivalent typed authorization decision for the
  target resource.
- Require at least one scoped selector for non-admin reads, such as tenant plus
  trace id, workflow instance id, WorkItem id, capability id, or audited entity,
  and verify effective access before returning rows.
- Rework `/api/audit/receipts/:id` to resolve the backing receipt through
  `eventLogId` or canonical trace/resource linkage, then apply the same
  resource-level authorization and tenant checks as the trace cockpit.
- Add field-level redaction unless the caller has the relevant sensitive-evidence
  permission.
- Deprecate or redirect legacy receipt reads through the unified receipts/trace
  API once compatibility callers are migrated.
- Add IDOR tests for cross-tenant event enumeration, entity id probing, receipt
  id probing, unauthorized workflow receipt access, and sensitive-payload
  redaction.

### 202. Canonical trace receipt reads are trace-id scoped but not resource-authorized

Evidence:

- Platform Web `src/app/api/traces/[traceId]/route.ts` is the canonical trace
  cockpit API and calls `/api/workgraph/receipts?trace_id=...`,
  `/api/audit-gov/traces/:traceId/timeline`, and `/api/platform-logs` in
  parallel.
- The route normalizes only the trace id length/null-byte shape, forwards the
  caller authorization header, and merges whatever the upstream services return;
  it does not first resolve the trace to a workflow instance, WorkItem,
  capability, artifact, or actor-visible resource.
- WorkGraph `receipts.router.ts` accepts only `trace_id` plus optional
  `include_cf`, derives tenant from the request, and then calls
  `localReceipts(traceId, tenantId)` and `cfReceipts(traceId)`.
- `localReceipts(...)` tenant-filters `AgentRun` rows by matching
  `WorkflowInstance.tenantId`, but it does not call
  `assertInstancePermission(..., 'audit_view')`, `assertInstancePermission(...,
  'view')`, WorkItem access checks, capability access checks, or any
  sensitive-evidence permission before returning receipts.
- Once any `AgentRun` matches the trace, the same local receipt query includes
  all `ApprovalRequest` rows for the discovered workflow instance ids and all
  `ToolRun` rows for those instances, even though the caller has not been proven
  allowed to view approvals, tool evidence, or the run itself.
- `cfReceipts(...)` fetches Context Fabric receipts by trace id with a
  service-token header and then merges them into the caller response; the
  WorkGraph route does not pass or enforce the caller's resource-level access
  against those remote receipts.
- The response payload includes receipt `payload`, `correlation`, metrics, tool
  idempotency keys, reviewer notes, reviewer ids, approval decisions, and
  Context Fabric/MCP receipt payloads without field-level redaction.

Impact:

- A tenant member who learns a trace id can open the canonical trace cockpit and
  retrieve evidence for workflow runs, approvals, tools, and model calls they may
  not otherwise be authorized to view.
- Trace ids become bearer-like evidence locators inside a tenant. That conflicts
  with the desired model where trace id is a correlation key, not an access
  grant.
- Sensitive approval notes, tool metadata, model-call payloads, and runtime
  correlations can leak through the trace view even when direct run, WorkItem, or
  operation routes are later hardened.
- The trace API can merge and display Context Fabric/MCP evidence without the
  platform verifying that the human caller has rights to the originating run or
  capability.
- Auditors and operators get an inconsistent access model: `/runs/:id` may deny
  a user, while `/audit/trace/:traceId` can still show correlated evidence if the
  trace id is known.

Required fixes:

- Add a trace-to-resource resolver that maps trace id to candidate workflow
  instances, WorkItems, capabilities, AgentRuns, ToolRuns, and Context Fabric
  calls before returning timeline data.
- Require `workflow:audit:view` or an explicit typed authorization decision for
  every resolved workflow instance/capability, with a fail-closed response when
  no authorized owning resource can be found.
- Make Context Fabric receipt fetch accept and enforce caller resource context or
  return only redacted source counts until WorkGraph authorizes and scopes the
  merge.
- Redact receipt payloads, approval notes, document references, model/tool
  payloads, idempotency keys, and external side-effect details unless the caller
  has the corresponding sensitive-evidence permission.
- Add tests where a same-tenant viewer can access one run but not another, then
  prove both `/runs/:id` and `/api/traces/:traceId` enforce the same effective
  access.

### 203. Idea Board coalesce keys can drop legitimate later edits and moves

Evidence:

- `useBoardProducer.ts` persists a browser-local queue of pending board events
  under `singularity:studio-board-events:${boardId}`.
- Each queued item contains only `eventType`, `objectIds`, `payload`, and
  optional `coalesceKey`; it does not store the branch, `expectedHeadSeq`, state
  hash, base event sequence, or a unique request id.
- The producer posts the queued object directly to
  `/studio/boards/:boardId/events`.
- The UI uses stable per-object coalesce keys for normal editing:
  `move:${id}`, `edit:${id}`, `create:${id}`, and `delete:${id}`.
- `board.router.ts` accepts `expectedHeadSeq`, but it is optional.
- `appendEvent(...)` enforces the stale-head guard only when
  `input.expectedHeadSeq !== undefined`.
- Before appending a fresh event, `appendEvent(...)` searches all prior events on
  the branch with the same `eventType`, `coalesceKey`, actor type, and actor id.
- If such a prior event exists and `shouldCoalesce(...)` returns false, the
  service returns the prior event as `coalesced: true` instead of appending or
  rejecting the new event.
- `shouldCoalesce(...)` returns false for `OBJECT_MOVED` after 2 seconds and for
  `OBJECT_EDITED` after 5 seconds.
- Therefore, a user moving or editing the same board object later with the same
  stable key can receive a successful response while the new move/edit is not
  appended to `BoardEvent` and not represented in replay, snapshots, branch
  merge, synthesis, or exports.

Impact:

- The live board can appear to accept an edit through the CRDT/local UI while the
  durable event log silently retains an older position or text.
- Reload, time travel, export, synthesis, branch diff, and evidence replay can
  lose ordinary later edits to the same sticky/frame/object.
- Offline queued events can replay against a newer branch head without a base
  sequence check, so stale browser state may append or be swallowed in ways the
  user cannot understand.
- The server conflates two different concepts: "retry the same request" and
  "coalesce a short-lived drag/edit burst". Stable object keys are not unique
  idempotency keys.
- This weakens the Miro-like board promise because users can make visible changes
  that do not become durable governed Synthesis evidence.

Required fixes:

- Split coalescing identity from idempotency identity. Use a unique
  `requestId`/`eventId` for retries and a short-lived `coalesceGroupId` for
  drag/edit bursts.
- Never return an old prior event for a new payload merely because the coalesce
  key matches outside the coalesce window. Append a fresh event or reject a true
  conflicting idempotency-key reuse.
- Make the board producer include branch, base `headEventSeq` or state hash, and
  a unique request id in every durable event post.
- Require `expectedHeadSeq` for structural object mutations in enterprise mode,
  with a clear conflict response that offers reload, fork, or merge.
- Add tests for editing the same object twice after the coalesce window, moving
  the same object twice after the coalesce window, retrying the exact same event,
  conflicting idempotency-key reuse, offline queue replay after head changes, and
  reload/time-travel reflecting the latest durable edit.

### 204. Source-document claim extraction failures are recorded as successful empty ingests

Evidence:

- `board-ingestion.service.ts` moves an artifact to `EXTRACTING`, then calls
  `extractStagedClaims(...)`.
- `extractStagedClaims(...)` catches every extractor error, invalid JSON parse,
  invalid envelope, or malformed claim output and returns an empty array.
- The catch block comment explicitly says "Extractor unavailable or produced no
  valid JSON" and "Never let extraction fail the ingest."
- After receiving that empty array, `ingest(...)` updates the artifact to
  `status: 'COMPLETED'` and stores `extractedClaims: []`.
- The same ingest path appends `INGESTION_COMPLETED`, logs
  `IngestionCompleted`, and publishes `IngestionCompleted` with
  `claims: staged.length`.
- `parseExtractedClaims(...)` also returns `[]` for an invalid envelope, and in
  the bare-array compatibility path silently drops malformed individual claims.
- No extraction status, warning, error class, invalid-claim count, raw-output
  digest, extractor model/call id, or retryability metadata is stored on the
  `IngestedArtifact` row.

Impact:

- Operators cannot distinguish "the source contained no extractable claims" from
  "Context Fabric was unavailable", "the model returned malformed JSON", "the
  schema rejected every claim", or "the extractor crashed".
- Synthesis may show a clean completed document pile while the governed
  source-to-claim evidence chain is incomplete.
- A user can proceed to decisions, specification, or generation with zero staged
  claims, believing the source was reviewed rather than extraction having failed
  open.
- Troubleshooting has no durable error reason, model call id, trace id, retry
  count, or dead-letter record for failed extraction.
- Evidence packs become weaker because a completed artifact does not prove that
  claim extraction succeeded or that zero claims is a meaningful result.

Required fixes:

- Split artifact status into at least `PARSED`, `EXTRACTION_COMPLETED`,
  `EXTRACTION_EMPTY`, `EXTRACTION_FAILED`, and `COMPLETED` or store a separate
  extraction-status object on the artifact.
- Persist extractor trace id, model/provider metadata, validation errors,
  malformed/drop counts, output digest, retryable flag, and last error reason.
- Treat extractor unavailable or invalid envelope as warning/failed extraction,
  not as successful empty extraction.
- Let the UI show "parsed but claim extraction failed" with retry and
  continue-without-claims options.
- Add tests for extractor unavailable, invalid JSON, invalid envelope, all claims
  malformed, valid zero-claim result, partial invalid claims, retry after failure,
  and evidence-pack rendering of extraction health.

### 205. Runtime bridge revocation checks treat unknown devices as active

Evidence:

- `singularity-iam-service/app/devices/routes.py` implements
  `GET /internal/devices/status`.
- That endpoint depends on `require_reference_read`, which permits any real user
  token and any service token with `read:reference-data`; it does not require the
  caller to be the device owner or a runtime-bridge-only service principal.
- The endpoint accepts arbitrary `user_id` and `device_id` query parameters.
- When no `UserDevice` row is found, it returns
  `{ "found": false, "revoked": false }`.
- `context-fabric/services/context_api_service/app/laptop_bridge.py`
  `_device_revoked(...)` calls that endpoint and returns only
  `bool(data.get("revoked"))`, discarding the `found` value.
- Runtime WebSocket admission rejects a runtime only when `_device_revoked(...)`
  returns `True`, or when the IAM status check is unavailable and
  `REVOCATION_FAIL_OPEN` is false.
- Therefore, a signed runtime/device JWT whose `(sub, device_id/runtime_id)` no
  longer maps to a `UserDevice` row is treated exactly like an active,
  non-revoked runtime.
- The mid-session recheck has the same issue: unknown device status is collapsed
  to false, so it does not disconnect the runtime.

Impact:

- Deleting or failing to persist a runtime/device row does not reliably disable
  a still-valid signed JWT; it can be admitted until JWT expiry.
- Operators cannot distinguish "known active runtime" from "unknown device id"
  in Context Fabric admission behavior.
- The internal device-status API is also a cross-user device existence probe for
  any authenticated real user, because it returns `found` for arbitrary
  `(user_id, device_id)` pairs.
- Runtime bridge audit evidence can imply revocation enforcement was checked
  even though the decisive registered-device existence check was ignored.

Required fixes:

- Make the IAM status endpoint service-only, or require owner/super-admin access
  for human callers and a dedicated `runtime:device-status` service scope for
  Context Fabric.
- Include tenant/runtime-scope checks in the status lookup and reject caller
  tenant mismatches.
- Change Context Fabric to treat `found=false` as fail-closed in strict mode and
  as a separate `RUNTIME_DEVICE_NOT_REGISTERED` admission error.
- Return and consume a richer status envelope such as
  `registered`, `revoked`, `owner_active`, `tenant_active`, `runtime_scope`, and
  `policy_version`.
- Add tests for unknown device rows, deleted device rows, cross-user status
  probes, revoked rows, IAM unavailable, and mid-session transition from found
  to missing.

### 206. IAM token verification does not refresh tenant membership claims

Evidence:

- `singularity-iam-service/app/auth/routes.py` local login computes tenant
  membership from the database with `active_tenant_ids(...)`, then stamps that
  list into the JWT through `create_access_token(...)`.
- OIDC login follows the same pattern before minting the user token.
- The same file's `/auth/verify` endpoint decodes the presented token and checks
  only that the `User` row still exists and has `status == "active"`.
- `/auth/verify` returns `tenant_ids=list(payload.get("tenant_ids") or [])`
  from the JWT payload instead of recomputing active `UserTenantMembership` rows.
- `workgraph-studio/apps/api/src/lib/iam/client.ts` prefers `/auth/verify` for
  bearer introspection and caches the returned `IamUser` object for
  `IAM_VERIFY_CACHE_TTL` seconds.
- `workgraph-studio/apps/api/src/middleware/auth.ts` uses the returned
  `iamUser.tenant_ids` to bind `X-Tenant-Id` / tenant selectors before route
  authorization runs.

Impact:

- Removing a user's tenant membership does not immediately remove that tenant
  from already-issued user JWTs. Downstream services can continue accepting the
  old tenant claim until JWT expiry, plus any WorkGraph verification cache TTL.
- WorkGraph's strict tenant selector check can pass with stale tenant claims
  even though IAM's current membership table would reject the same user.
- Enterprise offboarding and emergency tenant revocation are weaker than the UI
  implies: disabling the whole user is live, but removing one tenant from an
  otherwise active user is not live.
- Audit decisions that record the token tenant context can overstate the user's
  current tenant membership at the time of use.

Required fixes:

- Have `/auth/verify` recompute active tenant memberships from
  `UserTenantMembership` for user tokens, or include a token version /
  membership-version claim and reject stale versions after membership changes.
- Clear or shorten WorkGraph `IAM_VERIFY_CACHE_TTL` for tenant-sensitive actions,
  and provide an explicit cache-invalidation path for user membership changes.
- Record tenant-membership version or evaluated membership source in authz
  decisions.
- Add tests for removing one tenant from a multi-tenant user, keeping the user
  active, then verifying that old JWTs cannot select the removed tenant in IAM,
  WorkGraph, Context Fabric, approvals, and runtime dispatch.

### 207. WorkItem trigger dedupe claims can suppress retry after partial failure

Evidence:

- `fanOutToWorkItemTriggersDetailed(...)` computes a `dedupeValue` from
  `deliveryId` or the resolved trigger correlation key.
- When no existing WorkItem is attachable, the helper calls
  `claimTriggerEvent(...)` before `createWorkItem(...)`, `recordTriggerEventWorkItem(...)`,
  and `routeWorkItem(...)`.
- `claimTriggerEvent(...)` creates `WorkItemEventDedup(triggerId, dedupeValue)`
  first and returns `claimed`.
- If any later step throws before `recordTriggerEventWorkItem(...)`, the catch
  block returns a fan-out result with `status: 'failed'`, but the dedupe row
  remains with `workItemId == null`.
- A retry with the same delivery/correlation key inside `DEDUP_WINDOW_MS` hits
  the unique key, returns `duplicate` with `workItemId: null`, and
  `fanOutToWorkItemTriggersDetailed(...)` continues without creating or routing
  a WorkItem.
- The stale claim is released only after the window expires, at which point a
  later retry updates `claimedAt` and tries again.
- The schema has only `triggerId`, `dedupeValue`, `workItemId`, and `claimedAt`
  on `WorkItemEventDedup`; it has no claim status, error, attempt count, lease,
  expiration, tenant id, or recovery marker.

Impact:

- A transient failure after claim creation can turn an otherwise retryable
  inbound event into a silent duplicate/no-op for the dedupe window.
- Producers and operators can receive retryable errors, retry promptly, and still
  fail to create or route the WorkItem because the stale claim blocks them.
- Workflow Operations may show a failed event without a durable way to clear or
  replay the orphaned dedupe claim.
- The SDLC event-driven path is not strongly at-least-once: the idempotency
  guard protects against duplicate creation but can also suppress the only valid
  retry.

Required fixes:

- Treat `WorkItemEventDedup` as a leased command/claim with statuses such as
  `CLAIMED`, `CREATED`, `ROUTED`, `FAILED`, `EXPIRED`, and `REPLAYING`.
- Commit claim, WorkItem creation, claim-to-WorkItem binding, and routing command
  in one transaction or transactional outbox flow.
- On failure before `workItemId` is bound, mark the claim retryable instead of
  returning duplicate/no-op on the next delivery.
- Expose orphaned/failed dedupe claims in Workflow Operations with repair and
  replay actions.
- Add tests for failures after claim, after WorkItem create, after
  `recordTriggerEventWorkItem`, after route, concurrent retries, and manual
  replay of an orphaned claim.

### 208. Signed ingress records events before routing without an idempotent operation record

Evidence:

- `incoming-events.router.ts` requires an upstream outbox id and HMAC signature,
  then creates an `EventLog` row with `eventType: incoming.${eventName}` before
  it calls `fanOutToWorkItemTriggers(...)`.
- If the event-log write succeeds but trigger fan-out fails, the route returns
  `503 EVENT_FANOUT_FAILED` with `retryable: true`.
- The route does not upsert by upstream `outboxId`; `EventLog` has no unique key
  on event type, source service, upstream outbox id, tenant, or trace id.
- Re-delivery after that 503 can therefore create another `incoming.${eventName}`
  row before attempting fan-out again.
- The already-recorded row is not updated with routing status, trigger results,
  WorkItem ids, workflow instance ids, or a terminal dead-letter state.
- Workflow Operations currently reads only `WorkflowInboundEventReceived`,
  `WorkflowInboundEventDeadLettered`, `WorkflowInboundEventFailed`, and
  `WorkflowInboundEventReplayed`, so these partial signed-ingress rows do not
  become first-class operations records.

Impact:

- A signed event can be durably recorded many times while never producing a
  visible operation record that explains whether routing is pending, failed, or
  replayable.
- Upstream retry behavior can multiply audit rows without providing a stronger
  recovery path.
- Operators cannot safely answer "did this upstream outbox event start work?"
  from the event log alone, because the routing result is not part of the same
  idempotent operation record.
- Downstream work may eventually be created by a later retry, while earlier
  `incoming.*` rows remain as ambiguous partial evidence.

Required fixes:

- Normalize signed ingress into the same `WorkflowInboundEvent*` operation model
  used by authenticated event intake.
- Add a tenant-scoped unique idempotency key for source service + upstream
  outbox id + event name.
- Store routing status, trigger results, WorkItem ids, workflow instance ids,
  last error, and retry/replay state on that operation record.
- Make retries resume or update the existing operation record instead of writing
  a new ambiguous `incoming.*` audit row.
- Add tests for persist-then-fanout failure, repeated upstream retry,
  eventual-success retry, operation visibility, and replay of signed ingress.

### 209. Direct LLM execution records budget after the call instead of enforcing the preflight gate

Evidence:

- The governed Agent Task path calls `prepareLlmBudget(...)` before invoking the
  model, passing the workflow instance, node, AgentRun id, context policy,
  limits, and model overrides.
- `prepareLlmBudget(...)` checks workflow and initiative budgets, blocks or
  fails exhausted/hard-cap runs, clamps token limits to remaining budget, and
  can route budget overruns to a human budget approval request before any LLM
  call is made.
- The Direct LLM executor does not call `prepareLlmBudget(...)` before
  `callProvider(...)`, `runDirectLlmHarness(...)`, or
  `runDirectLlmToolLoop(...)`.
- After the Direct LLM provider returns, the executor calls
  `recordWorkflowLlmUsage(...)` and catches failures by logging
  `WorkflowBudgetUsageRecordFailed`; the Direct LLM node can still complete or
  move to review even if budget usage persistence failed.
- Direct LLM config validation bounds individual values such as `maxTokens` and
  loop turns, but those are static per-node safety bounds, not a live
  workflow/initiative remaining-budget decision.

Impact:

- A workflow or initiative that has already exhausted its approved token/cost
  envelope can still perform direct provider calls, especially through phase or
  tool loops, before the platform records any budget event.
- Budget enforcement is inconsistent: governed Agent Task calls can pause or
  fail before spending, while Direct LLM calls only reconcile spend after the
  fact.
- If the budget ledger write fails, operations can show a successful Direct LLM
  artifact or approval request without the corresponding cost/token evidence.
- This weakens initiative token-budget controls and makes Direct LLM an
  attractive bypass path for expensive verifier or co-work flows.

Required fixes:

- Route Direct LLM execution through `prepareLlmBudget(...)` before any provider
  call, using the same workflow and initiative budget policy as Agent Task.
- Convert the budget decision into Direct LLM behavior: fail for hard caps,
  pause with `BUDGET_APPROVAL_REQUIRED` for approval-required budgets, clamp
  prompt/output limits, and apply economy-model aliases when configured.
- Pass the clamped limits into single-call, phase-loop, and read-only tool-loop
  execution so multi-turn Direct LLM cannot exceed the remaining envelope.
- Make budget usage persistence failure visible as a recoverable blocked state
  or durable outbox item instead of a catch-and-log side effect.
- Add tests for exhausted workflow budget, exhausted initiative budget, warning
  clamp, economy model override, loop turn budget, and budget-ledger write
  failure on Direct LLM nodes.

### 210. Generation plan apply lacks a durable plan-level evidence event

Evidence:

- `POST /generation-plans/:planId/apply` creates WorkItems, optional
  specification bindings, DevelopmentScopes, HandoffGenerations, capacity
  allocations, WorkItem dependency rows, and updates `GenerationPlanRow.state`.
- The route catches each row failure and stores `state = FAILED` plus
  `error = String(error)`, then continues applying the remaining rows.
- At the end, it updates the plan `status` and increments `appliedRows`, then
  returns JSON to the caller.
- Searches found no `logEvent(...)`, `publishOutbox(...)`, or explicit
  `GenerationPlanApplied`, `GenerationPlanApplyFailed`,
  `GenerationPlanRowApplied`, or `GenerationPlanRowFailed` event in this apply
  route.
- Nearby related paths do emit audit events: actuals writes log
  `GenerationPlanActualsRecorded`, amendment creation logs
  `GenerationPlanAmendmentProposed`, and amendment transitions log
  `GenerationPlanAmendmentTransitioned`.

Impact:

- Applying a generation plan is the bridge from approved specification intent to
  executable WorkItems, but the bridge has no durable first-class event that
  says who applied it, what rows succeeded, what rows failed, which WorkItems
  were produced, and which dependencies/allocations were created.
- Row failures become local row state, not an operator-visible event stream or
  retryable outbox item.
- Evidence packs and Operations timelines must infer generation behavior from
  downstream WorkItems and row state, which is weaker than a single authoritative
  apply receipt.
- If the HTTP response is lost after partial success, operators cannot
  reconstruct the apply attempt cleanly from audit/outbox data alone.

Required fixes:

- Add a durable `GenerationPlanApplyCommand` or apply-attempt record with actor,
  tenant, request hash, plan content hash, validation snapshot id, started/completed
  timestamps, row results, produced WorkItem ids, dependency ids, allocation ids,
  and terminal status.
- Emit `GenerationPlanApplyStarted`, `GenerationPlanRowApplied`,
  `GenerationPlanRowFailed`, and `GenerationPlanApplyCompleted/Failed` audit and
  outbox events.
- Link each generated WorkItem, binding, scope, handoff, dependency, and capacity
  allocation back to the apply attempt id.
- Make row failure retry operate from the apply attempt/command record rather
  than only from mutable row state.
- Add tests proving successful apply, partial apply, all-row failure, lost HTTP
  response retry, and dependency/allocation side effects are all reconstructable
  from audit and outbox evidence.

### 211. Governance Gate controls can be marked satisfied from node config

Evidence:

- `GovernanceGateExecutor.ts` collects satisfied controls from run context keys
  such as `_satisfiedEvidence` / `_governanceEvidence`.
- The same helper also adds every value from node config
  `preSatisfiedControls` directly into the satisfied-control set.
- The rich WorkGraph node inspector exposes `preSatisfiedControls` as a normal
  Governance Gate field with the placeholder "comma-separated controlKeys
  (optional)".
- The resolved gate output reports `satisfied: [...satisfied]` and evidence refs
  from check status, so pre-satisfied controls can appear in the same satisfied
  list as controls proven by artifact, receipt, evaluator, formal, diff,
  evidence-pack, predicate, or standard bindings.
- Searches found no save-time validation that restricts `preSatisfiedControls`
  to migrations, test fixtures, platform-authored templates, or signed overlay
  data.

Impact:

- A workflow author who can edit node config can bypass a hard gate by listing
  required control keys as pre-satisfied instead of producing the required
  evidence.
- This undermines the governance promise that release gates check documents,
  artifacts, code diffs, standards, or formal evidence before progress.
- Audit readers may see a control in the satisfied list without a durable
  receipt/evaluator/artifact/formal proof explaining who satisfied it and why it
  should be trusted.
- Capability-owned governance overlays are weakened because local workflow
  config can satisfy overlay-required controls unless additional policy forbids
  the field.

Required fixes:

- Remove `preSatisfiedControls` from the normal node editor and reject it in
  production workflow saves unless the template is platform-seeded or signed by
  a trusted migration.
- If historical pre-satisfied controls are needed, model them as explicit
  `GovernanceControlAttestation` records with actor, tenant, capability,
  reason, expiry, evidence reference, and approval decision id.
- Make gate output distinguish proven, waived, manually attested, and
  config-preseeded controls instead of merging them all into `satisfied`.
- Add validation tests proving a normal workflow designer cannot publish a hard
  Governance Gate with `preSatisfiedControls`, and runtime tests proving overlay
  controls require real evidence or approved waivers.

### 212. Empty Governance Gate nodes pass as skipped instead of failing configuration

Evidence:

- Platform guidance says a Governance Gate checks documents, artifacts, code,
  standards, or combinations before allowing progress, and warns: "A gate
  without inputs can only report configuration failure."
- Runtime behavior differs: when the node has no governing capability and no
  local controls, `activateGovernanceGate(...)` emits `status: SKIPPED` with the
  note `no governing capability configured`, then returns `{ passed: true }`.
- This branch is reached before overlay resolution, evidence binding, artifact
  checks, formal verification, manual approval, or hard-block evaluation.
- The WorkGraph inspector makes governing capability and control inputs editable
  but not required fields, so a designer can accidentally leave a Governance
  Gate empty.

Impact:

- A workflow can visually contain a release/governance gate while the runtime
  treats it as a no-op success.
- Operators may assume a stage was gated because the graph includes a Governance
  Gate node, while the receipt only says `SKIPPED` and downstream execution has
  already continued.
- This is especially risky for generated or template-based workflows where a
  missing capability id, missing local controls, or failed parameter capture can
  silently remove the intended gate.

Required fixes:

- Treat an empty Governance Gate as a configuration error in `HARD_BLOCK`,
  `AUTOMATIC`, and `MANUAL_REVIEW` modes; it should block before downstream
  execution and report the missing capability/control inputs.
- Add design-time validation that requires at least one governing capability,
  local control, required artifact, formal verifier, diff validation, standard,
  predicate, or evidence-pack binding.
- Allow an explicit `disabled` or `advisoryNoop` field only for deliberate
  no-op gates, and make that state visually distinct in designer and run
  cockpit.
- Add tests for empty hard/manual/automatic gates, missing capability from
  launch parameters, and valid local-only controls.

### 213. Top-level Workbench Neo launch is ambiguous for multi-Workbench runs

Evidence:

- The unified run page renders a top-level `Workbench Neo` action with
  `workbenchNeoUrl({ workflowInstanceId: id, browserRunId: id })`; it does not
  pass `workflowNodeId`, phase, rendered workbench config, source, capability, or
  agent bindings.
- The Platform Web launch helper can include `workflowNodeId`, `phaseId`, goal,
  source, capability, agent template ids, gate mode, and loop definition, but it
  only serializes fields supplied by the caller.
- In the Workbench app, `hydrateDefaultsFromWorkflow(...)` uses the requested
  node when `workflowNodeId` is present, otherwise it falls back to
  `instance.nodes?.find(node => asRecord(node.config?.workbench))`, i.e. the
  first Workbench-configured node.
- Session matching has the same wildcard behavior:
  `!defaults.workflowNodeId || session.workflowNodeId === defaults.workflowNodeId`.
  If the URL omits `workflowNodeId`, any same-run Workbench session can match.
- The stage-level WorkGraph run cockpit already has the safer pattern:
  `RunGraphView` builds a Workbench URL with the node id and rendered node
  workbench config via `buildWorkbenchLaunchUrl(instanceId, node.id, ...)`.

Impact:

- A workflow with more than one Workbench/Copilot stage can open the wrong
  Workbench stage from the run page's top-level button.
- Session reuse can attach the operator to an unrelated same-run Workbench
  session because node identity is optional in matching.
- Human review, artifact editing, or approval from the wrong stage creates a
  serious usability and governance risk: the UI looks run-scoped, but the action
  is actually stage-scoped.

Required fixes:

- Replace the generic top-level `Workbench Neo` link with an active-stage
  selector that resolves the current pending/active Workbench node and includes
  `workflowNodeId` plus rendered node config in the URL.
- If multiple Workbench nodes are valid candidates, show a stage picker instead
  of falling back to the first node.
- Make the Workbench app refuse ambiguous workflow-scoped launches when multiple
  Workbench-configured nodes exist and no `workflowNodeId` is supplied.
- Include the stage/node label in the launch payload and session match UI so
  operators can verify which stage they are reviewing.
- Add browser tests for single-node launch, multi-node launch, ambiguous launch
  refusal, and stale same-run session isolation.

### 214. Workbench finalization messages can fall back to wildcard target origin

Evidence:

- `notifyWorkflowFinalized(...)` sends a large `blueprintWorkbench.finalized`
  payload containing the session id, workflow instance id, browser run id,
  workflow node id, final pack, consumable ids, stage consumables, artifacts, and
  grouped Workbench documents.
- When the Workbench is embedded in a parent, the target origin is:
  `window.location.origin === WORKBENCH_ORIGIN ? WORKGRAPH_WEB_ORIGIN : '*'`.
  A split-origin or misconfigured `VITE_BLUEPRINT_WORKBENCH_ORIGIN` therefore
  broadcasts the finalization payload to whatever parent embedded the Workbench.
- The code already has `isAllowedWorkbenchHostOrigin(...)` for incoming auth
  messages and sends opener finalization messages to `WORKGRAPH_WEB_ORIGIN`;
  only the parent finalization path keeps a wildcard fallback.
- Host pages such as `WorkDetailPage` check message origin before consuming
  finalization events, but that protects the host; it does not prevent the
  Workbench from disclosing its artifact/final-pack payload to an unintended
  embedding parent.

Impact:

- Final packs, artifact metadata, document contents, consumable ids, and run
  correlation data can be exposed to the wrong parent window in a split-origin or
  misconfigured deployment.
- The risk is deployment-sensitive, which makes it brittle: local single-origin
  testing passes while cloud or embedded deployments can silently widen the
  message target.
- This weakens the Workbench as an enterprise review surface because completion
  evidence can leave the trusted shell without an explicit origin allowlist.

Required fixes:

- Remove the wildcard target for finalization messages; fail closed when the
  configured Workbench origin does not match the actual origin.
- Require an explicit allowed host origin list for split-origin Workbench
  deployments and validate it at startup/build time.
- Send only a minimal finalization signal across `postMessage`; let the host
  fetch final packs and documents through authorized APIs after validating the
  event.
- Add tests for same-origin, configured split-origin, misconfigured origin, and
  malicious embedding parent scenarios.

### 215. Event Emit nodes can bypass the governed event subscription boundary

Evidence:

- The guarded EventSubscription path is administrator-only, validates target URLs
  with `assertEventTargetUrlAllowed(...)`, encrypts subscription HMAC secrets, and
  revalidates target URLs again in the dispatcher before `fetch(...)`.
- The `EVENT_EMIT` workflow node is a separate runtime path. Its editor exposes
  transport, Kafka brokers, SQS queue URL, SNS topic ARN, AWS region, AMQP URL,
  exchange, and routing key as normal node configuration fields.
- The executor sends directly to Kafka/SQS/SNS/AMQP from node config:
  `emitKafka(...)` uses `cfgString(node, 'brokers')`, `emitSqs(...)` uses
  `cfgString(node, 'queueUrl')`, `emitSns(...)` uses `cfgString(node,
  'topicArn')`, and `emitAmqp(...)` uses `cfgString(node, 'url') ??
  process.env.AMQP_URL`.
- If `payloadPath` is blank, `activateEventEmit(...)` sends the whole workflow
  context as the event body.
- The executor does syntax/presence checks for required routing fields, but it
  does not resolve a registered event connection/subscription, enforce an
  allowlist, apply SSRF/private-network controls to AMQP/Kafka hosts, or require
  explicit payload projection before external emission.

Impact:

- A workflow template editor can create a node that sends arbitrary run context
  to an external broker without going through the governed subscription registry.
- The platform has two event-delivery policy surfaces: a hardened subscription
  path and a direct node path with broader routing authority.
- Blank `payloadPath` makes accidental data exfiltration easy because the entire
  workflow context can include prompt snippets, event payloads, repository
  details, artifacts, and derived secrets/handles.
- Enterprise operators cannot centrally answer "where can this workflow emit
  events?" from registered subscriptions alone.

Required fixes:

- Make external `EVENT_EMIT` transports reference registered, tenant-scoped event
  bus connections rather than raw broker URLs/ARNs/broker lists in node config.
- Restrict raw external transport fields to local debug mode; production should
  fail closed unless the connection id resolves to an approved destination.
- Require `payloadPath` or a visual payload mapping for all external transports;
  do not allow whole-context emission by default.
- Apply destination policy checks equivalent to EventSubscription target guards
  for AMQP/Kafka hosts and account/ARN allowlists for SQS/SNS.
- Add workflow-design validation and runtime tests proving external Event Emit
  nodes cannot publish to unregistered destinations or emit whole context in
  production mode.

### 216. Live workflow signals can wake unrelated same-tenant runs

Evidence:

- `SignalEmitExecutor.ts` still describes `SIGNAL_EMIT` as broadcasting a named
  signal "across all workflow instances."
- The durable signal store is instance-scoped: `persistSignal(...)` writes
  `instanceId`, and `consumePendingSignal(...)` queries by the same `instanceId`.
- Live delivery behaves differently. `activateSignalEmit(...)` queries all active
  `SIGNAL_WAIT` nodes in the tenant with `where: { nodeType: 'SIGNAL_WAIT',
  status: 'ACTIVE' }`; it does not filter by the emitting workflow instance.
- Correlation is permissive: if the emitter has `correlationKey` but the waiting
  node has none, the wait still receives the signal because the mismatch check
  only runs when both sides set a key.
- The UI copy in `NodeInspector` reinforces this behavior: "Wakes any
  SIGNAL_WAIT node across all workflow instances that is listening for the same
  signal name."

Impact:

- Two same-tenant workflow runs using common signal names such as `approved`,
  `done`, `ready`, or `review_complete` can wake each other.
- The durable and live semantics differ: a waiter activated later only sees
  same-instance persisted signals, while an already-active waiter can be woken by
  another run.
- A missing correlation key on either side turns a signal into a tenant-wide
  broadcast, which is dangerous for human approvals, external callbacks, and
  generated SDLC workflow templates.
- Debugging is hard because the wake-up may look like a valid signal event, not a
  cross-run collision.

Required fixes:

- Make live `SIGNAL_EMIT` instance-scoped by default, matching durable signal
  semantics.
- Add an explicit cross-instance signal mode with a required namespace,
  correlation key, authorization check, and audit event if tenant-wide signaling
  is truly needed.
- Require both emitter and waiter correlation keys for cross-instance delivery;
  missing correlation should fail validation rather than widen delivery.
- Add design-time warnings for common/unqualified signal names and runtime
  receipts that record the emitting instance, receiving instance, correlation
  policy, and delivery mode.
- Add tests for two active runs with the same signal name, missing correlation,
  mismatched correlation, same-instance live delivery, and persisted pre-wait
  delivery.

### 217. Durable workflow signals fail open when persistence fails

Evidence:

- The Prisma schema describes `WorkflowSignal` as the durable store for
  emit-before-wait correctness: "An emitted signal is persisted here so a
  SIGNAL_WAIT that parks AFTER the emit can still consume it."
- `persistSignal(...)` catches all persistence errors and returns `null` with the
  comment "Durability is best-effort -- a failure here must not break live
  delivery."
- `activateSignalEmit(...)` persists before live delivery, but if persistence
  fails and there is no active same-instance waiter, nothing records the signal
  for a later `SIGNAL_WAIT`.
- `WorkflowRuntime` always advances the `SIGNAL_EMIT` node after
  `activateSignalEmit(...)` returns; the emit path has no output or error state
  that tells the run the durable signal was lost.

Impact:

- The platform advertises durable signal semantics, but an infrastructure,
  tenant-context, migration, or database error can silently downgrade the signal
  to live-only delivery.
- A workflow branch can emit a signal, advance successfully, and later leave a
  downstream wait node parked forever because the signal was never persisted.
- Operators will see the emitter as complete and have no receipt explaining why
  the later wait did not resume.
- This undercuts event-driven workflow reliability, especially for parallel
  branch coordination, external callbacks, and replay/debug scenarios.

Required fixes:

- Treat signal persistence failure as a node failure for workflows that depend on
  durable signaling, or add an explicit `durabilityMode: live_only |
  durable_required` with `durable_required` as the enterprise default.
- Return persistence status from `activateSignalEmit(...)` and record it in the
  node output/receipt.
- Add retry/dead-letter behavior for failed signal persistence instead of
  swallowing the error.
- Add a stuck-run sweep that can identify `SIGNAL_WAIT` nodes whose matching
  emitter completed without a persisted signal.
- Add tests for database write failure, tenant transaction failure, emit before
  wait with persistence success, and emit before wait with persistence failure.

### 218. WorkItem IAM permissions enforced by WorkGraph are missing from the default IAM catalog

Evidence:

- WorkGraph's `assertCanMutateWorkItem(...)` maps WorkItem actions to dedicated
  IAM permission keys: `workflow:cancel`, `workflow:finalize`,
  `workflow:submit`, `workflow:reconcile`, and `workflow:approve`.
- Contract-bound routes use those actions directly: finalize calls
  `assertCanMutateWorkItem(..., 'finalize')`, submissions use `'submit'`,
  reconciliation uses `'reconcile'`, start uses `'start'`, and cancel paths use
  `'cancel'`.
- The IAM service default permission catalog includes workflow create/view/update,
  execute, approve, assign, audit, template, operations, event, and runtime
  permissions, but does not include `workflow:cancel`, `workflow:finalize`,
  `workflow:submit`, or `workflow:reconcile`.
- The IAM default roles also omit those keys. Capability admins get
  `workflow:update`, `workflow:execute`, `workflow:assign`, and
  `workflow:approve`, but not the WorkItem-specific permissions that WorkGraph
  now checks.
- The WorkGraph local Prisma seed only creates `workflow:approve` plus unrelated
  approval permissions; it also does not seed the WorkItem-specific keys.
- IAM authorization checks exact permission strings, or `platform:all`; an
  unknown/missing permission key is not equivalent to `workflow:update`.

Impact:

- Enterprise users with normal seeded roles can be blocked from WorkItem
  submission, reconciliation, cancellation, or finalization even though the UI
  and route layer now expose those actions.
- Teams may "fix" the blockage by giving users broad `platform:all` or
  `workflow:update`, which defeats the new explicit WorkItem action model.
- Fresh-clone and bare-metal demos can fail unpredictably when WorkGraph asks IAM
  for permissions that the IAM seed never created.
- Access reviews and the Identity permission catalog will not show the full set
  of permissions required to operate contract-bound WorkItems.

Required fixes:

- Add `workflow:cancel`, `workflow:finalize`, `workflow:submit`, and
  `workflow:reconcile` to the IAM default permission catalog and migration/seed
  scripts.
- Assign the keys intentionally to seeded roles: e.g. executor can submit,
  verifier/reconciler can reconcile, approver/finalizer can finalize, and
  operator/admin can cancel.
- Update WorkGraph local seed and any docs/UI permission catalogs to include the
  same keys.
- Add startup/readiness checks that compare WorkGraph's hard-coded permission
  vocabulary against IAM's advertised permission catalog.
- Add tests proving a seeded non-super-admin can complete the intended WorkItem
  lifecycle without `platform:all`, and that users lacking each specific key are
  denied only that action.

### 219. WorkItem detail and contract-bound reads bypass the tenant-scoped DB context

Evidence:

- The RLS scaffold explicitly says enabling RLS must happen only after
  request-scoped DB transactions set `app.tenant_id` with `SET LOCAL` for all
  tenant-sensitive query paths.
- `tenantDbContextMiddleware` only stores tenant and trace metadata in
  `AsyncLocalStorage`; the code that actually calls `set_config('app.tenant_id',
  ...)` lives in `withTenantDbTransaction(...)`.
- The WorkItem-family RLS migration enables and forces row-level security on
  `work_items`, `work_item_targets`, `work_item_events`,
  `work_item_clarifications`, `work_item_routing_policies`,
  `work_item_triggers`, and `workflow_triggers`.
- Despite that, key WorkItem APIs still use plain Prisma reads outside
  `withTenantDbTransaction`: `GET /work-items/:id` loads by id with targets,
  events, clarifications, project, and completion program; `cancel` and approval
  routes load WorkItems directly; `loadAuthorizedWorkItem(...)` and
  `updateWorkItem(...)` also call `prisma.workItem.findUnique(...)` directly.
- The contract-bound router repeats the pattern: `loadVisibleWorkItem(...)` uses
  `prisma.workItem.findUnique(...)`, then specification bindings, development
  scopes, handoffs, submissions, reconciliation, finalization, and workflow start
  command routes use that helper before querying more contract-bound records.
- `canViewWorkItem(...)` grants view immediately when `createdById`,
  `approvedById`, or any target `claimedById` equals the local WorkGraph user id;
  those shortcuts do not first prove tenant membership or a capability-scoped IAM
  decision.

Impact:

- In strict RLS deployments, these routes can fail closed or behave
  inconsistently because the forced-RLS tables expect `app.tenant_id` but the
  plain Prisma query never set it.
- In relaxed/default-tenant deployments, direct-id reads can occur before a
  tenant-scoped query boundary, leaving tenant safety to application-side checks
  and local id shortcuts instead of a uniform database invariant.
- The local creator/approver/claimed shortcuts are especially brittle in a
  multi-tenant system: they can authorize view without proving that the caller is
  still a member of the WorkItem tenant or the target capability.
- Contract-bound evidence APIs can inherit the same problem, exposing or blocking
  bindings, scopes, handoffs, submissions, reconciliation runs, and finalization
  records depending on whether the route happened to enter a tenant-scoped
  transaction.

Required fixes:

- Move all WorkItem detail, mutation preloads, and contract-bound helper reads
  behind a single tenant-scoped loader that uses `withTenantDbTransaction(...)`
  and includes an explicit persisted-row tenant check.
- Prefer `findFirst({ where: { id, tenantId } })` or equivalent row-tenant
  filters for every direct-id WorkItem and contract-bound child lookup, even when
  RLS is expected to protect the query.
- Remove or tighten the creator/approver/claimed view shortcuts so they require
  active tenant membership and a capability/resource decision before returning
  `true`.
- Add tests for strict-RLS WorkItem detail, contract-bound binding/scope/handoff
  reads, direct-id cross-tenant access, same local user id in two tenants, claimed
  targets across tenants, and revoked tenant membership after claim.

### 220. Contract-bound execution tables have tenant columns but no RLS policies

Evidence:

- `20260725000000_contract_bound_work_execution` creates
  `work_item_specification_bindings`, `development_scopes`,
  `handoff_generations`, `work_item_finalization_records`,
  `work_item_creation_commands`, `workflow_start_commands`, `generation_plans`,
  and `generation_plan_rows` with `tenantId` columns and tenant indexes.
- The same migration adds foreign keys and indexes but does not call
  `workgraph_install_tenant_policy(...)`, `ENABLE ROW LEVEL SECURITY`, or
  `FORCE ROW LEVEL SECURITY` for those tables.
- Older contract-bound tables are similar: `implementation_submissions` and
  `reconciliation_runs` have tenant indexes from their migrations, but exact
  searches for those table names show no RLS policy installation or force-RLS
  migration.
- By contrast, the WorkItem-family migration explicitly installs tenant policies
  and forces RLS on `work_items`, `work_item_targets`, `work_item_events`,
  `work_item_clarifications`, `work_item_routing_policies`,
  `work_item_triggers`, and `workflow_triggers`.
- Contract-bound routes query child tables directly by ids such as
  `workItemId`, `scopeId`, `handoffId`, and `submissionId`; some routes rely on
  the parent WorkItem visibility helper before reading child rows, but the
  database does not enforce a tenant predicate on the child tables themselves.

Impact:

- The new "contract-bound work execution" authority is not protected by the same
  tenant-isolation invariant as the core WorkItem rows.
- A missed application-level tenant filter, direct Prisma lookup, reporting query,
  background job, or future route can expose bindings, requirement subsets,
  handoff content, reconciliation evidence, finalization records, and durable
  command state across tenants.
- Production preflight can truthfully verify WorkItem-family forced RLS while the
  actual contract-bound proof chain remains outside forced RLS.
- This weakens audit/compliance claims because the records that prove the exact
  specification, scope, handoff, submission, reconciliation, and finalization are
  less isolated than the WorkItem shell.

Required fixes:

- Add an RLS migration for every contract-bound table with a `tenantId` column:
  bindings, scopes, handoffs, finalization records, creation commands, start
  commands, generation plans, generation plan rows, submissions, reconciliation
  runs, and their evidence/job child tables where applicable.
- Backfill and make `tenantId` non-null for these tables before forcing RLS.
- Add database policies using `workgraph_current_tenant_id()` plus relationship
  policies only where a table is intentionally instance/work-item scoped.
- Extend production preflight to enumerate all tenant-bearing tables and fail if
  any required table lacks RLS, force-RLS, or an approved exemption.
- Add cross-tenant tests that directly query child table ids for bindings,
  scopes, handoffs, submissions, reconciliation runs, finalization records, and
  command rows.

### 221. WorkItem command idempotency keys are globally unique instead of tenant-scoped

Evidence:

- `WorkItemCreationCommand.idempotencyKey` and
  `WorkflowStartCommand.idempotencyKey` are both declared `@unique` in the Prisma
  schema, while each model also has a separate `tenantId` column.
- The contract-bound migration creates global unique indexes:
  `work_item_creation_commands_idempotencyKey_key` and
  `workflow_start_commands_idempotencyKey_key`; it does not create composite
  `(tenantId, idempotencyKey)` uniqueness.
- `createWorkItem(...)` resolves existing command state with
  `prisma.workItemCreationCommand.findUnique({ where: { idempotencyKey } })`
  and later updates by `{ idempotencyKey }`, not by tenant plus key.
- `startWorkItemTarget(...)` does the same for workflow starts:
  `prisma.workflowStartCommand.findUnique({ where: { idempotencyKey } })` and
  later updates/reuses command state by key alone.
- The WorkItem creation `requestHash` includes `tenantId`, so a same idempotency
  key reused by another tenant will usually be treated as a conflicting request.
  The workflow-start `requestHash` does not include tenant, and its command lookup
  is still global.

Impact:

- A client, integration, or malicious tenant can accidentally or deliberately
  reserve an idempotency key that blocks another tenant's WorkItem create or
  workflow-start retry.
- Support cannot safely tell users "reuse the same idempotency key for retries"
  unless keys are globally coordinated, which is not how tenant-local API clients
  normally behave.
- Global command keys leak cross-tenant existence through conflict behavior: a
  tenant can learn that a key is already in use even though the command row
  belongs to another tenant.
- Command recovery, replay, and Operations views become harder because the command
  natural key does not include the tenant boundary while the business object does.

Required fixes:

- Replace global command idempotency uniqueness with composite uniqueness on
  `(tenantId, idempotencyKey)` for WorkItem creation and workflow start commands.
- Change every command lookup/update to include the authoritative tenant id, and
  reject missing tenant context in strict mode before reading command state.
- Include tenant id in the workflow-start request hash and in command receipts so
  retries can prove they are tenant-local.
- Add migration/backfill logic for existing command rows, including conflict
  handling if historical global keys collide across tenants.
- Add tests where tenant A and tenant B intentionally reuse the same
  idempotency key for WorkItem creation and workflow start; both should succeed or
  conflict only within their own tenant.

### 222. Approval decisions and escalations are outside the tenant RLS boundary

Evidence:

- `ApprovalRequest` has a `tenantId` column and the forced-RLS migration enables
  and forces row-level security on `approval_requests`.
- `ApprovalDecision` has `requestId`, `decidedById`, decision, notes,
  conditions, and `decidedAt`, but no `tenantId` column or tenant index.
- `ApprovalEscalation` similarly has `requestId`, escalation level, target
  user/team/role/skill fields, and reason, but no `tenantId` column or tenant
  index.
- Searches across migrations show RLS policy installation and force-RLS for
  `approval_requests`, but not for `approval_decisions` or
  `approval_escalations`.
- Approval routes generally read decisions through a request after
  `assertApprovalRequestTenant(...)`, but other services also query
  `approvalDecision` directly by `requestId` for governance, specification review,
  receipts, and sponsor readouts.

Impact:

- Approval votes, notes, conditions, escalation targets, and reviewer identities
  are tenant-sensitive evidence, yet the database does not enforce tenant
  isolation on those child rows.
- A future report, receipt, governance check, or maintenance job that queries
  approval decisions/escalations directly can bypass the RLS boundary that protects
  the parent request.
- Production preflight can show approval request RLS as healthy while the actual
  vote/escalation evidence remains protected only by application query discipline.
- This weakens enterprise separation-of-duty evidence because the rows proving who
  decided what are less isolated than the approval request itself.

Required fixes:

- Add `tenantId` to `approval_decisions` and `approval_escalations`, backfilled
  from the parent `approval_requests.tenantId`, and make it non-null after
  historical cleanup.
- Install and force RLS policies on both child tables, using direct `tenantId` or
  a parent-request visibility predicate.
- Update every approval decision/escalation writer to pass the parent request
  tenant explicitly and reject mismatches.
- Add production preflight coverage for approval child-table RLS, not only
  `approval_requests`.
- Add tests for direct decision/escalation id queries, sponsor readout lookup,
  governance waiver decisions, receipt assembly, and cross-tenant request-id
  collisions.

### 223. Governance waivers and overlay snapshots are not tenant-scoped records

Evidence:

- `GovernanceOverlaySnapshot` stores `workItemId`, `workflowInstanceId`,
  `workflowNodeId`, `governedCapabilityId`, `overlayHash`, and the full
  `resolvedOverlayJson`, but it has no `tenantId` column, tenant index, or RLS
  policy.
- `GovernanceWaiver` stores `workItemId`, `workflowInstanceId`, `workflowNodeId`,
  `controlKey`, reason, status, requester/approver, expiry, and revocation
  fields, but it also has no `tenantId` column, tenant index, or RLS policy.
- The migrations that create `governance_overlay_snapshots` and
  `governance_waivers` add only work-item/run/control indexes; the later roadmap
  migration adds waiver revocation columns but still does not add tenant
  ownership.
- `enrichStageRequestWithGovernance(...)` writes overlay snapshots by
  `workItemId`, `workflowNodeId`, and `overlayHash` through plain Prisma, and
  `GovernanceGateExecutor.snapshotOverlay(...)` repeats that idempotent lookup and
  create pattern.
- `activeWaiverControlKeys(...)` returns approved, unexpired waiver control keys
  by `workItemId`; `GovernanceGateExecutor.nodeScopedWaiverKeys(...)` queries
  approved waivers by `workflowNodeId`; those waiver keys can mark controls as
  `WAIVED` in the gate output.
- Governance router listing and snapshot routes query snapshot/waiver tables by
  work item, run, or node identifiers, not by a persisted tenant column on the
  governance evidence rows themselves.

Impact:

- The records that say which capability governance overlay was applied, and which
  controls were waived, are not isolated by tenant at the database layer.
- A direct-id bug, reporting query, stuck-run sweep, or future route can read or
  reuse governance evidence across tenants because the rows themselves do not
  carry tenant ownership.
- Waiver lookup is especially sensitive: an approved waiver control key can turn a
  blocking governance control into `WAIVED`; without tenant-scoped rows, the
  safety of that decision depends on every caller always passing the right parent
  id and tenant context.
- Enterprise evidence packs cannot prove a governance overlay or waiver belonged
  to the tenant/run at the time of enforcement from the row alone.

Required fixes:

- Add non-null `tenantId` to `governance_overlay_snapshots` and
  `governance_waivers`, backfilled from the related WorkItem or WorkflowInstance.
- Change unique keys and lookup predicates to include tenant id, e.g.
  `(tenantId, workItemId, workflowNodeId, overlayHash)` for snapshots and
  tenant-scoped waiver lookups.
- Install and force RLS policies on both governance evidence tables.
- Make every snapshot/waiver writer pass the authoritative tenant and reject
  mismatches between WorkItem, workflow instance, and node.
- Add tests for cross-tenant waiver ids, same node id/control key in separate
  tenants, overlay snapshot reuse, waived hard gates, and evidence-pack
  generation.

### 224. IAM-mirrored users can inherit stale local workflow grants by email

Evidence:

- WorkGraph IAM authentication lazily mirrors the IAM user into the local
  `users` table. If no row exists for `iamUserId`, `mirrorIamUser(...)` falls
  back to `findUnique({ where: { email: iamUser.email } })` and attaches the
  incoming `iamUserId` to that existing local user.
- That email-link path updates `iamUserId` and `displayName`, then reconciles only
  the IAM-sourced admin role. It does not clear local `UserRole` rows, local
  `teamId`, existing `TeamMember` rows, workflow creator ownership, or other
  local grants tied to the reused WorkGraph user id.
- Team mirroring adds IAM team memberships and updates the primary `user.teamId`
  when IAM teams are present, but when IAM team lookup returns no teams or fails
  it does not remove stale local team memberships or reset an old local `teamId`.
- Workflow resource grants are evaluated before IAM capability checks:
  `actorGrantSubjects(...)` builds local `USER:<workgraph-id>`,
  `TEAM:<local-team-id>`, and `ROLE:<local-role-id>` subjects, and
  `grantMatches(...)` allows matching `WorkflowAccessGrant` rows for those
  subjects.
- The workflow access-grant API accepts `USER`, `IAM_USER`, `TEAM`, `ROLE`, and
  `CAPABILITY` subjects and stores only `subjectType` / `subjectId`; it does not
  record whether a local user/team/role subject was IAM-mirrored, legacy-local, or
  still active in IAM.

Impact:

- Switching a deployment from local users to IAM, or reusing an email address,
  can cause an IAM-authenticated user to inherit stale local workflow ownership,
  team grants, role grants, or explicit workflow access grants that IAM did not
  issue.
- A hardened IAM `/authz/check` decision can be bypassed for workflow resource
  grants because WorkGraph may return `resource_grant` before consulting IAM for
  the capability permission.
- IAM team revocation is not enough if stale local `TeamMember` rows or `teamId`
  remain in WorkGraph and existing workflow grants target those local teams.
- Enterprise audits cannot prove whether a workflow allow came from current IAM
  membership or from a historical local WorkGraph identity artifact.

Required fixes:

- In `AUTH_PROVIDER=iam`, stop binding IAM users to pre-existing local rows by
  email unless an explicit one-time migration claims that mapping with audit
  evidence and conflict review.
- Mark local identity rows and grants with provenance, then ignore or reject
  local `USER`, `TEAM`, and `ROLE` workflow grants for IAM-authenticated users
  unless the subject is verified against current IAM membership.
- On every IAM login or background sync, reconcile deletions as well as additions:
  remove stale IAM-sourced team memberships and reset primary local team when IAM
  no longer grants it.
- Prefer `IAM_USER` and IAM team/capability subject ids for enterprise workflow
  access grants; require a live IAM authorization check before honoring local
  role/team grants in IAM mode.
- Add migration tests for a local user with workflow grants, then IAM login with
  the same email; revoked IAM team membership; stale local role grant; and
  explicit local `TEAM` / `ROLE` workflow grants in IAM mode.

### 225. Workflow access grants accept arbitrary subjects and action strings

Evidence:

- The workflow access-grant API schema allows `subjectType` values `USER`,
  `IAM_USER`, `TEAM`, `ROLE`, and `CAPABILITY`, but it validates `subjectId` only
  as a non-empty string and `action` only as a free-form string up to 80
  characters.
- `PUT /api/workflows/:id/access` checks only that the caller can edit the
  workflow, loads the workflow tenant, and upserts the grant by
  `(workflowId, subjectType, subjectId, action)`.
- The route does not verify that a `USER` is active, an `IAM_USER` exists and
  belongs to the workflow tenant, a `TEAM` belongs to the tenant, a `ROLE` is a
  valid tenant/platform role, or a `CAPABILITY` is active and owned by the same
  tenant.
- The same route stores arbitrary action text. Runtime evaluation lowercases the
  stored action and treats it as matching only when it equals the requested action
  or `*`, but unsupported action names can still be persisted as apparent policy.
- `WorkflowAccessGrant` has no foreign keys to users, teams, roles, IAM users, or
  capabilities; it stores `subjectType` and `subjectId` as plain strings and
  indexes them for lookup.
- `grantMatches(...)` turns these stored strings into authorization decisions by
  comparing them to local actor subjects and allows matching `ALLOW` grants before
  performing the IAM capability permission check.

Impact:

- Editors can create grants for nonexistent, inactive, cross-tenant, misspelled,
  or stale subjects, and the UI/API will present them as access policy even though
  no live identity authority validated them.
- If a stale local user/team/role later becomes active or is reused, an old grant
  can unexpectedly become effective.
- Free-form action strings create policy drift: operators can think they granted
  or denied a permission while runtime ignores it, or they can accidentally create
  `*` grants without an explicit elevated workflow-access-admin flow.
- Enterprise access reviews cannot distinguish valid IAM-governed grants from
  inert or stale local string grants without manually resolving every subject.

Required fixes:

- Replace free-form `action` with the canonical `WorkflowAction` enum, and make
  wildcard grants a separate privileged operation that requires an explicit
  workflow access administration permission.
- Validate every grant subject against the authoritative tenant source before
  write and before effective-access evaluation: IAM for IAM users/capabilities,
  IAM-mirrored teams/roles where applicable, and local rows only in local-auth
  development mode.
- Store subject provenance, resolved display metadata, and validation status so
  access reviews show whether a grant is live, stale, invalid, or pending
  migration.
- Revalidate grants on IAM sync, tenant membership revocation, team deletion,
  capability archive, and role deletion; suspend or mark invalid grants rather
  than leaving them silently matchable.
- Add tests for nonexistent subjects, cross-tenant subjects, archived
  capabilities, deleted teams/roles, wildcard grants, typo actions, deny
  precedence, and later subject id reuse.

### 226. Contract-bound WorkItem evidence can be mutated after lifecycle lock

Evidence:

- The normal `updateWorkItem(...)` path explicitly limits edits to
  `SCHEDULED`, `QUEUED`, and `IN_PROGRESS`, rejects terminal states such as
  `AWAITING_PARENT_APPROVAL`, `COMPLETED`, `CANCELLED`, and `ARCHIVED`, and blocks
  detail edits when `detailsLocked` is true.
- Contract-bound routes use a separate path. `loadVisibleWorkItem(...)` loads the
  WorkItem with targets and checks view access, but it does not enforce
  `status`, `detailsLocked`, `finalizationGeneration`, or target lifecycle state.
- `POST /work-items/:workItemId/specification-bindings` calls only
  `assertCanMutateWorkItem(..., 'edit')`, then supersedes the current binding and
  creates a new `WorkItemSpecificationBinding`.
- `POST /work-items/:workItemId/development-scopes` likewise checks only edit
  permission before creating a `DevelopmentScope`.
- `POST /development-scopes/:scopeId/handoffs` and
  `POST /handoffs/:handoffId/publish` check only WorkItem edit permission before
  creating a new handoff, superseding any published handoff, and replacing
  `DevelopmentScope.currentHandoffGenerationId`.
- `assertCanMutateWorkItem(...)` maps the action to IAM permission and target
  capability checks; it does not reject terminal WorkItem states or locked
  contract/evidence state.

Impact:

- A user with `workflow:update` on the target capability can rewrite the governing
  specification binding, create extra scopes, or replace the current handoff after
  implementation, reconciliation, approval, or even finalization has already
  occurred.
- Finalization records and evidence digests can describe the contract that was
  current at completion, while the live WorkItem contract panels later show a
  different binding/scope/handoff chain.
- Replacing the current handoff after a submission can make previously valid
  submissions and reconciliation runs look stale without an explicit rework,
  cancellation, or generation bump.
- Enterprise auditors cannot rely on the mutable contract-bound endpoints as the
  live source of truth unless every read is pinned to a historical
  finalization/binding/handoff generation.

Required fixes:

- Add a contract mutation guard that rejects binding, scope, handoff creation, and
  handoff publication unless the WorkItem is in an allowed pre-execution state or
  an explicit governed rework/change-request command is active.
- Treat `AWAITING_PARENT_APPROVAL`, `COMPLETED`, `CANCELLED`, and `ARCHIVED` as
  hard stops for contract mutation.
- When changing a binding or publishing a replacement handoff after execution has
  started, require a rework path that increments `finalizationGeneration`, marks
  affected submissions/reconciliation runs stale, cancels/fences child workflow
  runs, and records the approved reason.
- Pin contract-panel reads to either "current mutable draft" or "finalized
  evidence generation" so UI and evidence packs do not mix live state with
  historical proof.
- Add tests for binding/scope/handoff mutation in `QUEUED`, `IN_PROGRESS`,
  `AWAITING_PARENT_APPROVAL`, `COMPLETED`, `CANCELLED`, and after dynamic
  reconciliation has passed.

### 227. Git History Explainer verifies identity but still does not enforce repository grants

Evidence:

- `agent-and-tools/web/src/app/api/git-history/explain/route.ts` now attempts
  caller verification through IAM `/auth/verify` before using the Runtime Bridge,
  but `runtimeIdentity(...)` still returns the first available identity from
  `verifiedCallerIdentity(req)`, `envRuntimeIdentity()`,
  `devRuntimeOverride(body)`, or `singleConnectedRuntimeIdentity()`.
- `runViaRuntimeBridge(...)` builds a Context Fabric tool-run payload with
  `tool_name = "git_history_explain"`, `capability_id =
  "operations.git-history"`, `capability_tags = ["mcp", "tools", "git"]`, and
  `repo_access = true`.
- The route does not call IAM `/authz/check`, the Git broker
  `/repository-grants` API, a capability-owned repository resolver, or any
  repository/path authorization helper before setting `repo_access = true`.
- The route accepts `workspaceId`, `repoPath`, optional source override
  environment/request fields in non-production, and date/path/author filters, but
  those values are only normalized for shape; they are not checked against a
  repository grant for the caller.
- If the Runtime Bridge path fails and `GIT_HISTORY_LOCAL_FALLBACK_ENABLED` is
  true, `runLocalFallback(...)` executes `bin/explain-git-history.py` against the
  Platform Web server checkout and returns the repo path/script metadata without
  a repository-grant check.
- The platform already has a Repository Grants admin surface and client
  (`agent-and-tools/web/src/lib/git/api.ts`) whose stated purpose is authorizing
  Git operations through the broker, but the Git History Explainer route does not
  use it.
- Existing `server-jsonish-routes.contract.test.ts` coverage for Git History
  checks JSON parsing, bounded timeouts, IAM verify timeout usage, and Runtime
  Bridge status timeout usage. It does not assert repository-grant enforcement,
  unauthorized repository denial, path-scope denial, or local-fallback denial.

Impact:

- An authenticated tenant user, env-derived identity, or single connected runtime
  identity can ask the platform to explain Git history for a runtime/server
  workspace without proving that the caller is allowed to read that repository or
  path.
- `repo_access = true` becomes a declaration made by Platform Web rather than the
  result of a repository-access decision, so downstream Runtime Bridge/MCP logic
  may treat the request as already authorized.
- Git history reports can expose commit messages, author names, touched paths,
  generated change summaries, stderr, and local repository/script paths outside
  the intended Git broker authorization model.
- Local fallback is especially risky because it runs inside the Platform Web
  container/process instead of a caller-owned MCP workspace, weakening the
  separation between UI orchestration and source-code access.

Required fixes:

- Resolve the requested source/repository to a platform repository grant before
  any Runtime Bridge or local fallback execution.
- Require a caller-bound authorization decision for `git-history:read` or
  equivalent repository read permission, scoped by tenant, user/service subject,
  capability, repository, ref, and path prefix.
- Treat `repo_access` as an output of that decision, not a static route constant.
- Disable server-local fallback in production-class deployments and require an
  explicit operator permission plus audited reason when it is enabled for local
  debugging.
- Add tests for authorized repository read, missing repository grant, wrong
  tenant, wrong capability, disallowed path, single-runtime/env identity fallback,
  and local fallback.

### 228. Feature flags are global toggles without tenant or policy-scoped access

Evidence:

- `workgraph-studio/apps/api/prisma/schema.prisma` defines `FeatureFlag` with
  `key`, `enabled`, `description`, `updatedById`, and `updatedAt`, but no
  `tenantId`, `scopeType`, `scopeId`, environment, lifecycle status, approval
  state, or rollout metadata.
- `workgraph-studio/apps/api/src/app.ts` mounts
  `/api/admin/feature-flags` behind `authMiddleware` and mounts
  `/api/internal/feature-flags` without `authMiddleware`.
- `feature-flags.router.ts` lets any authenticated caller list/read all feature
  flags whenever `TENANT_ISOLATION_MODE` is not strict. In strict mode it only
  requires `isAdminUser(...)`, not IAM `authz/check` with a tenant-aware
  `feature_flag:view` permission.
- `PUT /api/admin/feature-flags/:key` gates writes with the local
  `isAdminUser(...)` helper and then upserts any dotted key matching
  `KEY_PATTERN`; it does not require a named flag registry, dual approval,
  rollout scope, or production-change reason.
- The internal feature-flag reader accepts either `Authorization: Bearer
  <WORKGRAPH_INTERNAL_TOKEN>` or `X-Service-Token: <WORKGRAPH_INTERNAL_TOKEN>`.
  In strict mode `requireTenantScopedInternalToken(...)` validates the requested
  tenant against `WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS`, but the query still reads
  the same global `feature_flags` table and returns every flag.
- `config.ts` defaults `WORKGRAPH_INTERNAL_TOKEN` to
  `dev-workgraph-internal-token`; production only rejects that local default,
  not the absence of per-service scopes, per-tenant flag claims, or key-specific
  access.
- No searched tests reference `feature-flags`, `FeatureFlag`, or "feature flag",
  so there is no current regression proof for reader permissions, strict
  tenant-scoped reads, unauthorized toggles, internal-token scope, or audit
  completeness.

Impact:

- A feature flag can enable or disable a platform capability globally even when
  only one tenant, capability, environment, or rollout cohort should be affected.
- Non-strict deployments expose global feature-flag names and descriptions to
  any authenticated user, which can reveal hidden/experimental surfaces,
  kill-switch names, or partially deployed capabilities.
- A local-admin mirror or stale local admin grant can toggle feature flags without
  an IAM policy decision tied to tenant, environment, or change-management role.
- Internal service callers receive a full global flag list instead of only the
  keys they are allowed to evaluate, making one leaked internal token a broad
  feature-discovery credential.
- Enterprise operators cannot prove who approved a production toggle, what blast
  radius it had, or which tenant/workflow/run saw a given flag value.

Required fixes:

- Replace global booleans with scoped feature-flag records:
  tenant/environment/scope type, owning capability, rollout cohort, status,
  version, and content digest.
- Add explicit IAM permissions such as `feature_flag:view`,
  `feature_flag:evaluate`, and `feature_flag:toggle`, with stronger production
  requirements for write approval and change reason.
- Make internal evaluation endpoints accept service JWTs with allowed flag keys
  and tenant claims rather than a single shared `WORKGRAPH_INTERNAL_TOKEN`.
- Return only the requested/evaluable flag keys to internal callers, scoped by
  tenant/environment, and fail closed when tenant context is missing in strict
  mode.
- Store immutable audit evidence for every toggle: actor, IAM decision id,
  previous/next version, scope, reason, rollout window, and affected tenants.
- Add tests for non-admin read/write denial, strict tenant filtering,
  internal-token key scoping, unknown flag creation policy, production toggle
  approval, and audit event contents.

### 229. IAM local login records failures but does not enforce lockout, throttling, or MFA

Evidence:

- `singularity-iam-service/app/auth/routes.py` implements `POST
  /auth/local/login` by looking up a local account, verifying the bcrypt hash,
  updating `last_login_at`, minting a bearer JWT, and recording `failed_login`
  or `local_login` audit events.
- The same route records a failed-login audit event for unknown users and bad
  passwords, but it does not increment a failed-attempt counter, update a
  lockout timestamp, call a rate limiter, inspect the caller IP/user agent, or
  deny repeated attempts after a threshold.
- `singularity-iam-service/app/models.py` defines `LocalCredential` with
  `mfa_enabled` and `mfa_secret_ref`, but the login route never reads those
  fields.
- `singularity-iam-service/app/auth/schemas.py` defines `LoginRequest` with only
  `email` and `password`; there is no `totp_code`, recovery code, MFA challenge,
  or step-up decision in the API contract.
- `singularity-iam-service/AUTHENTICATION.md` explicitly documents MFA as
  future wiring: it says the table already has MFA columns, then shows example
  code for how to extend `local_login()` and `LoginRequest`.
- Exact searches under `singularity-iam-service/app` and
  `singularity-iam-service/tests` found no implemented `lockout`, login
  `rate_limit`, `failed_attempt`, `totp_code`, `refresh_token`,
  `token_version`, or session-revocation path for human IAM sessions.

Impact:

- A password-spray or brute-force attack against local IAM accounts is limited
  only by external infrastructure, not by the IAM service itself.
- Operators can see failed-login events after the fact, but the platform does not
  automatically slow, lock, or challenge the attacker.
- Enabling `mfa_enabled` in the database would not actually require a second
  factor at login, so the column can create a false enterprise-readiness signal.
- Stolen browser bearer tokens remain valid until JWT expiry because there is no
  session table, refresh-token rotation, token version, or per-session revocation
  check for normal user tokens.
- Production environments that temporarily use local password login during
  setup, break-glass, or office-laptop testing have weaker controls than the
  Identity UI and documentation imply.

Required fixes:

- Add a local-login protection service that tracks failed attempts by user,
  normalized email, IP/subnet, tenant selector, and device fingerprint, with
  exponential backoff and lockout.
- Extend `LoginRequest` and the UI to support MFA challenge/verification when
  `mfa_enabled` is true; store only secret references in a secrets manager.
- Add recovery-code and break-glass flows that are audited and super-admin
  approved, not ordinary password resets.
- Introduce a server-side user session/token version table so logout, admin
  revocation, password rotation, MFA reset, and tenant removal can invalidate
  existing access tokens before JWT expiry.
- Add production preflight warnings or refusal when `IAM_AUTH_MODE=local` is used
  without lockout/MFA/break-glass policy.
- Add tests for repeated failed login, unknown-user spray, locked-account login,
  successful reset after lockout expiry, MFA-required login, missing/invalid TOTP,
  token revocation after password rotation, and audit event contents.

### 230. OIDC login state and nonce are browser-owned instead of server-bound

Evidence:

- `singularity-iam-service/app/auth/routes.py` exposes `GET
  /auth/oidc/login-url`, generates `state` and `nonce` with
  `secrets.token_urlsafe(24)`, returns both values to the browser, and includes
  them in the provider authorization URL.
- The same IAM service does not persist the generated state or nonce in a
  server-side login-attempt table, signed HttpOnly cookie, cache entry, or
  one-time challenge record.
- `OidcCodeLoginRequest` and `OidcTokenLoginRequest` accept only `code` or
  `id_token` plus optional `nonce`; neither request accepts `state`, so IAM
  cannot verify that the callback corresponds to a server-issued authorization
  request.
- `_login_oidc_id_token(...)` passes the optional nonce to
  `verify_oidc_id_token(...)`. If the caller omits nonce, `assert_oidc_nonce(...)`
  intentionally does nothing because it only compares when `expected_nonce` is
  truthy.
- `agent-and-tools/web/src/components/identity/IdentityLoginPage.tsx` stores the
  OIDC `state` and `nonce` in `localStorage`, and
  `IdentityOidcCallbackPage.tsx` compares callback `state` against that local
  value before sending `{ code, nonce }` to IAM.
- `singularity-iam-service/tests/test_sso_config.py` asserts nonce mismatch
  fails and nonce match passes, but it also asserts that passing `None` for the
  expected nonce is accepted. The tests only verify the authorization URL
  contains a state value; they do not prove server-side state storage,
  one-time-use semantics, expiry, replay denial, or missing-nonce rejection.

Impact:

- IAM relies on the browser to preserve and validate OIDC CSRF/correlation state.
  A different client, script, or compromised same-origin page can call the OIDC
  code-login endpoint without presenting a server-issued state record.
- OIDC nonce becomes optional at the security boundary. If the browser loses
  localStorage state or a custom client skips the login-url step, IAM can still
  exchange and accept an ID token without proving it belongs to a fresh browser
  authorization request.
- Login attempts are not one-time-use or expiry-bound from IAM's perspective, so
  operators cannot audit or revoke a pending OIDC login challenge.
- The implementation is fragile across multiple tabs, private browsing, browser
  storage clearing, or embedded enterprise IdP flows because login correlation
  exists only in local browser storage.
- This weakens SSO enterprise readiness even though token signature, audience,
  issuer, and domain checks are present.

Required fixes:

- Add a server-side OIDC login challenge table or signed HttpOnly cookie storing
  state hash, nonce hash, issuer/client id, redirect URI, expiry, user agent/IP
  fingerprint metadata, tenant hint, consumed-at, and audit trace id.
- Require `state` on `/auth/oidc/code-login`, look up the unconsumed challenge,
  compare nonce against the stored server value, and consume it atomically before
  minting a platform token.
- Make nonce required for code and token login in OIDC mode unless the provider
  is explicitly configured for a tested flow that does not support nonce.
- Reject replayed, expired, missing-state, missing-nonce, mismatched-nonce, and
  wrong-redirect/client/issuer login attempts with audited failure reasons.
- Keep browser localStorage only as a UI convenience, not as the authoritative
  security state.
- Add tests for multi-tab login, missing state, wrong state, expired challenge,
  replayed code-login, missing nonce, wrong nonce, and callback after browser
  storage loss.

### 231. Audit Governance uses one shared service token for all producers and operations

Evidence:

- `audit-governance-service/src/routes-events.ts` defines `SERVICE_TOKEN =
  process.env.AUDIT_GOV_SERVICE_TOKEN ?? ""` and `requireServiceAuth(...)`
  accepts either `Authorization: Bearer <token>` or `X-Service-Token: <token>`.
  It compares only against that one shared string.
- The same middleware does not decode an IAM service JWT, check `kind=service`,
  validate scopes, enforce tenant allowlists, bind allowed source services, or
  attach an authenticated producer identity to the request.
- `eventsRouter.use(requireServiceAuth, rateLimit)` protects audit ingest, but
  `actorKey(...)` derives the rate-limit bucket from request body fields:
  `source_service` and `tenant_id`. A caller with the shared token can therefore
  choose the producer and tenant labels used for ingestion and throttling.
- `ingestOne(...)` stores `source_service`, `actor_id`, `capability_id`, and
  `tenant_id` from the parsed event payload. `AUDIT_GOV_ALLOWED_SOURCE_SERVICES`
  can reject unknown source names, but the code comment says the empty default
  disables the check and that per-service tokens are out of scope.
- `audit-governance-service/src/routes-governance.ts` applies the same
  `requireServiceAuth` to approvals, budget mutation, rate-limit mutation, and
  authz decision routes. The route comments say platform-web and backend
  services all inject `AUDIT_GOV_SERVICE_TOKEN`.
- `audit-governance-service/src/routes-logs.ts` applies the same
  `requireServiceAuth` to operational log ingestion, search, trace timelines,
  alert rules, retention sweeps, export drains, and retry operations.
- `audit-governance-service/src/routes-search.ts` gates audit search with the
  same middleware and lets callers supply optional `tenantId`, `actorId`,
  `traceId`, sources, and capability filters; facets are global over the last 30
  days.
- Existing searched tests cover timing-safe token comparison, bounded ingest
  knobs, redaction, storage, and log operations, but not per-service scopes,
  tenant-claim enforcement, producer/source binding, forged `source_service`,
  forged `tenant_id`, or operation-specific audit-governance permissions.

Impact:

- Any service or proxy that can read the shared audit-governance token can write
  events as any `source_service`, for any `tenant_id`, and can mutate budgets,
  rate limits, approvals, and log operations.
- A compromised producer can poison the audit ledger with another service's
  identity, making forensic timelines and governance evidence less trustworthy.
- Rate limiting can be bypassed or shifted by changing body-level source/tenant
  labels because the bucket is not bound to authenticated producer claims.
- Platform Web's proxy token becomes equivalent to all backend producer powers,
  not just read-only operator search or redacted trace lookup.
- Enterprise tenants cannot prove that an audit event, budget change, approval,
  or log operation came from a producer authorized for that tenant and action.

Required fixes:

- Replace the raw shared token with IAM-signed service JWTs carrying
  `service_name`, allowed route/action scopes, allowed source services, tenant
  allowlists, expiry, key id, and token id.
- Make `requireServiceAuth` verify JWT claims and expose an authenticated
  producer context; reject raw shared tokens in production.
- Derive `source_service` and tenant eligibility from the producer token, not
  from untrusted request body fields; allow body values only when they match the
  token's allowed claims.
- Split scopes for event ingest, audit search, log ingest, log search, budget
  mutate, approval decide/consume, rate-limit mutate, retention sweep, export
  drain, and alert-rule management.
- Filter search/facets/timeline/log results by the caller's tenant and scope,
  with explicit break-glass/auditor scopes for global queries.
- Add tests for producer A attempting to write as producer B, tenant A token
  writing tenant B events, read-only proxy token attempting mutation, forged
  source-service rate-limit bypass, expired/revoked token, global facet denial,
  and successful scoped producer ingestion.

### 232. MCP session-token minting can escalate a scoped static bearer

Evidence:

- `mcp-server/src/app.ts` mounts `app.use("/mcp", bearerAuth)` and then mounts
  `tokensRouter` before the per-route `requireMcpScope(...)` guards.
- `mcp-server/src/mcp/tokens.ts` protects `POST /mcp/tokens` only with
  `requireStaticBearer(...)`, which checks that the presented bearer equals the
  static `MCP_BEARER_TOKEN`.
- The token mint schema accepts caller-supplied `subject`, `origin`, `client`,
  `invocationId`, `agentRunId`, `capabilityId`, `scopes`, and `ttlSeconds`.
  `scopes` is `z.array(z.string()).optional()` with no enum, allowlist,
  maximum length, wildcard rejection, or subset-of-caller validation.
- `mintMcpSessionToken(...)` writes `input.scopes` directly into the token
  claims, defaulting to `["tools:list", "tools:call", "resources:read",
  "events:read"]` when the caller omits scopes.
- `hasMcpSessionScope(...)` treats any session token containing `"*"` as having
  every MCP scope.
- `MCP_STATIC_BEARER_SCOPES` was added so the static bearer is no longer an
  invisible all-scopes credential, but `/mcp/tokens` does not check
  `staticBearerHasScope(...)` or derive the minted scopes from the static
  bearer allowlist.
- `mcp-server/src/lib/http-auth.contract.test.ts` proves a static bearer can
  mint a session token with requested scopes and that the session token can call
  scoped routes, but it does not test that minted scopes are a subset of
  `MCP_STATIC_BEARER_SCOPES`, that `"*"` is rejected, that unknown scopes are
  rejected, or that subject/capability/origin claims are authorized.

Impact:

- An operator may configure `MCP_STATIC_BEARER_SCOPES=resources:read` expecting
  the static bearer to be read-only, but the same bearer can mint a session token
  with `tools:call`, `invoke`, or `"*"`.
- A leaked static bearer can create long-lived session tokens for arbitrary
  subjects, clients, capabilities, and origins, confusing run evidence and
  ownership.
- The scoped-bearer hardening can be bypassed without changing the static bearer
  itself: mint a broader session token, then call the protected route with the
  session token.
- Revocation is only an in-memory `Map` in `session-token.ts`, so minted session
  revocations disappear on MCP restart and cannot be coordinated across shared
  server runtime replicas.
- Enterprise runtime operators cannot prove that a session token's scopes,
  subject, tenant/capability, and client identity were authorized by IAM or
  Context Fabric.

Required fixes:

- Gate `/mcp/tokens` with a dedicated static scope such as
  `tokens:mint`, and refuse minting unless `MCP_STATIC_BEARER_SCOPES` permits
  that action.
- Validate requested session scopes against a fixed MCP scope enum and require
  them to be a subset of the caller's authenticated scopes; reject `"*"` outside
  explicit break-glass/admin mode.
- Do not accept arbitrary `subject`, `origin`, `client`, `capabilityId`, or
  `agentRunId` from the request body unless they are signed by Context Fabric or
  validated against an IAM/runtime enrollment record.
- Add tenant/runtime/capability claims to MCP session tokens and enforce them in
  `requireMcpScope(...)` where route semantics are tenant or workspace sensitive.
- Persist session-token revocation and issuance metadata, or make session tokens
  very short-lived and non-revocable with clear evidence of issuer and scope.
- Add tests for static bearer with only `resources:read` attempting to mint
  `tools:call`, wildcard scope rejection, unknown scope rejection, overlong TTL,
  forged subject/capability, restart revocation behavior, and a valid scoped
  mint through an authorized Context Fabric/runtime issuer.

### 233. LLM Gateway provider spend and catalog writes are protected by one raw bearer

Evidence:

- `context-fabric/services/llm_gateway_service/app/router.py` defines
  `_check_auth(...)` as a single string comparison against
  `settings.gateway_bearer`. If `LLM_GATEWAY_BEARER` is empty, the function
  returns successfully and auth is disabled.
- The same `_check_auth(...)` protects `/llm/providers`, `/llm/models`,
  `POST/PUT/DELETE /llm/models`, `POST /v1/chat/completions`, and
  `POST /v1/embeddings`. It does not verify an IAM JWT, service identity,
  tenant allowlist, scopes, caller class, model budget, capability ownership,
  or per-route permission.
- `context-fabric/services/llm_gateway_service/app/config.py` fails closed only
  in production-like environments when real provider credentials exist and the
  bearer is empty. When the bearer is present, it is still one shared raw secret
  for every read, write, chat, and embedding operation.
- `context-fabric/services/llm_gateway_service/app/platform_registry.py`
  advertises the gateway `auth_mode` as `"bearer-static"` or `"none"`, not as an
  IAM-scoped service-token mode.
- `context-fabric/services/llm_gateway_service/app/types.py` exposes
  `trace_id`, `run_id`, and `capability_id` as optional request body fields for
  chat completions and embeddings. The router does not require or validate those
  fields before provider dispatch.
- `context-fabric/services/llm_gateway_service/app/provider_config.py` persists
  model catalog changes to the shared `llm-models.json` file via
  `add_model(...)`, `update_model(...)`, and `delete_model(...)`. The route guard
  for those writes is the same raw bearer used for provider-funded inference.
- Several callers post directly to `/v1/chat/completions` with only
  `content-type` headers in the searched code, including
  `audit-governance-service/src/engine/llm-judge.ts`,
  `audit-governance-service/src/engine/diagnose.ts`, and
  `agent-and-tools/apps/agent-runtime/src/modules/capabilities/bootstrap-phase3-distill.ts`.
  Those calls rely on deployments where the gateway accepts unauthenticated or
  network-local traffic, or they fail when auth is enabled.
- Existing searched gateway tests cover config hardening, provider readiness,
  upstream parsing, retry behavior, prompt-cache handling, and platform
  registration, but not IAM-scoped gateway tokens, tenant-scoped catalog
  mutation, per-model budget enforcement, forbidden capability/run ids, or
  route-specific service permissions.

Impact:

- A leaked `LLM_GATEWAY_BEARER` is equivalent to provider spend authority and
  model catalog administration for the whole gateway.
- Any service holding the gateway bearer for embeddings or provider status can
  also call chat completions, mutate model aliases, change default routing, or
  delete aliases unless additional network controls happen to prevent it.
- Model costs, default aliases, and provider routing are global file state, so
  one caller can change the effective model behavior for unrelated tenants,
  runs, agents, and evidence exports.
- Optional body-level `trace_id`, `run_id`, and `capability_id` cannot prove who
  caused provider spend or which tenant/capability was authorized for the call.
- Services that still call the gateway without a bearer create a deployment
  split-brain: secure gateway mode breaks those features, while permissive mode
  exposes provider-funded endpoints.
- Enterprise budget, tenant isolation, and audit evidence cannot rely on the
  gateway as the final provider-spend control point.

Required fixes:

- Replace `LLM_GATEWAY_BEARER` with IAM-signed service JWTs carrying
  `service_name`, tenant allowlist, allowed routes, allowed model aliases,
  allowed capabilities, expiry, key id, token id, and budget class.
- Split scopes for provider status, model catalog read, model catalog write,
  chat completion, embeddings, provider health, and admin/debug operations.
- Require tenant id, actor/service id, capability id, trace id, and run/workflow
  context for production chat and embedding calls; derive the authoritative
  caller context from the verified token rather than optional body fields.
- Move model catalog writes behind a tenant/platform policy decision and record
  immutable catalog version, actor, tenant, reason, and diff audit events.
- Add per-tenant/per-service/per-model rate limits and budget checks before
  provider dispatch, with fail-closed behavior when budget context is missing.
- Update all direct callers to send scoped gateway tokens or route through the
  governed Context Fabric/MCP path consistently; reject unauthenticated direct
  calls in strict mode.
- Add tests for read-only token attempting chat, embedding-only token attempting
  catalog mutation, tenant A token mutating tenant B/global aliases, missing
  trace/capability in strict mode, over-budget provider dispatch, expired token,
  and legacy no-bearer callers in secure deployments.

### 234. Synthesis workspaces store important artifacts only in browser localStorage

Evidence:

- `agent-and-tools/web/src/components/synthesis/hooks/useLocalWorkspace.ts`
  reads and writes arbitrary workspace state through `window.localStorage` using
  the supplied key. It has no server write-through, revision, author, tenant,
  lock, branch, or audit event.
- `DiagramWorkspaceScreen.tsx` stores React Flow nodes and edges under
  `synthesis:diagram:${projectId}` and offers only a client-side JSON export.
  The diagram is not written to WorkGraph, the specification package, the claim
  evidence graph, or a project artifact record.
- `JourneyMapScreen.tsx` stores journey stages, lanes, and observations under
  `synthesis:journey:${projectId}`. The screen labels the data as the
  initiative journey, but it is scoped to the current browser profile rather
  than the initiative system of record.
- `PseudoCodeStudioScreen.tsx` stores `initiative.logic` under
  `synthesis:pseudocode:${projectId}` and displays "Auto-saved", but the
  auto-save is localStorage only. The validation result is client-side state and
  is not persisted as evidence.
- `FactVotingView.tsx` fetches governed claims from WorkGraph but stores team
  votes under `synthesis:fact-votes:${projectId}`. The UI uses those votes to
  rank facts and summarize supported/contested signals, but the votes are not
  shared, audited, or visible to another user.
- Exact searches found no WorkGraph route or Prisma model for Synthesis diagram,
  journey-map, pseudocode-workspace, or fact-vote persistence. Related
  specification schemas support diagrams and pseudocode, but these Synthesis
  screens do not call those specification APIs.
- The Synthesis shell presents these surfaces as phase-level workspaces:
  Journey Map in Explore and System Diagrams/Pseudocode in Specify, so users see
  them as part of the primary initiative flow rather than throwaway scratchpads.

Impact:

- Two users looking at the same initiative can see different diagrams, journey
  maps, pseudocode, and fact-vote rankings because the state lives in each
  browser.
- Clearing browser storage, changing machines, using an incognito window, or
  opening the platform from a different host loses those artifacts.
- Specification lock, generation-plan validation, impact assessment, evidence
  pack export, and WorkItem creation cannot reliably include these artifacts
  because they are not part of the backend evidence graph.
- "Auto-saved" copy is misleading for enterprise users: it suggests durable
  platform persistence while only saving to local browser storage.
- Local fact votes can change perceived claim support without an auditable
  decision record, reviewer identity, quorum, or tenant/capability guard.

Required fixes:

- Add tenant-scoped WorkGraph records or project artifact records for Synthesis
  diagrams, journey maps, pseudocode modules, and fact votes.
- Reuse the existing specification package diagram/pseudocode schema where these
  artifacts are intended to become locked specification content; otherwise store
  them as draft project artifacts with explicit promotion into the spec package.
- Replace `useLocalWorkspace` persistence with API-backed save/load hooks that
  carry project id, capability id, actor id, revision, branch, and trace id.
- Add optimistic concurrency, autosave status, conflict resolution, and recovery
  for multi-user edits.
- Persist fact votes as governed review signals with voter identity, optional
  role/team eligibility, idempotency key, and audit events; distinguish informal
  signals from formal approvals.
- Change UI copy from "Auto-saved" to "Saved locally" until backend persistence
  is implemented.
- Add tests proving artifacts survive browser reload/storage clear, are visible
  to another authorized user, are denied cross-capability, are included in
  specification/evidence exports only after promotion, and preserve revision
  history.

### 235. Claim Registry has tenant scoping but no action-level claim permissions

Evidence:

- `claim-registry/src/middleware/auth.ts` verifies a bearer token through IAM or
  local HS256, derives `userId`, `tenantId`, and `kind`, and rejects tenant
  headers outside the verified token membership. This gives the service a tenant
  boundary.
- The same middleware exposes only `registryActor` and `requireServicePrincipal`.
  There is no equivalent of `requireClaimPermission(...)`,
  `requireCapabilityMembership(...)`, `requireCuratorRole(...)`, or
  IAM `/authz/check` call for normal claim operations.
- `claim-registry/src/index.ts` mounts all `/api/v1` routes behind
  `registryAuth`, then mounts `claimsRouter`, `knowledgeRouter`,
  `registryRouter`, and `ambiguityRouter` without route-specific permission
  middleware.
- `claims.router.ts` lets any authenticated tenant actor create claims, attach
  evidence, and transition maturity. The transition route accepts
  `approvedBy` from the request body and falls back to the caller id; it does not
  verify that the caller is allowed to approve, bind requirements, falsify, or
  transition that capability's claims.
- `knowledge.router.ts` lets any authenticated tenant actor capture raw
  knowledge events, run the lowering pass, list all lowering candidates, and
  accept or reject candidates. Accepting a candidate creates or merges governed
  claims.
- `registry.router.ts` lets any authenticated tenant actor call
  `/lookup/resolve` and `/promotions`. Only the scheduled `/jobs/*` endpoints
  require `requireServicePrincipal`.
- `ambiguity.router.ts` lets any authenticated tenant actor open, acknowledge,
  resolve, dismiss ambiguities, assert claim relations, and read the assumption
  register. These operations influence contradiction sweeps and projected
  readiness.
- The Prisma schema stores `capabilityId`, `createdBy`, `attachedBy`,
  `approvedBy`, `reviewedBy`, and tenant ids, but it has no grant, reviewer,
  steward, role, quorum, or capability-membership enforcement table for claim
  actions.
- `claim-registry/test/auth.test.ts` verifies bearer requirement, IAM-derived
  actor identity, tenant header validation, and fail-closed missing tenant
  membership. Searched tests do not cover role/capability permission denial,
  unauthorized evidence attachment, unauthorized maturity transition,
  unauthorized candidate acceptance, or forged `approvedBy`.

Impact:

- Any authenticated user in a tenant can potentially turn source documents into
  governed claims, attach evidence, transition maturity, bind requirements, or
  reject/accept LLM-lowered candidates for capabilities they should not curate.
- Claim maturity and ambiguity resolution become tenant-wide writable state
  instead of controlled epistemic governance decisions.
- A user can submit another user's id in `approvedBy`, making maturity-transition
  receipts look like a different approver approved the move.
- Capability-specific evidence quality can be weakened even though the tenant
  boundary itself is enforced.
- Downstream specification compilation, generation-plan validation, governance
  gates, and evidence packs can trust claims that were curated by users without
  the right role, skill, or capability authority.

Required fixes:

- Add explicit Claim Registry permissions such as `claim:view`, `claim:create`,
  `claim:evidence:attach`, `claim:maturity:transition`, `claim:approve`,
  `claim:promote`, `claim:lowering:review`, `claim:ambiguity:resolve`, and
  `claim:relation:assert`.
- Resolve claim/candidate/event/ambiguity/capability context before mutation and
  call IAM `/authz/check` or a shared policy service with tenant, actor,
  capability, resource id, and action.
- Remove caller-controlled `approvedBy` from normal user routes; derive the
  approver from the authenticated actor or from a verified delegation/approval
  decision.
- Enforce capability membership or curator/steward assignment for capability
  scoped claims and knowledge events.
- Split read-only assumption/register lookup from mutating curation actions.
- Add audit decisions for allow/deny, evidence attachment, maturity transition,
  lowering candidate acceptance/rejection, promotion, relation assertion, and
  ambiguity resolution.
- Add tests for tenant user without curator role attempting each mutation,
  capability A user mutating capability B claim, forged `approvedBy`, service
  token without curation scope, read-only auditor behavior, and successful
  authorized curator flows.

### 236. Claim Registry event dispatcher can deliver tenant events to other tenants' subscriptions

Evidence:

- `claim-registry/prisma/schema.prisma` gives `EventOutbox`,
  `EventSubscription`, and `EventDelivery` a `tenantId` column. Subscription
  names are unique per tenant.
- `claim-registry/src/lib/events.ts` writes outbox rows with
  `tenantId: currentRegistryTenant()`, so emitted claim events are tenant
  labeled at creation time.
- `claim-registry/src/lib/dispatcher.ts` drains `EventOutbox` rows with
  `where: { status: 'PENDING' }` and passes each row to `deliverRow(...)`, but
  the row shape used by `deliverRow(...)` omits `tenantId`.
- `deliverRow(...)` loads subscriptions with
  `prisma.eventSubscription.findMany({ where: { active: true } })`; it does not
  filter `EventSubscription.tenantId` to the outbox row tenant.
- The same function creates `EventDelivery` rows without setting `tenantId`, so
  delivery rows use the Prisma default `"default"` instead of the outbox tenant
  or subscription tenant.
- Delivery sends the signed payload to `sub.targetUrl` for every matching event
  pattern. The signed envelope built by `dispatch-core.ts` includes source
  service, trace id, subject, status, and payload, but not the outbox tenant id.
- `EventSubscription.secret` and `targetUrl` are stored as plaintext strings in
  the Claim Registry schema. The dispatcher fetches `sub.targetUrl` directly and
  signs with `sub.secret`; there is no SSRF allowlist, encrypted secret read, or
  per-tenant destination policy in the Claim Registry dispatcher path.
- `claim-registry/test/dispatch-core.test.ts` covers pattern matching, envelope
  construction, HMAC round-trip, unsigned deliveries, and retry math, but there
  is no dispatcher test for tenant-filtered subscriptions, delivery tenant id,
  encrypted secrets, target URL policy, or cross-tenant non-delivery.

Impact:

- A tenant A claim event can be delivered to tenant B's active subscription if
  the event pattern matches.
- Tenant-specific claim, ambiguity, knowledge, and lowering payloads can leak to
  another tenant's webhook target.
- Delivery records can be stored under the default tenant, making operations,
  replay, retry, and forensic reporting misleading or incomplete.
- Receivers cannot use the signed envelope to reject the wrong tenant because
  the envelope does not carry an authoritative tenant id.
- Plaintext webhook secrets and unguarded target URLs repeat an event-bus risk
  that WorkGraph has already started hardening elsewhere.

Required fixes:

- Include `tenantId` in the dispatcher row shape and filter subscriptions with
  `where: { active: true, tenantId: row.tenantId }`.
- Persist `EventDelivery.tenantId` from the outbox row and add a migration to
  backfill or quarantine default-tenant delivery rows.
- Add tenant id to the signed delivery envelope and require receivers to compare
  it with the expected source tenant.
- Encrypt `EventSubscription.secret` at rest or reference an external secret id,
  then decrypt only inside the dispatcher.
- Validate subscription target URLs with the same SSRF/destination policy used by
  the WorkGraph event-subscription path before storing and again before sending.
- Add dispatcher integration tests for tenant A/B subscriptions, wildcard
  patterns, delivery tenant id, wrong-tenant receiver rejection, target URL
  denial, encrypted secret use, and failed delivery reporting.

### 237. Claim Registry raw knowledge captures are stored inline and returned through the API

Evidence:

- `claim-registry/src/routes/knowledge.router.ts` accepts
  `POST /knowledge-events` with `content` up to 500,000 characters for sources
  such as transcripts, Slack, Confluence, board exports, Workbench, and manual
  entries.
- That route returns `res.status(201).json(await captureEvent(...))` without a
  response DTO or redaction layer.
- `claim-registry/src/services/knowledge.service.ts` stores the raw capture via
  `payloadRef: putPayload(input.content)` and returns the full Prisma
  `KnowledgeEvent` row to the caller.
- `claim-registry/src/lib/payload-store.ts` is still an inline stub:
  `putPayload(...)` returns `"inline:" + base64(rawContent)`, and
  `getPayload(...)` decodes that inline value. The file comment says production
  should back `payloadRef` with MinIO, but the implementation has a
  `TODO(M-CR2 hardening)` and throws for non-inline refs.
- `claim-registry/prisma/schema.prisma` stores `KnowledgeEvent.payloadRef` as a
  plain `String` with the comment "MinIO ref to raw capture". In the current
  code, that string can contain the full base64-encoded source document.
- `lowerEvent(...)` reads `event.payloadRef` directly and sends the decoded raw
  transcript/document into the LLM lowering prompt.
- Exact searched Claim Registry tests cover authentication, dispatch-core HMAC,
  lowering parsing, posterior math, ambiguity, maturity, and canonicalization,
  but not encrypted payload storage, MinIO/object-store failure, payloadRef
  redaction, retention, size pressure, or response leakage.

Impact:

- Sensitive source documents, transcripts, and customer data can be persisted
  directly inside the Claim Registry database row as base64 text rather than in
  a controlled artifact/object store.
- API callers that create or deduplicate a knowledge event can receive a
  `payloadRef` containing the full encoded raw document.
- Database backups, query logs, debug dumps, Prisma inspection, and broad
  internal reads can expose raw source material outside normal document/artifact
  permissions.
- Object-store controls such as encryption context, retention policy, content
  hash, MIME type, size tiering, malware scanning, legal hold, and presigned
  access logs are bypassed.
- Lowering evidence cannot prove which immutable object version was sent to the
  LLM, because the source is an inline blob rather than a versioned artifact with
  policy metadata.

Required fixes:

- Replace inline `payloadRef` with an object-store artifact reference carrying
  tenant id, capability id, content hash, byte size, media type, classification,
  retention policy, and encryption metadata.
- Return a redacted response DTO from `POST /knowledge-events`; expose only
  event id, source, content hash, capability id, status, and policy metadata.
- Make inline payload storage development-only and fail closed in production when
  the object store is unavailable.
- Add a bounded retrieval service for lowering that validates tenant, capability,
  purpose, retention, scan status, and LLM-use policy before returning content.
- Record lowering receipts with payload artifact id, content hash, extraction
  version, prompt trace id, and redaction/classification summary.
- Add tests for large capture storage, response redaction, object-store
  unavailable behavior, content hash immutability, cross-tenant payload denial,
  retention expiry, and non-inline lowering retrieval.

### 238. Claim Registry local JWT mode accepts empty or weak signing secrets

Evidence:

- `claim-registry/src/middleware/auth.ts` chooses the authentication provider
  from `CLAIM_REGISTRY_AUTH_PROVIDER ?? AUTH_PROVIDER ?? "iam"`.
- When the provider is `local`, the same middleware calls
  `verifyHs256(token, process.env.JWT_SECRET ?? "")`. There is no check that
  `JWT_SECRET` exists, is non-default, is high entropy, or meets the 32+
  character platform secret contract used by other production guardrails.
- `verifyHs256(...)` computes the expected HS256 signature with the supplied
  `secret` and accepts the token when the HMAC matches. If `JWT_SECRET` is
  missing, that secret is the empty string, so any token deliberately signed
  with an empty HS256 key is treated as valid local identity.
- `claim-registry/.env.example` warns that `CLAIM_REGISTRY_AUTH_PROVIDER=local`
  is only for isolated development with a compatible HS256 `JWT_SECRET`, but the
  running service has no startup refusal or request-time fail-closed guard for a
  missing or default development secret.
- `claim-registry/README.md` says all `/api/v1` requests require a verified IAM
  bearer token and that production should use `AUTH_PROVIDER=iam`, but the code
  still honors local mode whenever the environment selects it.
- `claim-registry/test/auth.test.ts` covers IAM verification, spoofed header
  rejection, tenant membership checks, and missing bearer denial. It does not
  test local mode, missing `JWT_SECRET`, default weak secrets, empty-secret
  forged tokens, unsupported algorithms beyond the helper branch, or production
  refusal when local auth is configured.
- Docker and bare-metal defaults start Claim Registry in IAM mode, but the
  service itself does not enforce that local mode is development-only or that a
  local JWT secret is safe before accepting claim, knowledge, ambiguity, and
  registry routes.

Impact:

- A misconfigured Claim Registry with `CLAIM_REGISTRY_AUTH_PROVIDER=local` and
  no `JWT_SECRET` lets a caller mint their own HS256 token with arbitrary
  `sub`, `tenant_ids`, `kind`, and service/user classification, signed by the
  empty string.
- Even with a default development secret, local mode turns claim governance into
  bearer-token self-assertion: a caller can choose tenant membership and service
  identity claims if they know or guess the shared dev secret.
- This bypasses the stronger IAM membership verification added to the registry
  and can compound the existing action-level authorization gap for claim
  curation, knowledge lowering, ambiguity resolution, and job-only operations.
- Operators can believe the service follows the README's IAM-only contract while
  one environment variable silently changes the trust model.
- Incident response is weaker because forged local tokens are not bound to an
  IAM user record, active membership version, service-token id, revocation
  state, or IAM authz decision.

Required fixes:

- Add a startup guard: in production-class or strict tenant mode, refuse
  `CLAIM_REGISTRY_AUTH_PROVIDER=local` unless an explicit unsafe-development
  override is set.
- In local mode, require `JWT_SECRET` to be present, non-default, at least 32
  characters, and preferably high entropy before accepting any `/api/v1`
  request.
- Reject empty secrets at verifier construction time; never pass `""` as an HMAC
  key for JWT verification.
- Restrict local-mode claims to development-only user tokens and never allow
  `kind=service` or scheduled job access unless a separate local service-token
  contract is explicitly configured.
- Log a loud startup warning and health degradation when local auth is active,
  even in development.
- Add tests for missing secret denial, empty-secret forged token denial, default
  weak secret denial, valid strong local token acceptance in development,
  production local-mode refusal, and local token attempts to call service-only
  job endpoints.

### 239. Claim Registry outbox marks permanently failed deliveries as processed

Evidence:

- `claim-registry/prisma/schema.prisma` defines `EventOutbox.status` as a string
  defaulting to `PENDING`, with the inline comment `PENDING | PROCESSED`. There
  is no outbox-level `FAILED`, `PARTIAL`, `DEAD_LETTERED`, `retryCount`, or
  `lastError` field.
- `claim-registry/src/lib/dispatcher.ts` drains `EventOutbox` rows where
  `status: "PENDING"`, delivers to matching `EventSubscription` rows, and then
  calls `deliverRow(row)`.
- `deliverRow(...)` returns `!anyStillPending`. The only condition that keeps
  `anyStillPending=true` is a failed delivery that remains retryable according
  to `shouldRetry(delivery.attempts)`.
- When a delivery reaches the retry limit, the dispatcher writes the
  `EventDelivery` row to `FAILED`, but `anyStillPending` remains false. The
  parent outbox row is therefore considered settled.
- Back in `drain()`, if `settled` is true, the dispatcher updates the parent
  outbox row to `status: "PROCESSED"` even if one or more child deliveries are
  `FAILED`.
- If no active subscription matches an event, `matching` is empty,
  `anyStillPending` remains false, and the outbox row is also marked
  `PROCESSED` without an explicit `NO_SUBSCRIBERS` or dead-letter state.
- `claim-registry/test/dispatch-core.test.ts` covers pure retry math and signed
  delivery bytes, but it does not exercise the database dispatcher path, failed
  child delivery aggregation, no-subscriber behavior, outbox status transitions,
  or a replay/retry operator view.
- The main platform audit already records that the WorkGraph event bus was
  improved so aggregate outbox health remains failed when subscriber deliveries
  fail; the Claim Registry dispatcher has not received the same lifecycle
  hardening.

Impact:

- Claim lifecycle events can disappear from operator attention: the parent
  outbox says `PROCESSED` even though downstream systems never received the
  event.
- WorkGraph, Synthesis, governance projections, and evidence-pack consumers can
  miss claim decay, falsification, ambiguity, or promotion events while the
  Claim Registry appears healthy at the aggregate outbox level.
- Retry tooling that scans only `EventOutbox.status="PENDING"` will never revisit
  permanently failed deliveries after the parent row is marked processed.
- No-subscriber events are indistinguishable from successfully delivered events,
  which hides wiring mistakes between the Claim Registry and WorkGraph.
- Operations dashboards cannot answer whether a claim event was fully delivered,
  partially delivered, dead-lettered, or ignored because no route existed.

Required fixes:

- Extend `EventOutbox.status` to include `DELIVERED`, `PARTIAL_FAILED`,
  `FAILED`, `NO_SUBSCRIBERS`, and `DEAD_LETTERED`, or store equivalent aggregate
  delivery health fields.
- Make `deliverRow(...)` return aggregate counts: matched subscribers,
  delivered, pending, failed, retryable, and last error summary.
- Mark the parent outbox row failed or partial when any non-retryable child
  delivery fails; reserve `PROCESSED` or `DELIVERED` for all required deliveries
  succeeding.
- Treat no-subscriber events as an explicit terminal status, with policy deciding
  whether that is allowed, warning, or dead-lettered for required event types.
- Add operator retry/replay APIs for failed Claim Registry deliveries that do
  not re-run claim mutation, only resend the event to subscriptions.
- Add database-backed dispatcher tests for all-delivered, one-failed,
  all-failed, retryable-pending, no-subscriber, and restart-after-failure cases.

### 240. Claim Registry subscription patterns can behave as unintended regular expressions

Evidence:

- `claim-registry/src/lib/dispatch-core.ts` documents subscription matching as
  glob semantics: exact names or globs, where `.` is literal and `*` does not
  cross dots.
- In `patternToRegex(...)`, the branch for patterns without `*` builds
  `new RegExp("^" + pattern.replace(/\./g, "\\.") + "$")`. It escapes dots but
  does not escape other regular-expression metacharacters such as `[`, `]`,
  `(`, `)`, `+`, `?`, `|`, `{`, `}`, `^`, or `$`.
- The branch for patterns with `*` does use the broader escape expression before
  replacing `*`, so exact-name subscriptions and glob subscriptions do not share
  the same safety behavior.
- A pattern such as `claim.created+` is treated as regex `^claim\.created+$`,
  so it can match event names like `claim.createddddd` instead of only the
  literal event name `claim.created+`.
- A malformed exact pattern such as `claim.[broken` throws while constructing
  the `RegExp`. `matchesAny(...)` does not catch that error.
- `claim-registry/src/lib/dispatcher.ts` calls
  `subs.filter((s) => matchesAny(s.eventTypes, row.eventType))` before creating
  deliveries. A bad active subscription pattern can therefore throw during
  matching and prevent the row from being delivered during that sweep.
- `claim-registry/prisma/schema.prisma` stores `EventSubscription.eventTypes` as
  a plain `String[]`; there is no database-level pattern validation.
- `claim-registry/prisma/seed-subscriptions.example.sql` writes subscription
  `eventTypes` directly with SQL and says exact names are used on purpose, but
  it cannot enforce the intended literal/glob grammar.
- `claim-registry/test/dispatch-core.test.ts` only asserts that `a.b` does not
  match `aXb`, plus normal suffix/lone-star behavior. It does not test exact
  names containing regex metacharacters, malformed exact patterns, validator
  rejection, or dispatcher isolation when one subscription is malformed.

Impact:

- A typo in an operator-managed Claim Registry subscription can broaden delivery
  to unintended event types or cause matching to throw on every sweep.
- A malformed active subscription can poison delivery for unrelated subscribers
  because matching happens before per-subscription delivery creation.
- Claim decay, falsification, ambiguity, or promotion events can be repeatedly
  skipped while logs show only dispatcher-row failures, not a clear invalid
  subscription configuration state.
- The platform presents event types as names/globs, but the exact-name path
  exposes raw regex behavior to operators and migrations.
- This repeats a class of event subscription pattern bug already found in the
  WorkGraph dispatcher, making cross-service eventing semantics inconsistent.

Required fixes:

- Use one shared `escapeRegExp(...)` helper for both exact and wildcard pattern
  branches; only `*` should have special meaning after escaping everything else.
- Add a `validateEventTypePattern(...)` helper with maximum length, allowed
  characters, explicit wildcard grammar, and clear errors.
- Validate `eventTypes` before insert/update in every seed, migration helper, or
  future subscription management API.
- During dispatch, isolate malformed subscriptions: mark the subscription
  disabled or `INVALID_CONFIG`, emit an operator-visible event, and continue
  matching/delivering for other valid subscriptions.
- Add tests for regex metacharacter literals, malformed bracket patterns,
  wildcard semantics, max length, invalid pattern quarantine, and ensuring one
  bad subscription cannot block delivery to another.

### 241. Claim Registry LLM lowering candidates lack model and prompt provenance

Evidence:

- `claim-registry/src/services/knowledge.service.ts` runs `lowerEvent(...)` by
  decoding the capture payload, generating a trace id, calling
  `llm.complete(...)`, parsing the response, and creating `LoweringCandidate`
  rows for each proposal.
- `claim-registry/src/lib/gateway.ts` sends the lowering prompt directly to
  `${LLM_GATEWAY_URL}/v1/chat/completions` with headers containing only
  `content-type` and `x-trace-id`. It does not send an `Authorization` bearer,
  tenant id, capability id, service identity, budget context, or a body-level
  `trace_id`.
- The gateway request body includes only `model_alias`, messages, and
  temperature. It does not ask for or persist a gateway request id, model
  version, provider id, prompt hash, response hash, token usage, cost, or safety
  metadata.
- `claim-registry/prisma/schema.prisma` defines `KnowledgeEvent` with
  `contentHash`, `payloadRef`, `capabilityId`, `capturedBy`, and
  `loweringStatus`, but no `loweringTraceId`, `modelAlias`, `promptHash`,
  `responseHash`, `gatewayCallId`, `tokenUsage`, `cost`, `loweringError`, or
  `loweringAttempt` fields.
- The same schema defines `LoweringCandidate` with `proposedStatement`,
  `proposedKind`, `modelConfidence`, `matchedClaimId`, `status`, `reviewedBy`,
  and `resultingClaimId`, but no per-candidate provenance back to the exact
  prompt, model, response JSON path, or parser version that produced it.
- On lowering failure, `lowerEvent(...)` updates the event to
  `loweringStatus: "FAILED"` and throws `LOWERING_FAILED`, but it does not
  persist the failure reason, provider status, trace id, attempt count, or retry
  policy on the event.
- `claim-registry/test/lowering.test.ts` proves pure JSON parsing and schema
  validation only. The LLM gateway client is injectable and not covered by tests
  for authentication headers, tenant/capability context, trace propagation,
  model alias capture, gateway failure receipts, or persisted provenance.

Impact:

- A candidate that later becomes a governed claim cannot prove which model,
  prompt, payload version, response, and parser generated the original proposed
  statement.
- Auditors cannot distinguish two candidates produced from the same source by
  different model aliases, prompt versions, temperatures, or retry attempts.
- Secure LLM Gateway mode can break Claim Registry lowering because this caller
  does not send gateway auth, while permissive mode hides provider spend behind
  an unscoped service call.
- Token/cost budgets, model-risk policies, and capability-specific LLM routing
  cannot be reconstructed from the Claim Registry row after the fact.
- A failed lowering pass leaves only a coarse `FAILED` status, making operations
  unable to tell whether the cause was missing gateway auth, invalid model
  alias, provider timeout, unsafe content, malformed JSON, parser rejection, or
  network failure.
- Human curation may accept candidates into durable claims without seeing the
  LLM evidence bundle that explains how the text was derived.

Required fixes:

- Add a `KnowledgeLoweringRun` or equivalent attempt table with tenant id,
  event id, capability id, trace id, model alias, resolved provider/model,
  prompt hash, payload hash/ref, parser version, gateway call id, token usage,
  cost, status, error code, and response hash.
- Link every `LoweringCandidate` to the lowering run and record the candidate's
  response JSON path or index, normalized statement hash, and parser validation
  result.
- Send scoped LLM Gateway authorization plus tenant/capability/trace context for
  every lowering call; fail closed when gateway auth or model routing is missing
  in strict mode.
- Persist lowering failure details in a redacted operator-safe form and expose
  retry only through an idempotent lowering-run command.
- Show lowering provenance in the curation UI before a user accepts a candidate
  into a governed claim.
- Add tests for authenticated gateway calls, missing bearer rejection, model
  alias persistence, prompt/payload hash stability, parser-version recording,
  failed-attempt persistence, retry idempotency, and claim acceptance carrying
  the lowering-run id into claim provenance.

### 242. Claim Registry maturity transitions are not atomic with receipts and events

Evidence:

- `claim-registry/src/services/claim.service.ts` implements
  `applyTransition(...)` as a sequence of independent Prisma writes rather than
  one `prisma.$transaction(...)`.
- The sequence first creates a `MaturityTransition` row, then updates the `Claim`
  maturity/status, then writes a receipt through `emitReceipt(...)`, then writes
  one or more outbox events through `publishEvent(...)`.
- `emitReceipt(...)` in `claim-registry/src/lib/events.ts` inserts a `Receipt`
  row directly and can throw independently after the claim row has already
  changed.
- `publishEvent(...)` inserts an `EventOutbox` row directly and can throw after
  the transition row, claim update, and receipt write have already succeeded.
- `SPEC_BOUND` has an additional side effect: `applyTransition(...)` calculates
  a `snapshotId` and emits `claim.spec_bound` after the main maturity event. If
  that final outbox insert fails, the claim is `SPEC_BOUND` but the specification
  control plane may never receive the snapshot signal.
- The `claim-registry/test/maturity.test.ts` and `test/mcr3.test.ts` files cover
  pure gate math, auto-transition selection, and decay threshold detection. They
  do not cover database write failure between transition, claim update, receipt,
  and outbox creation.
- `claim-registry/src/services/claim.service.ts` has the same pattern in the
  evidence attach path: evidence object upsert, evidence link upsert, posterior
  recompute, outbox events, and possible auto-transition are separate writes
  without one transaction or outbox command boundary.

Impact:

- The registry can record that a transition happened while the claim remains in
  the old maturity state if the claim update fails after `MaturityTransition`
  creation.
- The claim can move to a new maturity state without the promised receipt if
  receipt creation fails after the claim update.
- Downstream systems can miss `claim.maturity.changed`, `claim.falsified`, or
  `claim.spec_bound` even though the claim state changed durably.
- Evidence packs and audit timelines can disagree: one table may say a claim was
  promoted, another may not have the receipt, and subscribers may never receive
  the event that should drive specification/workflow re-evaluation.
- Retrying after a partial failure can create duplicate transition rows or emit
  events with a different trace id for the same logical maturity move.
- For `SPEC_BOUND`, a missing `claim.spec_bound` event can leave locked
  specification flows unaware that a requirement-level claim became binding.

Required fixes:

- Wrap transition row creation, claim update, receipt creation, and required
  outbox event creation in one database transaction.
- Introduce an idempotent `ClaimTransitionCommand` keyed by tenant, claim id,
  from state, to state, actor/approval id, evidence hash, and request id.
- Emit all outbox rows from inside the transaction and let the dispatcher handle
  delivery; never mutate claim maturity without a matching receipt/outbox record.
- Make `SPEC_BOUND` snapshot creation a persisted record or outbox payload within
  the same transaction, not an extra best-effort event after the main update.
- Add compare-and-set predicates on the claim update (`id`, tenant id, expected
  current maturity, posterior/evidence generation) to prevent stale concurrent
  transitions.
- Apply the same transaction/outbox discipline to evidence attach and posterior
  recompute when they can auto-transition the claim.
- Add fault-injection tests for failure after each write boundary, duplicate
  retry, concurrent transition attempts, missing outbox insert, and `SPEC_BOUND`
  snapshot consistency.

### 243. Claim evidence weight and tier are caller-asserted instead of source-verified

Evidence:

- `claim-registry/src/routes/claims.router.ts` defines the evidence attach body
  with caller-supplied `tier`, `kind`, `direction`, `logLikelihoodRatio`,
  `sourceKey`, `excerpt`, `observedAt`, `sourceMeta`, `decayExempt`, and
  `payloadRef`.
- The route passes those values directly to `attachEvidence(...)` with only Zod
  type/enum validation. It does not resolve `payloadRef` to a governed artifact,
  verify source ownership, check source freshness, validate `sourceKey`, or
  require an evidence-quality decision for high-tier evidence.
- `claim-registry/src/services/claim.service.ts` writes `EvidenceObject.tier`,
  `kind`, `excerpt`, `payloadRef`, `sourceMeta`, and `observedAt` from the
  request, then writes `EvidenceLink.direction`, `logLikelihoodRatio`,
  `sourceKey`, and `decayExempt` from the request.
- `recompute(...)` derives posterior probability from those persisted links, and
  `maybeAutoTransition(...)` can then auto-transition a `HYPOTHESIS` to
  `VALIDATED`.
- `claim-registry/src/lib/maturity.ts` makes `HYPOTHESIS->VALIDATED` automatic
  when posterior, effective evidence, and tier gates pass; it does not require
  human approval for that edge.
- The default tier caps in `claim-registry/src/lib/posterior.ts` limit LLR
  magnitude once a tier is chosen, but they do not prove that the evidence is
  truly `T0`, `T1`, `T2`, or `T3`.
- `decayExempt` is caller-controlled on each evidence link. If true, the
  evidence bypasses time decay in `computePosterior(...)`; there is no
  policy-side check that only regulatory, contractual, or otherwise durable
  evidence can be exempt.
- Existing tests cover pure posterior caps, decay, same-source diminishing, and
  maturity gate math, but not route-level evidence-source verification,
  high-tier approval, payloadRef existence, sourceKey trust, decay-exempt policy,
  or attempts to auto-validate a claim with self-asserted high-tier evidence.

Impact:

- A caller who can attach evidence can inflate a claim by labeling weak excerpts
  as `T0`/`T1`, choosing independent `sourceKey` values to avoid same-source
  diminishing, and marking evidence as decay-exempt.
- Claims can cross into `VALIDATED` automatically even though the evidence tier
  and source identity were never verified by an artifact store, telemetry system,
  experiment registry, or human evidence steward.
- Downstream specification generation, governance gates, and evidence packs can
  treat a claim as validated based on self-asserted evidence quality.
- `payloadRef` can point to a nonexistent or unauthorized object while the
  excerpt and tier still affect the posterior.
- The decay model becomes unreliable if durable-exemption flags are not tied to
  a governed evidence type or source policy.

Required fixes:

- Introduce an evidence-source registry with allowed tiers, source owners,
  source kinds, artifact/document requirements, and decay-exemption policy.
- Resolve and authorize `payloadRef` before evidence affects posterior; store
  artifact id, content hash, tenant, capability, classification, and source
  verifier on the evidence object.
- Require explicit evidence-quality approval or automated verifier receipts for
  `T0`/`T1` evidence, `decayExempt=true`, and any source used for automatic
  maturity transitions.
- Derive or validate `sourceKey` from the governed source/artifact rather than
  trusting arbitrary caller strings.
- Separate draft evidence capture from posterior-affecting accepted evidence;
  only accepted evidence should feed recompute.
- Add route/integration tests proving weak evidence cannot self-label as high
  tier, nonexistent payload refs are rejected, unauthorized sources are denied,
  decay exemption requires policy, duplicate source keys are enforced, and
  auto-validation requires verified evidence.

### 244. Claim Registry promotions trust caller-supplied Rooms posterior state

Evidence:

- `claim-registry/src/routes/registry.router.ts` exposes
  `POST /promotions` as the Rooms-to-Registry promotion intake.
- The route schema accepts caller-supplied `statement`, `kind`, `alpha`, `beta`,
  `roomClaimId`, and optional `capabilityId`. It validates only basic shape:
  statement length, kind enum, positive numbers, non-empty room claim id, and
  UUID-shaped capability id.
- `claim-registry/src/services/registry.service.ts` implements
  `promoteFromRoom(...)` by converting the supplied `alpha`/`beta` through
  `betaToLogOdds(...)`, then creating a Registry claim with
  `priorLogOddsOverride`, `maturity: "HYPOTHESIS"`, and provenance containing
  `{ promotedFromRoom: true, roomClaimId, beta: { alpha, beta } }`.
- The Claim Registry service does not call WorkGraph/Rooms to verify that
  `roomClaimId` exists, belongs to the current tenant, belongs to the supplied
  capability, contains the supplied statement/kind, has the supplied Beta
  posterior, or has been approved for promotion.
- The route does not require a source Room snapshot hash, board/room head
  revision, promotion decision id, reviewer id, source evidence ids, or
  idempotency key.
- `betaToLogOdds(...)` clamps degenerate values for numerical stability, but
  there is no upper bound or reasonability check on `alpha` and `beta` in the
  route. A caller can submit a very high-confidence posterior as the claim's
  Registry prior.
- `claim-registry/test/mcr3.test.ts` covers pure Beta-to-log-odds math and
  decay threshold detection only. It does not test source Room resolution,
  tenant/capability binding, source-posterior verification, duplicate promotion,
  fabricated room ids, or idempotent promotion receipts.

Impact:

- A promotion can create a durable Registry claim whose prior belief comes from
  caller-provided numbers rather than the actual Rooms claim state.
- The provenance says `promotedFromRoom` and carries a `roomClaimId`, but that id
  may be nonexistent, cross-tenant, stale, or unrelated to the statement.
- Auditors cannot reconstruct which Room/board revision, evidence set, or human
  promotion decision produced the claim.
- A fabricated high prior can make later weak evidence more likely to pass
  maturity gates, even though the prior was not independently verified.
- Duplicate promotion retries can create conflicts based only on canonical claim
  text, not on a durable promotion command/receipt that proves the original
  source and decision.

Required fixes:

- Make promotion a source-verified command: resolve `roomClaimId` through the
  WorkGraph/Rooms API or a signed promotion envelope before creating the Registry
  claim.
- Require source tenant, project/room id, capability id, room claim version,
  board/head revision, source evidence hash, promotion decision id, and
  idempotency key.
- Derive `statement`, `kind`, `alpha`, `beta`, and capability from the verified
  source snapshot instead of trusting the request body.
- Bound accepted Beta inputs and record the exact source posterior digest in the
  Registry claim provenance.
- Add a `ClaimPromotionCommand` or `PromotionReceipt` table keyed by tenant plus
  source room claim/version so retries return the same Registry claim.
- Add tests for nonexistent source room claim, cross-tenant source, stale source
  version, mismatched statement/kind, fabricated Beta values, duplicate retry,
  and successful verified promotion.

### 245. Claim Registry ambiguity idempotency is code-only and race-prone

Evidence:

- `claim-registry/src/lib/ambiguity.ts` documents that two OPEN ambiguities with
  the same key are the same logical tension, but also states the guard is
  code-enforced and "NOT a DB unique".
- `claim-registry/prisma/schema.prisma` confirms this: `Ambiguity` has
  `@@index([dedupeKey, status])`, not a unique constraint such as
  `(tenantId, dedupeKey, status)` for OPEN rows or a partial unique index on
  `status = 'OPEN'`.
- `claim-registry/src/services/ambiguity.service.ts` implements
  `openAmbiguity(...)` as `findFirst({ tenantId, dedupeKey, status: 'OPEN' })`
  followed by `prisma.ambiguity.create(...)` if no row is found.
- The `findFirst` and `create` are not inside a transaction with a serializable
  isolation level or protected by a unique key, so two concurrent sweep workers
  can both observe no OPEN row and both create an OPEN ambiguity for the same
  tension.
- `runContradictionSweep(...)`, `runStarvationSweep(...)`, and
  `runDecayRecompute(...)` all call `openAmbiguity(...)`; there is no sweep
  lease or leader election shown in the Claim Registry service.
- Manual `POST /ambiguities` also calls the same helper, so a human/manual open
  can race with a nightly sweep for the same claim/tension.
- `claim-registry/test/ambiguity.test.ts` proves that `dedupeKeyFor(...)` is
  deterministic and order-independent, but it does not test concurrent opens,
  database uniqueness, duplicate OPEN prevention, or reopen-after-resolution
  semantics.

Impact:

- Operators can see duplicate OPEN ambiguity rows for the same contradiction,
  missing-evidence, or starvation issue.
- Each duplicate emits its own `ambiguity.opened` outbox event, which can
  trigger duplicate downstream work, duplicate notifications, or duplicate
  WorkGraph review flags.
- Human resolution can close one duplicate while another remains OPEN, making
  the assumption register and readiness projections keep reporting a tension the
  team believes it resolved.
- Because reopening after resolution is intended, this needs a state-aware
  uniqueness model; without one, the platform gets neither clean replayability
  nor clean human queue semantics.

Required fixes:

- Add a database-enforced invariant for one OPEN ambiguity per tenant and
  dedupe key, using either a partial unique index on `(tenantId, dedupeKey)` for
  `status = 'OPEN'` or an active-ambiguity table.
- Rewrite `openAmbiguity(...)` to use atomic insert/upsert semantics and return
  the existing OPEN row on unique conflict.
- Add a `reopenGeneration` or `ambiguityEpoch` if the same logical tension can
  reopen after resolution, and include it in events and receipts.
- Add sweep leasing or idempotent sweep-run records so parallel scheduled jobs
  do not repeatedly contend on the same ambiguity set.
- Add concurrency tests for two simultaneous opens, sweep/manual race,
  resolve-then-reopen, duplicate event suppression, and assumption-register
  counts after duplicate attempts.

### 246. Assumption register undercounts ambiguities where the assumption is the related claim

Evidence:

- `claim-registry/src/services/ambiguity.service.ts` stores contradiction
  ambiguities with a primary `claimId` and optional `relatedClaimId`.
- `runContradictionSweep(...)` opens contradiction ambiguities with
  `claimId: rel.fromClaimId` and `relatedClaimId: rel.toClaimId`.
- `claim-registry/prisma/schema.prisma` makes `Ambiguity.claimId` a real
  relation to `Claim`, while `relatedClaimId` is documented as "the other side
  of a CONTRADICTION" and is a soft ref with no FK relation.
- `claim-registry/src/services/projections.service.ts` builds the assumption
  register's open-ambiguity counts with:
  `where: { status: 'OPEN', claimId: { in: claims.map((c) => c.id) } }`.
- That query does not include `relatedClaimId`, so an assumption that appears as
  the `toClaimId` side of a contradiction gets `openAmbiguityCount: 0` even when
  an OPEN contradiction references it.
- `listAmbiguities(...)` has the same directional filter: when filtering by
  `claimId`, it adds only `{ claimId: filter.claimId }`; it does not return rows
  where the claim is `relatedClaimId`.
- `claim-registry/test/ambiguity.test.ts` proves the dedupe key is
  order-independent, but there is no projection test proving both sides of a
  contradiction see the same open ambiguity.

Impact:

- The assumption register can under-report risk for assumptions that are on the
  related side of a contradiction edge.
- Users may prioritize or promote an assumption as clean because the register
  shows zero open ambiguities, even though a live contradiction exists.
- Directional storage leaks into the read model: `A CONTRADICTS B` and
  `B CONTRADICTS A` are logically the same tension but not equally visible in
  claim-scoped queries.
- Synthesis and specification readiness views that depend on the assumption
  register can miss contested assumptions.

Required fixes:

- Count ambiguities where either `claimId` or `relatedClaimId` is in the
  assumption claim set.
- Update `listAmbiguities({ claimId })` to query both sides of the relation.
- Make `relatedClaimId` a proper relation or introduce an
  `AmbiguityParticipant` table so multi-claim tensions are symmetrical and
  queryable.
- Include participant ids and roles in `ambiguity.opened` events so downstream
  projections can update every affected claim.
- Add tests proving assumption register counts contradictions for both `from`
  and `to` claims, including mixed assumption/non-assumption pairs and filtered
  capability views.

### 247. Concept Studio proposal promotion drops generated claims

Evidence:

- `workgraph-studio/apps/api/src/modules/concept-archive/archive.service.ts`
  implements direct card promotion in `promoteCard(...)`.
- In that direct path, the service parses the card body, loops through
  `body.assumptions`, creates one WorkGraph `Claim` per assumption, updates the
  card to `status: 'PROMOTED'`, and stores the generated ids in
  `claimRefs`.
- The proposal-inbox path uses the same business word, `PROMOTE`, inside
  `decideProposal(...)`.
- When accepting a `CONCEPT_CARD` proposal with `kind === 'PROMOTE'`, the code
  only updates the card's `status`, `promotedRef`, and `operatorNote`; it does
  not parse the target card body, create assumption claims, preserve existing
  `claimRefs`, or write new `claimRefs`.
- The proposal path appends a `CARD_PROMOTED` archive event with only
  `{ proposalId }`, while the direct promotion event includes the generated
  `claimIds`.
- `workgraph-studio/apps/api/test/archive.engine.test.ts` covers engine
  behavior such as cell keys, scoring, dedupe, and pathfinder ranking. It does
  not cover archive service promotion, proposal acceptance, claim creation, or
  promoted-card evidence parity.

Impact:

- Two user-visible paths that both say "promote" create different evidence
  chains.
- A human who accepts an agent's promote proposal can end up with a promoted
  concept that has no generated claims, while a direct promotion would have
  created those claims.
- Downstream specification, decision, generation-plan, and readiness views that
  expect `claimRefs` can treat proposal-promoted concepts as weaker or empty
  evidence.
- Auditors cannot reconstruct why the proposal-promoted concept was trusted,
  because the event lacks the assumption claim ids that the direct path records.

Required fixes:

- Factor claim generation into a shared promotion helper used by both
  `promoteCard(...)` and the accepted `PROMOTE` proposal branch.
- Make accepted `PROMOTE` proposals produce the same `claimRefs` and archive
  event payload shape as direct promotions.
- Preserve existing claim refs when a card is re-promoted, and make repeated
  proposal acceptance idempotent.
- Add API/service tests for direct promotion, proposal promotion, no-assumption
  promotion, repeated promotion, and generated claim/event parity.

### 248. Concept Studio tables are not covered by forced tenant RLS and child queries omit tenant filters

Evidence:

- `workgraph-studio/apps/api/prisma/schema.prisma` gives `Studio`,
  `ConceptArchive`, `ConceptCard`, `ArchiveCellState`, `ConceptCardVote`, and
  `StudioProposal` `tenantId` fields, but `ArchiveEvent` has no `tenantId`
  field at all.
- `workgraph-studio/apps/api/prisma/migrations/20260805020000_synthesis_tenant_rls/migration.sql`
  enables and forces RLS for decision/economics tables only:
  `decision_dossiers`, `decision_options`, `project_budget_envelopes`, and
  `project_token_ledger`.
- `workgraph-studio/apps/api/prisma/rls-cutover-manual-apply-only.sql` and the
  checked migrations enable forced RLS for workflow, board, business-alignment,
  work-item, and decision/economics tables, but there is no matching forced-RLS
  policy for `studios`, `concept_archives`, `concept_cards`,
  `archive_cell_states`, `archive_events`, `concept_card_votes`, or
  `studio_proposals`.
- `archive.service.ts` mixes tenant-aware and tenant-unaware queries. For
  example, `getArchive(...)` reads cards with `{ archiveId, ...tenantWhere() }`
  but reads cells with only `{ archiveId }` and events with only `{ archiveId }`.
- `confirmCardCoords(...)` reads `archiveCellState` by the composite key
  `{ archiveId, axesRevision, cellKey }` without tenant filtering, then updates
  the cell by `id`.
- `voteCard(...)` scopes the card read by tenant, but then reads all votes with
  `{ cardId }` and updates the card by `{ id: cardId }`.
- `freezeArchive(...)`, `recutArchive(...)`, and proposal swap handling also
  include child-card or child-cell reads and writes without consistently adding
  `tenantId`.
- The only searched Concept Archive test is `archive.engine.test.ts`; it is
  DB-free and cannot prove table RLS, cross-tenant direct-id denial, or child-row
  tenant scoping.

Impact:

- In non-forced-RLS deployments, a bug, stale row, manual data repair, or direct
  id path can leak archive events/cells/votes across tenant boundaries.
- Even in strict-mode code paths, Concept Studio is not protected by the same
  database backstop that exists for WorkItems, workflow runtime, boards,
  business alignment, and decision/economics data.
- Board/idea data can contain unreleased strategy, customer evidence, proposed
  capabilities, and assumption notes, so child-row leakage is not harmless.
- Missing `tenantId` on `ArchiveEvent` also makes tenant-scoped event retention,
  replay, export, and audit filtering weaker than the rest of the platform.

Required fixes:

- Add `tenantId` to `ArchiveEvent` and backfill it from the owning archive.
- Add forced RLS policies for all Concept Studio tables:
  `studios`, `concept_archives`, `concept_cards`, `archive_cell_states`,
  `archive_events`, `concept_card_votes`, and `studio_proposals`.
- Update every Concept Archive child query and mutation to include tenant scope
  or run inside a tenant transaction whose RLS policy is proven active.
- Add direct-id cross-tenant tests for archives, cards, cells, events, votes,
  proposals, pathfinder, freeze, recut, promotion, and proposal decision.
- Extend the WorkGraph tenant-isolation doctor to include Concept Studio tables.

### 249. Concept Archive budget counters are race-prone JSON snapshots

Evidence:

- `archive.service.ts` stores archive usage in
  `ConceptArchive.budgetUsage`, a JSON object with `cards`, `proposals`,
  `embeddingCalls`, and `searchExpansions`.
- `stageCardInTx(...)` reads `usage = usageOf(archive.budgetUsage)`, checks
  `usage.cards >= budget.maxCards`, creates a card, and writes a whole JSON
  replacement with `cards: usage.cards + 1`.
- The same function increments `embeddingCalls` by rewriting the same JSON
  snapshot.
- `confirmCardCoords(...)`, `createProposal(...)`, and `rebaseProposal(...)`
  increment `proposals` with the same read-check-rewrite pattern.
- `pathfinder(...)` reads usage outside the update path, ranks cards, then
  rewrites `searchExpansions` to `usage.searchExpansions + ranked.expansions`.
- None of these updates use a row lock, serializable transaction, compare-and-set
  on the previous `budgetUsage` value, SQL-side JSON increment, or separate
  counter table with atomic numeric columns.
- Under PostgreSQL's normal read-committed behavior, two concurrent requests can
  both read `cards = N`, both pass the max-card check, both create cards, and
  both write `cards = N + 1`.
- The Concept Archive tests are engine-only and do not exercise concurrent
  staging, proposal creation, pathfinder budget exhaustion, or lost-update
  behavior.

Impact:

- A busy idea board can exceed card, proposal, embedding-call, or search
  expansion budgets without the stored usage showing the real amount consumed.
- Token/cost controls for agent-generated ideas become advisory instead of
  enforceable under concurrency.
- Later budget decisions can be made from stale or undercounted usage, which is
  especially risky when agents are allowed to generate many proposals.
- Operators can see confusing budget UI: the board appears within budget while
  more cards/proposals exist than the configured cap allows.

Required fixes:

- Replace JSON budget counters with first-class numeric columns or a
  `ConceptArchiveBudgetLedger` table.
- If JSON must remain for compatibility, update counters with SQL-side atomic
  expressions and compare-and-set guards.
- Lock the archive row before checking and consuming budget, or use serializable
  transactions with retry on serialization failure.
- Record each budget-consuming action in an immutable ledger with request id,
  actor, action type, trace id, and consumed amount.
- Add concurrency tests for card staging, proposal creation, pathfinder search,
  embedding budget exhaustion, and UI summary consistency after races.

### 250. Synthesis claim references are split between WorkGraph local claims and Claim Registry claims

Evidence:

- `workgraph-studio/apps/api/prisma/schema.prisma` defines a WorkGraph-local
  `Claim` model with posterior fields, stewardship, provenance, evidence, and
  project/capability scoping.
- Concept Studio and Rooms create these WorkGraph-local claims directly. For
  example, `promoteCard(...)`, `killCell(...)`, Rooms claim creation, and
  Experience claim extraction all call `tx.claim.create(...)` or
  `prisma.claim.create(...)`.
- `studio-spec.schemas.ts` allows project requirements and decisions to carry
  `claimRefs` as UUIDs, and `contract-bound.router.ts` validates generation
  plan row `claimRefs` by querying `prisma.claim.findMany(...)` for claims that
  belong to the same WorkGraph project.
- Separately, `lookup/resolver.ts` defines the workflow-template `claim` resolver
  as a live call to the external `claim-registry` service at
  `/api/v1/claims/:id`.
- `workgraph-studio/apps/api/src/modules/claims/README.md` says
  `Workflow.metadata.claimRefs` are written for SPEC_BOUND Claim Registry claims
  and are validated by the resolver's `claim` kind.
- That README also says Claim Registry decay/falsification events re-flag
  workflow templates that reference registry claim ids.
- There is no searched code path that automatically mirrors WorkGraph-local
  `Claim` rows into Claim Registry, or normalizes Claim Registry claim ids back
  into WorkGraph project claims before specification/generation validation.

Impact:

- The same field name, `claimRefs`, means different claim authorities depending
  on where it appears: WorkGraph-local project claims in Synthesis and
  Claim-Registry claims in workflow metadata.
- A claim created from a concept promotion can satisfy generation-plan
  validation, but the Claim Registry decay/falsification loop will not know
  about it unless an explicit sync exists.
- A Claim Registry SPEC_BOUND claim can validate workflow metadata, but it will
  not satisfy Synthesis generation-plan validation unless it also exists as a
  WorkGraph-local claim.
- Users and auditors can follow a `claimRefs` chain and land in a different
  registry depending on the screen, breaking the "one evidence spine" promise.
- Claim lifecycle events, ambiguity sweeps, assumption register projections, and
  WorkGraph specification readiness can diverge for the same business belief.

Required fixes:

- Define one canonical claim authority for new Synthesis evidence, or introduce
  explicit typed refs such as `{ authority: 'workgraph' | 'claim-registry',
  claimId, snapshotId }`.
- Add a deterministic sync/binding layer if WorkGraph-local claims remain:
  local claim id, registry claim id, content hash, snapshot id, tenant id,
  capability id, and lifecycle status.
- Rename or version `claimRefs` payloads so workflow metadata and Synthesis
  specification packages cannot silently mix incompatible claim ids.
- Extend Claim Registry events to update or invalidate bound WorkGraph-local
  claims, and extend WorkGraph claim changes to publish registry-compatible
  evidence.
- Add end-to-end tests proving a concept promotion claim can be traced through
  specification, generation plan, workflow metadata, Claim Registry decay, and
  UI audit links without changing authority midstream.

### 251. Platform Registry registration authority is shared and caller-controlled

Evidence:

- `platform-registry/src/routes/registry.ts` documents that `POST /register`
  uses tokens from `REGISTER_TOKENS`, while GET routes are public.
- `requireRegisterToken(...)` only checks whether the bearer token is present in
  the global `allowedRegisterTokens` set.
- `POST /register` trusts the caller-supplied `service_name` and performs an
  `ON CONFLICT (service_name) DO UPDATE` that replaces `display_name`,
  `version`, `base_url`, `internal_url`, `health_path`, `auth_mode`,
  `owner_team`, and `metadata`.
- The same registration path deletes and replaces all
  `service_capabilities` for that `service_name`.
- `POST /services/:name/heartbeat` uses the same shared token check and lets a
  caller update any `:name` to `last_status = 'healthy'`.
- There is no service-specific credential, JWT subject binding, mTLS subject,
  service allowlist, owner lock, registration generation, or audit trail in
  `platform-registry/db/001_init.sql`.
- `context-fabric/services/context_api_service/app/governed/llm_client.py`
  resolves the live LLM gateway by reading public
  `/api/v1/services/{LLM_GATEWAY_SERVICE_NAME}` and trusting
  `internal_url` or `base_url`.

Impact:

- Any holder of a shared register token can clobber `llm-gateway`,
  `workgraph-api`, `prompt-composer`, or another registered service.
- A bad or compromised service can redirect Context Fabric LLM calls to a wrong
  or hostile URL by overwriting the LLM gateway registry row.
- A caller can keep a dead or replaced service looking healthy by heartbeating
  its name.
- Capabilities and contracts become last-writer-wins metadata, not a trusted
  platform service inventory.

Required fixes:

- Bind registration credentials to a specific `service_name`, tenant or
  deployment boundary, and expected service identity.
- Use IAM service JWTs or mTLS identities with an explicit service registration
  permission instead of a global shared token.
- Reject conflicting owner, URL, auth mode, or capability changes unless a
  privileged operator approves a registration generation change.
- Add immutable registration audit records with actor, service identity, old
  value, new value, trace id, and decision id.
- Make Context Fabric discovery accept only registry rows with verified
  ownership and fresh health.

### 252. Platform Registry can run unauthenticated in production when `REGISTER_TOKENS` is empty

Evidence:

- `platform-registry/src/config.ts` defaults `NODE_ENV` to `development` and
  `REGISTER_TOKENS` to an empty string.
- The same config builds `allowedRegisterTokens` by splitting
  `REGISTER_TOKENS`; an empty value produces an empty set.
- `requireRegisterToken(...)` immediately calls `next()` when
  `allowedRegisterTokens.size === 0`, with the comment `// dev mode`.
- There is no startup refusal when `NODE_ENV === 'production'` and
  `REGISTER_TOKENS` is empty.
- `platform-registry/docker-compose.yml` passes
  `REGISTER_TOKENS: "${REGISTER_TOKENS:-}"`, preserving the empty default.
- The route comment says empty tokens are dev-only, but the code does not
  enforce that boundary.

Impact:

- A production or shared staging registry can become unauthenticated through a
  single missing environment variable.
- In that state, any network caller can register or overwrite services and
  heartbeat arbitrary service names.
- The failure mode is silent: health can still return ok, and public GET routes
  can look normal after untrusted writes have happened.

Required fixes:

- Refuse startup in `production` or strict deployment mode unless registration
  auth is configured.
- Treat empty `REGISTER_TOKENS` as allowed only when an explicit
  `ALLOW_OPEN_REGISTRY_DEV=true` flag is set.
- Add startup and unit tests for production empty-token refusal.
- Surface `unsafe_auth` or `open_registration` in registry health/readiness so
  Operations cannot mistake an open registry for an enterprise-ready one.
- Include platform-registry auth checks in deployment guardrails and doctor
  scripts.

### 253. Platform Registry liveness is self-reported and never marks stale services unhealthy

Evidence:

- `platform-registry/db/001_init.sql` documents `last_status` values of
  `registered`, `healthy`, `unhealthy`, and `stale`.
- `POST /register` writes `last_status = 'registered'`.
- `POST /services/:name/heartbeat` writes `last_seen_at = now()` and
  `last_status = 'healthy'`.
- No searched registry route, worker, or sweeper probes
  `base_url + health_path`, checks missed heartbeats, or transitions rows to
  `unhealthy` or `stale`.
- `GET /services` and `GET /services/:name` return whatever `last_status` is
  stored; they do not compute freshness from `last_seen_at`.
- `workgraph-studio/apps/api/src/lib/platform-registry/register.ts` fires the
  initial register once, starts a heartbeat timer, and silently ignores
  heartbeat failures.
- The Python helpers in `context_api_service` and `singularity-iam-service`
  catch exceptions but do not log non-2xx responses, so schema/auth failures can
  be easy to miss.
- `context-fabric/services/llm_gateway_service/app/platform_registry.py` logs
  non-2xx registration failures, but its heartbeat loop also does not
  re-register when the registry row is missing.

Impact:

- Operations live maps can report stale rows as healthy long after the backing
  service is gone.
- Context Fabric LLM gateway discovery can use an obsolete gateway URL until an
  operator notices or the static fallback happens to mask the issue.
- If the initial registration fails, several services can continue running
  normally while their registry row never appears; later 404 heartbeat failures
  do not repair the missing row.
- Operators cannot distinguish "service is healthy", "service self-reported
  recently", and "registry has not checked it".

Required fixes:

- Add a registry-side health sweeper that probes registered health endpoints,
  marks stale rows after missed heartbeat thresholds, and records last probe
  error.
- Make GET responses include computed freshness, heartbeat age, probe age, and
  whether health is self-reported or verified.
- Have service helpers re-run full registration when heartbeat returns 404.
- Log non-2xx registration and heartbeat responses consistently in every helper.
- Make Context Fabric reject stale discovered LLM gateway rows unless explicit
  debug fallback is enabled.
- Add tests for missed heartbeats, stale status, re-registration after 404, and
  discovery rejection of stale rows.

### 254. Platform Registry validation tests do not exercise the actual API schema

Evidence:

- `platform-registry/test/smoke.test.ts` defines
  `SERVICE_NAME_RE = /^[a-z][a-z0-9-]{2,63}$/` and says it mirrors the
  canonical service-name regex used by the registry capability index.
- `platform-registry/src/routes/registry.ts` defines
  `registerSchema.service_name` as `z.string().min(1)`, not that regex.
- The same route accepts `capability_key` and `contract_key` as only
  `z.string().min(1)`.
- `platform-registry/db/001_init.sql` stores `service_name`,
  `capability_key`, and `contract_key` as `TEXT` columns without CHECK
  constraints or length bounds.
- The smoke test that claims to detect source import failures catches import
  errors and substitutes `{ version: "?" }`, so it cannot fail on a missing
  `src/lib/version` module.
- There are no searched integration tests that POST invalid registrations to
  `/api/v1/register` and assert rejection from the actual zod schema plus DB
  constraints.

Impact:

- Uppercase, underscored, overly long, or otherwise non-canonical service names
  can be accepted even though the tests imply they are rejected.
- Capability and contract keys can drift into arbitrary strings, making search,
  topology, docs, and service discovery inconsistent.
- The test suite gives false confidence because it tests a local regex constant
  rather than the production parser or database.
- Later consumers may add assumptions around canonical keys that the registry
  does not actually enforce.

Required fixes:

- Export and reuse one shared validator for service names, capability keys, and
  contract keys in both routes and tests.
- Add DB CHECK constraints for canonical key format and bounded length.
- Replace the catch-and-substitute import smoke test with a real import
  assertion.
- Add supertest or integration tests for malformed service names, malformed
  capability keys, malformed contract keys, invalid URLs, invalid auth modes,
  and DB constraint failures.
- Add a migration/backfill check for any existing non-canonical registry rows
  before tightening constraints.

### 255. Observability log export has no per-target tenant or data-class policy

Evidence:

- `audit-governance-service/src/log-operations.ts` reads export targets from
  `LOG_EXPORT_TARGETS_JSON` with fields `id`, `type`, `url`, `credentialEnv`,
  and `enabled`.
- `queueLogExports(...)` filters only by `target.ready` and an optional
  `onlyTargetId`, then inserts the same batch payload for every ready target.
- `safeExportRecords(...)` truncates large messages/payloads but does not apply
  tenant, capability, service, environment, sensitivity, prompt/document, or
  data-class policy.
- `targetBody(...)` sends the full safe record to Datadog, Splunk, or an
  `http-json` endpoint.
- `validateTarget(...)` checks URL scheme, optional private/local URL allowance,
  and credential presence, but not allowed tenants, services, regions,
  compliance domains, retention class, redaction mode, or data residency.
- `audit-governance-service/src/routes-logs.ts` queues exports from every log
  ingest batch by calling `queueLogExports(logs)` after writing the logs.
- `audit-governance-service/test/log-operations.contract.test.ts` only checks
  that export credentials are read from env and that export routes exist; it
  does not test tenant filtering, data-class filtering, or external egress
  denial.

Impact:

- A single configured Datadog/Splunk target receives logs for all tenants,
  services, capabilities, traces, and environments that ingest into the log
  lake.
- Operators cannot say "export tenant A to this vendor but keep tenant B local"
  or "export metrics/errors but not prompts, documents, repository paths, or
  provider payloads."
- A misconfigured target can create cross-tenant or cross-region data egress
  even when the in-platform log search is later permission-scoped.
- The export queue becomes a second copy of broad operational data with no
  explicit data-handling policy attached to each queued item.

Required fixes:

- Extend export targets with allowlists for tenant, capability, service,
  environment, level, event type, and data class.
- Add a redaction mode per target, with `metadata-only` or `operator-safe` as
  the default and full payload export requiring an explicit sensitive-egress
  flag.
- Tag each normalized log with data classes such as `secret`, `prompt`,
  `document`, `repo-path`, `provider-error`, `runtime-diagnostic`, and
  `business-payload`.
- Apply egress policy before inserting export queue rows, not only before HTTP
  delivery.
- Add tests proving tenant A logs do not go to tenant B targets, prompt/document
  payloads are not exported in default mode, private targets remain blocked by
  default, and a disabled/missing target cannot receive queued data.

### 256. Observability raw log storage is searchable but not tamper-evident evidence

Evidence:

- `audit-governance-service/src/db.ts` creates
  `audit_governance.observability_logs` with `raw_storage_uri`,
  `raw_storage_offset`, and `raw_storage_bytes`.
- The same table has no `raw_storage_hash`, `batch_hash`, `previous_hash`,
  `signature`, `producer_token_id`, `ingest_decision_id`, or immutable sequence
  field.
- `audit-governance-service/src/log-storage.ts` writes filesystem records by
  appending JSON lines to a day/service `logs.ndjson` file and stores only URI,
  offset, and byte count.
- The S3 storage path creates one NDJSON object per batch and uses AWS request
  signing to upload, but it does not persist the object content hash or an
  application-level signature in `observability_logs`.
- `routes-logs.ts` writes parsed/redacted records to Postgres and raw NDJSON
  storage, but there is no verification route that rereads the raw bytes and
  proves they still match the indexed row.
- Retention sweeps delete old indexed rows and filesystem partitions, but there
  is no legal-hold marker, evidence-hold policy, or signed deletion receipt for
  traces tied to governance evidence.
- The searched log tests cover redaction, route existence, and worker startup,
  but not raw-object hash verification, append-chain integrity, deletion
  receipts, or tamper detection.

Impact:

- `/operations/logs` can help operators troubleshoot, but the raw log lake is
  not strong enough to serve as authoritative governance evidence.
- A filesystem admin, buggy retention sweep, or object-store mutation can alter
  or remove raw NDJSON without the indexed row showing a broken hash chain.
- Investigators cannot prove that the raw log bytes behind a trace are the same
  bytes originally ingested.
- Compliance retention and litigation-hold needs conflict with a simple
  age-based sweep when workflow evidence traces must be preserved longer than
  the default log retention period.

Required fixes:

- Persist a content hash for each raw storage span or batch and include it in the
  indexed row.
- Add an append-only hash chain or Merkle batch manifest with producer identity,
  ingest time, row ids, storage URI, byte ranges, and previous batch hash.
- Sign batch manifests with an audit-governance signing key and expose a
  verification endpoint for trace/evidence bundles.
- Add legal/evidence hold metadata so retention sweeps skip logs tied to active
  investigations, approvals, or release evidence packs.
- Emit signed deletion receipts for expired log partitions and include them in
  Operations trust evidence.
- Add tests for raw byte verification, tamper detection, missing object
  detection, retention skip on hold, and signed deletion receipts.

### 257. Production preflight omits Platform Registry and log-egress posture checks

Evidence:

- `bin/check-deploy-env.sh` checks production-class settings such as
  `AUTH_PROVIDER=iam`, `AUTH_OPTIONAL=false`, `TENANT_ISOLATION_MODE=strict`,
  `REQUIRE_TENANT_ID=true`, fail-closed governance, tool grants, provider
  manifest signatures, tenant-scoped service tokens, audit-governance
  reachability, and WorkGraph tenant DB posture.
- Exact searches of `bin/check-deploy-env.sh`, `bin/check-deployment-env.sh`,
  `bin/doctor.sh`, and `bin/configure-platform.py` find no checks for
  `REGISTER_TOKENS`, `PLATFORM_REGISTER_TOKEN`, `PLATFORM_REGISTRY_URL`, or
  platform-registry production auth mode.
- `bin/check-deployment-env.sh` server mode checks core service tokens,
  backend URLs, governance mode, provider manifest mode, and private agent-source
  URL posture, but not Platform Registry auth/liveness or observability storage
  and export settings.
- Exact searches of the same deployment check scripts find no checks for
  `LOG_EXPORT_TARGETS_JSON`, `LOG_STORAGE_BACKEND`, `LOG_RETENTION_DAYS`,
  `LOG_EXPORT_ALLOW_INSECURE_HTTP`, or `LOG_EXPORT_ALLOW_PRIVATE_URLS`.
- `platform-registry/docker-compose.yml` keeps
  `REGISTER_TOKENS: "${REGISTER_TOKENS:-}"`, while
  `audit-governance-service/docker-compose.yml` exposes log storage/export
  knobs such as `LOG_STORAGE_BACKEND` and `LOG_EXPORT_TARGETS_JSON`.
- `docs/observability-log-lake.md` documents external Datadog/Splunk forwarding,
  but the deploy preflight does not prove any vendor target is policy-safe or
  that a durable central log storage backend is configured.

Impact:

- A production preparation run can pass while Platform Registry remains open to
  unauthenticated registration or while services are not securely registered.
- The same deploy can pass while log egress is globally enabled without tenant,
  data-class, or redaction policy.
- Operators may believe the production guardrail script covers all enterprise
  control-plane boundaries, while two evidence-sensitive boundaries remain
  outside the blocking preflight.

Required fixes:

- Add Platform Registry checks to `bin/check-deploy-env.sh` and
  `bin/check-deployment-env.sh`: non-empty strong register auth, no open
  registration in production, reachable registry when service discovery is
  enabled, and stale-health policy configured.
- Add observability checks: durable storage backend, explicit retention policy,
  export targets disabled by default, and policy metadata for every enabled
  external target.
- Fail production-class preflight when `LOG_EXPORT_ALLOW_INSECURE_HTTP=true` or
  `LOG_EXPORT_ALLOW_PRIVATE_URLS=true` unless an explicit break-glass evidence
  reference is supplied.
- Add doctor/preflight tests proving missing registry auth and unsafe log egress
  fail the production path.

### 258. Copilot setup scripts and docs still describe a retired gateway route

Evidence:

- `bin/check-deployment-env.sh` explicitly rejects
  `DEFAULT_PROVIDER=copilot` or `github_copilot` with the message:
  "Copilot is incorrectly configured as a Gateway provider" and tells operators
  to use `AGENT_TASK executor=copilot` plus `copilot_execute`.
- `bin/llm-use-copilot.sh` exits immediately with
  "Copilot gateway mode is retired. Copilot is executed only through an
  AGENT_TASK with executor=copilot..."
- The same `bin/llm-use-copilot.sh` file still contains extensive dead
  instructions and code for routing all LLM traffic through a Copilot
  OpenAI-compatible server via the LLM Gateway.
- `bin/setup-mcp-server.sh` still has a top-level example titled "Copilot
  through the bundled local OpenAI-compatible bridge", defines
  `start_copilot_bridge(...)`, and its preflight `case "$provider"` branch
  checks for a Copilot bridge and `bin/copilot-cli-server.js`.
- Later in the same `bin/setup-mcp-server.sh`, any `--provider copilot`,
  `--copilot-base-url`, `--copilot-token`, or `--start-copilot-bridge` exits
  with "Copilot gateway/bridge mode is retired."
- `docs/office-cloud-deployment.md` still says "Run LLM on this laptop via
  Copilot" by starting `npx copilot-api@latest`.
- `README.md` still contains older guidance about an OpenAI-compatible Copilot
  bridge and warns that the GitHub Copilot CLI is not an OpenAI-compatible HTTP
  server.

Impact:

- Fresh-clone users can follow checked-in docs or script examples that lead
  directly to a retired path and immediate script failure.
- Operators cannot tell whether Copilot should be configured as an LLM Gateway
  provider, a local bridge, GitHub Models, or the governed MCP
  `copilot_execute` path.
- A setup screen or support runbook can accidentally revive the gateway route
  even though runtime policy now blocks it, creating inconsistent demos and
  broken split-runtime setup.

Required fixes:

- Remove retired Copilot gateway code and examples from
  `bin/llm-use-copilot.sh` and `bin/setup-mcp-server.sh`, or move them behind an
  explicit legacy/development command that is not shown in normal help.
- Update `README.md`, `docs/office-cloud-deployment.md`, and provider setup docs
  so the only normal Copilot path is `AGENT_TASK executor=copilot` through the
  governed MCP `copilot_execute` tool.
- Rename any remaining OpenAI-compatible GitHub Models path so it is not called
  "Copilot" unless it is actually the governed Copilot CLI route.
- Add a docs/script drift test that fails if normal setup docs mention Copilot as
  an LLM Gateway provider or bridge.

### 259. Runtime preflight can pass with placeholder tenant metadata that disagrees with the JWT

Evidence:

- `bin/runtime-preflight.sh` sets
  `RUNTIME_TENANT_ID="${RUNTIME_TENANT_ID:-${TENANT_ID:-default}}"` before
  running required checks.
- The same script then calls `check_required RUNTIME_TENANT_ID`, so a missing
  tenant silently becomes the string `default` and passes.
- `bin/runtime-preflight.sh` validates the runtime token only for JWT shape,
  expiry, and `kind` being `runtime` or `device`.
- The token validation block does not compare JWT claims such as `runtime_id`,
  `device_id`, `sub`, `tenant_id`, `tenant_ids`, or allowed frame types against
  `RUNTIME_ID`, `RUNTIME_USER_ID`, `RUNTIME_TENANT_ID`, or
  `RUNTIME_BRIDGE_URL`.
- `bin/setup-mcp-server.sh check` is stricter in one direction: it warns when
  `tenant_id` is not configured, but it still delegates the full environment
  inventory to `check-deployment-env.sh` rather than making
  `runtime-preflight.sh` authoritative.
- Context Fabric correctly treats JWT claims as authoritative, so any local
  preflight mismatch is an operator/debugging problem, not something Context
  Fabric will reconcile from the hello metadata.

Impact:

- A multi-user or server-hosted MCP+LLM runtime can pass local preflight while
  the operator has not selected a real tenant.
- The runtime process can display or send `default` tenant metadata while
  Context Fabric routes by a different tenant claim or by a tenantless personal
  token.
- Troubleshooting becomes confusing: the terminal says the runtime is ready, but
  `/api/runtime-bridge/status` may show a different tenant/user/runtime identity
  or reject tenant-scoped work.
- Server-shared runtime deployments are especially prone to this because
  placeholder tenant metadata looks like a successful enterprise preflight.

Required fixes:

- Make `bin/runtime-preflight.sh` fail when tenant is missing in strict or
  shared-runtime mode instead of defaulting to `default`.
- Decode the JWT and compare token claims to configured runtime id, user id,
  tenant id, allowed frame types, and expiry.
- Show the token-derived identity as authoritative and mark local env values as
  mismatches when they differ.
- Add an explicit `--allow-personal-tenantless-runtime` or local-dev flag for
  compatibility with old laptop device tokens.
- Add tests for missing tenant, placeholder `default`, mismatched tenant claim,
  mismatched runtime id, expired token, and tenantless personal runtime mode.

### 260. Desktop and CLI runtime clients have divergent token storage and session contracts

Evidence:

- `workgraph-studio/apps/sgl-cli/src/index.ts` writes `token` directly into
  `~/.singularity/sgl.json` through `saveConfig()`.
- `singularity-desktop/src/App.tsx` stores the IAM bearer token in
  `window.localStorage` under `singularityDesk.token`.
- The same legacy desktop renderer keeps development credentials in code:
  `DEFAULT_EMAIL = admin@singularity.local` and
  `DEFAULT_PASSWORD = Admin1234!`, then offers a `Dev Login` button.
- `singularity-desktop/src/App.tsx` answers Workbench auth requests with
  `postMessage({ type: 'blueprintWorkbench.auth', token }, '*')`, so the bearer
  token is sent with a wildcard target origin.
- `clients/singularity-desktop/src/main.js` is a separate Electron app that uses
  `safeStorage`, but falls back to `Buffer.from(token, 'utf8')` when OS
  encryption is unavailable.
- The two desktop app folders (`singularity-desktop` and
  `clients/singularity-desktop`) present different maturity, security, and
  runtime models while both remain runnable.

Impact:

- Users and support teams can pick the weaker desktop path without realizing it.
- Bearer tokens can persist outside the platform web session contract and outside
  a revocation-aware keychain.
- Workbench token handoff can leak a platform bearer token to an unexpected
  window or embedded surface if a spoofed message source is present.
- Development defaults can accidentally become a real authentication path in a
  packaged or shared-machine desktop install.
- Enterprise policy cannot currently say, "this is the one supported desktop
  runtime client and this is how its token storage is certified."

Required fixes:

- Retire or hard-disable the legacy `singularity-desktop` app, or mark it as
  local-dev-only with startup refusal outside explicit development mode.
- Move CLI token storage to OS keychain where available, with strict file mode
  fallback and short-lived device/runtime tokens.
- Remove hard-coded development login defaults from desktop production builds.
- Replace wildcard Workbench token `postMessage` with exact origin validation and
  a one-time, audience-bound handoff token.
- Add a desktop/CLI security contract test that rejects new bearer-token
  `localStorage`, plaintext config, or wildcard token postMessage usage.

### 261. Laptop invocation APIs allow execution and completion with view-only WorkItem access

Evidence:

- `workgraph-studio/apps/api/src/modules/laptop/laptop.router.ts` mounts
  laptop start, heartbeat, complete, question, stream, wait, and answer routes
  behind only the generic `authMiddleware`.
- `startLaptopInvocation()` in
  `workgraph-studio/apps/api/src/modules/laptop/laptop.service.ts` loads the
  WorkItem and calls only `assertCanViewWorkItem(actorId, workItem)` before
  creating an `AgentRun`, minting an MCP session token, creating a
  `LaptopInvocation`, and emitting `STARTED`.
- `loadInvocationForActor()` also calls only `assertCanViewWorkItem()` before
  heartbeat, completion, question creation, question wait, and question stream.
- `completeLaptopInvocation()` updates the laptop invocation and sets the linked
  `AgentRun.status` to `APPROVED` when the client posts `COMPLETED`.
- `answerLaptopQuestion()` checks only WorkItem view access before recording the
  answer.
- `work-items.service.ts` already has action-specific guards such as
  `assertCanMutateWorkItem(..., 'start')`, `workflow:execute`,
  `workflow:submit`, and `workflow:approve`, but the laptop routes do not use
  those checks.
- `laptop.service.ts` defines `requireInvocationOwner()`, but the current route
  path does not call it.

Impact:

- A user who can view a WorkItem can start a laptop execution session even if
  they do not have `workflow:execute`.
- A user who can view the WorkItem and knows an invocation id can heartbeat or
  complete another user's laptop invocation because invocation ownership is not
  enforced.
- A viewer can answer open laptop questions without being the assigned owner,
  approver, or requested human-in-the-loop participant.
- Direct-Copilot completions can move agent evidence to `APPROVED` without the
  same policy gate used by governed workflow nodes.

Required fixes:

- Require `workflow:execute` or a dedicated `laptop:invoke` permission before
  starting a laptop invocation.
- Require invocation ownership, runner lease identity, or a service-scoped
  session token for heartbeat and completion.
- Require explicit question assignment or `workflow:approve`/`workflow:respond`
  permission before answering laptop questions.
- Use `assertCanMutateWorkItem()` or the centralized workflow authorization
  service instead of view-only checks for mutating laptop routes.
- Add regression tests where a viewer can list a WorkItem but cannot start,
  complete, heartbeat, or answer laptop-session questions.

### 262. Laptop invocation lifecycle updates are not fenced against stale or terminal sessions

Evidence:

- `recordLaptopHeartbeat()` updates a `LaptopInvocation` by id and unconditionally
  sets `status` to `RUNNING`.
- `completeLaptopInvocation()` updates the invocation by id and unconditionally
  writes `status`, `endedAt`, merged payload data, and linked `AgentRun`
  completion state.
- The heartbeat watchdog marks stale sessions as `ENDED`, but a later heartbeat
  can set the same row back to `RUNNING`.
- There is no compare-and-set condition on status, `userId`, heartbeat lease,
  work-item generation, source workflow generation, or cancellation state.
- There is no check that the WorkItem, target, workflow instance, or parent node
  is still active before accepting a late laptop completion.
- `LocalRetryQueue` in `workgraph-studio/packages/laptop-sdk/src/index.ts` can
  durably replay failed heartbeat and completion requests later, but the server
  side does not reject stale generation or terminal-state completions.

Impact:

- A stale laptop process can revive an ended session with a heartbeat.
- A queued retry can complete an invocation after the WorkItem was cancelled,
  rebased, reassigned, or superseded by a newer run.
- Multiple clients can race to complete the same invocation because completion is
  not guarded by terminal-state fencing.
- Evidence from a previous prompt, branch, binding, or WorkItem generation can be
  accepted as current.

Required fixes:

- Add explicit laptop invocation states and allowlisted transitions.
- Make heartbeat and completion conditional updates that include current status,
  owner/session token, tenant, and lease/generation fences.
- Reject heartbeats after terminal states such as `COMPLETED`, `FAILED`,
  `CANCELLED`, or `ENDED`.
- Reject completion if the WorkItem, target, source workflow node, or
  authorization snapshot is no longer current.
- Include generation and invocation-owner checks in the SDK retry replay path and
  server-side tests.

### 263. Laptop session rows are not tenant-stamped even though the schema has tenant fields

Evidence:

- `LaptopInvocation` in
  `workgraph-studio/apps/api/prisma/schema.prisma` has an optional `tenantId`
  column.
- `startLaptopInvocation()` creates the linked `AgentRun` with
  `tenantId: currentTenantIdForDb()`, but the subsequent
  `prisma.laptopInvocation.create()` call does not set `tenantId`.
- `LaptopQuestion` has no `tenantId` column at all; it is scoped only indirectly
  through `invocationId` and `workItemId`.
- The RLS cutover documentation focuses on six standalone-capable tables such as
  `agent_runs`, but `laptop_invocations` is a newer runtime-control table with
  tenant-sensitive prompts, MCP token ids, repo metadata, and completion payloads.
- Searches for `laptop_invocations` tenant stamping found the schema field and
  service routes, but no write-path assignment or RLS policy for the laptop
  session tables.

Impact:

- Operations, audit, and future RLS policies cannot reliably filter laptop
  sessions by their own tenant column.
- Tenant isolation depends on joining back through the WorkItem every time,
  which is brittle for logs, outbox deliveries, watchdog sweeps, and incident
  forensics.
- If a laptop invocation ever becomes detached from its WorkItem context, the row
  has no direct tenant anchor.
- A future developer can assume `LaptopInvocation.tenantId` is authoritative
  because it exists in the Prisma model, but current writes leave it null.

Required fixes:

- Set `tenantId` on every `LaptopInvocation` at creation from the request tenant
  or WorkItem tenant.
- Add `tenantId` to `LaptopQuestion` or enforce a tenant-aware RLS/join policy
  that is tested explicitly.
- Add indexes and RLS policies for laptop runtime-control tables before strict
  production cutover.
- Backfill existing laptop invocation rows from their WorkItem tenant.
- Add a migration/test that fails when new laptop invocation or question rows
  are created without tenant scope.

### 264. Direct-Copilot evidence can be accepted without trustworthy verification provenance

Evidence:

- `bin/copilot-execute.js` runs `copilot -p <task> --allow-all` inside the local
  workspace, then captures git status, diff, and summary as a receipt.
- The same script completes the platform invocation by posting arbitrary
  `payload` to `/laptop-invocations/:id/complete` with the user's platform
  bearer token.
- `singularity-desktop/electron/main.cjs` collects evidence by reading
  `git diff`, `git diff --stat`, and a 24 KB patch excerpt, but initializes
  `verificationReceipts` as an empty array.
- `singularity-desktop/src/App.tsx` warns that verification receipts are not
  captured automatically in the v1 evidence panel.
- `normalizeLaptopCompletionEvidence()` treats caller-supplied
  `verificationReceipts` as enough to clear the verification gap; the package
  tests confirm a supplied passing receipt changes `gap` to `false`.
- There is no server-side provenance check that the supplied receipt came from a
  governed runner, a signed local harness, a command allowlist, or an isolated
  execution environment.

Impact:

- Direct laptop execution can produce code-change evidence without a trusted
  test or verification trail.
- A compromised or buggy desktop/CLI client can mark a receipt as passing without
  the platform knowing what command actually ran.
- `--allow-all` gives Copilot broad local action capability, while the platform
  receives only post-hoc evidence.
- Governance gates can confuse "client supplied a passing receipt" with
  "platform verified the code under an approved harness."

Required fixes:

- Require signed or server-issued verification receipts for direct-Copilot
  completions in enterprise mode.
- Route local test execution through a governed harness with command allowlists,
  arguments as arrays, resource limits, and attested exit codes.
- Record receipt provenance, runner version, command digest, worktree base,
  output hash, and generated evidence hash.
- Treat client-supplied verification receipts as advisory unless an enterprise
  trust policy explicitly accepts that runner.
- Add negative tests proving a fabricated passing receipt cannot satisfy a hard
  verification gate.

### 265. Two desktop applications are maintained with incompatible runtime assumptions

Evidence:

- `singularity-desktop/package.json` defines a Vite/React Electron app named
  `singularity-desktop-workbench`.
- `clients/singularity-desktop/package.json` defines a second Electron app named
  `singularity-desktop`.
- `singularity-desktop/README.md` describes an independently packaged
  WorkItem execution app with Workbench Neo embedding, direct-Copilot mode, and
  runtime-policy requirements.
- `clients/singularity-desktop/README.md` calls that app a "prototype scaffold"
  and says allowed-path sandbox, scope-gated mint, per-action prompts,
  signing/notarization, and auto-update are still future work.
- The newer `clients/singularity-desktop/src/main.js` launches an MCP runner and
  optionally a local LLM gateway/shim, while `singularity-desktop/src/App.tsx`
  embeds Workbench Neo and starts Copilot directly through its Electron main
  process.
- The two apps use different ports, settings files, token storage mechanisms,
  pairing flows, and assumptions about whether MCP+LLM are the primary runtime
  bridge.

Impact:

- It is unclear which desktop runtime is canonical for laptop/cloud split
  deployments.
- Security work can land in one desktop path while users continue to run the
  other.
- Packaging, auto-update, runtime-policy enforcement, support docs, and tenant
  rollout cannot be certified against a single binary.
- Runtime bridge behavior observed by operators can differ by which desktop app
  a user installed.

Required fixes:

- Declare one desktop app canonical and move the other under an explicit
  `legacy/` or `experiments/` path with no production packaging.
- Consolidate runtime pairing, keychain storage, workspace consent,
  MCP+LLM launch, Workbench launch, and evidence upload into the canonical app.
- Add a desktop release checklist that covers signing, notarization, auto-update,
  minimum-version enforcement, runtime-policy enrollment, and tenant-scoped
  device revocation.
- Update scripts/docs so operators have one "install desktop runtime" path.
- Add a repository guard that fails if production docs reference the retired
  desktop client.

### 266. Workflow Operations does not show every event-driven WorkItem path

Evidence:

- `workflow-operations.router.ts` defines `INBOUND_EVENT_TYPES` as only
  `WorkflowInboundEventReceived`, `WorkflowInboundEventDeadLettered`,
  `WorkflowInboundEventFailed`, and `WorkflowInboundEventReplayed`.
- `/api/workflow-operations/events` reads only `EventLog` rows with those event
  types.
- The canonical authenticated intake route logs one of those
  `WorkflowInboundEvent*` rows after `fanOutToWorkItemTriggersDetailed(...)`.
- The WorkItem webhook receiver in `triggers.router.ts` creates or attaches a
  WorkItem, writes a `WorkItemEvent` with `eventType: 'TRIGGERED'`, updates
  `lastFiredAt`, and routes the WorkItem, but does not log a
  `WorkflowInboundEvent*` operation row.
- `TriggerScheduler.runWorkItemScheduleTriggers()` and
  `runWorkItemEventTriggers()` also create or attach WorkItems and route them
  through `TRIGGERED` WorkItem events, not `WorkflowInboundEvent*` operation
  rows.
- Legacy `WorkflowTrigger` webhook/schedule/event paths log
  `WorkflowTriggered` and possible `WorkflowTriggerStartFailed`, but those event
  types are also outside the Workflow Operations event inbox.

Impact:

- Operators using `/workflows/control-plane` can miss WorkItems and runs started
  by WorkItem webhooks, schedule triggers, internal outbox event triggers, or
  legacy workflow triggers.
- Replay Center cannot replay those paths from the same lifecycle table because
  they are not represented as `WorkflowInboundEvent*` rows.
- Event-driven incidents split across WorkItem timelines, workflow trigger logs,
  and canonical inbound-event rows, weakening the promised operations center.
- Readiness may show active `EVENT` or `WEBHOOK` triggers while the event inbox
  appears empty for those same trigger families.

Required fixes:

- Create a normalized workflow-operation event record for every trigger family:
  authenticated event intake, signed service ingress, WorkItem webhook,
  WorkItem schedule, WorkItem internal event trigger, and legacy workflow
  trigger.
- Include trigger family, trigger id, tenant, capability, source delivery id,
  correlation key, WorkItem id, workflow instance id, and replay eligibility.
- Make `/api/workflow-operations/events` query that normalized operation model
  instead of only `WorkflowInboundEvent*` audit rows.
- Add replay support or an explicit "not replayable from this surface" reason
  for schedule and webhook-originated work.
- Add tests proving each trigger type appears in Operations after it creates or
  routes work.

### 267. WorkItem webhook triggers have no first-class secret lifecycle

Evidence:

- `work-item-routing.router.ts` accepts `WorkItemTrigger` creation with
  `triggerType: 'WEBHOOK'`, `scheduleConfig`, and `payloadMapping`, but it does
  not require or generate a webhook secret.
- The public webhook receiver in `triggers.router.ts` tries to match WorkItem
  webhook triggers by checking `recordOf(t.scheduleConfig).secret` or
  `recordOf(t.payloadMapping).secret`.
- `WorkItemTrigger` stores `scheduleConfig` and `payloadMapping` as generic JSON
  fields; there is no typed `secretHash`, `secretId`, `createdBy`, `rotatedAt`,
  `lastUsedAt`, or `disabledReason`.
- `MetadataRegistryPage.tsx` exposes WorkItem trigger `scheduleConfig` and
  `payloadMapping` as raw JSON fields.
- By contrast, legacy workflow triggers auto-generate a webhook secret during
  `triggersRouter.post('/')` when the type is `WEBHOOK`.
- The webhook receiver must scan active workflow triggers and active WorkItem
  webhook triggers because the secret is hidden inside JSON rather than indexed
  or hashed.

Impact:

- A user can create an active WorkItem webhook trigger that has no usable secret
  and therefore cannot ever receive traffic.
- Operators must hand-edit JSON to create or rotate the trigger secret.
- Secrets are stored in plaintext JSON instead of a hashed or secret-managed
  field.
- Public webhook lookup cost grows with active trigger count and cannot use a
  unique index to reject duplicate secrets.
- There is no lifecycle evidence for when a secret was generated, revealed,
  rotated, revoked, or last used.

Required fixes:

- Add first-class WorkItem webhook credential fields: hashed secret, display
  handle, generated-at, rotated-at, last-used-at, and revoked/disabled status.
- Auto-generate a secret for WorkItem `WEBHOOK` triggers and reveal it only once.
- Store only a hash or external secret reference; never store reusable secrets in
  arbitrary JSON.
- Add indexed lookup by secret hash and tenant/trigger id instead of full scans.
- Add UI controls for generate, copy-once, rotate, disable, and audit history.
- Add tests for missing secret rejection, duplicate secret prevention, rotation,
  old-secret denial, and successful new-secret delivery.

### 268. GitHub PR webhook submission matching is global by repository, not tenant-scoped

Evidence:

- `github-webhook.router.ts` is public and validates a single
  `GITHUB_WEBHOOK_SECRET` before handling `pull_request` events.
- `handleGithubPullRequest(...)` queries
  `prisma.developmentTarget.findMany({ where: { status: 'PUBLISHED',
  repository: { equals: pr.repository, mode: 'insensitive' } } })`.
- `DevelopmentTarget` has a `tenantId` column and tenant index, but the GitHub
  webhook query does not filter by tenant.
- When multiple targets share the same repository, the service tries to
  disambiguate by finding a WorkItem code in the PR title, body, or head branch.
- If exactly one published target exists for a repository, the service accepts
  it without tenant context.
- The webhook registers a submission through `registerSubmission(...)` using the
  synthetic actor id `github-webhook`; it does not perform the user-route
  `loadAuthorizedWorkItem(..., 'submit')` check.
- The webhook result is not logged as a `WorkflowInboundEvent*` operation row,
  so tenant/operator replay and visibility depend on the submission and WorkItem
  timeline records.

Impact:

- In a multi-tenant deployment, a globally signed GitHub PR event can match any
  tenant's published development target for the same repository.
- Repository name plus WorkItem code becomes the effective tenant boundary.
- If two tenants use the same GitHub repository name pattern or a shared
  mono-repo, webhook correlation can skip, misroute, or register against the
  wrong tenant's WorkItem.
- A shared `GITHUB_WEBHOOK_SECRET` makes tenant rotation and revocation coarse:
  rotating one tenant's webhook secret can affect all tenants.
- Submission authorization for webhooks is not expressed as a tenant-scoped
  service principal permission.

Required fixes:

- Model GitHub webhook installations or repository bindings per tenant and
  capability.
- Use a tenant-scoped webhook secret or GitHub App installation id to select the
  tenant before querying `DevelopmentTarget`.
- Filter development targets by tenant and repository binding, not repository
  string alone.
- Register webhook submissions as a tenant-scoped service principal with
  explicit `workflow:submit` or `submission:register` permission.
- Emit normalized Workflow Operations events for webhook PR registration,
  including ignored, skipped, registered, rejected, and already-registered
  outcomes.
- Add tests for same repository across two tenants, global secret rotation,
  ambiguous WorkItem code, wrong installation id, and authorized tenant-specific
  registration.

### 269. Concept Archive embeddings bypass governed LLM/runtime egress controls

Evidence:

- `archive.service.ts` calls `resolveEmbedding(text)` during card staging when
  `CONCEPT_ARCHIVE_EMBEDDING_URL` is configured.
- `resolveEmbedding(...)` reads the target URL and bearer token directly from
  `CONCEPT_ARCHIVE_EMBEDDING_URL` and `CONCEPT_ARCHIVE_EMBEDDING_TOKEN`, then
  sends the staged concept title and summary to that URL with `fetch(...)`.
- The URL is not resolved through LLM Routing, Context Fabric, MCP runtime
  bridge, service-token policy, provider allowlists, or the board-ingestion SSRF
  guard.
- The function accepts any configured URL string, uses the same token for all
  tenants/archives, and has no tenant, project, capability, actor, trace, or
  data-classification context in the request.
- Non-OK responses, parsing issues, and network errors are swallowed and return
  `{}`, causing silent fallback to lexical duplicate detection.
- `docs/concept-archive.md` documents this as an optional embedding path and
  explicitly says embedding failure falls back to lexical checks.
- Search found no dedicated contract tests for URL allowlisting, private-network
  rejection, token scoping, tenant-specific embedding providers, audit events, or
  visible degraded status for this Concept Archive embedding path.

Impact:

- Sensitive early-stage strategy, customer evidence, assumptions, and concept
  summaries can leave WorkGraph through an arbitrary server-configured endpoint
  that is outside the platform's normal LLM/runtime governance model.
- A compromised or misconfigured embedding URL can become a data-exfiltration
  path from Synthesis without the runtime bridge, Context Fabric, or audit
  controls seeing the call.
- Because failures are silent, operators may believe semantic duplicate checks
  are active while the system is actually running lexical-only matching.
- A single global embedding token makes tenant-specific rotation, revocation,
  provider readiness, and egress evidence impossible.
- Evidence packs cannot prove which embedding provider/model was used, whether
  data was sent off-platform, or why a duplicate decision was lexical versus
  embedding-assisted.

Required fixes:

- Route Concept Archive embeddings through the same governed LLM/routing layer
  used by other model calls, or introduce a dedicated governed embedding
  provider registry with tenant/capability allowlists.
- Apply SSRF/private-network controls and provider allowlists before any
  embedding URL is contacted.
- Include tenant id, actor id, project id, primary capability id, trace id, data
  classification, and provider alias in every embedding request and receipt.
- Replace the global embedding token with environment-indirection plus
  tenant/provider policy, and never expose the secret value to API/UI responses.
- Surface embedding readiness and degraded lexical-only fallback in Operations
  and the Concept Archive UI.
- Add tests for unsafe URLs, localhost/private network targets, provider
  failures, token absence, tenant/provider routing, audit receipt emission, and
  lexical fallback visibility.

### 270. Studio co-edit relay accepts arbitrary opaque document streams under a visible project

Evidence:

- `studio-projects.router.ts` exposes
  `POST /projects/:projectId/coedit` with `docKey` as any non-empty string up
  to 120 characters and `updates` as up to 200 strings of 200,000 characters
  each.
- `syncCoedit(...)` in `studio-coedit.service.ts` only verifies that the caller
  can see the project through `getProject(projectId)`, then stores updates under
  the key `${projectId}::${docKey}` in an in-memory `Map`.
- The service does not validate that `docKey` refers to an existing board,
  specification section, archive card, room, or other first-class Synthesis
  resource.
- The server treats Yjs updates as opaque base64 strings and never decodes,
  validates, hashes, redacts, or bounds them beyond the per-request string
  length and a soft `MAX_LOG = 20_000` update cap.
- `useBoardDoc.ts` uses doc keys such as `board:<boardId>`, but the API accepts
  any caller-supplied doc key for the project, so hidden or typoed streams can
  be created without resource ownership.
- The co-edit log is memory-local and comments state that a multi-instance
  deploy would need a shared store; there is no persistent index, cleanup job,
  resource binding table, or audit event for arbitrary doc streams.
- Existing audit findings cover durable board-event divergence, but not this
  separate resource-binding and memory/authorization gap for arbitrary co-edit
  documents.

Impact:

- A user with access to one project can create opaque co-edit documents that are
  not tied to a governed board or Synthesis artifact, making them invisible to
  normal evidence, retention, audit, and cleanup paths.
- Typos or stale UI code can fork collaboration state into an untracked doc key,
  which makes board state harder to reconcile and support.
- Large opaque updates can consume process memory until the soft cap is reached,
  and the cap drops old updates in a way that can strand new joiners without a
  durable snapshot.
- Because updates are not typed or resource-bound, the platform cannot enforce
  per-board locks, archive freeze rules, DLP/redaction, sensitive-field
  controls, or resource-specific edit permissions on live collaborative edits.
- In horizontally scaled deployments, users connected to different API workers
  can see different live board states because the relay is process-local.

Required fixes:

- Replace free-form `docKey` with typed document references such as
  `{resourceType, resourceId, surface}` and verify that the referenced resource
  belongs to the project and the caller has edit access.
- Bind each live co-edit document to a durable row with tenant, project,
  resource id, lifecycle state, last activity, owner, retention policy, and
  cleanup status.
- Move co-edit updates to a shared store or durable event stream for
  multi-instance deployments, with snapshotting for late joiners.
- Enforce per-resource lifecycle guards, including board/branch status, archive
  freeze, specification lock, and read-only historical views before accepting
  updates.
- Add request-size, per-document, per-user, and per-tenant rate limits and
  memory quotas.
- Emit audit/activity records for doc creation, first sync, high-water updates,
  cleanup, and rejected writes.
- Add tests for wrong project/board pairs, arbitrary doc keys, locked resources,
  large update floods, multi-user late join, dropped-log recovery, and
  multi-instance behavior with a shared relay backend.

### 271. Policy Check nodes pass by default with a local allow engine

Evidence:

- `PolicyCheckExecutor.ts` resolves the node engine as
  `cfgString(node, 'engine') ?? cfgString(node, 'policyEngine') ??
  'local_allow'`.
- The only special engine implemented is `formal_verifier`; every other engine
  falls through to the default branch, updates the node to `COMPLETED`, and
  returns `{ policyCheck: { engine, status: 'PASSED' } }`.
- When `engine=formal_verifier` but formal verification is disabled,
  `recordFormalDisabledSkip(...)` is called, the node is completed, and the
  executor returns `passed: true` with `status: 'SKIPPED'`.
- The designer and node catalog label `POLICY_CHECK` as "Policy Check" and say
  it checks a governance policy before the workflow continues, but the runtime
  path does not call `governance-policy.service.ts`, IAM governance resolution,
  a named policy registry, or a typed rule evaluator.
- `GovernanceGateExecutor` now has richer policy, overlay, evidence, waiver,
  and formal-binding logic, but `POLICY_CHECK` remains a separate legacy
  executor with a pass-by-default path.
- Search found no audit entry or contract test proving `POLICY_CHECK` fails
  closed when the engine is missing, unknown, disabled, or points at a named
  policy that cannot be evaluated.

Impact:

- A workflow can contain a node that visually reads as a governance/policy gate
  while runtime behavior is a no-op pass unless the author explicitly chose the
  one implemented formal verifier engine.
- Typos such as `policyEngine: opa` or `engine: governance_policy` are not
  rejected; they are recorded as the engine name and treated as passed.
- In deployments where formal verification is disabled, a formal policy check
  reports skipped but still allows downstream release, push, or event-emission
  stages to continue.
- Operators comparing `POLICY_CHECK` and `GOVERNANCE_GATE` may assume both are
  enterprise gates, but they enforce very different contracts.

Required fixes:

- Make `POLICY_CHECK` either a compatibility alias for `GOVERNANCE_GATE` or a
  thin executor that evaluates a named active `GovernancePolicy`.
- Fail closed for missing, unknown, disabled, or unavailable policy engines in
  production/strict mode.
- Require explicit `mode: warn|block|audit` if a policy check is intended to be
  advisory; never default to pass.
- Surface `SKIPPED` policy checks as warnings or blocks in the run cockpit
  rather than full completion.
- Add tests for missing engine, unknown engine, formal disabled, named
  governance policy pass/fail, advisory mode, and strict-mode fail-closed.

### 272. Verifier nodes pass empty evidence by default

Evidence:

- `VerifierExecutor.ts` defaults `scope` to `PRIOR`, gathers consumables from
  immediately upstream nodes, and reads `requireDocuments` with fallback
  `false`.
- If no matching documents are found, the executor sets
  `const passed = !requireDocuments`.
- The returned output can be
  `{ verifier: { status: 'PASSED', total: 0, failed: 0, documents: [],
  note: 'No documents produced by the preceding stage to verify.' } }`.
- The node is not marked blocked unless `requireDocuments` is explicitly true.
- The UI labels `VERIFIER` as a governance/reliability node, and the executor
  comment says it verifies documents produced by preceding stages and blocks
  when any document fails standards.
- Search found no audit entry or contract test proving verifier nodes fail when
  expected evidence is missing.

Impact:

- A release/readiness workflow can include a Verifier node that appears to check
  design, QA, security, or compliance documents but passes because an upstream
  stage produced no consumables or used a mismatched document name.
- Optional-by-default verification makes template errors and broken artifact
  wiring look like successful verification.
- Downstream Governance Gate, Git Push, Event Emit, or Evidence Pack stages can
  rely on a "passed" verifier with zero documents reviewed.
- Operators must inspect the note and `total: 0` manually to notice that the
  verification step did not actually verify anything.

Required fixes:

- Make verifier nodes require at least one document by default in
  production/strict mode and in all release/security/readiness templates.
- Add explicit `allowEmpty: true` or `requireDocuments: false` as an advisory
  exception, and render it visually as advisory/no evidence.
- Validate node configuration at design time: selected document names or scopes
  should be resolvable from upstream artifacts or declared workflow outputs.
- Treat `total: 0` as a warning/block in the run cockpit, evidence pack, and
  workflow health views.
- Add tests for no upstream documents, mismatched filters, prior versus all
  scope, optional/advisory empty mode, and strict-mode missing evidence.

### 273. LLM routing rules can be active while pointing at nothing usable

Evidence:

- `llm-routing.router.ts` defines a static `TOUCH_POINTS` list and comments that
  adding a touch point is a code change because something must consume it.
- The route `ruleSchema` still accepts `touchPoint` as any non-empty string,
  `modelAlias` as any non-empty string, and `scopeId` as any string up to 200
  characters.
- `POST /api/llm-routing/rules` only rejects the retired `copilot` alias and
  missing non-default `scopeId`. It does not verify that the touch point is one of
  `TOUCH_POINTS`, that `modelAlias` maps to an enabled/credential-ready
  `LlmConnection` or catalog entry, or that USER/CAPABILITY scope ids exist,
  belong to the tenant, and are active.
- `GET /api/llm-routing/resolve` and the shared `resolveLlmRouting(...)` helper
  return only the selected `modelAlias`, not a resolved connection snapshot or a
  readiness decision.
- `workflow-operations.router.ts` marks the `llm-alias` readiness check as
  `ready` when `llmConnections > 0 || llmRules > 0`, so a single dangling route
  row can make the control plane look usable even when no runtime can call that
  provider.

Impact:

- An administrator can save typo touch points that no workflow surface consumes,
  typo model aliases that fail at runtime, or stale user/capability-specific
  routes that are never selected for the intended actor.
- Workflow launch, Direct LLM tasks, Agent Tasks, Workbench, and audit judges can
  pass readiness checks and then fall back late, fail late, or call a different
  default than the route author expected.
- Operations cannot distinguish "an LLM row exists" from "this touch point has a
  valid, tenant-scoped, credential-ready provider route."

Required fixes:

- Validate `touchPoint` against the canonical touch-point registry before storing
  routing rows.
- Resolve and persist a routing-rule readiness snapshot that includes rule id,
  connection id, provider, model, base URL class, credential env name, credential
  readiness, tenant id, and validation errors.
- Reject enabled rules whose `modelAlias` cannot be resolved to an enabled,
  approved, credential-ready connection or explicit catalog entry for the tenant.
- Validate USER and CAPABILITY scoped `scopeId` values against IAM/Agent-Tools
  ownership and active status before enabling the route.
- Change Operations readiness from row counts to per-touch-point route resolution
  checks, and add tests for typo touch point, missing alias, disabled alias,
  missing credential env value, inactive capability, and cross-tenant scope ids.

### 274. Context Fabric registers the wrong authentication contract in the platform registry

Evidence:

- `context_api_service/app/main.py` self-registers Context Fabric with
  `auth_mode: "none"` and `health_path: "/health"` on startup.
- The same service's execution router requires a service token whenever the
  environment is production-class or `REQUIRE_TENANT_ID=true`; missing
  `IAM_SERVICE_TOKEN` returns `503`, and an invalid or missing caller token
  returns `401`.
- Runtime Bridge HTTP control-plane routes independently require one of the
  configured Context Fabric/IAM service tokens unless an explicit non-production
  `RUNTIME_BRIDGE_ALLOW_UNAUTHENTICATED_HTTP` escape hatch is enabled.
- Runtime WebSocket connect requires a runtime/device JWT with `kind`, `sub`,
  runtime id, and allowed frame types.
- Other services advertise stronger registry auth modes: WorkGraph uses
  `bearer-iam` or `bearer-static`, Prompt Composer and Agent Runtime use
  `bearer-iam`, and MCP uses `bearer-static`.

Impact:

- Operations live maps and service-discovery consumers can show Context Fabric as
  unauthenticated even when its critical execution and runtime bridge APIs are
  token-protected.
- Operators troubleshooting runtime dial-in or `/execute` failures can be pointed
  at the wrong contract: the registry says "none" while the API returns
  `401`/`503` for missing service tokens.
- Future clients that trust the registry may omit required service-token or
  runtime-JWT setup and fail late, or incorrectly classify Context Fabric as a
  public/open service in readiness and trust evidence.

Required fixes:

- Register Context Fabric with route-aware authentication metadata, at minimum
  `bearer-iam` or `bearer-static` for service-token HTTP APIs and
  `runtime-jwt` for `/api/runtime-bridge/connect`.
- Split public health metadata from protected execution/control-plane contracts
  rather than using one service-level `auth_mode` for every route.
- Add a registry contract test that compares Context Fabric's advertised
  `auth_mode` with `check_execute_service_token(...)`,
  `check_runtime_bridge_service_token(...)`, and runtime JWT handshake behavior.
- Make Operations render "Public health, protected execution" instead of a single
  misleading service auth badge.

### 275. Approval form submissions can relink arbitrary documents into approval evidence

Evidence:

- `POST /api/approvals/:id/form-submission` checks that the approval request is
  pending and that the caller may decide the approval.
- When `attachmentIds` are supplied, the route runs
  `tx.document.updateMany({ where: { id: { in: attachmentIds },
  ...(found.instanceId ? { instanceId: found.instanceId } : {}) },
  data: { nodeId: found.nodeId, instanceId: found.instanceId } })`.
- The route does not call `assertDocumentTenant(...)` for each document id, does
  not require `uploadedById === req.user.userId` or an attachment permission, and
  does not check that the update count equals the requested attachment count.
- If the approval has an `instanceId`, any document already attached somewhere in
  that workflow instance can be moved into the approval node's evidence by any
  eligible approver. If the approval is a tenant-scoped non-instance approval,
  the `where` clause falls back to only `id in attachmentIds`.
- `documents.router.ts` is stricter for deletion: only the uploader or an admin
  can delete a document, showing that document ownership is treated as meaningful
  elsewhere.

Impact:

- An approver can attach, or effectively reclassify, another user's workflow
  document as approval evidence without the uploader's consent or a document-level
  permission check.
- Missing or cross-context attachment ids can be silently ignored, so the UI may
  tell the user attachments were submitted while the stored approval evidence is
  incomplete.
- In regulated flows, approval evidence can be contaminated by documents from
  unrelated nodes in the same run, weakening the proof of exactly what the human
  reviewed when approving or rejecting.

Required fixes:

- Resolve every `attachmentId` first and require a full count match before
  mutating any document rows.
- Enforce tenant, workflow instance, node/task context, uploader ownership, or an
  explicit `approval:attach_document` / `document:attach_to_approval` permission
  for each attachment.
- Avoid moving existing document ownership/context when attaching to approvals;
  use a join table such as `ApprovalAttachment` with immutable document id,
  approval request id, attachedBy id, timestamp, content hash, and evidence role.
- Add tests for another user's document, wrong node document, wrong instance
  document, missing document id, non-instance approval attachment, and partial
  update-count mismatch.

### 276. Governed single-turn direct LLM bypasses pre-call governance gates

Evidence:

- The legacy Context Fabric `/execute` path computes `governance_mode`, then
  calls `fail_closed_precheck(...)` before prompt composition, tool discovery,
  MCP dispatch, or model execution.
- The same legacy path blocks invalid required context plans in
  `governance_mode=fail_closed`, allows a degraded posture only when requested,
  and returns `WAITING_APPROVAL` for `human_approval_required` context-plan
  approval.
- `POST /api/v1/execute-governed-single-turn` computes `governance_mode` and
  extracts `governance_overlay`, but then immediately chooses either
  `call_direct_chat(...)` or `call_gateway_chat(...)`.
- When `run_context.llm_route` selects the Context-Fabric-direct route,
  `call_direct_chat(...)` reads provider configuration and credentials from
  server environment variables and calls the provider directly.
- The single-turn endpoint emits `governed.turn_completed` after the provider
  call and includes `governanceMode`, `governanceOverlay`, and `llmRoute` in the
  audit payload, but it does not perform the legacy fail-closed audit precheck,
  required-context validation, human-approval pause, or overlay enforcement
  before the direct provider call.
- Existing audit findings cover direct LLM routing/evidence drift and WorkGraph
  budget preflight gaps, but not this Context Fabric single-turn pre-call
  governance bypass.

Impact:

- A node can be labeled as a governed single turn while direct-provider egress
  has already happened before audit/governance readiness is proven.
- `governance_mode=fail_closed` is weaker on the single-turn endpoint than on
  `/execute`, which gives operators two different meanings for the same setting.
- `human_approval_required` cannot pause the direct single-turn call before the
  model sees prompt and document context.
- Governance overlays and waivers become after-the-fact evidence fields instead
  of an enforcement boundary for this route.
- Regulated Direct LLM verifier or co-work nodes can bypass the stricter Context
  Fabric path even when the UI and receipts call them governed.

Required fixes:

- Reuse the same pre-call governance gate for `/execute` and
  `/api/v1/execute-governed-single-turn`: strict audit precheck, required
  context-plan validation, human-approval pause, and overlay enforcement.
- Add a `governance_required=true` or equivalent flag to the single-turn request
  and fail closed when the overlay is missing, stale, advisory-only, or cannot be
  resolved.
- For direct LLM routes, evaluate the direct-provider connection, credential env,
  data classification, prompt source, and context artifacts before any provider
  call.
- Make single-turn responses distinguish `governed`, `governed_degraded`,
  `approval_paused`, and `context_fabric_direct_unverified` instead of always
  returning `executionPosture: governed`.
- Add tests for single-turn direct LLM with audit-governance down,
  fail-closed mode, human-approval-required mode, missing governance overlay,
  advisory overlay, and a permitted overlay.

### 277. Specification generation LLM calls use a static capability instead of the WorkItem capability

Evidence:

- The WorkGraph `WorkItem` model stores `parentCapabilityId` and target records,
  and the `SpecificationProject` model stores the required
  `primaryCapabilityId`.
- The specification generator's default LLM client calls Context Fabric
  `executeGovernedTurn(...)` with `run_context.capability_id` set to
  `process.env.SPEC_GEN_CAPABILITY_ID ?? 'spec-author'`.
- `generateSpecificationDraft(...)` loads only `id`, `workCode`, `title`,
  `description`, and `tenantId` for the WorkItem before calling the generator.
  It does not load `parentCapabilityId`, WorkItem targets, `projectId`, or the
  linked `SpecificationProject.primaryCapabilityId`.
- Other governed-turn callers in WorkGraph pass caller-owned capability context:
  the planner sends the selected home capability, and contract replay sends the
  request's `capabilityId`.
- The Context Fabric client contract treats `run_context.capability_id` as a
  required execution context field for governed execution.
- The audit did not already contain a specific finding for spec-generation
  capability attribution; related entries covered broader direct LLM and
  budget/governance issues.

Impact:

- Generated specification drafts can be billed, routed, authorized, audited, and
  budgeted under `spec-author` or a global environment capability instead of the
  initiative or WorkItem capability that owns the work.
- Capability-specific LLM routing, runtime placement, provider allowlists, data
  classification, prompt policy, and token budgets can be silently bypassed.
- Multi-tenant or multi-capability deployments cannot explain which business
  capability caused a spec-generation model call from Context Fabric receipts
  alone.
- If `SPEC_GEN_CAPABILITY_ID` is missing, the literal `spec-author` may not map
  to an active IAM capability, creating inconsistent behavior between local
  setup and enterprise deployments.

Required fixes:

- Resolve the effective capability for spec generation from the WorkItem in this
  order: explicit request capability if allowed, active WorkItem target,
  `parentCapabilityId`, linked `SpecificationProject.primaryCapabilityId`, then
  fail closed.
- Include `tenant_id`, `project_id`, specification version id, and the resolved
  capability in the Context Fabric `run_context` and trace/audit payload.
- Remove the `spec-author` fallback from production mode; keep any platform
  default only behind an explicit local/demo flag.
- Add tests for WorkItem-only, project-owned, multi-target, missing-capability,
  inactive-capability, and cross-tenant spec-generation cases.

### 278. Event verifier demo endpoints can install active workflow automation without workflow authoring authorization

Evidence:

- `app.ts` mounts `/api/demo/event-verifier` behind `authMiddleware`, but there
  is no feature flag, demo-only environment guard, service-principal check, or
  workflow-authoring permission check around the router.
- `POST /api/demo/event-verifier/setup` resolves any visible active capability
  or accepts an explicit `capabilityId`, then creates or reuses a Verifier agent.
- The same setup path calls `upsertVerifierWorkflow(...)`, which directly
  creates or updates an `ACTIVE` workflow, rewrites its design nodes/edges, marks
  it `isDefaultForType`, and sets `defaultRoutingMode: AUTO_START`.
- The setup path also calls `upsertEventTrigger(...)`, which creates or updates
  an active event trigger with `routingMode: AUTO_START`.
- `POST /api/demo/event-verifier/ingest` and `/simulate` create or attach a
  WorkItem from the trigger payload, then call `routeWorkItem(...)` as
  `systemRouteActor('demo-verifier')`.
- `routeWorkItem(...)` skips IAM `workflow:assign` checks for any actor in
  `SYSTEM_ROUTE_ACTORS`; `system:demo-verifier` is part of that allowlist.
- `WORKFLOW_INTERNAL_AUTOMATION_ENABLED` defaults to true, so the bypass is
  enabled unless an operator explicitly disables internal automation.
- The audit already covered event-created WorkItems being mislabeled as local
  work, but not this demo setup and system-route authorization bypass.

Impact:

- Any authenticated user who can see a capability can potentially install an
  active auto-start workflow, routing policy, and event trigger for that
  capability without `workflow:create`, `workflow:edit`, `workflow:publish`,
  `workflow:route`, or trigger-management permissions.
- Demo infrastructure can silently become production automation: inbound events
  may start verifier Direct LLM workflows, emit callbacks, and create approval
  work before the capability owner approved the template.
- Because `system:demo-verifier` bypasses normal route/claim IAM checks, the
  resulting WorkItem start evidence names a platform automation principal rather
  than proving the initiating user was authorized for the target capability.
- Disabling all internal automation to close this path also disables legitimate
  scheduler/trigger automation, so operators do not have a narrow kill switch.

Required fixes:

- Put `/api/demo/event-verifier/*` behind an explicit
  `WORKGRAPH_DEMO_ENDPOINTS_ENABLED=true` flag and refuse it in production-class
  environments.
- Require capability-scoped permissions before setup:
  `workflow:create`, `workflow:edit`, `workflow:publish`,
  `workflow:routing_policy:manage`, `workflow:trigger:manage`, and
  `agent:profile:create` as applicable.
- Replace `system:demo-verifier` with a scoped service principal that carries
  tenant id, capability id, trigger id, and allowed actions, and records the
  initiating user in the route/start authorization snapshot.
- Make demo-created workflows and triggers default to `DRAFT` or
  `INACTIVE_DEMO` until a capability owner explicitly enables them.
- Add tests proving a normal authenticated viewer cannot run setup, ingest, or
  simulate for a capability unless they have the required authoring and routing
  permissions.

### 279. The tested WorkItems console is not the live `/work-items` route

Evidence:

- `agent-and-tools/web/src/app/work-items/page.tsx` renders
  `LegacyWorkItemsRoute`.
- `LegacyWorkgraphAdminRoute.tsx` imports `WorkItemsPage` from
  `workgraph-web/features/runtime/WorkItemsPage` and returns it from
  `LegacyWorkItemsRoute`.
- `agent-and-tools/web/src/components/workflows/WorkItemsConsole.tsx` contains
  the newer Platform Web WorkItems console with Agent-and-Tools capability
  dropdowns, template diagnostics, event history, and a contract-bound
  execution panel.
- Repository route search shows no app page importing `WorkItemsConsole`; the
  direct imports are contract tests such as
  `work-items-normalization.contract.test.ts`,
  `work-items-template-status.contract.test.ts`, and
  `work-item-capability-picker.contract.test.ts`.
- Those tests assert behavior on `WorkItemsConsole`, while the actual
  `/work-items` route continues to use the legacy Workgraph page. Some
  protections are duplicated in the legacy page and API, but the tested
  contract-bound WorkItems console is not what users open from navigation.

Impact:

- A test can pass for the WorkItems UX while the canonical Work Hub still
  renders a different component.
- Users see WorkItem creation, routing, contract-bound evidence, and capability
  selection through a different mental model than the one the Platform Web
  tests describe.
- Future fixes may continue landing in `WorkItemsConsole` without improving the
  live `/work-items` experience.

Required fixes:

- Choose one canonical WorkItems surface.
- Either wire `WorkItemsConsole` to `/work-items` and retire the legacy wrapper,
  or delete/merge `WorkItemsConsole` and move its tests/features onto the live
  `workgraph-web` page.
- Add a route-level contract test proving `/work-items` renders the intended
  Work Hub component and includes the expected capability, routing, evidence,
  and contract-bound controls.

### 280. Routing policies and WorkItem triggers use broad workflow permissions instead of automation-specific permissions

Evidence:

- `workflowTemplate.ts` maps generic workflow actions to IAM permissions:
  `edit` becomes `workflow:update`, `delete` becomes `workflow:delete`, and
  `route` / `claim` become `workflow:assign`.
- `assertCapabilityPermission(...)` accepts a generic `WorkflowAction` and
  applies that generic permission to any supplied `resourceType`; it does not
  switch `WorkItemRoutingPolicy` or `WorkItemTrigger` to a dedicated permission
  vocabulary.
- `work-item-routing.router.ts` creates and updates routing policies with
  `assertCapabilityPermission(..., 'edit', 'WorkItemRoutingPolicy', ...)` and
  deletes them with `assertCapabilityPermission(..., 'delete',
  'WorkItemRoutingPolicy', ...)`.
- The same router creates, updates, and deletes WorkItem triggers with generic
  `edit`, `create`, and `delete` checks. Capability-less triggers are checked
  against `__platform__`, but still through the generic workflow permission map.
- `singularity-iam-service/app/seed/default_permissions.py` seeds workflow
  permissions such as `workflow:create`, `workflow:update`,
  `workflow:delete`, `workflow:execute`, `workflow:assign`,
  `workflow:event:publish`, and operations permissions, but it does not seed
  `workflow:routing_policy:*` or `workflow:trigger:*` permissions.
- The default `workflow_designer` role includes `workflow:update`, so the same
  capability role used to edit workflow templates can also be enough to change
  routing policies and event/schedule/webhook trigger definitions.

Impact:

- Template design authority is coupled to production automation authority. A
  user who should only edit workflow structure may also be able to change which
  WorkItems auto-route, which workflows auto-start, and which external events
  create work.
- Enterprises cannot grant or revoke trigger/routing administration separately
  from workflow template updates.
- Audit evidence says the user had `workflow:update` or `workflow:delete`, not
  that they had explicit authority to manage event intake and routing
  automation.
- The safer checks already added for target workflow startability do not solve
  this separation-of-duties problem; they only prove the selected workflow can
  be started.

Required fixes:

- Add dedicated IAM permissions such as `workflow:routing_policy:view`,
  `workflow:routing_policy:manage`, `workflow:routing_policy:delete`,
  `workflow:trigger:view`, `workflow:trigger:manage`, and
  `workflow:trigger:delete`.
- Replace the generic `WorkflowAction` mapping for `WorkItemRoutingPolicy` and
  `WorkItemTrigger` with resource-specific authorization helpers and decision
  logging.
- Update default roles so workflow designers can design templates without
  automatically owning event intake and routing automation; create a separate
  workflow automation administrator role.
- Add regression tests proving a user with `workflow:update` but without the
  trigger/routing permissions cannot create, edit, delete, activate, replay, or
  auto-start routing automation.

### 281. Governance Gate receipts lose active policy evaluation identity and advisory details

Evidence:

- `GovernanceGateExecutor.activateGovernanceGate(...)` calls
  `evaluateActiveGovernancePolicies(...)` before resolving local and overlay
  controls.
- `evaluateGovernancePolicy(...)` creates durable `GovernancePolicyEvaluation`
  rows with `policyId`, `policyVersion`, `instanceId`, `nodeId`, `workItemId`,
  `evidence`, `missing`, and `result`.
- The gate converts only `policyEvaluation.blocked` into local blocking controls
  with control keys like `POLICY:${policy.id}:${key}`. Those controls include the
  policy id in a string, but not the policy version, evaluation id, evaluated
  status, evidence digest, or full missing/check result.
- Advisory policy results are not converted into checks at all. The executor only
  appends a note such as `"N advisory governance policy warning(s)"` to
  `gate.note`.
- `blockNode(...)` and `emitNonBlock(...)` create `GOVERNANCE_GATE_EVIDENCE`
  receipts containing only `instanceId`, `nodeId`, `status`, `mode`, `checks`,
  and `blocked`. They do not include `GovernancePolicyEvaluation` ids, active
  policy ids/versions, or advisory warning details.
- The run viewer's blocked-detail extraction reads generic keys such as
  `approvalRequestId`, `code`, `blockedCode`, and `retryable`, but there is no
  searched UI path that links a Governance Gate node to the persisted
  `GovernancePolicyEvaluation` rows.

Impact:

- A run can correctly evaluate an active governance policy, but the main gate
  evidence shown in receipts and the run cockpit cannot prove exactly which policy
  version and evaluation row caused the warning or block.
- Advisory governance policy warnings become a count, not actionable evidence;
  operators cannot see which advisory policy warned, what was missing, or whether
  it was intentionally accepted.
- Blocking controls from policies are harder to audit because the policy id is
  embedded in a synthetic control key rather than linked to an immutable
  policy-version/evaluation record.
- Evidence packs and trace views may show a Governance Gate pass/warn/block
  without enough correlation to reconstruct the governed policy decision later.

Required fixes:

- Add `policyEvaluations` to the Governance Gate output with
  `evaluationId`, `policyId`, `policyVersion`, `policyName`, `mode`, `status`,
  `missing`, `checks`, and an evidence/content digest.
- Include both blocked and advisory policy evaluations in
  `GOVERNANCE_GATE_EVIDENCE` receipts and outbox payloads.
- Convert advisory warnings into first-class gate checks with severity `warning`,
  while keeping them non-blocking under advisory mode.
- Update the run cockpit and trace cockpit to link Governance Gate policy checks
  to the persisted `GovernancePolicyEvaluation` row and active policy version.
- Add tests for blocking policy, advisory policy, mixed overlay-plus-policy gate,
  policy evaluation failure, and evidence-pack reconstruction from only receipts
  plus evaluation ids.

### 282. Template migrations can relabel active runs without migrating runtime topology

Evidence:

- `workflowDebugRouter.post('/templates/:id/migrations', ...)` accepts
  `applyToInFlight`.
- The route requires template `edit` permission, but there is no separate
  migration, runtime-mutation, operations, or approval permission.
- `createTemplateMigration(...)` validates only that every old graph snapshot
  node id has a corresponding new graph snapshot node id.
- When `applyToInFlight` is true, the service finds active runs with
  `status in ['DRAFT', 'ACTIVE', 'PAUSED']` and updates only
  `WorkflowInstance.templateVersion` plus a `_templateMigration` object in
  `context`.
- The service does not rewrite `WorkflowNode`, `WorkflowEdge`, `WorkflowPhase`,
  node configs, edge conditions, node type snapshots, pending executions,
  checkpoints, authorization snapshots, or `graphGeneration`.
- The `WorkflowTemplateMigration` row stores `nodeMap` and `status`, but no
  safety-analysis result, approval id, migration digest, affected-run list, or
  per-run application status.

Impact:

- A run can claim to be on template version N while its actual executable graph
  remains the cloned topology from version N-1.
- Run cockpits, evidence packs, replay, budget attribution, and migration reports
  can disagree about which version really executed.
- Active and paused runs can be changed by a template editor without an explicit
  governed runtime-mutation proposal.
- Pending external/client nodes may keep old node ids/config while the migration
  context advertises a new mapping, making runner completion and replay harder to
  trust.
- Enterprise operators cannot reconstruct which in-flight runs were safely
  migrated, skipped, failed, or approved.

Required fixes:

- Treat in-flight template migration as a governed graph-mutation proposal, not a
  direct debug update.
- Require an explicit permission such as `workflow:migration:apply` or
  `workflow:runtime_mutation:approve`.
- Store migration digest, safety analysis, approval decision, affected run ids,
  per-run status, and before/after graph hashes.
- Either actually migrate runtime nodes/edges/phases with fencing and
  `graphGeneration` increments, or mark the migration as metadata-only and keep
  `templateVersion` unchanged for already-cloned runs.
- Add tests for active, paused, pending-execution, completed, failed, and
  cross-tenant runs, plus a test proving a template editor cannot apply an
  in-flight migration without the runtime-mutation permission.

### 283. Workflow time-travel GET creates persistent forensic snapshots

Evidence:

- `workflowDebugRouter.get('/instances/:id/time-travel', ...)` calls
  `createTimeTravelSnapshot(...)`.
- `createTimeTravelSnapshot(...)` inserts a new `WorkflowTimeTravelSnapshot` row
  every time it is called.
- The persisted snapshot includes checkpoint context, node states, routing
  decisions, prompt references, policy snapshot, and artifact references derived
  from workflow events matching `ARTIFACT`, `DOCUMENT`, or `RECEIPT`.
- The permission used for both GET and POST time-travel is the generic
  `checkpoint` action.
- `checkpoint` maps to IAM permission `workflow:update`, not to a dedicated
  forensic-read, audit, debug, or evidence-export permission.
- The function does not record a normal audit event or outbox event for the
  snapshot creation.

Impact:

- A nominally read-style GET request mutates durable forensic state, so page
  refreshes, crawlers, or preview panels can create many snapshots.
- Users with workflow update rights can materialize historical context, prompt
  references, and artifact payload references without an explicit audit/evidence
  export permission.
- Retention, storage growth, and sensitive-evidence minimization are hard to
  enforce because snapshot creation is hidden behind a read endpoint.
- Operators cannot distinguish a deliberate forensic capture from a UI refresh
  because no audit/outbox event records why the snapshot was created.

Required fixes:

- Make GET time-travel a pure computed preview that does not persist rows.
- Keep persistent snapshot creation behind POST only, with an explicit reason and
  permission such as `workflow:debug:snapshot` or `workflow:audit:capture`.
- Redact artifact/prompt references unless the caller has the corresponding
  sensitive-evidence permission.
- Emit an audit/outbox event containing actor, tenant, instance id, checkpoint id,
  reason, redaction mode, and snapshot id.
- Add tests proving GET is idempotent and non-mutating, POST is permission-gated,
  and sensitive references are redacted for non-auditors.

### 284. Workflow checkpoints and replay records are not tenant-stamped

Evidence:

- `WorkflowCheckpoint` has `instanceId`, `sequence`, `nodeStates`, `context`,
  `traceId`, `reason`, and `createdById`, but no `tenantId`.
- `WorkflowReplay` has `instanceId`, `checkpointId`, `requestedById`, `status`,
  `input`, `result`, and `error`, but no `tenantId`.
- The migrations that create `workflow_checkpoints` and `workflow_replays` add
  indexes only on instance/checkpoint fields; searched migrations do not add
  tenant columns or forced RLS policies for these tables.
- `createWorkflowCheckpoint(...)`, `listWorkflowCheckpoints(...)`, and
  `replayWorkflow(...)` rely on the caller's instance-level tenant check and the
  current transaction tenant context, but they never persist tenant evidence onto
  checkpoint or replay rows.
- Newer debug tables such as `WorkflowTimeTravelSnapshot` and
  `WorkflowTemplateMigration` do include tenant fields, making checkpoint/replay
  the outliers in the workflow-debug data family.

Impact:

- Database-level tenant isolation cannot be enforced directly on checkpoint and
  replay rows.
- Admin/reporting/export code that queries checkpoint or replay rows without an
  instance join can accidentally cross tenant boundaries.
- Replay and forensic evidence lacks a first-class tenant stamp, making audit
  reconstruction depend on the current instance relation rather than immutable
  row-local provenance.
- Backups, retention jobs, tenant data export, and tenant deletion jobs have to
  infer ownership through joins instead of filtering by tenant.

Required fixes:

- Add `tenantId` to `WorkflowCheckpoint` and `WorkflowReplay`, backfilled from
  `WorkflowInstance.tenantId`.
- Update checkpoint and replay writes to persist tenant id and reject mismatched
  tenant context.
- Add forced RLS policies and tenant indexes for both tables.
- Include tenant id in replay/checkpoint audit events and trace exports.
- Add tests for cross-tenant checkpoint list/create/replay denial, tenant data
  export, and direct DB RLS rejection without an instance join.

### 285. Generation plan partial retry can downgrade an already-applied plan to failed

Evidence:

- `POST /generation-plans/:planId/apply` allows retry when a plan is in
  `VALIDATED` or `PARTIAL`.
- The route initializes `let applied = 0` for the current HTTP request.
- When a row already has `row.workItemId`, the route records the row in `byKey`,
  ensures its capacity allocation, and then `continue`s without incrementing
  `applied`.
- New row failures are caught per row and stored as `GenerationPlanRow.state =
  'FAILED'`.
- After the loop, the plan status is computed only from the current request's
  newly applied count:
  `applied === plan.rows.length ? 'APPLIED' : applied > 0 ? 'PARTIAL' : 'FAILED'`.
- Therefore, retrying a `PARTIAL` plan where earlier rows already have WorkItems
  and the remaining rows fail again will set the whole plan to `FAILED`, even
  though some rows are still applied and linked to WorkItems.
- The `GenerationPlanStatus` enum includes `PARTIAL`, `APPLIED`, and `FAILED`,
  but the retry computation does not count persisted row state or existing
  `workItemId`s when deciding the aggregate state.

Impact:

- Operators can see a plan marked `FAILED` while it has already-created
  WorkItems, bindings, scopes, handoffs, dependencies, or capacity allocations.
- Dashboards and readiness checks that key off `GenerationPlan.status` can hide
  or misclassify partially delivered work.
- A retry after transient row failure can make the aggregate state less accurate
  than before the retry.
- Evidence packs may have to infer truth from row state and WorkItems instead of
  trusting the plan aggregate.

Required fixes:

- Compute final plan status from the persisted row set after the attempt:
  applied rows are rows with `state = APPLIED` or `workItemId IS NOT NULL`;
  failed rows are rows with terminal failure and no WorkItem.
- Do not allow a plan with any applied rows to downgrade to `FAILED`; keep it
  `PARTIAL` until all rows apply or an explicit operator abandons the remainder.
- Store retry attempt metadata separately from durable row outcome so "failed
  this attempt" and "failed overall" are not conflated.
- Add tests for retrying `PARTIAL` plans with already-applied rows, all remaining
  rows failing, and all remaining rows later succeeding.

### 286. Capability impact assessment reruns are not leased or budget-fenced

Evidence:

- Initiative creation returns `201` and then starts
  `runCapabilityImpactAssessments(...)` as a detached background promise.
- The same project exposes `POST /projects/:projectId/impact-assessments/run`,
  which calls `runCapabilityImpactAssessments(...)` synchronously and returns
  `202`.
- `runCapabilityImpactAssessments(...)` reads `project.tokenUsed` and
  `project.costUsedUsd` once into local variables, then checks remaining budget
  before each model call.
- Before calling the LLM it upserts the single
  `(projectId, capabilityId)` `CapabilityImpactAssessment` row to `RUNNING` and
  clears `summary`, `recommendations`, `risks`, `dependencies`, `suggestedClaims`,
  `traceId`, tokens, cost, error, and `assessedAt`.
- There is no assessment-run attempt table, idempotency key, lease, status
  compare-and-set, `startedById`, `leaseUntil`, or "already running" guard.
- After the LLM call, each concurrent caller updates the same assessment row to
  `COMPLETED` or `FAILED`, increments `SpecificationProject.tokenUsed`, and
  optionally increments `costUsedUsd`.
- The Prisma model has a unique row per `(projectId, capabilityId)`, but no
  durable attempt identity for multiple runs of that row.

Impact:

- A create-triggered background assessment and a manual rerun can execute the same
  capability-agent assessment at the same time.
- Concurrent runs can overspend initiative token/cost budgets because each run
  makes the pre-call budget decision from stale counters.
- The last writer wins on the single assessment row, so a later failure can erase
  a successful summary or a later success can hide a failed attempt that consumed
  tokens.
- Audit and outbox events contain separate trace ids, but the UI has only the
  final row state, making it hard to explain duplicate model spend or compare
  attempts.

Required fixes:

- Add a `CapabilityImpactAssessmentRun` or generic `ModelAssessmentCommand` with
  idempotency key, request hash, actor, trace id, status, lease owner,
  `leaseUntil`, token/cost reservation, and terminal result.
- Use compare-and-set leasing so only one active assessment run per project and
  capability can execute unless the operator explicitly starts a new generation.
- Reserve or re-check token/cost budget inside the same transaction that claims
  the run, then reconcile actual usage on completion.
- Keep the parent `CapabilityImpactAssessment` as the latest projection while
  preserving all attempt records for audit, comparison, and cost evidence.
- Add tests for create-plus-manual race, double manual click, stale lease retry,
  budget exhaustion during concurrent starts, and last-writer prevention.

### 287. Automated WorkItem starts bypass the durable workflow-start command model

Evidence:

- Manual target starts go through `startWorkItemTarget(...)`.
- `startWorkItemTarget(...)` creates or reuses a `WorkflowStartCommand` with
  `idempotencyKey`, `requestHash`, `state = IN_PROGRESS`, `attempt`,
  `leaseUntil`, `tenantId`, and later updates the same command to `COMPLETED` or
  `FAILED`.
- WorkItem routing uses a different helper, `startAttachedTarget(...)`, when
  `routeWorkItem(...)` sees `options.startNow` or `routingMode = AUTO_START`.
- `startAttachedTarget(...)` reserves the target by setting `startedAt`, calls
  `cloneDesignToRun(...)`, stamps `_workItem` into the cloned instance context,
  links `childWorkflowInstanceId`, updates the WorkItem to `IN_PROGRESS`, emits
  `AUTO_STARTED`, and calls `startInstance(...)`.
- `startAttachedTarget(...)` does not create, lease, update, or complete a
  `WorkflowStartCommand`.
- Canonical event intake calls `fanOutToWorkItemTriggersDetailed(...)`, which
  routes with the trigger routing mode. The internal event and schedule sweeps
  also call `routeWorkItem(...)` with system actors. These automated paths
  therefore use `startAttachedTarget(...)` instead of the command-backed manual
  start path.

Impact:

- Manual, event-driven, scheduled, and routing-policy auto-starts do not have the
  same durable command evidence.
- Workflow Operations can inspect a manual `WorkflowStartCommand`, but an
  auto-started WorkItem run has no equivalent command row with request hash,
  launch inputs, attempt count, lease, or terminal error.
- A crash or failure during automated clone/link/start recovery is reconstructed
  from target timestamps, WorkItem events, and logs instead of a single
  idempotent start command.
- Enterprise retry and replay semantics differ by launch source, even though the
  user-facing outcome is the same: a WorkItem target starts a child workflow run.

Required fixes:

- Route every WorkItem target start, including `AUTO_START`, `SCHEDULED_START`,
  event trigger, scheduled trigger, generation-plan, and system automation starts,
  through a shared `WorkflowStartCommand` service.
- Include launch source, routing policy id, trigger id, delivery/outbox id,
  WorkItem target id, template id, vars, globals, params, model/source choices,
  tenant id, and actor/system principal in the command request hash.
- Make `startAttachedTarget(...)` either a thin internal wrapper around the command
  service or remove it after migrating callers.
- Show automated start commands in Workflow Operations with retry/replay controls
  and command-to-run links.
- Add regression tests proving manual start, event `AUTO_START`, scheduled start,
  and generation-plan start all create exactly one durable command and recover
  consistently after clone/start failures.

### 288. Internal WorkItem event triggers mark events processed before routing succeeds

Evidence:

- `runWorkItemEventTriggers()` scans internal `OutboxEvent` rows and, for each
  matching event, creates or attaches a WorkItem.
- Before routing the WorkItem, the sweep updates `WorkItemTrigger.lastFiredAt` to
  the matched event's `createdAt`, mutates the in-memory trigger cursor, and calls
  `markEventProcessed(matched.id)`.
- Only after those cursor/processed updates does it call
  `routeWorkItem(workItem.id, systemRouteActor('event-trigger'), ...)`.
- `markEventProcessed(...)` writes only to a process-local `Set`.
- `loadMatchingOutboxEvents(...)` skips events at the `lastFiredAt` timestamp when
  their id is present in that process-local set.
- If `routeWorkItem(...)` throws after the event is marked processed, the outer
  catch only logs `WorkItem event trigger error:`. It does not roll back
  `lastFiredAt`, clear the processed marker, mark the event dead-lettered, or write
  an operations retry record.
- A later event with a newer `createdAt` can advance `lastFiredAt` past the failed
  event, making the failed routing attempt disappear from normal trigger scanning.

Impact:

- Internal event-triggered WorkItems can be created or attached, but never routed
  or auto-started, while the event cursor has already advanced.
- The same process will skip the failed event on later sweeps because the
  process-local processed set says the event was handled.
- Recovery depends on restart timing, cursor equality, or manual operator repair
  rather than a durable "routing failed after event claim" state.
- Operators may see a WorkItem with `TRIGGERED` evidence but no child workflow run,
  without a matching Workflow Operations event that says routing/start must be
  retried.

Required fixes:

- Treat event-trigger processing as a durable command with phases such as
  `MATCHED`, `WORK_ITEM_CREATED`, `ROUTING_STARTED`, `ROUTED`, `STARTED`,
  `FAILED`, and `DEAD_LETTERED`.
- Move the `lastFiredAt`/processed cursor update after routing and any requested
  auto-start completes, or write a retryable failure row before advancing the
  cursor.
- Replace process-local `processedEventIds` with persisted per-trigger/event
  processing state, or keep it only as a short-lived optimization backed by a
  durable claim.
- Surface failed internal event-trigger routing in Workflow Operations with the
  event id, trigger id, WorkItem id, route failure, retry count, and replay action.
- Add tests where `routeWorkItem(...)` fails after WorkItem creation, after
  trigger dedupe binding, after attachment, and during `AUTO_START`, proving the
  event remains retryable and visible.

### 289. Synthesis sponsor and owner fields accept raw user ids that later drive approvals

Evidence:

- The Synthesis hub UI populates Sponsor and Product owner dropdowns from
  `/lookup/users?size=200&status=ACTIVE`.
- The create/update schemas in `studio-projects.router.ts` accept
  `sponsorId` and `productOwnerId` as any trimmed string up to 200 characters.
- `createProject(...)` writes `sponsorId` and `productOwnerId` directly to
  `SpecificationProject`; `updateProject(...)` updates those columns directly
  when provided.
- No service call in the project create/update path verifies that those ids are
  active IAM users, tenant members, capability members, sponsors, or eligible
  product owners.
- Business Alignment objective creation accepts `ownerId` as a plain string and
  writes it directly to `BusinessObjective.ownerId`.
- `requestBusinessReadoutSponsorApproval(...)` uses `readout.project.sponsorId`
  to decide approval assignment mode. When present, it creates an
  `ApprovalRequest` with `assignmentMode = DIRECT_USER` and
  `assignedToId = readout.project.sponsorId`.
- `requestBusinessChangeSponsorReview(...)` repeats the same pattern for
  `SpecificationChangeRequest` sponsor review.
- The only self-approval guard compares the generator/requester id to the stored
  sponsor string. It does not prove the stored sponsor is a valid approver.

Impact:

- A malformed, stale, inactive, cross-tenant, or mistyped sponsor id can create a
  direct-user approval that no eligible human can see or decide.
- A project can appear to have sponsor ownership and a DRI/product-owner lane in
  Synthesis while IAM has no matching active identity or capability relationship.
- Sponsor fast-lane decisions, business readouts, and change-request approvals can
  be routed to strings rather than governed users.
- Objective ownership and risk ownership can become unverifiable metadata instead
  of actionable enterprise accountability.

Required fixes:

- Resolve and validate `sponsorId`, `productOwnerId`, objective `ownerId`, and
  risk `ownerId` through IAM/lookup on every create/update, not just in the UI.
- Require active tenant membership and, where appropriate, capability membership
  or sponsor/product-owner role eligibility before persisting those ids.
- Store the resolved display name, tenant membership version, policy decision id,
  and validation timestamp or a reference to an identity snapshot.
- Fail sponsor approval request creation if the stored sponsor has become
  inactive or unauthorized; fall back to role-based sponsor assignment only when
  no direct sponsor was intentionally set.
- Add tests for nonexistent user ids, inactive users, cross-tenant users, revoked
  sponsors, direct-user sponsor assignment, role-based fallback, and objective
  owner validation.

### 290. Team hierarchy creation still depends on raw parent-team ids

Evidence:

- Platform Web improved several Identity forms with populated selectors:
  business-unit parent uses a `business-units` dropdown, role scope uses fixed
  `platform` / `capability` options, permission category uses the platform
  taxonomy, and user team/role assignment uses relation pickers.
- The same `IdentityConsole.tsx` team create/edit definitions still expose
  `parent_team_id` as `"Parent team ID"` with placeholder `"(optional UUID)"`,
  not as a team picker that excludes the current team and descendants.
- IAM's team update path validates `parent_team_id` existence and calls
  `_assert_no_team_cycle(...)`, but the create path writes
  `parent_team_id=body.parent_team_id` directly into the new `Team` row and
  relies on database constraints or later update validation if the operator
  entered a bad raw id.

Impact:

- Identity admins can create or edit team hierarchy by copying UUIDs instead of
  selecting governed teams, which is error-prone and inconsistent with the rest
  of the newer Identity UX.
- A bad parent id on create can surface as a low-level persistence failure rather
  than a clear field-level validation error. Even when the database rejects it,
  the operator sees a brittle admin workflow.
- Hierarchy mistakes matter because team membership feeds capability ownership,
  workflow access grants, approvals, routing, and notification targeting.

Required fixes:

- Change team create/edit `parent_team_id` to a populated parent-team dropdown
  with search, root/detach option, current-team exclusion, and descendant
  exclusion for edits.
- Validate parent existence and cycle safety in the create route as well as the
  update route, returning a clear `400` field error before attempting the insert.
- Include tenant-aware parent filtering once IAM tenant ownership is strict, so a
  team can only be nested under an eligible team in the same tenant/business
  hierarchy.
- Add UI/API tests for valid parent selection, missing parent, self-parent,
  descendant-parent, root detach, and cross-tenant parent rejection.

### 291. Capacity forecasts use one-day availability instead of a schedulable horizon

Evidence:

- `capacity.router.ts` exposes `POST /api/planning/capacity/forecast` with
  `workItems`, optional `calendarIds`, optional `scenario`, and per-work-item
  `dueAt`, but the request schema has no explicit forecast start/end horizon,
  working-day policy, or scheduling granularity.
- `forecastCapacity(...)` loads all selected calendars and all active
  allocations for those calendars, regardless of allocation dates or overlap with
  the forecast scenario.
- The same function computes `availableHours` by calling
  `hoursForDay(calendar, new Date())` once per calendar, so `totalAvailableHours`
  represents today's capacity only.
- Conflict detection compares each work item's `effortHours` to that one-day
  `totalAvailableHours`; it does not calculate cumulative capacity until the
  item's `dueAt`, respect the calendar timezone, subtract allocations in the same
  date window, or build a real schedule.
- `predictedCompletionDays` is derived as
  `ceil(totalEffort / totalAvailable)`, where `totalAvailable` is again today's
  available hours, not capacity across the delivery horizon.

Impact:

- Capacity dashboards can label a plan low/medium/high risk based on today's
  capacity rather than actual capacity before the requested due dates.
- A plan with work due next month can look falsely risky if today's hours are
  low, while a plan due tomorrow can look falsely safe if long-range allocations
  were counted outside the relevant window.
- Generation plans and portfolio views that consume these forecasts can produce
  misleading staffing, WIP, and delivery-date evidence.

Required fixes:

- Add a forecast horizon to the API contract: start date, end date or per-item
  due-date window, timezone behavior, working-day policy, and scheduling
  granularity.
- Compute cumulative calendar capacity over the requested horizon, subtracting
  only allocations that overlap the same window and respecting holidays and
  timezone-local working days.
- Return a schedule-oriented result: earliest feasible date, overloaded days,
  blocking allocation ids, utilization by week, WIP-limit violations, and per
  WorkItem risk.
- Store a forecast input digest and calendar/allocation snapshot references so
  generation-plan and portfolio evidence can prove which capacity state produced
  the recommendation.
- Add tests for due tomorrow versus due next month, timezone boundary days,
  holidays, overlapping allocations, non-overlapping allocations, zero-capacity
  calendars, and WIP-limit breaches.

### 292. Bare-metal setup does not pin or validate the Node and package-manager toolchain

Evidence:

- `bin/bare-metal.sh` performs a real Python minimum-version check through
  `PYTHON_MIN_VERSION="3.11"` and `select_python_bin(...)`, but the same `cmd_up`
  path only calls `require node` and `require npm`.
- The WorkGraph package manager is only presence-checked:
  `command -v pnpm ... || warn "pnpm not found — workgraph install will fail"`.
  There is no minimum pnpm version, Corepack activation, or package-manager
  lockfile version check before install.
- `bin/check-deployment-env.sh` similarly checks that `node` and `npm` exist, but
  does not validate a Node major/minor range.
- Active packages launched by setup, including `agent-and-tools`,
  `agent-and-tools/web`, `agent-runtime`, `agent-service`, `prompt-composer`,
  `mcp-server`, `workgraph-studio`, `workgraph-studio/apps/api`,
  `audit-governance-service`, `platform-registry`, and `claim-registry`, have no
  `engines.node` or `packageManager` declaration. The retired/hidden
  `singularity-code-foundry` package is the only inspected package declaring
  `engines: { node: ">=20" }`.
- The current local shell used for this audit reports `node v25.5.0`,
  `npm 11.8.0`, and `pnpm 10.33.2`; the setup scripts would accept that toolchain
  without telling the operator whether it is supported.

Impact:

- Fresh-clone and office-laptop installs can fail in inconsistent ways depending
  on the user's globally installed Node, npm, and pnpm versions.
- Next, Prisma, ts-node, Vite, Electron, and WorkGraph VM packages can break on
  unsupported Node majors or lockfile/package-manager mismatches, but setup will
  discover that only after dependency install, code generation, build, or runtime
  boot.
- Support cannot give a single reproducible setup recipe because the platform
  does not encode the toolchain contract it expects.

Required fixes:

- Add a repository-level toolchain contract such as `.nvmrc` / `.node-version`,
  `packageManager`, and `engines` for each active package family.
- Teach `bin/setup.sh`, `bin/bare-metal.sh`, `bin/doctor.sh`, and
  `bin/check-deployment-env.sh` to validate Node and pnpm ranges before
  dependency installation.
- Prefer Corepack-managed pnpm with a pinned version for WorkGraph and fail early
  when the wrong package manager/version is active.
- Document one supported Node line for Docker, bare-metal server, and laptop MCP
  runtime, plus an explicit "known unsupported" warning for newer untested majors.
- Add a topology/doctor test that fails when active packages omit engines or when
  setup would accept an unsupported Node/pnpm combination.

### 293. Agent template snapshots fail open into unknown-agent provenance

Evidence:

- `AgentTaskExecutor.ts` resolves a local `agentId` by calling
  `snapshotAgentTemplate(cfgAgentTemplate, ...)` before it validates the full
  `agentTemplateId`, `task`, and `capabilityId` execution prerequisites.
- `snapshotAgentTemplate(...)` initializes fallback values such as
  `name = agent-template:<prefix>` and `model = 'unknown'`.
- If `getAgentTemplate(...)` throws, the catch block intentionally suppresses
  the error with the comment `upstream unreachable — fall through; placeholder
  snapshot keeps the run unblocked`.
- The helper can then create or update the local `Agent` row with
  `sourceHash = null`, `sourceVersion = undefined`, and the fallback model/name.
- `AgentTaskExecutor` creates an `AgentRun` against that local agent snapshot and
  only later calls Context Fabric with the original `agentTemplateId`.

Impact:

- Agent provenance can show a runnable local agent even when Agent Runtime was
  unreachable and no template prompt/model/profile was actually fetched.
- A transient dependency outage can overwrite a previously useful local snapshot
  with `model = unknown` and `sourceHash = null`, weakening evidence replay.
- Operators may debug Context Fabric or Prompt Composer failures from a run whose
  WorkGraph-side agent evidence already lost the real upstream template state.
- Enterprise audit needs to distinguish "fresh signed snapshot", "reused prior
  snapshot", and "placeholder because source unavailable"; the current result
  only returns `{ fetchedFresh: true, sourceHash: null }`.

Required fixes:

- Fail closed for new agent-template snapshots when the upstream template cannot
  be fetched, unless an explicit debug/degraded mode is enabled.
- Never overwrite a known-good `Agent.sourceHash` with `null` just because a
  later fetch failed; keep the prior snapshot and record a separate stale-source
  warning.
- Add snapshot status fields such as `sourceStatus`, `sourceError`,
  `staleSince`, and `lastVerifiedHash`, and surface them in run evidence.
- Move agent snapshot resolution after node config validation, and make run
  activation block when a required agent template cannot be proven current.
- Add tests for fresh fetch, unchanged fetch, changed fetch, upstream outage
  with prior snapshot, upstream outage without prior snapshot, and strict-mode
  fail-closed behavior.

### 294. Team variables use unchecked capability/workflow scope ids

Evidence:

- `TeamVariablesPage.tsx` asks users to type `Capability id (from IAM)` or
  `Workflow id` when visibility is `CAPABILITY` or `WORKFLOW`; there is no
  capability/workflow picker in that form.
- `teams.router.ts` accepts `visibilityScopeId` as an optional nullable string
  for both create and patch. It does not verify that a CAPABILITY scope exists in
  IAM/Agent Runtime, that a WORKFLOW scope exists in WorkGraph, or that either
  belongs to the same team/tenant.
- The `TeamVariable` table stores `visibilityScopeId String?` with no foreign key
  and no tenant column. Its indexes only support lookup by `(visibility,
  visibilityScopeId)`.
- Runtime injection in `cloneDesignToRun.ts` applies CAPABILITY variables only
  when `v.visibilityScopeId === template.capabilityId`, and applies WORKFLOW
  variables only when `v.visibilityScopeId === template.id`.
- The live instance variable reader in `instances.router.ts` repeats the same
  exact string comparison against `capabilityId` and `workflowId`.

Impact:

- A typo, stale UUID, copied IAM slug, or wrong environment id can make a
  variable look configured in the admin UI while silently never appearing in
  workflow `_globals`.
- A team member can store scope ids for workflows or capabilities outside the
  intended resource boundary, with no validation or warning that the variable is
  orphaned or cross-scope.
- Since variables can feed LLM routing, runtime source paths, event payloads, and
  approval placeholders, silent non-application can change workflow behavior at
  launch time without a clear diagnostic.
- Operators cannot safely refactor or rename capabilities/workflows because
  variable visibility is not backed by referential integrity or an effective-use
  preview.

Required fixes:

- Replace raw scope text with capability and workflow pickers populated from the
  authoritative IAM/Agent Runtime and WorkGraph APIs.
- Validate `visibilityScopeId` server-side on create/patch, including tenant,
  team ownership, active status, and resource existence.
- Add an "effective variables for this workflow/capability" preview before
  launch, showing missing/orphaned variables as blocking or warning diagnostics.
- Add migration/backfill checks that mark existing scoped variables as valid,
  orphaned, or cross-scope before enforcing strict validation.
- Add tests for invalid capability id, valid capability id, invalid workflow id,
  cross-team workflow id, deleted workflow id, and variable injection precedence.

### 295. Published deliverables can skip git publication without evidence

Evidence:

- `transitionConsumable(...)` logs `ConsumableAPPROVED` or
  `ConsumablePUBLISHED`, creates the status receipt, and publishes the outbox
  event before starting git publication side effects.
- For approved/published consumables, it calls `commitDeliverableConsumable(...)`
  and `pushCodeForConsumable(...)` as fire-and-forget promises. Only thrown
  errors are logged as `DeliverableCommitFailed` or `PhaseCodePushFailed`.
- `commitDeliverableConsumable(...)` intentionally returns without logging when
  key preconditions are missing: no consumable/instance, no document content, no
  `workCode`, no `repoUrl`, or no active `GIT` connector.
- The helper comment says missing preconditions such as "no work-item code, no
  content, no GIT connector" silently no-op because the runtime working-tree
  push may still carry the artifact.
- `pushCodeForConsumable(...)` also returns without logging when there is no
  consumable/instance/node, `globals.pushEachPhase !== true`, no work code, or
  missing node.
- Successful document commits log `DeliverableCommitted`, but skipped paths have
  no corresponding `DeliverableCommitSkipped` receipt/event with the missing
  prerequisite.

Impact:

- A run can show a deliverable as approved or published while the expected
  `deliverables/<workCode>/<role>/...` file was never committed and no operator
  can tell whether git publication was skipped, pending, or unavailable.
- Evidence packs and PR handoff may claim published work that exists only in the
  database/S3/runtime workspace, not in the repository branch where downstream
  SDLC tools expect to find it.
- Missing repository, missing connector, or missing work-code wiring becomes an
  invisible configuration problem instead of an actionable blocked/warning state.
- Fire-and-forget side effects are difficult to retry safely because skipped
  preconditions do not create a durable delivery record.

Required fixes:

- Create a `DeliverablePublication` or outbox row for every approved/published
  consumable before attempting git/S3/runtime publication.
- Record terminal states for `COMMITTED`, `PUSHED`, `SKIPPED`, `FAILED`, and
  `RETRYABLE`, with explicit missing-precondition codes.
- Surface skipped/failed publication in the run cockpit, Documents tab, evidence
  pack, and Operations delivery tables.
- Make release/readiness workflows optionally require all mandatory deliverables
  to be published to the selected repository before final approval.
- Add tests for missing work code, missing repo, no Git connector, empty content,
  runtime push disabled, runtime push failed, successful cloud commit, and retry.

### 296. Workbench Copilot exports can download with unresolved stage prompts

Evidence:

- `workbenchDefinitionsRouter.get('/export-copilot')` resolves each workbench
  stage prompt through `promptComposerClient.resolveStage(...)`.
- The route catches each per-stage Prompt Composer failure, sets
  `resolved: false`, stores an empty `task`, `systemPromptAppend`, and
  `extraContext`, and continues building the export.
- The comment says a single failed resolve should not sink the whole export and
  should fall back to a noted placeholder so the operator still gets a usable
  file.
- `buildCopilotAgentMd(...)` emits only a note when a stage is unresolved:
  "No bound prompt could be resolved for this stage... Follow the agent role and
  the documents below."
- `buildCopilotYaml(...)` uses an empty `prompt` for unresolved stages and puts
  the Prompt Composer error into `metadata.prompt_resolution_note`.
- The HTTP response still returns a downloadable YAML/Markdown file with normal
  attachment headers rather than a blocked status or explicit degraded export
  response.

Impact:

- Operators can hand a Copilot CLI workflow to another environment that is
  missing the actual stage prompts, while the export still looks structurally
  valid and executable.
- The most important governed content, the prompt contract, can be replaced by a
  generic note during an infrastructure outage.
- A downstream run may produce code/evidence from role names and documents
  rather than from the approved Workbench stage prompt profile, weakening
  reproducibility.
- The current behavior is helpful for debugging, but in enterprise mode it should
  not be indistinguishable from a complete export.

Required fixes:

- Add an export policy: `fail_closed`, `metadata_only_degraded`, or
  `debug_allow_placeholders`, with fail-closed as the production default.
- Return a 422 or explicit degraded response when mandatory stage prompts cannot
  be resolved, unless the caller asks for a debug placeholder export and has the
  corresponding permission.
- Include per-stage prompt resolution status, assembly id, profile key, prompt
  hash, and error code in an export receipt.
- Add UI warnings that block handoff/download when any mandatory stage prompt is
  unresolved.
- Add tests for all prompts resolved, one prompt unavailable, Prompt Composer
  unauthorized, debug placeholder export, YAML prompt hash metadata, and
  production fail-closed behavior.

### 297. Immutable contract replay is executable without contract/resource authorization

Evidence:

- `app.ts` mounts `/api/contracts` with `authMiddleware` only.
- `contracts.router.ts` exposes `POST /api/contracts/:contractId/replay` as an
  executable route that fetches a contract bundle from Prompt Composer, renders a
  frozen prompt, and calls `contextFabricClient.executeGovernedTurn(...)`.
- The replay request body accepts caller-supplied `agentTemplateId`,
  `capabilityId`, `workflowInstanceId`, `originalInput`, and optional
  `originalRunId`.
- The route checks tenant access only when `originalRunId` is supplied, through
  `assertAgentRunTenant(req, originalRunId)`, so a replay with no original run id
  performs no WorkGraph tenant/resource lookup before invoking Context Fabric.
- The contract fetch is by raw `contractId` through WorkGraph's Prompt Composer
  service credentials. The route does not verify that the authenticated caller can
  view or replay that contract, that the contract belongs to the requested agent
  template/capability, or that the requested capability is visible to the caller.
- The generated `run_context` can use `workflow_instance_id =
  replay-<contractId>` when no workflow instance is supplied, so the replay need
  not be anchored to an authorized run.

Impact:

- Any authenticated WorkGraph caller can potentially execute model calls using a
  frozen prompt contract id they know or can guess, paired with an arbitrary
  capability id and input.
- Contract replay can become a side channel for prompt contents, model/provider
  behavior, and capability-scoped execution without the normal workflow/run
  authorization snapshot.
- The replay evidence is weaker than normal run evidence because it lacks a
  required workflow instance, actor authorization decision, contract ownership
  check, and capability membership proof.
- This undermines the intended value of immutable contracts as an enterprise
  evidence primitive: the replay surface itself is not governed like a sensitive
  execution action.

Required fixes:

- Add explicit `contract:view` and `contract:replay` authorization checks before
  fetching or executing a contract bundle.
- Require contract replay to be anchored to an authorized workflow instance,
  agent run, or approved replay request in production-class environments.
- Verify the contract's agent template, capability, tenant, and bundle hash
  against the requested replay context before provider invocation.
- Record a replay authorization snapshot with actor, tenant, contract id,
  capability id, workflow/run id, policy version, and trace id.
- Add tests for no original run id, wrong capability id, unauthorized contract
  id, cross-tenant contract replay, stale contract version, and successful
  authorized replay.

### 298. Governed coding stages synthesize non-authoritative Context Fabric call ids

Evidence:

- `coding-agent/orchestrator.ts` documents that the governed-stage endpoint does
  not mint a `cf_call_id`, so the adapter "synthesize[s] a UUID-like value from
  the run_context.work_item_id + turn count" and leaves a TODO to emit
  `cf_call_id` from the stage runner.
- The actual adapter builds `const cfCallId =
  \`governed:${resp.final_state.stage_key}:${resp.turns.length}\``.
- That synthetic value is stored in the ExecuteResponse-shaped wrapper under
  both top-level `cfCallId` and `correlation.cfCallId`.
- `blueprint.router.ts` persists `result.correlation?.cfCallId` into
  `BlueprintStageRun.correlation`, stage attempts, review events, and
  Blueprint audit records.
- The code-change panel path builds lookup maps from stored `cfCallId` values
  and calls `contextFabricClient.listCodeChanges(cfCallId, ...)`.
- `context-fabric/client.ts` defines `listCodeChanges(...)` as an API request
  keyed by `cf_call_id`; the synthetic `governed:<stage>:<turns>` value is not a
  server-minted Context Fabric call record.

Impact:

- Workbench evidence can display a "Context Fabric call" id that is not actually
  queryable as a Context Fabric call.
- Code-change lookup, trace cockpit joins, audit searches, and replay debugging
  can fail or collide because the id is based only on stage key and turn count.
- Multiple workflow runs with the same stage and same number of turns can produce
  identical synthetic `cfCallId` values.
- Operators may chase missing Context Fabric logs even though WorkGraph created
  the apparent id locally.
- This weakens the platform trace spine precisely on governed coding stages,
  where code diffs, verifier receipts, and approval evidence need the strongest
  correlation.

Required fixes:

- Make `execute-governed-stage` return a real server-minted `cf_call_id` and
  include it in every governed stage response.
- Treat missing `cf_call_id` as a degraded/blocked evidence condition in strict
  mode instead of fabricating a normal-looking call id.
- If a temporary local id remains necessary, store it in a separate field such as
  `workgraphStageCorrelationId`, never in `correlation.cfCallId`.
- Update code-change lookup and trace cockpit joins to use authoritative
  Context Fabric ids only, with inline WorkGraph code-change records as an
  explicitly labelled fallback.
- Add tests for two same-stage same-turn runs proving call ids are unique,
  queryable, and trace-linked; add a strict-mode test that rejects missing
  governed-stage `cf_call_id`.

### 299. Workbench governed coding usage records hard-code zero cost

Evidence:

- In `adaptGovernedStageToCodingRun(...)`, the synthetic `modelUsage` object is
  built from the governed-stage response turns and totals.
- It copies provider and model from the last LLM turn and input/output tokens
  from `resp.totals`, but sets `estimatedCost: 0`.
- The same synthetic response does not carry a `modelAlias`, pricing source, or
  pricing status that would distinguish "free", "mock", "unpriced", and
  "priced as zero".
- `recordBlueprintBudgetUsage(...)` reads
  `result.modelUsage?.estimatedCost ?? result.usage?.estimatedCost ??
  result.tokensUsed?.estimatedCost ...` and records that value into workflow LLM
  usage.
- `buildExecutionFallbackMarkdown(...)` renders `Estimated cost:
  ${estimatedCost}` whenever the value is non-null, so a hard-coded zero appears
  as real receipt evidence.
- Run Insights renders priced rows and budget bars from recorded
  `estimatedCost`; it distinguishes `UNPRICED` only when cost is null, not when
  the adapter writes zero.

Impact:

- Governed Workbench stages can consume real Anthropic/OpenAI/OpenRouter/Copilot
  model tokens while WorkGraph records the stage as `$0.00`.
- Initiative budget, run economics, evidence packs, and release reports can
  understate cost for the highest-value code-generation stages.
- Because zero is a valid numeric cost, downstream UIs cannot tell that the
  adapter lacked authoritative pricing.
- Fixing Context Fabric placeholder pricing will not correct this path unless
  WorkGraph stops overwriting governed-stage cost with zero.
- Tenant admins cannot rely on Workbench budget data to compare providers or
  enforce initiative token/cost envelopes.

Required fixes:

- Propagate authoritative per-turn cost or pricing status from Context Fabric's
  governed-stage response.
- If no authoritative price exists, set `estimatedCost` to `null` and
  `pricingStatus = UNPRICED`; do not use zero unless the provider/model catalog
  proves a zero-price route such as mock.
- Include model alias, provider, model, pricing source, catalog version/digest,
  and effective rates in WorkGraph usage records.
- Update fallback artifacts and Run Insights to label unpriced governed stages
  explicitly instead of rendering `$0.0000`.
- Add tests for priced provider, unpriced provider, mock provider, missing model
  alias, and budget aggregation across governed Workbench stages.

### 300. MCP ToolInvocationGrant enforcement depends on an incomplete tool registry

Evidence:

- MCP grant enforcement in `tool-run.ts` calls `toolRequiresGrant(body.tool_name)`
  and returns immediately when it is false, even in `MCP_TOOL_GRANT_MODE =
  enforce`.
- `toolRequiresGrant(...)` in `security/tool-grant.ts` checks whether
  `categoryForTool(toolName)` is in the configured grant-required categories
  (`mutate,finalize,run` by default).
- `categoryForTool(...)` in `tools/tool-registry-loader.ts` reads
  `tools-registry.json` and returns `"unknown"` when a tool is missing from that
  manifest.
- The same file comments that unknown tools require a workspace but are "NOT
  gated by default" and that high-risk executor-only tools must be listed in the
  registry.
- The executable MCP local registry in `tools/registry.ts` includes tools that
  are absent from `tools-registry.json`; a quick source/manifest comparison found
  missing executable names including `git_commit`, `prepare_work_branch`,
  `write_file_demo`, `apply_patch_demo`, `notify_admin`, `http_get`,
  `web_fetch`, `record_outcome_pattern`, `query_learning_state`, and
  `query_similar_capabilities`.
- `git_commit` is a real filesystem/git side-effecting tool with risk
  `MEDIUM`; `prepare_work_branch` mutates git/worktree state; `notify_admin` is
  a `HIGH` risk approval-gated external notification tool.
- Because missing tools resolve to category `unknown`, the default
  required-category set does not require a Context Fabric-signed grant for those
  tools.

Impact:

- `MCP_TOOL_GRANT_MODE=enforce` can still allow side-effecting or high-risk local
  tools to run without a ToolInvocationGrant when the tool is missing from the
  secondary registry manifest.
- Adding or registering a new MCP tool can silently bypass grant enforcement
  unless the developer also updates `tools-registry.json` with the correct
  category.
- Operators may believe every mutating/finalizing/running tool call is bound to
  Context Fabric's phase/policy decision while several reachable handlers are
  category-unknown at the grant layer.
- Demo code-change tools can create believable code-change evidence without
  grant binding, which is especially confusing in smoke/demo environments that
  later become shared.
- The platform has two sources of truth for local tools: executable handlers in
  `tools/registry.ts` and governance categories in `tools-registry.json`.

Required fixes:

- Make unknown tool categories fail closed for grant enforcement in production,
  or require an explicit `unknown` category only for tools proven read-only and
  workspace-independent.
- Add a startup/CI drift check that every executable `getLocalTool(...)` handler
  has a manifest entry with category, risk, approval, and grant policy.
- Move grant-required classification to the executable tool descriptor itself,
  or generate `tools-registry.json` from the local registry to avoid hand drift.
- Add missing manifest entries for `git_commit`, `prepare_work_branch`, demo
  code-change tools, notification tools, learning writers, and network egress
  tools with appropriate categories.
- Add tests proving `MCP_TOOL_GRANT_MODE=enforce` rejects a missing-manifest
  mutating tool, rejects a missing-manifest run tool, and fails startup when
  executable/manifest drift is present.

### 301. Rejected submissions can invalidate the latest verified scope evidence

Evidence:

- `registerSubmission(...)` intentionally records invalid manifests instead of
  dropping them: `validateSubmissionManifest(...)` returns an error count and the
  service creates an `ImplementationSubmission` with `status = 'REJECTED'` when
  identity checks fail.
- The same registration transaction invalidates prior reconciliation runs for the
  same `DevelopmentScope` or legacy repository whenever it inserts a newer
  submission, regardless of whether the new submission status is `RECEIVED` or
  `REJECTED`.
- `startReconciliation(...)` refuses to reconcile a rejected submission with
  `Rejected implementation submissions cannot be reconciled`.
- `WorkItemFinalizer` builds `latestSubmissionByScope` from all
  `implementationSubmissions`, ordered by newest first, without filtering out
  `REJECTED` submissions.
- `isCurrentVerifiedScopeRun(...)` then requires the verified reconciliation run's
  `submissionId` to equal that latest submission id.
- The existing hardening test only proves "latest submission" behavior; it does
  not cover a newer rejected submission after a previously verified dynamic run.

Impact:

- A malformed webhook/manual/API submission can make a previously verified scope
  stop satisfying finalization even though the bad submission cannot itself be
  reconciled into fresh `VERIFIED_PASS` evidence.
- Finalization can dead-end with "Dynamic verification evidence is required" after
  a transient rejected manifest, forcing manual database repair or a new valid
  implementation attempt.
- A bad event from an external system can effectively contest accepted code
  without producing a contestable reconciliation run, approval request, or
  operator-visible rework command.
- Evidence timelines become confusing: they show the good dynamic reconciliation,
  the rejected submission, and stale invalidation, but no first-class reason that
  finalization now ignores the verified run.

Required fixes:

- Decide the lifecycle semantics explicitly: either rejected submissions must not
  become the "latest implementation attempt" for finalization, or they must create
  a clear `CONTESTED` / rework command that operators can resolve.
- If rejected submissions should not invalidate verification, filter
  `latestSubmissionByScope` to accepted/submittable statuses and avoid marking
  prior verified runs stale for rejected manifests.
- If rejected submissions should invalidate verification, create a durable
  contest/rework state with reason, source, actor/service principal, and repair
  action instead of leaving the scope impossible to verify.
- Add tests for: verified scope + newer rejected submission, rejected submission
  from webhook, retry with a later valid submission, and finalization behavior in
  each policy mode.
- Surface rejected-submission invalidation in WorkItem/Workflow Operations with a
  retry or discard action.

### 302. WorkItem creation commands can be stranded in IN_PROGRESS forever

Evidence:

- `WorkItemCreationCommand` has `idempotencyKey`, `requestHash`, `workItemId`,
  `state`, `error`, and tenant timestamps, but unlike `WorkflowStartCommand` it
  has no `leaseUntil`, `attempt`, `claimedBy`, or recovery metadata.
- `createWorkItem(...)` creates or updates the command to `IN_PROGRESS`, creates
  the WorkItem, then updates the command to `COMPLETED`.
- A repeat request with the same idempotency key returns
  `WorkItem creation command is already in progress` whenever the command state is
  still `IN_PROGRESS`.
- There is no timeout or stale-command recovery branch for
  `WorkItemCreationCommand`, while `startWorkItemTarget(...)` does implement
  `leaseUntil` expiry and `STALE` handling for `WorkflowStartCommand`.
- If the process crashes or loses its database connection after creating the
  command but before marking it failed/completed, the command can remain
  `IN_PROGRESS` with no linked WorkItem and no retry path.
- If the process crashes after creating the WorkItem but before completing the
  command, the retry is still blocked by `IN_PROGRESS`; the command does not carry
  enough recovery state to discover and link the created WorkItem by request hash.

Impact:

- Event-driven, generated, or public WorkItem creation can become permanently
  wedged on its idempotency key after a crash in the small but important window
  between command reservation and terminal command update.
- Clients following the correct retry guidance can be told that their command is
  still in progress long after no worker exists to finish it.
- Operators cannot distinguish a legitimately active create from an abandoned
  command because there is no lease expiry, attempt count, owner, or heartbeat.
- A created WorkItem can exist without its creation command being completed, which
  weakens command-to-entity traceability for the root of the SDLC flow.

Required fixes:

- Add `leaseUntil`, `attempt`, `claimedBy`, `heartbeatAt`, and optionally
  `createdWorkCode` / `resultLookup` fields to `WorkItemCreationCommand`.
- Wrap command reservation, WorkItem creation, command completion, and created
  event/outbox writes in one transactional command service where possible.
- When a command lease expires, recover by either linking the already-created
  WorkItem for the matching request hash or marking the command `STALE`/`FAILED`
  with a retryable error.
- Add an Operations view and repair action for stale WorkItem creation commands.
- Add crash-window tests: after command reservation, after WorkItem insert, after
  command completion but before event/outbox, and retry with same/different
  request hashes.

### 303. Synthesis Evidence Wiki export is browser-only and loses provenance

Evidence:

- `/synthesis/wiki` is presented as an "Evidence Wiki" and renders a living
  initiative record from `useProject(...)`, `useClaims(...)`, and
  `useProjectSpec(...)`.
- `ProjectWikiScreen.tsx` builds the downloaded Markdown in the browser from
  project name/mission, claims with `mean >= 0.65`, requirements, and decisions.
- The download path creates a `Blob`, object URL, and `<a download>` click with
  `${project.code}-wiki.md`; no WorkGraph API route is called to materialize the
  export.
- The generated Markdown does not include an export id, actor, tenant, policy
  decision id, project revision, specification version id, specification content
  hash, claim estimate ids, claim evidence citations, board/event sequence,
  trace id, or artifact-store reference.
- Exact searches found no server route or Prisma model for Synthesis Evidence
  Wiki export, while other platform evidence surfaces such as workflow evidence
  packs and business readout exports have server-side render/export code.

Impact:

- Users can circulate an Evidence Wiki as if it were governed SDLC evidence, but
  the platform has no durable record of who exported it, when, under which
  permission, and from which exact project/spec/claim state.
- The export collapses probabilistic claims, requirements, and decisions into a
  citation-light Markdown snapshot, making later audit or dispute resolution
  unable to prove which evidence supported each statement.
- Two users can download different wiki content seconds apart without any
  snapshot id or hash that tells downstream reviewers which one is authoritative.
- Evidence packs, trace cockpits, and release gates cannot cite the wiki as a
  governed artifact because the download never enters artifact storage or audit.

Required fixes:

- Add a server-side `/studio/projects/:id/wiki/export` route that resolves the
  project, active specification version, claims, decisions, citations, and
  requested redaction mode under explicit `synthesis:wiki:export` permission.
- Store a `SynthesisWikiExport` or generic artifact record with actor, tenant,
  project id, spec version id, revision/hash, claim/evidence refs, format,
  byte hash, trace id, and policy decision id.
- Render citations per fact/requirement/decision and include both the platform
  trace id and source ids needed to reopen the original evidence.
- Make the UI download from the governed export endpoint and show the artifact id
  plus generated-at snapshot metadata.
- Add tests for current-head export, stale revision export, redaction, permission
  denial, artifact creation, audit event creation, and evidence-pack inclusion.

### 304. Synthesis scaffold acceptance is not idempotently fenced

Evidence:

- The Synthesis intake UI posts
  `/studio/experience/intake/scaffolds/:proposalId/accept` when the user accepts
  a `SCAFFOLD_BATCH` proposal.
- `acceptIntakeScaffold(...)` first reads the `StudioProposal`, checks
  `proposal.status === 'PENDING'`, then creates or finds a board, creates rooms,
  creates claims, creates probes, creates business objectives, merges the project
  specification draft, updates the project mission, resolves the discovery
  session, and finally updates the proposal to `ACCEPTED`.
- The update to `StudioProposal.status = 'ACCEPTED'` is not a compare-and-set
  write such as `where: { id, status: 'PENDING' }`, and there is no
  `ScaffoldApplyAttempt` / idempotency key / applied payload digest.
- Under normal read-committed database isolation, two accept requests can both
  read the proposal as `PENDING` before either transaction commits, then both
  create rooms, claims, probes, objectives, and spec-draft changes before the
  final status write.
- Prisma models do not enforce uniqueness that would make this retry safe:
  `StudioProposal` has indexes but no unique constraint for
  `(studioId, kind, scopeType, scopeRef)`, `Board` has no unique
  `(projectId, name)`, `Room` has no unique `(projectId, title)`, `Claim` has no
  uniqueness on provenance/source statement, and `BusinessObjective` has no
  uniqueness on intake-origin/source.

Impact:

- Double-clicks, browser retries, proxy retries, or two reviewers acting at the
  same time can duplicate the belief room, claims, probes, business objectives,
  and draft-spec analysis for one intake session.
- The proposal may end as `ACCEPTED`, but the project can contain multiple
  accepted copies of the same generated scaffold, making traceability and
  posterior claim confidence misleading.
- Retrying after a lost HTTP response cannot safely return the previous apply
  result because no durable apply attempt records the created board, claims,
  objectives, spec revision, and proposal payload hash.
- Downstream Synthesis surfaces such as Evidence Wiki, generation planning,
  objective readouts, and claim voting may treat duplicated scaffold content as
  independent evidence.

Required fixes:

- Add a durable `StudioProposalApplyAttempt` or scaffold-specific apply command
  with actor, tenant, proposal id, payload digest, started/completed timestamps,
  created entity ids, spec revision before/after, and terminal state.
- Claim proposal acceptance with a compare-and-set transition from `PENDING` to
  `APPLYING`; return the existing apply result for repeated requests once the
  attempt is terminal.
- Make created board/room/claim/objective rows carry the proposal id and source
  ordinal, with uniqueness that prevents duplicate apply of the same proposal
  payload.
- Publish audit/outbox events for apply started, per-entity creation, apply
  completed, and apply failed.
- Add concurrency tests for two simultaneous accept requests, lost-response
  retry, failure after room creation, failure after claims/probes, and failure
  after spec update.

### 305. Observability log ingest is not atomic or deduplicated

Evidence:

- `audit-governance-service/src/routes-logs.ts` normalizes every incoming log with
  `id: randomUUID()`.
- The same ingest path calls `storage.writeBatch(logs)` before inserting rows into
  `audit_governance.observability_logs`.
- After raw storage succeeds, the route inserts each normalized log row one at a
  time with separate `query(...)` calls; there is no ingest batch row,
  transaction-spanning manifest, recovery cursor, or cleanup path for a later DB
  insert failure.
- Filesystem log storage appends raw NDJSON to service/day files and returns
  byte pointers; S3 log storage writes a UUID-named NDJSON object per batch, but
  neither backend makes the subsequent database index insert idempotent.
- `audit_governance.observability_logs` has only the UUID primary key plus raw
  storage URI/offset/byte columns; it has no source event id, producer sequence,
  source file/inode/offset key, batch id, or unique fingerprint.
- `bin/log-forwarder.py` advances its local file offsets only after `/logs/batch`
  succeeds. If the central service writes raw storage and then fails before
  returning success, the forwarder retries the same physical log lines and the
  server assigns fresh UUIDs.
- `queueLogExports(logs)` runs after row inserts and writes one export payload per
  ready target without an ingest batch id, so duplicate ingest retries can also
  duplicate vendor export queue entries.

Impact:

- A transient DB failure after raw storage succeeds can leave raw NDJSON records
  that are not searchable from `/operations/logs`, `/logs/search`, or trace
  timelines.
- A partial insert failure can create a split-brain batch where some records are
  indexed, some only exist in raw storage, and the caller sees a failed request
  that is retried as a new logical batch.
- Retrying the same bare-metal log lines after a lost response or state-file loss
  can produce duplicate central rows and duplicate Datadog/Splunk/http-json
  export queue items with different platform log ids.
- Operators cannot reliably answer whether two matching log records represent two
  real events, a retry replay, or an orphaned raw batch being indexed later.
- For governance evidence, the log lake is still weaker than an at-least-once
  append ledger because it lacks a durable ingest command, batch manifest, and
  deterministic idempotency key.

Required fixes:

- Introduce an `ObservabilityIngestBatch` table keyed by tenant, producer,
  source, source offset/fingerprint, and request idempotency key.
- Accept or derive deterministic per-record ids from producer identity plus
  source file/inode/offset/hash, OTLP event id, or an explicit caller-provided
  `eventId`.
- Make ingest a recoverable state machine: `RECEIVED`, `RAW_STORED`, `INDEXED`,
  `EXPORTED`, `FAILED`, and `DEAD_LETTERED`, with visible repair/replay actions.
- Store a batch manifest with raw object URIs, byte ranges, hashes, DB row ids,
  export queue ids, and attempt metadata.
- Queue exports from indexed row ids or batch ids, not from the in-memory request
  array, and make export queue insertion idempotent per target and row/batch.
- Add fault-injection tests for raw-storage success plus DB failure, partial row
  insert failure, retry after lost response, state-file loss, duplicate
  suppression, and export queue dedupe.

### 306. Direct LLM and gateway calls cannot stream tokens into the run cockpit

Evidence:

- `context-fabric/services/llm_gateway_service/app/types.py` exposes
  `ChatCompletionRequest.stream` only for OpenAI-shape parity and documents that
  streaming is not implemented.
- `context-fabric/services/llm_gateway_service/app/router.py` rejects any
  `/v1/chat/completions` request with `stream=true` by returning
  `400 streaming is not yet supported by the gateway; set stream=false`.
- `context-fabric/services/llm_gateway_service/app/providers/openai_compat.py`
  explicitly says streaming is not implemented and callers fall back to
  non-streaming final-response assembly.
- `workgraph-studio/apps/api/src/modules/workflow/runtime/executors/DirectLlmTaskExecutor.ts`
  calls OpenAI-compatible and Anthropic endpoints with ordinary `fetch(...)`
  JSON requests, then parses the full JSON body through `parseJsonResponse(...)`.
  It never sends `stream: true`, never reads an SSE/body stream, and never emits
  per-token or per-chunk workflow events during the provider call.
- The same Direct LLM executor creates `EXECUTION_TRACE` and `LLM_RESPONSE`
  outputs only after the provider/harness call returns.
- The run UI already has live-token affordances: `LiveEventsPanel.tsx` renders
  `llm.stream.delta` events into `liveText`, and `RunInsightsPage.tsx` counts
  `llm.stream.delta` as "stream chunks".
- `LiveEventsPanel.tsx` describes its source as "Streamed from MCP via
  context-fabric", so WorkGraph-direct LLM nodes and LLM Gateway calls do not
  match the live interaction model shown to operators.

Impact:

- Direct LLM co-work/review nodes can sit silent until the full model call
  returns, even though users expect a Copilot-like live window with incremental
  reasoning, partial outputs, and early cancel/send-back options.
- Long verifier, document-review, or multi-phase loop calls provide no live
  heartbeat beyond the surrounding workflow node status, making timeouts,
  provider stalls, and prompt mistakes harder to diagnose.
- Run insights can show zero stream chunks for successful direct LLM work, which
  makes the "live events" metric misleading when users mix MCP-routed agents and
  WorkGraph-direct LLM nodes in one workflow.
- Governance review happens after a completed output exists; reviewers cannot
  intervene on suspicious intermediate content, runaway output, or an obviously
  wrong prompt before the full token spend occurs.
- The platform cannot offer a consistent enterprise co-work experience across
  Context Fabric/MCP agent nodes, WorkGraph-direct LLM nodes, and LLM Gateway
  aliases.

Required fixes:

- Add a streaming contract to LLM Gateway, such as
  `POST /v1/chat/completions/stream` or `stream=true` returning normalized SSE
  frames for OpenAI-compatible, Anthropic, Copilot, and mock providers.
- Normalize provider deltas into platform events with trace id, workflow instance
  id, node id, agent run id, model alias, provider request id, sequence number,
  content delta, finish reason, and redaction class.
- Update WorkGraph Direct LLM execution to request streaming when the selected
  connection supports it and publish `llm.stream.delta`, `llm.stream.done`, and
  `llm.stream.error` events before final `LLM_RESPONSE` persistence.
- Add cancel/stop controls that can abort the active provider stream and persist
  a reviewable partial-output artifact with clear status.
- Keep non-streaming as a provider capability fallback, but surface that fallback
  in run cockpit and `/llm-settings` readiness instead of silently behaving as a
  dead live panel.
- Add tests for OpenAI-compatible SSE, Anthropic event streams, provider fallback
  to non-streaming, stream cancellation, redaction before event publication,
  sequence ordering, and run UI transcript reconstruction from deltas.

### 307. LLM Gateway mock admin endpoints bypass the gateway auth guard

Evidence:

- `context-fabric/services/llm_gateway_service/app/main.py` mounts the normal
  LLM router on the production FastAPI app, then defines `POST /v1/mock/reset`
  and `GET /v1/mock/counts` directly on `app`.
- The comment above those endpoints says they are "intentionally unprotected"
  because they are intended for the chaos smoke harness and only touch mock
  provider state.
- `context-fabric/services/llm_gateway_service/app/router.py` centralizes gateway
  auth in `_check_auth(...)` and calls it from `/llm/providers`, `/llm/models`,
  model-catalog writes, `/v1/chat/completions`, and `/v1/embeddings`.
- The mock reset/counts endpoints do not call `_check_auth(...)`, are not mounted
  through the authenticated router, and do not check environment mode, localhost
  binding, caller identity, tenant, or service scope.
- Searched LLM Gateway tests mention `LLM_GATEWAY_BEARER` only in platform
  registration tests; no test currently proves `/v1/mock/reset` or
  `/v1/mock/counts` require auth in non-test deployments.

Impact:

- Any caller that can reach the LLM Gateway can reset mock fail-N counters or read
  mock counter state even when the rest of the gateway is configured with
  `LLM_GATEWAY_BEARER`.
- Fresh-clone demos, chaos smoke runs, and mock-mode readiness checks can become
  non-reproducible if another browser, script, or network-local caller resets the
  counters mid-run.
- Exposing these endpoints under `/v1/*` makes them look like part of the
  provider API surface, so reverse proxies and operators can accidentally publish
  them with normal gateway routes.
- Because resets are unauthenticated and unaudited, evidence that depends on mock
  failure/retry behavior cannot prove who changed the provider state.

Required fixes:

- Move mock admin routes behind the same gateway auth guard by default, with a
  separate `llm:debug:mock-admin` or equivalent service-token scope.
- Allow unauthenticated mock reset/counts only under an explicit test/dev flag
  that is refused in production-like environments.
- Prefer a separate `/debug/mock/*` route group or test-only app mount so
  provider-compatible `/v1/*` traffic does not include administrative controls.
- Emit a structured audit/log event for each mock reset, including trace id,
  caller service/user, reason, and previous counter snapshot when available.
- Add tests for authenticated access, missing bearer rejection, dev/test override,
  and production startup refusal when unauthenticated mock admin is enabled.

### 308. Context Memory routes expose tenantless conversation memory by caller-supplied ids

Evidence:

- `context-fabric/services/context_memory_service/app/routes.py` defines
  `/memory/messages`, `/memory/messages/{session_id}`,
  `/memory/messages/{session_id}/stats`, `/memory/summaries/update`,
  `/memory/summaries/latest/{session_id}`, `/memory/items`, `/memory/search`,
  `/context/compile`, `/context/compare`, and `/context/packages/{id}` without
  any `Authorization` header, dependency, service-token check, tenant id, or
  actor/capability validation.
- `context-fabric/services/context_api_service/app/main.py` imports that same
  `memory_router` and mounts it directly on Context API with `app.include_router(memory_router)`.
  Nearby routers such as execute, receipts, and runtime bridge implement their
  own service-token checks, so there is no shared global auth wrapper protecting
  the folded memory routes.
- The legacy standalone memory app in
  `context-fabric/services/context_memory_service/app/main.py` also includes the
  same router directly and self-registers with platform registry using
  `"auth_mode": "none"`.
- `context-fabric/services/context_memory_service/app/repository.py` stores
  `conversation_messages`, `context_summaries`, `memory_items`, and
  `context_packages` keyed by `session_id`, `agent_id`, or package id only. The
  schemas shown in `init_db()` have no `tenant_id`, `user_id`, capability id, or
  ownership columns.
- `routes.py` lets `/memory/search` call `list_memory_items(limit=200)` when the
  caller omits both `agent_id` and `session_id`, which returns the highest-ranked
  memory rows across the store.
- `routes.py` lets `/context/compile` and `/context/compare` read conversation
  history for any supplied `session_id` and produce optimized context packages
  without proving the caller owns that session.
- No searched audit entry currently covers Context Memory route authorization or
  tenant isolation; existing Context Fabric auth findings focus on execute,
  receipts, runtime bridge, direct LLM, and MCP paths.

Impact:

- Any caller that can reach Context API or the legacy context-memory service can
  read, summarize, search, or repackage another run's conversation memory if they
  know or guess a `session_id`, `agent_id`, or context package id.
- Memory search without a scope can leak distilled durable learning across
  users, capabilities, tenants, or demos because the repository has no tenant
  partition to filter on.
- `/context/compile` can assemble prior messages, rolling summaries, and memory
  items into a prompt-ready package for an unauthorized caller, turning context
  optimization into a data-exfiltration surface.
- Because memory rows do not carry tenant/capability/user ownership, downstream
  receipts and evidence cannot prove which tenant was allowed to read or reuse
  the memory that influenced an LLM call.
- Folding the routes into Context API increases exposure: operators may assume
  Context API's stricter execute/runtime auth posture also applies to `/memory/*`
  and `/context/*`, but these routes remain byte-compatible and unauthenticated.

Required fixes:

- Add tenant, actor, capability, workflow/run, and ownership columns to memory
  messages, summaries, memory items, and context packages, with a backfill plan
  for existing rows.
- Require authenticated service/user tokens on every `/memory/*` and
  `/context/*` route, derive tenant/user from the token, and reject caller-supplied
  ids outside the authorized tenant/capability/session scope.
- Replace unscoped `/memory/search` with explicit tenant/capability/session
  filters, and fail closed when no scope is supplied outside local test mode.
- Authorize `/context/compile`, `/context/compare`, and `/context/packages/{id}`
  against the source session and package owner before returning prompt-ready
  context.
- Update platform registry to advertise the real auth mode for context memory and
  refuse production startup when the memory router is exposed without auth.
- Add IDOR tests for reading another tenant's session messages, unscoped memory
  search, compiling another user's context, fetching another package by id, and
  legacy standalone service exposure.

### 309. Context Memory silently promotes heuristic fallback summaries as trusted memory

Evidence:

- `context-fabric/services/context_memory_service/app/summarizer.py` defines
  `fallback_summary(...)` as a deterministic regex/string parser that uses the
  last user message, the last 20 lines, a keyword regex for decisions, and
  question marks for open questions. It leaves requirements, constraints, user
  preferences, technical design, changes done, and next best actions empty.
- `_resolve_summarizer_prompts(...)` logs prompt-composer lookup failures and
  uses inline fallback prompt text, but it returns the same `(system_msg,
  user_msg)` shape as the composer-backed path.
- `summarize_with_llm(...)` sends the summarization request to
  `settings.mcp_server_url + "/mcp/invoke"` with a synthetic
  `traceId = summarize-{agent_id or 'anon'}`. If the MCP call fails, returns a
  non-JSON body, or produces no extractable dict, the broad `except Exception:
  pass` path falls through to `fallback_summary(messages)` without returning any
  status, provenance, warning, trace id, or failure reason.
- `context-fabric/services/context_memory_service/app/routes.py` persists the
  returned object as a normal `"rolling"` summary through `insert_summary(...)`
  regardless of whether it came from MCP/LLM or from the heuristic fallback.
- The same route promotes `summary["durable_learning"]` into `memory_items` with
  `importance_score = 0.75`, `confidence = 0.75`, and `source_type = "summary"`
  even when the durable learning came from the regex fallback.
- `context-fabric/services/context_memory_service/app/context_compiler.py` later
  loads `get_latest_summary(...)`, renders it with `summary_to_text(...)`, marks
  the optimized context as containing `rolling_summary`, and ranks memory items
  with no indication that the summary or durable learning was fallback-derived.

Impact:

- MCP outages, LLM JSON-shape failures, prompt-composer outages, or provider
  timeout errors can silently degrade memory quality while the API still reports
  `"updated": true` and downstream context treats the summary as authoritative.
- A heuristic keyword match such as "must" or "should" can become durable
  learning with 0.75 confidence, influencing later prompts, workflow decisions,
  and evidence without an operator-visible warning.
- The synthetic trace id is disconnected from the original workflow/run trace, so
  audit reconstruction cannot reliably prove which run caused a summary, which
  provider/model attempted it, or why the fallback was used.
- Operators cannot distinguish a high-quality LLM summary from a lossy fallback
  summary in `/context/compile` output, memory search, run receipts, or evidence
  packs.
- Because fallback summaries omit entire schema sections, requirements,
  constraints, technical design, and next-best-action context can disappear from
  subsequent agent turns without a visible degraded-memory signal.

Required fixes:

- Return a structured `SummaryResult` containing `summary`, `mode`
  (`llm`, `prompt_fallback`, `heuristic_fallback`, `failed`), provider/model
  metadata, trace id, prompt version, warnings, and failure reason.
- Persist summary provenance fields and confidence at the summary row level; do
  not promote heuristic fallback `durable_learning` at the same confidence as
  validated LLM output.
- Replace the broad silent `except Exception: pass` with logged, trace-linked,
  surfaced failures and a policy switch such as `fail_closed`, `warn`, or
  `allow_heuristic_fallback`.
- Propagate the caller's workflow/run/trace context into the summarizer MCP call
  instead of generating `summarize-{agent_id}` as the only trace.
- Include summary provenance and degraded-memory warnings in `/memory/summaries/update`,
  `/context/compile`, context package records, and run/evidence views that consume
  compiled context.
- Add tests for MCP timeout, non-JSON LLM output, prompt-composer outage,
  fallback provenance persistence, reduced fallback confidence, and strict-mode
  refusal to use heuristic summaries.

### 310. Terminal run learning is fire-and-forget without durable retry or idempotency

Evidence:

- `workgraph-studio/apps/api/src/modules/workflow/runtime/WorkflowRuntime.ts`
  calls `void recordRunLearning(instanceId, 'FAILED', tenantId)` after
  `WorkflowFailed`, `void recordRunLearning(instanceId, 'COMPLETED', tenantId)`
  after `WorkflowCompleted`, and `void recordRunLearning(instanceId, 'CANCELLED',
  tenantId)` after `WorkflowCancelled`.
- `workgraph-studio/apps/api/src/lib/learning/record-run-learning.ts` states that
  callers must not await the writer and that it "swallows its own errors"; the
  catch block only writes `console.warn(...)`.
- The same writer skips learning when no service token is available, when the
  workflow has no capability, when Agent Runtime returns non-2xx, when the
  response body is invalid, or when the execution-memory creation returns no id.
  Each of those paths returns `null` or exits without a durable failure row.
- `runtimePost(...)` uses a single 10 second fetch timeout and has no retry,
  backoff, outbox, dead-letter state, health signal, or operator-visible repair
  command.
- `agent-and-tools/apps/agent-runtime/src/modules/memory/memory.schemas.ts`
  defines `storeExecutionMemorySchema` and `promoteSchema` without an idempotency
  key, source terminal event id, workflow terminal generation, or unique
  run-learning key.
- `agent-and-tools/apps/agent-runtime/src/modules/memory/memory.service.ts`
  creates a new `WorkflowExecutionMemory` row and then a new `DistilledMemory` row
  for every successful call; promotion marks the source as `PROMOTED` but does
  not make the pair idempotent for a specific workflow terminal event.
- Existing audit coverage mentions capability-memory read authorization and
  Context Memory fallback durable learning, but not this WorkGraph terminal
  run-outcome learning write path.

Impact:

- A completed, failed, or cancelled run can lose the "what happened last time"
  learning signal permanently if Agent Runtime, IAM service-token minting, the
  network, or JSON parsing fails during the fire-and-forget window.
- Operators and adoption-health checks can see a successful terminal workflow
  receipt while the closed learning loop silently did not update the capability
  memory used by Prompt Composer on the next run.
- Manual repair is hard because there is no durable `RunLearningCommand`,
  `terminalEventId`, retry count, last error, or replay action to reconstruct the
  intended memory write from Workflow Operations.
- If a future repair script or duplicate terminal side-effect path retries the
  same learning write, Agent Runtime has no idempotency key to prevent duplicate
  `RUN_OUTCOME` distilled memories for the same terminal event.
- Portfolio execution evidence can overstate "the run teaches the next one" as a
  product guarantee, while the implementation treats learning as best-effort
  console logging.

Required fixes:

- Write a durable `RunLearningCommand` or outbox row inside the same terminal
  side-effect transaction as the workflow receipt/outbox event, with
  `instanceId`, terminal status, terminal event id, tenant id, capability id,
  summary hash, status, attempts, and last error.
- Process run-learning commands with retry/backoff/dead-letter semantics and
  surface failures in Workflow Operations, run cockpit, and adoption health.
- Add an idempotency key to Agent Runtime memory writes and promotions, such as
  `runOutcome:<tenantId>:<instanceId>:<terminalGeneration>`, and enforce a unique
  key for promoted `RUN_OUTCOME` memory.
- Return and persist Agent Runtime request ids/memory ids on the command record so
  evidence can prove whether learning was staged and promoted.
- Keep terminal workflow completion non-blocking, but make learning-write loss
  observable and replayable rather than only printing `console.warn`.
- Add tests for missing service token, Agent Runtime 500, timeout, invalid JSON,
  replay after failure, duplicate replay idempotency, no-capability skip with
  visible reason, and successful command-to-memory promotion.

### 311. Architect self-review timeout fallback can synthesize approval-ready evidence

Evidence:

- `context-fabric/services/context_api_service/app/governed/stage_driver.py`
  defines `_architect_self_review_fallback_receipt(...)`, which runs when the
  agent role is `ARCHITECT`, the current phase is `SELF_REVIEW`, and either PLAN
  or EXPLORE has produced a structured receipt.
- That fallback constructs a new `self_review_receipt` after max-turn exhaustion
  with an `acceptance_criteria_check` entry whose `status` is `"met"` and
  evidence text says PLAN/EXPLORE receipts were produced before SELF_REVIEW timed
  out.
- The fallback fills missing risks with a generic default such as "Developer must
  verify case-insensitive matching and null or empty input behavior", builds a
  verification summary from PLAN when available, and sets
  `recommended_for_approval: True`.
- `_try_architect_self_review_fallback(...)` advances the phase machine with that
  synthetic receipt, sets `result.stop_reason = "APPROVAL_PENDING"`, and emits
  only a warning event named `governed.architect_self_review_fallback`.
- `context-fabric/services/context_api_service/app/governed/phase_state.py`
  explicitly sets `approval_pending` from any `SELF_REVIEW` receipt carrying
  `recommended_for_approval=true`, so the fallback enters the same approval path
  shape as an agent-produced self-review receipt.
- Existing audit coverage mentions direct LLM governance bypasses and fallback
  summaries, but no searched entry covers synthesized Architect self-review
  receipts or timeout-to-approval-pending behavior.

Impact:

- A stage that failed to produce its final self-review receipt before the turn
  budget can still present a human approver with an approval-ready receipt whose
  criteria are marked `"met"`.
- Operators may see "approval pending" and a plausible summary without realizing
  the actual SELF_REVIEW agent output is missing and the receipt was synthesized
  by fallback logic after max-turn exhaustion.
- The fallback can downplay uncertainty: generic risks and a default verification
  summary are mixed with real PLAN/EXPLORE evidence, making it hard to separate
  agent-stated findings from platform-invented guardrails.
- Governance evidence becomes weaker because approval decisions can be based on a
  surrogate receipt rather than the explicit self-review artifact the policy
  intended to collect.
- Regression tests can pass the human-gate path while still allowing architect
  stages to time out in SELF_REVIEW, masking prompt or model-quality issues that
  should be fixed.

Required fixes:

- Persist a distinct receipt kind or provenance field such as
  `self_review_fallback_receipt` / `synthetic=true`, and surface it prominently in
  run cockpit, approval UI, receipts, and evidence packs.
- Do not set `recommended_for_approval=true` on fallback receipts by default.
  Require an explicit policy flag such as `allowFallbackApprovalHandoff` per
  workflow/stage.
- Mark fallback acceptance checks as `partial`, `unverified`, or
  `requires_human_review` instead of `"met"` unless the original self-review
  receipt was produced and validated.
- Separate platform-generated default risks/verification notes from agent-authored
  PLAN/EXPLORE evidence in the receipt schema.
- Add strict-mode behavior that blocks or routes to rework when SELF_REVIEW times
  out without a valid self-review receipt.
- Add tests for max-turn Architect SELF_REVIEW timeout, fallback provenance,
  approval UI warning state, strict-mode block, policy-enabled fallback handoff,
  and evidence export labelling.

### 312. Agent Runtime memory mutation routes do not enforce writer capability or service scope

Evidence:

- `agent-and-tools/apps/agent-runtime/src/modules/memory/memory.routes.ts` mounts
  all memory routes behind `requireAuth`, but it does not attach route-specific
  permissions such as `memory:execution:write`, `memory:review`, or
  `memory:distilled:promote`.
- `agent-and-tools/apps/agent-runtime/src/modules/memory/memory.controller.ts`
  passes `req.user` into `listExecution(...)` and `listDistilled(...)`, but
  `storeExecution(...)`, `review(...)`, and `promote(...)` call their service
  methods with only request body/params.
- `agent-and-tools/apps/agent-runtime/src/modules/memory/memory.service.ts`
  mutation method signatures do not accept `AuthUser`; they validate only
  capability/binding state and archived status before creating
  `WorkflowExecutionMemory`, changing review status, or creating `DistilledMemory`.
- `validateExecutionMemoryScope(...)` verifies an optional agent binding is active
  and belongs to the supplied capability, then calls
  `assertMemoryCapabilityWritable(...)`; it never checks `req.user.capability_ids`,
  IAM permissions, service-token scopes, tenant membership, workflow ownership, or
  whether the caller is the runtime that produced the execution memory.
- `validateDistilledMemoryPromotionScope(...)` enforces capability consistency only
  when `scopeType === "CAPABILITY"`. Other caller-supplied scope types return
  immediately and can be persisted without an ownership model.
- `agent-and-tools/apps/agent-runtime/src/middleware/auth.middleware.ts` accepts
  scoped service tokens by mapping token `scopes` into `req.user.permissions`, but
  the memory mutation path never reads those permissions.
- `memory-write-scope.contract.test.ts` asserts archived/cross-capability scope
  validation, but it does not assert writer authorization, service-scope
  enforcement, reviewer authority, or denial for users outside the capability.

Impact:

- Any authenticated human or service principal that can reach Agent Runtime can
  stage execution memory for an active capability id it knows, even if it is not
  the workflow/runtime owner for that execution.
- The same caller can review execution memory or promote distilled memory into an
  active capability scope without proving capability write/admin rights.
- A low-privilege service token intended for read/list operations can become a
  memory-writing principal because memory routes authenticate the token but ignore
  its scopes.
- Prompt Composer consumes active capability distilled memory in future prompt
  assemblies, so unauthorized memory promotion can poison subsequent agent
  context and evidence for that capability.
- Non-CAPABILITY distilled memory scopes have no tenant or resource guard here,
  creating an unowned memory namespace that future readers may accidentally trust.

Required fixes:

- Pass `req.user` into `storeExecution`, `review`, and `promote`, and enforce
  explicit IAM permissions/scopes for each mutation route.
- Require capability write/admin access, workflow/run ownership, or a trusted
  service-token scope before accepting execution memory for a capability.
- Restrict review and promote actions to authorized reviewers/operators, and
  record `reviewedBy`, `promotedBy`, actor type, tenant id, and policy decision id.
- Reject non-CAPABILITY distilled memory scopes until each supported scope type has
  a tenant/resource ownership model and authorization policy.
- Validate service token scopes such as `memory:execution:write`,
  `memory:review`, and `memory:promote` separately from user permissions.
- Add IDOR tests for out-of-capability user writes, read-only service token
  promotion, cross-tenant capability ids, unauthorized review, non-capability
  scope promotion, and successful authorized runtime/workflow writes.

### 313. Agent skill-source previews fetch unbounded remote bodies

Evidence:

- `agent.routes.ts` exposes `POST /skill-sources/preview` to any authenticated
  caller and bounds uploaded files to 25 MB, but the remote preview path has no
  equivalent response-size limit.
- `previewSkillSourceSchema` accepts a `providerManifestUrl`, `url`, or
  `sourceRef`; it does not require a capability context and has no max-bytes
  field.
- `fetchJsonWithTimeout(...)` validates the provider manifest URL and content
  type, then calls `await res.text()` before signature verification, digesting,
  or JSON parsing.
- The `url_document` preview path validates the URL, then calls
  `await res.text()` and only afterwards normalizes whitespace and truncates the
  preview to 500 characters.
- `agent-source-url-policy.ts` blocks unsafe protocols, embedded credentials,
  private hosts, and private DNS results, but it does not cap `Content-Length`,
  chunked transfer size, or decompressed response size.
- `AGENT_SOURCE_FETCH_TIMEOUT_SEC` is bounded by time, not bytes, so a large
  fast response can still be fully buffered in Agent Runtime memory.

Impact:

- A normal authenticated user can turn skill-source preview into a generic
  server-side large-response fetch workload without owning a capability or
  creating a profile.
- Provider manifest previews can consume memory and CPU while hashing,
  signature-checking, and parsing a huge JSON document.
- URL-document previews appear safe because only 500 characters are returned, but
  the full body is already downloaded and buffered before truncation.
- Remote previews have a weaker resource-exhaustion boundary than uploaded
  documents, even though both are part of the same agent creation workflow.

Required fixes:

- Add an environment-configured remote preview byte cap and enforce both
  `Content-Length` preflight checks and streaming reader limits for provider
  manifests and URL documents.
- Reject compressed responses whose decompressed body exceeds the limit, and cap
  manifest capability/schema counts before storing or returning them.
- Reuse one safe fetch helper that performs redirect revalidation, timeout,
  content-type checks, byte limits, digesting, and audited outcome logging.
- Require a capability id plus owner/editor permission for remote previews, or
  enforce strict per-user rate limits before the fetch starts.
- Add tests for oversized `Content-Length`, chunked bodies that exceed the cap,
  compressed expansion, slow bodies, huge provider JSON, and huge URL document
  text.

### 314. Authenticated event intake can create tenantless operation rows on default-tenant fallback

Evidence:

- `app.ts` mounts canonical user event ingress at `/api/events/ingest` behind
  `authMiddleware`.
- `event-intake.router.ts` resolves `tenantId` as
  `requireTenantFromRequest(...) ?? resolveTenantFromRequest(...) ?? "default"`.
  In non-strict/default deployments this can choose `"default"` even when the
  request did not carry an explicit tenant selector.
- The route wraps only `fanOutToWorkItemTriggersDetailed(...)` in
  `runWithTenantDbContext(tenantId, ...)`, so created WorkItems and routing use
  that computed tenant.
- The subsequent `logEvent(eventLogType, "WorkflowInboundEvent", ...)` call runs
  after that scoped callback returns. Its payload includes `status`, `eventType`,
  `deliveryId`, `capabilityId`, `payload`, `workItemIds`, trigger results, and
  trace ids, but does not include `tenantId` or `tenant_id`.
- `logEvent(...)` derives `EventLog.tenantId` only from
  `currentTenantIdForDb()` or the payload's `tenantId` / `tenant_id`. When the
  authenticated request had no explicit tenant selector, the auth middleware's
  tenant context remains unset even though event intake selected `"default"`.
- Workflow Operations counts, event lists, and replay lookups filter inbound
  events by `EventLog.tenantId` whenever a tenant is supplied.
- The signed `/api/events/incoming` path avoids this by explicitly writing
  `tenantId` and `tenant_id` while also wrapping persistence and fan-out in the
  selected tenant context.

Impact:

- In bare-metal, demo, or non-strict default-tenant installs, a user event can
  create and route WorkItems under `"default"` while the corresponding
  `WorkflowInboundEvent*` operation row is tenantless.
- Operators filtering Workflow Operations by tenant can miss the inbound event
  that created a WorkItem and started a workflow, weakening replay and incident
  reconstruction.
- Replay and dead-letter workflows depend on inbound operation rows; a tenantless
  row can be visible in broad, unfiltered views but disappear from tenant-scoped
  operational views.
- The platform's event evidence story differs between signed service ingress and
  authenticated user ingress even though both can trigger the same WorkItem
  routing path.

Required fixes:

- Wrap both fan-out and `logEvent(...)` in the same
  `runWithTenantDbContext(tenantId, ...)` block for canonical event intake.
- Include `tenantId` and `tenant_id` in every `WorkflowInboundEvent*` payload and
  set `EventLog.tenantId` explicitly in the persistence call.
- Apply the same tenant scoping to Workflow Operations replay: load the source
  tenant, run fan-out under that tenant, and stamp the replay event row with that
  tenant.
- In non-strict mode, make the chosen default tenant explicit in the API response
  and Operations UI instead of relying on null tenant context.
- Add tests for event intake with no tenant selector, explicit tenant selector,
  strict tenant mode, replay, and Operations tenant filtering.

### 315. Role and skill approval queues do not create actionable notifications

Evidence:

- `createApprovalSchema` supports `assignedToId`, `teamId`, `roleKey`,
  `skillKey`, `capabilityId`, and `assignmentMode`.
- `validateApprovalRouting(...)` treats `ROLE_BASED` and `SKILL_BASED` as
  first-class approval routing modes.
- `/approvals/my-approvals` compensates for delegated approvals by scanning
  pending requests with `roleKey`, `skillKey`, `teamId`, or `capabilityId` and
  calling `canDecideApproval(...)` for each candidate.
- `WorkNotification` has `userId` and `teamId`, but no `roleKey`, `skillKey`,
  `capabilityId`, assignment mode, or eligibility snapshot field.
- `createNotification(...)` accepts only `userId` and `teamId` as delivery
  selectors. It looks up user preferences only when `input.userId` exists.
- Approval quorum and escalation paths call `createNotification(...)` with
  `assignedToId` and `teamId`, while escalation only stores `roleKey` and
  `skillKey` inside payload metadata.
- `listNotifications(...)` returns notifications where `userId` is the caller or
  `teamId` equals the caller's mirrored single `User.teamId`; it does not resolve
  role-based, skill-based, or capability-member notification eligibility.

Impact:

- Role-based and skill-based approval requests can be valid and actionable in the
  approval inbox, but they do not naturally appear as durable bell notifications
  for eligible approvers.
- Users must know to visit the approvals inbox; the topbar notification center can
  stay quiet while a workflow is blocked on their role or skill.
- Approval escalation for `roleKey` / `skillKey` can update routing and create an
  audit payload, but it still lacks a real notification audience unless a user or
  team is also selected.
- Enterprise approval SLAs and "next action" UX are weakened because notification
  targeting is less expressive than approval targeting.

Required fixes:

- Extend `WorkNotification` with routed audience fields such as `assignmentMode`,
  `roleKey`, `skillKey`, `capabilityId`, and an optional resolved-eligible-user
  snapshot.
- Update `createNotification(...)` to accept the same routing contract as
  approvals and either materialize per-user notification rows or evaluate
  role/skill/capability eligibility consistently at read time.
- Make `listNotifications(...)` reuse the same IAM/local eligibility logic used by
  `resolveDelegatedApprovalIds(...)`, not only direct user and single team fields.
- When escalation targets a role or skill, create a notification with that routed
  audience rather than storing role/skill only in payload metadata.
- Add tests for direct-user, team, role, skill, and capability-member approval
  notifications, including IAM role changes and users with multiple teams.

### 316. Direct notification send endpoints bypass governed message policy

Evidence:

- `app.ts` mounts `/api/notify` with `authMiddleware` only.
- `notify.router.ts` documents `POST /api/notify/email` and
  `POST /api/notify/teams` as thin templating plus dispatcher endpoints over
  Email and Teams connector adapters.
- `pickConnector(...)` resolves an explicit connector by global id or falls back
  to the most recently updated active connector of the requested type. It does
  not filter by tenant, capability, workflow, WorkItem, approval assignment,
  notification policy, or connector grant.
- The email payload schema accepts arbitrary `to`, `cc`, `bcc`, `subject`,
  `body`, `html`, `context`, and `connectorId`, then calls
  `adapter.invoke('sendEmail', ...)` directly.
- The Teams payload schema accepts arbitrary `webhookUrl`, `channelId`,
  `teamId`, `card`, `message`, `html`, `context`, and `connectorId`, then calls
  `adapter.invoke('postWebhook' | 'postAdaptiveCard' |
  'postChannelMessage', ...)` directly.
- The email adapter forwards caller-supplied recipients to SendGrid or Mailgun
  without a recipient allowlist, tenant membership check, domain policy, DLP
  check, notification preference check, or workflow approval requirement.
- The Teams adapter does validate webhook URLs through the outbound URL guard,
  but it still permits caller-selected webhook/channel targets without a
  workflow notification policy, channel allowlist, or delivery record.
- Successful sends write only `NotifyEmailSent` or `NotifyTeamsSent` audit
  events; they do not create a `WorkNotification`, `NotificationDelivery`,
  workflow operation record, event outbox row, approval evidence row, or
  retry/dead-letter record.

Impact:

- Any authenticated WorkGraph caller can use platform-owned email or Teams
  credentials to send external messages outside the governed workflow,
  approval, notification, and trace evidence path.
- Direct sends can disclose workflow context because caller-provided template
  data is rendered into email or Teams bodies without resource access checks or
  sensitive-data policy.
- Tenants or teams can accidentally use the wrong connector because the
  fallback path selects an active connector globally by type.
- Operators cannot reliably answer who should have received the message, which
  policy authorized it, whether it was retried, or whether failure became a
  durable incident.
- This weakens enterprise controls even if the future notification dispatcher
  is implemented, because callers could still bypass that dispatcher through
  `/api/notify/*`.

Required fixes:

- Treat `/api/notify/*` as an administrative/debug compatibility surface or
  move it behind the same governed notification delivery service used by
  workflow approvals, mentions, escalations, and event subscriptions.
- Require explicit permissions such as `notification:send`,
  `connector:invoke`, and channel-specific send grants, plus tenant,
  capability, workflow or WorkItem, actor, trace, and approval context.
- Resolve connectors only through tenant/capability-scoped connector grants and
  remove the global "latest active connector" fallback for production.
- Enforce recipient/domain/webhook/channel allowlists, notification
  preferences, rate limits, DLP/sensitive-field scanning, and body redaction
  before any external send.
- Persist `WorkNotification` and `NotificationDelivery` rows before sending, and
  let a dispatcher handle retries, provider ids, failures, dead-lettering, and
  delivery audit.
- Add tests proving unauthorized users cannot send, cross-tenant connector ids
  are rejected, arbitrary external recipients/channels are blocked by policy,
  DLP failures prevent send, and successful sends produce durable delivery and
  trace evidence.

### 317. Business objective primary initiative can drift from linked initiatives

Evidence:

- `BusinessObjective` stores both `studioProjectId` as a convenient primary
  initiative pointer and `BusinessObjectiveProject` rows as the many-initiative
  link table.
- `createObjectiveInternal(...)` deduplicates `projectIds`, appends
  `studioProjectId` when present, validates every referenced
  `SpecificationProject` in the current tenant, writes `studioProjectId`, and
  creates matching `BusinessObjectiveProject` rows.
- `updateObjectiveInternal(...)` validates only `input.projectIds` when that
  array is present. It does not validate `input.studioProjectId` independently,
  does not require it to belong to the same tenant, and does not require it to be
  one of the linked `projectIds`.
- When `projectIds` are patched, `updateObjectiveInternal(...)` deletes and
  recreates the link-table rows but leaves the old `studioProjectId` in place
  unless the caller also supplies a replacement primary project id.
- The PATCH route accepts `objectiveSchema.partial()`, so a caller can send only
  `studioProjectId`, only `projectIds`, or both without a server-side invariant
  that the primary pointer and link table describe the same initiative set.
- Objective listing uses
  `OR: [{ studioProjectId: projectId }, { projectLinks: { some: ... } }]`, so a
  stale primary pointer continues to make the objective appear under the old
  initiative even after the link table was moved.
- Traceability and spend exports use the same `studioProjectId OR projectLinks`
  pattern, so drift affects exported evidence and not only the on-screen
  objective list.

Impact:

- A business objective can appear attached to multiple initiatives even after an
  operator intended to move it, or it can keep a primary initiative that is not
  represented by the explicit link table.
- Value, spend, objective coverage, sponsor readouts, and traceability exports
  can include objectives for the wrong initiative, undermining the business
  alignment layer that is supposed to explain why work is funded.
- Capability ownership becomes ambiguous because initiative ownership is now the
  route back to capability, budget, sponsor lane, and generated WorkItems.
- Cross-tenant or stale-id attempts may fail only through database foreign-key
  behavior instead of returning a clear validation error with tenant/capability
  context.

Required fixes:

- Define one source of truth for objective-to-initiative membership. Prefer the
  link table, with `studioProjectId` either removed, derived, or maintained by a
  strict invariant.
- On create and update, validate `studioProjectId` against current tenant,
  active initiative status, and capability access, then require it to be included
  in `projectIds`.
- When `projectIds` change without an explicit primary id, set
  `studioProjectId` to the first linked project or reject the request as
  ambiguous.
- Add a database constraint, trigger, or transactional service invariant so
  `BusinessObjective.studioProjectId` cannot point outside the objective's
  `BusinessObjectiveProject` set.
- Add a repair/doctor check for existing objectives where the primary pointer is
  missing from the link table or points at a project from another tenant.
- Add tests for moving an objective between initiatives, clearing/replacing the
  primary pointer, cross-tenant primary project ids, stale project ids, and
  traceability/spend exports after objective relinking.

### 318. Initiative aging can be reset by generic metadata edits instead of governed reviews

Evidence:

- `SpecificationProject` stores `reviewCadenceDays`, `lastReviewedAt`, and
  `updatedAt`.
- The Synthesis hub displays an `AgingChip` using `project.agingStatus` and
  `project.ageDays`, making this status a visible operator signal for initiative
  freshness.
- `shapeProject(...)` computes `latestActivityAt` from the project row's generic
  `updatedAt`, latest claim update, latest WorkItem update, and latest impact
  assessment update.
- The same function derives `inactiveDays` from that `latestActivityAt` and marks
  the initiative `CURRENT`, `REVIEW_DUE`, `STALE`, or `OVERDUE`.
- `shapeProject(...)` does not use `lastReviewedAt` when deriving aging status,
  even though `lastReviewedAt` is selected and exposed in the frontend type.
- `updateProjectSchema` accepts caller-supplied `lastReviewedAt` and
  `reviewCadenceDays` on the generic project PATCH route.
- `updateProject(...)` writes `lastReviewedAt` directly from the request and also
  updates normal metadata such as name, mission, tags, scores, owners, target date,
  and review cadence. Any such PATCH advances the row's `updatedAt` timestamp.

Impact:

- A minor metadata edit can make a stale initiative look freshly active because
  `updatedAt` is treated as meaningful initiative activity.
- A caller can set or clear `lastReviewedAt`, but the aging algorithm does not
  treat it as the authoritative review signal, so the field is both mutable and
  semantically confusing.
- Operators may believe an initiative was recently reviewed, refreshed, or
  actively worked when the only change was cosmetic metadata.
- Portfolio aging, sponsor follow-up, capability-agent reassessment, and stale
  initiative queues can become unreliable because there is no durable
  "review completed" event with reviewer, scope, notes, and evidence.
- Auditors cannot distinguish genuine review activity from a PATCH that only
  changed tags, display text, or cadence.

Required fixes:

- Introduce a first-class `InitiativeReview` or `SpecificationProjectReview`
  record with reviewer, tenant, capability, scope, notes, decision, trace id, and
  reviewed-at timestamp.
- Derive `agingStatus` from the latest review event plus meaningful execution
  activity, not from the generic project `updatedAt`.
- Remove `lastReviewedAt` from the generic PATCH schema or make it server-owned
  and set only through a review-completion endpoint.
- Separate cosmetic metadata updates from material activity timestamps, for
  example `metadataUpdatedAt`, `lastExecutionActivityAt`, and `lastReviewedAt`.
- Add audit/outbox events for review completion and cadence changes.
- Add tests proving name/tag/score edits do not reset stale status, review
  completion does reset it, caller-supplied `lastReviewedAt` is rejected or
  ignored, and aging queues remain stable across cosmetic PATCHes.

### 319. Failed capability-impact LLM parses can drop token and cost evidence

Evidence:

- `defaultCapabilityImpactLlm.complete(...)` calls Context Fabric and returns
  `text`, `traceId`, `totalTokens`, and `estimatedCost`.
- `runCapabilityImpactAssessments(...)` awaits that LLM response, then immediately
  calls `parseCapabilityImpactResult(response.text)`.
- `parseCapabilityImpactResult(...)` throws when the response does not contain a
  parseable JSON object or when the object fails the zod output contract.
- The successful path writes `tokensUsed`, `estimatedCostUsd`, `traceId`, and
  parsed recommendations to `CapabilityImpactAssessment`, then increments
  `SpecificationProject.tokenUsed` and optionally `costUsedUsd`.
- The catch block for the same try/catch writes only `status: 'FAILED'`, an error
  message, `traceId`, and `assessedAt`; it does not write `response.totalTokens`,
  `response.estimatedCost`, raw-response hash, parser error details, or increment
  the project usage counters.
- Because `response` is scoped inside the try block, the catch block cannot access
  usage metadata from an LLM call that succeeded but produced malformed output.

Impact:

- A capability-impact assessment can spend model tokens and money but show zero
  usage on the assessment row and initiative budget when the model response is
  malformed.
- Initiative token guardrails and cost dashboards understate actual usage for
  failed parse/validation attempts.
- Operators can see a failed assessment, but cannot distinguish "provider never
  returned" from "provider returned invalid JSON after consuming budget" without
  checking external traces.
- Repeated retries against a prompt that returns invalid JSON can silently burn
  budget outside the Synthesis hub's visible token ledger.
- Audit and dispute reviews lack a raw-response hash or parse diagnostic that
  proves what failed and whether the output contract or the model response was at
  fault.

Required fixes:

- Split the provider call from output parsing so usage metadata is captured in a
  durable assessment attempt row before parsing begins.
- On parse or schema failure, persist `tokensUsed`, `estimatedCostUsd`, provider
  trace id, raw-response hash, parser error path, and validation issue summary.
- Increment initiative token/cost usage for every provider call that returned
  authoritative usage, regardless of parse success.
- Add a terminal status such as `FAILED_INVALID_OUTPUT` so UI and operators can
  distinguish malformed model output from transport/governance/provider failure.
- Include parse-failure attempts in audit/outbox events and Synthesis budget
  displays.
- Add tests where the LLM returns valid usage plus invalid JSON, invalid schema,
  empty response, and provider failure, proving only actual provider calls consume
  visible budget while every failure class is explainable.

### 320. External taxonomy mappings can be attached to the wrong initiative

Evidence:

- `ExternalTaxonomyMapping` stores `studioProjectId`, `entityType`, `entityId`,
  `externalSystem`, `externalType`, `externalLabel`, `costCenterRef`, and
  metadata.
- The model's uniqueness key is
  `@@unique([tenantId, externalSystem, entityType, entityId])`; it does not
  include `studioProjectId`.
- `PUT /business-alignment/projects/:projectId/taxonomy-mappings` accepts
  caller-supplied `entityType`, `entityId`, `externalSystem`, `externalType`,
  `externalLabel`, `costCenterRef`, and `metadata`.
- `upsertTaxonomyMappingInternal(...)` verifies only that the target project
  exists. It does not verify that `entityId` belongs to that project, that the
  `entityType` is one of the supported business-alignment entities, or that the
  entity is still active/current.
- The upsert lookup uses the tenant/system/type/entity tuple; if a mapping for
  the same entity already exists under another initiative, the update branch sets
  `studioProjectId` to the new `projectId`, effectively moving the mapping.
- The Synthesis UI only offers local generation-plan rows in its dropdown, but
  the API remains a direct path that can submit arbitrary ids and entity types.
- `exportJiraCsvInternal(...)` loads all mappings for the current
  `studioProjectId` and uses them to set Jira issue type, label, and cost center
  for generation-plan rows.

Impact:

- A malformed or direct API request can attach a Jira/cost-center mapping to an
  initiative even when the mapped entity belongs to a different initiative or
  does not exist.
- Updating a mapping for one initiative can silently move the mapping away from
  another initiative because the unique key is global per tenant/entity, not
  project-scoped.
- Jira CSV exports can carry the wrong issue type, labels, or cost center,
  confusing downstream delivery, finance, and traceability reporting.
- Business alignment evidence can imply that a WorkItem or generation-plan row is
  funded or tracked under a project that does not actually own that work.
- Operators may trust the dropdown-based UI while integrations or scripts corrupt
  the same table through the broader API contract.

Required fixes:

- Restrict `entityType` to an enum such as `GENERATION_PLAN_ROW`,
  `BUSINESS_OBJECTIVE`, or `REQUIREMENT`, and validate each `entityId` against the
  target initiative before upsert.
- For `GENERATION_PLAN_ROW`, load the row through its generation plan and require
  `plan.specificationProjectId = projectId` and tenant match.
- Include `studioProjectId` in the uniqueness model, or reject attempts to move an
  existing mapping between projects without an explicit governed transfer action.
- Store the resolved owning entity type/project/version metadata on the mapping
  so exports can verify it has not drifted.
- Add audit/outbox events for create, update, and transfer of external taxonomy
  mappings.
- Add tests for arbitrary entity ids, cross-project row ids, stale/deleted rows,
  duplicate mappings across two initiatives, and Jira export correctness after
  mapping updates.

### 321. Synthesis budget ledger idempotency keys are globally scoped and silently collide

Evidence:

- `ProjectTokenLedgerEntry.evidenceKey` is declared as a single-column global
  `@unique` field, and `ProjectBudgetEvent.evidenceKey` has the same global
  uniqueness pattern.
- `recordProjectTokenLedgerInternal(...)` writes usage with
  `projectTokenLedgerEntry.upsert({ where: { evidenceKey }, update: {}, create:
  { ...input, tenantId: project.tenantId } })`. If an evidence key already
  exists for another initiative or tenant, the update branch performs no
  ownership assertion and creates no new ledger entry.
- The same function then recomputes the rollup only for `input.projectId`, so a
  collision can leave the requested initiative undercounted while returning the
  unrelated existing row as if the write were idempotent.
- The workflow budget bridge constructs ledger keys as
  `llm:${instanceId}:${correlation}:${updated.consumedTotalTokens}`; the key is
  derived from runtime ids rather than persisted tenant/project ownership.
- Budget events are deduplicated through
  `projectBudgetEvent.upsert({ where: { evidenceKey }, update: {}, create: ... })`,
  so any future caller that reuses a non-project-qualified key would have the
  same silent suppression behavior.

Impact:

- Tenant isolation and initiative economics depend on a caller-assembled string
  being globally unique forever, across cloned runs, seed data, imports,
  environment restores, and test/demo tenants.
- A duplicated evidence key can make a real LLM spend disappear from the
  initiative token ledger and budget warnings, weakening hard-cap enforcement
  and sponsor/evidence reporting.
- Operators cannot distinguish a true idempotent retry from a cross-project or
  cross-tenant key collision because the existing code does not emit a conflict
  event or ownership mismatch error.

Required fixes:

- Change ledger/event idempotency to tenant- and project-scoped keys, for example
  unique `(tenantId, projectId, evidenceKey)` for project ledger entries and
  `(tenantId, projectId, evidenceKey)` for project budget events.
- In upsert/update branches, assert that the existing row's tenant id and project
  id match the requested write; otherwise fail closed and log a security/evidence
  collision event.
- Normalize evidence keys through a helper that includes tenant id, project id,
  workflow instance id, node id, trace id, and a source-specific digest rather
  than accepting arbitrary caller strings directly.
- Add migration/backfill checks for duplicate evidence keys by tenant/project
  before changing indexes.
- Add tests for retry idempotency, same evidence key in two tenants, same
  evidence key in two initiatives, restored seed/demo rows, and rollup behavior
  after a rejected collision.

### 322. Postgres connector runs against the platform database instead of an external connector boundary

Evidence:

- `PostgresAdapter` imports the WorkGraph Prisma singleton and its file comment
  says it "uses the app's own Prisma connection" while external database support
  through `pg` is deferred.
- `testConnection()` runs `SELECT 1` through `prisma.$queryRaw`, so a configured
  POSTGRES connector can look healthy even if its supplied `connectionString` is
  unused or invalid.
- `rawQuery(...)` accepts caller-supplied SQL, checks only that the text starts
  with `SELECT`, and executes it with `prisma.$queryRawUnsafe(sql)` against the
  platform database.
- `upsertJson(...)` also ignores connector credentials and writes to
  `outbox_events` through `prisma.outboxEvent.create(...)`; the created row has
  no tenant id, actor id, connector id, or operation evidence.
- The generic connector router exposes `POST /api/connectors/:id/invoke`, so this
  adapter can be reached through the same direct connector invocation path as
  ordinary external integrations.

Impact:

- Operators can create what appears to be an external Postgres connector, but
  reads and sink writes actually use the WorkGraph application's database role.
- A caller with connector invoke access can run arbitrary platform-database
  `SELECT` statements, including broad tenant data reads, expensive queries,
  timing/lock probes, or database functions that are not appropriate for an
  integration connector.
- Connector health is misleading because it proves only that WorkGraph can reach
  its own database, not that an external database credential or network path is
  valid.
- Outbox sink writes lose tenant, actor, connector, trace, and authorization
  provenance, weakening replay, audit, and incident triage.

Required fixes:

- Disable the POSTGRES connector in production until it uses an actual external
  connection boundary or an explicitly approved internal-reporting mode.
- If external Postgres is supported, create a dedicated `pg` connection from an
  encrypted secret reference, enforce host/network allowlists, timeouts, row
  limits, statement timeouts, and read-only credentials by default.
- Never execute arbitrary SQL against the WorkGraph application database through
  a connector. Expose approved reporting views or parameterized named queries
  instead.
- Require operation-level grants such as `connector:postgres:query` and
  `connector:postgres:sink_write`, with tenant/capability scope and audit
  decision ids.
- Persist connector invocation evidence with tenant id, actor id, connector id,
  target database identity, query digest, row count, trace id, and sink event id.
- Add tests proving invalid external credentials fail health checks, platform DB
  reads are denied, non-SELECT and unsafe SELECT/function calls are rejected,
  long queries time out, row limits apply, and sink writes include tenant/actor
  provenance.

## Verified Improvements

These are not gaps in the current worktree:

- Synthesis initiative creation now requires exactly one platform capability in the
  composer and API.
- Project-level specification creation through `/api/specifications` now also
  requires one active platform capability and writes the matching single
  `PRIMARY` capability link plus pending impact assessment.
- Workflow template design writes are DRAFT-only at the API revision gate;
  non-DRAFT saves now fail with `WORKFLOW_DESIGN_FROZEN`.
- Workflow instance node/edge topology writes call `assertInstanceGraphEditable`,
  so direct instance graph CRUD is DRAFT-only and bumps `graphGeneration`.
- Event-bus outbox rows now remain `failed` when one or more subscriber
  deliveries fail, making aggregate delivery health match subscriber reality.
- A database migration adds a single-link invariant for initiative capability
  ownership.
- Contract-bound work execution is partially implemented: the schema now has
  `WorkItemSpecificationBinding`, `DevelopmentScope`, `HandoffGeneration`,
  `WorkItemFinalizationRecord`, `WorkItemCreationCommand`,
  `WorkflowStartCommand`, and `GenerationPlan` models.
- `WorkItemFinalizer` is present and reconciliation comments explicitly state
  reconciliation is evidence, not completion authority.
- Exact searches for direct `workItem.update*({ status: 'COMPLETED' })` found no
  WorkItem completion write path outside `work-item-finalizer.service.ts`.
- Workflow Operations routes perform explicit operation permission checks and
  redact sensitive event/delivery payloads unless the caller has audit access.
- WorkGraph and Context Fabric production-class startup now enforce key
  invariants such as IAM auth, tenant isolation, strong secrets, fail-closed
  governance, service-token tenant allowlists, and runtime bridge token checks.
- Runtime Bridge authentication correctly treats JWT claims as authoritative and
  treats the hello frame as advisory metadata.
- Prompt Composer rejects runtime/device tokens on normal prompt routes and
  uses service-token exceptions only for internal callers.
- Human Task required role has picker-or-placeholder support in the richer
  React Flow inspector.
- Direct LLM config has a backend validator and Copilot direct calls are blocked.
- Generation plans now resolve the initiative's primary capability through the
  Agent/Tools capability lookup, force generated rows to that capability during
  create/validate/apply, and the frontend generation flow no longer exposes an
  arbitrary target capability picker.
- The single-capability migration now fails closed for orphan initiatives instead
  of assigning the first active cached capability; its contract test rejects any
  future `fallback_capability` / `capabilities_cache` fallback.
- Event subscription targets are SSRF-guarded, event subscription secrets are
  encrypted at rest, and signed incoming service events fail closed when source
  HMAC secrets or strict-mode tenant context are missing.

## Verification Still Needed

The following areas were not fully proven in this pass:

- Full browser E2E: Synthesis initiative -> specification -> WorkItem -> workflow
  launch -> run cockpit -> evidence export.
- Authz IDOR matrix across tenants/capabilities for Synthesis, WorkItems,
  Workflows, Operations, Prompt Composer assemblies/stage prompts, approvals,
  artifacts, and receipts.
- Production strict-mode startup refusal for missing IAM/RLS/audit/secrets.
- Real MCP runtime dial-in with Copilot and non-Copilot providers.
- Full `agent-and-tools/web` production build; current local Next server can
  interfere with `.next` cleanup.
- CI release gate coverage for Workgraph lockfile installs, IAM/Context Fabric
  pytest, authz/tenant suites, browser hydration, trace-spine, RLS enforcement,
  and blocking secret guardrails.
- Docker/cloud observability smoke proving every core service emits correlated
  durable logs into the central log lake, not only local tails.
- Tenant-scoped LLM routing resolution in every surface that uses
  `resolveLlmRouting`.
- Outbound event dispatcher liveness and end-to-end callback delivery health.
