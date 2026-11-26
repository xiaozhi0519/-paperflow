import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useOutletContext } from 'react-router-dom'
import { ArrowLeft, BookOpen, ChevronLeft, ChevronRight, FileUp, Highlighter, Minus, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { getDocument, TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import '../features/pdf/pdfConfig'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { LoadingState } from '../components/ui/States'
import { captureSelection, loadAnchors } from '../features/pdf/anchors'
import type { LayoutContext } from '../layouts/AppLayout'
import type { HighlightAnchor } from '../types'

export function PdfLabPage() {
  const { openUpload } = useOutletContext<LayoutContext>()
  const { state } = useLocation()
  const navigate = useNavigate()
  const file = (state as { file?: File } | null)?.file
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(1)
  const [renderVersion, setRenderVersion] = useState(0)
  const [anchors, setAnchors] = useState<HighlightAnchor[]>([])
  const [selection, setSelection] = useState<HighlightAnchor | null>(null)
  const [storageKey, setStorageKey] = useState('')
  const [loading, setLoading] = useState(true)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState('')
  const [storageError, setStorageError] = useState('')
  const [dimensions, setDimensions] = useState({ width: 612, height: 792 })
  const pageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let task: ReturnType<typeof getDocument> | undefined
    setLoading(true)
    setRendering(false)
    setDocument(null)
    setPage(1)
    setSelection(null)
    setAnchors([])
    setStorageKey('')
    setError('')
    setStorageError('')

    async function load() {
      try {
        const response = file ? null : await fetch(`${import.meta.env.BASE_URL}paperflow-sample.pdf`)
        if (response && !response.ok) throw new Error('示例 PDF 加载失败')
        const bytes = file ? await file.arrayBuffer() : await response!.arrayBuffer()
        const digest = await crypto.subtle.digest('SHA-256', bytes)
        const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
        if (cancelled) return
        const key = `paperflow:pdf-anchors:v1:${hash}`
        task = getDocument({ data: new Uint8Array(bytes), enableXfa: false })
        const pdf = await task.promise
        if (cancelled) return
        setStorageKey(key)
        setAnchors(loadAnchors(key))
        setDocument(pdf)
      } catch (cause) {
        if (!cancelled) setError(`无法打开 PDF：${cause instanceof Error ? cause.message : '文件可能已损坏或不受支持'}`)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true; if (task) void task.destroy() }
  }, [file])

  useEffect(() => {
    if (!document || !canvasRef.current || !textLayerRef.current) return
    let cancelled = false
    let renderTask: RenderTask | undefined
    let textLayer: TextLayer | undefined
    const canvas = canvasRef.current
    const layerElement = textLayerRef.current
    setRendering(true)
    setError('')
    setSelection(null)
    layerElement.replaceChildren()

    async function renderPage() {
      try {
        const pdfPage = await document!.getPage(page)
        if (cancelled) return
        const viewport = pdfPage.getViewport({ scale })
        const outputScale = window.devicePixelRatio || 1
        setDimensions({ width: viewport.width, height: viewport.height })
        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        layerElement.style.setProperty('--total-scale-factor', String(viewport.scale * viewport.userUnit))
        layerElement.style.setProperty('--scale-round-x', '1px')
        layerElement.style.setProperty('--scale-round-y', '1px')
        const context = canvas.getContext('2d')
        if (!context) throw new Error('浏览器无法创建画布')
        renderTask = pdfPage.render({ canvas, canvasContext: context, viewport, transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0] })
        await renderTask.promise
        if (cancelled) return
        textLayer = new TextLayer({ textContentSource: pdfPage.streamTextContent(), container: layerElement, viewport })
        await textLayer.render()
      } catch (cause) {
        if (!cancelled) setError(`页面渲染失败：${cause instanceof Error ? cause.message : '未知错误'}`)
      } finally {
        if (!cancelled) setRendering(false)
      }
    }
    void renderPage()
    return () => { cancelled = true; renderTask?.cancel(); textLayer?.cancel(); layerElement.replaceChildren() }
  }, [document, page, scale, renderVersion])

  function capture() {
    if (!pageRef.current || rendering) return
    setSelection(captureSelection(pageRef.current, page))
  }

  function persist(next: HighlightAnchor[]) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
      setAnchors(next)
      setStorageError('')
    } catch {
      setStorageError('无法保存到浏览器本地存储，请检查存储空间或浏览器设置。')
    }
  }

  function saveSelection() {
    if (!selection || !storageKey) return
    persist([...anchors, selection])
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }

  const currentAnchors = anchors.filter(anchor => anchor.page === page)
  return <div className="pdf-page-wrap">
    <div className="pdf-heading"><div><Link to="/" className="back-link"><ArrowLeft size={15} /> 返回工作台</Link><div className="pdf-heading__title"><h1>PDF 阅读验证</h1><Badge tone="blue">技术验证</Badge></div><p>选择正文，保存高亮，切换页码或缩放后检查锚点。</p></div><div className="pdf-heading__actions"><Button onClick={openUpload}><FileUp size={16} />打开本地 PDF</Button>{file && <Button onClick={() => navigate('/pdf-lab', { replace: true, state: null })}>使用示例</Button>}</div></div>
    <div className="pdf-notice">{file ? `本地文件：${file.name}` : '原创双页示例文档'} · PDF 不会上传；高亮文字和位置保存在当前浏览器的本地存储中。</div>
    <div className="pdf-workspace">
      <div className="pdf-viewer-card">
        <div className="pdf-toolbar"><div className="pdf-file-label"><span><BookOpen size={17} /></span><div><strong>{file?.name ?? 'PaperFlow 阅读示例.pdf'}</strong><small>PDF DOCUMENT</small></div></div><div className="pdf-toolbar-controls"><Button variant="icon" size="small" disabled={!document || page <= 1 || rendering} onClick={() => setPage(page - 1)} aria-label="上一页"><ChevronLeft size={17} /></Button><span className="page-counter">{document ? page : '—'} <span>/</span> {document?.numPages ?? '—'}</span><Button variant="icon" size="small" disabled={!document || page >= document.numPages || rendering} onClick={() => setPage(page + 1)} aria-label="下一页"><ChevronRight size={17} /></Button><span className="toolbar-divider" /><Button variant="icon" size="small" disabled={!document || scale <= 0.6 || rendering} onClick={() => setScale(value => Math.max(0.6, Math.round((value - 0.2) * 10) / 10))} aria-label="缩小"><Minus size={16} /></Button><span className="zoom-label">{Math.round(scale * 100)}%</span><Button variant="icon" size="small" disabled={!document || scale >= 2 || rendering} onClick={() => setScale(value => Math.min(2, Math.round((value + 0.2) * 10) / 10))} aria-label="放大"><Plus size={16} /></Button><span className="toolbar-divider" /><Button variant="icon" size="small" disabled={!document || rendering} onClick={() => setRenderVersion(value => value + 1)} aria-label="重新渲染页面" title="重新渲染页面"><RotateCcw size={16} /></Button></div></div>
        <div className="pdf-canvas-area">
          {loading && <LoadingState label="正在打开 PDF..." />}
          {error && <div className="pdf-error" role="alert">{error}</div>}
          {document && <div className="pdf-page" ref={pageRef} style={{ width: dimensions.width, height: dimensions.height }} onMouseUp={capture} onKeyUp={capture} data-testid="pdf-page"><canvas ref={canvasRef} /><div className="highlight-layer" aria-hidden="true">{currentAnchors.flatMap(anchor => anchor.rects.map((rect, index) => <span key={`${anchor.id}-${index}`} className="pdf-highlight" data-anchor-id={anchor.id} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} />))}</div><div className="textLayer" ref={textLayerRef} /></div>}
          {rendering && <div className="pdf-rendering"><LoadingState label="正在渲染页面..." /></div>}
        </div>
      </div>
      <aside className="pdf-inspector"><div className="inspector-heading"><span className="inspector-icon"><Highlighter size={18} /></span><div><h2>选区与高亮</h2><p>PDF.js 技术验证</p></div></div><div className="inspector-body"><div className="inspector-section"><span className="inspector-label">当前选区</span>{selection ? <><div className="selection-box"><span>第 {selection.page} 页 · {selection.rects.length} 个位置</span><p>{selection.text}</p></div><Button variant="primary" className="save-highlight" onMouseDown={event => event.preventDefault()} onClick={saveSelection}><Highlighter size={15} />保存高亮</Button></> : <div className="selection-empty">在左侧 PDF 中选中一段文字，查看文字、页码和位置。</div>}{storageError && <p className="storage-error" role="alert">{storageError}</p>}</div><div className="inspector-section"><div className="inspector-label-row"><span className="inspector-label">已保存高亮</span><span>{anchors.length}</span></div>{anchors.length === 0 ? <div className="saved-empty">暂无高亮记录</div> : <div className="saved-list">{anchors.map(anchor => <div className="saved-item" key={anchor.id}><button className="saved-item__text" onClick={() => setPage(anchor.page)}><span>第 {anchor.page} 页 · {anchor.rects.length} 个位置</span><p>{anchor.text}</p></button><button className="delete-anchor" aria-label="删除高亮" onClick={() => persist(anchors.filter(item => item.id !== anchor.id))}><Trash2 size={15} /></button></div>)}</div>}</div><div className="inspector-tip"><strong>验证提示</strong><p>保存后尝试缩放、翻页、重新渲染或刷新页面。高亮基于 PDF 页面比例坐标，仅适用于同一文件。</p></div></div></aside>
    </div>
  </div>
}
