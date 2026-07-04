import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boundedIntEnv, boundedNumberEnv } from "../../shared/env-bounds";

const originalEnv = { ...process.env };

try {
  process.env.EMBEDDING_RECENCY_DAYS = "not-a-number";
  assert.equal(boundedIntEnv("EMBEDDING_RECENCY_DAYS", 30, 1, 3650), 30);

  process.env.EMBEDDING_RECENCY_DAYS = "0";
  assert.equal(boundedIntEnv("EMBEDDING_RECENCY_DAYS", 30, 1, 3650), 30);

  process.env.EMBEDDING_RECENCY_DAYS = "99999";
  assert.equal(boundedIntEnv("EMBEDDING_RECENCY_DAYS", 30, 1, 3650), 3650);

  process.env.EMBEDDING_RECENCY_DAYS = "45.9";
  assert.equal(boundedIntEnv("EMBEDDING_RECENCY_DAYS", 30, 1, 3650), 45);

  process.env.EMBEDDING_RECENCY_BOOST = "bad";
  assert.equal(boundedNumberEnv("EMBEDDING_RECENCY_BOOST", 0.2, 0, 1), 0.2);

  process.env.EMBEDDING_RECENCY_BOOST = "1.5";
  assert.equal(boundedNumberEnv("EMBEDDING_RECENCY_BOOST", 0.2, 0, 1), 1);

  process.env.RETRIEVAL_EMPTY_COSINE_THRESHOLD = "-0.1";
  assert.equal(boundedNumberEnv("RETRIEVAL_EMPTY_COSINE_THRESHOLD", 0.2, 0, 1), 0.2);
} finally {
  process.env = originalEnv;
}

const retrieval = readFileSync("src/modules/compose/retrieval.ts", "utf8");
const service = readFileSync("src/modules/compose/compose.service.ts", "utf8");
const routes = readFileSync("src/modules/compose/compose.routes.ts", "utf8");
const pkg = readFileSync("package.json", "utf8");

assert.match(
  retrieval,
  /const RETRIEVAL_CONFIG = retrievalConfig\(\);/,
  "recency boost must use bounded retrieval config",
);
assert.doesNotMatch(
  retrieval,
  /Number\(process\.env\.EMBEDDING_RECENCY_/,
  "retrieval primitives must not parse recency env directly",
);

assert.match(
  service,
  /const RETRIEVAL_CONFIG = retrievalConfig\(\);/,
  "compose service must use bounded retrieval config",
);
assert.doesNotMatch(
  service,
  /Number\(process\.env\.(EMBEDDING_RECENCY_|RETRIEVAL_EMPTY_COSINE_THRESHOLD)/,
  "compose service must not parse retrieval env directly",
);

assert.match(
  routes,
  /const tuning = retrievalConfig\(\);/,
  "debug retrieval route must report bounded tuning",
);
assert.doesNotMatch(
  routes,
  /Number\(process\.env\.EMBEDDING_RECENCY_/,
  "debug retrieval route must not parse recency env directly",
);

assert.match(
  pkg,
  /retrieval-config\.contract\.test\.ts/,
  "contract suite must include retrieval config hardening",
);

console.log("retrieval-config.contract.test.ts: OK");
