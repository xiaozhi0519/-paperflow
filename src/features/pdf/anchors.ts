import type { HighlightAnchor, HighlightRect } from '../../types'

export function captureSelection(pageElement: HTMLElement, page: number): HighlightAnchor | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed || !selection.toString().trim()) return null
  const range = selection.getRangeAt(0).cloneRange()
  if (!pageElement.contains(range.startContainer) || !pageElement.contains(range.endContainer)) return null
  const textLayer = pageElement.querySelector('.textLayer')
  if (!textLayer?.contains(range.startContainer) || !textLayer.contains(range.endContainer)) return null
  const walker = pageElement.ownerDocument.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT)
  let first: { node: Node; offset: number } | null = null
  let last: { node: Node; offset: number } | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : node.textContent!.length
    const fragment = node.textContent!.slice(start, end)
    const leading = fragment.search(/\S/)
    if (leading < 0) continue
    first ??= { node, offset: start + leading }
    last = { node, offset: start + fragment.trimEnd().length }
  }
  if (!first || !last) return null
  range.setStart(first.node, first.offset)
  range.setEnd(last.node, last.offset)
  const pageRect = pageElement.getBoundingClientRect()
  if (!pageRect.width || !pageRect.height) return null
  const rects: HighlightRect[] = Array.from(range.getClientRects())
    .filter(rect => rect.width > 0 && rect.height > 0)
    .map(rect => ({ x: (rect.left - pageRect.left) / pageRect.width, y: (rect.top - pageRect.top) / pageRect.height, width: rect.width / pageRect.width, height: rect.height / pageRect.height }))
    .filter(rect => rect.x >= -0.01 && rect.y >= -0.01 && rect.x + rect.width <= 1.01 && rect.y + rect.height <= 1.01)
  if (!rects.length) return null
  return { id: crypto.randomUUID(), page, text: selection.toString().trim(), rects }
}

export function loadAnchors(key: string): HighlightAnchor[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter((item): item is HighlightAnchor => typeof item?.id === 'string' && Number.isInteger(item.page) && typeof item.text === 'string' && Array.isArray(item.rects) && item.rects.every((rect: HighlightRect) => Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.width) && Number.isFinite(rect.height)))
  } catch {
    return []
  }
}
