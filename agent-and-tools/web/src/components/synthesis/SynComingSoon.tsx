"use client";

import type { LucideIcon } from "lucide-react";
import { SynthesisShell } from "@/components/synthesis/SynthesisShell";
import { EmptyState } from "@/components/synthesis/ui/kit";

/**
 * Placeholder surface used by Synthesis screens that are scaffolded but whose
 * full data-wiring lands in a later slice. Renders inside the standard shell so
 * navigation, theming, and the offline boundary all work end-to-end.
 */
export function SynComingSoon({
  title,
  icon,
  description,
}: {
  title: string;
  icon: LucideIcon;
  description: string;
}) {
  return (
    <SynthesisShell title={title}>
      <EmptyState icon={icon} title={`${title} — coming online`} description={description} />
    </SynthesisShell>
  );
}
