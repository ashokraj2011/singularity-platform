"use client";

import { Suspense } from "react";
import { IdeaWallScreen } from "@/components/synthesis/screens/IdeaWallScreen";

export default function IdeasPage() {
  return (
    <Suspense fallback={null}>
      <IdeaWallScreen />
    </Suspense>
  );
}
