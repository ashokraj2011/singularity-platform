import { defineConfig } from "vitest/config";

/**
 * M35.5 — vitest config for workgraph-api.
 *
 * Tests live in test/ at the repo root. JWT_SECRET and DATABASE_URL must be
 * set for module imports to succeed (config.ts gates them). The test script
 * sets sentinel values automatically; integration tests that need a live
 * Postgres should check process.env.TEST_DATABASE_URL and skip otherwise.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "prisma/**"],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.test.ts",
        "src/index.ts",
        "src/lib/observability/**", // OTel boot, hard to unit-test
      ],
    },
  },
});
