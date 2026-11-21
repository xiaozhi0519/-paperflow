import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, FilePlus2, Search, Trash2 } from 'lucide-react'
import { Link, useLocation, useNavigate, useOutletContext } from 'react-router-dom'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input } from '../components/ui/Input'
import { EmptyState, LoadingState } from '../components/ui/States'
import type { LayoutContext } from '../layouts/AppLayout'
import { useAuth } from '../services/auth'
import { importPaper } from '../services/importPaper'
import { libraryStore, storageMode } from '../services/libraryStore'
import type { LibraryItem } from '../types/library'

const statusLabels = { unread: '待读', reading: '阅读中', finished: '已读' }

export function LibraryPage() {
  const { openUpload } = useOutletContext<LayoutContext>()
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const handledFile = useRef<File | null>(null)
  const [items, setItems] = useState<LibraryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [deleting, setDeleting] = useState<LibraryItem | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try { setItems(await libraryStore.listPapers()) } catch { setError(storageMode === 'local' ? '无法读取本地文献库，请检查浏览器存储权限。' : '无法读取远程文献库，请检查服务和账号。') } finally { setLoading(false) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const file = (location.state as { file?: File } | null)?.file
    if (!file || handledFile.current === file) return
    handledFile.current = file
    navigate(location.pathname, { replace: true, state: null })
    setUploading(true); setError(''); setMessage('')
    void importPaper(file, libraryStore).then(async paper => { await refresh(); setMessage(`“${paper.title}”已保存到${storageMode === 'local' ? '本地' : '远程'}文献库。`) }).catch(cause => setError(`上传失败：${cause instanceof Error ? cause.message : '存储失败，请检查空间和权限。'}`)).finally(() => setUploading(false))
  }, [location, navigate, refresh])

  async function confirmDelete() {
    if (!deleting) return
    setBusy(true); setError(''); setMessage('')
    try { await libraryStore.deletePaper(deleting.paper.id); setMessage(`“${deleting.paper.title}”及其记录已删除。`); setDeleting(null); await refresh() }
    catch { setError('删除失败，请检查存储服务后重试。'); setDeleting(null) }
    finally { setBusy(false) }
  }

  const filtered = items.filter(({ paper }) => `${paper.title} ${paper.authors}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <div className="page-wrap library-page">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> YOUR LIBRARY</div><h1>个人文献库</h1><p>整理每一篇值得反复阅读的论文。</p></div><div className="team-heading-actions">{storageMode === 'remote' && <Link className="text-link workspace-open" to="/library/import">导入本地文献</Link>}<Button variant="primary" onClick={openUpload} disabled={uploading}><FilePlus2 size={16} />上传论文</Button></div></div>
    <div className="local-notice">{storageMode === 'local' ? '本地开发模式 · 文件与记录保存在当前浏览器的 IndexedDB，不会上传服务器，也不会跨设备同步。切换到远程模式并登录后，可在此页将本地文献安全导入远程库。' : '远程持久化模式 · 文件与记录保存在已配置的服务端，与本地文献库互不关联，不会自动同步。'}</div>
    {uploading && <div className="operation-message" role="status"><LoadingState label="正在校验并保存 PDF..." /></div>}
    {message && <div className="operation-message operation-message--success" role="status">{message}</div>}
    {error && <div className="operation-message operation-message--error" role="alert">{error}</div>}
    <div className="library-toolbar"><div><span className="section-kicker">ALL PAPERS</span><h2>全部文献 <span>{items.length.toString().padStart(2, '0')}</span></h2></div><label className="library-search"><Search size={16} /><Input placeholder="搜索标题或作者" aria-label="搜索标题或作者" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
    <Card className="library-list">
      {loading ? <LoadingState label="正在读取文献库..." /> : !items.length ? <div className="library-empty"><EmptyState icon={<BookOpen size={20} />} title="还没有文献" description="上传一篇 PDF，开始你的阅读旅程。" /><Button variant="primary" onClick={openUpload} disabled={uploading}><FilePlus2 size={15} />上传第一篇论文</Button></div> : !filtered.length ? <EmptyState title="没有找到匹配文献" description="试试其他标题或作者。" /> : filtered.map(({ paper, progress }) => {
        const shared = Boolean(paper.workspaceIds?.length)
        const teamOnly = storageMode === 'remote' && shared && paper.ownerId !== user?.id
        const readPath = teamOnly ? `/library/${paper.id}/read?workspace=${paper.workspaceIds![0]}` : `/library/${paper.id}/read`
        return <div className="library-row" key={paper.id}>
          <div className="library-file-icon"><BookOpen size={19} /></div><div className="library-row__body"><Link className="library-title" to={`/library/${paper.id}`}>{paper.title}</Link><p>{paper.authors || '作者未填写'} <span>·</span> {paper.year || '年份未填写'} <span>·</span> {paper.pageCount} 页</p><div className="library-row__meta"><Badge tone={progress.status === 'finished' ? 'green' : 'blue'}>{statusLabels[progress.status]}</Badge>{shared && <Badge tone="neutral">团队共享{paper.workspaceIds!.length > 1 ? ` · ${paper.workspaceIds!.length} 个空间` : ''}</Badge>}<span>{progress.status === 'unread' ? '尚未开始阅读' : `上次阅读第 ${progress.lastPage} / ${paper.pageCount} 页`}</span></div></div><div className="library-row__actions"><Link className="text-link" to={readPath}>{progress.status === 'unread' ? '开始阅读' : '继续阅读'}</Link>{(storageMode === 'local' || paper.ownerId === user?.id) && <Button variant="icon" onClick={() => setDeleting({ paper, progress })} aria-label={`删除 ${paper.title}`}><Trash2 size={16} /></Button>}</div>
        </div>
      })}
    </Card>
    {deleting && <div className="dialog-backdrop"><div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title"><div className="dialog-icon"><Trash2 size={19} /></div><h2 id="delete-title">删除这篇文献？</h2><p>“{deleting.paper.title}”的 PDF、阅读进度、高亮和关联笔记将从{storageMode === 'local' ? '当前浏览器' : '远程服务端'}删除{deleting.paper.workspaceIds?.length ? `，并从 ${deleting.paper.workspaceIds.length} 个团队空间一并移除` : ''}，无法撤销。</p><div className="dialog-actions"><Button onClick={() => setDeleting(null)} disabled={busy}>取消</Button><Button variant="primary" className="button-danger" onClick={() => void confirmDelete()} disabled={busy}>{busy ? '删除中...' : '确认删除'}</Button></div></div></div>}
  </div>
}
