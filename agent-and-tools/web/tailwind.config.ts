import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans:    ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["'Public Sans'", "ui-sans-serif", "system-ui", "sans-serif"],
        mono:    ["ui-monospace", "'SFMono-Regular'", "Menlo", "monospace"],
      },
      colors: {
        singularity: {
          50:  "#f0fdf4",
          100: "#dcfce7",
          200: "#bbf7d0",
          300: "#86efac",
          400: "#4ade80",
          500: "#22c55e",
          600: "#00843D",   /* brand primary */
          700: "#006227",   /* brand dark */
          800: "#14532d",
          900: "#052e16",
        },
      },
    },
  },
  plugins: [],
};
export default config;
