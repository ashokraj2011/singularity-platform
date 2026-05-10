/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        // Singularity brand palette (matches UserAndCapabillity)
        navy: {
          DEFAULT: '#0A2240',
          light: '#0D2D52',
          dark: '#071829',
        },
        brand: {
          // Green accents
          DEFAULT: '#00843D',
          dark: '#006236',
          accent: '#00A651',
          light: '#e6f4ed',
        },
        surface: '#F0F4F8',
      },
    },
  },
  plugins: [],
}
