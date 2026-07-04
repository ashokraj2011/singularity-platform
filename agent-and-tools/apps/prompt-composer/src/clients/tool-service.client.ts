import { env } from "../config/env";
import { logger } from "../config/logger";
import { readUpstreamJsonObject } from "../shared/upstream-json";

const TOOL_SERVICE_DISCOVERY_TIMEOUT_MS = env.TOOL_SERVICE_DISCOVERY_TIMEOUT_SEC * 1000;

export interface DiscoveredTool {
  tool_name: string;
  version: string;
  description: string;
  input_schema: Record<string, unknown>;
  risk_level: string;
  requires_approval?: boolean;
  requiresApproval?: boolean;
  execution_target?: "LOCAL" | "SERVER" | string;
  execution_location: string;
  runtime_type: string;
  capability_id?: string;
  capability_permissions?: string[];
  read_only?: boolean;
  provider_locked?: boolean;
  provider_id?: string;
  provider_manifest_version?: string;
  provider_manifest_digest?: string;
  provider_manifest_signature_key_id?: string;
  provider_manifest_signed?: boolean;
  source?: string;
  source_type?: string;
  source_ref?: string;
}

export interface DiscoverInput {
  capability_id: string;
  agent_uid: string;
  agent_id?: string;
  task_type?: string;
  query?: string;
  risk_max?: "low" | "medium" | "high" | "critical";
  limit?: number;
  effective_capabilities?: Array<Record<string, unknown>>;
  effectiveCapabilities?: Array<Record<string, unknown>>;
}

export const toolServiceClient = {
  async discover(input: DiscoverInput): Promise<DiscoveredTool[]> {
    try {
      const res = await fetch(`${env.TOOL_SERVICE_URL}/api/v1/tools/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(TOOL_SERVICE_DISCOVERY_TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, "tool-service /tools/discover non-200");
        return [];
      }
      const json = await readUpstreamJsonObject(res, "tool-service /tools/discover") as { tools?: DiscoveredTool[] };
      return json.tools ?? [];
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "tool-service /tools/discover failed; continuing without dynamic tools");
      return [];
    }
  },
};
