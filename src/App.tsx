import { lazy, Suspense, useRef, useState } from 'react'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AppLayout } from './layouts/AppLayout'
import { DashboardPage } from './pages/DashboardPage'
import { LoadingState } from './components/ui/States'
import { PlaceholderPage } from './pages/PlaceholderPage'
import { LibraryPage } from './pages/LibraryPage'
import { ImportLocalPage } from './pages/ImportLocalPage'
import { PaperDetailPage } from './pages/PaperDetailPage'
import { AccountPage, RequireRemoteAccount } from './pages/AccountPage'
import { TeamPage } from './pages/TeamPage'
import { TeamDetailPage } from './pages/TeamDetailPage'
import { KnowledgePage } from './pages/KnowledgePage'

const PdfLabPage = lazy(() => import('./pages/PdfLabPage').then(module => ({ default: module.PdfLabPage })))
const ReaderPage = lazy(() => import('./pages/ReaderPage').then(module => ({ default: module.ReaderPage })))

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [uploadError, setUploadError] = useState('')

  function handleFile(file?: File) {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.pdf') || file.size > 20 * 1024 * 1024 || file.size === 0) {
      setUploadError('请选择不超过 20 MB 的非空 PDF 文件。')
      return
    }
    setUploadError('')
    if (pathname === '/pdf-lab') navigate('/pdf-lab', { state: { file } })
    else navigate('/library', { state: { file } })
  }

  return <>
    <input ref={inputRef} type="file" accept="application/pdf,.pdf" className="visually-hidden" aria-label="选择 PDF 文件" onChange={event => { handleFile(event.target.files?.[0]); event.target.value = '' }} />
    {uploadError && <div className="upload-alert" role="alert">{uploadError}<button onClick={() => setUploadError('')} aria-label="关闭">×</button></div>}
    <Routes>
      <Route element={<AppLayout openUpload={() => inputRef.current?.click()} />}>
        <Route index element={<DashboardPage />} />
        <Route path="pdf-lab" element={<Suspense fallback={<LoadingState label="正在加载阅读器..." />}><PdfLabPage /></Suspense>} />
        <Route path="library" element={<RequireRemoteAccount><LibraryPage /></RequireRemoteAccount>} />
        <Route path="library/import" element={<RequireRemoteAccount><ImportLocalPage /></RequireRemoteAccount>} />
        <Route path="library/:paperId" element={<RequireRemoteAccount><PaperDetailPage /></RequireRemoteAccount>} />
        <Route path="library/:paperId/read" element={<RequireRemoteAccount><Suspense fallback={<LoadingState label="正在加载阅读器..." />}><ReaderPage /></Suspense></RequireRemoteAccount>} />
        <Route path="account" element={<RequireRemoteAccount><AccountPage /></RequireRemoteAccount>} />
        <Route path="knowledge" element={<RequireRemoteAccount><KnowledgePage /></RequireRemoteAccount>} />
        <Route path="team" element={<RequireRemoteAccount><TeamPage /></RequireRemoteAccount>} />
        <Route path="team/:id" element={<RequireRemoteAccount><TeamDetailPage /></RequireRemoteAccount>} />
        <Route path="*" element={<PlaceholderPage title="页面不存在" description="可以返回工作台继续体验。" />} />
      </Route>
    </Routes>
  </>
}
