import { NextRequest, NextResponse } from "next/server";
import { readRequestJson } from "../../_json";
import { buildStartPreview, type StartPreviewInput } from "../_shared";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const requestBody = await readRequestJson(req);
  if (requestBody.parseError) {
    return NextResponse.json(
      { code: "INVALID_JSON", message: "Request body must be valid JSON.", detail: requestBody.text },
      { status: 400 },
    );
  }
  const body = requestBody.data && typeof requestBody.data === "object" && !Array.isArray(requestBody.data)
    ? requestBody.data as StartPreviewInput
    : {};
  const preview = await buildStartPreview(req, body);
  return NextResponse.json(preview);
}
