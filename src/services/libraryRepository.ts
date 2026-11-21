import type { Annotation, LibraryItem, Note, Paper, PaperMetadata, ReadingProgress, ReadingStatus } from '../types/library'
import type { AiMessage, PaperChunk } from '../types/ai'

export const LOCAL_USER_ID = 'local-user'

export interface FileStorage {
  getFile(fileKey: string): Promise<Blob | undefined>
  putFile(fileKey: string, file: Blob): Promise<void>
  deleteFile(fileKey: string): Promise<void>
}

export interface LibraryRepository {
  listPapers(): Promise<LibraryItem[]>
  getPaper(id: string): Promise<LibraryItem | undefined>
  createPaper(paper: Paper, file: Blob): Promise<void>
  updatePaper(id: string, metadata: PaperMetadata): Promise<void>
  deletePaper(id: string): Promise<void>
  saveProgress(paperId: string, page: number): Promise<void>
  setStatus(paperId: string, status: ReadingStatus): Promise<void>
  listAnnotations(paperId: string, workspaceId?: string | null): Promise<Annotation[]>
  createAnnotation(annotation: Annotation): Promise<void>
  deleteAnnotation(id: string): Promise<void>
  getNote(annotationId: string): Promise<Note | undefined>
  saveNote(note: Note): Promise<void>
  createAnnotationWithNote(annotation: Annotation, note: Note): Promise<void>
  getChunks(paperId: string): Promise<PaperChunk[]>
  saveChunks(paperId: string, chunks: PaperChunk[]): Promise<void>
  getAiHistory(paperId: string): Promise<AiMessage[]>
  saveAiHistory(paperId: string, messages: AiMessage[]): Promise<void>
}

export type LibraryStorage = LibraryRepository & FileStorage
export type { Annotation, Note, Paper, PaperMetadata, ReadingProgress, ReadingStatus }
