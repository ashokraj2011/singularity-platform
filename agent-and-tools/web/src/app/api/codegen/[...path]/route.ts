import { NextRequest, NextResponse } from "next/server";
import { proxyHeaders, proxyRequest, requireVerifiedCallerBearer } from "../../_proxy";
import { platformWebCredentialError } from "@/lib/serverEnvGuard";

const FOUNDRY_API_URL = process.env.CODE_FOUNDRY_API_URL ?? "http://code-foundry-api:3005";

function foundryToken(): string {
  return process.env.FOUNDRY_TOKEN?.trim()
    || process.env.CODEGEN_SERVICE_TOKEN?.trim()
    || "dev-codegen-service-token";
}

async function proxy(req: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const authFailure = await requireVerifiedCallerBearer(req, "Code Foundry");
  if (authFailure) return authFailure;

  const params = await context.params;
  const token = foundryToken();
  const error = platformWebCredentialError("CODEGEN_SERVICE_TOKEN/FOUNDRY_TOKEN", token);
  if (error) {
    return NextResponse.json({ code: "PLATFORM_WEB_CREDENTIAL_UNSAFE", message: error }, { status: 503 });
  }

  const path = params.path ?? [];
  const suffix = (path[0] === "codegen" ? path.slice(1) : path).join("/");
  const search = req.nextUrl.search ?? "";
  const upstream = `${FOUNDRY_API_URL.replace(/\/$/, "")}/api/codegen/${suffix}${search}`;
  const headers = proxyHeaders(req, FOUNDRY_API_URL);
  // Code Foundry is service-token gated. Browser requests may carry an IAM JWT,
  // but upstream must see the server-held Foundry service token instead.
  headers.set("authorization", `Bearer ${token}`);
  return proxyRequest(req, upstream, headers, { normalizeTextErrors: true });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
