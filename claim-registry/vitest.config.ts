import { defineConfig } from "vitest/config";

// The posterior + maturity engines are pure (no DB, no clock), so unit tests run
// with no Postgres. Integration tests that need a live DB should check
// process.env.TEST_DATABASE_URL_CLAIM_REGISTRY and skip otherwise.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "prisma/**"],
  },
});
