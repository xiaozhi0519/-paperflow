import { createSiteContext } from './_qoder/backend.mjs'
import { createGateway } from './gateway.mjs'

const gateway = createGateway({ readEnv: (name: string) => Deno.env.get(name) })
Deno.serve(async (request: Request) => {
  try {
    const context = createSiteContext(request, { forwardApplicationCredentials: true })
    return await gateway(context.request)
  } catch {
    return Response.json({ error: '站点网关暂时不可用。' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
})
