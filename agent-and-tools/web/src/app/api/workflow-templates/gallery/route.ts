import { NextRequest } from "next/server";
import { proxyHeaders, proxyRequest } from "../../_proxy";
import { platformServiceUrl } from "@/lib/platformServices";
import { referenceOnlySdlcGallery } from "@/lib/sdlcIntentCatalog";

export const dynamic = "force-dynamic";

const WORKGRAPH_API_URL = platformServiceUrl("workgraph-api");

export async function GET(req: NextRequest) {
  const base = WORKGRAPH_API_URL.replace(/\/$/, "");
  const upstream = `${base}/api/workflow-templates/gallery${req.nextUrl.search ?? ""}`;
  const proxied = await proxyRequest(req, upstream, proxyHeaders(req, WORKGRAPH_API_URL), { normalizeTextErrors: true });
  const hasCallerAuth = Boolean(req.headers.get("authorization")?.trim());
  if ((proxied.status === 401 || proxied.status === 403) && !hasCallerAuth) {
    const capabilityId = req.nextUrl.searchParams.get("capabilityId")?.trim() || null;
    return Response.json(referenceOnlySdlcGallery(capabilityId), {
      status: 200,
      headers: { "x-singularity-reference-only": "true" },
    });
  }
  return proxied;
}
