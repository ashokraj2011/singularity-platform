import "./synthesis.css";

/**
 * Route-group layout for the Synthesis app. Its only job is to pull in the
 * scoped "Ethos & Form" theme stylesheet; each page renders its own
 * <SynthesisShell> so it can set the header title and actions. The platform
 * AppShell drops to full-bleed for /synthesis (see FULL_BLEED_PREFIXES).
 */
export default function SynthesisLayout({ children }: { children: React.ReactNode }) {
  return children;
}
