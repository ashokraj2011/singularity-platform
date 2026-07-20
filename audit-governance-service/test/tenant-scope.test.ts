/**
 * Contract: the audit / cost query surface is tenant-scoped, fail-closed.
 *
 * The bug this pins shut was not a missing filter on one endpoint — it was a
 * SHAPE. `($2::text IS NULL OR tenant_id = $2)` made "no tenant supplied" mean
 * "every tenant", so the safe default was the unsafe behaviour and every new
 * endpoint on the router inherited it. Two endpoints took no tenant parameter
 * at all and so could not be scoped even deliberately.
 *
 * The load-bearing assertions are therefore the negative ones: that the
 * fail-open shape does not come back, and that scope cannot be widened by
 * omitting something.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Request } from "express";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function reqWith(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}

/** The module reads its token at import time, so a token change needs a fresh import. */
async function freshModule(crossTenantToken?: string) {
  vi.resetModules();
  if (crossTenantToken === undefined) delete process.env.AUDIT_GOV_CROSS_TENANT_TOKEN;
  else process.env.AUDIT_GOV_CROSS_TENANT_TOKEN = crossTenantToken;
  return import("../src/tenant-scope");
}

const ORIGINAL_TOKEN = process.env.AUDIT_GOV_CROSS_TENANT_TOKEN;

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.AUDIT_GOV_CROSS_TENANT_TOKEN;
  else process.env.AUDIT_GOV_CROSS_TENANT_TOKEN = ORIGINAL_TOKEN;
});

describe("tenant scope resolution", () => {
  it("refuses a request that names no tenant", async () => {
    const { resolveTenantScope } = await freshModule();
    const resolved = resolveTenantScope(reqWith({}));
    expect(resolved).toMatchObject({ status: 400 });
  });

  it("refuses a blank tenant header rather than treating it as absent-and-fine", async () => {
    const { resolveTenantScope } = await freshModule();
    expect(resolveTenantScope(reqWith({ "x-tenant-id": "   " }))).toMatchObject({ status: 400 });
  });

  it("scopes to the named tenant, trimmed", async () => {
    const { resolveTenantScope } = await freshModule();
    expect(resolveTenantScope(reqWith({ "x-tenant-id": " acme " })))
      .toEqual({ mode: "tenant", tenantId: "acme" });
  });

  it("refuses cross-tenant scope when no cross-tenant token is provisioned", async () => {
    // The default posture. Asking for everything must not be granted just
    // because the deployment never configured the wider credential.
    const { resolveTenantScope } = await freshModule(undefined);
    expect(resolveTenantScope(reqWith({ "x-tenant-scope": "all" }))).toMatchObject({ status: 403 });
  });

  it("refuses cross-tenant scope with a wrong token", async () => {
    const { resolveTenantScope } = await freshModule("right-token");
    expect(resolveTenantScope(reqWith({ "x-tenant-scope": "all", "x-cross-tenant-token": "wrong" })))
      .toMatchObject({ status: 403 });
  });

  it("grants cross-tenant scope only with the matching token", async () => {
    const { resolveTenantScope } = await freshModule("right-token");
    expect(resolveTenantScope(reqWith({ "x-tenant-scope": "all", "x-cross-tenant-token": "right-token" })))
      .toEqual({ mode: "all" });
  });

  it("does not let the general service token double as the cross-tenant token", async () => {
    // Distinct credentials is the entire point: every service holds the service
    // token, so if it also widened scope, scope would not be a control at all.
    const { resolveTenantScope } = await freshModule("cross-only");
    process.env.AUDIT_GOV_SERVICE_TOKEN = "service-token";
    expect(resolveTenantScope(reqWith({ "x-tenant-scope": "all", "x-cross-tenant-token": "service-token" })))
      .toMatchObject({ status: 403 });
  });

  it("ignores a tenant header when cross-tenant scope was granted", async () => {
    const { resolveTenantScope } = await freshModule("tok");
    expect(resolveTenantScope(reqWith({
      "x-tenant-scope": "all", "x-cross-tenant-token": "tok", "x-tenant-id": "acme",
    }))).toEqual({ mode: "all" });
  });
});

describe("requireTenantScope rollout modes", () => {
  function harness() {
    const statuses: number[] = [];
    const bodies: unknown[] = [];
    const res = {
      status(code: number) { statuses.push(code); return this; },
      json(body: unknown) { bodies.push(body); return this; },
    } as unknown as import("express").Response;
    let nexted = false;
    return { res, statuses, bodies, next: () => { nexted = true; }, called: () => nexted };
  }

  const ORIGINAL_MODE = process.env.AUDIT_GOV_REQUIRE_TENANT_SCOPE;
  afterEach(() => {
    if (ORIGINAL_MODE === undefined) delete process.env.AUDIT_GOV_REQUIRE_TENANT_SCOPE;
    else process.env.AUDIT_GOV_REQUIRE_TENANT_SCOPE = ORIGINAL_MODE;
    vi.restoreAllMocks();
  });

  it("defaults to shadow so the audit dashboard keeps working pre-migration", async () => {
    // No caller can send a tenant yet: platform-web sets no tenant header and
    // its proxy drops the verified IAM user. Enforcing on day one would 400 it.
    delete process.env.AUDIT_GOV_REQUIRE_TENANT_SCOPE;
    const { requireTenantScope } = await freshModule();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    const req = { headers: {}, method: "GET", originalUrl: "/api/v1/cost/summary" } as unknown as Request;
    requireTenantScope(req, h.res, h.next);

    expect(h.called()).toBe(true);
    expect(h.statuses).toEqual([]);
    expect(req.tenantScope).toEqual({ mode: "all" });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("names the offending route in the shadow warning", async () => {
    // The log is the migration to-do list; a warning without the path is useless.
    delete process.env.AUDIT_GOV_REQUIRE_TENANT_SCOPE;
    const { requireTenantScope } = await freshModule();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    requireTenantScope(
      { headers: {}, method: "GET", originalUrl: "/api/v1/cost/by-model?days=7" } as unknown as Request,
      h.res, h.next,
    );
    expect(String(warn.mock.calls[0]?.[0])).toContain("/api/v1/cost/by-model?days=7");
  });

  it("refuses an unscoped read once enforcing", async () => {
    process.env.AUDIT_GOV_REQUIRE_TENANT_SCOPE = "enforce";
    const { requireTenantScope } = await freshModule();
    const h = harness();
    requireTenantScope({ headers: {}, method: "GET", originalUrl: "/x" } as unknown as Request, h.res, h.next);

    expect(h.statuses).toEqual([400]);
    expect(h.called()).toBe(false);
  });

  it("passes a properly scoped request through identically in both modes", async () => {
    for (const mode of ["shadow", "enforce"]) {
      process.env.AUDIT_GOV_REQUIRE_TENANT_SCOPE = mode;
      const { requireTenantScope } = await freshModule();
      const h = harness();
      const req = { headers: { "x-tenant-id": "acme" }, method: "GET", originalUrl: "/x" } as unknown as Request;
      requireTenantScope(req, h.res, h.next);
      expect(h.called(), mode).toBe(true);
      expect(req.tenantScope, mode).toEqual({ mode: "tenant", tenantId: "acme" });
    }
  });

  it("still refuses an unauthorized cross-tenant claim in shadow mode", async () => {
    // Shadow relaxes "you forgot to say"; it must NOT relax "you asked for
    // everything without the credential" — that request is deliberate, not legacy.
    delete process.env.AUDIT_GOV_REQUIRE_TENANT_SCOPE;
    const { requireTenantScope } = await freshModule("real-token");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    requireTenantScope(
      { headers: { "x-tenant-scope": "all", "x-cross-tenant-token": "guess" }, method: "GET", originalUrl: "/x" } as unknown as Request,
      h.res, h.next,
    );
    expect(h.statuses).toEqual([403]);
    expect(h.called()).toBe(false);
  });
});

describe("scopeOf", () => {
  it("throws when the route was mounted without the middleware", async () => {
    // Defaulting to "all" here would silently reintroduce the original bug for
    // any future route someone forgets to gate.
    const { scopeOf } = await freshModule();
    expect(() => scopeOf(reqWith({}))).toThrow(/not behind requireTenantScope/);
  });
});

describe("tenantPredicate", () => {
  it("emits a bound parameter at the requested position", async () => {
    const { tenantPredicate } = await freshModule();
    expect(tenantPredicate({ mode: "tenant", tenantId: "acme" }, "tenant_id", 3))
      .toEqual({ sql: "tenant_id = $3", params: ["acme"] });
  });

  it("never inlines the tenant id into SQL", async () => {
    const { tenantPredicate } = await freshModule();
    const { sql } = tenantPredicate({ mode: "tenant", tenantId: "'; DROP TABLE llm_calls; --" }, "tenant_id", 1);
    expect(sql).toBe("tenant_id = $1");
  });

  it("consumes no parameters under cross-tenant scope", async () => {
    // Param numbering at the call sites depends on this being exactly zero.
    const { tenantPredicate } = await freshModule();
    expect(tenantPredicate({ mode: "all" }, "tenant_id", 1)).toEqual({ sql: "TRUE", params: [] });
  });
});

describe("query routes are scoped", () => {
  const source = read("src/routes-query.ts");

  it("mounts the middleware on the whole router", () => {
    expect(source).toContain("queryRouter.use(requireTenantScope)");
  });

  it("no longer accepts tenant as an optional query parameter", () => {
    // This is the regression that matters. Reading tenant from the query string
    // is what made omission equal to "all".
    expect(source).not.toMatch(/req\.query\.tenant_id/);
  });

  it("has no fail-open tenant predicate left anywhere", () => {
    expect(source).not.toMatch(/IS NULL OR tenant_id/);
  });

  it("scopes every endpoint that reads tenant-bearing rows", () => {
    for (const route of ["/audit/timeline", "/audit/events/:id", "/cost/rollup", "/cost/by-model", "/cost/summary"]) {
      const start = source.indexOf(`"${route}"`);
      expect(start, `${route} is missing`).toBeGreaterThan(-1);
      // Bound the slice at the next handler so a neighbour's scoping can't
      // satisfy this route's assertion.
      const nextHandler = source.indexOf("queryRouter.get", start + 1);
      const body = source.slice(start, nextHandler === -1 ? source.length : nextHandler);
      expect(body, `${route} does not resolve a scope`).toContain("scopeOf(req)");
    }
  });

  it("scopes /cost/summary's subselects, including the table with no tenant column", () => {
    // authz_decisions has no tenant_id; it can only be scoped through the
    // audit_event it references, and forgetting that would leave one unscoped
    // count in an otherwise scoped response.
    expect(source).toContain("e.id = d.audit_event_id AND e.tenant_id");
  });

  it("returns 404 rather than 403 for an out-of-scope event", () => {
    // 403 would confirm the id exists, turning the endpoint into an oracle for
    // another tenant's primary keys.
    const body = source.slice(source.indexOf('"/audit/events/:id"'));
    expect(body.slice(0, 900)).toContain('status(404)');
  });
});
