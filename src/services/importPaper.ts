import { LOCAL_USER_ID, type LibraryStorage } from './libraryRepository'
import type { Paper } from '../types/library'

export async function importPaper(file: File, storage: LibraryStorage, workspaceId: string | null = null): Promise<Paper> {
  if (!file.name.toLowerCase().endsWith('.pdf') || file.size === 0 || file.size > 20 * 1024 * 1024) throw new Error('请选择不超过 20 MB 的非空 PDF 文件。')
  const bytes = await file.arrayBuffer()
  const header = new TextDecoder('ascii').decode(bytes.slice(0, 1024))
  if (!header.includes('%PDF-')) throw new Error('文件不是有效的 PDF，请重新选择。')
  const [{ getDocument }] = await Promise.all([import('pdfjs-dist'), import('../features/pdf/pdfConfig')])
  const task = getDocument({ data: new Uint8Array(bytes) })
  let pageCount: number
  try {
    const document = await task.promise
    pageCount = document.numPages
    if (pageCount < 1) throw new Error('PDF 没有可阅读的页面。')
  } catch {
    throw new Error('PDF 已损坏、受密码保护或无法解析，请选择其他文件。')
  } finally {
    await task.destroy()
  }
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const paper: Paper = { id, ownerId: LOCAL_USER_ID, workspaceId, fileKey: id, fileName: file.name, fileSize: file.size, pageCount, title: file.name.replace(/\.pdf$/i, '').trim() || '未命名文献', authors: '', abstract: '', year: '', venue: '', doi: '', createdAt: now, updatedAt: now }
  await storage.createPaper(paper, file)
  return paper
}
