import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { storageMode } from './libraryStore'
import { clearRemoteCache } from './remoteLibrary'
import { apiUrl } from './api'

export interface Account { id: string; name: string; email: string }
type AuthState = 'loading' | 'guest' | 'ready' | 'unavailable'
type AuthContextValue = { state: AuthState; user: Account | null; refresh: () => Promise<void>; login: (email: string, password: string, name?: string) => Promise<void>; logout: () => Promise<void>; updateName: (name: string) => Promise<void> }
const AuthContext = createContext<AuthContextValue | null>(null)

async function authRequest(path: string, method = 'GET', body?: unknown): Promise<Response> {
  const response = await fetch(apiUrl(`/auth/${path}`), { method, credentials: 'same-origin', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error || '无法连接账号服务。')
  }
  return response
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(storageMode === 'remote' ? 'loading' : 'guest')
  const [user, setUser] = useState<Account | null>(null)
  const refresh = useCallback(async () => {
    if (storageMode !== 'remote') return
    setState('loading')
    try {
      const response = await fetch(apiUrl('/auth/me'), { credentials: 'same-origin' })
      if (response.status === 401) { clearRemoteCache(); setUser(null); setState('guest'); return }
      if (!response.ok) throw new Error('unavailable')
      setUser((await response.json() as { user: Account }).user); setState('ready')
    } catch { setUser(null); setState('unavailable') }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const expire = () => { clearRemoteCache(); setUser(null); setState('guest') }
    window.addEventListener('paperflow:session-expired', expire)
    return () => window.removeEventListener('paperflow:session-expired', expire)
  }, [])
  async function login(email: string, password: string, name?: string) {
    const response = await authRequest(name === undefined ? 'login' : 'register', 'POST', { email, password, ...(name === undefined ? {} : { name }) })
    clearRemoteCache(); setUser((await response.json() as { user: Account }).user); setState('ready')
  }
  async function logout() {
    await authRequest('logout', 'POST')
    clearRemoteCache(); setUser(null); setState('guest')
  }
  async function updateName(name: string) {
    const response = await authRequest('me', 'PATCH', { name })
    setUser((await response.json() as { user: Account }).user)
  }
  return <AuthContext.Provider value={{ state, user, refresh, login, logout, updateName }}>{children}</AuthContext.Provider>
}
export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('AuthProvider missing')
  return value
}
