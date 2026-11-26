import { apiUrl } from './api'
import type { AiMessage, PaperChunk } from '../types/ai'
import type { Annotation, LibraryItem, Note } from '../types/library'
import type { LibraryStorage } from './libraryRepository'

const chunks = new Map<string, PaperChunk[]>()
const history = new Map<string, AiMessage[]>()
export function clearRemoteCache() { chunks.clear(); history.clear() }

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(apiUrl(path), { credentials: 'same-origin', ...init })
  if (response.status === 401) window.dispatchEvent(new Event('paperflow:session-expired'))
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error || '远程服务请求失败。')
  }
  return response
}
const json = (method: string, value: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
const paperPath = (id: string) => `/papers/${encodeURIComponent(id)}`
const annotationPath = (id: string) => `/annotations/${encodeURIComponent(id)}`

export const remoteLibrary: LibraryStorage = {
  async listPapers() {
    const items = await (await request('/papers')).json() as LibraryItem[]
    return items.sort((a, b) => (b.progress.updatedAt || b.paper.createdAt).localeCompare(a.progress.updatedAt || a.paper.createdAt))
  },
  async getPaper(id) { return await (await request(paperPath(id))).json() as LibraryItem },
  async getFile(key) { return (await request(`${paperPath(key)}/file`)).blob() },
  async putFile() { throw new Error('远程 PDF 必须与文献一同上传。') },
  async deleteFile() { throw new Error('远程 PDF 必须与文献一同删除。') },
  async createPaper(paper, file) {
    const form = new FormData()
    form.append('metadata', JSON.stringify({ id: paper.id, title: paper.title, workspaceId: paper.workspaceId }))
    form.append('file', file, paper.fileName)
    await request('/papers', { method: 'POST', body: form })
  },
  async updatePaper(id, metadata) { await request(paperPath(id), json('PUT', metadata)) },
  async deletePaper(id) { await request(paperPath(id), { method: 'DELETE' }); chunks.delete(id); history.delete(id) },
  async saveProgress(id, page) { await request(`${paperPath(id)}/progress`, json('PUT', { page })) },
  async setStatus(id, status) { await request(`${paperPath(id)}/progress`, json('PUT', { status })) },
  async listAnnotations(id, workspaceId) { return await (await request(`${paperPath(id)}/annotations${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`)).json() as Annotation[] },
  async createAnnotation(annotation) { await request(`${paperPath(annotation.paperId)}/annotations`, json('POST', annotation)) },
  async deleteAnnotation(id) { await request(annotationPath(id), { method: 'DELETE' }) },
  async getNote(id) { return (await (await request(`${annotationPath(id)}/note`)).json() as Note | null) ?? undefined },
  async saveNote(note) { await request(`${annotationPath(note.annotationId)}/note`, json('PUT', note)) },
  async createAnnotationWithNote(annotation, note) { await request(`${paperPath(annotation.paperId)}/annotation-note`, json('POST', { annotation, note })) },
  async getChunks(id) { return chunks.get(id) ?? [] },
  async saveChunks(id, value) { chunks.set(id, value) },
  async getAiHistory(id) { return history.get(id) ?? [] },
  async saveAiHistory(id, value) { history.set(id, value.slice(-40)) },
}
