import { NextRequest, NextResponse } from "next/server";
import { buildStartPreview, type StartPreviewInput } from "../_shared";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: StartPreviewInput = {};
  try {
    body = await req.json() as StartPreviewInput;
  } catch {
    body = {};
  }
  const preview = await buildStartPreview(req, body);
  return NextResponse.json(preview);
}
