"use client";

// M23 — legacy /agents flat list replaced by /agent-studio. Hard redirect on
// the client so any bookmark / muscle-memory link still lands somewhere useful.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AgentsLegacyRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/agent-studio");
  }, [router]);
  return (
    <div className="text-sm text-slate-500">
      Redirecting to <a href="/agent-studio" className="text-emerald-600 underline">/agent-studio</a>…
    </div>
  );
}
