"use client";

import dynamic from "next/dynamic";

const LegacyArtifactDesignerRoute = dynamic(
  () => import("@/components/workflows/LegacyWorkgraphAdminRoute").then((module) => module.LegacyArtifactDesignerRoute),
  {
    ssr: false,
    loading: () => <div className="card" style={{ padding: 24, color: "var(--color-outline)" }}>Loading artifact designer...</div>,
  },
);

export default function WorkflowArtifactsDesignerPage() {
  return <LegacyArtifactDesignerRoute />;
}
