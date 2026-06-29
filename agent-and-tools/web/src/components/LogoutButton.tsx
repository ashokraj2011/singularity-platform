"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { clearAgentToolsToken, notifyAuthChanged } from "@/lib/api";

/** Top-bar logout: clears the stored token(s) and returns to the unified home. */
export function LogoutButton() {
  const router = useRouter();

  function handleLogout() {
    try {
      clearAgentToolsToken();
      // authHeaders() also reads these fallbacks — clear them for a full sign-out.
      for (const k of ["agent-tools-token", "auth-token", "token", "singularity-portal.auth", "workgraph-auth", "iam-auth"]) localStorage.removeItem(k);
    } catch {
      /* ignore storage errors */
    }
    // Flip the front-door gate immediately — covers logging out while already on
    // "/", where router.push won't change the path and re-trigger a re-check.
    notifyAuthChanged();
    router.push("/");
    router.refresh();
  }

  return (
    <button
      onClick={handleLogout}
      title="Log out"
      aria-label="Log out"
      style={{
        width: 32,
        height: 32,
        borderRadius: 10,
        border: "1px solid var(--color-outline-variant)",
        background: "transparent",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--color-outline)",
        transition: "all 0.15s",
      }}
    >
      <LogOut size={15} />
    </button>
  );
}
