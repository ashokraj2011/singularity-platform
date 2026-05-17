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

export const dynamic = "force-dynamic";

function composerUrl(): string {
  return (process.env.PROMPT_COMPOSER_URL ?? "http://localhost:3004").replace(/\/+$/, "");
}

export async function GET(request: NextRequest) {
  const surface = request.nextUrl.searchParams.get("surface")?.trim() || "capability-admin";
  try {
    const r = await fetch(
      `${composerUrl()}/api/v1/event-horizon-actions?surface=${encodeURIComponent(surface)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return NextResponse.json(
        { error: "composer fetch failed", detail: text.slice(0, 300) },
        { status: r.status },
      );
    }
    const json = (await r.json()) as { success?: boolean; data?: unknown };
    return NextResponse.json(json.data ?? []);
  } catch (err) {
    return NextResponse.json(
      { error: "event-horizon actions fetch failed", detail: (err as Error).message },
      { status: 502 },
    );
  }
}
