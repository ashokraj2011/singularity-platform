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

export function saveIdentitySession(body: LoginResponse): void {
  const persisted = JSON.stringify({
    state: { token: body.access_token, user: body.user },
    version: 0,
  });
  localStorage.setItem("iam-auth", persisted);
  localStorage.setItem("singularity-portal.auth", persisted);
  localStorage.setItem("workgraph-auth", persisted);
  localStorage.setItem("agent-tools-token", body.access_token);
}
