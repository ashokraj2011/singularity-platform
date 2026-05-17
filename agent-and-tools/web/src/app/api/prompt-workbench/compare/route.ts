import { NextRequest, NextResponse } from "next/server";
import { callComposer, estimateTokensFromPreview, selectedAliases } from "../_shared/composer";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { compose?: Record<string, unknown>; modelAliases?: unknown } | null;
  if (!body?.compose || typeof body.compose !== "object") {
    return NextResponse.json({ error: "Request body must include compose." }, { status: 400 });
  }

  const baseCompose = body.compose;
  const baseOverrides = (baseCompose.modelOverrides && typeof baseCompose.modelOverrides === "object")
    ? baseCompose.modelOverrides as Record<string, unknown>
    : {};
  const aliases = selectedAliases(body.modelAliases, baseOverrides.modelAlias);

  const items = await Promise.all(aliases.map(async (alias) => {
    const compose = {
      ...baseCompose,
      modelOverrides: {
        ...baseOverrides,
        ...(alias ? { modelAlias: alias } : {}),
      },
    };
    const result = await callComposer(request, compose, true);
    if (!result.ok) {
      return {
        modelAlias: alias || null,
        ok: false,
        error: result.error,
        status: result.status,
        requestId: result.requestId ?? null,
      };
    }
    return {
      ok: true,
      ...estimateTokensFromPreview(result.data, compose, alias),
    };
  }));

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    items,
  }, { status: 200 });
}
