/**
 * ELM Studio design tokens — Linear-grade minimal: precise near-black neutrals, hairline depth (borders
 * are low-opacity white, not gray boxes), one restrained indigo accent, refined semantics. Returns a
 * scoped CSS-variable override object that re-skins the platform `--color-*` tokens (so every existing
 * studio surface inherits the look for free) AND defines `--studio-*` chrome tokens. Applied inline on
 * the StudioShell container, so only /studio adopts it — the rest of the light platform is untouched.
 */
export function studioTokens(): Record<string, string> {
  return {
    // ── Re-skin the platform tokens the shared components consume ──
    "--color-primary": "#7c7cf5",
    "--color-primary-dim": "rgba(124,124,245,0.13)",
    "--color-primary-glow": "rgba(124,124,245,0.35)",
    "--color-primary-hover-border": "rgba(124,124,245,0.35)",
    "--color-secondary": "#9a9aff",
    "--color-secondary-dim": "rgba(124,124,245,0.13)",
    "--color-surface": "#101013",
    "--color-surface-bright": "#141418",
    "--color-surface-high": "#17171c",
    "--color-surface-container": "#141418",
    "--color-surface-low": "#0d0d10",
    "--color-card": "#101013",
    "--color-on-surface": "#f2f2f5",
    "--color-on-surface-variant": "#b4b4bd",
    "--color-outline": "#82828e",
    "--color-outline-variant": "rgba(255,255,255,0.07)", // hairline — the key refinement
    "--color-success": "#52d788",
    "--color-warning": "#f5c451",
    "--color-danger": "#f77b7b",
    "--color-focus-ring": "#7c7cf5",
    "--shadow-card": "0 1px 2px rgba(0,0,0,0.4), 0 8px 24px -14px rgba(0,0,0,0.6)",

    // ── Bespoke studio chrome (near-black elevation ladder) ──
    "--studio-bg": "#08080a",
    "--studio-chrome": "#0c0c0f",
    "--studio-panel": "#101013",
    "--studio-panel-2": "#141418",
    "--studio-elev": "#17171c",
    "--studio-line": "rgba(255,255,255,0.07)",
    "--studio-line-2": "rgba(255,255,255,0.11)",
    "--studio-line-soft": "rgba(255,255,255,0.05)",
    "--studio-ink": "#f2f2f5",
    "--studio-ink-dim": "#b4b4bd",
    "--studio-muted": "#82828e",
    "--studio-faint": "#56565f",
    "--studio-accent": "#7c7cf5",
    "--studio-accent-2": "#9a9aff",
    "--studio-accent-soft": "rgba(124,124,245,0.13)",
    "--studio-accent-line": "rgba(124,124,245,0.35)",
    "--studio-accent-ink": "#ffffff",
    "--studio-live": "#52d788",
    "--studio-live-soft": "rgba(82,215,136,0.12)",
    "--studio-good": "#52d788",
    "--studio-good-soft": "rgba(82,215,136,0.12)",
    "--studio-warn": "#f5c451",
    "--studio-warn-soft": "rgba(245,196,81,0.12)",
    "--studio-bad": "#f77b7b",
    "--studio-bad-soft": "rgba(247,123,123,0.12)",

    // Persona avatar palette (refined)
    "--studio-p1": "#7c7cf5",
    "--studio-p2": "#f0a35e",
    "--studio-p3": "#52d788",
    "--studio-p4": "#f77b7b",
    "--studio-p5": "#5ab0f0",
    "--studio-p6": "#e0c14a",

    "--studio-mono": 'ui-monospace, "SF Mono", "JetBrains Mono", "Fira Code", monospace',
    "--studio-shadow": "0 1px 2px rgba(0,0,0,0.4), 0 8px 24px -14px rgba(0,0,0,0.6)",
  };
}
