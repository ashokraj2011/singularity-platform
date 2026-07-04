import { NextRequest } from "next/server";
import { proxyHeaders, proxyRequest, requireVerifiedCallerBearer } from "../../_proxy";
import { platformServiceUrl } from "@/lib/platformServices";

const WORKGRAPH_API_URL = platformServiceUrl("workgraph-api");

async function proxy(req: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const authFailure = await requireVerifiedCallerBearer(req, "Workgraph Code Generation");
  if (authFailure) return authFailure;

  const params = await context.params;
  const path = params.path ?? [];
  const suffix = (path[0] === "codegen" ? path.slice(1) : path).join("/");
  const search = req.nextUrl.search ?? "";
  const upstream = `${WORKGRAPH_API_URL.replace(/\/$/, "")}/api/codegen/${suffix}${search}`;
  const headers = proxyHeaders(req, WORKGRAPH_API_URL);
  return proxyRequest(req, upstream, headers, { normalizeTextErrors: true });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
