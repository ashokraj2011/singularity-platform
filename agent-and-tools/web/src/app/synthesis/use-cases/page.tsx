"use client";

import { Boxes } from "lucide-react";
import { SynComingSoon } from "@/components/synthesis/SynComingSoon";

export default function UseCasesPage() {
  return (
    <SynComingSoon
      title="Use-Case Registry"
      icon={Boxes}
      description="Track business use-case maturity and downstream dependencies."
    />
  );
}
