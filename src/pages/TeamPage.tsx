import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ArrowRight, Plus, UsersRound } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input } from '../components/ui/Input'
import { EmptyState, LoadingState } from '../components/ui/States'
import { setStorageMode, storageMode } from '../services/libraryStore'
import { workspaceService, type WorkspaceSummary } from '../services/workspaces'

export function TeamPage() {
  const [items, setItems] = useState<WorkspaceSummary[]>([])
  const [loading, setLoading] = useState(storageMode === 'remote')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [joining, setJoining] = useState(false)
  const [code, setCode] = useState('')
  const navigate = useNavigate()
  async function join(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try { const team = await workspaceService.join(code.trim().toLowerCase()); navigate(`/team/${team.id}`) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '加入失败。') }
    finally { setBusy(false) }
  }
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try { setItems(await workspaceService.list()); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '无法读取团队空间。') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { if (storageMode === 'remote') void refresh() }, [refresh])

  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError('')
    try { const team = await workspaceService.create(name.trim(), description.trim()); navigate(`/team/${team.id}`) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '创建团队空间失败。') }
    finally { setBusy(false) }
  }

  if (storageMode === 'local') return <div className="page-wrap"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> TEAM SPACE</div><h1>团队空间</h1><p>团队共享的文献与讨论需要远程账号，避免误把本地数据当作团队数据。</p></div></div>
    <Card className="team-gate"><EmptyState icon={<UsersRound size={20} />} title="团队空间需要远程模式" description="本地模式的文献与记录只保存在当前浏览器，无法邀请成员或共享讨论。切换后本地数据仍会保留。" /><Button variant="primary" onClick={() => setStorageMode('remote', '/team')}>切换到远程模式</Button></Card>
  </div>

  return <div className="page-wrap">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> TEAM SPACE</div><h1>团队空间</h1><p>在团队中共享论文、共读高亮与讨论记录，个人文献库保持独立。</p></div><div className="team-heading-actions"><Button onClick={() => { setJoining(true); setError('') }}>邀请码加入</Button><Button variant="primary" onClick={() => { setCreating(true); setError('') }}><Plus size={16} />创建空间</Button></div></div>
    <div className="local-notice">团队空间属于远程模式：空间内共享的文献、高亮与讨论只对成员可见；个人文献库不会自动共享。</div>
    {error && <div className="operation-message operation-message--error" role="alert">{error}</div>}
    <div className="library-toolbar"><div><span className="section-kicker">MY WORKSPACES</span><h2>我的空间 <span>{items.length.toString().padStart(2, '0')}</span></h2></div></div>
    <Card className="workspace-list">
      {loading ? <LoadingState label="正在读取团队空间..." /> : !items.length ? <div className="library-empty"><EmptyState icon={<UsersRound size={20} />} title="还没有团队空间" description="创建一个空间，邀请成员后即可共享论文与讨论。" /><Button variant="primary" onClick={() => setCreating(true)}><Plus size={15} />创建第一个空间</Button></div> : items.map(workspace => <div className="workspace-row" key={workspace.id}>
        <div className="workspace-row__icon"><UsersRound size={19} /></div>
        <div className="workspace-row__body"><Link className="library-title" to={`/team/${workspace.id}`}>{workspace.name}</Link>{workspace.description && <p>{workspace.description}</p>}<p><Badge tone={workspace.role === 'owner' ? 'blue' : 'neutral'}>{workspace.role === 'owner' ? '所有者' : '成员'}</Badge> <span>·</span> {workspace.memberCount} 位成员 <span>·</span> 创建于 {new Date(workspace.createdAt).toLocaleDateString('zh-CN')}</p></div>
        <div className="workspace-row__actions"><Link className="text-link workspace-open" to={`/team/${workspace.id}`}>进入空间<ArrowRight size={14} /></Link></div>
      </div>)}
    </Card>
    {joining && <div className="dialog-backdrop"><div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="join-title"><h2 id="join-title">通过邀请码加入</h2><p>向团队所有者索取有效邀请码，加入后可访问团队共享内容。</p><form className="metadata-form" onSubmit={event => void join(event)}><label>邀请码<Input aria-label="邀请码" autoFocus required maxLength={32} value={code} onChange={event => setCode(event.target.value)} /></label>{error && <p role="alert">{error}</p>}<div className="form-actions"><Button type="button" disabled={busy} onClick={() => setJoining(false)}>取消</Button><Button variant="primary" type="submit" disabled={busy || !code.trim()}>加入团队</Button></div></form></div></div>}
    {creating && <div className="dialog-backdrop"><div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="create-workspace-title"><div className="dialog-icon dialog-icon--blue"><UsersRound size={19} /></div><h2 id="create-workspace-title">创建团队空间</h2><p>空间创建后，你将成为所有者，可邀请已注册的成员加入。</p>
      <form className="metadata-form" onSubmit={event => void create(event)}><label>空间名称<Input aria-label="空间名称" required maxLength={120} autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="例如：多模态研究组" /></label><label>团队简介<textarea className="input" aria-label="团队简介" maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} /></label>{error && <p role="alert">{error}</p>}<div className="form-actions"><Button type="button" onClick={() => setCreating(false)} disabled={busy}>取消</Button><Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? '创建中...' : '创建空间'}</Button></div></form>
    </div></div>}
  </div>
}
