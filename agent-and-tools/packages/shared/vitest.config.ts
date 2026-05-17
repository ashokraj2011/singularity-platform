import { defineConfig } from "vitest/config";

/**
 * M35.5 — vitest config for @agentandtools/shared.
 *
 * The shared package is the single source of truth for the LLM gateway
 * client contract and the assertProductionSecret helper. Both are exercised
 * here so regressions in the contract surface immediately.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    testTimeout: 10_000,
  },
});
