"use client";

import { LayoutDashboard } from "lucide-react";
import { SynComingSoon } from "@/components/synthesis/SynComingSoon";

export default function OverviewPage() {
  return (
    <SynComingSoon
      title="System Overview"
      icon={LayoutDashboard}
      description="Health metrics and a live activity feed across every initiative."
    />
  );
}
