"use client";

import { Suspense } from "react";
import { FoundryConsole } from "@/components/foundry/FoundryConsole";

type FoundryView = "runs" | "artifacts" | "gaps" | "tasks" | "receipts" | "repos" | "plans" | "verification" | "history";

export function FoundryRoute({ view = "runs" }: { view?: FoundryView }) {
  return (
    <Suspense fallback={<section className="card" style={{ padding: 28, color: "var(--color-outline)" }}>Loading Code Foundry...</section>}>
      <FoundryConsole view={view} />
    </Suspense>
  );
}
