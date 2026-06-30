import { SESSION_LAST_ACTIVITY_KEY } from "@/lib/api";

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
    const parsed = JSON.parse(raw) as { state?: { user?: LoginUser } };
    const user = parsed?.state?.user;
    return user && typeof user.id === "string" ? user : null;
  } catch {
    return null;
  }
}

export function saveIdentitySession(body: LoginResponse): void {
  const persisted = JSON.stringify({
    state: { token: body.access_token, user: body.user },
    version: 0,
  });
  localStorage.setItem("iam-auth", persisted);
  localStorage.setItem("singularity-portal.auth", persisted);
  localStorage.setItem("workgraph-auth", persisted);
  localStorage.setItem("agent-tools-token", body.access_token);
  localStorage.setItem(SESSION_LAST_ACTIVITY_KEY, String(Date.now())); // fresh idle deadline on sign-in
}
