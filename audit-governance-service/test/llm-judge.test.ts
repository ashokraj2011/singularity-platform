/**
 * M74 Phase 2A — llm_judge unit tests.
 *
 * Covers:
 *   • Rubric resolution: catalog hit, alias lookup, override, fallback
 *   • Helpers: extractJsonObject, clampScore, buildUserPrompt
 *   • runJudge: happy path, gateway down (fail closed + fail open),
 *     gateway non-2xx, malformed JSON response, score below threshold
 *
 * The gateway is mocked at fetch — vitest's vi.fn replaces global fetch,
 * each test gives the response shape it wants back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __test_internals,
  runJudge,
  type JudgeInput,
} from "../src/engine/llm-judge";
import {
  getRubricForStageType,
  listRubricStageTypes,
} from "../src/engine/rubrics";

const { extractJsonObject, clampScore, resolveRubric, buildUserPrompt } = __test_internals;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

function mockGatewayResponse(opts: {
  status?: number;
  body?: unknown;
  reject?: Error;
  rawText?: string;
}) {
  const mock = vi.fn();
  if (opts.reject) {
    mock.mockRejectedValue(opts.reject);
  } else {
    mock.mockResolvedValue({
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      json: async () => opts.body,
      text: async () => opts.rawText ?? JSON.stringify(opts.body ?? ""),
    });
  }
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

// ── rubric catalog ──────────────────────────────────────────────────────────

describe("rubrics catalog", () => {
  it("returns a spec for each known stage type", () => {
    for (const key of listRubricStageTypes()) {
      const spec = getRubricForStageType(key);
      expect(spec).not.toBeNull();
      expect(spec?.source).toBe("catalog");
      expect(spec?.stageType).toBe(key);
      expect(spec?.text.length).toBeGreaterThan(50);
    }
  });

  it("resolves common aliases", () => {
    expect(getRubricForStageType("dev")?.stageType).toBe("developer");
    expect(getRubricForStageType("engineer")?.stageType).toBe("developer");
    expect(getRubricForStageType("DEV")?.stageType).toBe("developer");
    expect(getRubricForStageType("quality")?.stageType).toBe("qa");
    expect(getRubricForStageType("PRODUCT-OWNER")?.stageType).toBe("product_owner");
  });

  it("returns null for unknown stage types", () => {
    expect(getRubricForStageType("data_science")).toBeNull();
    expect(getRubricForStageType("")).toBeNull();
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

describe("extractJsonObject", () => {
  it("parses a clean JSON object", () => {
    const out = extractJsonObject('{"score": 4, "reason": "good"}');
    expect(out).toEqual({ score: 4, reason: "good" });
  });

  it("extracts the first {...} from text with surrounding prose", () => {
    const out = extractJsonObject(
      'Here is my judgement:\n\n{"score": 5, "reason": "great"}\n\nThanks.',
    );
    expect(out?.score).toBe(5);
  });

  it("returns null when there's no JSON", () => {
    expect(extractJsonObject("just some words")).toBeNull();
  });

  it("returns null when JSON lacks a numeric score", () => {
    expect(extractJsonObject('{"reason": "ok"}')).toBeNull();
    expect(extractJsonObject('{"score": "five"}')).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(extractJsonObject('{"score": 4, "reason":')).toBeNull();
  });
});

describe("clampScore", () => {
  it("rounds and clamps to 1..5", () => {
    expect(clampScore(3.4)).toBe(3);
    expect(clampScore(3.6)).toBe(4);
    expect(clampScore(0)).toBe(1);
    expect(clampScore(-2)).toBe(1);
    expect(clampScore(7)).toBe(5);
  });

  it("returns 0 for non-finite", () => {
    expect(clampScore(NaN)).toBe(0);
    expect(clampScore(Infinity)).toBe(0);
  });
});

describe("resolveRubric", () => {
  it("prefers explicit rubric_text over catalog", () => {
    const r = resolveRubric({
      rubricText: "custom rubric body",
      stageType: "developer",
      expected: "",
      actual: "",
    });
    expect(r.source).toBe("config");
    expect(r.text).toBe("custom rubric body");
  });

  it("falls back to catalog when no rubric_text", () => {
    const r = resolveRubric({ stageType: "qa", expected: "", actual: "" });
    expect(r.source).toBe("catalog");
    expect(r.stageType).toBe("qa");
  });

  it("falls back to generic when stage_type is unknown", () => {
    const r = resolveRubric({ stageType: "alchemy", expected: "", actual: "" });
    expect(r.source).toBe("fallback-generic");
  });

  it("falls back to generic when stage_type is missing", () => {
    const r = resolveRubric({ expected: "", actual: "" });
    expect(r.source).toBe("fallback-generic");
  });
});

describe("buildUserPrompt", () => {
  it("includes all three sections labelled", () => {
    const out = buildUserPrompt("RUBRIC_X", "EXPECTED_X", "ACTUAL_X");
    expect(out).toMatch(/RUBRIC:/);
    expect(out).toMatch(/EXPECTED OUTPUT/);
    expect(out).toMatch(/ACTUAL OUTPUT/);
    expect(out).toContain("RUBRIC_X");
    expect(out).toContain("EXPECTED_X");
    expect(out).toContain("ACTUAL_X");
  });

  it("renders empty actual/expected with placeholder", () => {
    const out = buildUserPrompt("R", "", "");
    expect(out).toContain("(none provided)");
  });
});

// ── runJudge end-to-end (with mocked fetch) ────────────────────────────────

const BASE_INPUT: JudgeInput = {
  stageType: "developer",
  expected: "A correct implementation",
  actual: "function impl() { return 42 }",
};

describe("runJudge happy path", () => {
  it("scores >= threshold → passed=true with judge reason", async () => {
    mockGatewayResponse({
      body: {
        content: '{"score": 4, "reason": "diff handles main case; minor style issues"}',
        finish_reason: "stop",
        provider: "openai",
        model: "gpt-4o-mini",
      },
    });
    const out = await runJudge(BASE_INPUT);
    expect(out.passed).toBe(true);
    expect(out.score).toBe(4);
    expect(out.reason).toContain("judge passed");
    expect(out.reason).toContain("diff handles main case");
    expect(out.evidence.judge_status).toBe("ran");
    expect(out.evidence.rubric_source).toBe("catalog");
    expect(out.evidence.stage_type).toBe("developer");
  });

  it("score < threshold → passed=false", async () => {
    mockGatewayResponse({
      body: {
        content: '{"score": 2, "reason": "missing acceptance criterion N"}',
        finish_reason: "stop",
      },
    });
    const out = await runJudge({ ...BASE_INPUT, threshold: 3 });
    expect(out.passed).toBe(false);
    expect(out.score).toBe(2);
    expect(out.reason).toContain("judge failed");
    expect(out.reason).toContain("missing acceptance criterion N");
  });

  it("custom threshold respected", async () => {
    mockGatewayResponse({
      body: { content: '{"score": 4, "reason": "ok"}', finish_reason: "stop" },
    });
    const strict = await runJudge({ ...BASE_INPUT, threshold: 5 });
    expect(strict.passed).toBe(false);
    expect(strict.score).toBe(4);
  });
});

describe("runJudge failure paths", () => {
  it("gateway unreachable + fail_mode='closed' → passed=false", async () => {
    mockGatewayResponse({ reject: new Error("ECONNREFUSED") });
    const out = await runJudge({ ...BASE_INPUT, failMode: "closed" });
    expect(out.passed).toBe(false);
    expect(out.score).toBe(0);
    expect(out.reason).toContain("judge unavailable");
    expect(out.reason).toContain("failing closed");
    expect(out.evidence.judge_status).toBe("unavailable");
  });

  it("gateway unreachable + fail_mode='open' → passed=true", async () => {
    mockGatewayResponse({ reject: new Error("ECONNREFUSED") });
    const out = await runJudge({ ...BASE_INPUT, failMode: "open" });
    expect(out.passed).toBe(true);
    expect(out.reason).toContain("failing open");
  });

  it("gateway 5xx → fails closed by default", async () => {
    mockGatewayResponse({ status: 503, body: { error: "overloaded" } });
    const out = await runJudge(BASE_INPUT);
    expect(out.passed).toBe(false);
    expect(out.reason).toContain("gateway 503");
  });

  it("malformed JSON response → fails closed by default", async () => {
    mockGatewayResponse({
      body: { content: "I think it's pretty good but no JSON here", finish_reason: "stop" },
    });
    const out = await runJudge(BASE_INPUT);
    expect(out.passed).toBe(false);
    expect(out.reason).toContain("not parseable");
    expect(out.evidence.judge_status).toBe("malformed_response");
  });

  it("invalid gateway JSON envelope → fails closed by default", async () => {
    mockGatewayResponse({ rawText: "Internal Server Error" });
    const out = await runJudge(BASE_INPUT);
    expect(out.passed).toBe(false);
    expect(out.reason).toContain("gateway returned non-JSON");
    expect(out.reason).toContain("invalid JSON");
    expect(out.evidence.judge_status).toBe("unavailable");
  });

  it("malformed JSON + fail_mode='open' → passes with warning", async () => {
    mockGatewayResponse({
      body: { content: "no JSON", finish_reason: "stop" },
    });
    const out = await runJudge({ ...BASE_INPUT, failMode: "open" });
    expect(out.passed).toBe(true);
    expect(out.reason).toContain("not parseable");
  });

  it("score is clamped out of returned 1..5 range", async () => {
    mockGatewayResponse({
      body: { content: '{"score": 9, "reason": "great"}', finish_reason: "stop" },
    });
    const out = await runJudge(BASE_INPUT);
    expect(out.score).toBe(5);
  });
});

describe("runJudge gateway request shape", () => {
  it("posts to /v1/chat/completions with messages+temperature=0", async () => {
    const mock = mockGatewayResponse({
      body: { content: '{"score": 5, "reason": "ok"}', finish_reason: "stop" },
    });
    await runJudge(BASE_INPUT);
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toMatch(/\/v1\/chat\/completions$/);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.temperature).toBe(0);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(body.trace_id).toMatch(/^audit-gov-judge-/);
  });

  it("includes rubric text in the user prompt", async () => {
    const mock = mockGatewayResponse({
      body: { content: '{"score": 4, "reason": "ok"}', finish_reason: "stop" },
    });
    await runJudge({ ...BASE_INPUT, rubricText: "MY_CUSTOM_RUBRIC_BODY" });
    const body = JSON.parse((mock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[1].content).toContain("MY_CUSTOM_RUBRIC_BODY");
  });

  it("omits model_alias when not configured (gateway picks default)", async () => {
    const mock = mockGatewayResponse({
      body: { content: '{"score": 5, "reason": "ok"}', finish_reason: "stop" },
    });
    await runJudge({ ...BASE_INPUT, modelAlias: "" });
    const body = JSON.parse((mock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model_alias).toBeUndefined();
  });
});
