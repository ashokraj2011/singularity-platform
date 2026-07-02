import { NextRequest, NextResponse } from "next/server";
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
  const obj = record(value);
  const message = obj.message ?? obj.error ?? obj.detail ?? obj.title;
  if (typeof message === "string" && message.trim()) return message;
  if (typeof value === "string" && value.trim()) return value.slice(0, 700);
  return fallback;
}

export async function POST(req: NextRequest) {
  let body: StartPreviewInput & { plan?: unknown; workflowTemplateId?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const preview = await buildStartPreview(req, body);
  const recommendation = preview.recommendation;
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
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
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
