import { NextRequest, NextResponse } from "next/server";
import { callComposer, composerError } from "../_shared/composer";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be a compose request." }, { status: 400 });
  }

  const result = await callComposer(request, body as Record<string, unknown>, true);
  if (!result.ok) return composerError(result);
  return NextResponse.json(result.data, { status: 200 });
}
