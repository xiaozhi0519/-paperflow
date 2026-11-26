const MAX_BODY = 20 * 1024 * 1024 + 64 * 1024
const id = '[0-9a-fA-F-]{36}'
const routes = [
  ['GET', '^/api/(health|auth/me|ai/status|workspaces|papers|knowledge)$'],
  ['POST', '^/api/(auth/(register|login|logout)|ai/answer|workspaces(/join)?|papers|knowledge)$'],
  ['PATCH', '^/api/auth/me$'],
  ['GET|PATCH', `^/api/workspaces/${id}$`],
  ['POST|DELETE', `^/api/workspaces/${id}/invite-code$`],
  ['GET|POST', `^/api/workspaces/${id}/members$`],
  ['POST', `^/api/workspaces/${id}/leave$`],
  ['DELETE', `^/api/workspaces/${id}/(members|papers)/${id}$`],
  ['GET|POST', `^/api/workspaces/${id}/papers$`],
  ['GET|PUT|DELETE', `^/api/papers/${id}$`],
  ['GET', `^/api/papers/${id}/file$`],
  ['PUT', `^/api/papers/${id}/progress$`],
  ['GET|POST', `^/api/papers/${id}/(annotations|comments|summaries)$`],
  ['POST', `^/api/papers/${id}/(annotation-note|discussion-summary)$`],
  ['DELETE', `^/api/annotations/${id}$`],
  ['GET|PUT', `^/api/annotations/${id}/note$`],
  ['DELETE', `^/api/(comments|summaries)/${id}$`],
  ['GET|PATCH|DELETE', `^/api/knowledge/${id}$`],
].map(([methods, pattern]) => ({ methods: methods.split('|'), pattern: new RegExp(pattern) }))

class GatewayError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
function origin(value, allowLocal) {
  const url = new URL(value)
  if (url.origin !== value || url.username || url.password || !(url.protocol === 'https:' || (allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) throw new Error('configuration')
  return url.origin
}
async function limitedBody(message, signal) {
  const length = message.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new GatewayError(413, '文件或请求超过大小限制。')
  if (!message.body) return undefined
  const reader = message.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const parts = []
  let total = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY) { await reader.cancel(); throw new GatewayError(413, '文件或请求超过大小限制。') }
      parts.push(value)
    }
    const result = new Uint8Array(total)
    let offset = 0
    for (const part of parts) { result.set(part, offset); offset += part.byteLength }
    return result
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock() }
}

export function createGateway({ readEnv, fetchImpl = fetch, allowLocal = false }) {
  return async request => {
    const requestId = crypto.randomUUID()
    const safeHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-request-id': requestId }
    try {
      let appOrigin, apiOrigin, token
      try {
        appOrigin = origin(readEnv('APP_ORIGIN'), allowLocal)
        apiOrigin = origin(readEnv('APP_API_ORIGIN'), allowLocal)
        token = readEnv('APP_GATEWAY_TOKEN') || ''
        if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error()
      } catch { throw new GatewayError(503, '站点网关未配置。') }
      const url = new URL(request.url)
      const match = url.pathname.match(/^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/api\/.*)$/)
      const path = match?.[1]
      const route = path && routes.filter(route => route.pattern.test(path))
      if (!route?.length) throw new GatewayError(404, '接口不存在。')
      if (!route.some(route => route.methods.includes(request.method))) throw new GatewayError(405, '不支持的请求方法。')
      const requestOrigin = request.headers.get('origin')
      if ((requestOrigin && requestOrigin !== appOrigin) || (!['GET', 'HEAD'].includes(request.method) && !requestOrigin) || request.headers.get('sec-fetch-site') === 'cross-site') throw new GatewayError(403, '不允许的请求来源。')
      const headers = new Headers({ 'x-paperflow-gateway-token': token, accept: 'application/json, application/pdf' })
      if (requestOrigin) headers.set('origin', requestOrigin)
      const contentType = request.headers.get('content-type')
      if (contentType) {
        if (!/^application\/json(?:\s*;|$)/i.test(contentType) && !(path === '/api/papers' && request.method === 'POST' && /^multipart\/form-data\s*;\s*boundary=/i.test(contentType))) throw new GatewayError(415, '请求格式不支持。')
        headers.set('content-type', contentType)
      }
      const cookies = (request.headers.get('cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith('paperflow.sid='))
      if (cookies.length > 1 || cookies.some(value => value.length > 512)) throw new GatewayError(400, '会话格式不合法。')
      if (cookies.length) headers.set('cookie', cookies[0])
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(65000)])
      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await limitedBody(request, signal)
      const target = new URL(path === '/api/health' ? '/health/ready' : path, apiOrigin)
      target.search = url.search
      const response = await fetchImpl(target, { method: request.method, headers, body, signal, redirect: 'manual' })
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new GatewayError(502, '后端返回了不允许的重定向。') }
      const responseType = response.headers.get('content-type') || ''
      if (response.status !== 204 && !/^application\/(json|pdf)(?:\s*;|$)/i.test(responseType)) { await response.body?.cancel(); throw new GatewayError(502, '后端响应格式不正确。') }
      const resultHeaders = new Headers(safeHeaders)
      if (responseType) resultHeaders.set('content-type', responseType)
      if (response.headers.has('set-cookie') && typeof response.headers.getSetCookie !== 'function') throw new GatewayError(502, '网关运行时不支持应用 Cookie。')
      for (const cookie of response.headers.getSetCookie?.() || []) {
        if (!cookie.startsWith('paperflow.sid=')) continue
        if (/;\s*domain=/i.test(cookie) || !/;\s*path=\/(?:;|$)/i.test(cookie) || !/;\s*httponly(?:;|$)/i.test(cookie) || !/;\s*samesite=lax(?:;|$)/i.test(cookie) || (!allowLocal && !/;\s*secure(?:;|$)/i.test(cookie))) throw new GatewayError(502, '后端 Cookie 配置不正确。')
        resultHeaders.append('set-cookie', cookie)
      }
      const result = response.status === 204 ? null : await limitedBody(response, signal)
      return new Response(result, { status: response.status, headers: resultHeaders })
    } catch (error) {
      const status = error instanceof GatewayError ? error.status : ['TimeoutError', 'AbortError'].includes(error?.name) ? 504 : 502
      return Response.json({ error: error instanceof GatewayError ? error.message : '网关请求失败或超时，请稍后重试。', requestId }, { status, headers: safeHeaders })
    }
  }
}
