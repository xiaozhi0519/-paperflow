export interface CommentAuthor { id: string; name: string }
export interface DiscussionComment {
  id: string
  paperId: string
  parentId: string | null
  annotationId: string | null
  workspaceId: string | null
  content: string
  createdAt: string
  author: CommentAuthor
  canDelete: boolean
}
export interface CommentDraft { content: string; parentId?: string; annotationId?: string; workspaceId?: string | null }

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...init })
  if (response.status === 401) window.dispatchEvent(new Event('paperflow:session-expired'))
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error || '讨论请求失败。')
  }
  return response
}

export const commentService = {
  async list(paperId: string, workspaceId?: string | null) {
    const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''
    return await (await request(`/papers/${encodeURIComponent(paperId)}/comments${query}`)).json() as DiscussionComment[]
  },
  async create(paperId: string, draft: CommentDraft) {
    return await (await request(`/papers/${encodeURIComponent(paperId)}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) })).json() as DiscussionComment
  },
  async remove(id: string) {
    await request(`/comments/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
}
