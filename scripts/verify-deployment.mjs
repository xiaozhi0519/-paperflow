import assert from 'node:assert/strict'

const target = process.env.PAPERFLOW_VERIFY_ORIGIN
const api = process.env.PAPERFLOW_VERIFY_API_BASE || '/functions/v1/app/api'
try {
  const origin = new URL(target)
  const local = process.argv.includes('--local') && origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname)
  assert.ok(origin.origin === target && !origin.username && !origin.password && (origin.protocol === 'https:' || local), '请提供精确 HTTPS 来源；本机 HTTP 仅可使用 --local。')
  assert.ok(['/api', '/functions/v1/app/api'].includes(api), 'API 前缀不合法。')
  const check = async (path, expected, type, headers = {}) => {
    const response = await fetch(new URL(path, origin), { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, expected, `状态不符：${path}`)
    assert.ok((response.headers.get('content-type') || '').includes(type), `格式不符：${path}`)
    return response
  }
  const home = await check('/', 200, 'text/html')
  const html = await home.text()
  assert.match(html, /id="root"/)
  assert.match(html, /Content-Security-Policy/)
  await check('/library', 200, 'text/html')
  await check('/knowledge', 200, 'text/html')
  await check('/team', 200, 'text/html')
  const script = html.match(/<script[^>]+src="([^"]+)"/)?.[1]
  assert.ok(script && script.startsWith('/') && !script.startsWith('//'), '缺少同源构建入口。')
  const js = await check(script, 200, 'javascript')
  assert.ok(!(await js.text()).startsWith('<'), '脚本被 SPA 回退替换。')
  const health = await check(`${api}/health`, 200, 'application/json')
  assert.equal((await health.json()).status, 'ready')
  await check(`${api}/auth/me`, 401, 'application/json')
  await check(`${api}/papers`, 401, 'application/json')
  const csrf = await fetch(new URL(`${api}/auth/logout`, origin), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { origin: 'https://untrusted.example.invalid' } })
  assert.equal(csrf.status, 403, '跨站写请求未被拒绝。')
  assert.equal(csrf.headers.get('access-control-allow-origin'), null)
  console.log(`${local ? '本机' : '目标 HTTPS 入口'}只读/拒绝路径验证通过：SPA、构建脚本、就绪、匿名隔离及 CSRF。未登录或创建账号/业务数据；不代表双账号、S3 写入、Cookie 或恢复演练通过。`)
} catch {
  console.error('部署验证未通过：检查来源/API 前缀、站点准入、HTTPS、路由及后端就绪；未输出响应正文或凭据。')
  process.exitCode = 1
}
