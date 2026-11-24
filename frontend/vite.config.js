import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Rivet Local dashboard — fixed on http://localhost:3000
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    strictPort: true,
    host: 'localhost',
    open: false,
  },
  preview: {
    port: 3000,
    strictPort: true,
  },
})
