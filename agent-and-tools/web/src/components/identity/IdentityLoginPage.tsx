"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AlertCircle, Fingerprint, KeyRound, Lock, Mail } from "lucide-react";
import { readResponseBody, responseMessage } from "@/lib/api";
import { type LoginResponse, normalizeLoginResponse, safeNextPath, saveIdentitySession } from "@/lib/identity/session";

const OIDC_STATE_KEY = "singularity.identity.oidc.state";
const OIDC_NONCE_KEY = "singularity.identity.oidc.nonce";
const OIDC_NEXT_KEY = "singularity.identity.oidc.next";

type ProviderReadiness = {
  mode: "local" | "oidc" | string;
  localLoginEnabled: boolean;
  oidc: {
    enabled: boolean;
    configured: boolean;
    issuerUrl?: string | null;
    redirectUri?: string | null;
    scopes?: string[];
  };
};

type LoginUrlResponse = {
  authorization_url: string;
  state: string;
  nonce: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isProviderReadiness(value: unknown): value is ProviderReadiness {
  return isRecord(value) && typeof value.localLoginEnabled === "boolean" && isRecord(value.oidc);
}

function isLoginResponse(value: unknown): value is LoginResponse {
  return normalizeLoginResponse(value) !== null;
}

function isLoginUrlResponse(value: unknown): value is LoginUrlResponse {
  return isRecord(value)
    && typeof value.authorization_url === "string"
    && typeof value.state === "string"
    && typeof value.nonce === "string";
}

export function IdentityLoginPage() {
  const [email, setEmail] = useState("admin@singularity.local");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);
  const [isSsoSubmitting, setSsoSubmitting] = useState(false);
  const [providers, setProviders] = useState<ProviderReadiness | null>(null);

  const destination = useMemo(() => {
    if (typeof window === "undefined") return "/identity/dashboard";
    const next = new URLSearchParams(window.location.search).get("next");
    return safeNextPath(next);
  }, []);

  const localLoginEnabled = providers?.localLoginEnabled ?? true;
  const oidcReady = Boolean(providers?.oidc.enabled && providers?.oidc.configured);

  useEffect(() => {
    let active = true;
    fetch("/api/iam/auth/providers", { headers: { accept: "application/json" } })
      .then(async (response) => {
        const { raw, parsed } = await readResponseBody(response);
        if (!response.ok) throw new Error(responseMessage(parsed, raw, `Provider discovery failed: ${response.status}`));
        if (!isProviderReadiness(parsed)) throw new Error("Provider discovery returned an invalid response.");
        return parsed;
      })
      .then((body) => {
        if (active) setProviders(body);
      })
      .catch(() => {
        if (active) setProviders({ mode: "local", localLoginEnabled: true, oidc: { enabled: false, configured: false } });
      });
    return () => {
      active = false;
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!localLoginEnabled) {
      setError("Local password login is disabled. Use the configured SSO provider.");
      return;
    }
    setError(null);
    setSubmitting(true);

    try {
      const response = await fetch("/api/iam/auth/local/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const { raw, parsed } = await readResponseBody(response);
      if (!response.ok) throw new Error(responseMessage(parsed, raw, "Invalid credentials. Please try again."));
      if (!isLoginResponse(parsed)) throw new Error("IAM login returned an invalid session response.");

      saveIdentitySession(parsed);
      window.location.assign(destination);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in.");
    } finally {
      setSubmitting(false);
    }
  }

  async function startSso() {
    setError(null);
    setSsoSubmitting(true);
    try {
      const response = await fetch("/api/iam/auth/oidc/login-url", { headers: { accept: "application/json" } });
      const { raw, parsed } = await readResponseBody(response);
      if (!response.ok) throw new Error(responseMessage(parsed, raw, "OIDC provider is not ready."));
      if (!isLoginUrlResponse(parsed)) throw new Error("OIDC provider returned an invalid login URL response.");
      const body = parsed;
      localStorage.setItem(OIDC_STATE_KEY, body.state);
      localStorage.setItem(OIDC_NONCE_KEY, body.nonce);
      localStorage.setItem(OIDC_NEXT_KEY, destination);
      window.location.assign(body.authorization_url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start SSO.");
      setSsoSubmitting(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-8rem)] flex items-center justify-center">
      <section className="w-full max-w-5xl overflow-hidden rounded-lg border border-[var(--color-outline-variant)] bg-white shadow-[0_12px_32px_rgba(15,23,42,0.08)]">
        <div className="grid min-h-[560px] lg:grid-cols-[0.9fr_1.1fr]">
          <aside
            className="hidden flex-col items-center justify-center p-12 text-center lg:flex"
            style={{ background: "linear-gradient(145deg, #071829 0%, #0A2240 48%, #0D3060 100%)" }}
          >
            <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#368727] shadow-2xl">
              <Fingerprint className="text-white" size={32} />
            </div>
            <h1 className="text-2xl font-bold tracking-wide text-white">SINGULARITY</h1>
            <p className="mt-2 text-xs font-semibold uppercase tracking-[0.2em] text-white/45">IAM Platform</p>
            <div className="my-7 h-0.5 w-9 rounded-full bg-[#368727]" />
            <p className="max-w-xs text-sm leading-relaxed text-white/60">
              Identity and Access Management for enterprise capabilities, teams, roles, and permissions.
            </p>
          </aside>

          <main className="flex items-center justify-center bg-[#F0F4F8] p-8">
            <div className="w-full max-w-sm">
              <div className="mb-8">
                <h2 className="mb-1 text-2xl font-bold text-[#0A2240]">Welcome back</h2>
                <p className="text-sm text-slate-500">
                  {oidcReady ? "Sign in with your configured identity provider" : "Sign in to your admin account"}
                </p>
              </div>

              <div className="space-y-5 rounded-lg border border-slate-200 bg-white p-6 shadow-[0_1px_3px_rgba(10,34,64,0.08),0_4px_16px_rgba(10,34,64,0.06)]">
                {error ? (
                  <div className="flex items-center gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-600">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {error}
                  </div>
                ) : null}

                {oidcReady ? (
                  <button
                    type="button"
                    onClick={() => void startSso()}
                    disabled={isSsoSubmitting}
                    className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#368727] text-sm font-semibold tracking-wide text-white transition hover:bg-[#006F34] disabled:pointer-events-none disabled:opacity-60"
                  >
                    <KeyRound className="h-4 w-4" />
                    {isSsoSubmitting ? "Opening SSO..." : "Continue with SSO"}
                  </button>
                ) : null}

                {localLoginEnabled ? (
                  <form onSubmit={onSubmit} className="space-y-5">
                    {oidcReady ? <div className="h-px bg-slate-100" /> : null}

                    <label className="block">
                      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-600">
                        Email Address
                      </span>
                      <span className="relative block">
                        <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        <input
                          className="h-10 w-full rounded-md border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 outline-none transition focus:border-[#368727] focus:ring-2 focus:ring-[#368727]/15"
                          name="email"
                          type="email"
                          value={email}
                          onChange={(event) => setEmail(event.target.value)}
                          autoComplete="username"
                          required
                        />
                      </span>
                    </label>

                    <label className="block">
                      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-600">
                        Password
                      </span>
                      <span className="relative block">
                        <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        <input
                          className="h-10 w-full rounded-md border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 outline-none transition focus:border-[#368727] focus:ring-2 focus:ring-[#368727]/15"
                          name="password"
                          type="password"
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                          autoComplete="current-password"
                          required
                        />
                      </span>
                    </label>

                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="h-10 w-full rounded-lg bg-[#368727] text-sm font-semibold tracking-wide text-white transition hover:bg-[#006F34] disabled:pointer-events-none disabled:opacity-60"
                    >
                      {isSubmitting ? "Signing in..." : "Sign In"}
                    </button>
                  </form>
                ) : (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-3 text-xs leading-relaxed text-slate-500">
                    Local password login is disabled for this deployment.
                  </div>
                )}
              </div>

              <p className="mt-4 text-center text-xs text-slate-400">
                {oidcReady ? "External SSO session is shared across Platform Web" : "Local super admin credentials only"}
              </p>
            </div>
          </main>
        </div>
      </section>
    </div>
  );
}
