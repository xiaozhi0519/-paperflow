import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, BookOpen, ChevronLeft, ChevronRight, Highlighter, Minus, Plus, Trash2 } from 'lucide-react'
import { getDocument, TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import '../features/pdf/pdfConfig'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { LoadingState } from '../components/ui/States'
import { captureSelection } from '../features/pdf/anchors'
import { AiPanel, type AiCommand } from '../features/ai/AiPanel'
import { DiscussionPanel } from '../features/discussion/DiscussionPanel'
import { KnowledgeEditor } from '../components/KnowledgeEditor'
import type { KnowledgeKind, KnowledgeSource } from '../services/knowledge'
import { useAuth } from '../services/auth'
import { libraryStore, storageMode } from '../services/libraryStore'
import { LOCAL_USER_ID } from '../services/libraryRepository'
import { workspaceService } from '../services/workspaces'
import type { HighlightAnchor, HighlightRect } from '../types'
import type { Citation } from '../types/ai'
import type { Annotation, LibraryItem, Note } from '../types/library'

export function ReaderPage() {
  const { paperId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const workspaceId = storageMode === 'remote' ? searchParams.get('workspace') : null
  const { user } = useAuth()
  const [workspaceName, setWorkspaceName] = useState('')
  const [item, setItem] = useState<LibraryItem | null>(null)
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(1)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [selection, setSelection] = useState<HighlightAnchor | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [noteText, setNoteText] = useState('')
  const [noteReady, setNoteReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [rendering, setRendering] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [selectionHint, setSelectionHint] = useState('')
  const [hasText, setHasText] = useState(true)
  const [dimensions, setDimensions] = useState({ width: 612, height: 792 })
  const [panel, setPanel] = useState<'annotations' | 'discussion' | 'ai'>('annotations')
  const [command, setCommand] = useState<AiCommand | null>(null)
  const [citation, setCitation] = useState<Citation | null>(null)
  const [citationRects, setCitationRects] = useState<HighlightRect[]>([])
  const [citationStatus, setCitationStatus] = useState('')
  const pageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const noteRequest = useRef(0)
  const renderedPage = useRef<number | null>(null)
  const annotationWorkspaceId = workspaceId ?? null
  const sourceAnnotationId = searchParams.get('annotation')
  const sourceCommentId = searchParams.get('comment')
  const [discussionAnnotationId, setDiscussionAnnotationId] = useState<string | null>(null)
  const [knowledgeDraft, setKnowledgeDraft] = useState<{ source: KnowledgeSource; kind: KnowledgeKind } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  function createKnowledge(source: KnowledgeSource, kind: KnowledgeKind) { setKnowledgeDraft({ source, kind }) }

  useEffect(() => {
    let cancelled = false
    let task: ReturnType<typeof getDocument> | undefined
    setLoading(true); setError(''); setDocument(null); setItem(null); setWorkspaceName(''); setAnnotations([]); setActiveId(null); setNote(null); setNoteText(''); setNoteReady(false); setSelection(null); setKnowledgeDraft(null); setDiscussionAnnotationId(null); noteRequest.current++
    async function load() {
      try {
        const workspace = workspaceId ? await workspaceService.detail(workspaceId) : null
        const record = await libraryStore.getPaper(paperId)
        if (!record) throw new Error('文献不存在或无权访问。')
        const [file, saved] = await Promise.all([libraryStore.getFile(record.paper.fileKey), libraryStore.listAnnotations(paperId, workspaceId)])
        if (!file) throw new Error('PDF 文件不存在或无权访问。')
        const bytes = await file.arrayBuffer()
        if (cancelled) return
        task = getDocument({ data: new Uint8Array(bytes), enableXfa: false })
        const pdf = await task.promise
        if (cancelled) return
        setItem(record); setWorkspaceName(workspace?.name ?? ''); setAnnotations(saved); setPage(Math.max(1, Math.min(record.progress.lastPage, pdf.numPages))); setDocument(pdf)
        const anchor = saved.find(value => value.id === sourceAnnotationId)
        if (anchor) { await openNote(anchor); if (cancelled) return; setDiscussionAnnotationId(anchor.id) }
        else if (sourceAnnotationId) setError('关联批注已删除或无权访问。')
        setPanel(sourceCommentId ? 'discussion' : 'annotations')
      } catch (cause) { if (!cancelled) setError(`无法打开 PDF：${cause instanceof Error ? cause.message : '文件可能已损坏或不受支持。'}`) }
      finally { if (!cancelled) setLoading(false) }
    }
    void load()
    return () => { cancelled = true; noteRequest.current++; if (task) void task.destroy() }
  }, [paperId, workspaceId, sourceAnnotationId, sourceCommentId, reloadKey])

  useEffect(() => {
    if (!activeId || rendering) return
    pageRef.current?.querySelector(`[data-annotation-id="${activeId}"]`)?.scrollIntoView({ block: 'center', inline: 'center' })
  }, [activeId, rendering, page])

  useEffect(() => {
    if (!document || !canvasRef.current || !textLayerRef.current) return
    let cancelled = false
    let renderTask: RenderTask | undefined
    let textLayer: TextLayer | undefined
    const canvas = canvasRef.current
    const layer = textLayerRef.current
    renderedPage.current = null
    setRendering(true); setSelection(null); setSelectionHint(''); layer.replaceChildren()
    async function renderPage() {
      try {
        const pdfPage = await document!.getPage(page)
        if (cancelled) return
        const viewport = pdfPage.getViewport({ scale })
        const outputScale = window.devicePixelRatio || 1
        setDimensions({ width: viewport.width, height: viewport.height })
        canvas.width = Math.floor(viewport.width * outputScale); canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`
        layer.style.setProperty('--total-scale-factor', String(viewport.scale * viewport.userUnit))
        layer.style.setProperty('--scale-round-x', '1px'); layer.style.setProperty('--scale-round-y', '1px')
        const context = canvas.getContext('2d')
        if (!context) throw new Error('浏览器无法创建画布。')
        renderTask = pdfPage.render({ canvas, canvasContext: context, viewport, transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0] })
        await renderTask.promise
        if (cancelled) return
        textLayer = new TextLayer({ textContentSource: pdfPage.streamTextContent(), container: layer, viewport })
        await textLayer.render()
        if (cancelled) return
        renderedPage.current = page
        setHasText(Boolean(layer.textContent?.trim()))
        try { await libraryStore.saveProgress(paperId, page) } catch { if (!cancelled) setError('阅读页码保存失败，请检查存储空间和权限。') }
      } catch (cause) { if (!cancelled) setError(`页面渲染失败：${cause instanceof Error ? cause.message : '未知错误'}`) }
      finally { if (!cancelled) setRendering(false) }
    }
    void renderPage()
    return () => { cancelled = true; renderTask?.cancel(); textLayer?.cancel(); layer.replaceChildren() }
  }, [document, page, scale, paperId])

  useEffect(() => {
    setCitationRects([])
    if (!citation || citation.pageNumber !== page || rendering || renderedPage.current !== page || !textLayerRef.current || !pageRef.current) return
    const spans = [...textLayerRef.current.querySelectorAll('span')]
    const matches = spans.flatMap(span => {
      const text = span.firstChild
      if (!text || text.nodeType !== Node.TEXT_NODE || !text.textContent) return []
      const first = text.textContent.indexOf(citation.quote)
      if (first < 0) return []
      if (text.textContent.indexOf(citation.quote, first + 1) >= 0) return [{ text, first }, { text, first }]
      return [{ text, first }]
    })
    if (matches.length !== 1) { setCitationStatus('已跳转至引用页；原文位置无法唯一匹配，仅提供页码级定位。'); return }
    const range = window.document.createRange()
    range.setStart(matches[0].text, matches[0].first)
    range.setEnd(matches[0].text, matches[0].first + citation.quote.length)
    const bounds = pageRef.current.getBoundingClientRect()
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => ({ x: (rect.left - bounds.left) / bounds.width, y: (rect.top - bounds.top) / bounds.height, width: rect.width / bounds.width, height: rect.height / bounds.height }))
    if (!rects.length) { setCitationStatus('已跳转至引用页；无法定位文本，仅提供页码级定位。'); return }
    setCitationRects(rects)
    setCitationStatus('已在当前页的文本层中唯一匹配并突出显示原文。')
  }, [citation, page, rendering, dimensions])

  function startAi(mode: AiCommand['mode']) {
    if (!selection) return
    setCommand({ id: crypto.randomUUID(), mode, selection })
    setPanel('ai')
  }
  function jumpToCitation(value: Citation) {
    if (value.paperId !== paperId || !document || value.pageNumber < 1 || value.pageNumber > document.numPages) { setError('引用不属于当前论文或页码无效。'); return }
    setCitation(value); setCitationStatus('正在跳转至引用页...'); setPage(value.pageNumber)
  }
  async function saveAiNote(anchor: HighlightAnchor, content: string) {
    const id = crypto.randomUUID()
    const annotation: Annotation = { ...anchor, id, paperId, userId: user?.id ?? LOCAL_USER_ID, workspaceId: annotationWorkspaceId, createdAt: new Date().toISOString() }
    const note: Note = { id: crypto.randomUUID(), paperId, annotationId: id, authorId: user?.id ?? LOCAL_USER_ID, workspaceId: annotationWorkspaceId, content, updatedAt: new Date().toISOString() }
    await libraryStore.createAnnotationWithNote(annotation, note)
    setAnnotations(await libraryStore.listAnnotations(paperId, workspaceId))
  }

  function capture() {
    if (!pageRef.current || rendering) return
    const browserSelection = window.getSelection()
    if (!browserSelection || browserSelection.isCollapsed || !browserSelection.toString().trim()) return
    const captured = captureSelection(pageRef.current, page)
    setSelection(captured)
    setSelectionHint(captured ? '' : '无法定位这段选区。请选择单页内的文字；扫描件、跨页选区和复杂版式可能无法识别。')
  }
  async function saveSelection() {
    if (!selection) return
    setBusy(true); setError(''); setMessage('')
    const annotation: Annotation = { ...selection, paperId, userId: user?.id ?? LOCAL_USER_ID, workspaceId: annotationWorkspaceId, createdAt: new Date().toISOString() }
    try { await libraryStore.createAnnotation(annotation); setAnnotations(await libraryStore.listAnnotations(paperId, workspaceId)); setSelection(null); window.getSelection()?.removeAllRanges(); setMessage('高亮已保存。') }
    catch { setError('高亮保存失败，请检查存储服务后重试。') }
    finally { setBusy(false) }
  }
  async function openNote(annotation: Annotation) {
    const request = ++noteRequest.current
    setPanel('annotations'); setActiveId(annotation.id); setPage(annotation.page); setNote(null); setNoteText(''); setNoteReady(false); setError(''); setMessage('')
    try { const saved = await libraryStore.getNote(annotation.id); if (request === noteRequest.current) { setNote(saved ?? null); setNoteText(saved?.content ?? ''); setNoteReady(true) } }
    catch { if (request === noteRequest.current) setError('无法读取笔记，请检查存储服务。') }
  }
  async function saveNote() {
    if (!activeId || !noteReady) return
    setBusy(true); setError(''); setMessage('')
    const next: Note = { id: note?.id ?? crypto.randomUUID(), paperId, annotationId: activeId, authorId: user?.id ?? LOCAL_USER_ID, workspaceId: active?.workspaceId ?? annotationWorkspaceId, content: noteText, updatedAt: new Date().toISOString() }
    try { await libraryStore.saveNote(next); setNote(next); setMessage('笔记已保存。') }
    catch { setError('笔记保存失败，请检查存储服务后重试。') }
    finally { setBusy(false) }
  }
  async function deleteAnnotation(id: string) {
    setBusy(true); setError(''); setMessage('')
    try { await libraryStore.deleteAnnotation(id); setAnnotations(current => current.filter(annotation => annotation.id !== id)); if (activeId === id) { noteRequest.current++; setActiveId(null); setNote(null); setNoteText('') }; setMessage('高亮及关联笔记已删除。') }
    catch { setError('删除高亮失败，请重试。') }
    finally { setBusy(false) }
  }

  const active = annotations.find(annotation => annotation.id === activeId)
  const canManageAnnotation = (annotation: Annotation) => storageMode === 'local' || annotation.canManage === true
  return <div className="pdf-page-wrap reader-page"><div className="pdf-heading"><div><Link to={workspaceId ? `/team/${workspaceId}` : `/library/${paperId}`} className="back-link"><ArrowLeft size={15} /> {workspaceId ? '返回团队空间' : '返回文献详情'}</Link><div className="pdf-heading__title"><h1>{item?.paper.title ?? '论文阅读'}</h1><Badge tone="blue">{workspaceId ? '团队阅读' : storageMode === 'local' ? '本地阅读' : '远程阅读'}</Badge></div><p>{workspaceId ? `高亮与笔记保存在团队空间${workspaceName ? `「${workspaceName}」` : ''}，仅在成员间可见。` : storageMode === 'local' ? '阅读页码、高亮及笔记保存在当前浏览器。' : '阅读页码、高亮及笔记保存在远程服务端。'}</p></div></div>
    {storageMode === 'remote' && item && <div className="reader-scope"><label>批注可见范围<select className="input" aria-label="批注可见范围" value={workspaceId ?? ''} onChange={event => { window.location.href = `/library/${paperId}/read${event.target.value ? `?workspace=${event.target.value}` : ''}` }}><option value="">个人私有 · 仅自己可见</option>{item.contexts?.map(context => <option key={context.workspaceId} value={context.workspaceId}>团队公开{context.workspaceId === workspaceId && workspaceName ? ` · ${workspaceName}` : ` · ${context.workspaceId.slice(0, 8)}`}</option>)}</select></label><Button disabled={loading || busy} onClick={() => setReloadKey(value => value + 1)}>刷新协作内容</Button><Link className="text-link" to={workspaceId ? `/knowledge?workspace=${workspaceId}` : '/knowledge'}>打开知识库</Link></div>}
    <div className="pdf-notice">{storageMode === 'local' ? 'PDF 文件保存在当前浏览器' : 'PDF 文件保存在服务端，通过账号权限访问'}；启用模型后，主动发起 AI 请求会发送相关文字片段。扫描件和复杂排版可能无法准确选取文字。</div>
    {error && <div className="operation-message operation-message--error" role="alert">{error}</div>}{message && <div className="operation-message operation-message--success" role="status">{message}</div>}{citationStatus && <div className="operation-message" role="status">{citationStatus}</div>}
    <div className="pdf-workspace"><div className="pdf-viewer-card"><div className="pdf-toolbar"><div className="pdf-file-label"><span><BookOpen size={17} /></span><div><strong>{item?.paper.fileName ?? 'PDF DOCUMENT'}</strong><small>PDF DOCUMENT</small></div></div><div className="pdf-toolbar-controls"><Button variant="icon" size="small" disabled={!document || page <= 1 || rendering} onClick={() => setPage(value => value - 1)} aria-label="上一页"><ChevronLeft size={17} /></Button><span className="page-counter">{document ? page : '—'} <span>/</span> {document?.numPages ?? '—'}</span><Button variant="icon" size="small" disabled={!document || page >= document.numPages || rendering} onClick={() => setPage(value => value + 1)} aria-label="下一页"><ChevronRight size={17} /></Button><span className="toolbar-divider" /><Button variant="icon" size="small" disabled={!document || scale <= 0.6 || rendering} onClick={() => setScale(value => Math.max(0.6, Math.round((value - 0.2) * 10) / 10))} aria-label="缩小"><Minus size={16} /></Button><span className="zoom-label">{Math.round(scale * 100)}%</span><Button variant="icon" size="small" disabled={!document || scale >= 2 || rendering} onClick={() => setScale(value => Math.min(2, Math.round((value + 0.2) * 10) / 10))} aria-label="放大"><Plus size={16} /></Button></div></div>
      <div className="pdf-canvas-area">{loading && <LoadingState label="正在打开 PDF..." />}{document && <div className="pdf-page" ref={pageRef} style={{ width: dimensions.width, height: dimensions.height }} onMouseUp={capture} onKeyUp={capture} onTouchEnd={capture} data-testid="pdf-page"><canvas ref={canvasRef} /><div className="textLayer" ref={textLayerRef} /><div className="citation-highlight-layer" aria-hidden="true">{citationRects.map((rect, index) => <span key={index} className="citation-highlight" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} />)}</div>{selection && <div className="selection-menu" role="toolbar" aria-label="选段 AI 操作" style={{ left: `${Math.min(55, Math.max(0, selection.rects[0].x * 100))}%`, top: `${Math.min(95, (selection.rects[0].y + selection.rects[0].height) * 100)}%` }} onMouseDown={event => event.preventDefault()}><button onClick={() => startAi('explain')}>解释</button><button onClick={() => startAi('translate')}>翻译</button><button onClick={() => startAi('selection-question')}>针对选段提问</button></div>}<div className="reader-highlight-layer">{annotations.filter(annotation => annotation.page === page).flatMap(annotation => annotation.rects.map((rect, index) => <button key={`${annotation.id}-${index}`} data-annotation-id={annotation.id} className={`pdf-highlight reader-highlight${activeId === annotation.id ? ' reader-highlight--active' : ''}`} aria-label={`打开高亮笔记：${annotation.text}`} title="打开高亮笔记" onClick={() => void openNote(annotation)} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} />))}</div></div>}{rendering && <div className="pdf-rendering"><LoadingState label="正在渲染页面..." /></div>}</div></div>
      <aside className="pdf-inspector"><div className="reader-tabs" role="tablist" aria-label="阅读面板"><button role="tab" disabled={loading} aria-selected={panel === 'annotations'} onClick={() => setPanel('annotations')}>高亮与笔记</button>{storageMode === 'remote' && <button role="tab" disabled={loading} aria-selected={panel === 'discussion'} onClick={() => setPanel('discussion')}>讨论</button>}<button role="tab" disabled={loading} aria-selected={panel === 'ai'} onClick={() => setPanel('ai')}>AI 助手</button></div>{panel === 'ai' ? <AiPanel paperId={paperId} pdf={document} command={command} onCommandHandled={() => setCommand(null)} onCitation={jumpToCitation} onSaveNote={saveAiNote} /> : panel === 'discussion' ? <DiscussionPanel key={`${paperId}-${workspaceId}`} paperId={paperId} workspaceId={annotationWorkspaceId} annotations={annotations} focusAnnotationId={discussionAnnotationId} focusCommentId={sourceCommentId} onCreateKnowledge={createKnowledge} onOpenAnnotation={annotation => { setPanel('annotations'); void openNote(annotation) }} /> : <><div className="inspector-heading"><span className="inspector-icon"><Highlighter size={18} /></span><div><h2>高亮与笔记</h2><p>记录阅读中的思考</p></div></div><div className="inspector-body"><div className="inspector-section"><span className="inspector-label">当前选区</span>{selection ? <><div className="selection-box"><span>第 {selection.page} 页 · {selection.rects.length} 个位置</span><p>{selection.text}</p></div><Button variant="primary" className="save-highlight" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => void saveSelection()}><Highlighter size={15} />保存高亮</Button></> : <div className="selection-empty">在 PDF 中选中一段文字，保存为高亮。</div>}{selectionHint && <p className="storage-error" role="status">{selectionHint}</p>}{!hasText && !rendering && <p className="storage-error">此页没有可选择的文本层，扫描件暂不支持 OCR。</p>}</div>
      <div className="inspector-section"><div className="inspector-label-row"><span className="inspector-label">已保存高亮</span><span>{annotations.length}</span></div>{annotations.length === 0 ? <div className="saved-empty">暂无高亮记录</div> : <div className="saved-list">{annotations.map(annotation => <div className="saved-item" key={annotation.id}><button className="saved-item__text" onClick={() => void openNote(annotation)}><span>第 {annotation.page} 页 · {annotation.workspaceId ? '团队公开' : '个人私有'}</span><p>{annotation.text}</p><small className="annotation-meta">{annotation.author?.name ?? '我'} · {new Date(annotation.createdAt).toLocaleString('zh-CN')}</small></button>{canManageAnnotation(annotation) && <button className="delete-anchor" aria-label="删除高亮" disabled={busy} onClick={() => void deleteAnnotation(annotation.id)}><Trash2 size={15} /></button>}</div>)}</div>}</div>
      {active && <div className="inspector-section note-editor"><span className="inspector-label">{active.workspaceId ? '团队公开批注' : '个人私有笔记'} · 第 {active.page} 页</span><p>{active.text}</p><small className="annotation-meta">原文引用不可改写；下方为成员的批注内容。</small><textarea className="input" aria-label="高亮笔记" maxLength={10000} value={noteText} disabled={!noteReady || !canManageAnnotation(active)} onChange={event => setNoteText(event.target.value)} placeholder={noteReady ? '写下你的思考...' : '笔记未就绪，请稍候或重新打开高亮。'} />{note && <p className="annotation-meta">更新于 {new Date(note.updatedAt).toLocaleString('zh-CN')}</p>}{canManageAnnotation(active) ? <Button variant="primary" disabled={busy || !noteReady} onClick={() => void saveNote()}>保存笔记</Button> : <p className="annotation-meta">只读：只有作者、论文所有者或团队所有者可编辑公开批注。</p>}{storageMode === 'remote' && <div className="annotation-actions"><Button size="small" onClick={() => { setDiscussionAnnotationId(active.id); setPanel('discussion') }}>查看 / 回复批注</Button><Button size="small" onClick={() => createKnowledge({ workspaceId: annotationWorkspaceId, paperId, annotationId: active.id, commentId: null }, 'question')}>创建研究问题</Button><Button size="small" onClick={() => createKnowledge({ workspaceId: annotationWorkspaceId, paperId, annotationId: active.id, commentId: null }, 'note')}>存为知识笔记</Button></div>}</div>}
      <div className="inspector-tip"><strong>选区提示</strong><p>请在单页文本层中选取文字。扫描件、跨页选区及复杂排版可能无法定位；现有高亮可点击打开笔记。</p></div></div></>}</aside></div>{knowledgeDraft && <KnowledgeEditor source={knowledgeDraft.source} kind={knowledgeDraft.kind} onClose={() => setKnowledgeDraft(null)} onSaved={() => { setKnowledgeDraft(null); setMessage('知识卡片已保存，可在知识库查看。') }} />}</div>
}
