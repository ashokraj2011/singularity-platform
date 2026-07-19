"use client";

import { useEffect, useState } from "react";
import { getIdentityUser, type LoginUser } from "../lib/identity/session";
import { AUTH_CHANGED_EVENT } from "../lib/api";

/**
 * Who is signed in, in the app chrome.
 *
 * The identity was already available client-side (`getIdentityUser`, persisted
 * under `iam-auth`) but had exactly one consumer — the super-admin gate — so the
 * app never told you whose session you were looking at. On a platform where runs
 * are attributed to the launching user and permissions differ per role, "which
 * account am I?" should not require opening devtools.
 *
 * Renders nothing until mounted: the store is localStorage-backed, so reading it
 * during the server render would produce a hydration mismatch. It also re-reads
 * on `storage` and AUTH_CHANGED_EVENT, so signing in or out — including in
 * another tab — updates this without a reload.
 */
export function CurrentUserBadge() {
  const [mounted, setMounted] = useState(false);
  const [user, setUser] = useState<LoginUser | null>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    const sync = () => setUser(getIdentityUser());
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener(AUTH_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(AUTH_CHANGED_EVENT, sync);
    };
  }, [mounted]);

  if (!mounted || !user) return null;

  // display_name is optional, so fall back to the email local-part rather than
  // showing a blank chip or the raw id.
  const label = user.display_name?.trim() || user.email?.split("@")[0] || "Signed in";
  const initial = label.charAt(0).toUpperCase();

  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        maxWidth: 200,
        padding: "3px 10px 3px 3px",
        borderRadius: 999,
        border: "1px solid var(--color-outline-variant, var(--color-outline))",
        color: "var(--color-on-surface)",
      }}
      // The full email is the unambiguous identifier; the visible label may be a
      // display name shared by more than one account.
      title={user.email ? `Signed in as ${user.email}` : "Signed in"}
    >
      <span
        aria-hidden="true"
        style={{
          width: 22,
          height: 22,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          fontWeight: 600,
          background: "var(--color-primary)",
          color: "var(--color-on-primary, #fff)",
          flexShrink: 0,
        }}
      >
        {initial}
      </span>
      <span
        style={{
          fontSize: 12,
          lineHeight: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {user.is_super_admin ? (
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.04em",
            padding: "2px 5px",
            borderRadius: 4,
            background: "var(--color-primary)",
            color: "var(--color-on-primary, #fff)",
            flexShrink: 0,
          }}
          title="This account has platform super-admin rights"
        >
          ADMIN
        </span>
      ) : null}
    </span>
  );
}
