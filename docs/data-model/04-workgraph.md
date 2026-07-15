```mermaid
erDiagram

        NodeType {
            START START
END END
HUMAN_TASK HUMAN_TASK
AGENT_TASK AGENT_TASK
DIRECT_LLM_TASK DIRECT_LLM_TASK
WORKBENCH_TASK WORKBENCH_TASK
APPROVAL APPROVAL
DECISION_GATE DECISION_GATE
CONSUMABLE_CREATION CONSUMABLE_CREATION
TOOL_REQUEST TOOL_REQUEST
GIT_PUSH GIT_PUSH
POLICY_CHECK POLICY_CHECK
EVAL_GATE EVAL_GATE
TIMER TIMER
SIGNAL_WAIT SIGNAL_WAIT
SIGNAL_EMIT SIGNAL_EMIT
CALL_WORKFLOW CALL_WORKFLOW
WORK_ITEM WORK_ITEM
FOREACH FOREACH
PARALLEL_FORK PARALLEL_FORK
PARALLEL_JOIN PARALLEL_JOIN
INCLUSIVE_GATEWAY INCLUSIVE_GATEWAY
EVENT_GATEWAY EVENT_GATEWAY
CUSTOM CUSTOM
DATA_SINK DATA_SINK
SET_CONTEXT SET_CONTEXT
ERROR_CATCH ERROR_CATCH
RUN_PYTHON RUN_PYTHON
EVENT_EMIT EVENT_EMIT
VERIFIER VERIFIER
GOVERNANCE_GATE GOVERNANCE_GATE
RAISE_PR RAISE_PR
CREATE_BRANCH CREATE_BRANCH
DISCOVERY DISCOVERY
        }
    


        ExecutionLocation {
            SERVER SERVER
CLIENT CLIENT
EDGE EDGE
EXTERNAL EXTERNAL
        }
    


        ConnectorType {
            HTTP HTTP
EMAIL EMAIL
TEAMS TEAMS
SLACK SLACK
JIRA JIRA
GIT GIT
CONFLUENCE CONFLUENCE
DATADOG DATADOG
SERVICENOW SERVICENOW
LLM_GATEWAY LLM_GATEWAY
S3 S3
POSTGRES POSTGRES
SHAREPOINT SHAREPOINT
        }
    


        EdgeType {
            SEQUENTIAL SEQUENTIAL
CONDITIONAL CONDITIONAL
PARALLEL_SPLIT PARALLEL_SPLIT
PARALLEL_JOIN PARALLEL_JOIN
ERROR_BOUNDARY ERROR_BOUNDARY
        }
    


        WorkItemStatus {
            SCHEDULED SCHEDULED
QUEUED QUEUED
IN_PROGRESS IN_PROGRESS
AWAITING_PARENT_APPROVAL AWAITING_PARENT_APPROVAL
COMPLETED COMPLETED
CANCELLED CANCELLED
ARCHIVED ARCHIVED
        }
    


        WorkItemTargetStatus {
            QUEUED QUEUED
CLAIMED CLAIMED
IN_PROGRESS IN_PROGRESS
SUBMITTED SUBMITTED
APPROVED APPROVED
REWORK_REQUESTED REWORK_REQUESTED
CANCELLED CANCELLED
        }
    


        WorkItemEventType {
            CREATED CREATED
SCHEDULED SCHEDULED
TRIGGERED TRIGGERED
ROUTED ROUTED
ATTACHED ATTACHED
AUTO_STARTED AUTO_STARTED
ROUTE_FAILED ROUTE_FAILED
CLAIMED CLAIMED
STARTED STARTED
SUBMITTED SUBMITTED
APPROVAL_REQUESTED APPROVAL_REQUESTED
APPROVED APPROVED
REWORK_REQUESTED REWORK_REQUESTED
CLARIFICATION_REQUESTED CLARIFICATION_REQUESTED
CLARIFICATION_ANSWERED CLARIFICATION_ANSWERED
CANCELLED CANCELLED
ARCHIVED ARCHIVED
DETACHED DETACHED
SPEC_DRAFT_CREATED SPEC_DRAFT_CREATED
SPEC_GENERATED SPEC_GENERATED
SPEC_VALIDATION_COMPLETED SPEC_VALIDATION_COMPLETED
SPEC_REVIEW_REQUESTED SPEC_REVIEW_REQUESTED
SPEC_APPROVED SPEC_APPROVED
DEVELOPER_PACKAGE_PUBLISHED DEVELOPER_PACKAGE_PUBLISHED
IMPLEMENTATION_SUBMITTED IMPLEMENTATION_SUBMITTED
RECONCILIATION_STARTED RECONCILIATION_STARTED
RECONCILIATION_COMPLETED RECONCILIATION_COMPLETED
CODE_REWORK_REQUESTED CODE_REWORK_REQUESTED
SPEC_AMENDMENT_CREATED SPEC_AMENDMENT_CREATED
IMPLEMENTATION_ACCEPTED IMPLEMENTATION_ACCEPTED
        }
    


        SpecificationStatus {
            DRAFT DRAFT
IN_REVIEW IN_REVIEW
CHANGES_REQUESTED CHANGES_REQUESTED
APPROVED APPROVED
SUPERSEDED SUPERSEDED
REJECTED REJECTED
        }
    


        WorkItemOriginType {
            PARENT_DELEGATED PARENT_DELEGATED
CAPABILITY_LOCAL CAPABILITY_LOCAL
        }
    


        WorkItemRoutingMode {
            MANUAL MANUAL
AUTO_ATTACH AUTO_ATTACH
AUTO_START AUTO_START
SCHEDULED_START SCHEDULED_START
        }
    


        WorkItemRoutingState {
            UNROUTED UNROUTED
ROUTED ROUTED
ATTACHED ATTACHED
STARTED STARTED
ROUTE_FAILED ROUTE_FAILED
        }
    


        MetadataDefinitionKind {
            WORK_ITEM_TYPE WORK_ITEM_TYPE
WORKFLOW_TYPE WORKFLOW_TYPE
NODE_TYPE NODE_TYPE
EVENT_TYPE EVENT_TYPE
TRIGGER_PROFILE TRIGGER_PROFILE
        }
    


        MetadataDefinitionStatus {
            DRAFT DRAFT
ACTIVE ACTIVE
DEPRECATED DEPRECATED
ARCHIVED ARCHIVED
        }
    


        MetadataScopeType {
            GLOBAL GLOBAL
CAPABILITY CAPABILITY
WORKFLOW WORKFLOW
NODE NODE
        }
    


        WorkItemTriggerType {
            EVENT EVENT
SCHEDULE SCHEDULE
WEBHOOK WEBHOOK
        }
    


        WorkItemUrgency {
            LOW LOW
NORMAL NORMAL
HIGH HIGH
CRITICAL CRITICAL
        }
    


        WorkItemClarificationStatus {
            OPEN OPEN
ANSWERED ANSWERED
CLOSED CLOSED
        }
    


        WorkItemClarificationDirection {
            CHILD_TO_PARENT CHILD_TO_PARENT
PARENT_TO_CHILD PARENT_TO_CHILD
        }
    


        NodeStatus {
            PENDING PENDING
ACTIVE ACTIVE
COMPLETED COMPLETED
SKIPPED SKIPPED
FAILED FAILED
BLOCKED BLOCKED
        }
    


        InstanceStatus {
            DRAFT DRAFT
ACTIVE ACTIVE
PAUSED PAUSED
COMPLETED COMPLETED
CANCELLED CANCELLED
FAILED FAILED
        }
    


        TaskStatus {
            OPEN OPEN
IN_PROGRESS IN_PROGRESS
PENDING_REVIEW PENDING_REVIEW
COMPLETED COMPLETED
CANCELLED CANCELLED
        }
    


        AssignmentMode {
            DIRECT_USER DIRECT_USER
TEAM_QUEUE TEAM_QUEUE
ROLE_BASED ROLE_BASED
SKILL_BASED SKILL_BASED
AGENT AGENT
        }
    


        ApprovalStatus {
            PENDING PENDING
APPROVED APPROVED
REJECTED REJECTED
APPROVED_WITH_CONDITIONS APPROVED_WITH_CONDITIONS
NEEDS_MORE_INFORMATION NEEDS_MORE_INFORMATION
DEFERRED DEFERRED
ESCALATED ESCALATED
        }
    


        ConsumableStatus {
            DRAFT DRAFT
UNDER_REVIEW UNDER_REVIEW
APPROVED APPROVED
PUBLISHED PUBLISHED
SUPERSEDED SUPERSEDED
CONSUMED CONSUMED
REJECTED REJECTED
        }
    


        AgentRunStatus {
            REQUESTED REQUESTED
RUNNING RUNNING
PAUSED PAUSED
AWAITING_REVIEW AWAITING_REVIEW
APPROVED APPROVED
REJECTED REJECTED
FAILED FAILED
        }
    


        ToolRunStatus {
            REQUESTED REQUESTED
PENDING_APPROVAL PENDING_APPROVAL
APPROVED APPROVED
RUNNING RUNNING
COMPLETED COMPLETED
REJECTED REJECTED
FAILED FAILED
        }
    


        RiskLevel {
            LOW LOW
MEDIUM MEDIUM
HIGH HIGH
CRITICAL CRITICAL
        }
    


        OutboxStatus {
            PENDING PENDING
PROCESSED PROCESSED
FAILED FAILED
        }
    


        BlueprintSourceType {
            GITHUB GITHUB
LOCALDIR LOCALDIR
        }
    


        BlueprintSessionStatus {
            DRAFT DRAFT
SNAPSHOTTED SNAPSHOTTED
RUNNING RUNNING
COMPLETED COMPLETED
APPROVED APPROVED
FAILED FAILED
ABANDONED ABANDONED
        }
    


        BlueprintStage {
            ARCHITECT ARCHITECT
DEVELOPER DEVELOPER
QA QA
        }
    


        BlueprintStageStatus {
            PENDING PENDING
RUNNING RUNNING
COMPLETED COMPLETED
FAILED FAILED
        }
    


        WorkflowBudgetEnforcementMode {
            PAUSE_FOR_APPROVAL PAUSE_FOR_APPROVAL
FAIL_HARD FAIL_HARD
WARN_ONLY WARN_ONLY
        }
    


        WorkflowRunBudgetStatus {
            ACTIVE ACTIVE
WARNED WARNED
PAUSED PAUSED
EXCEEDED EXCEEDED
EXHAUSTED EXHAUSTED
        }
    


        WorkflowRunBudgetEventType {
            SNAPSHOT_CREATED SNAPSHOT_CREATED
PRECHECK_CLAMPED PRECHECK_CLAMPED
PRECHECK_BLOCKED PRECHECK_BLOCKED
USAGE_RECORDED USAGE_RECORDED
WARN_THRESHOLD WARN_THRESHOLD
BUDGET_EXCEEDED BUDGET_EXCEEDED
EXTRA_APPROVED EXTRA_APPROVED
UNPRICED_USAGE UNPRICED_USAGE
        }
    


        WorkflowPermissionAction {
            VIEW VIEW
EDIT EDIT
START START
ADMIN ADMIN
        }
    


        TriggerType {
            WEBHOOK WEBHOOK
SCHEDULE SCHEDULE
EVENT EVENT
        }
    


        ReconciliationStatus {
            PENDING PENDING
RUNNING RUNNING
PASSED PASSED
FAILED FAILED
PARTIAL PARTIAL
ERROR ERROR
        }
    


        RequirementVerdictValue {
            PASS PASS
PARTIAL PARTIAL
FAIL FAIL
NOT_APPLICABLE NOT_APPLICABLE
NOT_VERIFIED NOT_VERIFIED
        }
    


        ReconciliationFindingSeverity {
            ERROR ERROR
WARNING WARNING
INFO INFO
        }
    


        ReconciliationJobStatus {
            PENDING PENDING
CLAIMED CLAIMED
RUNNING RUNNING
COMPLETED COMPLETED
FAILED FAILED
CANCELLED CANCELLED
        }
    


        DiscoveryScopeType {
            WORKFLOW_STAGE WORKFLOW_STAGE
WORK_ITEM WORK_ITEM
RUN RUN
        }
    


        DiscoverySessionStatus {
            OPEN OPEN
RESOLVING RESOLVING
BLOCKED BLOCKED
RESOLVED RESOLVED
ABANDONED ABANDONED
        }
    


        DiscoveryQuestionKind {
            single_select single_select
multi_select multi_select
freeform freeform
clarification clarification
        }
    


        DiscoveryQuestionSource {
            configured configured
llm llm
copilot copilot
human human
agent agent
        }
    


        DiscoveryQuestionStatus {
            OPEN OPEN
ANSWERED ANSWERED
DISMISSED DISMISSED
        }
    


        DiscoveryAssumptionStatus {
            PROPOSED PROPOSED
ACCEPTED ACCEPTED
REJECTED REJECTED
VALIDATED VALIDATED
INVALIDATED INVALIDATED
        }
    
  "users" {
    String id "🗝️"
    String email 
    String displayName 
    String passwordHash "❓"
    String iamUserId "❓"
    Boolean isActive 
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "teams" {
    String id "🗝️"
    String name 
    String description "❓"
    String externalIamTeamId "❓"
    String externalTeamKey "❓"
    String source 
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "team_variables" {
    String id "🗝️"
    String key 
    String label "❓"
    String type 
    String scope 
    String visibility 
    String visibilityScopeId "❓"
    String editableBy 
    Json value 
    String description "❓"
    String createdById "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "capabilities_cache" {
    String id "🗝️"
    String name 
    String type "❓"
    String status "❓"
    Boolean isGoverning 
    DateTime syncedAt 
    }
  

  "governance_overlay_snapshots" {
    String id "🗝️"
    String workItemId "❓"
    String workflowInstanceId "❓"
    String workflowNodeId "❓"
    String governedCapabilityId 
    String overlayHash 
    Json resolvedOverlayJson 
    DateTime resolvedAt 
    DateTime createdAt 
    }
  

  "governance_waivers" {
    String id "🗝️"
    String workItemId "❓"
    String workflowInstanceId "❓"
    String workflowNodeId "❓"
    String controlKey 
    String reason 
    String status 
    String requestedBy "❓"
    String approvedBy "❓"
    DateTime expiresAt "❓"
    String revokedBy "❓"
    DateTime revokedAt "❓"
    String revocationReason "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "departments" {
    String id "🗝️"
    String name 
    DateTime createdAt 
    }
  

  "roles" {
    String id "🗝️"
    String name 
    String description "❓"
    Boolean isSystemRole 
    DateTime createdAt 
    }
  

  "skills" {
    String id "🗝️"
    String name 
    String description "❓"
    String category "❓"
    DateTime createdAt 
    }
  

  "permissions" {
    String id "🗝️"
    String name 
    String resource 
    String action 
    String description "❓"
    }
  

  "user_roles" {
    DateTime grantedAt 
    String source 
    }
  

  "user_skills" {
    Int proficiencyLevel "❓"
    }
  

  "role_permissions" {

    }
  

  "team_members" {
    String id "🗝️"
    String userId 
    DateTime joinedAt 
    }
  

  "delegations" {
    String id "🗝️"
    String delegatorId 
    String delegateId 
    String scope "❓"
    DateTime startsAt 
    DateTime endsAt 
    DateTime createdAt 
    }
  

  "approval_authorities" {
    String id "🗝️"
    String userId 
    String resourceType 
    Decimal maxValue "❓"
    DateTime grantedAt 
    DateTime expiresAt "❓"
    }
  

  "initiatives" {
    String id "🗝️"
    String title 
    String description "❓"
    String status 
    String createdById 
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "initiative_owners" {
    String userId "🗝️"
    }
  

  "initiative_documents" {
    String id "🗝️"
    String documentId 
    DateTime createdAt 
    }
  

  "workflow_templates" {
    String id "🗝️"
    String name 
    String description "❓"
    String status 
    Int currentVersion 
    String createdById "❓"
    String tenantId "❓"
    String capabilityId "❓"
    DateTime archivedAt "❓"
    Json metadata "❓"
    String workflowTypeKey 
    Int typeVersion 
    Json typeSnapshot "❓"
    String profile 
    Json eligibleWorkItemTypes 
    Boolean isDefaultForType 
    WorkItemRoutingMode defaultRoutingMode 
    Json variables 
    Json budgetPolicy "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "run_snapshots" {
    String id "🗝️"
    String runId 
    String name 
    String status 
    Json payload 
    Int version 
    String createdById "❓"
    String tenantId "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "workflow_permissions" {
    String id "🗝️"
    String roleId 
    WorkflowPermissionAction action 
    DateTime grantedAt 
    }
  

  "workflow_access_grants" {
    String id "🗝️"
    String tenantId "❓"
    String subjectType 
    String subjectId 
    String action 
    String effect 
    DateTime startsAt "❓"
    DateTime endsAt "❓"
    String createdById "❓"
    Json metadata 
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "workflow_triggers" {
    String id "🗝️"
    TriggerType type 
    Boolean isActive 
    Json config 
    DateTime lastFiredAt "❓"
    DateTime createdAt 
    DateTime updatedAt 
    String tenantId "❓"
    }
  

  "workflow_template_versions" {
    String id "🗝️"
    Int version 
    Json graphSnapshot 
    String contentHash "❓"
    String source "❓"
    DateTime createdAt 
    }
  

  "workflow_design_phases" {
    String id "🗝️"
    String name 
    Int displayOrder 
    String color "❓"
    DateTime createdAt 
    }
  

  "workflow_design_nodes" {
    String id "🗝️"
    NodeType nodeType 
    String nodeTypeKey "❓"
    Int nodeTypeVersion "❓"
    Json nodeTypeSnapshot "❓"
    String label 
    Json config 
    Json compensationConfig "❓"
    ExecutionLocation executionLocation 
    Float positionX 
    Float positionY 
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "workflow_design_edges" {
    String id "🗝️"
    EdgeType edgeType 
    Json condition "❓"
    String label "❓"
    DateTime createdAt 
    }
  

  "workflow_instances" {
    String id "🗝️"
    Int templateVersion "❓"
    String tenantId "❓"
    String name 
    InstanceStatus status 
    Json context 
    String parentNodeId "❓"
    String profile 
    DateTime startedAt "❓"
    DateTime completedAt "❓"
    DateTime archivedAt "❓"
    String createdById "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "workflow_authorization_snapshots" {
    String id "🗝️"
    String tenantId "❓"
    String actorIamUserId "❓"
    String actorWorkGraphId "❓"
    String runOwnerId "❓"
    String workflowId "❓"
    String capabilityId "❓"
    String policyVersion 
    Json effectiveRoles 
    Json effectivePermissions 
    Json resourceGrants 
    String snapshotDigest 
    DateTime capturedAt 
    }
  

  "workflow_run_budgets" {
    String id "🗝️"
    String templateId "❓"
    Json policy 
    Int maxInputTokens "❓"
    Int maxOutputTokens "❓"
    Int maxTotalTokens "❓"
    Float maxEstimatedCost "❓"
    Int warnAtPercent 
    WorkflowBudgetEnforcementMode enforcementMode 
    Int consumedInputTokens 
    Int consumedOutputTokens 
    Int consumedTotalTokens 
    Float consumedEstimatedCost 
    String pricingStatus 
    WorkflowRunBudgetStatus status 
    DateTime warningEmittedAt "❓"
    DateTime exceededAt "❓"
    DateTime pausedAt "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "workflow_run_budget_events" {
    String id "🗝️"
    String instanceId 
    String nodeId "❓"
    String agentRunId "❓"
    String cfCallId "❓"
    String promptAssemblyId "❓"
    WorkflowRunBudgetEventType eventType 
    Int inputTokensDelta 
    Int outputTokensDelta 
    Int totalTokensDelta 
    Float estimatedCostDelta "❓"
    String pricingStatus 
    Json metadata "❓"
    DateTime createdAt 
    }
  

  "workflow_phases" {
    String id "🗝️"
    String name 
    Int displayOrder 
    String color "❓"
    DateTime createdAt 
    }
  

  "workflow_nodes" {
    String id "🗝️"
    NodeType nodeType 
    String nodeTypeKey "❓"
    Int nodeTypeVersion "❓"
    Json nodeTypeSnapshot "❓"
    String label 
    NodeStatus status 
    Json config 
    Json compensationConfig "❓"
    ExecutionLocation executionLocation 
    Float positionX 
    Float positionY 
    DateTime createdAt 
    DateTime updatedAt 
    DateTime startedAt "❓"
    DateTime completedAt "❓"
    Int attempt 
    }
  

  "workflow_edges" {
    String id "🗝️"
    EdgeType edgeType 
    Json condition "❓"
    String label "❓"
    DateTime createdAt 
    }
  

  "workflow_mutations" {
    String id "🗝️"
    String nodeId "❓"
    String mutationType 
    Json beforeState "❓"
    Json afterState "❓"
    String performedById "❓"
    DateTime performedAt 
    }
  

  "workflow_events" {
    String id "🗝️"
    String eventType 
    Json payload "❓"
    DateTime occurredAt 
    }
  

  "workflow_signals" {
    String id "🗝️"
    String instanceId 
    String signalName 
    String correlationKey "❓"
    Json payload "❓"
    DateTime emittedAt 
    DateTime consumedAt "❓"
    DateTime expiresAt 
    }
  

  "work_items" {
    String id "🗝️"
    String workCode 
    WorkItemOriginType originType 
    String workItemTypeKey 
    Int typeVersion 
    Json typeSnapshot "❓"
    WorkItemRoutingMode routingMode 
    DateTime scheduledAt "❓"
    DateTime notBefore "❓"
    String sourceEventTypeKey "❓"
    WorkItemRoutingState routingState 
    String title 
    String description "❓"
    String parentCapabilityId "❓"
    WorkItemStatus status 
    Json input 
    Json details 
    Json budget 
    WorkItemUrgency urgency 
    DateTime requiredBy "❓"
    Boolean detailsLocked 
    Json finalOutput "❓"
    Int priority 
    DateTime dueAt "❓"
    String createdById "❓"
    String approvedById "❓"
    String parentApprovalRequestId "❓"
    DateTime createdAt 
    DateTime updatedAt 
    String tenantId "❓"
    }
  

  "specification_versions" {
    String id "🗝️"
    Int version 
    Int revision 
    SpecificationStatus status 
    Json package 
    String renderedMarkdown "❓"
    String contentHash "❓"
    String createdById "❓"
    String approvedById "❓"
    DateTime approvedAt "❓"
    String approvalComment "❓"
    String supersedesId "❓"
    String tenantId "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "development_targets" {
    String id "🗝️"
    String specificationVersionId 
    String repository 
    String component "❓"
    String baseBranch 
    String baseCommitSha 
    Json requirementIds 
    Json requiredEvidence 
    Json forbiddenPaths 
    Json reconciliationPolicy 
    DateTime dueAt "❓"
    String status 
    DateTime publishedAt "❓"
    String tenantId "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "implementation_submissions" {
    String id "🗝️"
    String specificationHash 
    String repository 
    String baseCommitSha 
    String headCommitSha 
    Int pullRequestNumber "❓"
    Json manifest "❓"
    Json claims 
    Json deviations 
    String source 
    String status 
    String tenantId "❓"
    DateTime createdAt 
    }
  

  "reconciliation_runs" {
    String id "🗝️"
    String specificationVersionId 
    String specificationHash "❓"
    String mode 
    ReconciliationStatus status 
    Json summary 
    String traceId "❓"
    String startedById "❓"
    DateTime startedAt 
    DateTime completedAt "❓"
    String tenantId "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "requirement_verdicts" {
    String id "🗝️"
    String requirementId 
    String priority "❓"
    RequirementVerdictValue verdict 
    String claimStatus "❓"
    String rationale "❓"
    Json evidence 
    Boolean verified 
    DateTime createdAt 
    }
  

  "reconciliation_findings" {
    String id "🗝️"
    String requirementId "❓"
    String kind 
    ReconciliationFindingSeverity severity 
    String message 
    Json detail "❓"
    DateTime createdAt 
    }
  

  "reconciliation_jobs" {
    String id "🗝️"
    String workItemId 
    String submissionId 
    ReconciliationJobStatus status 
    String repository 
    String baseCommitSha 
    String headCommitSha 
    Json testPlan 
    String claimToken "❓"
    String claimedBy "❓"
    DateTime claimedAt "❓"
    Int attempts 
    Json result "❓"
    String error "❓"
    String tenantId "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "work_item_dependencies" {
    String id "🗝️"
    String dependencyType 
    Json condition "❓"
    String createdById "❓"
    String tenantId "❓"
    DateTime createdAt 
    }
  

  "work_programs" {
    String id "🗝️"
    String name 
    String description "❓"
    String capabilityId "❓"
    Int version 
    String status 
    Json metadata 
    String createdById "❓"
    String tenantId "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "work_program_steps" {
    String id "🗝️"
    String stepKey 
    Int ordinal 
    String titleTemplate 
    String descriptionTemplate "❓"
    String workItemTypeKey 
    String targetCapabilityId 
    WorkItemRoutingMode routingMode 
    Json inputMapping 
    Json dependsOnKeys 
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "work_program_runs" {
    String id "🗝️"
    String status 
    Json input 
    Json output "❓"
    String startedById "❓"
    String tenantId "❓"
    DateTime startedAt 
    DateTime completedAt "❓"
    }
  

  "work_program_run_steps" {
    String id "🗝️"
    String status 
    Json output "❓"
    DateTime startedAt "❓"
    DateTime completedAt "❓"
    }
  

  "work_item_targets" {
    String id "🗝️"
    String targetCapabilityId 
    String roleKey "❓"
    WorkItemTargetStatus status 
    String claimedById "❓"
    Json output "❓"
    DateTime claimedAt "❓"
    DateTime startedAt "❓"
    DateTime submittedAt "❓"
    DateTime completedAt "❓"
    DateTime createdAt 
    DateTime updatedAt 
    String tenantId "❓"
    }
  

  "work_item_events" {
    String id "🗝️"
    WorkItemEventType eventType 
    String actorId "❓"
    Json payload "❓"
    DateTime createdAt 
    String tenantId "❓"
    }
  

  "work_item_clarifications" {
    String id "🗝️"
    WorkItemClarificationDirection direction 
    WorkItemClarificationStatus status 
    String question 
    String answer "❓"
    String requestedById "❓"
    String answeredById "❓"
    DateTime answeredAt "❓"
    Json payload "❓"
    DateTime createdAt 
    DateTime updatedAt 
    String tenantId "❓"
    }
  

  "metadata_definitions" {
    String id "🗝️"
    MetadataDefinitionKind kind 
    String key 
    Int version 
    MetadataDefinitionStatus status 
    MetadataScopeType scopeType 
    String scopeId 
    String label 
    String description "❓"
    String icon "❓"
    String color "❓"
    String category "❓"
    Json schema 
    Json defaults 
    Json policy 
    Json ui 
    Json compatibility 
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "work_item_routing_policies" {
    String id "🗝️"
    String capabilityId 
    String workItemTypeKey 
    String workflowTypeKey 
    WorkItemRoutingMode routingMode 
    Int priority 
    Json selector 
    Boolean isActive 
    DateTime createdAt 
    DateTime updatedAt 
    String tenantId "❓"
    }
  

  "work_item_triggers" {
    String id "🗝️"
    WorkItemTriggerType triggerType 
    String eventTypeKey "❓"
    String capabilityId "❓"
    String workItemTypeKey 
    WorkItemRoutingMode routingMode 
    Json scheduleConfig 
    Json payloadMapping 
    String dedupeKey "❓"
    Boolean isActive 
    DateTime lastFiredAt "❓"
    DateTime createdAt 
    DateTime updatedAt 
    String tenantId "❓"
    }
  

  "work_item_event_dedup" {
    String id "🗝️"
    String triggerId 
    String dedupeValue 
    String workItemId "❓"
    DateTime claimedAt 
    }
  

  "tasks" {
    String id "🗝️"
    String tenantId "❓"
    String nodeId "❓"
    String title 
    String description "❓"
    TaskStatus status 
    AssignmentMode assignmentMode 
    Int priority 
    DateTime dueAt "❓"
    Json formSchema "❓"
    Json formData "❓"
    String createdById "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "task_assignments" {
    String id "🗝️"
    String assignedToId "❓"
    String teamId "❓"
    String roleId "❓"
    String skillId "❓"
    DateTime assignedAt 
    DateTime claimedAt "❓"
    DateTime completedAt "❓"
    }
  

  "team_queue_items" {
    String id "🗝️"
    String roleKey "❓"
    String skillKey "❓"
    String capabilityId "❓"
    String assignmentMode "❓"
    String claimedById "❓"
    DateTime enqueuedAt 
    DateTime claimedAt "❓"
    }
  

  "task_comments" {
    String id "🗝️"
    String authorId 
    String content 
    DateTime createdAt 
    }
  

  "task_status_history" {
    String id "🗝️"
    TaskStatus previousStatus "❓"
    TaskStatus newStatus 
    String changedById "❓"
    String reason "❓"
    DateTime changedAt 
    }
  

  "approval_requests" {
    String id "🗝️"
    String instanceId "❓"
    String tenantId "❓"
    String nodeId "❓"
    String subjectType 
    String subjectId 
    String requestedById 
    String assignedToId "❓"
    String assignmentMode "❓"
    String teamId "❓"
    String roleKey "❓"
    String skillKey "❓"
    String capabilityId "❓"
    ApprovalStatus status 
    DateTime dueAt "❓"
    Json formData "❓"
    Int quorumRequired 
    Boolean adminOverride 
    DateTime quorumMetAt "❓"
    Json escalationPolicy 
    Int escalationLevel 
    DateTime nextEscalationAt "❓"
    DateTime lastEscalatedAt "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "approval_decisions" {
    String id "🗝️"
    String decidedById 
    ApprovalStatus decision 
    String conditions "❓"
    String notes "❓"
    DateTime decidedAt 
    }
  

  "approval_escalations" {
    String id "🗝️"
    Int level 
    String targetUserId "❓"
    String targetTeamId "❓"
    String targetRoleKey "❓"
    String targetSkillKey "❓"
    String reason "❓"
    DateTime createdAt 
    }
  

  "planner_sessions" {
    String id "🗝️"
    String capabilityId 
    String createdById 
    String title "❓"
    String story "❓"
    String status 
    String intent "❓"
    String modelAlias "❓"
    String runtimePreference "❓"
    String governancePreset "❓"
    Json messages 
    Json milestones 
    Json critic "❓"
    Json metadata 
    Int version 
    String tenantId "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "planner_session_revisions" {
    String id "🗝️"
    Int version 
    Json messages 
    Json milestones 
    Json response "❓"
    String createdById "❓"
    DateTime createdAt 
    }
  

  "work_notifications" {
    String id "🗝️"
    String userId "❓"
    String teamId "❓"
    String tenantId "❓"
    String kind 
    String title 
    String message 
    String source 
    String threadKey "❓"
    String severity 
    String status 
    String entityType "❓"
    String entityId "❓"
    String href "❓"
    Json payload 
    Json why 
    Json deliveryPolicy 
    DateTime dueAt "❓"
    DateTime readAt "❓"
    DateTime resolvedAt "❓"
    DateTime snoozedUntil "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "workflow_checkpoints" {
    String id "🗝️"
    Int sequence 
    String checkpointType 
    String nodeId "❓"
    Json nodeStates 
    Json context 
    String traceId "❓"
    String reason "❓"
    String createdById "❓"
    DateTime createdAt 
    }
  

  "workflow_simulations" {
    String id "🗝️"
    String createdById "❓"
    String tenantId "❓"
    String status 
    Json input 
    Json result "❓"
    String traceId "❓"
    String error "❓"
    DateTime createdAt 
    DateTime completedAt "❓"
    }
  

  "workflow_replays" {
    String id "🗝️"
    String requestedById "❓"
    String status 
    Json input 
    Json result "❓"
    String error "❓"
    DateTime createdAt 
    DateTime completedAt "❓"
    }
  

  "consumable_types" {
    String id "🗝️"
    String name 
    String description "❓"
    Json schemaDef 
    String ownerRoleId "❓"
    Boolean requiresApproval 
    Boolean allowVersioning 
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "consumables" {
    String id "🗝️"
    String tenantId "❓"
    String nodeId "❓"
    String name 
    ConsumableStatus status 
    Int currentVersion 
    Json formData "❓"
    String assignedToId "❓"
    String assignmentMode "❓"
    String teamId "❓"
    String roleKey "❓"
    String skillKey "❓"
    String capabilityId "❓"
    String createdById "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "consumable_versions" {
    String id "🗝️"
    Int version 
    Json payload 
    String createdById "❓"
    DateTime createdAt 
    }
  

  "consumable_events" {
    String id "🗝️"
    String eventType 
    Json payload "❓"
    DateTime occurredAt 
    }
  

  "agents" {
    String id "🗝️"
    String name 
    String description "❓"
    String provider 
    String model 
    String systemPrompt "❓"
    Boolean isActive 
    String externalTemplateId "❓"
    DateTime externalSyncedAt "❓"
    String sourceHash "❓"
    String sourceVersion "❓"
    String fetchedBy "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "agent_skills" {

    }
  

  "agent_runs" {
    String id "🗝️"
    String tenantId "❓"
    String nodeId "❓"
    Int attempt "❓"
    AgentRunStatus status 
    String initiatedById "❓"
    String origin 
    String client "❓"
    String traceId "❓"
    String cfCallId "❓"
    String promptAssemblyId "❓"
    String mcpServerId "❓"
    String mcpInvocationId "❓"
    String contextPackageId "❓"
    String modelCallId "❓"
    String laptopInvocationId "❓"
    DateTime startedAt "❓"
    DateTime completedAt "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "agent_run_inputs" {
    String id "🗝️"
    String inputType 
    Json payload 
    DateTime createdAt 
    }
  

  "agent_run_outputs" {
    String id "🗝️"
    String outputType 
    String rawContent "❓"
    Json structuredPayload "❓"
    Int tokenCount "❓"
    DateTime createdAt 
    }
  

  "agent_reviews" {
    String id "🗝️"
    String reviewedById 
    String decision 
    String notes "❓"
    DateTime reviewedAt 
    }
  

  "laptop_invocations" {
    String id "🗝️"
    String capabilityId "❓"
    String client 
    String mode 
    String status 
    String userId "❓"
    String tenantId "❓"
    String mcpUrl "❓"
    String mcpTokenJti "❓"
    String repoUrl "❓"
    String branch "❓"
    String baseCommitSha "❓"
    String renderedPrompt "❓"
    String promptAssemblyId "❓"
    String envelopeAssemblyId "❓"
    Json agentSpec 
    Json data 
    DateTime lastHeartbeatAt "❓"
    DateTime startedAt 
    DateTime endedAt "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "laptop_questions" {
    String id "🗝️"
    String workItemId 
    String question 
    Json context 
    String status 
    String answer "❓"
    String askedById "❓"
    String answeredById "❓"
    DateTime askedAt 
    DateTime answeredAt "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "blueprint_sessions" {
    String id "🗝️"
    String goal 
    BlueprintSourceType sourceType 
    String sourceUri 
    String sourceRef "❓"
    Json includeGlobs 
    Json excludeGlobs 
    String capabilityId 
    String architectAgentTemplateId 
    String developerAgentTemplateId 
    String qaAgentTemplateId 
    BlueprintSessionStatus status 
    String workflowInstanceId "❓"
    String multinodeInstanceKey "❓"
    String phaseId "❓"
    Json metadata 
    String createdById "❓"
    String approvedById "❓"
    DateTime approvedAt "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "blueprint_source_snapshots" {
    String id "🗝️"
    String status 
    Json manifest 
    Json summary 
    Int fileCount 
    Int totalBytes 
    String rootHash "❓"
    String error "❓"
    DateTime createdAt 
    }
  

  "blueprint_stage_runs" {
    String id "🗝️"
    BlueprintStage stage 
    BlueprintStageStatus status 
    String task 
    String response "❓"
    String error "❓"
    Json correlation "❓"
    Json tokensUsed "❓"
    DateTime startedAt "❓"
    DateTime completedAt "❓"
    DateTime createdAt 
    }
  

  "blueprint_artifacts" {
    String id "🗝️"
    BlueprintStage stage "❓"
    String kind 
    String title 
    String content "❓"
    Json payload "❓"
    DateTime createdAt 
    }
  

  "tools" {
    String id "🗝️"
    String name 
    String description "❓"
    RiskLevel riskLevel 
    Boolean requiresApproval 
    Boolean isActive 
    String externalToolName "❓"
    String externalVersion "❓"
    DateTime externalSyncedAt "❓"
    String sourceHash "❓"
    String sourceVersion "❓"
    String fetchedBy "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "tool_actions" {
    String id "🗝️"
    String name 
    String description "❓"
    Json inputSchema 
    Json outputSchema 
    RiskLevel riskLevel 
    }
  

  "tool_permissions" {
    String id "🗝️"
    String toolId 
    String roleId "❓"
    String actionId "❓"
    DateTime grantedAt 
    }
  

  "execution_runners" {
    String id "🗝️"
    String name 
    String runnerType 
    Json config 
    Boolean isActive 
    }
  

  "tool_runs" {
    String id "🗝️"
    String actionId "❓"
    String tenantId "❓"
    String runnerId "❓"
    ToolRunStatus status 
    Json inputPayload 
    Json outputPayload "❓"
    String requestedById "❓"
    String idempotencyKey "❓"
    DateTime startedAt "❓"
    DateTime completedAt "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "tool_run_approvals" {
    String id "🗝️"
    String approvalRequestId "❓"
    String approvedById "❓"
    String decision "❓"
    DateTime decidedAt "❓"
    }
  

  "policies" {
    String id "🗝️"
    String name 
    String description "❓"
    String resourceType 
    Boolean isActive 
    Int priority 
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "policy_conditions" {
    String id "🗝️"
    String fieldPath 
    String operator 
    Json value 
    String logicalOperator 
    }
  

  "policy_actions" {
    String id "🗝️"
    String actionType 
    Json actionConfig 
    }
  

  "event_log" {
    String id "🗝️"
    String eventType 
    String entityType 
    String entityId 
    String actorId "❓"
    String traceId "❓"
    String tenantId "❓"
    Json payload "❓"
    DateTime occurredAt 
    }
  

  "receipts" {
    String id "🗝️"
    String receiptType 
    String entityType 
    String entityId 
    String eventLogId "❓"
    Json content 
    DateTime generatedAt 
    }
  

  "documents" {
    String id "🗝️"
    String name 
    String kind 
    String mimeType "❓"
    BigInt sizeBytes "❓"
    String storageKey "❓"
    String bucket "❓"
    String url "❓"
    String provider "❓"
    String uploadedById "❓"
    DateTime uploadedAt 
    String tenantId "❓"
    }
  

  "custom_node_types" {
    String id "🗝️"
    String name 
    String label 
    String description "❓"
    String color 
    String icon 
    String baseType 
    Json fields 
    Boolean supportsForms 
    Boolean isActive 
    String createdById "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "outbox_events" {
    String id "🗝️"
    String aggregateType 
    String aggregateId 
    String eventType 
    Json payload 
    OutboxStatus status 
    DateTime createdAt 
    DateTime processedAt "❓"
    String errorMessage "❓"
    }
  

  "connectors" {
    String id "🗝️"
    ConnectorType type 
    String name 
    String description "❓"
    Json config 
    Json credentials 
    DateTime archivedAt "❓"
    String createdById "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "pending_executions" {
    String id "🗝️"
    Int attempt 
    ExecutionLocation location 
    String claimToken 
    Json payload "❓"
    DateTime claimedAt "❓"
    String claimedBy "❓"
    DateTime completedAt "❓"
    Json result "❓"
    String error "❓"
    DateTime expiresAt 
    DateTime createdAt 
    }
  

  "artifact_templates" {
    String id "🗝️"
    String name 
    String description "❓"
    String type 
    String status 
    Int version 
    Json sections 
    Json parties 
    Json metadata "❓"
    String createdById 
    String teamName "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "event_outbox" {
    String id "🗝️"
    String eventName 
    String sourceService 
    String traceId "❓"
    String subjectKind 
    String subjectId 
    Json envelope 
    String tenantId "❓"
    String status 
    Int attempts 
    DateTime emittedAt 
    DateTime lastAttemptAt "❓"
    String lastError "❓"
    }
  

  "event_subscriptions" {
    String id "🗝️"
    String subscriberId 
    String eventPattern 
    String targetUrl 
    String secret "❓"
    Boolean isActive 
    Json metadata "❓"
    String createdById "❓"
    String tenantId "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "event_deliveries" {
    String id "🗝️"
    String status 
    Int attempts 
    DateTime lastAttemptAt "❓"
    String lastError "❓"
    DateTime deliveredAt "❓"
    Int responseStatus "❓"
    DateTime createdAt 
    }
  

  "prompt_profile_snapshots" {
    String id "🗝️"
    String externalId 
    String name "❓"
    String capabilityId "❓"
    String scope "❓"
    Json payload 
    String sourceHash 
    String sourceVersion "❓"
    DateTime fetchedAt 
    String fetchedBy "❓"
    DateTime createdAt 
    }
  

  "capability_snapshots" {
    String id "🗝️"
    String externalId 
    String capabilityKey "❓"
    String name "❓"
    String capabilityType "❓"
    Json payload 
    String sourceHash 
    String sourceVersion "❓"
    DateTime fetchedAt 
    String fetchedBy "❓"
    DateTime createdAt 
    }
  

  "feature_flags" {
    String key "🗝️"
    Boolean enabled 
    String description "❓"
    String updatedById "❓"
    DateTime updatedAt 
    }
  

  "workbench_definitions" {
    String id "🗝️"
    String workflowNodeId 
    String name 
    Int version 
    String goal "❓"
    String sourceType "❓"
    String sourceUri "❓"
    String sourceRef "❓"
    String capabilityId "❓"
    String architectAgentTemplateId "❓"
    String developerAgentTemplateId "❓"
    String qaAgentTemplateId "❓"
    Int maxLoopsPerStage 
    Int maxTotalSendBacks 
    String gateMode 
    String finalPackKey "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "workbench_stages" {
    String id "🗝️"
    String stageKey 
    String label 
    String agentRole 
    String agentTemplateId "❓"
    String promptProfileKey "❓"
    Int ordinal 
    Float positionX "❓"
    Float positionY "❓"
    Boolean required 
    Boolean terminal 
    Boolean approvalRequired 
    Boolean repoAccess 
    String toolPolicy 
    String contextPolicy 
    String governancePolicyId "❓"
    String governanceEnforcement "❓"
    Int governancePriority "❓"
    Json governanceContributions "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "workbench_expected_artifacts" {
    String id "🗝️"
    String kind 
    String title 
    String description "❓"
    String format 
    Boolean required 
    Int ordinal 
    Boolean editable 
    String templateId "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "workbench_stage_edges" {
    String id "🗝️"
    String kind 
    String label "❓"
    DateTime createdAt 
    }
  

  "workbench_artifact_consumes" {
    String id "🗝️"
    Boolean required 
    Boolean inferred 
    DateTime createdAt 
    }
  

  "workbench_stage_questions" {
    String id "🗝️"
    String questionId 
    String text 
    Boolean required 
    Boolean freeform 
    Int ordinal 
    Json options "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "llm_routing" {
    String id "🗝️"
    String touchPoint 
    String scopeType 
    String scopeId 
    String modelAlias 
    Boolean enabled 
    Float positionX "❓"
    Float positionY "❓"
    String createdById "❓"
    String tenantId "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "llm_connection" {
    String id "🗝️"
    String name 
    String provider 
    String baseUrl "❓"
    String model 
    String alias 
    String credentialEnv "❓"
    Boolean enabled 
    String createdById "❓"
    String tenantId "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "loop_strategies" {
    String id "🗝️"
    String tenantId "❓"
    String name 
    String description "❓"
    String kind 
    String status 
    Int currentVersion 
    String createdById "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "loop_strategy_versions" {
    String id "🗝️"
    String tenantId "❓"
    Int version 
    Json definition 
    String contentHash 
    String createdById "❓"
    DateTime publishedAt "❓"
    DateTime createdAt 
    }
  

  "codegen_specs" {
    String id "🗝️"
    String specName 
    String version 
    String kind 
    String state 
    String yaml 
    Json canonicalJson 
    String specHash 
    Json irJson "❓"
    String irHash "❓"
    String workItemId "❓"
    String createdById "❓"
    String tenantId "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "codegen_spec_lifecycle_events" {
    String id "🗝️"
    String fromState "❓"
    String toState 
    String actorId "❓"
    String reason "❓"
    Json payload "❓"
    DateTime occurredAt 
    }
  

  "codegen_runs" {
    String id "🗝️"
    String irHash 
    String templateVersion 
    String generatorVersion 
    String status 
    String mode 
    String outputPath "❓"
    String workflowInstanceId "❓"
    String tenantId "❓"
    DateTime startedAt 
    DateTime completedAt "❓"
    }
  

  "codegen_repo_models" {
    String id "🗝️"
    String repoPath 
    String language 
    String framework 
    Json modelJson 
    String modelHash 
    String scannedById "❓"
    String tenantId "❓"
    DateTime scannedAt 
    }
  

  "codegen_change_plans" {
    String id "🗝️"
    Json enhancementSpecJson 
    String enhancementSpecHash 
    Json planJson 
    String planHash 
    String status 
    String tenantId "❓"
    DateTime createdAt 
    DateTime appliedAt "❓"
    }
  

  "codegen_artifacts" {
    String id "🗝️"
    String path 
    String contentHash 
    String fileType 
    String generatedBy 
    Boolean protected 
    String content "❓"
    Int sizeBytes "❓"
    DateTime createdAt 
    }
  

  "codegen_gaps" {
    String id "🗝️"
    String gapType 
    String severity 
    String filePath "❓"
    String className "❓"
    String methodName "❓"
    String regionId "❓"
    String description 
    String recommendedResolution "❓"
    Boolean llmEligible 
    Boolean resolved 
    DateTime createdAt 
    DateTime resolvedAt "❓"
    }
  

  "codegen_llm_patch_tasks" {
    String id "🗝️"
    String gapId "❓"
    String taskType 
    String status 
    String targetFile 
    String targetClass "❓"
    String targetMethod "❓"
    String regionId 
    Json allowedChanges 
    Json forbiddenChanges 
    String promptHash "❓"
    String responseHash "❓"
    String cfCallId "❓"
    String bundleHash "❓"
    Json metadata "❓"
    DateTime createdAt 
    DateTime dispatchedAt "❓"
    DateTime completedAt "❓"
    }
  

  "codegen_verifications" {
    String id "🗝️"
    String status 
    Json result 
    DateTime createdAt 
    }
  

  "codegen_receipts" {
    String id "🗝️"
    Json receiptJson 
    String receiptHash 
    DateTime createdAt 
    }
  

  "workflow_run_clones" {
    String id "🗝️"
    String sourceInstanceId 
    String cloneInstanceId "❓"
    String sourceCheckpointId "❓"
    String requestedById "❓"
    String tenantId "❓"
    String reason "❓"
    String status 
    Json isolatedContext 
    DateTime createdAt 
    DateTime completedAt "❓"
    String error "❓"
    }
  

  "workflow_template_migrations" {
    String id "🗝️"
    String templateId 
    Int fromVersion 
    Int toVersion 
    Json nodeMap 
    String status 
    Json warnings 
    String createdById "❓"
    String tenantId "❓"
    DateTime createdAt 
    DateTime appliedAt "❓"
    }
  

  "workflow_time_travel_snapshots" {
    String id "🗝️"
    String instanceId 
    String checkpointId "❓"
    String nodeId "❓"
    String tenantId "❓"
    Json context 
    Json nodeStates 
    Json routingDecisions 
    Json promptReferences 
    Json policySnapshot 
    Json artifactReferences 
    String createdById "❓"
    DateTime createdAt 
    }
  

  "workflow_compensation_executions" {
    String id "🗝️"
    String instanceId 
    String nodeId 
    String actionKey 
    String tenantId "❓"
    String status 
    Json config 
    Json result "❓"
    String requestedById "❓"
    DateTime createdAt 
    DateTime completedAt "❓"
    String error "❓"
    }
  

  "work_comments" {
    String id "🗝️"
    String tenantId "❓"
    String entityType 
    String entityId 
    String authorId 
    String parentId "❓"
    String body 
    Json mentions 
    String status 
    DateTime createdAt 
    DateTime updatedAt 
    DateTime resolvedAt "❓"
    String resolvedBy "❓"
    }
  

  "notification_preferences" {
    String id "🗝️"
    String tenantId "❓"
    String userId 
    Json categories 
    Json channels 
    String digestMode 
    Json quietHours 
    String severityMin 
    String timezone 
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "notification_subscriptions" {
    String id "🗝️"
    String tenantId "❓"
    String userId "❓"
    String teamId "❓"
    String entityType "❓"
    String entityId "❓"
    String capabilityId "❓"
    String workflowId "❓"
    String severityMin 
    Json channels 
    Boolean enabled 
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "notification_deliveries" {
    String id "🗝️"
    String notificationId 
    String tenantId "❓"
    String channel 
    String status 
    Int attempts 
    String providerId "❓"
    String lastError "❓"
    DateTime nextAttemptAt "❓"
    DateTime deliveredAt "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "notification_audit" {
    String id "🗝️"
    String notificationId 
    String tenantId "❓"
    String actorId "❓"
    String action 
    String channel "❓"
    Json details 
    DateTime createdAt 
    }
  

  "out_of_office_delegations" {
    String id "🗝️"
    String tenantId "❓"
    String principalUserId 
    String delegateUserId 
    DateTime startsAt 
    DateTime endsAt 
    String reason "❓"
    String status 
    String createdById "❓"
    DateTime createdAt 
    DateTime revokedAt "❓"
    }
  

  "governance_policies" {
    String id "🗝️"
    String tenantId "❓"
    String name 
    String description "❓"
    String capabilityId "❓"
    String workflowId "❓"
    String workItemTypeKey "❓"
    String mode 
    String status 
    Int currentVersion 
    String createdById "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "governance_policy_versions" {
    String id "🗝️"
    String policyId 
    String tenantId "❓"
    Int version 
    String mode 
    Json rules 
    Json snapshot 
    String createdById "❓"
    DateTime createdAt 
    DateTime activatedAt "❓"
    }
  

  "governance_policy_evaluations" {
    String id "🗝️"
    String policyId 
    Int policyVersion 
    String tenantId "❓"
    String instanceId "❓"
    String nodeId "❓"
    String workItemId "❓"
    String mode 
    String status 
    Json evidence 
    Json missing 
    Json result 
    String evaluatedById "❓"
    DateTime createdAt 
    }
  

  "capacity_calendars" {
    String id "🗝️"
    String tenantId "❓"
    String ownerType 
    String ownerId 
    String timezone 
    Json weeklyHours 
    Json holidays 
    Int wipLimit "❓"
    String createdById "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "capacity_allocations" {
    String id "🗝️"
    String tenantId "❓"
    String calendarId 
    String workItemId "❓"
    String programStepId "❓"
    String capabilityId "❓"
    String skillKey "❓"
    DateTime startAt 
    DateTime endAt 
    Float estimatedHours 
    String status 
    String risk 
    Json metadata 
    String createdById "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "planning_forecasts" {
    String id "🗝️"
    String tenantId "❓"
    String plannerSessionId "❓"
    String capabilityId "❓"
    Json scenario 
    String status 
    Json result 
    String createdById "❓"
    DateTime createdAt 
    }
  

  "runtime_policies" {
    String id "🗝️"
    String tenantId "❓"
    String name 
    String minVersion "❓"
    Json allowedPaths 
    String consentMode 
    Boolean autoUpdate 
    Boolean killSwitch 
    Boolean enabled 
    String createdById "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "runtime_devices" {
    String id "🗝️"
    String tenantId "❓"
    String userId 
    String runtimeId 
    String deviceName 
    String platform 
    String version "❓"
    String status 
    String policyId "❓"
    Json workspaceProfiles 
    DateTime lastSeenAt "❓"
    DateTime revokedAt "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "runtime_consents" {
    String id "🗝️"
    String tenantId "❓"
    String runtimeId 
    String userId 
    String action 
    String scope 
    String decision 
    String reason "❓"
    DateTime expiresAt "❓"
    DateTime createdAt 
    }
  

  "grounding_evidence" {
    String id "🗝️"
    String tenantId "❓"
    String instanceId "❓"
    String nodeId "❓"
    String agentRunId "❓"
    String sourceType 
    String sourceUri "❓"
    String contentHash "❓"
    DateTime retrievedAt 
    Float influenceScore "❓"
    String outcome "❓"
    Json feedback 
    DateTime createdAt 
    }
  

  "code_impact_snapshots" {
    String id "🗝️"
    String tenantId "❓"
    String instanceId "❓"
    String nodeId "❓"
    String workItemId "❓"
    String commitSha "❓"
    String query "❓"
    String provider 
    Json files 
    Json callGraph 
    Json matches 
    Float riskScore "❓"
    String createdById "❓"
    DateTime createdAt 
    }
  

  "independent_verifications" {
    String id "🗝️"
    String tenantId "❓"
    String instanceId "❓"
    String nodeId "❓"
    String workItemId "❓"
    String commitSha "❓"
    String environment "❓"
    String command 
    String status 
    Json result 
    Json testSummary 
    Json coverage 
    Float riskScore "❓"
    DateTime startedAt "❓"
    DateTime completedAt "❓"
    String requestedById "❓"
    DateTime createdAt 
    }
  

  "verification_findings" {
    String id "🗝️"
    String verificationId 
    String tenantId "❓"
    String filePath "❓"
    String ruleKey "❓"
    String severity 
    String message 
    Json evidence 
    DateTime createdAt 
    }
  

  "discovery_sessions" {
    String id "🗝️"
    String tenantId "❓"
    DiscoveryScopeType scopeType 
    String scopeId 
    DiscoverySessionStatus status 
    String touchPoint "❓"
    Json budget "❓"
    String createdById "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "discovery_questions" {
    String id "🗝️"
    String tenantId "❓"
    String text 
    DiscoveryQuestionKind kind 
    DiscoveryQuestionSource source 
    Boolean blocking 
    DiscoveryQuestionStatus status 
    Json options "❓"
    String answer "❓"
    String answeredById "❓"
    DateTime answeredAt "❓"
    String proposedAnswer "❓"
    Float confidence "❓"
    Int ordinal 
    String sourceType "❓"
    String sourceId "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "discovery_assumptions" {
    String id "🗝️"
    String tenantId "❓"
    String text 
    Float confidence 
    DiscoveryAssumptionStatus status 
    String validatedById "❓"
    DateTime validatedAt "❓"
    Json evidenceRef "❓"
    DateTime createdAt 
    DateTime updatedAt 
    }
  
    "users" }o--|o teams : "team"
    "teams" }o--|o departments : "department"
    "team_variables" }o--|| teams : "team"
    "departments" |o--|o departments : "parent"
    "user_roles" }o--|| users : "user"
    "user_roles" }o--|| roles : "role"
    "user_skills" }o--|| users : "user"
    "user_skills" }o--|| skills : "skill"
    "role_permissions" }o--|| roles : "role"
    "role_permissions" }o--|| permissions : "permission"
    "team_members" }o--|| teams : "team"
    "initiative_owners" }o--|| initiatives : "initiative"
    "initiative_documents" }o--|| initiatives : "initiative"
    "workflow_templates" }o--|| teams : "team"
    "workflow_templates" |o--|| "WorkItemRoutingMode" : "enum:defaultRoutingMode"
    "run_snapshots" }o--|| workflow_templates : "workflow"
    "workflow_permissions" |o--|| "WorkflowPermissionAction" : "enum:action"
    "workflow_permissions" }o--|| workflow_templates : "template"
    "workflow_access_grants" }o--|| workflow_templates : "workflow"
    "workflow_triggers" }o--|| workflow_templates : "template"
    "workflow_triggers" |o--|| "TriggerType" : "enum:type"
    "workflow_template_versions" }o--|| workflow_templates : "template"
    "workflow_design_phases" }o--|| workflow_templates : "workflow"
    "workflow_design_nodes" |o--|| "NodeType" : "enum:nodeType"
    "workflow_design_nodes" |o--|| "ExecutionLocation" : "enum:executionLocation"
    "workflow_design_nodes" }o--|| workflow_templates : "workflow"
    "workflow_design_nodes" }o--|o workflow_design_phases : "phase"
    "workflow_design_edges" |o--|| "EdgeType" : "enum:edgeType"
    "workflow_design_edges" }o--|| workflow_templates : "workflow"
    "workflow_design_edges" }o--|| workflow_design_nodes : "source"
    "workflow_design_edges" }o--|| workflow_design_nodes : "target"
    "workflow_instances" }o--|o workflow_templates : "template"
    "workflow_instances" |o--|| "InstanceStatus" : "enum:status"
    "workflow_instances" }o--|o initiatives : "initiative"
    "workflow_instances" |o--|o workflow_instances : "parent"
    "workflow_authorization_snapshots" |o--|| workflow_instances : "instance"
    "workflow_run_budgets" |o--|| "WorkflowBudgetEnforcementMode" : "enum:enforcementMode"
    "workflow_run_budgets" |o--|| "WorkflowRunBudgetStatus" : "enum:status"
    "workflow_run_budgets" |o--|| workflow_instances : "instance"
    "workflow_run_budget_events" |o--|| "WorkflowRunBudgetEventType" : "enum:eventType"
    "workflow_run_budget_events" }o--|| workflow_run_budgets : "budget"
    "workflow_phases" }o--|| workflow_instances : "instance"
    "workflow_nodes" |o--|| "NodeType" : "enum:nodeType"
    "workflow_nodes" |o--|| "NodeStatus" : "enum:status"
    "workflow_nodes" |o--|| "ExecutionLocation" : "enum:executionLocation"
    "workflow_nodes" }o--|| workflow_instances : "instance"
    "workflow_nodes" }o--|o workflow_phases : "phase"
    "workflow_edges" |o--|| "EdgeType" : "enum:edgeType"
    "workflow_edges" }o--|| workflow_instances : "instance"
    "workflow_edges" }o--|| workflow_nodes : "source"
    "workflow_edges" }o--|| workflow_nodes : "target"
    "workflow_mutations" }o--|| workflow_instances : "instance"
    "workflow_events" }o--|| workflow_instances : "instance"
    "work_items" |o--|| "WorkItemOriginType" : "enum:originType"
    "work_items" |o--|| "WorkItemRoutingMode" : "enum:routingMode"
    "work_items" |o--|| "WorkItemRoutingState" : "enum:routingState"
    "work_items" |o--|| "WorkItemStatus" : "enum:status"
    "work_items" |o--|| "WorkItemUrgency" : "enum:urgency"
    "work_items" }o--|o workflow_instances : "sourceWorkflowInstance"
    "work_items" }o--|o workflow_nodes : "sourceWorkflowNode"
    "work_items" }o--|o work_item_routing_policies : "routingPolicy"
    "specification_versions" |o--|| "SpecificationStatus" : "enum:status"
    "specification_versions" }o--|| work_items : "workItem"
    "development_targets" |o--|| work_items : "workItem"
    "implementation_submissions" }o--|| specification_versions : "specificationVersion"
    "implementation_submissions" }o--|| work_items : "workItem"
    "reconciliation_runs" |o--|| "ReconciliationStatus" : "enum:status"
    "reconciliation_runs" }o--|| implementation_submissions : "submission"
    "reconciliation_runs" }o--|| work_items : "workItem"
    "requirement_verdicts" |o--|| "RequirementVerdictValue" : "enum:verdict"
    "requirement_verdicts" }o--|| reconciliation_runs : "reconciliationRun"
    "reconciliation_findings" |o--|| "ReconciliationFindingSeverity" : "enum:severity"
    "reconciliation_findings" }o--|| reconciliation_runs : "reconciliationRun"
    "reconciliation_jobs" |o--|| "ReconciliationJobStatus" : "enum:status"
    "reconciliation_jobs" |o--|| reconciliation_runs : "reconciliationRun"
    "work_item_dependencies" }o--|| work_items : "predecessor"
    "work_item_dependencies" }o--|| work_items : "successor"
    "work_program_steps" |o--|| "WorkItemRoutingMode" : "enum:routingMode"
    "work_program_steps" }o--|| work_programs : "program"
    "work_program_steps" }o--|o workflow_templates : "workflowTemplate"
    "work_program_runs" }o--|| work_programs : "program"
    "work_program_run_steps" }o--|| work_program_runs : "run"
    "work_program_run_steps" }o--|| work_program_steps : "step"
    "work_program_run_steps" }o--|| work_items : "workItem"
    "work_item_targets" |o--|| "WorkItemTargetStatus" : "enum:status"
    "work_item_targets" }o--|| work_items : "workItem"
    "work_item_targets" }o--|o workflow_instances : "childWorkflowInstance"
    "work_item_targets" }o--|o workflow_templates : "childWorkflowTemplate"
    "work_item_events" |o--|| "WorkItemEventType" : "enum:eventType"
    "work_item_events" }o--|| work_items : "workItem"
    "work_item_events" }o--|o work_item_targets : "target"
    "work_item_clarifications" |o--|| "WorkItemClarificationDirection" : "enum:direction"
    "work_item_clarifications" |o--|| "WorkItemClarificationStatus" : "enum:status"
    "work_item_clarifications" }o--|| work_items : "workItem"
    "work_item_clarifications" }o--|o work_item_targets : "target"
    "metadata_definitions" |o--|| "MetadataDefinitionKind" : "enum:kind"
    "metadata_definitions" |o--|| "MetadataDefinitionStatus" : "enum:status"
    "metadata_definitions" |o--|| "MetadataScopeType" : "enum:scopeType"
    "work_item_routing_policies" |o--|| "WorkItemRoutingMode" : "enum:routingMode"
    "work_item_routing_policies" }o--|o workflow_templates : "workflow"
    "work_item_triggers" |o--|| "WorkItemTriggerType" : "enum:triggerType"
    "work_item_triggers" |o--|| "WorkItemRoutingMode" : "enum:routingMode"
    "tasks" |o--|| "TaskStatus" : "enum:status"
    "tasks" |o--|| "AssignmentMode" : "enum:assignmentMode"
    "tasks" }o--|o workflow_instances : "instance"
    "task_assignments" }o--|| tasks : "task"
    "team_queue_items" }o--|o teams : "team"
    "team_queue_items" }o--|| tasks : "task"
    "task_comments" }o--|| tasks : "task"
    "task_status_history" |o--|o "TaskStatus" : "enum:previousStatus"
    "task_status_history" |o--|| "TaskStatus" : "enum:newStatus"
    "task_status_history" }o--|| tasks : "task"
    "approval_requests" |o--|| "ApprovalStatus" : "enum:status"
    "approval_decisions" |o--|| "ApprovalStatus" : "enum:decision"
    "approval_decisions" }o--|| approval_requests : "request"
    "approval_escalations" }o--|| approval_requests : "request"
    "planner_session_revisions" }o--|| planner_sessions : "session"
    "workflow_checkpoints" }o--|| workflow_instances : "instance"
    "workflow_simulations" }o--|| workflow_templates : "workflow"
    "workflow_replays" }o--|| workflow_instances : "instance"
    "workflow_replays" }o--|o workflow_checkpoints : "checkpoint"
    "consumables" |o--|| "ConsumableStatus" : "enum:status"
    "consumables" }o--|| consumable_types : "type"
    "consumables" }o--|o workflow_instances : "instance"
    "consumable_versions" }o--|| consumables : "consumable"
    "consumable_events" }o--|| consumables : "consumable"
    "agent_skills" }o--|| agents : "agent"
    "agent_skills" }o--|| skills : "skill"
    "agent_runs" |o--|| "AgentRunStatus" : "enum:status"
    "agent_runs" }o--|| agents : "agent"
    "agent_runs" }o--|o workflow_instances : "instance"
    "agent_run_inputs" }o--|| agent_runs : "run"
    "agent_run_outputs" }o--|| agent_runs : "run"
    "agent_reviews" }o--|| agent_runs : "run"
    "laptop_invocations" }o--|| work_items : "workItem"
    "laptop_invocations" |o--|| agent_runs : "agentRun"
    "laptop_questions" }o--|| laptop_invocations : "invocation"
    "blueprint_sessions" |o--|| "BlueprintSourceType" : "enum:sourceType"
    "blueprint_sessions" |o--|| "BlueprintSessionStatus" : "enum:status"
    "blueprint_source_snapshots" }o--|| blueprint_sessions : "session"
    "blueprint_stage_runs" |o--|| "BlueprintStage" : "enum:stage"
    "blueprint_stage_runs" |o--|| "BlueprintStageStatus" : "enum:status"
    "blueprint_stage_runs" }o--|| blueprint_sessions : "session"
    "blueprint_artifacts" |o--|o "BlueprintStage" : "enum:stage"
    "blueprint_artifacts" }o--|| blueprint_sessions : "session"
    "tools" |o--|| "RiskLevel" : "enum:riskLevel"
    "tool_actions" |o--|| "RiskLevel" : "enum:riskLevel"
    "tool_actions" }o--|| tools : "tool"
    "tool_runs" |o--|| "ToolRunStatus" : "enum:status"
    "tool_runs" }o--|| tools : "tool"
    "tool_runs" }o--|o workflow_instances : "instance"
    "tool_run_approvals" }o--|| tool_runs : "run"
    "policy_conditions" }o--|| policies : "policy"
    "policy_actions" }o--|| policies : "policy"
    "documents" }o--|o tasks : "task"
    "documents" }o--|o workflow_nodes : "node"
    "documents" }o--|o workflow_instances : "instance"
    "outbox_events" |o--|| "OutboxStatus" : "enum:status"
    "connectors" |o--|| "ConnectorType" : "enum:type"
    "pending_executions" |o--|| "ExecutionLocation" : "enum:location"
    "pending_executions" }o--|| workflow_instances : "instance"
    "pending_executions" }o--|| workflow_nodes : "node"
    "event_deliveries" }o--|| event_outbox : "outbox"
    "event_deliveries" }o--|| event_subscriptions : "subscription"
    "workbench_stages" }o--|| workbench_definitions : "definition"
    "workbench_expected_artifacts" }o--|| workbench_stages : "stage"
    "workbench_stage_edges" }o--|| workbench_stages : "fromStage"
    "workbench_stage_edges" }o--|| workbench_stages : "toStage"
    "workbench_artifact_consumes" }o--|| workbench_stages : "consumerStage"
    "workbench_artifact_consumes" }o--|| workbench_expected_artifacts : "producerArtifact"
    "workbench_stage_questions" }o--|| workbench_stages : "stage"
    "loop_strategy_versions" }o--|| loop_strategies : "strategy"
    "codegen_spec_lifecycle_events" }o--|| codegen_specs : "spec"
    "codegen_runs" }o--|| codegen_specs : "spec"
    "codegen_runs" }o--|o codegen_change_plans : "changePlan"
    "codegen_change_plans" }o--|| codegen_repo_models : "repoModel"
    "codegen_artifacts" }o--|| codegen_runs : "run"
    "codegen_gaps" }o--|| codegen_runs : "run"
    "codegen_llm_patch_tasks" }o--|| codegen_runs : "run"
    "codegen_verifications" }o--|| codegen_runs : "run"
    "codegen_receipts" |o--|| codegen_runs : "run"
    "discovery_sessions" |o--|| "DiscoveryScopeType" : "enum:scopeType"
    "discovery_sessions" |o--|| "DiscoverySessionStatus" : "enum:status"
    "discovery_questions" |o--|| "DiscoveryQuestionKind" : "enum:kind"
    "discovery_questions" |o--|| "DiscoveryQuestionSource" : "enum:source"
    "discovery_questions" |o--|| "DiscoveryQuestionStatus" : "enum:status"
    "discovery_questions" }o--|| discovery_sessions : "session"
    "discovery_assumptions" |o--|| "DiscoveryAssumptionStatus" : "enum:status"
    "discovery_assumptions" }o--|| discovery_sessions : "session"
```
