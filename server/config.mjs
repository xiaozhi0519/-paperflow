import { isIP } from 'node:net'
import { postgresConnection } from './database.mjs'
import { readStorageConfig } from './object-storage.mjs'

export class ConfigurationError extends Error {
  constructor(field) { super(`服务配置不合法或缺失：${field}`); this.field = field }
}

export function readServerConfig(env = process.env) {
  const production = env.NODE_ENV === 'production'
  const port = Number(env.AI_PORT || 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigurationError('AI_PORT')
  const host = env.BIND_HOST || '127.0.0.1'
  if (!isIP(host)) throw new ConfigurationError('BIND_HOST')
  const origins = (env.AI_ALLOWED_ORIGINS || (production ? '' : 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173,http://localhost:4173')).split(',').map(value => value.trim()).filter(Boolean)
  if (!origins.length) throw new ConfigurationError('AI_ALLOWED_ORIGINS')
  for (const origin of origins) {
    try {
      const url = new URL(origin)
      if (url.origin !== origin || url.username || url.password || !(production ? url.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) : ['http:', 'https:'].includes(url.protocol))) throw new Error()
    } catch { throw new ConfigurationError('AI_ALLOWED_ORIGINS') }
  }
  const allowedHosts = (env.ALLOWED_HOSTS || (production ? '' : `127.0.0.1:${port},localhost:${port}`)).split(',').map(value => value.trim()).filter(Boolean)
  if (!allowedHosts.length || allowedHosts.some(value => !/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d{1,5})?$/i.test(value))) throw new ConfigurationError('ALLOWED_HOSTS')
  const trustedProxies = (env.TRUSTED_PROXIES || '').split(',').map(value => value.trim()).filter(Boolean)
  if (production && !trustedProxies.length) throw new ConfigurationError('TRUSTED_PROXIES')
  if (trustedProxies.some(value => {
    const [ip, mask, extra] = value.split('/')
    const family = isIP(ip)
    return !family || extra !== undefined || (mask !== undefined && (!/^\d+$/.test(mask) || Number(mask) === 0 || Number(mask) > (family === 4 ? 32 : 128)))
  })) throw new ConfigurationError('TRUSTED_PROXIES')
  const mode = env.DEPLOYMENT_MODE || (production ? '' : 'same-origin')
  if (!['sites', 'same-origin'].includes(mode)) throw new ConfigurationError('DEPLOYMENT_MODE')
  const gatewayToken = env.APP_GATEWAY_TOKEN || ''
  if (mode === 'sites' && !/^[A-Za-z0-9_-]{43,128}$/.test(gatewayToken)) throw new ConfigurationError('APP_GATEWAY_TOKEN')
  if (production && (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)) throw new ConfigurationError('SESSION_SECRET')
  try { postgresConnection(env) } catch { throw new ConfigurationError('DATABASE_URL / PG_SSL_MODE / PG_SSL_CA_FILE') }
  try { readStorageConfig(env) } catch { throw new ConfigurationError('S3_*') }
  if (production && [env.AI_BASE_URL, env.AI_MODEL, env.AI_API_KEY].some(value => value?.trim())) throw new ConfigurationError('AI_*（生产 AI 尚未完成授权与证据验收，请保持空配置）')
  return { production, port, host, origins: new Set(origins), allowedHosts: new Set(allowedHosts.map(value => value.toLowerCase())), trustedProxies, mode, gatewayToken }
}
