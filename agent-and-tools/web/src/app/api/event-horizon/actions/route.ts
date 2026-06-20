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

export const dynamic = "force-dynamic";

function composerUrl(): string {
  return (process.env.PROMPT_COMPOSER_URL ?? "http://localhost:3004").replace(/\/+$/, "");
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function GET(request: NextRequest) {
  const authFailure = await composerAuthFailure(request);
  if (authFailure) return authFailure;
  const surface = request.nextUrl.searchParams.get("surface")?.trim() || "capability-admin";
  try {
    const r = await fetch(
      `${composerUrl()}/api/v1/event-horizon-actions?surface=${encodeURIComponent(surface)}`,
      { headers: composerAuthHeaders(request, { contentType: false }), signal: AbortSignal.timeout(10_000) },
    );
    const body = await readBody(r);
    if (!r.ok) {
      return NextResponse.json(
        { error: "composer fetch failed", detail: typeof body === "string" ? body.slice(0, 300) : body },
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
