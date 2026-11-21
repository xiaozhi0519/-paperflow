import type { HighlightRect } from './index'

export type ReadingStatus = 'unread' | 'reading' | 'finished'

export interface User { id: string; name: string }
export interface Workspace { id: string; name: string; ownerId: string }
export interface Paper {
  id: string
  ownerId: string
  workspaceId: string | null
  workspaceIds?: string[]
  fileKey: string
  fileName: string
  fileSize: number
  pageCount: number
  title: string
  authors: string
  abstract: string
  year: string
  venue: string
  doi: string
  createdAt: string
  updatedAt: string
}
export type PaperMetadata = Pick<Paper, 'title' | 'authors' | 'abstract' | 'year' | 'venue' | 'doi'>
export interface ReadingProgress {
  paperId: string
  userId: string
  lastPage: number
  status: ReadingStatus
  updatedAt: string
}
export interface Annotation {
  author?: User
  canManage?: boolean
  id: string
  paperId: string
  userId: string
  workspaceId: string | null
  page: number
  text: string
  rects: HighlightRect[]
  createdAt: string
}
export interface Note {
  id: string
  paperId: string
  annotationId: string
  authorId: string
  workspaceId: string | null
  content: string
  updatedAt: string
}
export interface LibraryItem { paper: Paper; progress: ReadingProgress; owner?: boolean; contexts?: { workspaceId: string; role: 'owner' | 'member' }[] }
