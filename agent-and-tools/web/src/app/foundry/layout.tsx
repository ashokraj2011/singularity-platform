import type { ReactNode } from "react";
import { redirect } from "next/navigation";

export default function FoundryDisabledLayout({ children: _children }: { children: ReactNode }) {
  redirect("/workflows");
}
