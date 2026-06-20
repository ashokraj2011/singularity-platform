import { Suspense } from "react";
import { WorkflowManager } from "@/components/workflows/WorkflowManager";

export function WorkflowRunsRoute() {
  return (
    <Suspense fallback={<div className="card" style={{ padding: 24, color: "var(--color-outline)" }}>Loading workflow runs...</div>}>
      <WorkflowManager initialTab="runs" />
    </Suspense>
  );
}
