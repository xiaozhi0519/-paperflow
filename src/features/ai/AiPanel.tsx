import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { BookOpenText, Send, Sparkles } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { libraryStore, storageMode } from '../../services/libraryStore'
import { getAiStatus, requestAi, type AiStatus } from '../../services/aiClient'
import type { HighlightAnchor } from '../../types'
import type { AiMessage, AiMode, Citation } from '../../types/ai'
import { extractPaperChunks } from './extract'
import { overviewChunks, retrieveChunks, selectionChunks } from './retrieval'

export type AiCommand = { id: string; mode: 'explain' | 'translate' | 'selection-question'; selection: HighlightAnchor }

type Props = {
  paperId: string
  pdf: PDFDocumentProxy | null
  command: AiCommand | null
  onCitation: (citation: Citation) => void
  onCommandHandled: () => void
  onSaveNote: (selection: HighlightAnchor, text: string) => Promise<void>
}

export function AiPanel({ paperId, pdf, command, onCitation, onCommandHandled, onSaveNote }: Props) {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [statusReady, setStatusReady] = useState(false)
  const [history, setHistory] = useState<AiMessage[]>([])
  const [historyReady, setHistoryReady] = useState(false)
  const [question, setQuestion] = useState('')
  const [selection, setSelection] = useState<HighlightAnchor | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const processed = useRef('')
  const historyRef = useRef<AiMessage[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let active = true
    void getAiStatus().then(value => { if (active) setStatus(value) }).catch(() => { if (active) setStatus({ configured: false, model: null }) }).finally(() => { if (active) setStatusReady(true) })
    void libraryStore.getAiHistory(paperId).then(messages => { if (active) { historyRef.current = messages; setHistory(messages) } }).catch(() => { if (active) setError('无法读取本地会话历史。') }).finally(() => { if (active) setHistoryReady(true) })
    return () => { active = false }
  }, [paperId])

  async function persist(next: AiMessage[]) {
    const limited = next.slice(-40)
    historyRef.current = limited
    setHistory(limited)
    try { await libraryStore.saveAiHistory(paperId, limited) } catch { setError('会话历史保存失败，当前内容可能在刷新后丢失。') }
  }

  async function run(mode: AiMode, prompt: string, selected: HighlightAnchor | null) {
    if (!pdf || busy || !historyReady || !statusReady) return
    if (selected && selected.text.length > 1000) { setError('选区过长，请选择不超过 1000 字符且不跨分块的原文。'); return }
    setBusy(true); setError(''); setNotice(''); setProgress('正在读取论文文本...')
    const label = mode === 'overview' ? '论文整体解读' : mode === 'explain' ? '解释选段' : mode === 'translate' ? '翻译选段' : prompt
    const userMessage: AiMessage = { id: crypto.randomUUID(), role: 'user', text: label, selection: selected ?? undefined }
    try {
      let chunks = await libraryStore.getChunks(paperId)
      if (!chunks.length) {
        const extracted = await extractPaperChunks(pdf, paperId, (page, total) => setProgress(`正在解析论文 ${page} / ${total} 页...`))
        chunks = extracted.chunks
        if (chunks.length) await libraryStore.saveChunks(paperId, chunks)
        if (extracted.truncated) setNotice('论文较长，仅索引了前 200 页或前 1200 个分块，回答不覆盖全文。')
      }
      if (!chunks.length) throw new Error('PDF 没有可提取的文字，扫描件暂不支持 OCR。')
      if (pdf.numPages > 200 || chunks.length >= 1200) setNotice('论文较长，仅索引了前 200 页或前 1200 个分块，回答不覆盖全文。')
      const selectedChunks = selected ? selectionChunks(chunks, selected.page, selected.text) : []
      if (selected && !selectedChunks.length) throw new Error('无法将选区与该页提取文本精确对应，请缩短选区或尝试其他文字。')
      const retrieved = mode === 'overview' ? overviewChunks(chunks) : selected ? [...selectedChunks, ...retrieveChunks(chunks, prompt).filter(chunk => !selectedChunks.some(item => item.chunkId === chunk.chunkId))].slice(0, 8) : retrieveChunks(chunks, prompt)
      let answer: AiMessage
      if (!retrieved.length) {
        answer = { id: crypto.randomUUID(), role: 'assistant', source: 'local', text: '未找到匹配的原文证据，无法从当前论文确认。', citations: [] }
      } else if (!status?.configured) {
        const citations = retrieved.slice(0, 3).map(chunk => ({ paperId, pageNumber: chunk.pageNumber, chunkId: chunk.chunkId, quote: selected && chunk.chunkId === selectedChunks[0]?.chunkId ? selected.text.slice(0, 180) : chunk.text.slice(0, 180) }))
        answer = { id: crypto.randomUUID(), role: 'assistant', source: 'demo', text: 'AI 服务未连接：以下仅为本地检索到的原文片段，不是模型解读或回答。', citations, selection: selected ?? undefined }
      } else {
        setProgress('正在请求模型，请勿关闭页面...')
        const result = await requestAi({ paperId, mode, question: prompt, selection: selected?.text ?? '', chunks: retrieved })
        answer = { id: crypto.randomUUID(), role: 'assistant', source: result.source, text: result.answer, citations: result.citations, selection: selected ?? undefined }
      }
      await persist([...historyRef.current, userMessage, answer])
      if (mode === 'overview') setNotice(current => `${current ? `${current} ` : ''}整体解读仅基于有限抽样片段，不能代表全文。`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '处理失败，请重试。') }
    finally { setProgress(''); setBusy(false) }
  }

  useEffect(() => {
    if (!command || !historyReady || !statusReady || !pdf || processed.current === command.id) return
    processed.current = command.id
    onCommandHandled()
    setSelection(command.selection)
    if (command.mode === 'selection-question') { inputRef.current?.focus(); return }
    void run(command.mode, '', command.selection)
  })

  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = question.trim()
    if (!value) return
    setQuestion('')
    await run('question', value, selection)
  }
  async function saveAsNote(message: AiMessage) {
    if (!message.selection) return
    setBusy(true); setError(''); setNotice('')
    try { await onSaveNote(message.selection, message.text); setNotice('回答与选区已保存为高亮笔记。') }
    catch { setError('保存笔记失败，请检查浏览器存储。') }
    finally { setBusy(false) }
  }

  return <div className="ai-panel"><div className="inspector-heading"><span className="inspector-icon"><Sparkles size={18} /></span><div><h2>论文 AI 助手</h2><p>{!statusReady ? '正在检查服务...' : status?.configured ? `模型已配置：${status.model}（未验证连接）` : 'AI 服务未连接 · 本地检索演示'}</p></div></div>
    <div className="ai-body"><div className="ai-privacy">{status?.configured ? '发起请求时，问题、选区和最多 8 个论文片段将发送至配置的模型服务；请勿提交敏感论文。' : '本地演示不生成 AI 答案，也不会发送论文内容。'} {storageMode === 'local' ? '历史仅保存在当前浏览器，最多 40 条。' : '远程模式的 AI 历史仅保留在当前页面内存中，刷新后清除。'}</div>
      <Button className="ai-overview" disabled={busy || !pdf || !statusReady || !historyReady} onClick={() => { setSelection(null); void run('overview', '', null) }}><BookOpenText size={15} />论文整体解读</Button>
      <p className="ai-limits">词项检索不等同语义检索；引文仅校验文字存在，不保证回答推理正确。每次提问独立处理，不发送历史。</p>
      {progress && <div className="ai-progress" role="status">{progress}</div>}{error && <div className="ai-error" role="alert">{error}</div>}{notice && <div className="ai-notice" role="status">{notice}</div>}
      <div className="ai-messages" aria-label="AI 会话历史">{history.length === 0 && <div className="saved-empty">输入问题，或选中原文后选择解释、翻译或提问。</div>}{history.map(message => <div key={message.id} className={`ai-message ai-message--${message.role}`}><div className="ai-message__label">{message.role === 'user' ? '你' : message.source === 'model' ? '模型回答 · 请核对证据' : message.source === 'demo' ? '本地检索演示 · 非 AI' : '本地提示'}</div><div className="ai-message__text">{message.text}</div>{message.citations?.map((citation, index) => <button className="citation-card" key={`${citation.chunkId}-${index}`} onClick={() => onCitation(citation)}><strong>第 {citation.pageNumber} 页 · 页码级引用</strong><span>“{citation.quote}”</span><small>点击跳转并尝试匹配原文</small></button>)}{message.role === 'assistant' && message.selection && message.source === 'model' && <Button size="small" disabled={busy} onClick={() => void saveAsNote(message)}>保存回答为笔记</Button>}</div>)}</div>
      {selection && <div className="ai-selection"><span>关联第 {selection.page} 页选区：{selection.text.slice(0, 70)}{selection.text.length > 70 ? '…' : ''}</span><button onClick={() => setSelection(null)} aria-label="取消关联选区">×</button></div>}
      <form className="ai-form" onSubmit={event => void submit(event)}><textarea ref={inputRef} className="input" aria-label="向论文提问" placeholder="向当前论文提问..." maxLength={1000} value={question} onChange={event => setQuestion(event.target.value)} /><Button variant="primary" type="submit" disabled={busy || !pdf || !question.trim() || !statusReady || !historyReady} aria-label="发送问题"><Send size={15} /></Button></form>
      {history.length > 0 && <button className="ai-clear" disabled={busy} onClick={() => void persist([])}>清空本地会话</button>}
    </div></div>
}
