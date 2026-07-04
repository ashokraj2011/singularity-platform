import { NextRequest, NextResponse } from "next/server";
import { proxyHeaders, proxyRequest, requireVerifiedCallerBearer } from "../../_proxy";
import { platformWebCredentialError } from "@/lib/serverEnvGuard";
import { platformServiceToken, platformServiceUrl } from "@/lib/platformServices";

const AUDIT_GOV_URL = platformServiceUrl("audit-governance");

function auditGovToken(): string | null {
  return platformServiceToken("audit-governance");
}

function upstreamPath(parts: string[]): string {
  const suffix = parts.join("/");
  if (suffix === "health" || suffix === "healthz" || suffix === "healthz/strict") return `/${suffix}`;
  if (!suffix) return "/api/v1";
  if (suffix === "api" || suffix.startsWith("api/")) return `/${suffix}`;
  return `/api/v1/${suffix}`;
}

async function proxy(req: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const authFailure = await requireVerifiedCallerBearer(req, "Audit Governance");
  if (authFailure) return authFailure;

  const params = await context.params;
  const token = auditGovToken();
  const error = platformWebCredentialError("AUDIT_GOV_SERVICE_TOKEN", token);
  if (error) {
    return NextResponse.json({ code: "PLATFORM_WEB_CREDENTIAL_UNSAFE", message: error }, { status: 503 });
  }

  const search = req.nextUrl.search ?? "";
  const upstream = `${AUDIT_GOV_URL.replace(/\/$/, "")}${upstreamPath(params.path ?? [])}${search}`;
  const headers = proxyHeaders(req, AUDIT_GOV_URL);
  // Audit Governance is service-token gated. Do not forward a browser/user
  // Authorization header to that service; Platform Web owns this hop.
  headers.delete("authorization");
  if (token) headers.set("authorization", `Bearer ${token}`);
  return proxyRequest(req, upstream, headers, { normalizeTextErrors: true });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
