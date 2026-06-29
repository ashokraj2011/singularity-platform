"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { AUTH_CHANGED_EVENT, hasAgentToolsToken, identityApi, saveAgentToolsToken } from "@/lib/api";

// Paths that must render WITHOUT a session — otherwise the gate would lock out
// the very pages used to obtain one (the IAM login + OIDC return) and the health
// probe. Matched as exact path or `${prefix}/...`.
const PUBLIC_PREFIXES = ["/identity/login", "/identity/oidc", "/healthz"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Unified front-door auth gate. Wraps the whole platform-web shell: until an IAM
 * session token is present (the same `agent-tools-token` the Agent Studio + API
 * layer already use), every non-public route renders the sign-in page instead of
 * the app. Reads localStorage only after mount so the first paint matches the
 * server render (no hydration mismatch), and re-checks on `storage` /
 * `AUTH_CHANGED_EVENT` so logout/login (incl. other tabs) flip the gate live.
 */
export function RequireSession({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    const sync = () => setSignedIn(hasAgentToolsToken());
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener(AUTH_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(AUTH_CHANGED_EVENT, sync);
    };
  }, [mounted, pathname]);

  const publicPath = isPublicPath(pathname);

  // Pre-mount paint is identical on server and first client render → no hydration
  // mismatch. The token check (localStorage) only runs in the effect above.
  if (!mounted) return publicPath ? <>{children}</> : <SessionSplash />;
  if (publicPath || signedIn) return <>{children}</>;
  return <SessionLoginPage onSignedIn={() => setSignedIn(true)} />;
}

/** Neutral full-screen placeholder shown for the one frame before the token check. */
function SessionSplash() {
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--color-surface)",
        color: "var(--color-outline)",
        fontSize: 13,
      }}
    >
      Loading Platform Web…
    </div>
  );
}

function SessionLoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("admin@singularity.local");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!email || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await identityApi.login({ email, password });
      saveAgentToolsToken(res.access_token, res.user); // also fires AUTH_CHANGED_EVENT
      onSignedIn();
    } catch (e) {
      setError((e as Error).message ?? "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
        background: "var(--color-surface)",
      }}
    >
      <div className="card w-full max-w-md p-8">
        <div className="flex items-center gap-2 text-base font-semibold text-slate-900">
          <ShieldCheck size={18} className="text-emerald-700" />
          Sign in to Platform Web
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Use your IAM session. The same sign-in governs agents, tools, workflows, and identity.
        </p>

        <div className="mt-6 flex flex-col gap-3">
          <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Email
            <input
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-900"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="username"
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            />
          </label>
          <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Password
            <input
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-900"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
              type="password"
              autoComplete="current-password"
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            />
          </label>

          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !email || !password}
            className="mt-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>

          {error && <p className="text-xs text-red-600">{error}</p>}

          <a href="/identity/login" className="mt-1 text-center text-xs text-slate-500 underline">
            Use SSO / other sign-in options
          </a>
        </div>
      </div>
    </div>
  );
}
