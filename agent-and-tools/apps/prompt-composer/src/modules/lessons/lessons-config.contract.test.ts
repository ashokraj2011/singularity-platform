import assert from "node:assert/strict";
import { boundedIntEnv, boundedLessonTake, boundedNumberEnv, lessonConfig } from "./lessons.config";

const ORIGINAL_ENV = { ...process.env };

try {
  process.env.LESSON_SUPERSEDE_COSINE = "bad";
  process.env.LESSON_MAX_ACTIVE_PER_SCOPE = "0";
  process.env.LESSON_TOOL_MATCH_BOOST = "999";
  process.env.LESSON_RETRIEVAL_FLOOR = "-1";
  process.env.LESSONS_TOPK = "999";

  const invalid = lessonConfig();
  assert.equal(invalid.supersedeCosineThreshold, 0.85);
  assert.equal(invalid.maxActivePerScope, 20);
  assert.equal(invalid.toolMatchBoost, 1);
  assert.equal(invalid.retrievalFloor, 0.3);
  assert.equal(invalid.defaultTopK, 50);

  process.env.LESSON_SUPERSEDE_COSINE = "0.5";
  process.env.LESSON_MAX_ACTIVE_PER_SCOPE = "12";
  process.env.LESSON_TOOL_MATCH_BOOST = "0";
  process.env.LESSON_RETRIEVAL_FLOOR = "1";
  process.env.LESSONS_TOPK = "7";

  const valid = lessonConfig();
  assert.equal(valid.supersedeCosineThreshold, 0.5);
  assert.equal(valid.maxActivePerScope, 12);
  assert.equal(valid.toolMatchBoost, 0);
  assert.equal(valid.retrievalFloor, 1);
  assert.equal(valid.defaultTopK, 7);

  assert.equal(boundedNumberEnv("MISSING_TEST_NUMBER", 0.4, 0, 1), 0.4);
  assert.equal(boundedIntEnv("MISSING_TEST_INT", 3, 1, 10), 3);
  assert.equal(boundedLessonTake("bad", 4), 4);
  assert.equal(boundedLessonTake("0", 4), 4);
  assert.equal(boundedLessonTake("8.9", 4), 8);
  assert.equal(boundedLessonTake("999", 4), 50);
} finally {
  process.env = ORIGINAL_ENV;
}

console.log("prompt composer lesson config contract tests passed");
