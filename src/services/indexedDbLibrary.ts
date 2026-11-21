import type { Annotation, LibraryItem, Note, Paper, ReadingProgress } from '../types/library'
import type { AiMessage, PaperChunk } from '../types/ai'
import { LOCAL_USER_ID, type LibraryStorage } from './libraryRepository'

const DATABASE = 'paperflow-library'
const STORES = ['papers', 'files', 'progress', 'annotations', 'notes', 'chunks', 'aiHistory'] as const
let databasePromise: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      let blocked = false
      const request = indexedDB.open(DATABASE, 2)
      request.onupgradeneeded = event => {
        const db = request.result
        if (event.oldVersion < 1) {
          db.createObjectStore('papers', { keyPath: 'id' })
          db.createObjectStore('files', { keyPath: 'key' })
          db.createObjectStore('progress', { keyPath: 'paperId' })
          const annotations = db.createObjectStore('annotations', { keyPath: 'id' })
          annotations.createIndex('paperId', 'paperId')
          const notes = db.createObjectStore('notes', { keyPath: 'annotationId' })
          notes.createIndex('paperId', 'paperId')
        }
        if (event.oldVersion < 2) {
          db.createObjectStore('chunks', { keyPath: 'chunkId' }).createIndex('paperId', 'paperId')
          db.createObjectStore('aiHistory', { keyPath: 'paperId' })
        }
      }
      request.onsuccess = () => {
        const db = request.result
        if (blocked) { db.close(); return }
        db.onversionchange = () => { db.close(); databasePromise = undefined }
        resolve(db)
      }
      request.onerror = () => reject(request.error ?? new Error('无法打开本地存储'))
      request.onblocked = () => { blocked = true; reject(new Error('本地数据库被其他页面阻塞，请关闭其他 PaperFlow 页面后重试')) }
    }).catch(error => { databasePromise = undefined; throw error })
  }
  return databasePromise
}

async function transact<T>(stores: readonly string[], mode: IDBTransactionMode, action: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  const db = await openDatabase()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction([...stores], mode)
    let value: T
    tx.oncomplete = () => resolve(value)
    tx.onabort = () => reject(tx.error ?? new Error('本地存储事务失败'))
    tx.onerror = () => { /* onabort reports the transaction error */ }
    try { action(tx, result => { value = result }) } catch (error) { tx.abort(); reject(error) }
  })
}

function emptyProgress(paperId: string): ReadingProgress {
  return { paperId, userId: LOCAL_USER_ID, lastPage: 1, status: 'unread', updatedAt: '' }
}

function deleteByPaper(tx: IDBTransaction, storeName: 'annotations' | 'notes' | 'chunks', paperId: string) {
  const request = tx.objectStore(storeName).index('paperId').openKeyCursor(IDBKeyRange.only(paperId))
  request.onsuccess = () => {
    const cursor = request.result
    if (cursor) { tx.objectStore(storeName).delete(cursor.primaryKey); cursor.continue() }
  }
}

export const indexedDbLibrary: LibraryStorage = {
  async listPapers() {
    return transact<LibraryItem[]>(['papers', 'progress'], 'readonly', (tx, result) => {
      const papers = tx.objectStore('papers').getAll()
      const progress = tx.objectStore('progress').getAll()
      progress.onsuccess = () => result((papers.result as Paper[]).map(paper => ({ paper, progress: (progress.result as ReadingProgress[]).find(item => item.paperId === paper.id) ?? emptyProgress(paper.id) })).sort((a, b) => (b.progress.updatedAt || b.paper.createdAt).localeCompare(a.progress.updatedAt || a.paper.createdAt)))
    })
  },
  async getPaper(id) {
    const items = await this.listPapers()
    return items.find(item => item.paper.id === id)
  },
  async getFile(key) {
    return transact<Blob | undefined>(['files'], 'readonly', (tx, result) => {
      const request = tx.objectStore('files').get(key)
      request.onsuccess = () => result((request.result as { blob: Blob } | undefined)?.blob)
    })
  },
  async putFile(key, file) {
    return transact<void>(['files'], 'readwrite', tx => { tx.objectStore('files').put({ key, blob: file }) })
  },
  async deleteFile(key) {
    return transact<void>(['files'], 'readwrite', tx => { tx.objectStore('files').delete(key) })
  },
  async createPaper(paper, file) {
    return transact<void>(['papers', 'files', 'progress'], 'readwrite', tx => {
      tx.objectStore('papers').add(paper)
      tx.objectStore('files').add({ key: paper.fileKey, blob: file })
      tx.objectStore('progress').add(emptyProgress(paper.id))
    })
  },
  async updatePaper(id, metadata) {
    return transact<void>(['papers'], 'readwrite', tx => {
      const store = tx.objectStore('papers')
      const request = store.get(id)
      request.onsuccess = () => {
        if (!request.result) { tx.abort(); return }
        store.put({ ...request.result, ...metadata, updatedAt: new Date().toISOString() })
      }
    })
  },
  async deletePaper(id) {
    return transact<void>(STORES, 'readwrite', tx => {
      const papers = tx.objectStore('papers')
      const request = papers.get(id)
      request.onsuccess = () => {
        const paper = request.result as Paper | undefined
        if (!paper) { tx.abort(); return }
        papers.delete(id)
        tx.objectStore('files').delete(paper.fileKey)
        tx.objectStore('progress').delete(id)
        deleteByPaper(tx, 'annotations', id)
        deleteByPaper(tx, 'notes', id)
        deleteByPaper(tx, 'chunks', id)
        tx.objectStore('aiHistory').delete(id)
      }
    })
  },
  async saveProgress(paperId, page) {
    return transact<void>(['papers', 'progress'], 'readwrite', tx => {
      const paperRequest = tx.objectStore('papers').get(paperId)
      paperRequest.onsuccess = () => {
        const paper = paperRequest.result as Paper | undefined
        if (!paper) { tx.abort(); return }
        const store = tx.objectStore('progress')
        const request = store.get(paperId)
        request.onsuccess = () => {
          const progress = (request.result as ReadingProgress | undefined) ?? emptyProgress(paperId)
          store.put({ ...progress, lastPage: Math.max(1, Math.min(page, paper.pageCount)), status: progress.status === 'unread' ? 'reading' : progress.status, updatedAt: new Date().toISOString() })
        }
      }
    })
  },
  async setStatus(paperId, status) {
    return transact<void>(['papers', 'progress'], 'readwrite', tx => {
      const paperRequest = tx.objectStore('papers').get(paperId)
      paperRequest.onsuccess = () => {
        if (!paperRequest.result) { tx.abort(); return }
        const store = tx.objectStore('progress')
        const request = store.get(paperId)
        request.onsuccess = () => store.put({ ...(request.result ?? emptyProgress(paperId)), status, updatedAt: new Date().toISOString() })
      }
    })
  },
  async listAnnotations(paperId, _workspaceId) {
    return transact<Annotation[]>(['annotations'], 'readonly', (tx, result) => {
      const request = tx.objectStore('annotations').index('paperId').getAll(paperId)
      request.onsuccess = () => result(request.result as Annotation[])
    })
  },
  async createAnnotation(annotation) {
    return transact<void>(['papers', 'annotations'], 'readwrite', tx => {
      const request = tx.objectStore('papers').get(annotation.paperId)
      request.onsuccess = () => { if (!request.result) { tx.abort(); return }; tx.objectStore('annotations').add(annotation) }
    })
  },
  async deleteAnnotation(id) {
    return transact<void>(['annotations', 'notes'], 'readwrite', tx => { tx.objectStore('annotations').delete(id); tx.objectStore('notes').delete(id) })
  },
  async getNote(annotationId) {
    return transact<Note | undefined>(['notes'], 'readonly', (tx, result) => {
      const request = tx.objectStore('notes').get(annotationId)
      request.onsuccess = () => result(request.result as Note | undefined)
    })
  },
  async saveNote(note) {
    return transact<void>(['annotations', 'notes'], 'readwrite', tx => {
      const request = tx.objectStore('annotations').get(note.annotationId)
      request.onsuccess = () => { if (!request.result || request.result.paperId !== note.paperId) { tx.abort(); return }; tx.objectStore('notes').put(note) }
    })
  },
  async createAnnotationWithNote(annotation, note) {
    return transact<void>(['papers', 'annotations', 'notes'], 'readwrite', tx => {
      const request = tx.objectStore('papers').get(annotation.paperId)
      request.onsuccess = () => {
        if (!request.result || note.paperId !== annotation.paperId || note.annotationId !== annotation.id) { tx.abort(); return }
        tx.objectStore('annotations').add(annotation)
        tx.objectStore('notes').put(note)
      }
    })
  },
  async getChunks(paperId) {
    return transact<PaperChunk[]>(['chunks'], 'readonly', (tx, result) => {
      const request = tx.objectStore('chunks').index('paperId').getAll(paperId)
      request.onsuccess = () => result((request.result as PaperChunk[]).sort((a, b) => a.pageNumber - b.pageNumber || a.chunkId.localeCompare(b.chunkId)))
    })
  },
  async saveChunks(paperId, chunks) {
    return transact<void>(['papers', 'chunks'], 'readwrite', tx => {
      const request = tx.objectStore('papers').get(paperId)
      request.onsuccess = () => {
        if (!request.result || chunks.some(chunk => chunk.paperId !== paperId)) { tx.abort(); return }
        const store = tx.objectStore('chunks')
        const keys = store.index('paperId').getAllKeys(paperId)
        keys.onsuccess = () => {
          for (const key of keys.result) store.delete(key)
          for (const chunk of chunks) store.put(chunk)
        }
      }
    })
  },
  async getAiHistory(paperId) {
    return transact<AiMessage[]>(['aiHistory'], 'readonly', (tx, result) => {
      const request = tx.objectStore('aiHistory').get(paperId)
      request.onsuccess = () => result((request.result as { messages: AiMessage[] } | undefined)?.messages ?? [])
    })
  },
  async saveAiHistory(paperId, messages) {
    return transact<void>(['papers', 'aiHistory'], 'readwrite', tx => {
      const request = tx.objectStore('papers').get(paperId)
      request.onsuccess = () => {
        if (!request.result) { tx.abort(); return }
        tx.objectStore('aiHistory').put({ paperId, messages: messages.slice(-40) })
      }
    })
  },
}

