import { env } from "../config/env";
import { AppError } from "../shared/errors";

export interface ChatRespondRequest {
  session_id: string;
  agent_id?: string;
  message: string;
  provider?: string;
  model?: string;
  temperature?: number;
  max_output_tokens?: number;
  system_prompt?: string;
  context_policy?: {
    optimization_mode?: string;
    compare_with_raw?: boolean;
    max_context_tokens?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface ChatRespondResponse {
  response: string;
  session_id: string;
  agent_id: string;
  context_package_id: string;
  model_call_id: string;
  optimization: {
    mode: string;
    raw_input_tokens: number;
    optimized_input_tokens: number;
    tokens_saved: number;
    percent_saved: number;
    estimated_raw_cost: number;
    estimated_optimized_cost: number;
    estimated_cost_saved: number;
  };
  model_usage: {
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    estimated_cost: number;
    latency_ms: number;
  };
  metrics_run_id: string | null;
}

export const contextFabricClient = {
  async chatRespond(input: ChatRespondRequest): Promise<ChatRespondResponse> {
    const url = `${env.CONTEXT_FABRIC_URL}/chat/respond`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      // context-fabric /chat/respond chains downstream calls; allow up to ~4min
      signal: AbortSignal.timeout(240_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AppError(
        `context-fabric /chat/respond returned ${res.status}: ${text.slice(0, 500)}`,
        502,
        "CONTEXT_FABRIC_ERROR",
      );
    }
    return await res.json() as ChatRespondResponse;
  },
};
