"use client";

import Link from "next/link";
import { useEffect } from "react";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";

export default function WorkbenchError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Workbench route failed", error);
  }, [error]);

  function reloadPage() {
    window.location.reload();
  }

  return (
    <section className="card" style={{ maxWidth: 760, padding: 24, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#991b1b", fontWeight: 850, marginBottom: 10 }}>
        <AlertTriangle size={20} />
        Workbench could not finish loading.
      </div>
      <p style={{ color: "var(--color-outline)", lineHeight: 1.55, margin: "0 0 16px", fontSize: 14 }}>
        The Workbench shell is still available. Retry the route first; if the browser kept an old client bundle after a rebuild, reload the page.
      </p>
      {error?.message ? (
        <div style={{ border: "1px solid rgba(185,28,28,0.2)", background: "rgba(254,242,242,0.72)", borderRadius: 8, padding: 12, color: "#7f1d1d", fontSize: 12, marginBottom: 16, overflowWrap: "anywhere" }}>
          {error.message}
          {error.digest ? ` (${error.digest})` : ""}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn-primary" onClick={reset}>
          <RotateCcw size={15} />
          Retry Workbench
        </button>
        <button type="button" className="btn-secondary" onClick={reloadPage}>
          <RefreshCw size={15} />
          Reload page
        </button>
        <Link href="/workbench" className="btn-secondary">
          Open Workbench
        </Link>
      </div>
    </section>
  );
}
