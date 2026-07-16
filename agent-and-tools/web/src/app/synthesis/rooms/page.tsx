"use client";

import { Suspense } from "react";
import { AssumptionRoomScreen } from "@/components/synthesis/screens/AssumptionRoomScreen";

export default function RoomsPage() {
  return (
    <Suspense fallback={null}>
      <AssumptionRoomScreen />
    </Suspense>
  );
}
