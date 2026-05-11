"use client";

// M23 — legacy /agent-templates flat list replaced by /agent-studio.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AgentTemplatesLegacyRedirect() {
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
