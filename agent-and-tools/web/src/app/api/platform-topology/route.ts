import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedCallerBearer } from "../_proxy";

export const dynamic = "force-dynamic";

type TopologyStatus = "live" | "degraded" | "offline" | "unconfigured" | "unknown";
type NodeKind = "client" | "web" | "ui" | "api" | "runtime" | "governance" | "data";
type NodeGroup = "entry" | "web" | "domain" | "core" | "agent" | "workflow" | "runtime" | "governance" | "storage";

type ProbeConfig = {
  id: string;
  label: string;
  description: string;
  kind: NodeKind;
  group: NodeGroup;
  envKey?: string;
  url: string | null;
  healthPath?: string;
  route?: string;
  required: boolean;
  remoteCapable: boolean;
  authToken?: string | null;
  position: { x: number; y: number };
};

type TopologyNode = Omit<ProbeConfig, "authToken" | "healthPath"> & {
  status: TopologyStatus;
  ok: boolean | null;
  httpStatus: number | null;
  message: string;
  checkedAt: string;
};

type TopologyEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
  protocol: string;
  required: boolean;
  status: TopologyStatus;
  message: string;
};

const HEALTH_TIMEOUT_MS = 2500;

function cleanUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

function flagEnabled(value: string | null | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function authHeader(token: string | null | undefined): HeadersInit {
  const trimmed = token?.trim();
  if (!trimmed) return {};
  return { Authorization: trimmed.startsWith("Bearer ") ? trimmed : `Bearer ${trimmed}` };
}

function endpoint(baseUrl: string, path = "/health"): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function iamApiBase(): string {
  const raw = process.env.IAM_BASE_URL ?? process.env.IAM_SERVICE_URL ?? "http://iam-service:8100/api/v1";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
}

function staticNode(config: ProbeConfig, status: TopologyStatus, message: string, ok: boolean | null): TopologyNode {
  const { authToken: _authToken, healthPath: _healthPath, ...publicConfig } = config;
  return {
    ...publicConfig,
    status,
    ok,
    httpStatus: null,
    message,
    checkedAt: new Date().toISOString(),
  };
}

async function probe(config: ProbeConfig): Promise<TopologyNode> {
  const { authToken, healthPath, ...publicConfig } = config;
  const checkedAt = new Date().toISOString();

  if (!config.url) {
    return {
      ...publicConfig,
      status: config.required ? "offline" : "unconfigured",
      ok: config.required ? false : null,
      httpStatus: null,
      message: config.required
        ? `${config.envKey ?? config.id} is not configured.`
        : "Optional dial-in service. Configure a local or remote URL to enable it.",
      checkedAt,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint(config.url, healthPath ?? "/health"), {
      cache: "no-store",
      headers: authHeader(authToken),
      signal: controller.signal,
    });
    const text = await res.text();
    return {
      ...publicConfig,
      status: res.ok ? "live" : "degraded",
      ok: res.ok,
      httpStatus: res.status,
      message: text.slice(0, 260) || res.statusText || (res.ok ? "Healthy" : "Unhealthy"),
      checkedAt,
    };
  } catch (err) {
    return {
      ...publicConfig,
      status: "offline",
      ok: false,
      httpStatus: null,
      message: err instanceof Error ? err.message : "Health check failed",
      checkedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function edgeStatus(edge: Omit<TopologyEdge, "status" | "message">, nodes: Map<string, TopologyNode>): Pick<TopologyEdge, "status" | "message"> {
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  if (!source || !target) return { status: "unknown", message: "Endpoint metadata missing." };
  if (target.status === "unconfigured" && !edge.required) return { status: "unconfigured", message: "Optional connection is not configured." };
  if (source.ok === true && target.ok === true) return { status: "live", message: "Source and target are live." };
  if (source.ok === false || target.ok === false) return { status: edge.required ? "offline" : "degraded", message: `${source.label}: ${source.status}; ${target.label}: ${target.status}` };
  return { status: "unknown", message: `${source.label}: ${source.status}; ${target.label}: ${target.status}` };
}

export async function GET(request: NextRequest) {
  const authFailure = await requireVerifiedCallerBearer(request, "Platform topology");
  if (authFailure) return authFailure;

  const platformUrl = cleanUrl(process.env.PLATFORM_WEB_PUBLIC_URL ?? "http://localhost:5180");
  const mcpHttpDebugEnabled =
    flagEnabled(process.env.RUNTIME_HTTP_FALLBACK_ENABLED) ||
    flagEnabled(process.env.MCP_HTTP_DEBUG_PROBE_ENABLED);
  const staticNodes: TopologyNode[] = [
    staticNode({
      id: "browser",
      label: "Browser",
      description: "Operator session using the unified platform shell.",
      kind: "client",
      group: "entry",
      route: "/",
      url: platformUrl,
      required: true,
      remoteCapable: false,
      position: { x: 50, y: 6 },
    }, "live", "Current browser session is requesting this topology view.", true),
    staticNode({
      id: "platform-web",
      label: "Platform Web",
      description: "Single Next.js web app and nginx container for all UI domains.",
      kind: "web",
      group: "web",
      envKey: "PLATFORM_WEB_PUBLIC_URL",
      route: "/",
      url: platformUrl,
      required: true,
      remoteCapable: false,
      position: { x: 50, y: 20 },
    }, "live", "This Next.js API route responded from Platform Web.", true),
    ...[
      ["operations-ui", "Operations", "/operations", "Readiness, architecture, setup, trust evidence.", 18, 34],
      ["agents-ui", "Agents", "/agents", "Agent Studio, capabilities, tools, prompt profiles, and runtime receipts.", 34, 34],
      ["workflows-ui", "Workflows", "/workflows", "Workflow authoring, planner, runs, inbox, artifacts, and live runtime views.", 50, 34],
      ["workbench-ui", "Workbench", "/workbench", "Workbench Neo cockpit, governance, theater, and implementation artifacts.", 66, 34],
      ["foundry-ui", "Foundry", "/foundry", "SDLC generation cockpit, repositories, gaps, change plans, and verification.", 82, 34],
      ["identity-ui", "Identity", "/identity", "IAM users, teams, roles, permissions, variables, and audits.", 18, 48],
      ["llm-settings-ui", "LLM Routing", "/llm-settings", "Dial-in status for Context Fabric, MCP runtime, and LLM Gateway.", 34, 48],
    ].map(([id, label, route, description, x, y]) => staticNode({
      id: String(id),
      label: String(label),
      description: String(description),
      kind: "ui",
      group: "domain",
      route: String(route),
      url: platformUrl ? `${platformUrl}${route}` : null,
      required: true,
      remoteCapable: false,
      position: { x: Number(x), y: Number(y) },
    }, "live", "Native route served by Platform Web.", true)),
  ];

  const configs: ProbeConfig[] = [
    {
      id: "iam-service",
      label: "IAM Service",
      description: "Authentication, session verification, users, teams, roles, and capability permissions.",
      kind: "api",
      group: "core",
      envKey: "IAM_BASE_URL",
      url: cleanUrl(iamApiBase()),
      healthPath: "/health",
      required: true,
      remoteCapable: false,
      position: { x: 14, y: 62 },
    },
    {
      id: "agent-service",
      label: "Agent Service",
      description: "Agent catalog, profile/template lifecycle, learning endpoints, and agent metadata.",
      kind: "api",
      group: "agent",
      envKey: "AGENT_SERVICE_URL",
      url: cleanUrl(process.env.AGENT_SERVICE_URL ?? "http://agent-service:3001"),
      required: true,
      remoteCapable: false,
      position: { x: 30, y: 62 },
    },
    {
      id: "tool-service",
      label: "Tool Service",
      description: "Tool catalog, grants, source-backed tools, and central execution metadata.",
      kind: "api",
      group: "agent",
      envKey: "TOOL_SERVICE_URL",
      url: cleanUrl(process.env.TOOL_SERVICE_URL ?? "http://agent-service:3001"),
      required: true,
      remoteCapable: false,
      position: { x: 46, y: 62 },
    },
    {
      id: "agent-runtime",
      label: "Agent Runtime",
      description: "Resolved agent execution, runtime snapshots, receipts, and governed invocations.",
      kind: "api",
      group: "agent",
      envKey: "AGENT_RUNTIME_URL",
      url: cleanUrl(process.env.AGENT_RUNTIME_URL ?? "http://agent-runtime:3003"),
      required: true,
      remoteCapable: false,
      position: { x: 62, y: 62 },
    },
    {
      id: "prompt-composer",
      label: "Prompt Composer",
      description: "Prompt profiles, assemblies, layer composition, compression, and response orchestration.",
      kind: "api",
      group: "agent",
      envKey: "PROMPT_COMPOSER_URL",
      url: cleanUrl(process.env.PROMPT_COMPOSER_URL ?? "http://prompt-composer:3004"),
      required: true,
      remoteCapable: false,
      position: { x: 78, y: 62 },
      authToken: process.env.PROMPT_COMPOSER_SERVICE_TOKEN ?? null,
    },
    {
      id: "workgraph-api",
      label: "Workgraph API",
      description: "Workflow templates, runtime runs, events, artifacts, work items, and SSE streams.",
      kind: "api",
      group: "workflow",
      envKey: "WORKGRAPH_API_URL",
      url: cleanUrl(process.env.WORKGRAPH_API_URL ?? "http://workgraph-api:8080"),
      required: true,
      remoteCapable: false,
      position: { x: 50, y: 77 },
    },
    {
      id: "context-api",
      label: "Context Fabric",
      description: "Context, memory, knowledge, receipts, artifact context, and runtime bridge coordination.",
      kind: "api",
      group: "core",
      envKey: "CONTEXT_FABRIC_URL",
      url: cleanUrl(process.env.CONTEXT_FABRIC_URL ?? "http://context-api:8000"),
      required: true,
      remoteCapable: true,
      position: { x: 30, y: 77 },
      authToken: process.env.CONTEXT_FABRIC_SERVICE_TOKEN ?? null,
    },
    {
      id: "runtime-bridge",
      label: "Runtime Bridge",
      description: "Context Fabric WebSocket registry for MCP runtimes that dial in from Docker, servers, or laptops.",
      kind: "runtime",
      group: "runtime",
      envKey: "CONTEXT_FABRIC_URL",
      url: cleanUrl(process.env.CONTEXT_FABRIC_URL ?? "http://context-api:8000"),
      healthPath: "/api/runtime-bridge/status",
      required: true,
      remoteCapable: true,
      position: { x: 22, y: 92 },
    },
    {
      id: "mcp-server",
      label: "MCP HTTP Debug",
      description: mcpHttpDebugEnabled
        ? "Direct MCP endpoint used only for diagnostics or explicit HTTP fallback."
        : "Direct MCP HTTP probe disabled. Normal traffic uses the Runtime Bridge WebSocket.",
      kind: "runtime",
      group: "runtime",
      envKey: "MCP_SERVER_URL",
      url: mcpHttpDebugEnabled ? cleanUrl(process.env.MCP_SERVER_URL) : null,
      required: false,
      remoteCapable: true,
      position: { x: 40, y: 92 },
    },
    {
      id: "llm-gateway",
      label: "LLM Gateway Local",
      description: "Model gateway behind MCP runtime. Direct probe is diagnostic; normal model traffic is model-run over the bridge.",
      kind: "runtime",
      group: "runtime",
      envKey: "LLM_GATEWAY_URL",
      url: cleanUrl(process.env.LLM_GATEWAY_URL ?? process.env.LLM_GATEWAY_INTERNAL_URL),
      required: false,
      remoteCapable: true,
      position: { x: 58, y: 92 },
      authToken: process.env.LLM_GATEWAY_BEARER ?? null,
    },
    {
      id: "formal-verifier",
      label: "Formal Verifier",
      description: "Optional verification service for proof-backed SDLC gates.",
      kind: "runtime",
      group: "governance",
      envKey: "FORMAL_VERIFIER_URL",
      url: cleanUrl(process.env.FORMAL_VERIFIER_URL ?? process.env.FORMAL_VERIFIER_INTERNAL_URL),
      required: false,
      remoteCapable: true,
      position: { x: 74, y: 92 },
    },
    {
      id: "audit-governance",
      label: "Audit Governance",
      description: "Optional external governance ledger, audit packs, and trust evidence sink.",
      kind: "governance",
      group: "governance",
      envKey: "AUDIT_GOV_URL",
      url: cleanUrl(process.env.AUDIT_GOV_URL),
      required: false,
      remoteCapable: true,
      position: { x: 88, y: 92 },
      authToken: process.env.AUDIT_GOV_SERVICE_TOKEN ?? null,
    },
  ];

  const probedNodes = await Promise.all(configs.map(probe));
  const nodes = [...staticNodes, ...probedNodes];
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  const edgeBase: Omit<TopologyEdge, "status" | "message">[] = [
    { id: "browser-platform", source: "browser", target: "platform-web", label: "HTTP :5180", protocol: "browser", required: true },
    ...staticNodes.filter((node) => node.kind === "ui").map((node) => ({
      id: `platform-${node.id}`,
      source: "platform-web",
      target: node.id,
      label: "native route",
      protocol: "next",
      required: true,
    })),
    { id: "platform-iam", source: "platform-web", target: "iam-service", label: "auth/session", protocol: "HTTP", required: true },
    { id: "platform-agent", source: "platform-web", target: "agent-service", label: "agents", protocol: "HTTP", required: true },
    { id: "platform-tool", source: "platform-web", target: "tool-service", label: "tools", protocol: "HTTP", required: true },
    { id: "platform-runtime", source: "platform-web", target: "agent-runtime", label: "runtime", protocol: "HTTP", required: true },
    { id: "platform-composer", source: "platform-web", target: "prompt-composer", label: "prompts", protocol: "HTTP", required: true },
    { id: "platform-workgraph", source: "platform-web", target: "workgraph-api", label: "workflows/SSE", protocol: "HTTP", required: true },
    { id: "platform-context", source: "platform-web", target: "context-api", label: "memory/context", protocol: "HTTP", required: true },
    { id: "platform-foundry", source: "platform-web", target: "workgraph-api", label: "codegen proxy", protocol: "HTTP", required: true },
    { id: "platform-audit", source: "platform-web", target: "audit-governance", label: "audit proxy", protocol: "HTTP", required: false },
    { id: "agent-runtime-composer", source: "agent-runtime", target: "prompt-composer", label: "assembly", protocol: "HTTP", required: true },
    { id: "agent-runtime-tools", source: "agent-runtime", target: "tool-service", label: "tool grants", protocol: "HTTP", required: true },
    { id: "agent-runtime-context", source: "agent-runtime", target: "context-api", label: "context", protocol: "HTTP", required: true },
    { id: "composer-tools", source: "prompt-composer", target: "tool-service", label: "tool metadata", protocol: "HTTP", required: true },
    { id: "composer-context", source: "prompt-composer", target: "context-api", label: "knowledge", protocol: "HTTP", required: true },
    { id: "workgraph-context", source: "workgraph-api", target: "context-api", label: "events/artifacts", protocol: "HTTP/SSE", required: true },
    { id: "workgraph-composer", source: "workgraph-api", target: "prompt-composer", label: "stage prompts", protocol: "HTTP", required: true },
    { id: "context-runtime-bridge", source: "context-api", target: "runtime-bridge", label: "dispatch registry", protocol: "WS", required: true },
    { id: "runtime-bridge-mcp", source: "runtime-bridge", target: "mcp-server", label: "tool/model/code frames", protocol: "WebSocket", required: false },
    { id: "tool-mcp", source: "tool-service", target: "runtime-bridge", label: "tool metadata", protocol: "HTTP", required: false },
    { id: "composer-mcp", source: "prompt-composer", target: "runtime-bridge", label: "prompt + tool context", protocol: "HTTP", required: false },
    { id: "mcp-llm", source: "mcp-server", target: "llm-gateway", label: "local model calls", protocol: "HTTP", required: false },
    { id: "runtime-llm", source: "agent-runtime", target: "llm-gateway", label: "distill", protocol: "HTTP", required: false },
    { id: "codegen-composer", source: "workgraph-api", target: "prompt-composer", label: "SDLC prompts", protocol: "HTTP", required: false },
    { id: "codegen-verifier", source: "workgraph-api", target: "formal-verifier", label: "verification", protocol: "HTTP", required: false },
  ];

  const edges = edgeBase.map((edge) => ({ ...edge, ...edgeStatus(edge, nodeMap) }));
  const liveNodes = nodes.filter((node) => node.ok === true).length;
  const downRequired = nodes.filter((node) => node.required && node.ok === false);
  const configuredOptional = nodes.filter((node) => !node.required && node.url);
  const liveEdges = edges.filter((edge) => edge.status === "live").length;

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    summary: {
      nodeCount: nodes.length,
      liveNodes,
      requiredHealthy: downRequired.length === 0,
      requiredDown: downRequired.length,
      configuredOptional: configuredOptional.length,
      liveEdges,
      edgeCount: edges.length,
    },
    nodes,
    edges,
  });
}
