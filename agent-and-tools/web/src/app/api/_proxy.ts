import { NextRequest, NextResponse } from "next/server";

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

function iamApiBase(): string {
  const raw = process.env.IAM_BASE_URL ?? process.env.IAM_SERVICE_URL ?? "http://iam-service:8100/api/v1";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
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
      });
      if (verify.ok) {
        const body = await verify.json().catch(() => null) as { valid?: boolean; user?: unknown; reason?: string } | null;
        if (body?.valid && isUserLike(body.user)) return null;
        return authInvalid(serviceName, body?.reason ?? "IAM rejected token");
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
    });
    if (me.status === 401 || me.status === 403) return authInvalid(serviceName, `IAM rejected token (${me.status})`);
    if (!me.ok) return authInvalid(serviceName, `IAM /me returned ${me.status}`, 503);
    const user = await me.json().catch(() => null);
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

    const contentType = res.headers.get("content-type") ?? "";
    if (options.normalizeTextErrors && !res.ok && !contentType.includes("json")) {
      const text = await res.text();
      return NextResponse.json(
        {
          code: "UPSTREAM_ERROR",
          message: text.trim().slice(0, 500) || res.statusText,
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
