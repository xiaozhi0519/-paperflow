export type KnowledgeKind = 'question' | 'note' | 'record'
export type KnowledgeStatus = 'open' | 'investigating' | 'resolved'
export interface KnowledgeSource { workspaceId: string | null; paperId: string | null; annotationId: string | null; commentId: string | null }
export interface KnowledgeFields { title: string; description: string; status: KnowledgeStatus }
export interface KnowledgeDraft extends KnowledgeSource, KnowledgeFields { kind: KnowledgeKind }
export interface KnowledgeCard extends KnowledgeDraft {
  id: string
  createdAt: string
  updatedAt: string
  author: { id: string; name: string }
  updatedBy: { id: string; name: string }
  canManage: boolean
  paperTitle: string | null
  source: { page: number; quote: string } | null
  discussion: string | null
  contributions: { id: string; author: { id: string; name: string }; action: 'created' | 'edited' | 'status-changed'; createdAt: string }[]
}
export const kindLabels: Record<KnowledgeKind, string> = { question: '研究问题', note: '科研笔记', record: '研究记录' }
export const knowledgeStatusLabels: Record<KnowledgeStatus, string> = { open: '待研究', investigating: '研究中', resolved: '已整理' }
async function request(path: string, init?: RequestInit) {
  const response = await fetch(`/api/knowledge${path}`, { credentials: 'same-origin', ...init })
  if (response.status === 401) window.dispatchEvent(new Event('paperflow:session-expired'))
  if (!response.ok) { const data = await response.json().catch(() => ({})) as { error?: string }; throw new Error(data.error || '知识库请求失败。') }
  return response
}
const json = (method: string, value: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
export const knowledgeService = {
  async list(workspaceId: string | null) { return await (await request(workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '')).json() as KnowledgeCard[] },
  async create(draft: KnowledgeDraft) { return await (await request('', json('POST', draft))).json() as KnowledgeCard },
  async update(id: string, fields: KnowledgeFields) { return await (await request(`/${encodeURIComponent(id)}`, json('PATCH', fields))).json() as KnowledgeCard },
  async remove(id: string) { await request(`/${encodeURIComponent(id)}`, { method: 'DELETE' }) },
}
export function knowledgeSourcePath(card: KnowledgeCard) {
  const params = new URLSearchParams()
  if (card.workspaceId) params.set('workspace', card.workspaceId)
  if (card.annotationId) params.set('annotation', card.annotationId)
  if (card.commentId) params.set('comment', card.commentId)
  return `/library/${card.paperId}/read?${params}`
}
