import assert from "assert";
import {
  normalizeCapabilityPermissions,
  resolveLocalOrDocumentCapability,
  resolveProviderCapabilities,
  summarizeProfileSources,
  sortEffectiveCapabilities,
  type ProfileSkillForResolution,
} from "./agent-profile-resolve";

function binding(overrides: Partial<ProfileSkillForResolution>): ProfileSkillForResolution {
  return {
    skillId: "skill-1",
    skillName: "GitHub Search",
    skillType: "GITHUB",
    sourceType: "local",
    permissions: ["read", "invoke"],
    readOnly: false,
    providerLocked: false,
    ...overrides,
  };
}

function main() {
  const local = resolveLocalOrDocumentCapability(binding({ sourceType: "local" }));
  assert.deepEqual(local.permissions, ["read", "invoke"]);
  assert.equal(local.readOnly, false);

  const document = resolveLocalOrDocumentCapability(binding({
    sourceType: "url_document",
    sourceRef: "https://example.test/runbook.docx",
    permissions: ["read", "invoke", "edit"],
    readOnly: true,
    providerLocked: true,
  }));
  assert.deepEqual(document.permissions, ["read"]);
  assert.equal(document.readOnly, true);
  assert.equal(document.providerLocked, true);

  const provider = resolveProviderCapabilities(
    binding({
      sourceType: "provider_manifest",
      sourceRef: "https://provider.test/manifest.json",
      permissions: ["read", "invoke", "edit"],
      readOnly: false,
      providerLocked: false,
    }),
    {
      name: "GitHub",
      version: "2026-06-18",
      capabilities: [
        {
          id: "github.issue.search",
          name: "Search issues",
          permissions: ["read", "invoke"],
        },
        {
          id: "github.repo.settings.update",
          name: "Update repo settings",
          permissions: ["read", "invoke", "edit"],
          constraints: { providerLocked: true },
        },
      ],
    },
    {
      manifestDigest: "sha256-test-digest",
      signatureKeyId: "github-key-1",
      signedManifest: true,
    },
  );
  assert.equal(provider.provider.status, "resolved");
  if (provider.provider.status !== "resolved") throw new Error("provider should resolve");
  assert.equal(provider.provider.capabilityCount, 2);
  assert.equal(provider.provider.manifestDigest, "sha256-test-digest");
  assert.equal(provider.provider.signatureKeyId, "github-key-1");
  assert.equal(provider.provider.signedManifest, true);
  assert.deepEqual(provider.capabilities.find((capability) => capability.id === "github.issue.search")?.permissions, ["read", "invoke"]);
  assert.equal(provider.capabilities.find((capability) => capability.id === "github.issue.search")?.providerId, "GitHub");
  assert.equal(provider.capabilities.find((capability) => capability.id === "github.issue.search")?.providerManifestVersion, "2026-06-18");
  assert.equal(provider.capabilities.find((capability) => capability.id === "github.issue.search")?.providerManifestDigest, "sha256-test-digest");
  assert.equal(provider.capabilities.find((capability) => capability.id === "github.issue.search")?.providerManifestSignatureKeyId, "github-key-1");
  assert.equal(provider.capabilities.find((capability) => capability.id === "github.issue.search")?.providerManifestSigned, true);
  const locked = provider.capabilities.find((capability) => capability.id === "github.repo.settings.update");
  assert.deepEqual(locked?.permissions, ["read"]);
  assert.equal(locked?.providerLocked, true);

  assert.deepEqual(
    normalizeCapabilityPermissions(["invoke", "edit"], ["read"], true),
    ["read"],
    "provider-locked/read-only preview permissions must clamp to read",
  );
  assert.deepEqual(
    normalizeCapabilityPermissions(["read", "invoke", "edit"], ["read"], false),
    ["read", "invoke", "edit"],
  );

  const defaultReadOnlyProvider = resolveProviderCapabilities(
    binding({
      sourceType: "provider_manifest",
      sourceRef: "https://provider.test/manifest.json",
      permissions: ["read"],
      readOnly: true,
      providerLocked: false,
    }),
    {
      name: "GitHub",
      version: "2026-06-18",
      capabilities: [
        {
          id: "github.pr.comment.create",
          name: "Create PR comment",
          permissions: ["read", "invoke", "edit"],
        },
      ],
    },
  );
  assert.deepEqual(defaultReadOnlyProvider.capabilities[0]?.permissions, ["read"]);
  assert.equal(defaultReadOnlyProvider.capabilities[0]?.readOnly, true);
  assert.equal(defaultReadOnlyProvider.capabilities[0]?.providerLocked, false);

  const sorted = sortEffectiveCapabilities([
    provider.capabilities[1],
    document,
    provider.capabilities[0],
    local,
  ]);
  assert.deepEqual(sorted.map((capability) => capability.id), [
    local.id,
    "github.issue.search",
    "github.repo.settings.update",
    document.id,
  ]);

  const governance = summarizeProfileSources([
    binding({ sourceType: "local", skillName: "Local Runner" }),
    binding({
      sourceType: "url_document",
      skillName: "Runbook",
      sourceRef: "https://example.test/runbook.md",
      permissions: ["read", "invoke"],
      readOnly: true,
      providerLocked: true,
      metadata: { sourceArtifact: { kind: "knowledge_source", id: "ks-1" } },
    }),
    binding({
      sourceType: "provider_manifest",
      skillName: "GitHub",
      sourceRef: "https://provider.test/manifest.json",
      permissions: ["read"],
      readOnly: true,
      providerLocked: false,
    }),
    binding({
      sourceType: "provider_manifest",
      skillName: "Broken Provider",
      sourceRef: null,
      permissions: ["read"],
      readOnly: true,
      providerLocked: false,
    }),
  ]);
  assert.equal(governance.summary.totalBindings, 4);
  assert.equal(governance.summary.externalBindings, 3);
  assert.equal(governance.summary.documentBindings, 1);
  assert.equal(governance.summary.providerManifestBindings, 2);
  assert.equal(governance.summary.liveResolutionRequired, 2);
  assert.equal(governance.summary.missingSourceRefs, 1);
  assert.equal(governance.summary.knowledgeSources, 1);
  assert.equal(governance.sources.find((source) => source.skillName === "Runbook")?.permissions.join(","), "read");
  assert.ok(governance.summary.warnings.some((warning) => warning.includes("Broken Provider")));

  console.log("agent profile resolve contract tests passed");
}

main();
