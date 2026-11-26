import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import express from 'express'
import session from 'express-session'
import { readServerConfig } from '../server/config.mjs'
import { installHttpSecurity } from '../server/http-security.mjs'
import { postgresConnection } from '../server/database.mjs'
import { createObjectStorage, readStorageConfig } from '../server/object-storage.mjs'
import { createGateway } from '../functions/gateway.mjs'

const env = { NODE_ENV: 'production', DEPLOYMENT_MODE: 'sites', AI_PORT: '8787', ALLOWED_HOSTS: '127.0.0.1:8787', TRUSTED_PROXIES: '127.0.0.1/32,::1/128', AI_ALLOWED_ORIGINS: 'https://paperflow.example.test', SESSION_SECRET: 'test-only-session-secret-with-enough-length', APP_GATEWAY_TOKEN: 'test_only_gateway_token_012345678901234567890123456789', DATABASE_URL: 'postgresql://test:fake@db.example.test/paperflow_test', PG_SSL_MODE: 'verify-full', S3_BUCKET: 'test-bucket', S3_REGION: 'test-region', S3_ACCESS_KEY_ID: 'test-key', S3_SECRET_ACCESS_KEY: 'test-secret' }
for (const script of ['scripts/check-production-config.mjs', 'server/start.mjs']) {
  const result = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 1)
  assert.match(result.stdout + result.stderr, /配置|configuration/)
}
const config = readServerConfig(env)
for (const field of ['DEPLOYMENT_MODE', 'AI_ALLOWED_ORIGINS', 'ALLOWED_HOSTS', 'TRUSTED_PROXIES', 'SESSION_SECRET', 'DATABASE_URL', 'APP_GATEWAY_TOKEN', 'S3_BUCKET']) assert.throws(() => readServerConfig({ ...env, [field]: '' }), undefined, field)
for (const values of [{ AI_PORT: 'NaN' }, { AI_ALLOWED_ORIGINS: 'https://paperflow.example.test/path' }, { AI_ALLOWED_ORIGINS: '*' }, { AI_ALLOWED_ORIGINS: 'http://paperflow.example.test' }, { TRUSTED_PROXIES: '1' }, { TRUSTED_PROXIES: '0.0.0.0/0' }, { PG_SSL_MODE: 'disable' }, { DATABASE_URL: `${env.DATABASE_URL}?sslmode=no-verify` }, { S3_ENDPOINT: 'http://127.0.0.1:9000' }, { AI_API_KEY: 'must-not-call' }]) assert.throws(() => readServerConfig({ ...env, ...values }))
assert.equal(postgresConnection(env).ssl.rejectUnauthorized, true)
assert.equal(readStorageConfig(env).forcePathStyle, false)
assert.equal(readStorageConfig({ ...env, S3_ENDPOINT: 'https://s3.example.test' }).forcePathStyle, true)
console.log('生产配置静态检查：缺失值、来源、代理、PG TLS、S3 HTTPS、AI 留空约束通过；未连接远程资源。')

const localFetch = (url, options = {}) => new Promise((resolve, reject) => {
  const request = http.request(url, options, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })))
    response.on('error', reject)
  })
  request.on('error', reject)
  request.end()
})
const app = express()
installHttpSecurity(app, config)
app.use(session({ name: 'paperflow.sid', secret: env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { secure: true, httpOnly: true, sameSite: 'lax' } }))
app.post('/api/auth/login', (req, res) => { req.session.test = true; res.json({ ok: true }) })
app.get('/api/auth/me', (req, res) => res.json({ ok: Boolean(req.session.test), ip: req.ip }))
app.get('/health/live', (req, res) => res.json({ status: 'live' }))
const server = app.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`
const headers = { host: '127.0.0.1:8787', origin: env.AI_ALLOWED_ORIGINS, 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.10', 'x-paperflow-gateway-token': env.APP_GATEWAY_TOKEN }
try {
  const login = await localFetch(`${base}/api/auth/login`, { method: 'POST', headers })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie')
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/); assert.match(cookie, /Path=\//)
  assert.ok(!cookie.includes('Domain='))
  const me = await localFetch(`${base}/api/auth/me`, { headers: { ...headers, cookie: cookie.split(';')[0] } })
  assert.equal((await me.json()).ok, true)
  for (const override of [{ host: 'evil.example.test' }, { origin: 'https://evil.example.test' }, { origin: '' }, { 'x-forwarded-proto': 'http' }, { 'x-paperflow-gateway-token': 'wrong' }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await localFetch(`${base}/api/auth/login`, { method: 'POST', headers: { ...headers, ...override } })
    assert.equal(response.status, 403)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
    assert.ok(response.headers.get('x-request-id'))
  }
  assert.equal((await localFetch(`${base}/health/live`, { headers: { host: '127.0.0.1:8787' } })).status, 200)
  const untrusted = express()
  installHttpSecurity(untrusted, { ...config, trustedProxies: ['192.0.2.1/32'] })
  untrusted.get('/api/test', (req, res) => res.json({ ok: true }))
  const other = untrusted.listen(0, '127.0.0.1'); await once(other, 'listening')
  try { assert.equal((await localFetch(`http://127.0.0.1:${other.address().port}/api/test`, { headers })).status, 403) } finally { await new Promise(resolve => other.close(resolve)) }
  console.log('真实 Express/session 中间件：可信代理、Secure/HttpOnly/Lax Cookie、恶意 Host/Origin/伪造协议/网关令牌拒绝通过（本机 HTTP 模拟 TLS 终止，内存会话；非线上 HTTPS/PG 验收）。')
} finally { await new Promise(resolve => server.close(resolve)) }

const gatewayEnv = { APP_ORIGIN: env.AI_ALLOWED_ORIGINS, APP_API_ORIGIN: 'https://api.example.test', APP_GATEWAY_TOKEN: env.APP_GATEWAY_TOKEN }
let calls = []
let reply = () => Response.json({ ok: true })
const gateway = createGateway({ readEnv: name => gatewayEnv[name], fetchImpl: async (url, options) => { calls.push({ url: String(url), ...options }); return reply() } })
const url = suffix => `https://site.example.test/functions/v1/app${suffix}`
const input = (suffix, method = 'GET', extra = {}) => new Request(url(suffix), { method, headers: { ...(method === 'GET' ? {} : { origin: gatewayEnv.APP_ORIGIN }), ...extra.headers }, ...(extra.body === undefined ? {} : { body: extra.body }) })
assert.equal((await gateway(input('/api/auth/me'))).status, 200)
assert.equal(calls[0].url, 'https://api.example.test/api/auth/me')
await gateway(input('/api/auth/me', 'GET', { headers: { cookie: 'platform_secret=DO_NOT_FORWARD; paperflow.sid=s%3Atest', authorization: 'Bearer DO_NOT_FORWARD', 'x-forwarded-for': 'DO_NOT_FORWARD', 'x-qoder-user-context': 'DO_NOT_FORWARD', 'x-paperflow-gateway-token': 'attacker' } }))
const forwarded = calls.at(-1).headers
assert.equal(forwarded.get('cookie'), 'paperflow.sid=s%3Atest')
assert.equal(forwarded.get('authorization'), null); assert.equal(forwarded.get('x-forwarded-for'), null); assert.equal(forwarded.get('x-qoder-user-context'), null)
assert.equal(forwarded.get('x-paperflow-gateway-token'), env.APP_GATEWAY_TOKEN)
let before = calls.length
for (const [request, status] of [[input('/api/auth/login', 'POST', { headers: { origin: 'https://evil.example.test' } }), 403], [input('/api/auth/login', 'POST', { headers: { origin: '' } }), 403], [input('/api/auth/me', 'GET', { headers: { 'sec-fetch-site': 'cross-site' } }), 403], [input('/api/unknown'), 404], [input('/api/auth/me', 'DELETE'), 405], [input('/api/papers', 'POST', { headers: { 'content-length': String(22 * 1024 * 1024) } }), 413]]) assert.equal((await gateway(request)).status, status)
assert.equal(calls.length, before)
for (const prefix of ['/app', `/functions/v1/app-d${'a'.repeat(32)}`, `/app-d${'b'.repeat(32)}`]) assert.equal((await gateway(new Request(`https://site.example.test${prefix}/api/auth/me`))).status, 200)
const form = new FormData(); form.append('file', new Blob([Buffer.from('%PDF-1.7\nprobe')], { type: 'application/pdf' }), 'probe.pdf')
const multipart = new Request(url('/api/papers'), { method: 'POST', headers: { origin: gatewayEnv.APP_ORIGIN }, body: form })
const bytes = new Uint8Array(await multipart.clone().arrayBuffer())
assert.equal((await gateway(multipart)).status, 200)
assert.deepEqual(calls.at(-1).body, bytes)
assert.equal(calls.at(-1).headers.get('origin'), gatewayEnv.APP_ORIGIN)
const largeFile = new Uint8Array(20 * 1024 * 1024)
const largeForm = new FormData(); largeForm.append('file', new Blob([largeFile], { type: 'application/pdf' }), 'boundary.pdf')
assert.equal((await gateway(new Request(url('/api/papers'), { method: 'POST', headers: { origin: gatewayEnv.APP_ORIGIN }, body: largeForm }))).status, 200)
assert.ok(calls.at(-1).body.byteLength > largeFile.byteLength)
before = calls.length
assert.equal((await gateway(input('/api/papers', 'POST', { headers: { 'content-type': 'application/json' }, body: new Uint8Array(20 * 1024 * 1024 + 64 * 1024 + 1) }))).status, 413)
assert.equal(calls.length, before)
const failure = createGateway({ readEnv: name => gatewayEnv[name], fetchImpl: async () => { throw new Error(env.APP_GATEWAY_TOKEN) } })
const failureResponse = await failure(input('/api/auth/me'))
assert.equal(failureResponse.status, 502)
assert.ok(!(await failureResponse.text()).includes(env.APP_GATEWAY_TOKEN))
reply = () => new Response('redirect', { status: 302, headers: { location: 'https://do-not-follow.example.test' } })
before = calls.length; assert.equal((await gateway(input('/api/auth/me'))).status, 502); assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).redirect, 'manual')
reply = () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } })
assert.equal((await gateway(input('/api/auth/me'))).status, 502)
reply = () => new Response(null, { status: 204, headers: { 'set-cookie': 'paperflow.sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'clear-site-data': '"*"', 'x-provider-secret': 'no' } })
const logout = await gateway(input('/api/auth/logout', 'POST'))
assert.equal(logout.status, 204); assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/); assert.equal(logout.headers.get('clear-site-data'), null); assert.equal(logout.headers.get('x-provider-secret'), null)
reply = () => Response.json({}, { headers: { 'set-cookie': 'paperflow.sid=x; Domain=example.test; Path=/; HttpOnly; Secure; SameSite=Lax' } })
assert.equal((await gateway(input('/api/auth/me'))).status, 502)
const pdf = Buffer.from('%PDF-1.7\nbytes')
reply = () => new Response(pdf, { headers: { 'content-type': 'application/pdf' } })
assert.deepEqual(Buffer.from(await (await gateway(input(`/api/papers/${randomUUID()}/file`))).arrayBuffer()), pdf)
const missing = createGateway({ readEnv: () => '' })
assert.equal((await missing(input('/api/auth/me'))).status, 503)
console.log('Function 业务处理器 Node 夹具：固定目标/方法、逻辑及物理子路由、原始 Origin、平台凭据剥离、Cookie/二进制/大小限制、重定向拒绝通过；未运行 Deno 或平台 SDK。')

const objects = new Map()
const s3 = http.createServer(async (req, res) => {
  assert.match(req.headers.authorization, /^AWS4-HMAC-SHA256 /)
  const key = new URL(req.url, 'http://127.0.0.1').pathname
  if (req.method === 'HEAD' && key === '/test-bucket/') { res.writeHead(200); res.end(); return }
  if (req.method === 'PUT') { const parts = []; for await (const part of req) parts.push(part); objects.set(key, Buffer.concat(parts)); res.writeHead(200, { ETag: '"test"' }); res.end(); return }
  if (req.method === 'GET' && objects.has(key)) { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(objects.get(key)); return }
  if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); res.end(); return }
  res.writeHead(404); res.end()
})
s3.listen(0, '127.0.0.1'); await once(s3, 'listening')
const storage = await createObjectStorage('', { NODE_ENV: 'development', S3_BUCKET: 'test-bucket', S3_REGION: 'test-region', S3_ACCESS_KEY_ID: 'test-key', S3_SECRET_ACCESS_KEY: 'test-secret', S3_ENDPOINT: `http://127.0.0.1:${s3.address().port}` })
try {
  await storage.check()
  const key = `${randomUUID()}.pdf`
  await storage.put(key, pdf); assert.deepEqual(await storage.get(key), pdf)
  await storage.delete(key); assert.equal(objects.size, 0)
  console.log('真实 AWS SDK → 本机假 S3 HTTP 服务：签名请求、HeadBucket、Put/Get/Delete 与字节一致性通过；非真实 S3/ACL/TLS 验收。')
} finally { storage.close(); await new Promise(resolve => s3.close(resolve)) }
