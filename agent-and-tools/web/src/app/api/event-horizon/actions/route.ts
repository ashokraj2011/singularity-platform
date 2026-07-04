/**
 * M37.4 — Next.js proxy to prompt-composer's EventHorizonAction catalog.
 *
 * The agent-and-tools/web SPA's floating Event Horizon chip used to ship
 * a hardcoded ACTIONS array (5 prompts) in EventHorizonChat.tsx. Now it
 * fetches the catalog from this route at mount time. The route just
 * proxies to composer's /api/v1/event-horizon-actions, scoped to the
 * "capability-admin" surface by default.
 *
 * Surface defaults to "capability-admin" (the only surface this SPA owns).
 * Callers can override with ?surface=...
 */
import { NextRequest, NextResponse } from "next/server";
import { composerAuthFailure, composerAuthHeaders } from "../../prompt-workbench/_shared/composer";
import { platformServiceUrl } from "@/lib/platformServices";
import { jsonishMessage, readJsonish } from "../../_json";
import { boundedSecondsEnv } from "@/lib/serverEnvBounds";

export const dynamic = "force-dynamic";

const EVENT_HORIZON_ACTIONS_TIMEOUT_MS = boundedSecondsEnv("EVENT_HORIZON_ACTIONS_TIMEOUT_SEC", 10, 1, 300) * 1000;

function composerUrl(): string {
  return platformServiceUrl("prompt-composer");
}

export async function GET(request: NextRequest) {
  const authFailure = await composerAuthFailure(request);
  if (authFailure) return authFailure;
  const surface = request.nextUrl.searchParams.get("surface")?.trim() || "capability-admin";
  try {
    const r = await fetch(
      `${composerUrl()}/api/v1/event-horizon-actions?surface=${encodeURIComponent(surface)}`,
      { headers: composerAuthHeaders(request, { contentType: false }), signal: AbortSignal.timeout(EVENT_HORIZON_ACTIONS_TIMEOUT_MS) },
    );
    const responseBody = await readJsonish(r);
    const body = responseBody.data;
    if (!r.ok) {
      return NextResponse.json(
        { error: "composer fetch failed", detail: jsonishMessage(body, r.statusText || "Prompt Composer request failed", 300) },
        { status: r.status },
      );
    }
    const json = body && typeof body === "object" ? body as { success?: boolean; data?: unknown } : null;
    return NextResponse.json(json?.data ?? (Array.isArray(body) ? body : []));
  } catch (err) {
    return NextResponse.json(
      { error: "event-horizon actions fetch failed", detail: (err as Error).message },
      { status: 502 },
    );
  }
}
