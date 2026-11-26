import { randomUUID, timingSafeEqual } from 'node:crypto'

export function logEvent(event, fields = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }))
}

export function installHttpSecurity(app, config) {
  app.disable('x-powered-by')
  app.set('trust proxy', config.trustedProxies.length ? config.trustedProxies : false)
  app.use((req, res, next) => {
    req.requestId = randomUUID()
    res.setHeader('X-Request-ID', req.requestId)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    const started = performance.now()
    if (config.production) res.on('finish', () => logEvent('http_request', { requestId: req.requestId, method: req.method, route: req.route?.path || 'unmatched', status: res.statusCode, durationMs: Math.round(performance.now() - started) }))
    const deny = () => res.status(403).json({ error: '不允许的请求来源。', requestId: req.requestId })
    if (!config.allowedHosts.has((req.get('host') || '').toLowerCase())) return deny()
    const health = ['/health/live', '/health/ready'].includes(req.path) && ['GET', 'HEAD'].includes(req.method)
    if (health) return next()
    if (config.production && !req.secure) return deny()
    if (config.mode === 'sites') {
      const token = Buffer.from(req.get('x-paperflow-gateway-token') || '')
      const expected = Buffer.from(config.gatewayToken)
      if (token.length !== expected.length || !timingSafeEqual(token, expected)) return deny()
    }
    const origin = req.get('origin')
    if ((origin && !config.origins.has(origin)) || (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !origin)) return deny()
    if (req.get('sec-fetch-site') === 'cross-site') return deny()
    // Both deployment modes are same-origin; no credentialed cross-site CORS is enabled.
    next()
  })
}
