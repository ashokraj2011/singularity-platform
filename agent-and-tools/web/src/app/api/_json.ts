export type JsonishBody = {
  raw: string;
  text: string;
  data: unknown;
  parseError?: string;
};

export async function readJsonish(res: Response, maxText = 700): Promise<JsonishBody> {
  const raw = await res.text();
  if (!raw) return { raw, text: "", data: null };
  try {
    return { raw, text: raw.slice(0, maxText), data: JSON.parse(raw) as unknown };
  } catch (err) {
    return {
      raw,
      text: raw.slice(0, maxText),
      data: raw,
      parseError: err instanceof Error ? err.message : "Response body is not valid JSON",
    };
  }
}

export async function readRequestJson(req: Request, maxText = 700): Promise<JsonishBody> {
  const raw = await req.text();
  if (!raw.trim()) return { raw, text: "", data: null };
  try {
    return { raw, text: raw.slice(0, maxText), data: JSON.parse(raw) as unknown };
  } catch (err) {
    return {
      raw,
      text: raw.slice(0, maxText),
      data: null,
      parseError: err instanceof Error ? err.message : "Request body is not valid JSON",
    };
  }
}

export function jsonishMessage(value: unknown, fallback: string, maxText = 700): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const message = obj.message ?? obj.error ?? obj.detail ?? obj.title;
    if (typeof message === "string" && message.trim()) return message.slice(0, maxText);
    if (message != null) return JSON.stringify(message).slice(0, maxText);
  }
  if (typeof value === "string" && value.trim()) return value.slice(0, maxText);
  return fallback;
}
