"use client";

import dynamic from "next/dynamic";

const LegacyArtifactsExplorerRoute = dynamic(
  () => import("@/components/workflows/LegacyWorkgraphAdminRoute").then((module) => module.LegacyArtifactsExplorerRoute),
  {
    ssr: false,
    loading: () => <div className="card" style={{ padding: 24, color: "var(--color-outline)" }}>Loading artifacts explorer...</div>,
  },
);

export default function WorkflowArtifactsExplorerPage() {
  return <LegacyArtifactsExplorerRoute />;
}
