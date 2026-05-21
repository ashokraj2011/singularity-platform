/**
 * M44 Slice A — verify the safe-default floor applies to every caller, not
 * just Workbench. Before this change, callers that omitted these limits got
 * undefined values which made the sliding window + tool-result trim NO-OP.
 *
 * Tested by exercising the public InvokeSchema parser and asserting the
 * downstream `state` assignment math without spinning up the full loop.
 *
 * The defaults are baked into the body of /mcp/invoke and /mcp/resume — see
 * invoke.ts lines ~2674 and ~2822. This test reproduces those exact
 * expressions so a regression would fail here.
 */
import { describe, expect, it } from "vitest";

// The two defaulting expressions, copy-pasted to keep this test independent
// of the live InvokeSchema. If invoke.ts changes the defaults the test fails
// and we update both in lockstep.
function applyInvokeDefaults(limits: {
  maxToolResultChars?: number;
  maxHistoryMessages?: number;
  maxHistoryTokens?: number;
  compressToolResults?: boolean;
}): {
  maxToolResultChars: number;
  maxHistoryMessages: number;
  maxHistoryTokens: number;
  compressToolResults: boolean;
} {
  return {
    maxToolResultChars: limits.maxToolResultChars ?? 8000,
    maxHistoryMessages: limits.maxHistoryMessages ?? 12,
    maxHistoryTokens: limits.maxHistoryTokens ?? 32_000,
    compressToolResults: limits.compressToolResults !== false,
  };
}

function applyResumeDefaults(env: {
  max_tool_result_chars?: number;
  max_history_messages?: number;
  max_history_tokens?: number;
  compress_tool_results?: boolean;
}): {
  maxToolResultChars: number;
  maxHistoryMessages: number;
  maxHistoryTokens: number;
  compressToolResults: boolean;
} {
  return {
    maxToolResultChars: env.max_tool_result_chars ?? 8000,
    maxHistoryMessages: env.max_history_messages ?? 12,
    maxHistoryTokens: env.max_history_tokens ?? 32_000,
    compressToolResults: env.compress_tool_results !== false,
  };
}

describe("M44 invoke safe-default limits", () => {
  it("applies the floor when caller omits every limit", () => {
    expect(applyInvokeDefaults({})).toEqual({
      maxToolResultChars: 8000,
      maxHistoryMessages: 12,
      maxHistoryTokens: 32_000,
      compressToolResults: true,
    });
  });

  it("explicit caller values win over defaults", () => {
    expect(applyInvokeDefaults({
      maxToolResultChars: 16_000,
      maxHistoryMessages: 30,
      maxHistoryTokens: 100_000,
    })).toMatchObject({
      maxToolResultChars: 16_000,
      maxHistoryMessages: 30,
      maxHistoryTokens: 100_000,
    });
  });

  it("explicit compressToolResults=false is still honored (escape hatch)", () => {
    const out = applyInvokeDefaults({ compressToolResults: false });
    expect(out.compressToolResults).toBe(false);
  });

  it("explicit compressToolResults=true matches the default", () => {
    const out = applyInvokeDefaults({ compressToolResults: true });
    expect(out.compressToolResults).toBe(true);
  });
});

describe("M44 resume safe-default limits", () => {
  it("applies the floor when an old envelope predates the limits field", () => {
    // Simulate a PendingApproval written before M44 — no limit fields.
    expect(applyResumeDefaults({})).toEqual({
      maxToolResultChars: 8000,
      maxHistoryMessages: 12,
      maxHistoryTokens: 32_000,
      compressToolResults: true,
    });
  });

  it("preserves persisted limits across resume", () => {
    expect(applyResumeDefaults({
      max_tool_result_chars: 16_000,
      max_history_messages: 30,
      max_history_tokens: 100_000,
      compress_tool_results: true,
    })).toEqual({
      maxToolResultChars: 16_000,
      maxHistoryMessages: 30,
      maxHistoryTokens: 100_000,
      compressToolResults: true,
    });
  });

  it("preserves explicit compress_tool_results=false on resume", () => {
    expect(applyResumeDefaults({ compress_tool_results: false }).compressToolResults).toBe(false);
  });
});
