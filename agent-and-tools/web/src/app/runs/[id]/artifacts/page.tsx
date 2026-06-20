"use client";

import dynamic from "next/dynamic";

const RunSurfaceRoute = dynamic(
  () => import("@/components/workflows/RunSurfaceRoute").then((module) => module.RunSurfaceRoute),
  {
    ssr: false,
    loading: () => <div className="card" style={{ padding: 24, color: "var(--color-outline)" }}>Loading artifacts...</div>,
  },
);

export default function RunArtifactsPage() {
  return <RunSurfaceRoute />;
}
