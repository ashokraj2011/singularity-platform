import assert from "assert";
import { effectiveCapabilityGate } from "./effective-capability-gate";

function main() {
  assert.deepEqual(
    effectiveCapabilityGate({ toolName: "github.issue.search" }),
    { allowed: true, enforced: false },
  );

  const strictMissing = effectiveCapabilityGate({
    toolName: "github.issue.search",
    requireEffectiveCapabilities: true,
  });
  assert.equal(strictMissing.allowed, false);
  assert.match(strictMissing.allowed ? "" : strictMissing.reason, /required/);

  const strictEmpty = effectiveCapabilityGate({
    effectiveCapabilities: [],
    effectiveCapabilitiesProvided: true,
    requireEffectiveCapabilities: true,
    toolName: "github.issue.search",
  });
  assert.equal(strictEmpty.allowed, false);
  assert.match(strictEmpty.allowed ? "" : strictEmpty.reason, /not present/);

  const effectiveCapabilities = [
    {
      id: "github.issue.search",
      name: "Search issues",
      permissions: ["read", "invoke"],
      readOnly: false,
      providerLocked: false,
      providerManifestDigest: "sha256:abc123",
      providerManifestSignatureKeyId: "github-key-1",
      providerManifestSigned: true,
    },
    {
      id: "github.repo.settings.update",
      name: "Update repo settings",
      permissions: ["read"],
      readOnly: true,
      providerLocked: true,
    },
  ];

  const allowedSearch = effectiveCapabilityGate({
    effectiveCapabilities,
    toolName: "github.issue.search",
  });
  assert.equal(allowedSearch.allowed, true);
  assert.equal(
    allowedSearch.allowed ? allowedSearch.matchingCapability?.providerManifestDigest : undefined,
    "sha256:abc123",
  );

  const absent = effectiveCapabilityGate({
    effectiveCapabilities,
    toolName: "github.pr.comment.create",
  });
  assert.equal(absent.allowed, false);
  assert.match(absent.allowed ? "" : absent.reason, /not present/);

  const readOnly = effectiveCapabilityGate({
    effectiveCapabilities,
    toolName: "github.repo.settings.update",
    requestedPermission: "edit",
  });
  assert.equal(readOnly.allowed, false);
  assert.match(readOnly.allowed ? "" : readOnly.reason, /does not allow edit/);
  assert.match(readOnly.allowed ? "" : readOnly.reason, /read-only/);
  assert.match(readOnly.allowed ? "" : readOnly.reason, /provider-locked/);

  const named = effectiveCapabilityGate({
    effectiveCapabilities,
    toolName: "provider-tool",
    requestedCapabilityId: "Search issues",
    requestedPermission: "invoke",
  });
  assert.equal(named.allowed, true);
  assert.equal(named.allowed ? named.capabilityId : "", "Search issues");

  const invalidPermission = effectiveCapabilityGate({
    effectiveCapabilities,
    toolName: "github.issue.search",
    requestedPermission: "delete",
  });
  assert.equal(invalidPermission.allowed, false);
  assert.match(invalidPermission.allowed ? "" : invalidPermission.reason, /Unsupported/);

  const objectPermissionsAndSnakeCase = effectiveCapabilityGate({
    effectiveCapabilities: [
      {
        capability_id: "github.issue.comment.create",
        skill_name: "Comment on issue",
        permissions: { read: true, invoke: true, edit: false },
      },
    ],
    toolName: "provider-tool",
    requestedCapabilityId: "github.issue.comment.create",
    requestedPermission: "invoke",
  });
  assert.equal(objectPermissionsAndSnakeCase.allowed, true);

  const snakeCaseLocks = effectiveCapabilityGate({
    effectiveCapabilities: [
      {
        tool_name: "github.repo.settings.update",
        permissions: { read: true, edit: false },
        read_only: true,
        provider_locked: true,
      },
    ],
    toolName: "github.repo.settings.update",
    requestedPermission: "edit",
  });
  assert.equal(snakeCaseLocks.allowed, false);
  assert.match(snakeCaseLocks.allowed ? "" : snakeCaseLocks.reason, /read-only/);
  assert.match(snakeCaseLocks.allowed ? "" : snakeCaseLocks.reason, /provider-locked/);

  console.log("effective capability gate contract tests passed");
}

main();
