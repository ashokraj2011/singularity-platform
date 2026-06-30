"use client";

import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { AUTH_CHANGED_EVENT } from "@/lib/api";
import { getIdentityUser } from "@/lib/identity/session";

/**
 * Super-admin gate for admin-only pages (e.g. the Git Credential Broker config).
 *
 * Reads the signed-in IAM user from localStorage only AFTER mount (so the first
 * paint matches the server render — no hydration mismatch) and re-checks on
 * login/logout via AUTH_CHANGED_EVENT / storage. This is UX only: the IAM backend
 * independently enforces `require_super_admin` on every endpoint these pages call,
 * so a non-admin who bypasses this guard still gets a 403 from the API.
 *
 * Assumes a session already exists (the app-wide RequireSession front-door runs
 * first); this only narrows from "signed in" to "signed in as super-admin".
 */
export function RequireSuperAdmin({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    const sync = () => setIsSuperAdmin(Boolean(getIdentityUser()?.is_super_admin));
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener(AUTH_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(AUTH_CHANGED_EVENT, sync);
    };
  }, [mounted]);

  if (!mounted) return null;
  if (!isSuperAdmin) {
    return (
      <div
        style={{
          display: "grid",
          placeItems: "center",
          minHeight: "60vh",
          padding: 24,
        }}
      >
        <div className="card" style={{ maxWidth: 440, padding: 28, textAlign: "center" }}>
          <ShieldAlert size={28} style={{ color: "var(--color-warning, #b45309)", margin: "0 auto 10px" }} />
          <h2 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 800, color: "var(--color-text)" }}>
            Super-admin access required
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: "var(--color-outline)" }}>
            This page manages tenant Git credentials and repository grants. Ask a platform
            super-admin to make changes here.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
