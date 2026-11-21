import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, CloudUpload, FileCheck2, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { EmptyState, LoadingState } from '../components/ui/States'
import { importLocalItem, scanLocalLibrary, type ImportConflict, type LocalImportItem } from '../services/localImport'
import { libraryStore, setStorageMode, storageMode } from '../services/libraryStore'

const conflictLabels: Record<ImportConflict, string> = { 'already-imported': '已导入', 'duplicate-title': '标题重复', 'missing-file': '文件缺失', none: '可导入' }

const statusLabels = { unread: '待读', reading: '阅读中', finished: '已读' }

type ImportState = { state: 'importing' | 'imported' | 'failed'; detail?: string }

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function ImportLocalPage() {
  const [items, setItems] = useState<LocalImportItem[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(storageMode === 'remote')
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [states, setStates] = useState<Record<string, ImportState>>({})

  const scan = useCallback(async () => {
    setScanning(true); setError('')
    try {
      const remote = await libraryStore.listPapers()
      const result = await scanLocalLibrary(remote)
      setItems(result.items)
      setSelected(new Set(result.items.filter(item => item.conflict === 'none').map(item => item.paper.id)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取本地文献库。')
    } finally {
      setLoading(false); setScanning(false)
    }
  }, [])

  useEffect(() => { if (storageMode === 'remote') void scan() }, [scan])

  const importable = items.filter(item => item.conflict === 'none' || item.conflict === 'duplicate-title')
  const chosen = items.filter(item => selected.has(item.paper.id) && importable.some(value => value.paper.id === item.paper.id))

  function toggle(item: LocalImportItem) {
    if (item.conflict === 'already-imported' || item.conflict === 'missing-file' || busy) return
    setSelected(previous => { const next = new Set(previous); if (next.has(item.paper.id)) next.delete(item.paper.id); else next.add(item.paper.id); return next })
  }

  async function runImport() {
    setConfirming(false); setBusy(true); setError(''); setMessage('')
    const imported = new Set<string>()
    const failed = new Set<string>()
    let highlights = 0
    let notes = 0
    let warnings = 0
    for (const item of chosen) {
      setStates(previous => ({ ...previous, [item.paper.id]: { state: 'importing' } }))
      try {
        const result = await importLocalItem(item)
        highlights += result.annotations; notes += result.notes; warnings += result.warnings.length; imported.add(item.paper.id)
        setStates(previous => ({ ...previous, [item.paper.id]: { state: 'imported', detail: `已导入 ${result.annotations} 个高亮、${result.notes} 条笔记${result.warnings.length ? `；${result.warnings.join(' ')}` : ''}` } }))
      } catch (cause) {
        failed.add(item.paper.id)
        setStates(previous => ({ ...previous, [item.paper.id]: { state: 'failed', detail: cause instanceof Error ? cause.message : '导入失败。' } }))
      }
    }
    setItems(previous => previous.map(item => imported.has(item.paper.id) ? { ...item, conflict: 'already-imported' } : item))
    setSelected(failed)
    setBusy(false)
    if (imported.size) setMessage(`已导入 ${imported.size} 篇文献、${highlights} 个高亮、${notes} 条笔记。本地浏览器中的数据保持不变${warnings ? `；有 ${warnings} 项内容未能导入，详见列表提示` : ''}。`)
    if (failed.size) setError(`${failed.size} 篇文献导入失败，可稍后重试；已上传的部分需在文献库中手动处理。`)
  }

  if (storageMode === 'local') return <div className="page-wrap">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> LOCAL IMPORT</div><h1>导入本地文献</h1><p>把当前浏览器 IndexedDB 中的文献安全复制到远程文献库。</p></div></div>
    <Card className="team-gate"><EmptyState icon={<CloudUpload size={20} />} title="需要远程模式" description="导入会写入远程账号，请先切换存储模式并登录；本地数据不会被删除或修改。" /><Button variant="primary" onClick={() => setStorageMode('remote', '/library/import')}>切换到远程模式</Button></Card>
  </div>

  return <div className="page-wrap import-page">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> LOCAL IMPORT</div><h1>导入本地文献</h1><p>从当前浏览器的 IndexedDB 复制文献到远程库，导入前可预览冲突，不会静默覆盖。</p></div><Link className="back-link import-back" to="/library"><ArrowLeft size={14} /> 返回文献库</Link></div>
    <div className="local-notice"><ShieldCheck size={13} /> 导入只读取本地数据：不会删除、移动或修改浏览器中的原始文献；远程已存在的文献会被跳过，标题重复的文献默认不导入，可手动勾选。</div>
    {message && <div className="operation-message operation-message--success" role="status">{message}</div>}
    {error && <div className="operation-message operation-message--error" role="alert">{error}</div>}
    {loading || scanning ? <Card className="import-card"><LoadingState label="正在扫描浏览器本地文献..." /></Card> : !items.length ? <Card className="import-card"><EmptyState icon={<FileCheck2 size={20} />} title="没有可导入的本地文献" description="当前浏览器中没有检测到 IndexedDB 文献，或本地文献已全部导入。" /><div className="import-empty-actions"><Link className="text-link" to="/library">返回文献库</Link></div></Card> : <>
      <div className="library-toolbar"><div><span className="section-kicker">PREVIEW</span><h2>待导入文献 <span>{items.length.toString().padStart(2, '0')}</span></h2></div><div className="import-summary"><span>已选 {chosen.length} 篇</span><span>{chosen.reduce((sum, item) => sum + item.annotationCount, 0)} 个高亮</span><span>{chosen.reduce((sum, item) => sum + item.noteCount, 0)} 条笔记</span><Button variant="primary" disabled={!chosen.length || busy} onClick={() => setConfirming(true)}><CloudUpload size={15} />{busy ? '导入中...' : '开始导入'}</Button></div></div>
      <Card className="import-card"><div className="import-list">{items.map(item => {
        const disabled = item.conflict === 'already-imported' || item.conflict === 'missing-file'
        const state = states[item.paper.id]
        return <label className={`import-row${disabled ? ' import-row--disabled' : ''}`} key={item.paper.id}>
          <input type="checkbox" checked={selected.has(item.paper.id)} disabled={disabled || busy} onChange={() => toggle(item)} aria-label={`选择 ${item.paper.title}`} />
          <div className="import-row__body">
            <div className="import-row__title"><strong>{item.paper.title}</strong><Badge tone={item.conflict === 'duplicate-title' ? 'blue' : item.conflict === 'missing-file' ? 'neutral' : 'green'}>{conflictLabels[item.conflict]}</Badge></div>
            <p>{item.paper.pageCount} 页 <span>·</span> {formatSize(item.paper.fileSize)} <span>·</span> {statusLabels[item.progress.status]}{item.progress.lastPage > 1 ? ` · 第 ${item.progress.lastPage} 页` : ''}</p>
            <div className="import-row__meta"><span>{item.annotationCount} 个高亮</span><span>{item.noteCount} 条笔记</span>{item.conflict === 'already-imported' && <span>远程库已存在同一文献，不会重复创建</span>}{item.conflict === 'duplicate-title' && <span>远程库已有同名文献，默认不勾选</span>}{item.conflict === 'missing-file' && <span>本地文件缺失，无法上传</span>}</div>
            {state && <div className={`import-state import-state--${state.state}`} role="status">{state.state === 'importing' ? '正在导入...' : state.detail}</div>}
          </div>
        </label>
      })}</div></Card>
    </>}
    {confirming && <div className="dialog-backdrop"><div className="confirm-dialog confirm-dialog--wide" role="dialog" aria-modal="true" aria-labelledby="import-title"><div className="dialog-icon dialog-icon--blue"><CloudUpload size={19} /></div><h2 id="import-title">确认导入到远程库？</h2><p>将导入 {chosen.length} 篇文献、{chosen.reduce((sum, item) => sum + item.annotationCount, 0)} 个高亮和 {chosen.reduce((sum, item) => sum + item.noteCount, 0)} 条笔记。导入为新增副本：不会覆盖远程已有文献，也不会删除或修改浏览器中的本地数据；如中途失败，已上传的文献会保留在远程库。</p><div className="dialog-actions"><Button onClick={() => setConfirming(false)} disabled={busy}>取消</Button><Button variant="primary" onClick={() => void runImport()} disabled={busy}>确认导入</Button></div></div></div>}
  </div>
}
