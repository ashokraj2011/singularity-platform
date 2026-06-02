import { config } from "../config";

export interface RunnerExecuteRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  profile?: string;
  // Per-request overrides honored by the runner (docker-exec.ts). Used by the
  // run_python tool. `network` opts into outbound network ('bridge') for a
  // single run; omitted → runner's global MCP_RUNNER_NETWORK_MODE default.
  network?: "none" | "bridge";
  env?: Record<string, string>;
}

export async function callSandboxRunner(req: RunnerExecuteRequest): Promise<Record<string, unknown>> {
  const token = config.MCP_RUNNER_TOKEN?.trim();
  if (!token) {
    throw new Error("MCP_RUNNER_UNAVAILABLE: MCP_RUNNER_TOKEN is required when MCP_COMMAND_EXECUTION_MODE=container");
  }
  const url = `${config.MCP_RUNNER_URL.replace(/\/+$/, "")}/v1/execute`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(req.timeoutMs + 5_000),
    });
  } catch (err) {
    throw new Error(`MCP_RUNNER_UNAVAILABLE: ${(err as Error).message}`);
  }
  const raw = await response.text();
  let body: { success?: boolean; data?: unknown; error?: unknown } = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`MCP_RUNNER_UNAVAILABLE: runner returned non-JSON response (${response.status})`);
  }
  if (!response.ok || body.success === false) {
    throw new Error(`MCP_RUNNER_UNAVAILABLE: ${String(body.error ?? `runner returned ${response.status}`)}`);
  }
  if (!body.data || typeof body.data !== "object") {
    throw new Error("MCP_RUNNER_UNAVAILABLE: runner response missing data receipt");
  }
  return body.data as Record<string, unknown>;
}
export async function sandboxRunnerStatus(): Promise<Record<string, unknown>> {
  const url = `${config.MCP_RUNNER_URL.replace(/\/+$/, "")}/health`;
  const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`runner health returned ${response.status}`);
  const body = await response.json() as { success?: boolean; data?: unknown };
  if (body.success === false || !body.data || typeof body.data !== "object") {
    throw new Error("runner health returned invalid payload");
  }
  return body.data as Record<string, unknown>;
}
