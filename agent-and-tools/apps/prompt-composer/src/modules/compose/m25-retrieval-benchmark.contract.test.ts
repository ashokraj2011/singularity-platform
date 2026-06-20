/**
 * M25 retrieval benchmark contract.
 *
 * This is intentionally DB-free: it protects the ranking/citation primitives
 * that live on every retrieval path before operator data or seeded fixtures are
 * available. The live DB readiness check remains bin/check-m25-knowledge.sh.
 */
import assert from "node:assert/strict";
import {
  clampConfidence,
  formatCiteMarker,
  makeCitationKey,
  reciprocalRankFusion,
  recencyBoost,
  retrievalMode,
  taskSignature,
  toExcerpt,
} from "./retrieval";

const oldRetrievalMode = process.env.RETRIEVAL_MODE;
try {
  delete process.env.RETRIEVAL_MODE;
  assert.equal(retrievalMode(), "hybrid", "retrieval defaults to hybrid mode");
  process.env.RETRIEVAL_MODE = "vector";
  assert.equal(retrievalMode(), "vector", "vector override is accepted");
  process.env.RETRIEVAL_MODE = "fts";
  assert.equal(retrievalMode(), "fts", "FTS override is accepted");
  process.env.RETRIEVAL_MODE = "nonsense";
  assert.equal(retrievalMode(), "hybrid", "unknown retrieval mode falls back to hybrid");
} finally {
  if (oldRetrievalMode === undefined) delete process.env.RETRIEVAL_MODE;
  else process.env.RETRIEVAL_MODE = oldRetrievalMode;
}

const fused = reciprocalRankFusion(
  [
    { id: "vector-only-top", row: { title: "vector-only-top" } },
    { id: "vector-only-second", row: { title: "vector-only-second" } },
    { id: "shared-grounded-answer", row: { title: "shared-grounded-answer" } },
  ],
  [
    { id: "shared-grounded-answer", row: { title: "shared-grounded-answer" } },
    { id: "fts-only-exact-phrase", row: { title: "fts-only-exact-phrase" } },
  ],
);

assert.equal(
  fused[0].id,
  "shared-grounded-answer",
  "hybrid RRF must rank a cross-branch hit above single-branch hits",
);
assert(
  fused.some(hit => hit.id === "fts-only-exact-phrase" && hit.vector_rank === null && hit.fts_rank === 2),
  "hybrid RRF must retain FTS-only exact phrase hits instead of dropping them",
);
assert(
  fused.some(hit => hit.id === "vector-only-top" && hit.vector_rank === 1 && hit.fts_rank === null),
  "hybrid RRF must retain vector-only semantic hits instead of dropping them",
);
for (let i = 1; i < fused.length; i += 1) {
  assert(
    fused[i - 1].rrf_score >= fused[i].rrf_score,
    "hybrid RRF output must be sorted by descending score",
  );
}

const citation = makeCitationKey("knowledge", "  Deep   Retrieval\nGuide  ", "12345678-abcd");
assert.equal(citation, "KA:Deep Retrieval Guide#123456");
assert.equal(formatCiteMarker(citation), "〔cite: KA:Deep Retrieval Guide#123456〕");

const longExcerpt = toExcerpt("x".repeat(600));
assert.equal(longExcerpt.length, 501, "evidence excerpts stay bounded to 500 chars plus ellipsis");
assert(longExcerpt.endsWith("…"), "truncated evidence excerpts show truncation");
assert.equal(toExcerpt("short"), "short");

assert.equal(clampConfidence(-1), 0);
assert.equal(clampConfidence(1.2), 1);
assert.equal(clampConfidence(Number.NaN), 0);
assert.equal(clampConfidence(0.42), 0.42);

assert(recencyBoost(0) > recencyBoost(15), "newer evidence receives a larger recency boost");
assert.equal(recencyBoost(10_000), 0, "old evidence receives no recency boost");

const signatureA = taskSignature({
  capabilityId: "cap-1",
  agentTemplateId: "agent-1",
  intent: "  Fix    Checkout\n Bug ",
  contentRevision: "rev-1",
});
const signatureB = taskSignature({
  capabilityId: "cap-1",
  agentTemplateId: "agent-1",
  intent: "fix checkout bug",
  contentRevision: "rev-1",
});
const signatureC = taskSignature({
  capabilityId: "cap-1",
  agentTemplateId: "agent-1",
  intent: "fix checkout bug",
  contentRevision: "rev-2",
});

assert.equal(signatureA, signatureB, "task signatures normalize intent whitespace and case");
assert.notEqual(signatureA, signatureC, "task signatures change when capability content revision changes");

console.log("M25 retrieval benchmark contract passed");
