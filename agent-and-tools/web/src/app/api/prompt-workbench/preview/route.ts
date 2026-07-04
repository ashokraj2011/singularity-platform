import { NextRequest, NextResponse } from "next/server";
import { readRequestJson } from "../../_json";
import { callComposer, composerError } from "../_shared/composer";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestBody = await readRequestJson(request);
  if (requestBody.parseError) {
    return NextResponse.json({ error: "Request body must be valid JSON.", detail: requestBody.text }, { status: 400 });
  }
  const body = requestBody.data;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be a compose request." }, { status: 400 });
  }

  const result = await callComposer(request, body as Record<string, unknown>, true);
  if (!result.ok) return composerError(result);
  return NextResponse.json(result.data, { status: 200 });
}
