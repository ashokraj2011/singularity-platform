import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans:    ["Hanken Grotesk", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["'Source Serif 4'", "Georgia", "'Times New Roman'", "serif"],
        mono:    ["'JetBrains Mono'", "ui-monospace", "'SFMono-Regular'", "Menlo", "monospace"],
      },
      colors: {
        singularity: {
          50:  "#fbf3ee",
          100: "#f6e2d6",
          200: "#ecc4ad",
          300: "#e0a17d",
          400: "#d07d52",
          500: "#c15f3c",
          600: "#a24428",   /* brand primary (oxblood clay) */
          700: "#7d3319",   /* brand dark */
          800: "#6f3319",
          900: "#4e2513",
        },
        /* ─── Synthesis app ("Ethos & Form") tokens ────────────────────────
         * Purely additive utility colors (bg-surface-container-low, etc.).
         * Values resolve from `--syn-*` CSS variables that are only defined
         * under the `.synthesis-root` scope (see app/synthesis/synthesis.css),
         * so these utilities have no effect outside the Synthesis subtree. */
        "surface":                    "var(--syn-surface, #fcf9f4)",
        "surface-dim":                "var(--syn-surface-dim, #dcdad5)",
        "surface-bright":             "var(--syn-surface-bright, #fcf9f4)",
        "surface-container-lowest":   "var(--syn-surface-container-lowest, #ffffff)",
        "surface-container-low":      "var(--syn-surface-container-low, #f6f3ee)",
        "surface-container":          "var(--syn-surface-container, #f0ede9)",
        "surface-container-high":     "var(--syn-surface-container-high, #ebe8e3)",
        "surface-container-highest":  "var(--syn-surface-container-highest, #e5e2dd)",
        "surface-variant":            "var(--syn-surface-variant, #e5e2dd)",
        "surface-tint":               "var(--syn-surface-tint, #5f5e5c)",
        "on-surface":                 "var(--syn-on-surface, #1c1c19)",
        "on-surface-variant":         "var(--syn-on-surface-variant, #464741)",
        "inverse-surface":            "var(--syn-inverse-surface, #31302d)",
        "inverse-on-surface":         "var(--syn-inverse-on-surface, #f3f0eb)",
        "outline":                    "var(--syn-outline, #777771)",
        "outline-variant":            "var(--syn-outline-variant, #c7c7bf)",
        "primary":                    "var(--syn-primary, #040404)",
        "on-primary":                 "var(--syn-on-primary, #ffffff)",
        "primary-container":          "var(--syn-primary-container, #1e1e1c)",
        "on-primary-container":       "var(--syn-on-primary-container, #878683)",
        "inverse-primary":            "var(--syn-inverse-primary, #c8c6c3)",
        "secondary":                  "var(--syn-secondary, #4e625f)",
        "on-secondary":               "var(--syn-on-secondary, #ffffff)",
        "secondary-container":        "var(--syn-secondary-container, #cee4df)",
        "on-secondary-container":     "var(--syn-on-secondary-container, #526763)",
        "tertiary":                   "var(--syn-tertiary, #080300)",
        "on-tertiary":                "var(--syn-on-tertiary, #ffffff)",
        "tertiary-container":         "var(--syn-tertiary-container, #281b09)",
        "on-tertiary-container":      "var(--syn-on-tertiary-container, #978269)",
        "error":                      "var(--syn-error, #ba1a1a)",
        "on-error":                   "var(--syn-on-error, #ffffff)",
        "error-container":            "var(--syn-error-container, #ffdad6)",
        "on-error-container":         "var(--syn-on-error-container, #93000a)",
        "background":                 "var(--syn-background, #fcf9f4)",
        "on-background":              "var(--syn-on-background, #1c1c19)",
      },
    },
  },
  plugins: [],
};
export default config;
