```mermaid
erDiagram

        NodeType {
            START START
END END
HUMAN_TASK HUMAN_TASK
AGENT_TASK AGENT_TASK
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
        }
    


        EdgeType {
            SEQUENTIAL SEQUENTIAL
CONDITIONAL CONDITIONAL
PARALLEL_SPLIT PARALLEL_SPLIT
PARALLEL_JOIN PARALLEL_JOIN
ERROR_BOUNDARY ERROR_BOUNDARY
        }
    


        WorkItemStatus {
            QUEUED QUEUED
IN_PROGRESS IN_PROGRESS
AWAITING_PARENT_APPROVAL AWAITING_PARENT_APPROVAL
COMPLETED COMPLETED
CANCELLED CANCELLED
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
CLAIMED CLAIMED
STARTED STARTED
SUBMITTED SUBMITTED
APPROVAL_REQUESTED APPROVAL_REQUESTED
APPROVED APPROVED
REWORK_REQUESTED REWORK_REQUESTED
CLARIFICATION_REQUESTED CLARIFICATION_REQUESTED
CLARIFICATION_ANSWERED CLARIFICATION_ANSWERED
CANCELLED CANCELLED
        }
    


        WorkItemOriginType {
            PARENT_DELEGATED PARENT_DELEGATED
CAPABILITY_LOCAL CAPABILITY_LOCAL
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
    DateTime syncedAt 
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
    String capabilityId "❓"
    DateTime archivedAt "❓"
    Json metadata "❓"
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
    DateTime createdAt 
    DateTime updatedAt 
    }
  

  "workflow_permissions" {
    String id "🗝️"
    String roleId 
    WorkflowPermissionAction action 
    DateTime grantedAt 
    }
  

  "workflow_triggers" {
    String id "🗝️"
    TriggerType type 
    Boolean isActive 
    Json config 
    DateTime lastFiredAt "❓"
    DateTime createdAt 
    DateTime updatedAt 
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
    String name 
    InstanceStatus status 
    Json context 
    String parentNodeId "❓"
    DateTime startedAt "❓"
    DateTime completedAt "❓"
    DateTime archivedAt "❓"
    String createdById "❓"
    DateTime createdAt 
    DateTime updatedAt 
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
  

  "work_items" {
    String id "🗝️"
    String workCode 
    WorkItemOriginType originType 
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
    }
  

  "work_item_targets" {
    String id "🗝️"
    String targetCapabilityId 
    String childWorkflowTemplateId "❓"
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
    }
  

  "work_item_events" {
    String id "🗝️"
    WorkItemEventType eventType 
    String actorId "❓"
    Json payload "❓"
    DateTime createdAt 
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
    }
  

  "tasks" {
    String id "🗝️"
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
    String nodeId "❓"
    AgentRunStatus status 
    String initiatedById "❓"
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
    "run_snapshots" }o--|| workflow_templates : "workflow"
    "workflow_permissions" |o--|| "WorkflowPermissionAction" : "enum:action"
    "workflow_permissions" }o--|| workflow_templates : "template"
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
    "work_items" |o--|| "WorkItemStatus" : "enum:status"
    "work_items" |o--|| "WorkItemUrgency" : "enum:urgency"
    "work_items" }o--|o workflow_instances : "sourceWorkflowInstance"
    "work_items" }o--|o workflow_nodes : "sourceWorkflowNode"
    "work_item_targets" |o--|| "WorkItemTargetStatus" : "enum:status"
    "work_item_targets" }o--|| work_items : "workItem"
    "work_item_targets" }o--|o workflow_instances : "childWorkflowInstance"
    "work_item_events" |o--|| "WorkItemEventType" : "enum:eventType"
    "work_item_events" }o--|| work_items : "workItem"
    "work_item_events" }o--|o work_item_targets : "target"
    "work_item_clarifications" |o--|| "WorkItemClarificationDirection" : "enum:direction"
    "work_item_clarifications" |o--|| "WorkItemClarificationStatus" : "enum:status"
    "work_item_clarifications" }o--|| work_items : "workItem"
    "work_item_clarifications" }o--|o work_item_targets : "target"
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
```
