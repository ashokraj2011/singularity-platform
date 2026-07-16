"use client";

import { Lightbulb } from "lucide-react";
import { SynComingSoon } from "@/components/synthesis/SynComingSoon";

export default function IdeasPage() {
  return (
    <SynComingSoon
      title="Idea Wall"
      icon={Lightbulb}
      description="Capture raw ideas and let AI parse them into structured claims and questions."
    />
  );
}
