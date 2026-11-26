import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const runtimeEnv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const env = { ...loadEnv(mode, '.', ''), ...runtimeEnv }
  const value = Number(env.AI_PORT || 8787)
  const port = Number.isInteger(value) && value > 0 && value <= 65535 ? value : 8787
  const apiBase = mode === 'sites' ? '/functions/v1/app/api' : env.VITE_API_BASE_URL || '/api'
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(apiBase)) throw new Error('VITE_API_BASE_URL 必须是不含末尾斜线的同源绝对路径。')
  const gatewayPort = Number(env.PAPERFLOW_GATEWAY_PORT || 8790)
  const configure: ProxyOptions['configure'] = proxy => {
    proxy.on('proxyReq', (proxyRequest, _request, response) => {
      response.once('close', () => { if (!response.writableEnded) proxyRequest.destroy() })
    })
  }
  const proxy = {
    '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: true, configure },
    '/functions/v1/app': { target: `http://127.0.0.1:${gatewayPort}`, changeOrigin: true, configure },
  }
  return {
    base: '/',
    appType: 'spa',
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(apiBase) },
    plugins: [react(), tailwindcss(), {
      name: 'production-script-policy',
      apply: 'build',
      transformIndexHtml() {
        return [{
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'self'",
          },
          injectTo: 'head-prepend',
        }]
      },
    }],
    server: { host: '127.0.0.1', proxy },
    preview: { host: '127.0.0.1', proxy },
  }
})
