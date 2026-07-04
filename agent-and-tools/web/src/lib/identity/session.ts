import { notifyAuthChanged, SESSION_LAST_ACTIVITY_KEY } from "@/lib/api";

export type LoginUser = {
  id: string;
  email: string;
  display_name?: string | null;
  is_super_admin: boolean;
};

export type LoginResponse = {
  access_token: string;
  token_type?: string;
  user: LoginUser;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function normalizeAccessToken(value: unknown): string | null {
  const token = typeof value === "string" ? value.trim() : "";
  return token || null;
}

export function normalizeLoginUser(value: unknown): LoginUser | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const email = typeof value.email === "string" ? value.email.trim() : "";
  if (!id || !email) return null;
  const displayName = typeof value.display_name === "string" && value.display_name.trim()
    ? value.display_name.trim()
    : null;
  return {
    id,
    email,
    display_name: displayName,
    is_super_admin: value.is_super_admin === true,
  };
}

export function normalizeLoginResponse(value: unknown): LoginResponse | null {
  if (!isRecord(value)) return null;
  const token = normalizeAccessToken(value.access_token);
  const user = normalizeLoginUser(value.user);
  if (!token || !user) return null;
  const tokenType = typeof value.token_type === "string" && value.token_type.trim()
    ? value.token_type.trim()
    : undefined;
  return {
    access_token: token,
    ...(tokenType ? { token_type: tokenType } : {}),
    user,
  };
}

export function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/identity/dashboard";
  }
  if (
    value.startsWith("/api/") ||
    value.startsWith("/ops-health/") ||
    value.startsWith("/_next/") ||
    value === "/identity/login" ||
    value.startsWith("/identity/login?") ||
    value === "/identity/oidc/callback" ||
    value.startsWith("/identity/oidc/callback?")
  ) {
    return "/identity/dashboard";
  }
  return value;
}

/**
 * Read the signed-in IAM user from localStorage (the shape persisted by
 * saveIdentitySession / saveAgentToolsToken under `iam-auth`). Returns null when
 * unauthenticated or the store is malformed. Client-only — call after mount to
 * avoid hydration mismatch. Used by RequireSuperAdmin to gate admin pages; real
 * enforcement is server-side (`require_super_admin`).
 */
export function getIdentityUser(): LoginUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem("iam-auth");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    const state = isRecord(parsed) && isRecord(parsed.state) ? parsed.state : null;
    return normalizeLoginUser(state?.user);
  } catch {
    return null;
  }
}

export function saveIdentitySession(body: LoginResponse): void {
  const session = normalizeLoginResponse(body);
  if (!session) throw new Error("IAM login returned an invalid session response.");
  const persisted = JSON.stringify({
    state: { token: session.access_token, user: session.user },
    version: 0,
  });
  localStorage.setItem("iam-auth", persisted);
  localStorage.setItem("singularity-portal.auth", persisted);
  localStorage.setItem("workgraph-auth", persisted);
  localStorage.setItem("agent-tools-token", session.access_token);
  localStorage.setItem(SESSION_LAST_ACTIVITY_KEY, String(Date.now())); // fresh idle deadline on sign-in
  notifyAuthChanged();
}
