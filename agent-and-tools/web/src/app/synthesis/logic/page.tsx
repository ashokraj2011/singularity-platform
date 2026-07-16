"use client";

import { Binary } from "lucide-react";
import { SynComingSoon } from "@/components/synthesis/SynComingSoon";

export default function LogicPage() {
  return (
    <SynComingSoon
      title="Logic Console"
      icon={Binary}
      description="Surface contradictions and consistency gaps across requirements."
    />
  );
}
