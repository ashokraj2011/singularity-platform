import assert from "node:assert/strict";
import { capabilityMetadataForTool } from "./capability-metadata";

const readTool = capabilityMetadataForTool(
  { tool_name: "read_file", metadata: {}, runtime: { runtime_type: "mcp" } },
  "cap-1",
);
assert.deepEqual(readTool, {
  capability_id: "cap-1",
  capability_permissions: ["read", "invoke"],
  read_only: true,
  provider_locked: false,
  provider_id: undefined,
  provider_manifest_version: undefined,
  provider_manifest_digest: undefined,
  provider_manifest_signature_key_id: undefined,
  provider_manifest_signed: undefined,
  source_type: "local",
  source_ref: undefined,
  source: "local",
});

const mutationTool = capabilityMetadataForTool({ tool_name: "apply_patch", metadata: {} }, "cap-1");
assert.deepEqual(mutationTool.capability_permissions, ["read", "invoke", "edit"]);
assert.equal(mutationTool.read_only, false);

const providerTool = capabilityMetadataForTool({
  tool_name: "github.issue.read",
  metadata: {
    providerId: "github",
    providerManifestVersion: "2026-06-17",
    providerManifestDigest: "sha256:abc123",
    providerManifestSignatureKeyId: "github-key-1",
    providerManifestSigned: true,
    capabilityId: "github.issue.read",
    capabilityPermissions: { read: true, invoke: true, edit: false },
    providerLocked: true,
    sourceType: "provider_manifest",
    sourceRef: "https://api.github.test/.well-known/agent-manifest.json",
  },
});
assert.deepEqual(providerTool, {
  capability_id: "github.issue.read",
  capability_permissions: ["read", "invoke"],
  read_only: true,
  provider_locked: true,
  provider_id: "github",
  provider_manifest_version: "2026-06-17",
  provider_manifest_digest: "sha256:abc123",
  provider_manifest_signature_key_id: "github-key-1",
  provider_manifest_signed: true,
  source_type: "provider_manifest",
  source_ref: "https://api.github.test/.well-known/agent-manifest.json",
  source: "provider_manifest",
});

const runtimeTool = capabilityMetadataForTool({
  tool_name: "dynamic.lookup",
  metadata: {
    source: "runtime",
    permissions: ["READ", "invoke", "unknown", "invoke"],
    readOnly: false,
  },
});
assert.deepEqual(runtimeTool.capability_permissions, ["read", "invoke"]);
assert.equal(runtimeTool.read_only, false);
assert.equal(runtimeTool.source, "runtime");
assert.equal(runtimeTool.provider_locked, false);

console.log("tool-service capability metadata contract: 19 assertions passed");
