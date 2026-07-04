export const SERVICE_DEFINITIONS = {
  "agent-runtime": {
    envKey: "AGENT_RUNTIME_URL",
    localUrl: "http://localhost:3003",
    dockerUrl: "http://agent-runtime:3003",
    healthPath: "/health",
  },
  "agent-service": {
    envKey: "AGENT_SERVICE_URL",
    localUrl: "http://localhost:3001",
    dockerUrl: "http://agent-service:3001",
    healthPath: "/health",
  },
  "audit-governance": {
    envKey: "AUDIT_GOV_URL",
    localUrl: "http://localhost:8500",
    dockerUrl: "http://host.docker.internal:8500",
    healthPath: "/health",
    tokenEnvKeys: ["AUDIT_GOV_SERVICE_TOKEN", "AUDIT_GOV_TOKEN"],
  },
  "context-fabric": {
    envKey: "CONTEXT_FABRIC_URL",
    localUrl: "http://localhost:8000",
    dockerUrl: "http://context-api:8000",
    healthPath: "/health",
    tokenEnvKeys: ["CONTEXT_FABRIC_SERVICE_TOKEN", "IAM_SERVICE_TOKEN"],
  },
  "formal-verifier": {
    envKey: "FORMAL_VERIFIER_URL",
    localUrl: "http://localhost:8010",
    dockerUrl: "http://formal-verifier:8010",
    healthPath: "/health",
  },
  iam: {
    envKey: "IAM_BASE_URL",
    localUrl: "http://localhost:8100/api/v1",
    dockerUrl: "http://iam-service:8100/api/v1",
    healthPath: "/health",
    tokenEnvKeys: ["IAM_SERVICE_TOKEN"],
  },
  "llm-gateway": {
    envKey: "LLM_GATEWAY_URL",
    localUrl: "http://localhost:8001",
    dockerUrl: "http://llm-gateway:8001",
    healthPath: "/health",
    tokenEnvKeys: ["LLM_GATEWAY_BEARER"],
  },
  "mcp-server": {
    envKey: "MCP_SERVER_URL",
    localUrl: "http://localhost:7100",
    dockerUrl: "http://mcp-server:7100",
    healthPath: "/health",
    tokenEnvKeys: ["MCP_BEARER_TOKEN"],
  },
  "prompt-composer": {
    envKey: "PROMPT_COMPOSER_URL",
    localUrl: "http://localhost:3004",
    dockerUrl: "http://prompt-composer:3004",
    healthPath: "/health",
    tokenEnvKeys: ["PROMPT_COMPOSER_SERVICE_TOKEN"],
  },
  "tool-service": {
    envKey: "TOOL_SERVICE_URL",
    localUrl: "http://localhost:3001",
    dockerUrl: "http://agent-service:3001",
    healthPath: "/health",
  },
  "workgraph-api": {
    envKey: "WORKGRAPH_API_URL",
    localUrl: "http://localhost:8080",
    dockerUrl: "http://workgraph-api:8080",
    healthPath: "/health",
    tokenEnvKeys: ["WORKGRAPH_PROXY_SERVICE_TOKEN", "WORKGRAPH_INTERNAL_TOKEN"],
  },
};

export function defaultServiceUrl(serviceId, local) {
  const service = SERVICE_DEFINITIONS[serviceId];
  if (!service) throw new Error(`Unknown platform service: ${serviceId}`);
  return local ? service.localUrl : service.dockerUrl;
}
