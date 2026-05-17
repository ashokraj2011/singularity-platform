/**
 * M35.5 — tests for M35.1 assertProductionSecret helper.
 *
 * Proves the production-class secret gate refuses to allow weak or
 * default secrets in NODE_ENV=production. Process.exit is captured via
 * a spy so the test doesn't actually kill the runner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { assertProductionSecret } from "../src/security/assert-production-secret";

let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
    throw new Error("__process_exit_called__");
  }) as never);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("assertProductionSecret / development env", () => {
  it("does not exit in NODE_ENV=development even with a weak secret", () => {
    expect(() =>
      assertProductionSecret({
        name: "JWT_SECRET",
        value: "weak",
        nodeEnv: "development",
      }),
    ).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not exit in NODE_ENV=test even with a default dev secret", () => {
    expect(() =>
      assertProductionSecret({
        name: "JWT_SECRET",
        value: "dev-secret-change-in-prod",
        nodeEnv: "test",
      }),
    ).not.toThrow();
  });
});

describe("assertProductionSecret / production env", () => {
  it("exits when the secret is unset", () => {
    expect(() =>
      assertProductionSecret({
        name: "JWT_SECRET",
        value: undefined,
        nodeEnv: "production",
      }),
    ).toThrow("__process_exit_called__");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when the secret matches a known dev default", () => {
    expect(() =>
      assertProductionSecret({
        name: "JWT_SECRET",
        value: "dev-secret-change-in-prod-min-32-chars!!",
        nodeEnv: "production",
      }),
    ).toThrow("__process_exit_called__");
  });

  it("exits when the secret is shorter than minLength", () => {
    expect(() =>
      assertProductionSecret({
        name: "JWT_SECRET",
        value: "short",
        nodeEnv: "production",
        minLength: 32,
      }),
    ).toThrow("__process_exit_called__");
  });

  it("does not exit when a strong random secret is provided", () => {
    expect(() =>
      assertProductionSecret({
        name: "JWT_SECRET",
        value: "a-strong-random-secret-that-is-32+-chars-long-and-unguessable",
        nodeEnv: "production",
      }),
    ).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("treats 'prod', 'staging', 'perf' as production-class too", () => {
    for (const env of ["prod", "staging", "perf"]) {
      expect(() =>
        assertProductionSecret({
          name: "TOKEN",
          value: "changeme",
          nodeEnv: env,
        }),
      ).toThrow("__process_exit_called__");
    }
  });

  it("honors the extraBadValues set", () => {
    expect(() =>
      assertProductionSecret({
        name: "TOKEN",
        value: "my-org-specific-leaked-default",
        nodeEnv: "production",
        extraBadValues: ["my-org-specific-leaked-default"],
      }),
    ).toThrow("__process_exit_called__");
  });
});
