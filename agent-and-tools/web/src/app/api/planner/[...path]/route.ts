import { NextRequest } from "next/server";
import { proxyHeaders, proxyRequest } from "../../_proxy";
import { platformServiceUrl } from "@/lib/platformServices";

export const dynamic = "force-dynamic";

const WORKGRAPH_API_URL = platformServiceUrl("workgraph-api");

function suffix(parts?: string[]): string {
  return (parts ?? []).map((part) => encodeURIComponent(part)).join("/");
}

async function proxy(req: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const params = await context.params;
  const path = suffix(params.path);
  const base = WORKGRAPH_API_URL.replace(/\/$/, "");
  const upstream = `${base}/api/planner${path ? `/${path}` : ""}${req.nextUrl.search ?? ""}`;
  return proxyRequest(req, upstream, proxyHeaders(req, WORKGRAPH_API_URL), { normalizeTextErrors: true });
}

export const GET = proxy;
export const POST = proxy;
