"use client";

import { Suspense } from "react";
import { DiscoveryBoardScreen } from "@/components/synthesis/screens/DiscoveryBoardScreen";

export default function DiscoveryPage() {
  return (
    <Suspense fallback={null}>
      <DiscoveryBoardScreen />
    </Suspense>
  );
}
