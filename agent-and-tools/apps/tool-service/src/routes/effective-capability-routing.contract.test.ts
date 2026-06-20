import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const discoverySource = readFileSync(path.resolve(__dirname, "discovery.ts"), "utf8");
const executionSource = readFileSync(path.resolve(__dirname, "execution.ts"), "utf8");

assert(
  discoverySource.includes("allowed_capabilities, allowed_agents, metadata"),
  "tool discovery must select tool metadata so provider/source permission fields are available",
);
assert(
  discoverySource.includes("const capabilityMetadata = capabilityMetadataForTool(t, capability_id);"),
  "tool discovery must normalize capability metadata before the policy gate",
);
assert(
  discoverySource.includes("requestedCapabilityId: capabilityMetadata.capability_id ?? t.tool_name"),
  "tool discovery must gate by the declared capability id before falling back to tool_name",
);
assert(
  discoverySource.includes("...capabilityMetadata"),
  "tool discovery responses must include capability permission and source metadata",
);
assert(
  discoverySource.includes("manifestEvidenceFromCapability") &&
    discoverySource.includes("provider_manifest_digest") &&
    discoverySource.includes("provider_manifest_signature_key_id"),
  "tool discovery responses must preserve provider manifest digest/signature evidence from the effective capability set",
);
assert(
  executionSource.includes("const capabilityMetadata = capabilityMetadataForTool(tool, capability_id);"),
  "tool invocation must normalize stored tool metadata before the policy gate",
);
assert(
  executionSource.includes("requested_capability_id ?? requestedCapabilityId ?? capabilityMetadata.capability_id"),
  "tool invocation must gate by explicit request, then stored capability id, then tool_name fallback",
);
assert(
  executionSource.includes("serverToolUrlPolicy(endpointUrl)") &&
    executionSource.includes("policy_gate: \"server_tool_endpoint_allowlist\""),
  "server-side tool invocation must enforce endpoint allowlisting before fetch",
);
assert(
  executionSource.includes("function verifiedCallerAuthHeaders(req: Request)") &&
    executionSource.includes("...verifiedCallerAuthHeaders(req),"),
  "server-side tool fan-out must forward the already-verified caller bearer to authenticated internal tool endpoints",
);

console.log("tool-service effective capability routing contract tests passed");
