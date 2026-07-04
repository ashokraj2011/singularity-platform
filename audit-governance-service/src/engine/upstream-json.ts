export type UpstreamJsonBody = {
  raw: string;
  data: unknown;
  parseError?: string;
};

export async function readUpstreamJsonBody(res: Response): Promise<UpstreamJsonBody> {
  const raw = await res.text();
  if (!raw) return { raw, data: null };
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

export function upstreamSnippet(raw: string, max = 500): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}

export async function readUpstreamJsonObject<T extends object = Record<string, unknown>>(
  res: Response,
  source: string,
): Promise<T> {
  const body = await readUpstreamJsonBody(res);
  const snippet = upstreamSnippet(body.raw);
  if (body.parseError) {
    throw new Error(`${source} returned invalid JSON (${res.status}): ${body.parseError}${snippet ? `; body=${snippet}` : ""}`);
  }
  if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    throw new Error(`${source} returned invalid JSON object (${res.status})${snippet ? `; body=${snippet}` : ""}`);
  }
  return body.data as T;
}
