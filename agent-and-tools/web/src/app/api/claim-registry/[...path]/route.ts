import { NextRequest } from "next/server";
import { proxyHeaders, proxyRequest, requireVerifiedCallerBearer } from "../../_proxy";
import { platformServiceUrl } from "@/lib/platformServices";

const CLAIM_REGISTRY_URL = platformServiceUrl("claim-registry");

async function proxy(req: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const params = await context.params;
  const suffix = (params.path ?? []).join("/");
  const authFailure = await requireVerifiedCallerBearer(req, "Claim Registry");
  if (authFailure) return authFailure;

  const base = CLAIM_REGISTRY_URL.replace(/\/$/, "");
  const upstreamPath = suffix === "health" ? "/health" : `/api/v1/${suffix}`;
  return proxyRequest(
    req,
    `${base}${upstreamPath}${req.nextUrl.search ?? ""}`,
    proxyHeaders(req, CLAIM_REGISTRY_URL),
  );
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
