import { env } from "../config/env";
import { logger } from "../config/logger";

export interface DiscoveredTool {
  tool_name: string;
  version: string;
  description: string;
  input_schema: Record<string, unknown>;
  risk_level: string;
  requires_approval?: boolean;
  requiresApproval?: boolean;
  execution_location: string;
  runtime_type: string;
}

export interface DiscoverInput {
  capability_id: string;
  agent_uid: string;
  agent_id?: string;
  task_type?: string;
  query?: string;
  risk_max?: "low" | "medium" | "high" | "critical";
  limit?: number;
}

export const toolServiceClient = {
  async discover(input: DiscoverInput): Promise<DiscoveredTool[]> {
    try {
      const res = await fetch(`${env.TOOL_SERVICE_URL}/api/v1/tools/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, "tool-service /tools/discover non-200");
        return [];
      }
      const json = await res.json() as { tools?: DiscoveredTool[] };
      return json.tools ?? [];
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "tool-service /tools/discover failed; continuing without dynamic tools");
      return [];
    }
  },
};
