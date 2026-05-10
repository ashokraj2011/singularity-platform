export type ToolStatus = "draft" | "pending_approval" | "active" | "suspended" | "archived";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type ExecutionLocation = "server" | "edge" | "browser" | "client_local_runner";

export type RuntimeType = "http" | "wasm" | "local_command" | "mcp" | "queue" | "docker" | "python" | "node";

export type ToolExecutionStatus =
  | "success"
  | "error"
  | "blocked"
  | "waiting_approval"
  | "client_execution_required"
  | "browser_execution_required"
  | "edge_execution_pending";

export interface ToolRuntime {
  execution_location: ExecutionLocation;
  runtime_type: RuntimeType;
  endpoint_url?: string;
  method?: string;
  command?: string;
  artifact_url?: string;
  artifact_sha256?: string;
  region?: string;
}

export interface Tool {
  id: string;
  tool_name: string;
  version: string;
  display_name: string;
  description: string;
  status: ToolStatus;
  risk_level: RiskLevel;
  requires_approval: boolean;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  runtime: ToolRuntime;
  capabilities_required: Record<string, unknown>;
  allowed_capabilities: string[];
  allowed_agents: string[];
  tags: string[];
  metadata: Record<string, unknown>;
  created_by?: string;
  approved_by?: string;
  approved_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ToolExecution {
  id: string;
  tool_name: string;
  tool_version?: string;
  capability_id: string;
  agent_uid?: string;
  agent_id?: string;
  session_id?: string;
  workflow_id?: string;
  task_id?: string;
  execution_location?: string;
  runtime_type?: string;
  status: string;
  arguments_json: Record<string, unknown>;
  output_json?: Record<string, unknown>;
  output_summary?: string;
  risk_level?: string;
  requires_approval?: boolean;
  approved_by?: string;
  error?: string;
  started_at: string;
  completed_at?: string;
  metadata: Record<string, unknown>;
}

export interface ClientRunner {
  id: string;
  user_id?: string;
  runner_name?: string;
  runner_type?: string;
  runner_version?: string;
  capabilities: {
    providers?: string[];
    tools?: string[];
    workspace_access?: boolean;
    filesystem_access?: boolean;
    shell_access?: boolean;
  };
  status: string;
  last_seen_at?: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ClientExecutionJob {
  id: string;
  tool_execution_id?: string;
  assigned_runner_id?: string;
  status: string;
  job_payload: Record<string, unknown>;
  result_payload?: Record<string, unknown>;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  error?: string;
}

export interface RegisterToolRequest {
  tool_name: string;
  version?: string;
  display_name: string;
  description: string;
  risk_level?: RiskLevel;
  requires_approval?: boolean;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  runtime: ToolRuntime;
  capabilities_required?: Record<string, unknown>;
  allowed_capabilities?: string[];
  allowed_agents?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface DiscoverToolsRequest {
  capability_id: string;
  agent_uid: string;
  agent_id: string;
  task_type?: string;
  query?: string;
  risk_max?: RiskLevel;
  limit?: number;
}

export interface ToolCard {
  tool_name: string;
  version: string;
  description: string;
  input_schema: Record<string, unknown>;
  risk_level: RiskLevel;
  execution_location: ExecutionLocation;
  runtime_type: RuntimeType;
}

export interface InvokeToolRequest {
  capability_id: string;
  agent_uid: string;
  agent_id: string;
  session_id?: string;
  workflow_id?: string;
  task_id?: string;
  tool_name: string;
  tool_version?: string;
  arguments: Record<string, unknown>;
  context_package_id?: string;
  approval_id?: string;
}

export interface RegisterRunnerRequest {
  runner_id: string;
  runner_name?: string;
  runner_type?: string;
  runner_version?: string;
  user_id?: string;
  capabilities: ClientRunner["capabilities"];
}

export interface CompleteJobRequest {
  status: "success" | "error";
  output_summary?: string;
  output?: Record<string, unknown>;
  receipt?: {
    runner_id: string;
    workspace_hash?: string;
    started_at: string;
    completed_at: string;
  };
}

export interface FailJobRequest {
  error: string;
}
