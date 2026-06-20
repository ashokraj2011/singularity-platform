"use client";

// M23 — legacy /agent-templates flat list replaced by /agents/studio.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AgentTemplatesLegacyRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/agents/studio");
  }, [router]);
  return (
    <div className="text-sm text-slate-500">
      Redirecting to <a href="/agents/studio" className="text-emerald-600 underline">/agents/studio</a>…
    </div>
  );
}
