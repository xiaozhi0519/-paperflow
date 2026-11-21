import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const runtimeEnv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const value = Number(runtimeEnv?.AI_PORT || loadEnv(mode, '.', 'AI_PORT').AI_PORT || 8787)
  const port = Number.isInteger(value) && value > 0 && value <= 65535 ? value : 8787
  const proxy = { '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: true } }
  return {
    plugins: [react(), tailwindcss()],
    server: { host: '127.0.0.1', proxy },
    preview: { host: '127.0.0.1', proxy },
  }
})
