import { defineConfig } from "vitest/config";

/**
 * M35.5 — vitest config for audit-governance-service.
 *
 * Test files live in test/ at the repo root. Integration tests that
 * need a live Postgres are skipped unless TEST_DATABASE_URL is set, so
 * `pnpm test` runs the pure-unit subset without infra.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    // Per-test timeout 10s; default 5s is too tight for the supertest
    // boot path on a cold Express import.
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.test.ts",
        "src/index.ts", // boot file; covered via integration tests
      ],
    },
  },
});
