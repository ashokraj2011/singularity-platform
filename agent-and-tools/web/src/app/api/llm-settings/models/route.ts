import { NextRequest, NextResponse } from "next/server";
import { jsonishMessage, readJsonish, readRequestJson } from "../../_json";
import { requireVerifiedCallerBearer } from "../../_proxy";
import { configuredPlatformServiceUrl, serviceBearerHeaders } from "@/lib/platformServices";

export const dynamic = "force-dynamic";

// Write proxy for the LLM model catalog. Forwards to the gateway's
// POST/PUT/DELETE /llm/models, which persists to .singularity/llm-models.json
// (the file it reads) and hot-reloads its in-memory catalog. Writes ALWAYS
// require a verified caller (unlike the read at GET /api/llm-settings).

function gatewayBase(): string {
  return configuredPlatformServiceUrl("llm-gateway", "LLM_GATEWAY_INTERNAL_URL") ?? "";
}

function gatewayHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    ...serviceBearerHeaders("llm-gateway"),
  };
}

async function forward(method: string, path: string, body?: unknown): Promise<NextResponse> {
  const base = gatewayBase();
  if (!base) {
    return NextResponse.json({ error: "LLM Gateway is not configured for model catalog writes." }, { status: 503 });
  }
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: gatewayHeaders(),
      cache: "no-store",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const responseBody = await readJsonish(res);
    if (!res.ok) {
      return NextResponse.json(
        {
          code: "LLM_GATEWAY_REQUEST_FAILED",
          message: jsonishMessage(responseBody.data, res.statusText || "LLM Gateway request failed"),
          status: res.status,
          details: responseBody.data,
        },
        { status: res.status || 502 },
      );
    }
    return NextResponse.json(responseBody.data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "gateway request failed" }, { status: 502 });
  }
}

// POST /api/llm-settings/models — add a model to the catalog
export async function POST(request: NextRequest): Promise<NextResponse> {
  const authFailure = await requireVerifiedCallerBearer(request, "LLM settings");
  if (authFailure) return authFailure;
  const requestBody = await readRequestJson(request);
  if (requestBody.parseError) {
    return NextResponse.json({ code: "INVALID_JSON", message: "Request body must be valid JSON.", detail: requestBody.text }, { status: 400 });
  }
  const body = requestBody.data && typeof requestBody.data === "object" && !Array.isArray(requestBody.data) ? requestBody.data : {};
  return forward("POST", "/llm/models", body);
}

// PUT /api/llm-settings/models?id=<id> — edit a model
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const authFailure = await requireVerifiedCallerBearer(request, "LLM settings");
  if (authFailure) return authFailure;
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  const requestBody = await readRequestJson(request);
  if (requestBody.parseError) {
    return NextResponse.json({ code: "INVALID_JSON", message: "Request body must be valid JSON.", detail: requestBody.text }, { status: 400 });
  }
  const body = requestBody.data && typeof requestBody.data === "object" && !Array.isArray(requestBody.data) ? requestBody.data : {};
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
