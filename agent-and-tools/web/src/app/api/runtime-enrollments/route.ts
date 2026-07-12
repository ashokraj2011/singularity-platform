import { NextRequest } from "next/server";
import { iamApiBase } from "@/lib/platformServices";
import { proxyHeaders, proxyRequest, requireVerifiedCallerBearer } from "../_proxy";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const authFailure = await requireVerifiedCallerBearer(request, "Runtime enrollment");
  if (authFailure) return authFailure;
  const base = iamApiBase();
  return proxyRequest(request, `${base}/auth/runtime-enrollments`, proxyHeaders(request, base));
}
