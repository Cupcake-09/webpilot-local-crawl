/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        chat: {
          bg: '#0D0D0D',
          side: '#171717',
          card: '#212121',
          hover: '#2A2A2A',
          border: '#2F2F2F',
          text: '#ECECEC',
          muted: '#9B9B9B',
          key: '#1E293B',
          accent: '#38BDF8',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'sans-serif'],
      },
      keyframes: {
        rise: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        rise: 'rise 0.35s ease-out both',
      },
    },
  },
  plugins: [],
}
