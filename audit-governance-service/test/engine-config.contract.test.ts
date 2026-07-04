import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Audit Governance engine env config contract", () => {
  it("bounds LLM judge timeout config", () => {
    const source = read("src/engine/llm-judge.ts");

    expect(source).toContain('boundedEnvInteger("JUDGE_TIMEOUT_MS"');
    expect(source).toContain("defaultValue: 30_000");
    expect(source).toContain("max: 300_000");
    expect(source).not.toContain("parseInt(process.env.JUDGE_TIMEOUT_MS");
  });

  it("bounds diagnosis LLM timeout and prompt cache TTL", () => {
    const source = read("src/engine/diagnose.ts");

    expect(source).toContain('boundedEnvInteger("ENGINE_TIMEOUT_MS"');
    expect(source).toContain("defaultValue: 120_000");
    expect(source).toContain("max: 600_000");
    expect(source).toContain('boundedEnvInteger("SYSTEM_PROMPT_CACHE_TTL_SEC"');
    expect(source).toContain("max: 86_400");
    expect(source).not.toContain("Number(process.env.ENGINE_TIMEOUT_MS");
    expect(source).not.toContain("Number(process.env.SYSTEM_PROMPT_CACHE_TTL_SEC");
  });

  it("bounds lesson extraction windows, timeout, and prompt cache TTL", () => {
    const source = read("src/engine/extract-lesson.ts");

    expect(source).toContain('boundedEnvInteger("LESSON_CONFIRM_WINDOW_SEC"');
    expect(source).toContain("defaultValue: 3_600");
    expect(source).toContain("max: 604_800");
    expect(source).toContain('boundedEnvInteger("LESSON_RETRY_LOOKBACK_HOURS"');
    expect(source).toContain("max: 168");
    expect(source).toContain('boundedEnvInteger("LESSON_EXTRACT_TIMEOUT_MS"');
    expect(source).toContain("defaultValue: 30_000");
    expect(source).toContain('boundedEnvInteger("SYSTEM_PROMPT_CACHE_TTL_SEC"');
    expect(source).not.toContain("Number(process.env.LESSON_CONFIRM_WINDOW_SEC");
    expect(source).not.toContain("Number(process.env.LESSON_RETRY_LOOKBACK_HOURS");
    expect(source).not.toContain("Number(process.env.LESSON_EXTRACT_TIMEOUT_MS");
    expect(source).not.toContain("Number(process.env.SYSTEM_PROMPT_CACHE_TTL_SEC");
  });

  it("bounds sweep interval and lookback window config", () => {
    const source = read("src/engine/sweep.ts");

    expect(source).toContain('boundedEnvInteger("ENGINE_SWEEP_INTERVAL_MS"');
    expect(source).toContain("defaultValue: 5 * 60_000");
    expect(source).toContain("max: 86_400_000");
    expect(source).toContain('boundedEnvInteger("ENGINE_SWEEP_WINDOW_MIN"');
    expect(source).toContain("max: 1_440");
    expect(source).not.toContain("Number(process.env.ENGINE_SWEEP_INTERVAL_MS");
    expect(source).not.toContain("Number(process.env.ENGINE_SWEEP_WINDOW_MIN");
  });
});
