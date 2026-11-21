import type { PaperChunk } from '../../types/ai'

const stop = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'what', 'does', 'how', 'are', 'was', 'were', 'paper', 'study', 'article', 'about', '请问', '论文', '本文', '这个', '什么', '如何', '是否', '哪些', '说明', '作者', '研究', '中的', '是什么'])
const synonyms: [RegExp, string][] = [
  [/实验|评估|验证/, 'experiment evaluation'], [/结果|效果|表现/, 'result performance'],
  [/方法|模型|算法/, 'method model algorithm'], [/创新|贡献/, 'contribution novelty'],
  [/局限|限制|不足/, 'limitation limitations'], [/背景/, 'background introduction'],
]

function terms(value: string): string[] {
  const text = value.toLowerCase()
  const result = new Set<string>()
  for (const match of text.matchAll(/[a-z0-9]{3,}|[\u3400-\u9fff]+/g)) {
    const word = match[0]
    if (/^[\u3400-\u9fff]+$/.test(word)) {
      for (let i = 0; i < word.length - 1; i++) { const token = word.slice(i, i + 2); if (!stop.has(token)) result.add(token) }
    } else if (!stop.has(word)) result.add(word)
  }
  for (const [pattern, expansion] of synonyms) if (pattern.test(text)) for (const word of expansion.split(' ')) result.add(word)
  return [...result].slice(0, 30)
}

export function retrieveChunks(chunks: PaperChunk[], query: string, limit = 8): PaperChunk[] {
  const queryTerms = terms(query)
  if (!queryTerms.length) return []
  const lower = chunks.map(chunk => chunk.text.toLowerCase())
  const frequencies = new Map(queryTerms.map(term => [term, lower.filter(text => text.includes(term)).length]))
  return chunks.map((chunk, index) => {
    let score = 0
    for (const term of queryTerms) if (lower[index].includes(term)) score += Math.log(1 + chunks.length / (1 + (frequencies.get(term) ?? 0)))
    return { chunk, score }
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.chunk.pageNumber - b.chunk.pageNumber).slice(0, limit).map(item => item.chunk)
}

export function overviewChunks(chunks: PaperChunk[], limit = 8): PaperChunk[] {
  if (chunks.length <= limit) return chunks
  return Array.from({ length: limit }, (_, index) => chunks[Math.round(index * (chunks.length - 1) / (limit - 1))])
}

export function selectionChunks(chunks: PaperChunk[], page: number, selection: string): PaperChunk[] {
  const normalized = (text: string) => text.replace(/\s+/g, ' ').trim()
  const selected = normalized(selection)
  return chunks.filter(chunk => chunk.pageNumber === page && normalized(chunk.text).includes(selected)).slice(0, 2)
}
