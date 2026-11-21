const MAX_RESPONSE_LENGTH = 250000

export class ProviderError extends Error {
  constructor(code, message, upstreamStatus = null, upstreamCode = null) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.upstreamStatus = upstreamStatus
    this.upstreamCode = upstreamCode
  }
}

export function readProviderConfig(env = process.env) {
  const key = env.AI_API_KEY?.trim() || ''
  const model = env.AI_MODEL?.trim() || ''
  const base = env.AI_BASE_URL?.trim() || ''
  const timeoutValue = Number(env.AI_TIMEOUT_MS || 30000)
  const timeout = Number.isFinite(timeoutValue) ? Math.max(1000, Math.min(timeoutValue, 120000)) : 30000
  let endpoint = ''
  try {
    if (base) {
      const url = new URL(base)
      if ((url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) && !url.username && !url.password && !url.search && !url.hash) endpoint = `${url.href.replace(/\/+$/, '')}/chat/completions`
    }
  } catch {}
  return { key, model, endpoint, timeout, configured: Boolean(key && model && endpoint) }
}

function classifyError(status, data) {
  const error = data?.error
  const details = [typeof error === 'string' ? error : error?.code, error?.type, error?.message, data?.code, data?.message].filter(value => typeof value === 'string').join(' ').toLowerCase()
  const knownCodes = new Set(['invalid_api_key', 'authentication_error', 'permission_denied', 'insufficient_quota', 'insufficient_balance', 'rate_limit_exceeded', 'model_not_found', 'model_not_supported', 'unsupported_model'])
  const rawCode = (typeof error === 'object' && error !== null ? error.code : null) ?? data?.code
  const upstreamCode = typeof rawCode === 'string' && knownCodes.has(rawCode.toLowerCase()) ? rawCode.toLowerCase() : null
  const prefix = `模型中转站返回 ${status}：`
  if (status === 402 || /insufficient[_\s-]*(?:user[_\s-]*)?(?:balance|quota|credits?|funds)|(?:balance|quota|credits?)[_\s-]*(?:exceeded|insufficient)|billing_hard_limit|余额不足|额度不足|配额不足/.test(details)) return new ProviderError('INSUFFICIENT_QUOTA', `${prefix}余额或可用配额不足，请检查中转站账户。`, status, upstreamCode)
  if ([200, 400, 404, 422].includes(status) && /model[_\s-]*(?:not[_\s-]*(?:found|supported)|unsupported)|unsupported[_\s-]*model|invalid[_\s-]*model|model.{0,80}(?:not found|not supported|does not exist|unavailable)|模型.{0,30}(?:不支持|不存在|不可用)|不支持.{0,30}模型/.test(details)) return new ProviderError('MODEL_UNSUPPORTED', `${prefix}模型不存在或不支持此接口，请检查模型名称和中转站支持情况。`, status, upstreamCode)
  if (status === 401 || (status === 200 && ['invalid_api_key', 'authentication_error'].includes(upstreamCode))) return new ProviderError('AUTHENTICATION', `${prefix}密钥无效或身份验证失败。`, status, upstreamCode)
  if (status === 403 || (status === 200 && upstreamCode === 'permission_denied')) return new ProviderError('PERMISSION_DENIED', `${prefix}无权访问该接口或模型。`, status, upstreamCode)
  if (status === 404) return new ProviderError('ENDPOINT_NOT_FOUND', `${prefix}接口不存在，请检查基础地址是否正确。`, status, upstreamCode)
  if (status === 429 || (status === 200 && upstreamCode === 'rate_limit_exceeded')) return new ProviderError('RATE_LIMITED', `${prefix}请求频率受限，请稍后重试。`, status, upstreamCode)
  return new ProviderError('UPSTREAM_ERROR', `${prefix}请求失败，请检查中转站状态和模型配置。`, status, upstreamCode)
}

async function readResponse(response) {
  if (!response.body) return ''
  const decoder = new TextDecoder()
  let raw = ''
  for await (const part of response.body) {
    raw += decoder.decode(part, { stream: true })
    if (raw.length > MAX_RESPONSE_LENGTH) throw new ProviderError('INVALID_RESPONSE', '模型中转站响应过长，无法安全处理。', response.status)
  }
  raw += decoder.decode()
  if (raw.length > MAX_RESPONSE_LENGTH) throw new ProviderError('INVALID_RESPONSE', '模型中转站响应过长，无法安全处理。', response.status)
  return raw
}

function responseMetadata(data, key) {
  let model = null
  let modelStatus = 'missing'
  if (data.model !== undefined && data.model !== null) {
    if (typeof data.model === 'string' && /^[\w.:/-]{1,200}$/.test(data.model) && !data.model.includes(key)) { model = data.model; modelStatus = 'valid' }
    else modelStatus = 'invalid'
  }
  let usage = null
  let usageStatus = 'missing'
  if (data.usage !== undefined && data.usage !== null) {
    const value = data.usage
    if (typeof value === 'object' && ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(name => Number.isSafeInteger(value[name]) && value[name] >= 0)) {
      usage = { prompt_tokens: value.prompt_tokens, completion_tokens: value.completion_tokens, total_tokens: value.total_tokens }
      usageStatus = 'valid'
    } else usageStatus = 'invalid'
  }
  return { model, modelStatus, usage, usageStatus }
}

export async function requestChatCompletion(config, { messages, maxTokens = 1100, temperature = 0.1 }) {
  if (!config.configured) throw new ProviderError('NOT_CONFIGURED', '模型中转站尚未配置，请在服务端填写基础地址、模型名和密钥。')
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.timeout),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}` },
      body: JSON.stringify({ model: config.model, temperature, max_tokens: maxTokens, stream: false, messages }),
    })
    const raw = await readResponse(response)
    let data
    try { data = JSON.parse(raw) } catch {
      if (!response.ok) throw classifyError(response.status, null)
      throw new ProviderError('INVALID_RESPONSE', '模型中转站返回的内容不是有效 JSON。', response.status)
    }
    if (!response.ok) throw classifyError(response.status, data)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ProviderError('INVALID_RESPONSE', '模型中转站返回的 JSON 格式不兼容 Chat Completions。', response.status)
    if (data.error) throw classifyError(response.status, data)
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim() || content.length > 20000) throw new ProviderError('INVALID_RESPONSE', '模型中转站未返回兼容的非空文本内容。', response.status)
    if (content.includes(config.key)) throw new ProviderError('UNSAFE_RESPONSE', '模型返回内容包含敏感信息，已阻止显示。', response.status)
    return { content, ...responseMetadata(data, config.key) }
  } catch (error) {
    if (error instanceof ProviderError) throw error
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new ProviderError('TIMEOUT', '模型中转站请求超时，请检查服务状态或调整超时时间。')
    throw new ProviderError('CONNECTION_FAILED', '无法连接模型中转站，请检查网络和服务端配置。')
  }
}
