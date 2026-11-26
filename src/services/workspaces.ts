import { apiUrl } from './api'
import type { Paper, ReadingProgress } from '../types/library'

export type WorkspaceRole = 'owner' | 'member'
export interface WorkspaceSummary { id: string; name: string; description: string; ownerId: string; role: WorkspaceRole; createdAt: string; memberCount: number }
export interface WorkspaceMember { id: string; name: string; role: WorkspaceRole; joinedAt: string; email?: string }
export interface WorkspaceDetail extends WorkspaceSummary { members: WorkspaceMember[]; stats: { papers: number; annotations: number; comments: number; knowledge: number } }
export interface WorkspacePaperItem { paper: Paper; progress: ReadingProgress; addedAt: string }

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(apiUrl(path), { credentials: 'same-origin', ...init })
  if (response.status === 401) window.dispatchEvent(new Event('paperflow:session-expired'))
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error || '团队空间请求失败。')
  }
  return response
}
const json = (method: string, value: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
const workspacePath = (id: string) => `/workspaces/${encodeURIComponent(id)}`
const changed = () => window.dispatchEvent(new Event('paperflow:workspaces-changed'))

export const workspaceService = {
  async list() { return await (await request('/workspaces')).json() as WorkspaceSummary[] },
  async create(name: string, description: string) { const value = await (await request('/workspaces', json('POST', { name, description }))).json() as WorkspaceSummary; changed(); return value },
  async join(code: string) { const value = await (await request('/workspaces/join', json('POST', { code }))).json() as WorkspaceSummary; changed(); return value },
  async createInvite(id: string) { return await (await request(`${workspacePath(id)}/invite-code`, { method: 'POST' })).json() as { code: string; expiresAt: string } },
  async revokeInvite(id: string) { await request(`${workspacePath(id)}/invite-code`, { method: 'DELETE' }) }, 
  async detail(id: string) { return await (await request(workspacePath(id))).json() as WorkspaceDetail },
  async rename(id: string, name: string, description: string) { await request(workspacePath(id), json('PATCH', { name, description })); changed() },
  async invite(id: string, email: string) { await request(`${workspacePath(id)}/members`, json('POST', { email })); changed() },
  async removeMember(id: string, userId: string) { await request(`${workspacePath(id)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }); changed() },
  async leave(id: string) { await request(`${workspacePath(id)}/leave`, { method: 'POST' }); changed() },
  async listPapers(id: string) { return await (await request(`${workspacePath(id)}/papers`)).json() as WorkspacePaperItem[] },
  async addPaper(id: string, paperId: string) { await request(`${workspacePath(id)}/papers`, json('POST', { paperId })) },
  async removePaper(id: string, paperId: string) { await request(`${workspacePath(id)}/papers/${encodeURIComponent(paperId)}`, { method: 'DELETE' }) },
}
