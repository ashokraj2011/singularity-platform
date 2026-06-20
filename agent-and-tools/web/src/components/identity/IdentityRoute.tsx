"use client";

import { IdentityConsole } from "@/components/identity/IdentityConsole";
import type { IdentityView } from "@/lib/identity/api";

export function IdentityRoute({ view = "dashboard" }: { view?: IdentityView }) {
  return <IdentityConsole view={view} />;
}
