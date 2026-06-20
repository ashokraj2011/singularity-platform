"use client";

import dynamic from "next/dynamic";

const LegacyArtifactEditorRoute = dynamic(
  () => import("@/components/workflows/LegacyWorkgraphAdminRoute").then((module) => module.LegacyArtifactEditorRoute),
  {
    ssr: false,
    loading: () => <div className="card" style={{ padding: 24, color: "var(--color-outline)" }}>Loading artifact editor...</div>,
  },
);

export function ArtifactEditorClient({ artifactId }: { artifactId: string }) {
  return <LegacyArtifactEditorRoute artifactId={artifactId} />;
}
