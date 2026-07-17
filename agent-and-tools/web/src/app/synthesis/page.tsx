"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

/**
 * Navigate only after the client session gate renders this route. Throwing a
 * server redirect below RequireSession can become an unhandled rejection while
 * the gate is showing sign-in or reacting to an auth-state change.
 */
export default function SynthesisIndex() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/synthesis/hub");
  }, [router]);

  return (
    <div className="grid h-screen place-items-center bg-surface text-on-surface-variant">
      <div className="text-center">
        <Loader2 size={20} className="mx-auto animate-spin text-secondary" />
        <p className="mt-3 text-sm font-semibold">Opening Synthesis workspace</p>
        <Link href="/synthesis/hub" className="mt-2 inline-block text-xs text-secondary underline">
          Open workspace hub
        </Link>
      </div>
    </div>
  );
}
