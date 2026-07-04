export type UpstreamJsonBody = {
  raw: string;
  data: unknown;
  parseError?: string;
};

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function upstreamSnippet(value: string, max = 500): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export async function readUpstreamJsonBody(res: Response): Promise<UpstreamJsonBody> {
  const raw = await res.text().catch(() => "");
  if (!raw.trim()) return { raw, data: null };
  try {
    return { raw, data: JSON.parse(raw) as unknown };
  } catch (err) {
    return {
      raw,
      data: raw,
      parseError: err instanceof Error ? err.message : "Response body is not valid JSON",
    };
  }
}

export async function readUpstreamJsonObjectOrNull(res: Response): Promise<UpstreamJsonBody & { data: Record<string, unknown> | null }> {
  const body = await readUpstreamJsonBody(res);
  if (body.parseError || body.data === null) return { ...body, data: null };
  if (!isJsonObject(body.data)) return { ...body, data: null };
  return { ...body, data: body.data };
}
