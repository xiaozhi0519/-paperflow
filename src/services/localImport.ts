import type { Annotation, LibraryItem, Note, Paper, ReadingProgress } from '../types/library'
import { remoteLibrary } from './remoteLibrary'

const DATABASE = 'paperflow-library'

export type ImportConflict = 'none' | 'already-imported' | 'duplicate-title' | 'missing-file'

export interface LocalImportItem {
  paper: Paper
  progress: ReadingProgress
  annotationCount: number
  noteCount: number
  conflict: ImportConflict
}

export interface LocalImportScan {
  items: LocalImportItem[]
  annotationCount: number
  noteCount: number
}

export interface LocalImportResult {
  paperId: string
  title: string
  annotations: number
  notes: number
  warnings: string[]
}

interface LocalSnapshot {
  papers: Paper[]
  progress: ReadingProgress[]
  annotations: Annotation[]
  notes: Note[]
  fileKeys: Set<IDBValidKey>
}

async function openExistingDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null
  try {
    if (typeof indexedDB.databases === 'function') {
      const databases = await indexedDB.databases()
      if (!databases.some(database => database.name === DATABASE)) return null
    }
  } catch { /* fall through to a versionless open */ }
  return new Promise<IDBDatabase | null>((resolve, reject) => {
    let upgradeAttempted = false
    const request = indexedDB.open(DATABASE)
    request.onupgradeneeded = () => { upgradeAttempted = true; request.transaction?.abort() }
    request.onsuccess = () => {
      const db = request.result
      if (upgradeAttempted) { db.close(); resolve(null); return }
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => { if (upgradeAttempted) resolve(null); else reject(request.error ?? new Error('无法读取本地文献库。')) }
    request.onblocked = () => reject(new Error('本地数据库正被其他页面占用，请关闭其他 PaperFlow 页面后重试。'))
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法读取本地文献库。'))
  })
}

async function readSnapshot(): Promise<LocalSnapshot | null> {
  const db = await openExistingDatabase()
  if (!db) return null
  try {
    const tx = db.transaction(['papers', 'files', 'progress', 'annotations', 'notes'], 'readonly')
    return await new Promise<LocalSnapshot>((resolve, reject) => {
      let papers: Paper[] = []
      let progress: ReadingProgress[] = []
      let annotations: Annotation[] = []
      let notes: Note[] = []
      let fileKeys = new Set<IDBValidKey>()
      tx.oncomplete = () => resolve({ papers, progress, annotations, notes, fileKeys })
      tx.onabort = () => reject(tx.error ?? new Error('无法读取本地文献库。'))
      tx.onerror = () => { /* onabort reports the transaction error */ }
      const stores = tx.objectStore.bind(tx)
      requestResult(stores('papers').getAll()).then(value => { papers = value as Paper[] }, reject)
      requestResult(stores('progress').getAll()).then(value => { progress = value as ReadingProgress[] }, reject)
      requestResult(stores('annotations').getAll()).then(value => { annotations = value as Annotation[] }, reject)
      requestResult(stores('notes').getAll()).then(value => { notes = value as Note[] }, reject)
      requestResult(stores('files').getAllKeys()).then(value => { fileKeys = new Set(value) }, reject)
    })
  } finally {
    db.close()
  }
}

async function readPaperData(paper: Paper): Promise<{ file: Blob | undefined; annotations: Annotation[]; notes: Note[] } | null> {
  const db = await openExistingDatabase()
  if (!db) return null
  try {
    const tx = db.transaction(['files', 'annotations', 'notes'], 'readonly')
    return await new Promise((resolve, reject) => {
      let file: Blob | undefined
      let annotations: Annotation[] = []
      let notes: Note[] = []
      tx.oncomplete = () => resolve({ file, annotations, notes })
      tx.onabort = () => reject(tx.error ?? new Error('无法读取本地文献数据。'))
      tx.onerror = () => { /* onabort reports the transaction error */ }
      requestResult(tx.objectStore('files').get(paper.fileKey)).then(value => { file = (value as { blob: Blob } | undefined)?.blob }, reject)
      requestResult(tx.objectStore('annotations').index('paperId').getAll(paper.id)).then(value => { annotations = value as Annotation[] }, reject)
      requestResult(tx.objectStore('notes').index('paperId').getAll(paper.id)).then(value => { notes = value as Note[] }, reject)
    })
  } finally {
    db.close()
  }
}

function normalizeTitle(value: string) {
  return value.trim().toLocaleLowerCase()
}

export async function scanLocalLibrary(remoteItems: LibraryItem[]): Promise<LocalImportScan> {
  const snapshot = await readSnapshot()
  if (!snapshot) return { items: [], annotationCount: 0, noteCount: 0 }
  const remoteIds = new Set(remoteItems.map(item => item.paper.id))
  const remoteTitles = new Set(remoteItems.map(item => normalizeTitle(item.paper.title)))
  const annotationCounts = new Map<string, number>()
  for (const annotation of snapshot.annotations) annotationCounts.set(annotation.paperId, (annotationCounts.get(annotation.paperId) ?? 0) + 1)
  const noteCounts = new Map<string, number>()
  for (const note of snapshot.notes) noteCounts.set(note.paperId, (noteCounts.get(note.paperId) ?? 0) + 1)
  const items = snapshot.papers.map(paper => {
    const annotationCount = annotationCounts.get(paper.id) ?? 0
    const noteCount = noteCounts.get(paper.id) ?? 0
    let conflict: ImportConflict = 'none'
    if (remoteIds.has(paper.id)) conflict = 'already-imported'
    else if (!snapshot.fileKeys.has(paper.fileKey)) conflict = 'missing-file'
    else if (remoteTitles.has(normalizeTitle(paper.title))) conflict = 'duplicate-title'
    return { paper, progress: snapshot.progress.find(progress => progress.paperId === paper.id) ?? { paperId: paper.id, userId: 'local-user', lastPage: 1, status: 'unread' as const, updatedAt: '' }, annotationCount, noteCount, conflict }
  }).sort((a, b) => (b.progress.updatedAt || b.paper.createdAt).localeCompare(a.progress.updatedAt || a.paper.createdAt))
  return { items, annotationCount: snapshot.annotations.length, noteCount: snapshot.notes.length }
}

export async function importLocalItem(item: LocalImportItem): Promise<LocalImportResult> {
  const data = await readPaperData(item.paper)
  if (!data?.file) throw new Error('本地 PDF 文件缺失，无法导入。')
  const paper = item.paper
  const warnings: string[] = []
  await remoteLibrary.createPaper({ ...paper, ownerId: '', workspaceId: null, fileKey: paper.id }, data.file)
  const metadata = { title: paper.title.slice(0, 300), authors: paper.authors.slice(0, 300), abstract: paper.abstract.slice(0, 10000), year: /^\d{4}$/.test(paper.year) ? paper.year : '', venue: paper.venue.slice(0, 200), doi: paper.doi.slice(0, 200) }
  if (metadata.authors || metadata.abstract || metadata.year || metadata.venue || metadata.doi) {
    try { await remoteLibrary.updatePaper(paper.id, metadata) } catch { warnings.push('文献已导入，但作者、摘要等元数据保存失败。') }
  }
  try {
    if (item.progress.lastPage > 1 || item.progress.status !== 'unread') {
      await remoteLibrary.saveProgress(paper.id, Math.max(1, Math.min(item.progress.lastPage, paper.pageCount)))
      if (item.progress.status === 'finished') await remoteLibrary.setStatus(paper.id, 'finished')
    }
  } catch { warnings.push('文献已导入，但阅读进度保存失败。') }
  let annotations = 0
  let notes = 0
  for (const annotation of data.annotations.filter(value => !value.workspaceId)) {
    try {
      await remoteLibrary.createAnnotation({ ...annotation, paperId: paper.id, userId: '', workspaceId: null })
      annotations += 1
    } catch { warnings.push(`高亮“${annotation.text.slice(0, 30)}”导入失败。`); continue }
    const note = data.notes.find(value => value.annotationId === annotation.id)
    if (note?.content.trim()) {
      try { await remoteLibrary.saveNote({ ...note, paperId: paper.id, authorId: '', workspaceId: null }); notes += 1 }
      catch { warnings.push(`高亮“${annotation.text.slice(0, 30)}”的笔记导入失败。`) }
    }
  }
  return { paperId: paper.id, title: paper.title, annotations, notes, warnings }
}
