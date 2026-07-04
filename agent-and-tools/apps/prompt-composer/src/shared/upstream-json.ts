export type JsonObject = Record<string, unknown>;

export class UpstreamJsonError extends Error {
  constructor(
    message: string,
    public readonly upstream: string,
    public readonly status?: number,
    public readonly snippet?: string,
  ) {
    super(message);
  }
}

export async function readUpstreamText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export function responseSnippet(text: string, max = 400): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export function parseUpstreamJson(text: string, upstream: string, status?: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const snippet = responseSnippet(text);
    throw new UpstreamJsonError(
      `${upstream} returned invalid JSON${snippet ? `: ${snippet}` : ""}`,
      upstream,
      status,
      snippet,
    );
  }
}

export async function readUpstreamJson(response: Response, upstream: string): Promise<unknown> {
  return parseUpstreamJson(await readUpstreamText(response), upstream, response.status);
}

export async function readUpstreamJsonObject(response: Response, upstream: string): Promise<JsonObject> {
  const parsed = await readUpstreamJson(response, upstream);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UpstreamJsonError(
      `${upstream} returned invalid JSON object`,
      upstream,
      response.status,
      undefined,
    );
  }
  return parsed as JsonObject;
}
