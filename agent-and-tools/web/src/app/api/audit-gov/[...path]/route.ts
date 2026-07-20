import { NextRequest, NextResponse } from "next/server";
import { proxyHeaders, proxyRequest, verifyCallerBearer } from "../../_proxy";
import { CLIENT_CONTROLLED_TENANT_HEADERS, resolveCallerTenantId } from "../../_tenant";
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
  const verified = await verifyCallerBearer(req, "Audit Governance");
  if (verified.response) return verified.response;

  // Which tenant's rows this caller may read. The browser's own x-tenant-id is
  // treated as a REQUEST and is only honoured if IAM listed it among the
  // caller's memberships — see resolveCallerTenantId.
  const tenant = resolveCallerTenantId(verified.caller, req.headers.get("x-tenant-id"));
  if (!tenant.ok && tenant.reason === "forbidden") {
    return NextResponse.json(
      { code: "TENANT_FORBIDDEN", message: `Audit Governance proxy refused the request: ${tenant.message}.` },
      { status: 403 },
    );
  }

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

  // proxyHeaders copies every non-hop-by-hop header, so strip the scope headers
  // the client could otherwise dictate BEFORE setting the resolved one. Without
  // this, a browser could name any tenant it liked — or present its own
  // x-cross-tenant-token — and audit-gov would take it at face value.
  for (const header of CLIENT_CONTROLLED_TENANT_HEADERS) headers.delete(header);

  if (tenant.ok) {
    headers.set("x-tenant-id", tenant.tenantId);
  } else {
    // Deliberately send NO tenant header. audit-gov decides what an unscoped
    // read means (shadow logs it, enforce refuses it); substituting a default
    // or empty tenant here would rebuild the fail-open bug one hop upstream.
    console.warn(
      `[platform-web] audit-gov request left unscoped (${tenant.reason}): ${tenant.message}. ` +
      `${req.method} ${req.nextUrl.pathname}`,
    );
  }
  return proxyRequest(req, upstream, headers, { normalizeTextErrors: true });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
