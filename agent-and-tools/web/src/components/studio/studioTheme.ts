/**
 * ELM Studio design tokens — the dark, indigo-iris palette from the studio walkthrough. Returns a
 * scoped CSS-variable override object: it re-skins the platform `--color-*` tokens (so existing
 * studio components inherit the dark studio look for free) AND adds `--studio-*` chrome tokens for
 * the bespoke shell. Applied as an inline style on the StudioShell container, so only /studio goes
 * dark — the rest of the (light) platform is untouched.
 */
export function studioTokens(): Record<string, string> {
  return {
    // Re-skin the platform tokens the shared components consume
    "--color-primary": "#7c6cff",
    "--color-primary-dim": "rgba(124,108,255,0.16)",
    "--color-primary-glow": "rgba(124,108,255,0.40)",
    "--color-primary-hover-border": "#9d8dff",
    "--color-secondary": "#38bdf8",
    "--color-secondary-dim": "rgba(56,189,248,0.16)",
    "--color-surface": "#151827",
    "--color-surface-bright": "#1b1f31",
    "--color-surface-high": "#1b1f31",
    "--color-surface-container": "#1b1f31",
    "--color-surface-low": "#10121d",
    "--color-card": "#151827",
    "--color-on-surface": "#eaecf6",
    "--color-on-surface-variant": "#a7adc6",
    "--color-outline": "#6f7594",
    "--color-outline-variant": "#262b40",
    "--color-success": "#3ecf8e",
    "--color-warning": "#f5b544",
    "--color-danger": "#f2688a",
    "--color-focus-ring": "#7c6cff",
    "--shadow-card": "0 18px 50px -22px rgba(0,0,0,0.7)",

    // Bespoke studio chrome
    "--studio-bg": "#0b0d16",
    "--studio-chrome": "#10121d",
    "--studio-panel": "#151827",
    "--studio-panel-2": "#1b1f31",
    "--studio-line": "#262b40",
    "--studio-line-soft": "#1e2233",
    "--studio-ink": "#eaecf6",
    "--studio-ink-dim": "#a7adc6",
    "--studio-muted": "#6f7594",
    "--studio-faint": "#474d69",
    "--studio-accent": "#7c6cff",
    "--studio-accent-2": "#9d8dff",
    "--studio-accent-soft": "rgba(124,108,255,0.16)",
    "--studio-accent-ink": "#ffffff",
    "--studio-live": "#38d2f0",
    "--studio-live-soft": "rgba(56,210,240,0.16)",
    "--studio-good": "#3ecf8e",
    "--studio-warn": "#f5b544",
    "--studio-bad": "#f2688a",

    // Persona avatar palette
    "--studio-p1": "#7c6cff",
    "--studio-p2": "#ef8f5b",
    "--studio-p3": "#3ecf8e",
    "--studio-p4": "#f2688a",
    "--studio-p5": "#38bdf8",
    "--studio-p6": "#d8a24a",

    "--studio-mono": 'ui-monospace, "SF Mono", "JetBrains Mono", "Fira Code", monospace',
  };
}
