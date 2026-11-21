import type { HighlightAnchor } from './index'

export interface PaperChunk {
  chunkId: string
  paperId: string
  pageNumber: number
  text: string
}
export interface Citation {
  paperId: string
  pageNumber: number
  chunkId: string
  quote: string
}
export type AiMode = 'overview' | 'explain' | 'translate' | 'question'
export interface AiMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  citations?: Citation[]
  source?: 'model' | 'demo' | 'local'
  selection?: HighlightAnchor
}
