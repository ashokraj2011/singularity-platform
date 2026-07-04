import { NextRequest, NextResponse } from "next/server";
import { iamApiBase } from "@/lib/platformServices";
import { boundedSecondsEnv } from "@/lib/serverEnvBounds";
import { jsonishMessage, readJsonish } from "./_json";

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

export async function requireVerifiedCallerBearer(req: NextRequest, serviceName: string): Promise<NextResponse | null> {
  const required = requireCallerBearer(req, serviceName);
  if (required) return required;

  const token = callerBearerToken(req);
  if (!token) return authInvalid(serviceName, "missing bearer token");

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
          return authInvalid(
            serviceName,
            `IAM verify returned an invalid response: ${verifyBody.text || verify.statusText || "empty body"}`,
            503,
          );
        }
        const body = verifyBody.data as { valid?: boolean; user?: unknown; reason?: string };
        if (body?.valid && isUserLike(body.user)) return null;
        return authInvalid(serviceName, jsonishMessage(body, "IAM rejected token"));
      }
      if (verify.status === 401 || verify.status === 403) {
        return authInvalid(serviceName, `IAM verify rejected platform service token (${verify.status})`, 503);
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
    if (me.status === 401 || me.status === 403) return authInvalid(serviceName, `IAM rejected token (${me.status})`);
    const meBody = await readJsonish(me);
    if (!me.ok) return authInvalid(serviceName, jsonishMessage(meBody.data, `IAM /me returned ${me.status}`), 503);
    if (meBody.parseError) {
      return authInvalid(
        serviceName,
        `IAM /me returned an invalid response: ${meBody.text || me.statusText || "empty body"}`,
        503,
      );
    }
    const user = meBody.data;
    if (!isUserLike(user)) return authInvalid(serviceName, "IAM response did not identify a user");
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : "IAM verification failed";
    return authInvalid(serviceName, message, 503);
  }
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
