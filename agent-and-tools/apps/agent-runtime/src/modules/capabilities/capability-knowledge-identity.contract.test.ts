import assert from "node:assert/strict";
import {
  normalizedKnowledgeIdentityValue,
  sourceBackedKnowledgeArtifactKey,
} from "./capability-knowledge-identity";

assert.equal(normalizedKnowledgeIdentityValue("  repo://x  "), "repo://x");

assert.equal(
  sourceBackedKnowledgeArtifactKey({
    capabilityId: "CAP-1",
    artifactType: "DOC",
    title: " Architecture ",
    sourceType: " GITHUB_REPO ",
    sourceRef: " HTTPS://github.com/acme/app ",
  }),
  "capability-knowledge:cap-1:doc:architecture:github_repo:https://github.com/acme/app",
);

assert.equal(
  sourceBackedKnowledgeArtifactKey({
    capabilityId: "cap-1",
    artifactType: "DOC",
    title: "Architecture",
    sourceType: "GITHUB_REPO",
    sourceRef: "   ",
  }),
  null,
  "manual/user-entered artifacts without sourceRef are intentionally not deduped by source identity",
);

console.log("capability knowledge identity contract tests passed");
