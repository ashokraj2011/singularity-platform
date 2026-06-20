"use client";

import { Suspense } from "react";
import { WorkbenchConsole } from "@/components/workbench/WorkbenchConsole";

type WorkbenchRouteProps = {
  mode?: "cockpit" | "theater";
  view?: "cockpit" | "artifacts" | "code-review" | "stage-chat" | "milestones" | "export" | "audit" | "governance" | "loop-theater";
  fallback?: string;
};

export function WorkbenchRoute({ mode = "cockpit", view, fallback = "Loading Workbench..." }: WorkbenchRouteProps) {
  return (
    <Suspense fallback={<section className="card" style={{ padding: 28, color: "var(--color-outline)" }}>{fallback}</section>}>
      <WorkbenchConsole mode={mode} view={view} />
    </Suspense>
  );
}
