"use client";

import { Suspense } from "react";
import { LogicConsoleScreen } from "@/components/synthesis/screens/LogicConsoleScreen";

export default function LogicPage() {
  return (
    <Suspense fallback={null}>
      <LogicConsoleScreen />
    </Suspense>
  );
}
