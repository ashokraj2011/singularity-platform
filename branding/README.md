# Singularity — Brand Assets

Single source of truth for the Singularity logo, color tokens, typography, and
guidance for placing them across every app in the platform.

## Drop the logo here

Save the official PNG as:

```
branding/singularity-logo.png      ← full mark (silver swirl + "Singularity / Governed Agentic Delivery")
branding/singularity-mark.png      ← optional, swirl only (for tight headers / favicons)
```

Then run:

```bash
./bin/sync-branding.sh             # copies into each app's public/ directory
```

That single command refreshes the asset in:

- `singularity-portal/public/`
- `UserAndCapabillity/public/`
- `agent-and-tools/web/public/`
- `workgraph-studio/apps/web/public/`

Re-run any time the source PNG changes.

## Tagline

> **Governed Agentic Delivery**

Always lockup beneath the wordmark. Use the same warm-white as the wordmark, slightly lighter weight.

## Colors (CSS custom properties)

See `tokens.css`. Key values:

| Token | Hex | Use |
|-------|-----|-----|
| `--brand-forest` | `#0E3B2D` | sidebar background, hero panels |
| `--brand-forest-deep` | `#082821` | sidebar bottom band, footers |
| `--brand-forest-light` | `#155041` | hover surface on dark bg |
| `--brand-green` | `#00843D` | primary action, active nav border |
| `--brand-green-dark` | `#006236` | button hover |
| `--brand-green-accent` | `#00A651` | active icon, success |
| `--brand-warm-white` | `#F5F2EA` | text on dark, wordmark |
| `--brand-silver` | `#C9CCD1` | muted text on dark |
| `--brand-red-pulse` | `#E63946` | the singular red dot in the swirl (use sparingly — never as bg) |
| `--surface-light` | `#F0F4F8` | app body background |
| `--surface-card` | `#FFFFFF` | cards |
| `--surface-border` | `#E2E8F0` | hairline borders |
| `--text-strong` | `#0A2240` | headings on light bg (kept navy for contrast) |
| `--text-muted` | `#64748b` | secondary text |

## Typography

- **Wordmark**: Inter 700, tracked +0.04em, warm white
- **Tagline**: Inter 400 / 500, tracked +0.08em, ~70% opacity
- **Body**: Inter 400, 14px base
- **Numbers in tiles**: Inter 600, tabular-nums

## Placement rules

1. **Top-left of every sidebar**: silver swirl (40px–48px), wordmark beside it, tagline beneath in caps tracking-widest.
2. **Login pages**: full lockup centered above the form.
3. **Tab title**: every app sets `<title>Singularity — <App Name></title>`.
4. **Favicon**: `singularity-mark.png` (swirl only) → `public/favicon.png`.
5. **Never**: rotate the swirl, change the red dot color, place the mark on busy gradients, or stretch the lockup.

## How each app picks up the assets

Every frontend reads from its own `public/` directory at build time. The
`bin/sync-branding.sh` script keeps them in sync with the canonical files
here. If you tweak the brand, change it once in this folder and re-run the
script.
