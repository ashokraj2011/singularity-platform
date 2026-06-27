"use client";

import dynamic from "next/dynamic";

// The blue Blueprint Workbench cockpit now runs IN-PROCESS as this Next route
// (no standalone :5176 Vite server, no :8085 gateway). Client-only — the
// cockpit reads window/localStorage — so ssr:false, same pattern as the run
// cockpit (runs/[id]/page.tsx).
const WorkbenchCockpit = dynamic(() => import("@/components/workbench/WorkbenchCockpit"), {
  ssr: false,
  loading: () => <div style={{ padding: 24, color: "var(--color-outline)" }}>Loading Workbench…</div>,
});

export default function WorkbenchDomainPage() {
  return <WorkbenchCockpit />;
}
