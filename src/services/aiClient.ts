import type { AiMode, Citation, PaperChunk } from '../types/ai'

export interface AiStatus { configured: boolean; model: string | null }
export interface AiResponse { answer: string; citations: Citation[]; source: 'model' | 'local' }

export async function getAiStatus(): Promise<AiStatus> {
  const response = await fetch('/api/ai/status', { signal: AbortSignal.timeout(3000), cache: 'no-store' })
  if (!response.ok) throw new Error('AI 服务未启动。')
  return response.json() as Promise<AiStatus>
}

export async function requestAi(input: { paperId: string; mode: AiMode; question: string; selection: string; chunks: PaperChunk[] }): Promise<AiResponse> {
  let response: Response
  try {
    response = await fetch('/api/ai/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(125000) })
  } catch { throw new Error('无法连接 AI 服务或请求超时，请检查本地服务。') }
  const result = await response.json() as AiResponse & { error?: string }
  if (!response.ok) throw new Error(result.error || 'AI 服务请求失败。')
  return result
}
