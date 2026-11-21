import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PaperChunk } from '../../types/ai'

const MAX_PAGES = 200
const MAX_CHUNKS = 1200
const CHUNK_SIZE = 1000

type Line = { text: string; y: number; height: number; breakBefore: boolean }

function cleanLine(line: string) {
  return line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim()
}

export async function extractPaperChunks(pdf: PDFDocumentProxy, paperId: string, progress?: (page: number, total: number) => void): Promise<{ chunks: PaperChunk[]; scannedPages: number; truncated: boolean }> {
  const count = Math.min(pdf.numPages, MAX_PAGES)
  const pages: Line[][] = []
  for (let number = 1; number <= count; number++) {
    const content = await (await pdf.getPage(number)).getTextContent()
    const lines: Line[] = []
    let text = ''
    let y = 0
    let height = 0
    let breakBefore = false
    function finishLine() {
      const cleaned = cleanLine(text)
      if (cleaned) { lines.push({ text: cleaned, y, height, breakBefore }); breakBefore = false }
      else breakBefore = true
      text = ''; height = 0
    }
    for (const item of content.items) {
      if (!('str' in item)) continue
      const value = item.str
      if (!text && value) { y = item.transform[5]; height = Math.abs(item.height) || Math.abs(item.transform[3]) || 1 }
      const separator = text && value && !/\s$/.test(text) && !/^\s/.test(value) && !(/[\u3400-\u9fff]$/.test(text) && /^[\u3400-\u9fff]/.test(value)) ? ' ' : ''
      text += separator + value
      if (item.hasEOL) finishLine()
    }
    if (text) finishLine()
    pages.push(lines)
    progress?.(number, count)
  }
  const repeated = new Map<string, number>()
  if (count >= 3) {
    for (const lines of pages) {
      for (const line of new Set([lines[0]?.text, lines[lines.length - 1]?.text].filter((value): value is string => Boolean(value) && value.length <= 100))) repeated.set(line, (repeated.get(line) ?? 0) + 1)
    }
  }
  const chunks: PaperChunk[] = []
  let reachedLimit = false
  for (let page = 0; page < pages.length; page++) {
    const lines = pages[page].filter((line, index, array) => {
      const edge = index === 0 || index === array.length - 1
      return !(edge && ((repeated.get(line.text) ?? 0) >= Math.max(3, Math.ceil(count * 0.6)) || /^\d{1,4}$/.test(line.text)))
    })
    const paragraphs: string[] = []
    let paragraph = ''
    let previous: Line | undefined
    for (const line of lines) {
      if (paragraph && previous && (line.breakBefore || Math.abs(previous.y - line.y) > Math.max(previous.height, line.height) * 1.8)) { paragraphs.push(paragraph); paragraph = '' }
      paragraph += `${paragraph ? ' ' : ''}${line.text}`
      previous = line
    }
    if (paragraph) paragraphs.push(paragraph)
    let index = 0
    let buffer = ''
    function flush() {
      if (buffer) chunks.push({ chunkId: `${paperId}:v1:${String(page + 1).padStart(4, '0')}:${String(index++).padStart(4, '0')}`, paperId, pageNumber: page + 1, text: buffer })
      buffer = ''
    }
    for (const part of paragraphs) {
      for (let start = 0; start < part.length;) {
        let end = Math.min(start + CHUNK_SIZE, part.length)
        if (end < part.length) {
          const boundary = part.lastIndexOf(' ', end)
          if (boundary > start + CHUNK_SIZE / 2) end = boundary
        }
        const segment = part.slice(start, end).trim()
        if (buffer && buffer.length + segment.length + 1 > CHUNK_SIZE) flush()
        if (segment) buffer += `${buffer ? ' ' : ''}${segment}`
        start = end
        if (chunks.length >= MAX_CHUNKS) { reachedLimit = true; break }
      }
      if (reachedLimit) break
    }
    if (!reachedLimit) flush()
    if (chunks.length >= MAX_CHUNKS) { reachedLimit = true; break }
  }
  return { chunks, scannedPages: count, truncated: count < pdf.numPages || reachedLimit }
}
