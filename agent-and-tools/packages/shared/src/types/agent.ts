export type AgentType =
  | "llm_agent"
  | "workflow_agent"
  | "tool_agent"
  | "approval_agent"
  | "planner_agent"
  | "architect_agent"
  | "developer_agent"
  | "qa_agent"
  | "governance_agent"
  | "summarizer_agent";

export type AgentStatus = "draft" | "pending_approval" | "active" | "suspended" | "archived";

export type AgentVersionStatus = "draft" | "pending_approval" | "active" | "superseded";

export type LearningCandidateStatus = "pending" | "accepted" | "rejected" | "merged" | "superseded";

export type LearningCandidateSource =
  | "session_summary"
  | "tool_result"
  | "human_feedback"
  | "workflow_result"
  | "code_review"
  | "incident_analysis"
  | "approval_decision"
  | "quality_evaluation";

export interface Agent {
  id: string;
  capability_id: string;
  agent_id: string;
  agent_key: string;
  agent_uid: string;
  name: string;
  description?: string;
  agent_type: AgentType;
  status: AgentStatus;
  owner_user_id?: string;
  owner_team_id?: string;
  metadata: Record<string, unknown>;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface AgentVersion {
  id: string;
  agent_uid: string;
  version: number;
  status: AgentVersionStatus;
  system_prompt: string;
  behavior_policy: Record<string, unknown>;
  model_policy: ModelPolicy;
  context_policy: ContextPolicy;
  tool_policy: ToolPolicy;
  approval_policy: Record<string, unknown>;
  change_reason?: string;
  created_by?: string;
  approved_by?: string;
  approved_at?: string;
  created_at: string;
}

export interface ModelPolicy {
  default_provider?: string;
  default_model?: string;
  temperature?: number;
  max_output_tokens?: number;
  allowed_execution_modes?: string[];
  fallbacks?: Array<{ provider: string; model: string }>;
}

export interface ContextPolicy {
  default_mode?: string;
  max_context_tokens?: number;
  compare_with_raw?: boolean;
  include_learning_profile?: boolean;
  include_session_summary?: boolean;
}

export interface ToolPolicy {
  allowed_tools?: string[];
  max_tool_steps?: number;
  auto_execute_low_risk?: boolean;
  require_approval_for_risk?: string[];
}

export interface LearningProfile {
  id: string;
  agent_uid: string;
  profile_type: string;
  version: number;
  status: string;
  summary: Record<string, unknown>;
  summary_text?: string;
  source_session_ids: string[];
  source_memory_item_ids: string[];
  source_receipt_ids: string[];
  change_reason?: string;
  created_by?: string;
  created_at: string;
}

export interface LearningCandidate {
  id: string;
  agent_uid: string;
  capability_id: string;
  agent_id: string;
  source_type: LearningCandidateSource;
  source_id?: string;
  session_id?: string;
  workflow_id?: string;
  task_id?: string;
  candidate_type: string;
  content: string;
  content_json?: Record<string, unknown>;
  confidence: number;
  importance: number;
  status: LearningCandidateStatus;
  reviewed_by?: string;
  reviewed_at?: string;
  created_at: string;
}

export interface AgentRuntimeProfile {
  capability_id: string;
  agent_id: string;
  agent_key: string;
  agent_uid: string;
  active_agent_version: number;
  system_prompt: string;
  behavior_policy: Record<string, unknown>;
  model_policy: ModelPolicy;
  context_policy: ContextPolicy;
  tool_policy: ToolPolicy;
  learning_profile?: {
    profile_type: string;
    version: number;
    summary_text?: string;
  };
  runtime_profile_hash: string;
}

export interface CreateAgentRequest {
  capability_id: string;
  agent_id: string;
  name: string;
  description?: string;
  agent_type?: AgentType;
  owner_user_id?: string;
  owner_team_id?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateAgentVersionRequest {
  system_prompt: string;
  behavior_policy?: Record<string, unknown>;
  model_policy?: ModelPolicy;
  context_policy?: ContextPolicy;
  tool_policy?: ToolPolicy;
  approval_policy?: Record<string, unknown>;
  change_reason?: string;
}

export interface SubmitLearningCandidatesRequest {
  capability_id: string;
  agent_id: string;
  agent_uid: string;
  source_type: LearningCandidateSource;
  source_id?: string;
  session_id?: string;
  candidates: Array<{
    candidate_type: string;
    content: string;
    confidence?: number;
    importance?: number;
  }>;
}

export interface ReviewLearningCandidateRequest {
  decision: "accepted" | "rejected";
  review_note?: string;
}
