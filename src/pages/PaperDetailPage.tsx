import { useEffect, useState, type FormEvent } from 'react'
import { ArrowLeft, BookOpen, Pencil } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input } from '../components/ui/Input'
import { LoadingState } from '../components/ui/States'
import { useAuth } from '../services/auth'
import { libraryStore, storageMode } from '../services/libraryStore'
import type { LibraryItem, PaperMetadata, ReadingStatus } from '../types/library'

export function PaperDetailPage() {
  const { paperId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const workspaceId = storageMode === 'remote' ? searchParams.get('workspace') : null
  const { user } = useAuth()
  const [item, setItem] = useState<LibraryItem | null>(null)
  const [metadata, setMetadata] = useState<PaperMetadata | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => { let active = true; setLoading(true); setError(''); void libraryStore.getPaper(paperId).then(result => { if (active) { setItem(result ?? null); setMetadata(result?.paper ?? null) } }).catch(() => { if (active) setError('无法读取文献，请检查存储服务。') }).finally(() => { if (active) setLoading(false) }); return () => { active = false } }, [paperId])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!metadata || !metadata.title.trim()) { setError('请输入论文标题。'); return }
    if (metadata.year && !/^\d{4}$/.test(metadata.year)) { setError('年份请填写四位数字。'); return }
    setBusy(true); setError(''); setMessage('')
    try { await libraryStore.updatePaper(paperId, { title: metadata.title.trim(), authors: metadata.authors, abstract: metadata.abstract, year: metadata.year, venue: metadata.venue, doi: metadata.doi }); setItem((await libraryStore.getPaper(paperId)) ?? null); setEditing(false); setMessage('文献信息已保存。') }
    catch { setError('保存失败，请检查存储服务后重试。') }
    finally { setBusy(false) }
  }
  async function updateStatus(status: ReadingStatus) {
    setBusy(true); setError(''); setMessage('')
    try { await libraryStore.setStatus(paperId, status); setItem((await libraryStore.getPaper(paperId)) ?? null); setMessage('阅读状态已保存。') }
    catch { setError('状态保存失败，请重试。') }
    finally { setBusy(false) }
  }
  if (loading) return <LoadingState label="正在读取文献详情..." />
  if (!item || !metadata) return <div className="page-wrap"><Link to="/library" className="back-link"><ArrowLeft size={15} />返回文献库</Link><div className="operation-message operation-message--error" role="alert">{error || '文献不存在或无权访问。'}</div></div>
  const { paper, progress } = item
  const isOwner = storageMode === 'local' || paper.ownerId === user?.id
  const readWorkspace = workspaceId ?? (isOwner ? null : paper.workspaceIds?.[0] ?? null)
  const readPath = `/library/${paper.id}/read${readWorkspace ? `?workspace=${readWorkspace}` : ''}`
  const backPath = workspaceId ? `/team/${workspaceId}` : '/library'
  return <div className="page-wrap detail-page"><Link to={backPath} className="back-link"><ArrowLeft size={15} /> {workspaceId ? '返回团队空间' : '返回文献库'}</Link>
    <div className="detail-heading"><div><div className="eyebrow">PAPER DETAILS</div><h1>{paper.title}</h1><p>{paper.authors || '作者未填写'} · {paper.year || '年份未填写'}</p></div><Link className="button button--primary button--normal" to={readPath}><BookOpen size={16} />{progress.status === 'unread' ? '开始阅读' : '继续阅读'}</Link></div>
    <div className="local-notice">{storageMode === 'local' ? '此文献仅保存在当前浏览器。清理站点数据会删除本地文件及记录。' : workspaceId ? `团队共享阅读：高亮与讨论保存在团队空间${isOwner ? '' : '；只有论文所有者可以编辑文献信息'}。` : isOwner ? '此文献保存在远程服务端，不会自动同步至本地文献库。' : '此文献通过团队空间共享给你，个人阅读进度独立保存，不会自动同步至本地文献库。'}</div>
    {message && <div className="operation-message operation-message--success" role="status">{message}</div>}{error && <div className="operation-message operation-message--error" role="alert">{error}</div>}
    <div className="detail-grid"><Card className="detail-card"><div className="detail-card__heading"><div><span className="section-kicker">METADATA</span><h2>文献信息</h2></div>{!editing && isOwner && <Button size="small" onClick={() => { setMetadata(paper); setEditing(true); setMessage('') }}><Pencil size={14} />编辑信息</Button>}</div>
      {editing ? <form className="metadata-form" onSubmit={event => void save(event)}><label>标题 <Input aria-label="标题" required maxLength={300} value={metadata.title} onChange={event => setMetadata({ ...metadata, title: event.target.value })} /></label><label>作者 <Input aria-label="作者" maxLength={300} value={metadata.authors} onChange={event => setMetadata({ ...metadata, authors: event.target.value })} placeholder="多个作者可用逗号分隔" /></label><div className="form-grid"><label>发表年份 <Input aria-label="发表年份" maxLength={4} inputMode="numeric" value={metadata.year} onChange={event => setMetadata({ ...metadata, year: event.target.value })} /></label><label>会议 / 期刊 <Input aria-label="会议 / 期刊" maxLength={200} value={metadata.venue} onChange={event => setMetadata({ ...metadata, venue: event.target.value })} /></label></div><label>DOI <Input aria-label="DOI" maxLength={200} value={metadata.doi} onChange={event => setMetadata({ ...metadata, doi: event.target.value })} /></label><label>摘要 <textarea className="input metadata-textarea" aria-label="摘要" maxLength={10000} value={metadata.abstract} onChange={event => setMetadata({ ...metadata, abstract: event.target.value })} /></label><div className="form-actions"><Button type="button" onClick={() => { setEditing(false); setMetadata(paper); setError('') }} disabled={busy}>取消</Button><Button type="submit" variant="primary" disabled={busy}>{busy ? '保存中...' : '保存信息'}</Button></div></form> : <dl className="metadata-list"><div><dt>作者</dt><dd>{paper.authors || '未填写'}</dd></div><div><dt>发表年份</dt><dd>{paper.year || '未填写'}</dd></div><div><dt>会议 / 期刊</dt><dd>{paper.venue || '未填写'}</dd></div><div><dt>DOI</dt><dd>{paper.doi || '未填写'}</dd></div><div><dt>摘要</dt><dd className="abstract-text">{paper.abstract || '暂无摘要，可手动添加。'}</dd></div></dl>}
    </Card><Card className="detail-card reading-card"><span className="section-kicker">READING PROGRESS</span><h2>阅读进度</h2><div className="reading-page-number">{progress.status === 'unread' ? '尚未开始' : `第 ${progress.lastPage} / ${paper.pageCount} 页`}</div><div className="progress-track"><span style={{ width: `${progress.status === 'unread' ? 0 : progress.lastPage / paper.pageCount * 100}%` }} /></div><p>记录的是上次所在页，不代表已完整阅读。</p><label className="status-label">阅读状态<select className="input" aria-label="阅读状态" value={progress.status} disabled={busy} onChange={event => void updateStatus(event.target.value as ReadingStatus)}><option value="unread">待读</option><option value="reading">阅读中</option><option value="finished">已读</option></select></label><div className="file-info"><Badge tone="blue">PDF</Badge><span>{paper.fileName}</span><small>{(paper.fileSize / 1024 / 1024).toFixed(2)} MB · {paper.pageCount} 页</small></div></Card></div>
  </div>
}
