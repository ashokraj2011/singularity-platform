import { NextRequest, NextResponse } from "next/server";
import { jsonishMessage, readJsonish, readRequestJson } from "../../_json";
import { buildStartPreview, type StartPreviewInput } from "../_shared";

export const dynamic = "force-dynamic";

function authHeaders(req: NextRequest): HeadersInit {
  const auth = req.headers.get("authorization");
  return auth ? { authorization: auth } : {};
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function messageFrom(value: unknown, fallback: string): string {
  return jsonishMessage(value, fallback);
}

export async function POST(req: NextRequest) {
  const requestBody = await readRequestJson(req);
  if (requestBody.parseError) {
    return NextResponse.json(
      { code: "INVALID_JSON", message: "Request body must be valid JSON.", detail: requestBody.text },
      { status: 400 },
    );
  }
  const body = requestBody.data && typeof requestBody.data === "object" && !Array.isArray(requestBody.data)
    ? requestBody.data as StartPreviewInput & { plan?: unknown; workflowTemplateId?: string }
    : {};

  const preview = await buildStartPreview(req, body);
  const recommendation = preview.recommendation;
  const hardBlockers = preview.blockers.filter((blocker) => blocker.severity === "blocked");
  if (hardBlockers.length > 0) {
    return NextResponse.json(
      {
        code: "START_PREREQUISITES_BLOCKED",
        message: hardBlockers.map((blocker) => `${blocker.label}: ${blocker.message}`).join(" "),
        recommendation,
        blockers: preview.blockers,
      },
      { status: 409 },
    );
  }
  if (!recommendation.capabilityId || !recommendation.workflowTemplateId) {
    return NextResponse.json(
      {
        code: "START_PREREQUISITES_BLOCKED",
        message: "Start launch is missing a capability or seeded workflow template.",
        recommendation,
        blockers: preview.blockers,
      },
      { status: 409 },
    );
  }

  const launchPayload = {
    capabilityId: recommendation.capabilityId,
    intent: recommendation.intent,
    story: preview.story,
    plan: body.plan,
    workflowTemplateId: body.workflowTemplateId ?? recommendation.workflowTemplateId,
    modelAlias: recommendation.modelAlias,
    runtimePreference: recommendation.runtimePreference,
    governancePreset: recommendation.governancePreset,
  };

  const upstream = `${req.nextUrl.origin}/api/planner/launch`;
  try {
    const res = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(req) },
      body: JSON.stringify(launchPayload),
      cache: "no-store",
    });
    const parsed = (await readJsonish(res)).data;
    if (!res.ok) {
      return NextResponse.json(
        {
          code: "START_LAUNCH_FAILED",
          message: messageFrom(parsed, res.statusText),
          recommendation,
          blockers: preview.blockers,
          details: parsed,
        },
        { status: res.status || 502 },
      );
    }
    return NextResponse.json({
      ...record(parsed),
      recommendation,
      blockers: preview.blockers,
      warnings: [
        ...((Array.isArray(record(parsed).warnings) ? record(parsed).warnings : []) as unknown[]).map(String),
        ...preview.blockers.filter((blocker) => blocker.severity === "warning").map((blocker) => blocker.message),
      ],
    });
  } catch (err) {
    return NextResponse.json(
      {
        code: "START_LAUNCH_UNREACHABLE",
        message: err instanceof Error ? err.message : "Planner launch is unreachable.",
        recommendation,
        blockers: preview.blockers,
      },
      { status: 502 },
    );
  }
}
