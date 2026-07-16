"use client";

import { FileText } from "lucide-react";
import { SynComingSoon } from "@/components/synthesis/SynComingSoon";

export default function SpecPage() {
  return (
    <SynComingSoon
      title="Spec & Traceability"
      icon={FileText}
      description="Converge the specification and trace every requirement to its origin and tickets."
    />
  );
}
