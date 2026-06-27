import { NextRequest } from "next/server";
import { proxyHeaders, proxyRequest } from "../../_proxy";

export const dynamic = "force-dynamic";

const WORKGRAPH_API_URL = process.env.WORKGRAPH_API_URL ?? "http://workgraph-api:8080";

export async function GET(req: NextRequest) {
  const base = WORKGRAPH_API_URL.replace(/\/$/, "");
  const upstream = `${base}/api/workflow-templates/gallery${req.nextUrl.search ?? ""}`;
  return proxyRequest(req, upstream, proxyHeaders(req, WORKGRAPH_API_URL), { normalizeTextErrors: true });
}

