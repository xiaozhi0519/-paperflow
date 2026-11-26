import { apiUrl } from './api'
import type { AiMode, Citation, PaperChunk } from '../types/ai'

export interface AiStatus { configured: boolean; model: string | null; models: string[] }
export interface AiResponse { answer: string; citations: Citation[]; source: 'model' | 'local'; provider?: unknown }
type AiInput = { paperId: string; mode: AiMode; question: string; selection: string; chunks: PaperChunk[]; model: string }
type AiRequestOptions = { signal?: AbortSignal; onDelta?: (text: string) => void }

const MAX_STREAM_BYTES = 2 * 1024 * 1024
const MAX_LINE_LENGTH = 256 * 1024
const MAX_ANSWER_LENGTH = 64 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function isCitation(value: unknown): value is Citation {
  return isRecord(value) && isText(value.paperId, 512) && isText(value.chunkId, 512)
    && typeof value.pageNumber === 'number' && Number.isSafeInteger(value.pageNumber) && value.pageNumber > 0 && isText(value.quote, 2000)
}

function finalResponse(value: unknown, input: AiInput): AiResponse {
  if (!isRecord(value) || !isText(value.answer, MAX_ANSWER_LENGTH) || (value.source !== 'model' && value.source !== 'local')
    || !Array.isArray(value.citations) || value.citations.length > 32 || !value.citations.every(isCitation)) throw new Error('AI 最终响应格式无效，草稿已丢弃。')
  const citations = value.citations.filter(citation => citation.paperId === input.paperId && input.chunks.some(chunk =>
    chunk.paperId === citation.paperId && chunk.chunkId === citation.chunkId && chunk.pageNumber === citation.pageNumber && chunk.text.includes(citation.quote)))
  if (value.source === 'model' && !citations.length) throw new Error('回答没有通过校验的引用，草稿已丢弃。请调整问题或选区后重试。')
  return { answer: value.answer, citations, source: value.source, provider: value.provider }
}

async function* readUtf8(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal, maxBytes: number) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  while (true) {
    signal.throwIfAborted()
    const { done, value } = await reader.read()
    signal.throwIfAborted()
    if (done) {
      const remaining = decoder.decode()
      if (remaining) yield remaining
      return
    }
    bytes += value.byteLength
    if (bytes > maxBytes) throw new Error('AI 响应超过长度限制，草稿已丢弃。')
    yield decoder.decode(value, { stream: true })
  }
}

export async function getAiStatus(signal?: AbortSignal): Promise<AiStatus> {
  const timeout = AbortSignal.timeout(3000)
  const response = await fetch(apiUrl('/ai/status'), { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, cache: 'no-store' })
  if (!response.ok) throw new Error('AI 服务未启动。')
  const value: unknown = await response.json()
  if (!isRecord(value) || typeof value.configured !== 'boolean' || !Array.isArray(value.models) || !value.models.length || value.models.length > 20
    || !value.models.every((model): model is string => isText(model, 100)) || new Set(value.models).size !== value.models.length
    || (value.model !== null && (typeof value.model !== 'string' || !value.models.includes(value.model)))) throw new Error('AI 模型列表格式无效。')
  return { configured: value.configured, model: value.model, models: value.models }
}

export async function requestAi(input: AiInput, { signal: externalSignal, onDelta }: AiRequestOptions = {}): Promise<AiResponse> {
  const timeout = AbortSignal.timeout(125000)
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const cancelReader = () => { void reader?.cancel().catch(() => {}) }
  try {
    signal.throwIfAborted()
    const response = await fetch(apiUrl('/ai/answer'), {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify(input), signal,
    })
    if (!response.body) throw new Error('AI 响应为空，草稿已丢弃。')
    reader = response.body.getReader()
    signal.addEventListener('abort', cancelReader, { once: true })
    signal.throwIfAborted()
    if (!response.ok) {
      let body = ''
      for await (const text of readUtf8(reader, signal, 16 * 1024)) body += text
      let failure: unknown
      try { failure = JSON.parse(body) } catch { throw new Error('AI 服务请求失败。') }
      throw new Error(isRecord(failure) && isText(failure.error, 2000) ? failure.error : 'AI 服务请求失败。')
    }
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-ndjson') throw new Error('AI 服务未返回流式响应，草稿已丢弃。')
    let buffer = ''
    let previewLength = 0
    function consume(line: string): AiResponse | undefined {
      signal.throwIfAborted()
      if (line.length > MAX_LINE_LENGTH) throw new Error('AI 响应单行超过长度限制，草稿已丢弃。')
      if (!line.trim()) return
      let event: unknown
      try { event = JSON.parse(line) } catch { throw new Error('AI 流式响应格式无效，草稿已丢弃。') }
      if (!isRecord(event)) throw new Error('AI 流式事件格式无效，草稿已丢弃。')
      if (event.type === 'delta' && typeof event.text === 'string') {
        previewLength += event.text.length
        if (previewLength > MAX_ANSWER_LENGTH) throw new Error('AI 草稿超过长度限制，已丢弃。')
        if (event.text) onDelta?.(event.text)
        return
      }
      if (event.type === 'done') return finalResponse(event.result, input)
      if (event.type === 'error' && isText(event.error, 2000) && (event.code === undefined || isText(event.code, 100))) throw new Error(event.error)
      throw new Error('AI 流式事件格式无效，草稿已丢弃。')
    }
    for await (const text of readUtf8(reader, signal, MAX_STREAM_BYTES)) {
      buffer += text
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const result = consume(line)
        if (result) return result
      }
      if (buffer.length > MAX_LINE_LENGTH) throw new Error('AI 响应单行超过长度限制，草稿已丢弃。')
    }
    if (buffer.trim()) {
      const result = consume(buffer)
      if (result) return result
    }
    throw new Error('AI 响应中断，未收到最终结果，草稿已丢弃。')
  } catch (cause) {
    if (externalSignal?.aborted) throw new DOMException('已停止生成。', 'AbortError')
    if (timeout.aborted) throw new Error('AI 请求超时，草稿已丢弃，请重试。')
    if (cause instanceof TypeError) throw new Error('无法连接或读取 AI 服务响应，草稿已丢弃，请稍后重试。')
    throw cause
  } finally {
    signal.removeEventListener('abort', cancelReader)
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
}
