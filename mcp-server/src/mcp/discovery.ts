import { Router } from "express";
import { listLocalTools } from "../tools/registry";
import { modelCatalogResponse } from "../llm/model-catalog";
import { configuredDefaultModel, configuredDefaultProvider } from "../llm/provider-config";
import { workspaceStorageStats } from "../workspace/sandbox";
import { commandExecutionStatus } from "../tools/command-execution-status";

export const discoveryRouter = Router();

const RUN_CONTEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string" },
    capabilityId: { type: "string" },
    tenantId: { type: "string" },
    agentId: { type: "string" },
    runId: { type: "string" },
    runStepId: { type: "string" },
    workItemId: { type: "string" },
    workItemCode: { type: "string" },
    traceId: { type: "string" },
    workflowInstanceId: { type: "string" },
    nodeId: { type: "string" },
    branchBase: { type: "string" },
    branchName: { type: "string" },
    workspaceRoot: { type: "string" },
    sourceType: { type: "string" },
    sourceUri: { type: "string" },
    sourceRef: { type: "string" },
    dependencyState: {
      type: "object",
      properties: {
        changed_paths: { type: "array", items: { type: "string" } },
      },
    },
  },
};

const TOOL_DESCRIPTOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "input_schema", "execution_target", "risk_level", "requires_approval"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    natural_language: { type: "string" },
    input_schema: { type: "object", description: "JSON Schema for tool arguments." },
    output_schema: { type: ["object", "null"], description: "JSON Schema for tool output when known." },
    risk_level: { enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
    requires_approval: { type: "boolean" },
    execution_target: { enum: ["LOCAL", "SERVER"] },
    tags: { type: "array", items: { type: "string" } },
  },
};

const ENDPOINT_DESCRIPTOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "method", "path", "auth", "category", "description"],
  properties: {
    id: { type: "string" },
    method: { enum: ["GET", "POST", "WS"] },
    path: { type: "string" },
    auth: { enum: ["none", "bearer"] },
    category: { type: "string" },
    description: { type: "string" },
    request_schema: { type: ["object", "null"] },
    response_schema: { type: ["object", "null"] },
    query: { type: "object" },
    path_params: { type: "object" },
  },
};

const INVOKE_REQUEST_SCHEMA = {
  type: "object",
  required: ["message"],
  additionalProperties: false,
  properties: {
    systemPrompt: { type: "string" },
    history: {
      type: "array",
      items: {
        type: "object",
        required: ["role", "content"],
        properties: {
          role: { enum: ["system", "user", "assistant", "tool"] },
          content: { type: "string" },
          tool_call_id: { type: "string" },
          tool_name: { type: "string" },
        },
      },
    },
    message: { type: "string" },
    tools: { type: "array", items: TOOL_DESCRIPTOR_SCHEMA },
    modelConfig: {
      type: "object",
      additionalProperties: false,
      properties: {
        modelAlias: { type: "string" },
        applierModelAlias: { type: "string", description: "Optional small/fast model alias for surgical diff generation." },
        temperature: { type: "number" },
        maxTokens: { type: "integer" },
        promptCache: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            strategy: { type: "string" },
            key: { type: "string" },
          },
        },
      },
    },
    runContext: RUN_CONTEXT_SCHEMA,
    limits: {
      type: "object",
      additionalProperties: true,
      properties: {
        maxSteps: { type: "integer" },
        timeoutSec: { type: "integer" },
        maxToolResultChars: { type: "integer" },
        maxHistoryMessages: { type: "integer" },
        maxHistoryTokens: { type: "integer" },
        compressToolResults: { type: "boolean" },
        includeLocalTools: { type: "boolean" },
      },
    },
    governanceMode: {
      enum: ["fail_open", "fail_closed", "degraded", "human_approval_required"],
    },
    contextPlanHash: { type: "string" },
    degradedActionsAllowed: { type: "array", items: { type: "string" } },
    allowAutonomousMutation: { type: "boolean" },
  },
};

const EMBED_REQUEST_SCHEMA = {
  type: "object",
  required: ["input"],
  additionalProperties: false,
  properties: {
    modelAlias: { type: "string" },
    input: { type: "array", minItems: 1, items: { type: "string" } },
    runContext: RUN_CONTEXT_SCHEMA,
  },
};

function endpointDescriptors() {
  return [
    {
      id: "health",
      method: "GET",
      path: "/health",
      auth: "none",
      category: "health",
      description: "Basic liveness and default model/provider summary.",
    },
    {
      id: "health.strict",
      method: "GET",
      path: "/healthz/strict",
      auth: "none",
      category: "health",
      description: "Strict readiness checks for gateway, provider config, sandbox, and invariants.",
    },
    {
      id: "discovery",
      method: "GET",
      path: "/mcp/discovery",
      auth: "bearer",
      category: "discovery",
      description: "Standard JSON discovery document for MCP endpoints, tools, schemas, events, and resources.",
    },
    {
      id: "llm.providers",
      method: "GET",
      path: "/llm/providers",
      auth: "bearer",
      category: "models",
      description: "Provider posture and readiness without returning key material.",
    },
    {
      id: "llm.models",
      method: "GET",
      path: "/llm/models",
      auth: "bearer",
      category: "models",
      description: "Model alias catalog and readiness.",
    },
    {
      id: "mcp.invoke",
      method: "POST",
      path: "/mcp/invoke",
      auth: "bearer",
      category: "execution",
      description: "Run the LLM/tool agent loop.",
      request_schema: INVOKE_REQUEST_SCHEMA,
    },
    {
      id: "mcp.resume",
      method: "POST",
      path: "/mcp/resume",
      auth: "bearer",
      category: "execution",
      description: "Resume a paused approval flow.",
      request_schema: {
        type: "object",
        required: ["continuation_token", "decision"],
        properties: {
          continuation_token: { type: "string" },
          decision: { enum: ["approved", "rejected"] },
          reason: { type: "string" },
          args_override: { type: "object" },
        },
      },
    },
    {
      id: "mcp.embed",
      method: "POST",
      path: "/mcp/embed",
      auth: "bearer",
      category: "execution",
      description: "Generate embeddings through the MCP/gateway boundary.",
      request_schema: EMBED_REQUEST_SCHEMA,
    },
    {
      id: "mcp.tools.list",
      method: "GET",
      path: "/mcp/tools/list",
      auth: "bearer",
      category: "tools",
      description: "List local tools hosted by this MCP server.",
    },
    {
      id: "mcp.tools.call",
      method: "POST",
      path: "/mcp/tools/call",
      auth: "bearer",
      category: "tools",
      description: "Single-shot local tool call. Disabled in production-class environments unless explicitly enabled.",
      request_schema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          arguments: { type: "object" },
          runContext: RUN_CONTEXT_SCHEMA,
        },
      },
    },
    {
      id: "mcp.work.finish_branch",
      method: "POST",
      path: "/mcp/work/finish-branch",
      auth: "bearer",
      category: "work",
      description: "Commit and optionally push the prepared work branch.",
    },
    {
      id: "mcp.workspaces.stats",
      method: "GET",
      path: "/mcp/workspaces/stats",
      auth: "bearer",
      category: "workspaces",
      description: "Managed workspace/cache disk usage, quota posture, and workspace GC settings for Operations.",
    },
    {
      id: "mcp.events",
      method: "GET",
      path: "/mcp/events",
      auth: "bearer",
      category: "events",
      description: "Poll recent MCP events.",
      query: {
        trace_id: { type: "string" },
        run_id: { type: "string" },
        capability_id: { type: "string" },
        agent_id: { type: "string" },
        kinds: { type: "string", description: "Comma-separated event kinds." },
        limit: { type: "integer", default: 200 },
      },
    },
    {
      id: "mcp.events.replay",
      method: "GET",
      path: "/mcp/events/replay",
      auth: "bearer",
      category: "events",
      description: "Replay events since an event id or timestamp.",
    },
    {
      id: "mcp.ws",
      method: "WS",
      path: "/mcp/ws",
      auth: "bearer",
      category: "events",
      description: "Live event subscription WebSocket.",
    },
    {
      id: "mcp.resources.by_trace",
      method: "GET",
      path: "/mcp/resources/by-trace/{traceId}",
      auth: "bearer",
      category: "resources",
      description: "Cross-kind timeline for a trace.",
      path_params: { traceId: { type: "string" } },
    },
    ...["llm-calls", "tool-invocations", "artifacts", "code-changes"].flatMap((kind) => [
      {
        id: `mcp.resources.${kind}.list`,
        method: "GET",
        path: `/mcp/resources/${kind}`,
        auth: "bearer",
        category: "resources",
        description: `List ${kind} records. Supports trace_id and limit query parameters.`,
        query: { trace_id: { type: "string" }, limit: { type: "integer", default: 50 } },
      },
      {
        id: `mcp.resources.${kind}.get`,
        method: "GET",
        path: `/mcp/resources/${kind}/{id}`,
        auth: "bearer",
        category: "resources",
        description: `Fetch one ${kind} record by id.`,
        path_params: { id: { type: "string" } },
      },
    ]),
  ];
}

function inferToolTags(tool: ReturnType<typeof listLocalTools>[number]): string[] {
  const tags = new Set<string>();
  const text = `${tool.name} ${tool.description} ${tool.natural_language}`.toLowerCase();
  if (text.includes("file") || text.includes("patch") || text.includes("git")) tags.add("code");
  if (text.includes("write") || text.includes("patch") || text.includes("commit") || text.includes("push")) tags.add("mutating");
  if (tool.requires_approval) tags.add("approval");
  if (tool.risk_level === "LOW") tags.add("read_safe");
  return Array.from(tags).sort();
}

discoveryRouter.get("/discovery", async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const tools = listLocalTools().map((tool) => ({
    ...tool,
    execution_target: "LOCAL",
    tags: inferToolTags(tool),
  }));
  const modelCatalog = modelCatalogResponse();
  const commandExecution = await commandExecutionStatus();

  res.json({
    success: true,
    data: {
      kind: "singularity.mcp.discovery",
      schema: "https://singularity.local/schemas/mcp-discovery/v1",
      schemaVersion: "1.0.0",
      generatedAt: new Date().toISOString(),
      server: {
        id: "singularity-mcp-server",
        name: "Singularity MCP Server",
        version: "0.1.0",
        protocol: "singularity.mcp.http",
        baseUrl,
        basePath: "/mcp",
        defaultProvider: configuredDefaultProvider(),
        defaultModel: configuredDefaultModel(),
        auth: {
          type: "bearer",
          header: "Authorization",
          scheme: "Bearer",
          publicEndpoints: ["/health", "/healthz/strict"],
        },
      },
      capabilities: {
        agentLoop: true,
        embeddings: true,
        localToolListing: true,
        directToolCall: true,
        approvalResume: true,
        resourceInspection: true,
        eventPolling: true,
        eventWebSocket: true,
        workBranchFinish: true,
        workspaceStorageStats: true,
        serverToolDelegation: true,
        delegationReceipts: true,
        serviceTokenDelegation: true,
        isolatedCommandExecution: commandExecution.mode === "container",
        autoVerification: true,
        conflictSafeEdits: true,
        applierModelSupport: true,
        gitCheckpoints: true,
      },
      endpoints: endpointDescriptors(),
      tools,
      resources: {
        kinds: ["llm-calls", "tool-invocations", "artifacts", "code-changes"],
        byTracePath: "/mcp/resources/by-trace/{traceId}",
        workspaceStatsPath: "/mcp/workspaces/stats",
      },
      delegation: {
        serverTools: {
          executionTarget: "SERVER",
          adapterPath: "/internal/mcp/tools/{toolName}/call",
          auth: "short_lived_service_token",
          receiptKind: "delegation_receipt",
        },
        receiptChain: ["mcp-server", "context-fabric", "tool-service", "connector/service"],
      },
      events: {
        pollPath: "/mcp/events",
        replayPath: "/mcp/events/replay",
        websocketPath: "/mcp/ws",
        websocketMessageTypes: [
          "ping",
          "subscribe.events",
          "unsubscribe.events",
          "replay.events",
        ],
      },
      models: {
        providersPath: "/llm/providers",
        modelsPath: "/llm/models",
        defaultModelAlias: modelCatalog.defaultModelAlias,
        catalogSource: modelCatalog.source,
        warnings: modelCatalog.warnings,
      },
      commandExecution,
      schemas: {
        runContext: RUN_CONTEXT_SCHEMA,
        toolDescriptor: TOOL_DESCRIPTOR_SCHEMA,
        endpointDescriptor: ENDPOINT_DESCRIPTOR_SCHEMA,
        invokeRequest: INVOKE_REQUEST_SCHEMA,
        embedRequest: EMBED_REQUEST_SCHEMA,
      },
    },
    requestId: res.locals.requestId,
  });
});

discoveryRouter.get("/workspaces/stats", async (_req, res) => {
  res.json({
    success: true,
    data: await workspaceStorageStats(),
    requestId: res.locals.requestId,
  });
});
