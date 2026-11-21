import { useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input } from '../components/ui/Input'
import { LoadingState } from '../components/ui/States'
import { useAuth } from '../services/auth'
import { storageMode } from '../services/libraryStore'

export function RequireRemoteAccount({ children }: { children: ReactNode }) {
  const { state, refresh } = useAuth()
  if (storageMode === 'local' || state === 'ready') return children
  if (state === 'loading') return <LoadingState label="正在恢复账号会话..." />
  if (state === 'unavailable') return <div className="page-wrap"><div className="operation-message operation-message--error" role="alert">无法连接远程服务，请启动 PaperFlow 后端后重试。</div><Button onClick={() => void refresh()}>重新连接</Button></div>
  return <AccountForm />
}

function AccountForm() {
  const { login } = useAuth()
  const [register, setRegister] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try { await login(email, password, register ? name : undefined); setPassword('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '账号服务不可用。') }
    finally { setBusy(false) }
  }
  return <div className="page-wrap"><Card className="account-card"><div className="eyebrow">REMOTE LIBRARY</div><h1>{register ? '创建账号' : '登录远程文献库'}</h1><p>远程文献与当前浏览器的本地文献相互独立，不会自动同步。</p>
    {error && <div className="operation-message operation-message--error" role="alert">{error}</div>}
    <form className="metadata-form" onSubmit={event => void submit(event)}>
      {register && <label>名称<Input aria-label="名称" autoComplete="name" required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>}
      <label>邮箱<Input aria-label="邮箱" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></label>
      <label>密码<Input aria-label="密码" type="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={10} maxLength={72} value={password} onChange={event => setPassword(event.target.value)} /></label>
      <Button variant="primary" type="submit" disabled={busy}>{busy ? '请稍候...' : register ? '注册并登录' : '登录'}</Button>
    </form><button className="account-toggle" type="button" onClick={() => { setRegister(!register); setError('') }}>{register ? '已有账号？登录' : '没有账号？注册'}</button>
  </Card></div>
}

export function AccountPage() {
  const { user, updateName } = useAuth()
  const [name, setName] = useState(user?.name ?? '')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    try { await updateName(name); setMessage('账号资料已保存。') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败。') }
    finally { setBusy(false) }
  }
  if (!user) return null
  return <div className="page-wrap"><Card className="account-card"><div className="eyebrow">ACCOUNT</div><h1>账号资料</h1><p>{user.email}</p>
    {error && <div className="operation-message operation-message--error" role="alert">{error}</div>}{message && <div className="operation-message operation-message--success" role="status">{message}</div>}
    <form className="metadata-form" onSubmit={event => void submit(event)}><label>名称<Input aria-label="名称" required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label><Button type="submit" variant="primary" disabled={busy}>保存资料</Button></form>
  </Card></div>
}
