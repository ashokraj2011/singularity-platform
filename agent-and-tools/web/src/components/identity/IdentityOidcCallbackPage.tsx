"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { assertValidApiResponse, readResponseBody, responseMessage } from "@/lib/api";
import { type LoginResponse, normalizeLoginResponse, safeNextPath, saveIdentitySession } from "@/lib/identity/session";

const OIDC_STATE_KEY = "singularity.identity.oidc.state";
const OIDC_NONCE_KEY = "singularity.identity.oidc.nonce";
const OIDC_NEXT_KEY = "singularity.identity.oidc.next";

function clearOidcStorage() {
  localStorage.removeItem(OIDC_STATE_KEY);
  localStorage.removeItem(OIDC_NONCE_KEY);
  localStorage.removeItem(OIDC_NEXT_KEY);
}

async function responseError(response: Response): Promise<string> {
  const { raw, parsed } = await readResponseBody(response);
  return responseMessage(parsed, raw, response.statusText || "SSO login failed.");
}

function isLoginResponse(value: unknown): value is LoginResponse {
  return normalizeLoginResponse(value) !== null;
}

export function IdentityOidcCallbackPage() {
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("Completing SSO sign-in...");

  const query = useMemo(() => {
    if (typeof window === "undefined") return new URLSearchParams();
    return new URLSearchParams(window.location.search);
  }, []);

  useEffect(() => {
    let active = true;

    async function completeLogin() {
      const providerError = query.get("error");
      if (providerError) {
        const description = query.get("error_description");
        throw new Error(description || providerError);
      }

      const code = query.get("code");
      const state = query.get("state");
      const expectedState = localStorage.getItem(OIDC_STATE_KEY);
      const nonce = localStorage.getItem(OIDC_NONCE_KEY);
      const next = safeNextPath(localStorage.getItem(OIDC_NEXT_KEY));

      if (!code) throw new Error("OIDC provider did not return an authorization code.");
      if (!state || !expectedState || state !== expectedState) {
        throw new Error("OIDC state does not match this browser login request.");
      }

      const response = await fetch("/api/iam/auth/oidc/code-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, nonce }),
      });

      if (!response.ok) {
        throw new Error(await responseError(response));
      }

      const { raw, parsed, parseError } = await readResponseBody(response);
      assertValidApiResponse("/api/iam/auth/oidc/code-login", raw, parseError);
      if (!isLoginResponse(parsed)) throw new Error("IAM SSO callback returned an invalid session response.");
      saveIdentitySession(parsed);
      clearOidcStorage();
      if (active) {
        setStatus("success");
        setMessage("SSO sign-in complete. Redirecting...");
      }
      window.location.replace(next);
    }

    completeLogin().catch((err) => {
      clearOidcStorage();
      if (!active) return;
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Unable to complete SSO sign-in.");
    });

    return () => {
      active = false;
    };
  }, [query]);

  return (
    <div className="min-h-[calc(100vh-8rem)] flex items-center justify-center">
      <section className="w-full max-w-md rounded-lg border border-[var(--color-outline-variant)] bg-white p-8 text-center shadow-[0_12px_32px_rgba(15,23,42,0.08)]">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-[#368727]/10 text-[#368727]">
          {status === "loading" ? <Loader2 className="h-6 w-6 animate-spin" /> : null}
          {status === "success" ? <CheckCircle2 className="h-6 w-6" /> : null}
          {status === "error" ? <AlertCircle className="h-6 w-6 text-red-600" /> : null}
        </div>
        <h1 className="text-xl font-bold text-[#0A2240]">External SSO</h1>
        <p className={`mt-2 text-sm leading-relaxed ${status === "error" ? "text-red-600" : "text-slate-500"}`}>
          {message}
        </p>
        {status === "error" ? (
          <Link
            href="/identity/login"
            className="mt-6 inline-flex h-10 items-center justify-center rounded-lg bg-[#368727] px-4 text-sm font-semibold text-white hover:bg-[#006F34]"
          >
            Back to sign in
          </Link>
        ) : null}
      </section>
    </div>
  );
}
