"use client";

import dynamic from "next/dynamic";

const LegacyNodeTypesRoute = dynamic(
  () => import("@/components/workflows/LegacyWorkgraphAdminRoute").then((module) => module.LegacyNodeTypesRoute),
  {
    ssr: false,
    loading: () => <div className="card" style={{ padding: 24, color: "var(--color-outline)" }}>Loading node types...</div>,
  },
);

export default function WorkflowNodeTypesPage() {
  return <LegacyNodeTypesRoute />;
}
