import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const serviceSource = readFileSync(path.resolve(__dirname, "compose.service.ts"), "utf8");

assert(
  !serviceSource.includes("trace_id:       input.workflowContext.instanceId"),
  "audit events must not use workflow instance id when a resolved trace id exists",
);
assert(
  !serviceSource.includes("trace_id: input.workflowContext.instanceId"),
  "Context Fabric calls must not use workflow instance id when a resolved trace id exists",
);
assert(
  !serviceSource.includes("body = `[artifact ${art.label}: stored at ${art.minioRef}"),
  "MinIO-only artifacts must not inject fake placeholder content",
);
assert(
  !serviceSource.includes("MinIO fetch is not implemented"),
  "MinIO-only artifacts must not leave fake/placeholder fetch behavior in the prompt path",
);
assert(
  serviceSource.includes("fetchArtifactContent"),
  "MinIO/document references must route through the governed artifact fetch path",
);
assert(
  !serviceSource.includes("data: { evidenceRefs: evidenceRefs as never }"),
  "cached PromptAssembly rows must not be mutated across workflow runs",
);
assert(
  serviceSource.includes("requiresApprovalForDiscoveredTool"),
  "dynamic tool discovery must preserve approval requirements",
);
assert(
  serviceSource.includes("agent_template_id: input.agentTemplateId"),
  "Context Fabric execution must preserve agent template id for tool discovery and memory scope",
);
assert(
  serviceSource.includes("Input schema: ${JSON.stringify"),
  "tool contract prompt blocks must include the schema that MCP will expose to the model",
);
assert(
  serviceSource.includes("Array.isArray(input.toolDescriptors)"),
  "Prompt Composer must prefer Context Fabric's canonical tool descriptors when provided",
);
assert(
  serviceSource.indexOf("Array.isArray(input.toolDescriptors)") < serviceSource.indexOf("runtimeReader.toolGrant.findMany"),
  "canonical tool descriptors must short-circuit static grants and dynamic discovery",
);
assert(
  serviceSource.includes("Array.isArray(input.effectiveCapabilities)"),
  "dynamic tool discovery must require a resolved effective capability set",
);
assert(
  serviceSource.includes("effective_capabilities: input.effectiveCapabilities"),
  "dynamic tool discovery must forward the resolved effective capability set",
);
assert(
  serviceSource.includes("capability_permissions: t.capability_permissions"),
  "dynamic discovered tools must preserve capability permission metadata in prompt tool blocks",
);
assert(
  serviceSource.includes("read_only: t.read_only"),
  "dynamic discovered tools must preserve read-only metadata in prompt tool blocks",
);
assert(
  serviceSource.includes("provider_locked: t.provider_locked"),
  "dynamic discovered tools must preserve provider-locked metadata in prompt tool blocks",
);
assert(
  serviceSource.includes("source_ref: t.source_ref"),
  "dynamic discovered tools must preserve source references in prompt tool blocks",
);
assert(
  serviceSource.includes("function learningServiceHeaders(): Record<string, string>"),
  "learning-service calls must use an explicit service-token header helper",
);
assert(
  serviceSource.includes("env.LEARNING_SERVICE_TOKEN ?? process.env.AUDIT_GOV_SERVICE_TOKEN"),
  "learning-service calls must fall back to the existing audit governance service token",
);
assert(
  serviceSource.includes("headers: learningServiceHeaders()"),
  "learning-service state reads must send service auth headers",
);
assert(
  serviceSource.includes("trace_id:       resolvedTraceId ?? input.workflowContext.instanceId"),
  "prompt audit events should use the resolved trace id",
);
assert(
  serviceSource.includes("trace_id: resolvedTraceId ?? input.workflowContext.instanceId"),
  "Context Fabric execution should use the resolved trace id",
);

console.log("prompt composer hardening contract tests passed");
