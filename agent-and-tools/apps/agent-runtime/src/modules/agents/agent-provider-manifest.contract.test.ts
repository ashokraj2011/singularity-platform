import assert from "assert";
import {
  manifestSignatureRequired,
  signProviderManifest,
  trustedManifestKeyStrengthIssues,
  validateProviderManifestEnvelope,
  verifyProviderManifestSignature,
} from "./agent-provider-manifest";

function main() {
  const now = new Date("2026-06-19T00:00:00.000Z");
  const body = JSON.stringify({
    name: "GitHub provider",
    version: "2026-06-18",
    issuedAt: "2026-06-18T00:00:00.000Z",
    expiresAt: "2026-06-25T00:00:00.000Z",
    capabilities: [{ id: "github.issue.search", permissions: ["read", "invoke"] }],
  });
  const trustedKeys = JSON.stringify({ github: "local-test-provider-secret-min-32-chars" });
  const signature = signProviderManifest(body, "local-test-provider-secret-min-32-chars");

  assert.equal(manifestSignatureRequired({ mode: "auto", nodeEnv: "development" }), false);
  assert.equal(manifestSignatureRequired({ mode: "auto", nodeEnv: "production" }), true);
  assert.equal(manifestSignatureRequired({ mode: "auto", trustedKeys, nodeEnv: "development" }), true);
  assert.equal(manifestSignatureRequired({ mode: "required", nodeEnv: "development" }), true);
  assert.equal(manifestSignatureRequired({ mode: "disabled", nodeEnv: "production" }), false);
  assert.deepEqual(trustedManifestKeyStrengthIssues(trustedKeys), []);
  assert.deepEqual(
    trustedManifestKeyStrengthIssues(JSON.stringify({ tiny: "short" })),
    ["provider manifest key tiny must be at least 32 characters"],
  );
  assert.deepEqual(
    trustedManifestKeyStrengthIssues("tiny:short,github:local-test-provider-secret-min-32-chars"),
    ["provider manifest key tiny must be at least 32 characters"],
  );

  verifyProviderManifestSignature({ body, mode: "auto", nodeEnv: "development" });
  verifyProviderManifestSignature({
    body,
    mode: "required",
    trustedKeys,
    keyId: "github",
    signature: `sha256=${signature}`,
  });
  verifyProviderManifestSignature({
    body,
    mode: "auto",
    trustedKeys: "github:local-test-provider-secret-min-32-chars",
    keyId: "github",
    signature,
  });

  assert.throws(
    () => verifyProviderManifestSignature({ body, mode: "required", trustedKeys }),
    /signature required/,
  );
  assert.throws(
    () => verifyProviderManifestSignature({ body, mode: "required", trustedKeys, keyId: "other", signature }),
    /not trusted/,
  );
  assert.throws(
    () => verifyProviderManifestSignature({ body, mode: "required", trustedKeys, keyId: "github", signature: "sha256=deadbeef" }),
    /verification failed/,
  );

  validateProviderManifestEnvelope({
    manifest: JSON.parse(body),
    mode: "required",
    trustedKeys,
    now,
    maxTtlSeconds: 30 * 24 * 60 * 60,
  });
  validateProviderManifestEnvelope({
    manifest: {
      name: "Local provider",
      capabilities: [{ id: "local.issue.search", permissions: ["read"] }],
    },
    mode: "auto",
    nodeEnv: "development",
    now,
  });

  assert.throws(
    () => validateProviderManifestEnvelope({
      manifest: { name: "Missing version", expiresAt: "2026-06-25T00:00:00.000Z" },
      mode: "required",
      trustedKeys,
      now,
    }),
    /must include version/,
  );
  assert.throws(
    () => validateProviderManifestEnvelope({
      manifest: { name: "Missing expiry", version: "1" },
      mode: "required",
      trustedKeys,
      now,
    }),
    /must include expiresAt/,
  );
  assert.throws(
    () => validateProviderManifestEnvelope({
      manifest: { name: "Expired", version: "1", expiresAt: "2026-06-18T00:00:00.000Z" },
      mode: "required",
      trustedKeys,
      now,
    }),
    /expired/,
  );
  assert.throws(
    () => validateProviderManifestEnvelope({
      manifest: { name: "Future", version: "1", issuedAt: "2026-06-19T00:10:01.000Z", expiresAt: "2026-06-20T00:00:00.000Z" },
      mode: "required",
      trustedKeys,
      now,
    }),
    /future/,
  );
  assert.throws(
    () => validateProviderManifestEnvelope({
      manifest: { name: "Too long", version: "1", issuedAt: "2026-06-19T00:00:00.000Z", expiresAt: "2026-07-20T00:00:01.000Z" },
      mode: "required",
      trustedKeys,
      now,
      maxTtlSeconds: 30 * 24 * 60 * 60,
    }),
    /validity window exceeds/,
  );
  assert.throws(
    () => validateProviderManifestEnvelope({
      manifest: {
        name: "Duplicate",
        version: "1",
        expiresAt: "2026-06-25T00:00:00.000Z",
        capabilities: [
          { id: "github.issue.search" },
          { id: "github.issue.search" },
        ],
      },
      mode: "required",
      trustedKeys,
      now,
    }),
    /duplicate capability id/,
  );
  assert.throws(
    () => validateProviderManifestEnvelope({
      manifest: {
        name: "Insecure",
        version: "1",
        expiresAt: "2026-06-25T00:00:00.000Z",
        capabilities: [{ id: "github.issue.search", endpoint: "http://provider.test/invoke" }],
      },
      mode: "required",
      trustedKeys,
      now,
    }),
    /insecure invocation endpoint/,
  );

  console.log("agent provider manifest signature contract tests passed");
}

main();
