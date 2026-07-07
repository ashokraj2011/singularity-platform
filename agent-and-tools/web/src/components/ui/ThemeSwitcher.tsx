"use client";

import { useEffect, useState } from "react";
import { Check, Palette } from "lucide-react";
import { useTheme } from "next-themes";

type PlatformTheme = "current" | "fidelity-green";

const themeOptions: Array<{
  id: PlatformTheme;
  label: string;
  description: string;
  swatch: string;
}> = [
  {
    id: "current",
    label: "Current",
    description: "Warm ivory and clay command center.",
    swatch: "linear-gradient(135deg, #fbfaf6 0%, #a24428 100%)",
  },
  {
    id: "fidelity-green",
    label: "Fidelity Green",
    description: "Green and navy enterprise workspace.",
    swatch: "linear-gradient(135deg, #f7faf7 0%, #368727 55%, #0A2240 100%)",
  },
];

function isPlatformTheme(value: string | undefined): value is PlatformTheme {
  return value === "current" || value === "fidelity-green";
}

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const activeTheme: PlatformTheme = mounted && isPlatformTheme(theme) ? theme : "current";

  if (compact) {
    const nextTheme: PlatformTheme = activeTheme === "current" ? "fidelity-green" : "current";
    const activeOption = themeOptions.find((option) => option.id === activeTheme) ?? themeOptions[0];
    return (
      <button
        type="button"
        onClick={() => setTheme(nextTheme)}
        aria-label={`Theme: ${activeOption.label}. Switch theme.`}
        title={`Theme: ${activeOption.label}`}
        className="theme-switcher-compact"
      >
        <Palette size={15} />
        <span className="theme-switcher-dot" style={{ background: activeOption.swatch }} />
      </button>
    );
  }

  return (
    <div className="theme-switcher-grid" role="radiogroup" aria-label="Platform theme">
      {themeOptions.map((option) => {
        const active = option.id === activeTheme;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(option.id)}
            className={`theme-choice${active ? " active" : ""}`}
          >
            <span className="theme-choice-swatch" style={{ background: option.swatch }} />
            <span className="theme-choice-copy">
              <span className="theme-choice-label">{option.label}</span>
              <span className="theme-choice-description">{option.description}</span>
            </span>
            <span className="theme-choice-check" aria-hidden="true">
              {active && <Check size={14} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
