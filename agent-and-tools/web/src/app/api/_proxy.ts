import { NextRequest, NextResponse } from "next/server";
import { iamApiBase } from "@/lib/platformServices";
import { boundedSecondsEnv } from "@/lib/serverEnvBounds";
import { jsonishMessage, readJsonish } from "./_json";
import { readVerifiedCaller, type VerifiedCaller } from "./_tenant";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const PROXY_AUTH_TIMEOUT_MS = boundedSecondsEnv("PLATFORM_WEB_PROXY_AUTH_TIMEOUT_SEC", 5, 1, 300) * 1000;

export function proxyHeaders(req: NextRequest, upstreamBase: string, defaultBearer?: string): Headers {
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("host", new URL(upstreamBase).host);
  if (!headers.has("authorization") && defaultBearer) {
    headers.set("authorization", `Bearer ${defaultBearer}`);
  }
  return headers;
}

export function requireCallerBearer(req: NextRequest, serviceName: string): NextResponse | null {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ") && auth.slice("Bearer ".length).trim()) return null;

  return NextResponse.json(
    {
      code: "AUTH_REQUIRED",
      message: `${serviceName} proxy requires caller authorization before Platform Web can use server-side service credentials.`,
    },
    { status: 401 },
  );
}

function callerBearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token || null;
}

function authInvalid(serviceName: string, message: string, status = 401): NextResponse {
  return NextResponse.json(
    {
      code: status === 401 ? "AUTH_INVALID" : "AUTH_VERIFY_UNAVAILABLE",
      message: `${serviceName} proxy could not verify caller authorization: ${message}`,
    },
    { status },
  );
}

function isUserLike(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : undefined;
  return Boolean(record.id || record.user_id || record.sub) && (!kind || kind === "user");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * The outcome of verifying a caller: either a failure response, or the identity
 * IAM vouched for.
 *
 * `caller` can be null on success — the `/me` fallback below identifies a user
 * but IAM's MeResponse does not populate `tenant_ids`, so a caller verified that
 * way carries no tenant. Consumers must handle "verified but unscopable" rather
 * than assuming success implies a tenant.
 */
export type VerifiedCallerResult =
  | { response: NextResponse; caller: null }
  | { response: null; caller: VerifiedCaller | null };

/**
 * Verifies the caller's bearer token against IAM and RETURNS the resulting
 * identity.
 *
 * `requireVerifiedCallerBearer` below is the long-standing entry point and
 * discards this identity; it stays as a thin wrapper so the dozen-odd routes
 * that only care about the failure case are untouched. Routes that need to know
 * WHO called — to scope a downstream read to their tenant — call this instead.
 */
export async function verifyCallerBearer(req: NextRequest, serviceName: string): Promise<VerifiedCallerResult> {
  const required = requireCallerBearer(req, serviceName);
  if (required) return { response: required, caller: null };

  const token = callerBearerToken(req);
  if (!token) return { response: authInvalid(serviceName, "missing bearer token"), caller: null };

  const base = iamApiBase();
  const serviceToken = process.env.IAM_SERVICE_TOKEN?.trim();
  if (serviceToken) {
    try {
      const verify = await fetch(`${base}/auth/verify`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: serviceToken.startsWith("Bearer ") ? serviceToken : `Bearer ${serviceToken}`,
        },
        body: JSON.stringify({ token }),
        cache: "no-store",
        signal: AbortSignal.timeout(PROXY_AUTH_TIMEOUT_MS),
      });
      if (verify.ok) {
        const verifyBody = await readJsonish(verify);
        if (verifyBody.parseError || !isRecord(verifyBody.data)) {
          return {
            response: authInvalid(
              serviceName,
              `IAM verify returned an invalid response: ${verifyBody.text || verify.statusText || "empty body"}`,
              503,
            ),
            caller: null,
          };
        }
        const body = verifyBody.data as { valid?: boolean; user?: unknown; reason?: string };
        // The primary path, and the only one that yields tenants: IAM's
        // VerifyResponse.user is TokenUserOut, which carries `tenant_ids`.
        if (body?.valid && isUserLike(body.user)) {
          return { response: null, caller: readVerifiedCaller(body.user) };
        }
        return { response: authInvalid(serviceName, jsonishMessage(body, "IAM rejected token")), caller: null };
      }
      if (verify.status === 401 || verify.status === 403) {
        return {
          response: authInvalid(serviceName, `IAM verify rejected platform service token (${verify.status})`, 503),
          caller: null,
        };
      }
    } catch {
      // Fall through to /me validation with the caller token.
    }
  }

  try {
    const me = await fetch(`${base}/me`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(PROXY_AUTH_TIMEOUT_MS),
    });
    if (me.status === 401 || me.status === 403) {
      return { response: authInvalid(serviceName, `IAM rejected token (${me.status})`), caller: null };
    }
    const meBody = await readJsonish(me);
    if (!me.ok) {
      return {
        response: authInvalid(serviceName, jsonishMessage(meBody.data, `IAM /me returned ${me.status}`), 503),
        caller: null,
      };
    }
    if (meBody.parseError) {
      return {
        response: authInvalid(
          serviceName,
          `IAM /me returned an invalid response: ${meBody.text || me.statusText || "empty body"}`,
          503,
        ),
        caller: null,
      };
    }
    const user = meBody.data;
    if (!isUserLike(user)) {
      return { response: authInvalid(serviceName, "IAM response did not identify a user"), caller: null };
    }
    // Authenticated, but NOT tenant-bearing: IAM's `/me` builds a MeResponse
    // without passing tenant_ids (singularity-iam-service/app/main.py), so the
    // field falls back to its empty default. A caller verified down this path
    // resolves to no tenant rather than a wrong one.
    return { response: null, caller: readVerifiedCaller(user) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "IAM verification failed";
    return { response: authInvalid(serviceName, message, 503), caller: null };
  }
}

/**
 * Back-compatible wrapper: failure response or null, identity discarded.
 * Prefer `verifyCallerBearer` in new code.
 */
export async function requireVerifiedCallerBearer(req: NextRequest, serviceName: string): Promise<NextResponse | null> {
  return (await verifyCallerBearer(req, serviceName)).response;
}

export async function proxyRequest(
  req: NextRequest,
  upstreamUrl: string,
  headers: Headers,
  options: { normalizeTextErrors?: boolean } = {},
): Promise<NextResponse> {
  try {
    const init: RequestInit = {
      method: req.method,
      headers,
      redirect: "manual",
    };
    if (!["GET", "HEAD"].includes(req.method)) {
      // Read from a clone so callers can still retry the same NextRequest
      // (for example, Workgraph service-token fallback after an upstream 401).
      init.body = await req.clone().arrayBuffer();
    }

    const res = await fetch(upstreamUrl, init);
    const responseHeaders = new Headers(res.headers);
    HOP_BY_HOP_HEADERS.forEach((key) => responseHeaders.delete(key));

    const normalizeErrors = options.normalizeTextErrors ?? true;
    const contentType = res.headers.get("content-type") ?? "";
    if (normalizeErrors && !res.ok) {
      const text = await res.text();
      if (contentType.includes("json")) {
        try {
          JSON.parse(text);
          return new NextResponse(text, {
            status: res.status,
            statusText: res.statusText,
            headers: responseHeaders,
          });
        } catch {
          // Fall through to a Platform Web JSON envelope. A few upstreams return
          // text/plain or invalid JSON for 500s; client pages should never crash
          // while parsing an error response.
        }
      }
      return NextResponse.json(
        {
          code: "UPSTREAM_ERROR",
          message: text.trim().slice(0, 500) || res.statusText || "Upstream request failed",
          status: res.status,
          statusText: res.statusText,
          upstream: upstreamUrl,
        },
        { status: res.status || 502 },
      );
    }

    return new NextResponse(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return NextResponse.json(
      {
        code: "UPSTREAM_UNREACHABLE",
        message: (err as Error).message,
        upstream: upstreamUrl,
      },
      { status: 502 },
    );
  }
}
