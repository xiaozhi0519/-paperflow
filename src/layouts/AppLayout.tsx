import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { BookOpen, BookOpenText, ChevronsLeft, CircleHelp, FileText, FolderKanban, LayoutGrid, Menu, PanelLeftOpen, Search, Sparkles, UsersRound, X } from 'lucide-react'
import { Input } from '../components/ui/Input'
import { useAuth } from '../services/auth'
import { setStorageMode, storageMode } from '../services/libraryStore'
import { workspaceService, type WorkspaceSummary } from '../services/workspaces'

type LayoutContext = { openUpload: () => void; query: string }
export type { LayoutContext }

const navigation = [
  { label: '工作台', path: '/', icon: LayoutGrid },
  { label: '文献库', path: '/library', icon: BookOpenText },
  { label: '论文精读', path: '/pdf-lab', icon: FileText },
  { label: '科研知识库', path: '/knowledge', icon: FolderKanban },
  { label: '团队空间', path: '/team', icon: UsersRound },
]

const titles: Record<string, string> = { '/': '工作台', '/library': '文献库', '/pdf-lab': '论文精读', '/knowledge': '科研知识库', '/team': '团队空间' }

export function AppLayout({ openUpload }: { openUpload: () => void }) {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { pathname } = useLocation()
  const { user, logout } = useAuth()
  const [accountError, setAccountError] = useState('')
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  useEffect(() => {
    if (storageMode !== 'remote' || !user) { setWorkspaces([]); return }
    let alive = true
    const load = () => { void workspaceService.list().then(items => { if (alive) setWorkspaces(items) }).catch(() => { if (alive) setWorkspaces([]) }) }
    load()
    window.addEventListener('paperflow:workspaces-changed', load)
    return () => { alive = false; window.removeEventListener('paperflow:workspaces-changed', load) }
  }, [user, pathname])

  return <div className={`app-shell ${collapsed ? 'is-collapsed' : ''}`}>
    {mobileOpen && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />}
    <aside className={`sidebar ${mobileOpen ? 'is-mobile-open' : ''}`}>
      <div className="brand-row">
        <NavLink to="/" className="brand" onClick={() => setMobileOpen(false)} aria-label="PaperFlow 工作台">
          <span className="brand-mark"><BookOpen size={20} strokeWidth={2.15} /></span>
          <span className="brand-copy"><strong>PaperFlow</strong><small>研知同行</small></span>
        </NavLink>
        <button className="sidebar-collapse" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? '展开导航栏' : '收起导航栏'} title={collapsed ? '展开导航栏' : '收起导航栏'}>{collapsed ? <PanelLeftOpen size={17} /> : <ChevronsLeft size={17} />}</button>
        <button className="sidebar-close" onClick={() => setMobileOpen(false)} aria-label="关闭导航"><X size={19} /></button>
      </div>
      <div className="sidebar-section-label">WORKSPACE</div>
      <nav className="main-nav" aria-label="主导航">
        {navigation.map(({ label, path, icon: Icon }) => <NavLink key={path} to={path} end={path === '/'} onClick={() => setMobileOpen(false)} title={collapsed ? label : undefined} className={({ isActive }) => `nav-item ${isActive ? 'is-active' : ''}`}><Icon size={18} strokeWidth={1.75} /><span>{label}</span>{path === '/pdf-lab' && <small>LAB</small>}</NavLink>)}
      </nav>
      <div className="sidebar-divider" />
      <div className="sidebar-section-label section-label-row"><span>我的空间</span><span className="sidebar-muted">{storageMode === 'remote' ? workspaces.length : 'LOCAL'}</span></div>
      <div className="sidebar-workspaces">
        {workspaces.slice(0, 6).map(workspace => <NavLink key={workspace.id} to={`/team/${workspace.id}`} onClick={() => setMobileOpen(false)} className={({ isActive }) => `sidebar-team ${isActive ? 'is-active' : ''}`} title={workspace.name}><span className="team-icon"><UsersRound size={15} /></span><span className="sidebar-team__text">{workspace.name}<small>{workspace.role === 'owner' ? '所有者' : '成员'} · {workspace.memberCount} 人</small></span></NavLink>)}
        <NavLink to="/team" onClick={() => setMobileOpen(false)} className={({ isActive }) => `sidebar-team ${isActive && !workspaces.length ? 'is-active' : ''}`} title={workspaces.length ? '全部团队空间' : '团队空间'}><span className="team-icon"><UsersRound size={15} /></span><span className="sidebar-team__text">{workspaces.length ? '全部团队空间' : '团队空间'}<small>{storageMode === 'remote' ? (workspaces.length ? '管理空间与成员' : '创建并邀请成员') : '需切换到远程模式'}</small></span></NavLink>
      </div>
      <div className="sidebar-bottom">
        <div className="sidebar-note"><span><Sparkles size={16} /></span><strong>让知识持续生长</strong><p>从一篇论文开始，积累每一次思考。</p></div>
        <div className="sidebar-footer"><CircleHelp size={16} /><span>PaperFlow 预览版</span><small>v0.1</small></div>
      </div>
    </aside>
    <div className="app-main">
      <header className="topbar">
        <div className="topbar-left"><button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="打开导航"><Menu size={20} /></button><span className="breadcrumb-muted">PaperFlow</span><span className="breadcrumb-slash">/</span><strong>{pathname.endsWith('/read') ? '论文阅读' : pathname.startsWith('/library/') ? '文献详情' : pathname.startsWith('/team/') ? '团队空间' : titles[pathname] ?? '工作台'}</strong></div>
        <div className="topbar-right">
          <label className="search-box"><Search size={16} /><Input value={query} onChange={event => setQuery(event.target.value)} placeholder={pathname === '/' ? '搜索演示文献' : '请在工作台搜索'} aria-label="搜索演示文献" disabled={pathname !== '/'} /></label>
          <select className="mode-select" aria-label="存储模式" value={storageMode} onChange={event => setStorageMode(event.target.value as 'local' | 'remote')}><option value="local">本地模式</option><option value="remote">远程模式</option></select>
          <div className="topbar-divider" />
          {storageMode === 'local' ? <div className="profile" aria-label="本地用户，未登录"><span className="profile-avatar">研</span><span className="profile-copy"><strong>研究者</strong><small>本地 · 未登录</small></span></div> : <div className="account-actions">{user ? <><NavLink to="/account">{user.name} · 账号资料</NavLink><button onClick={() => { setAccountError(''); void logout().catch(() => setAccountError('退出失败，请重试。')) }}>退出登录</button></> : <NavLink to="/library">登录 / 注册</NavLink>}{accountError && <span role="alert">{accountError}</span>}</div>}
        </div>
      </header>
      <main className="main-content"><Outlet context={{ openUpload, query } satisfies LayoutContext} /></main>
    </div>
  </div>
}
