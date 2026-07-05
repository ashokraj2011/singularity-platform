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
      },
    },
  },
  plugins: [],
};
export default config;
