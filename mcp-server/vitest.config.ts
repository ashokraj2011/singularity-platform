import { defineConfig } from "vitest/config";

/**
 * M35.5 — vitest config for mcp-server.
 *
 * Tests live in test/ at the repo root. The MCP_BEARER_TOKEN env var must be
 * present for module imports to succeed (config.ts gates it); the npm test
 * script sets a long-enough sentinel value automatically. LLM_GATEWAY_URL=mock
 * short-circuits llm calls to the in-process mock handler in the shared
 * llm-gateway client.
 *
 * Existing contract tests in src/lib/*.contract.test.ts are excluded from
 * this glob to keep them on their existing ts-node runner (run via
 * `pnpm test:contracts`). They migrate later in M36.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: [
      "node_modules/**",
      "dist/**",
      "src/**/*.contract.test.ts", // legacy ts-node runner
    ],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.test.ts",
        "src/**/*.contract.test.ts",
        "src/cli/**", // CLI entry point, covered by smoke
        "src/index.ts",
      ],
    },
  },
});
