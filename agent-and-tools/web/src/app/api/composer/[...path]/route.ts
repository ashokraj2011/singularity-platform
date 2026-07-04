import { NextRequest, NextResponse } from "next/server";
import { composerAuthFailure, composerAuthHeaders } from "../../prompt-workbench/_shared/composer";
import { platformServiceUrl } from "@/lib/platformServices";
import { readJsonish } from "../../_json";

export const dynamic = "force-dynamic";

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

function composerUrl(): string {
  return platformServiceUrl("prompt-composer");
}

async function proxyComposer(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const authFailure = await composerAuthFailure(request);
  if (authFailure) return authFailure;

  const params = await context.params;
  const path = (params.path ?? []).map(encodeURIComponent).join("/");
  const upstream = new URL(`${composerUrl()}/api/v1/${path}`);
  request.nextUrl.searchParams.forEach((value, key) => upstream.searchParams.append(key, value));

  const headers = composerAuthHeaders(request, { contentType: false });
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== "authorization") {
      headers.set(key, value);
    }
  });
  headers.set("host", upstream.host);

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
    cache: "no-store",
  };
  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = await request.arrayBuffer();
  }

  try {
    const res = await fetch(upstream, init);
    const responseHeaders = new Headers(res.headers);
    HOP_BY_HOP_HEADERS.forEach((header) => responseHeaders.delete(header));
    if (!res.ok) {
      const body = await readJsonish(res);
      if (!body.parseError) {
        return new NextResponse(body.raw, {
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders,
        });
      }
      return NextResponse.json(
        {
          code: "COMPOSER_UPSTREAM_ERROR",
          error: "composer proxy failed",
          detail: body.text || res.statusText,
          status: res.status,
          statusText: res.statusText,
          upstream: upstream.toString(),
        },
        { status: res.status || 502 },
      );
    }
    if (request.method !== "HEAD") {
      const body = await readJsonish(res);
      if (body.parseError) {
        return NextResponse.json(
          {
            code: "COMPOSER_INVALID_RESPONSE",
            error: "composer proxy returned invalid JSON",
            detail: body.text || res.statusText,
            status: res.status,
            statusText: res.statusText,
            upstream: upstream.toString(),
          },
          { status: 502 },
        );
      }
      return new NextResponse(body.raw, {
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
      });
    }
    return new NextResponse(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "composer proxy failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return proxyComposer(request, context);
}

export async function POST(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return proxyComposer(request, context);
}

export async function PUT(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return proxyComposer(request, context);
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return proxyComposer(request, context);
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return proxyComposer(request, context);
}
