export const RUNTIME_TOKEN_MAX_BYTES = 16 * 1024;
const RUNTIME_TOKEN_CLAIM_MAX_CHARS = 200;

export type RuntimeTokenDiagnostic =
  | {
      valid: true;
      kind?: string;
      sub?: string;
      runtime_id?: string;
      device_id?: string;
      tenant_id?: string;
      shared?: boolean;
      exp?: number;
      expires_at?: string;
      expired: boolean;
    }
  | {
      valid: false;
      error: string;
      expired: false;
    };

export function runtimeTokenDiagnostic(token: string): RuntimeTokenDiagnostic {
  try {
    if (Buffer.byteLength(token, "utf8") > RUNTIME_TOKEN_MAX_BYTES) {
      return { valid: false, error: "token too long", expired: false };
    }
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: false, error: "malformed JWT", expired: false };
    const header = decodeJwtObject(parts[0] ?? "", "bad JWT header");
    if (stringClaim(header.alg) !== "HS256") {
      return { valid: false, error: `unsupported alg: ${stringClaim(header.alg) ?? "unknown"}`, expired: false };
    }
    const payload = decodeJwtObject(parts[1] ?? "", "bad JWT payload");
    const exp = typeof payload.exp === "number" ? payload.exp : Number(payload.exp);
    if (!Number.isFinite(exp)) {
      return { valid: false, error: "missing or invalid exp", expired: false };
    }
    const expiresAt = new Date(exp * 1000).toISOString();
    const expired = Date.now() > exp * 1000;
    return {
      valid: true,
      kind: stringClaim(payload.kind),
      sub: stringClaim(payload.sub, 128),
      runtime_id: stringClaim(payload.runtime_id, 128),
      device_id: stringClaim(payload.device_id, 128),
      tenant_id: stringClaim(payload.tenant_id, 128),
      shared: payload.shared === true,
      exp,
      expires_at: expiresAt,
      expired,
    };
  } catch (err) {
    return { valid: false, error: (err as Error).message || "bad JWT payload", expired: false };
  }
}

function decodeJwtObject(segment: string, message: string): Record<string, unknown> {
  const parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(message);
  }
  return parsed as Record<string, unknown>;
}

function stringClaim(value: unknown, maxChars = RUNTIME_TOKEN_CLAIM_MAX_CHARS): string | undefined {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return text ? text.slice(0, maxChars) : undefined;
}
