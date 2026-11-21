import { ProviderError, readProviderConfig, requestChatCompletion } from '../server/openai-provider.mjs'

const config = readProviderConfig()
try {
  const result = await requestChatCompletion(config, {
    messages: [{ role: 'user', content: 'Please reply with exactly OK.' }],
    maxTokens: 32,
    temperature: 0,
  })
  const excerpt = result.content.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 160)
  console.log(JSON.stringify({ ok: true, content: excerpt, contentLength: result.content.length, responseModel: result.model, modelStatus: result.modelStatus, usage: result.usage, usageStatus: result.usageStatus }, null, 2))
} catch (error) {
  if (error instanceof ProviderError) console.error(JSON.stringify({ ok: false, code: error.code, error: error.message, upstreamStatus: error.upstreamStatus, upstreamCode: error.upstreamCode }, null, 2))
  else console.error(JSON.stringify({ ok: false, code: 'CHECK_FAILED', error: '连通性检查未能完成。' }, null, 2))
  process.exitCode = 1
}
