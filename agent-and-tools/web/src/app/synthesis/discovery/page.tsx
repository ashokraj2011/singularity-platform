"use client";

import { Network } from "lucide-react";
import { SynComingSoon } from "@/components/synthesis/SynComingSoon";

export default function DiscoveryPage() {
  return (
    <SynComingSoon
      title="Discovery Board"
      icon={Network}
      description="A canvas for reducing unknowns — questions, assumptions, and claims."
    />
  );
}
