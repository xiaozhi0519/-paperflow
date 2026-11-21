import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { importPaper } from '../services/importPaper'
import { ArrowLeft, BookOpen, LogOut, Pencil, Plus, Trash2, UserPlus, UsersRound } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input } from '../components/ui/Input'
import { EmptyState, LoadingState } from '../components/ui/States'
import { useAuth } from '../services/auth'
import { libraryStore, setStorageMode, storageMode } from '../services/libraryStore'
import { workspaceService, type WorkspaceDetail, type WorkspaceMember, type WorkspacePaperItem } from '../services/workspaces'
import type { LibraryItem } from '../types/library'

type Dialog = { kind: 'rename' } | { kind: 'invite' } | { kind: 'remove'; member: WorkspaceMember } | { kind: 'leave' } | { kind: 'addPaper' } | { kind: 'removePaper'; item: WorkspacePaperItem } | null
const statusLabels = { unread: '待读', reading: '阅读中', finished: '已读' }

export function TeamDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null)
  const [papers, setPapers] = useState<WorkspacePaperItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [inviteCode, setInviteCode] = useState<{ code: string; expiresAt: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  async function upload(file?: File) {
    if (!file) return
    setBusy(true); setError('')
    try { await importPaper(file, libraryStore, id); setMessage('论文已上传到团队。'); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '上传失败。') }
    finally { setBusy(false) }
  }
  async function createInvite() {
    setBusy(true); setError('')
    try { setInviteCode(await workspaceService.createInvite(id)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '生成失败。') }
    finally { setBusy(false) }
  }
  async function revokeInvite() {
    setBusy(true); setError('')
    try { await workspaceService.revokeInvite(id); setInviteCode(null); setMessage('邀请码已撤销。') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '撤销失败。') }
    finally { setBusy(false) }
  }
  const [email, setEmail] = useState('')
  const [candidates, setCandidates] = useState<LibraryItem[]>([])
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [value, shared] = await Promise.all([workspaceService.detail(id), workspaceService.listPapers(id)])
      setWorkspace(value); setPapers(shared); setName(value.name); setDescription(value.description); setError('')
    } catch (cause) { setWorkspace(null); setPapers([]); setError(cause instanceof Error ? cause.message : '无法读取团队空间。') }
    finally { setLoading(false) }
  }, [id])
  useEffect(() => { if (storageMode === 'remote') void refresh() }, [refresh])

  function closeDialog() { setDialog(null); setEmail(''); setBusy(false) }

  async function rename(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError(''); setMessage('')
    try { await workspaceService.rename(id, name.trim(), description.trim()); setMessage('空间名称已更新。'); closeDialog(); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '重命名失败。'); setBusy(false) }
  }
  async function invite(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError(''); setMessage('')
    try { await workspaceService.invite(id, email.trim()); setMessage(`已邀请 ${email.trim()} 加入空间。`); closeDialog(); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '邀请成员失败。'); setBusy(false) }
  }
  async function removeMember(member: WorkspaceMember) {
    setBusy(true); setError(''); setMessage('')
    try { await workspaceService.removeMember(id, member.id); setMessage(`已移除成员 ${member.name}。`); closeDialog(); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '移除成员失败。'); setBusy(false) }
  }
  async function leave() {
    setBusy(true); setError(''); setMessage('')
    try { await workspaceService.leave(id); navigate('/team') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '退出空间失败。'); setBusy(false) }
  }
  async function openAddPapers() {
    setDialog({ kind: 'addPaper' }); setCandidatesLoading(true); setError(''); setMessage('')
    try {
      const library = await libraryStore.listPapers()
      setCandidates(library.filter(item => item.paper.ownerId === user?.id && !item.paper.workspaceIds?.includes(id)))
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法读取个人文献库。') }
    finally { setCandidatesLoading(false) }
  }
  async function addPaper(paperId: string) {
    setBusy(true); setError(''); setMessage('')
    try { await workspaceService.addPaper(id, paperId); setMessage('文献已加入团队空间。'); closeDialog(); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '加入团队空间失败。'); setBusy(false) }
  }
  async function removePaper(item: WorkspacePaperItem) {
    setBusy(true); setError(''); setMessage('')
    try { await workspaceService.removePaper(id, item.paper.id); setMessage(`“${item.paper.title}”已从团队空间移除，个人文献未受影响。`); closeDialog(); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '移除文献失败。'); setBusy(false) }
  }

  if (storageMode === 'local') return <div className="page-wrap"><div className="operation-message operation-message--error" role="alert">团队空间需要远程模式，请在顶部切换存储模式后重试。</div><Link className="back-link" to="/team"><ArrowLeft size={14} />返回团队空间</Link><Card className="team-gate"><Button variant="primary" onClick={() => setStorageMode('remote', '/team')}>切换到远程模式</Button></Card></div>
  if (loading) return <div className="page-wrap"><LoadingState label="正在读取团队空间..." /></div>
  if (!workspace) return <div className="page-wrap"><Link className="back-link" to="/team"><ArrowLeft size={14} />返回团队空间</Link><div className="operation-message operation-message--error" role="alert">{error || '空间不存在或无权访问。'}</div><Button onClick={() => void refresh()}>重试</Button></div>

  const owner = workspace.role === 'owner'
  return <div className="page-wrap">
    <Link className="back-link" to="/team"><ArrowLeft size={14} />返回团队空间</Link>
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> TEAM WORKSPACE</div><h1>{workspace.name}</h1><p><Badge tone={owner ? 'blue' : 'neutral'}>{owner ? '所有者' : '成员'}</Badge> <span className="heading-sep">·</span> {workspace.memberCount} 位成员 <span className="heading-sep">·</span> 创建于 {new Date(workspace.createdAt).toLocaleDateString('zh-CN')}</p></div>
      <div className="team-heading-actions">{owner && <><Button onClick={() => setDialog({ kind: 'rename' })}><Pencil size={15} />编辑团队</Button><Button variant="primary" onClick={() => setDialog({ kind: 'invite' })}><UserPlus size={16} />邀请成员</Button></>}{!owner && <Button onClick={() => setDialog({ kind: 'leave' })}><LogOut size={15} />退出空间</Button>}</div></div>
    {error && <div className="operation-message operation-message--error" role="alert">{error}</div>}
    {message && <div className="operation-message operation-message--success" role="status">{message}</div>}
    <p className="team-description">{workspace.description || '尚未填写团队简介。'}</p>
    <div className="team-stats" aria-label="团队真实数据">{Object.entries({ papers: '共享论文', annotations: '公开批注', comments: '讨论发言', knowledge: '知识卡片' }).map(([key, label]) => <Card key={key}><span>{label}</span><strong>{workspace.stats[key as keyof typeof workspace.stats]}</strong></Card>)}</div>
    <div className="team-heading-actions"><Link className="button button--primary button--normal" to={`/knowledge?workspace=${id}`}>团队知识库</Link><Button onClick={() => { void refresh(); window.dispatchEvent(new Event('paperflow:workspaces-changed')) }}>刷新概览</Button>{owner && <><Button disabled={busy} onClick={() => void createInvite()}>生成新邀请码</Button><Button disabled={busy} onClick={() => void revokeInvite()}>撤销邀请码</Button></>}</div>
    {inviteCode && <div className="local-notice invite-code"><strong>邀请码（请仅提供给受邀成员）</strong><input className="input" aria-label="团队邀请码" value={inviteCode.code} readOnly onFocus={event => event.target.select()} /><span>有效至 {new Date(inviteCode.expiresAt).toLocaleString('zh-CN')}；生成新码后旧码立即失效。</span></div>}
    <input ref={fileRef} type="file" className="visually-hidden" aria-label="上传团队 PDF" accept=".pdf,application/pdf" onChange={event => { void upload(event.target.files?.[0]); event.target.value = '' }} />
    <div className="library-toolbar"><div><span className="section-kicker">MEMBERS</span><h2>成员 <span>{workspace.members.length.toString().padStart(2, '0')}</span></h2></div>{owner && <span className="section-caption">仅所有者可邀请或移除成员</span>}</div>
    <Card className="workspace-list">
      {workspace.members.map(member => <div className="member-row" key={member.id}>
        <span className="member-avatar">{(member.name || '?').slice(0, 1)}</span>
        <div className="member-row__body"><strong>{member.name}{member.id === user?.id && <small>你</small>}</strong><p>{member.email || (member.role === 'owner' ? '空间所有者' : '团队成员')} <span>·</span> 加入于 {new Date(member.joinedAt).toLocaleDateString('zh-CN')}</p></div>
        <Badge tone={member.role === 'owner' ? 'blue' : 'neutral'}>{member.role === 'owner' ? '所有者' : '成员'}</Badge>
        {owner && member.role !== 'owner' && <Button variant="icon" aria-label={`移除成员 ${member.name}`} title="移除成员" onClick={() => setDialog({ kind: 'remove', member })}><Trash2 size={15} /></Button>}
      </div>)}
    </Card>
    <div className="library-toolbar"><div><span className="section-kicker">SHARED PAPERS</span><h2>共享文献 <span>{papers.length.toString().padStart(2, '0')}</span></h2></div><div className="team-heading-actions"><Button disabled={busy} onClick={() => fileRef.current?.click()}>上传团队论文</Button><Button variant="primary" onClick={() => void openAddPapers()}><Plus size={16} />添加我的文献</Button></div></div>
    <Card className="workspace-list">
      {!papers.length ? <div className="library-empty"><EmptyState icon={<BookOpen size={20} />} title="还没有共享文献" description="从个人文献库选择你拥有的论文加入空间，成员即可共同阅读与讨论。" /><Button variant="primary" onClick={() => void openAddPapers()}><Plus size={15} />添加第一篇文献</Button></div> : papers.map(item => <div className="workspace-row" key={item.paper.id}>
        <div className="workspace-row__icon"><BookOpen size={19} /></div>
        <div className="workspace-row__body"><Link className="library-title" to={`/library/${item.paper.id}/read?workspace=${id}`}>{item.paper.title}</Link><p><Badge tone={item.progress.status === 'finished' ? 'green' : 'blue'}>{statusLabels[item.progress.status]}</Badge> <span>·</span> {item.paper.pageCount} 页 <span>·</span> 共享者 {workspace.members.find(member => member.id === item.paper.ownerId)?.name ?? '成员'} <span>·</span> 加入于 {new Date(item.addedAt).toLocaleDateString('zh-CN')}</p></div>
        <div className="workspace-row__actions"><Link className="text-link workspace-open" to={`/library/${item.paper.id}/read?workspace=${id}`}>团队阅读</Link>{(owner || item.paper.ownerId === user?.id) && <Button variant="icon" aria-label={`从空间移除 ${item.paper.title}`} title="从空间移除" onClick={() => setDialog({ kind: 'removePaper', item })}><Trash2 size={15} /></Button>}</div>
      </div>)}
    </Card>
    {dialog?.kind === 'rename' && <div className="dialog-backdrop"><div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title"><div className="dialog-icon dialog-icon--blue"><Pencil size={19} /></div><h2 id="rename-title">编辑团队</h2><p>名称和简介会同步显示给团队成员。</p><form className="metadata-form" onSubmit={event => void rename(event)}><label>空间名称<Input aria-label="空间名称" required maxLength={120} autoFocus value={name} onChange={event => setName(event.target.value)} /></label><label>团队简介<textarea className="input" aria-label="团队简介" maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} /></label>{error && <p role="alert">{error}</p>}<div className="form-actions"><Button type="button" onClick={closeDialog} disabled={busy}>取消</Button><Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? '保存中...' : '保存名称'}</Button></div></form></div></div>}
    {dialog?.kind === 'invite' && <div className="dialog-backdrop"><div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="invite-title"><div className="dialog-icon dialog-icon--blue"><UserPlus size={19} /></div><h2 id="invite-title">邀请成员</h2><p>只能邀请已注册 PaperFlow 远程账号的邮箱，成员加入后可查看共享文献与讨论。</p><form className="metadata-form" onSubmit={event => void invite(event)}><label>成员邮箱<Input aria-label="成员邮箱" type="email" required maxLength={254} autoFocus value={email} onChange={event => setEmail(event.target.value)} placeholder="teammate@example.com" /></label><div className="form-actions"><Button type="button" onClick={closeDialog} disabled={busy}>取消</Button><Button type="submit" variant="primary" disabled={busy || !email.trim()}>{busy ? '邀请中...' : '发送邀请'}</Button></div></form></div></div>}
    {dialog?.kind === 'remove' && <div className="dialog-backdrop"><div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-title"><div className="dialog-icon"><Trash2 size={19} /></div><h2 id="remove-title">移除该成员？</h2><p>{dialog.member.name} 将立即失去该空间的文献与讨论访问权限，其个人文献库不受影响。</p><div className="dialog-actions"><Button onClick={closeDialog} disabled={busy}>取消</Button><Button variant="primary" className="button-danger" onClick={() => void removeMember(dialog.member)} disabled={busy}>{busy ? '移除中...' : '确认移除'}</Button></div></div></div>}
    {dialog?.kind === 'leave' && <div className="dialog-backdrop"><div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="leave-title"><div className="dialog-icon"><LogOut size={19} /></div><h2 id="leave-title">退出该空间？</h2><p>退出后你将无法查看该空间共享的文献、高亮与讨论；你上传的个人文献不会被删除。</p><div className="dialog-actions"><Button onClick={closeDialog} disabled={busy}>取消</Button><Button variant="primary" className="button-danger" onClick={() => void leave()} disabled={busy}>{busy ? '退出中...' : '确认退出'}</Button></div></div></div>}
    {dialog?.kind === 'addPaper' && <div className="dialog-backdrop"><div className="confirm-dialog confirm-dialog--wide" role="dialog" aria-modal="true" aria-labelledby="add-paper-title"><div className="dialog-icon dialog-icon--blue"><BookOpen size={19} /></div><h2 id="add-paper-title">添加共享文献</h2><p>只有你拥有的个人文献可以加入空间。加入后成员可共同阅读，不会复制或转移 PDF 文件。</p>
      {candidatesLoading ? <LoadingState label="正在读取个人文献库..." /> : !candidates.length ? <div className="saved-empty" role="status">个人文献库中没有可添加的文献。请先在文献库上传 PDF。</div> : <div className="candidate-list">{candidates.map(item => <div className="candidate-row" key={item.paper.id}><div className="candidate-copy"><strong>{item.paper.title}</strong><small>{item.paper.pageCount} 页 · {item.paper.fileName}</small></div><Button size="small" variant="primary" disabled={busy} onClick={() => void addPaper(item.paper.id)}>{busy ? '添加中...' : '加入空间'}</Button></div>)}</div>}
      <div className="dialog-actions"><Button onClick={closeDialog} disabled={busy}>关闭</Button></div></div></div>}
    {dialog?.kind === 'removePaper' && <div className="dialog-backdrop"><div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-paper-title"><div className="dialog-icon"><Trash2 size={19} /></div><h2 id="remove-paper-title">从团队空间移除？</h2><p>“{dialog.item.paper.title}”将不再对成员可见，但仅解除共享关系，不会删除 PDF 或个人文献库记录。</p><div className="dialog-actions"><Button onClick={closeDialog} disabled={busy}>取消</Button><Button variant="primary" className="button-danger" onClick={() => void removePaper(dialog.item)} disabled={busy}>{busy ? '移除中...' : '确认移除'}</Button></div></div></div>}
    <div className="team-detail-footnote"><UsersRound size={14} />团队空间与个人文献库相互隔离，共享行为不会改变论文的所有权。</div>
  </div>
}
