import { NextRequest } from "next/server";
import { iamApiBase } from "@/lib/platformServices";
import { proxyHeaders, proxyRequest, requireVerifiedCallerBearer } from "../_proxy";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const authFailure = await requireVerifiedCallerBearer(request, "Runtime revocation");
  if (authFailure) return authFailure;
  const body = await request.clone().json().catch(() => ({})) as { device_id?: string };
  const deviceId = typeof body.device_id === "string" ? body.device_id.trim() : "";
  if (!deviceId) {
    return Response.json({ code: "INVALID_DEVICE_ID", message: "device_id is required" }, { status: 400 });
  }
  const base = iamApiBase();
  const upstream = `${base}/runtime/revoke?device_id=${encodeURIComponent(deviceId)}`;
  return proxyRequest(request, upstream, proxyHeaders(request, base));
}
