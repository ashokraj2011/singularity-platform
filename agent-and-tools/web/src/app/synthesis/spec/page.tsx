"use client";

import { Suspense } from "react";
import { SpecTraceabilityScreen } from "@/components/synthesis/screens/SpecTraceabilityScreen";

export default function SpecPage() {
  return (
    <Suspense fallback={null}>
      <SpecTraceabilityScreen />
    </Suspense>
  );
}
