import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedCallerBearer } from "../../_proxy";

export const dynamic = "force-dynamic";

// Write proxy for the LLM model catalog. Forwards to the gateway's
// POST/PUT/DELETE /llm/models, which persists to .singularity/llm-models.json
// (the file it reads) and hot-reloads its in-memory catalog. Writes ALWAYS
// require a verified caller (unlike the read at GET /api/llm-settings).

function gatewayBase(): string {
  return (process.env.LLM_GATEWAY_URL ?? process.env.LLM_GATEWAY_INTERNAL_URL ?? "http://llm-gateway:8001").replace(/\/+$/, "");
}

function gatewayHeaders(): HeadersInit {
  const bearer = process.env.LLM_GATEWAY_BEARER?.trim();
  return {
    "content-type": "application/json",
    ...(bearer ? { Authorization: bearer.startsWith("Bearer ") ? bearer : `Bearer ${bearer}` } : {}),
  };
}

async function forward(method: string, path: string, body?: unknown): Promise<NextResponse> {
  try {
    const res = await fetch(`${gatewayBase()}${path}`, {
      method,
      headers: gatewayHeaders(),
      cache: "no-store",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "gateway request failed" }, { status: 502 });
  }
}

// POST /api/llm-settings/models — add a model to the catalog
export async function POST(request: NextRequest): Promise<NextResponse> {
  const authFailure = await requireVerifiedCallerBearer(request, "LLM settings");
  if (authFailure) return authFailure;
  const body = await request.json().catch(() => ({}));
  return forward("POST", "/llm/models", body);
}

// PUT /api/llm-settings/models?id=<id> — edit a model
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const authFailure = await requireVerifiedCallerBearer(request, "LLM settings");
  if (authFailure) return authFailure;
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  const body = await request.json().catch(() => ({}));
  return forward("PUT", `/llm/models/${encodeURIComponent(id)}`, body);
}

// DELETE /api/llm-settings/models?id=<id> — remove a model
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const authFailure = await requireVerifiedCallerBearer(request, "LLM settings");
  if (authFailure) return authFailure;
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  return forward("DELETE", `/llm/models/${encodeURIComponent(id)}`);
}
