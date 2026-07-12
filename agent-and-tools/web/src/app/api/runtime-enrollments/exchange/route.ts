import { NextRequest } from "next/server";
import { iamApiBase } from "@/lib/platformServices";
import { proxyHeaders, proxyRequest } from "../../_proxy";

export const dynamic = "force-dynamic";

// The enrollment code is the one-time secret for this endpoint. No browser
// session is required because this is called by the local runtime CLI.
export async function POST(request: NextRequest) {
  const base = iamApiBase();
  return proxyRequest(request, `${base}/auth/runtime-enrollments/exchange`, proxyHeaders(request, base));
}
