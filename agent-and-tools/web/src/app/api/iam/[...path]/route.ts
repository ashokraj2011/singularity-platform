import { NextRequest } from "next/server";
import { proxyHeaders, proxyRequest } from "../../_proxy";
import { iamApiBase } from "@/lib/platformServices";

const IAM_BASE_URL = iamApiBase();

async function proxy(req: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const params = await context.params;
  const suffix = (params.path ?? []).join("/");
  const search = req.nextUrl.search ?? "";
  const upstream = `${IAM_BASE_URL.replace(/\/$/, "")}/${suffix}${search}`;
  return proxyRequest(req, upstream, proxyHeaders(req, IAM_BASE_URL));
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
