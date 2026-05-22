/**
 * M57 — extractLlmOpenQuestions parser robustness.
 *
 * The Design stage with claude-haiku-4-5 emitted a markdown TABLE under
 * "Open Questions:". The original parser stripped leading bullets but
 * not pipes, so every table row became a phantom "question" in the
 * workbench's Clarification modal. This test pins the corrected
 * behaviour so a future regression that re-exposes the table-row path
 * fails loudly.
 *
 * The function is pure (string in → array out); the test imports it
 * directly without touching prisma/auth.
 */
import { describe, it, expect } from "vitest";

// Import via the router module. Because the function is a named export
// the test runtime doesn't need a live DB for prisma — prisma is loaded
// lazily by the route handlers, not by the helper itself.
//
// If this import ever becomes heavy, lift extractLlmOpenQuestions into
// a tiny lib/parsers.ts module.
import { extractLlmOpenQuestions } from "../src/modules/blueprint/blueprint.router";

// LoopStageDefinition / StageAttempt minimal stand-ins — the function
// only reads stage.key, attempt.id, attempt.attemptNumber.
const stage = { key: "design", label: "Design", required: true } as Parameters<typeof extractLlmOpenQuestions>[1];
const attempt = { id: "att-1", attemptNumber: 1 } as Parameters<typeof extractLlmOpenQuestions>[2];

describe("M57 extractLlmOpenQuestions — parser robustness", () => {
  it("happy path: returns the 2 bulleted questions OpenAI-style runs emit", () => {
    const response = [
      "## Open Questions",
      "",
      "- Should the operator be case-insensitive by default?",
      "- What's the expected behaviour for null input strings?",
      "",
    ].join("\n");
    const out = extractLlmOpenQuestions(response, stage, attempt);
    expect(out).toHaveLength(2);
    expect(out[0].question).toMatch(/case-insensitive/);
    expect(out[1].question).toMatch(/null input strings/);
  });

  it("rejects a markdown status table (Claude-style emission) entirely", () => {
    const response = [
      "## Open Questions",
      "",
      "| Assumption | Rationale | Validation |",
      "|------------|------------|------------|",
      "| Operator enum already registered | Confirmed in snapshot (WRK-984AD) | ✓ Verified |",
      "| First character only for multi-char input | Aligns with operator name (singular \"Character\") | Developer stage: add unit test |",
      "",
    ].join("\n");
    const out = extractLlmOpenQuestions(response, stage, attempt);
    expect(out).toHaveLength(0);
  });

  it("mixes — table rows are dropped but real bullets survive", () => {
    const response = [
      "## Open Questions",
      "",
      "| Topic | Decision |",
      "|-------|----------|",
      "| Locale | English-only for v1 |",
      "",
      "- Should we cache the compiled regex across calls?",
      "- Is async safety required?",
      "",
    ].join("\n");
    const out = extractLlmOpenQuestions(response, stage, attempt);
    expect(out).toHaveLength(2);
    expect(out[0].question).toMatch(/cache the compiled regex/);
    expect(out[1].question).toMatch(/async safety/);
  });

  it("rejects degenerate separator-only rows", () => {
    const response = [
      "## Clarifications",
      "",
      "|---|---|---|",
      "|:---|:---:|---:|",
      "|     |     |",
      "",
    ].join("\n");
    expect(extractLlmOpenQuestions(response, stage, attempt)).toHaveLength(0);
  });

  it("requires at least one 4+ letter word (defends against punctuation-only lines that slip past)", () => {
    const response = [
      "## Open Questions",
      "",
      "- ???",
      "- !!!  ----  ::::",
      "- a b c d e f g h i j k l",  // 12+ chars but no real word
      "- Should we support unicode?",
      "",
    ].join("\n");
    const out = extractLlmOpenQuestions(response, stage, attempt);
    expect(out).toHaveLength(1);
    expect(out[0].question).toMatch(/unicode/);
  });

  it("returns empty when section heading is missing", () => {
    const response = "Just some prose with no recognised heading.";
    expect(extractLlmOpenQuestions(response, stage, attempt)).toHaveLength(0);
  });

  it("preserves the existing 'no open questions' / 'none' / 'n/a' filtering", () => {
    const response = [
      "## Open Questions",
      "",
      "- None.",
      "- n/a",
      "- No open questions at this time.",
      "- Should we add metrics?",
      "",
    ].join("\n");
    const out = extractLlmOpenQuestions(response, stage, attempt);
    expect(out).toHaveLength(1);
    expect(out[0].question).toMatch(/metrics/);
  });

  it("caps at 12 questions to avoid runaway lists", () => {
    const bullets = Array.from({ length: 30 }, (_, i) => `- Should we support feature ${i}?`).join("\n");
    const response = `## Open Questions\n\n${bullets}\n`;
    const out = extractLlmOpenQuestions(response, stage, attempt);
    expect(out).toHaveLength(12);
  });
});
