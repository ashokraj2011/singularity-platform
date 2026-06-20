/**
 * M35.5 — tests for M35.1 assertProductionSecret helper.
 *
 * Proves the production-class secret gate refuses to allow weak or
 * default secrets in NODE_ENV=production. Process.exit is captured via
 * a spy so the test doesn't actually kill the runner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { assertProductionInvariant, assertProductionSecret, isProductionClassEnv } from "../src/security/assert-production-secret";

let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let originalAppEnv: string | undefined;
let originalEnvironment: string | undefined;
let originalSingularityEnv: string | undefined;

beforeEach(() => {
  originalAppEnv = process.env.APP_ENV;
  originalEnvironment = process.env.ENVIRONMENT;
  originalSingularityEnv = process.env.SINGULARITY_ENV;
  delete process.env.APP_ENV;
  delete process.env.ENVIRONMENT;
  delete process.env.SINGULARITY_ENV;
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
    throw new Error("__process_exit_called__");
  }) as never);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (originalAppEnv === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = originalAppEnv;
  if (originalEnvironment === undefined) delete process.env.ENVIRONMENT; else process.env.ENVIRONMENT = originalEnvironment;
  if (originalSingularityEnv === undefined) delete process.env.SINGULARITY_ENV; else process.env.SINGULARITY_ENV = originalSingularityEnv;
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

  it("classifies production-like env names", () => {
    expect(isProductionClassEnv("production")).toBe(true);
    expect(isProductionClassEnv("staging")).toBe(true);
    expect(isProductionClassEnv("development")).toBe(false);
  });

  it("treats platform env flags as production-class even when NODE_ENV stays development", () => {
    process.env.SINGULARITY_ENV = "production";
    expect(isProductionClassEnv("development")).toBe(true);
    expect(() =>
      assertProductionSecret({
        name: "JWT_SECRET",
        value: "changeme",
        nodeEnv: "development",
      }),
    ).toThrow("__process_exit_called__");
  });

  it("exits when a production invariant is false", () => {
    expect(() =>
      assertProductionInvariant({
        name: "AUTH_OPTIONAL",
        ok: false,
        message: "set AUTH_OPTIONAL=false",
        nodeEnv: "production",
      }),
    ).toThrow("__process_exit_called__");
  });

  it("does not exit for failed invariants in development", () => {
    expect(() =>
      assertProductionInvariant({
        name: "AUTH_OPTIONAL",
        ok: false,
        message: "set AUTH_OPTIONAL=false",
        nodeEnv: "development",
      }),
    ).not.toThrow();
  });
});
