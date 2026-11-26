import http from 'node:http'
import { Readable } from 'node:stream'
import { createGateway } from '../functions/gateway.mjs'

if (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost'].includes(new URL(process.env.APP_API_ORIGIN).hostname)) throw new Error('本机网关测试只允许回环目标。')
const port = Number(process.env.PAPERFLOW_GATEWAY_PORT || 8790)
const handler = createGateway({ readEnv: name => process.env[name], allowLocal: true })
const server = http.createServer(async (req, res) => {
  const controller = new AbortController()
  res.on('close', () => { if (!res.writableEnded) controller.abort() })
  try {
    const hasBody = !['GET', 'HEAD'].includes(req.method)
    const request = new Request(new URL(req.url, `http://127.0.0.1:${port}`), { method: req.method, headers: req.headers, ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}), signal: controller.signal })
    const response = await handler(request)
    res.statusCode = response.status
    for (const [name, value] of response.headers) if (name !== 'set-cookie') res.setHeader(name, value)
    if (response.headers.getSetCookie().length) res.setHeader('set-cookie', response.headers.getSetCookie())
    if (response.body) Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res)
    else res.end()
  } catch { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '本机网关失败。' })) }
})
server.listen(port, '127.0.0.1', () => console.log(`PaperFlow local gateway listening on 127.0.0.1:${port}`))
