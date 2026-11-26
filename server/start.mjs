import { ConfigurationError } from './config.mjs'
import { logEvent } from './http-security.mjs'

process.env.NODE_ENV = 'production'
try {
  await import('./server.mjs')
} catch (error) {
  logEvent('startup_failed', { category: error instanceof ConfigurationError ? 'configuration' : 'dependency_or_schema', ...(error instanceof ConfigurationError ? { field: error.field } : {}) })
  process.exit(1)
}
