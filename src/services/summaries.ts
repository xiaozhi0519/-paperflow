import { apiUrl } from './api'

export type SummarySourceType = 'paper-evidence' | 'member-opinion' | 'ai-inference'
export interface SummaryItem {
  text: string
  sourceType: SummarySourceType
  annotation?: { id: string; page: number; quote: string }
  commentIds?: string[]
}
export interface SummarySections {
  overview: string
  researchQuestions: SummaryItem[]
  keyPoints: SummaryItem[]
  disagreements: SummaryItem[]
  consensus: SummaryItem[]
  openQuestions: SummaryItem[]
}
export interface GeneratedSummary extends SummarySections {
  workspaceId: string
  generatedAt: string
  model: string | null
  discussionCount: number
  annotationCount: number
  warnings: string[]
}
export interface SavedSummary {
  id: string
  paperId: string
  workspaceId: string
  model: string
  createdAt: string
  author: { id: string; name: string }
  summary: SummarySections
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(apiUrl(path), { credentials: 'same-origin', ...init })
  if (response.status === 401) window.dispatchEvent(new Event('paperflow:session-expired'))
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error || '讨论总结请求失败。')
  }
  return response
}
const json = (method: string, value: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })

export const summaryService = {
  async generate(paperId: string, workspaceId: string) {
    return await (await request(`/papers/${encodeURIComponent(paperId)}/discussion-summary`, json('POST', { workspaceId }))).json() as GeneratedSummary
  },
  async list(paperId: string, workspaceId: string) {
    return await (await request(`/papers/${encodeURIComponent(paperId)}/summaries?workspaceId=${encodeURIComponent(workspaceId)}`)).json() as SavedSummary[]
  },
  async save(paperId: string, workspaceId: string, model: string | null, summary: SummarySections) {
    return await (await request(`/papers/${encodeURIComponent(paperId)}/summaries`, json('POST', { workspaceId, model: model ?? undefined, summary }))).json() as SavedSummary
  },
  async remove(id: string) {
    await request(`/summaries/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
}
