import assert from "node:assert/strict";
import {
  capabilityCodeEmbeddingKey,
  normalizedCodeEmbeddingValue,
} from "./capability-code-embedding-identity";

assert.equal(normalizedCodeEmbeddingValue(" symbol-1 "), "symbol-1");
assert.equal(
  capabilityCodeEmbeddingKey({ symbolId: " SYMBOL-1 " }),
  "capability-code-embedding:symbol-1",
);
assert.equal(capabilityCodeEmbeddingKey({ symbolId: "" }), null);
assert.equal(capabilityCodeEmbeddingKey({ symbolId: " " }), null);

console.log("capability code embedding identity contract tests passed");
