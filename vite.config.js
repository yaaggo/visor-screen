import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './', // relativo: funciona na Vercel e no Electron (file://)
  plugins: [react()],
  server: { port: 5173 },
})
