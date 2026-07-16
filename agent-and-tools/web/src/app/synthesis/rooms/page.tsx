"use client";

import { MessagesSquare } from "lucide-react";
import { SynComingSoon } from "@/components/synthesis/SynComingSoon";

export default function RoomsPage() {
  return (
    <SynComingSoon
      title="Assumption Rooms"
      icon={MessagesSquare}
      description="Validate assumptions and contested claims through guided probes."
    />
  );
}
