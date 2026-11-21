import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { BookOpen, Plus } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { EmptyState, LoadingState } from '../components/ui/States'
import { KnowledgeEditor } from '../components/KnowledgeEditor'
import { knowledgeService, knowledgeSourcePath, kindLabels, knowledgeStatusLabels, type KnowledgeCard } from '../services/knowledge'
import { workspaceService, type WorkspaceSummary } from '../services/workspaces'
import { setStorageMode, storageMode } from '../services/libraryStore'

export function KnowledgePage() {
  const [params, setParams] = useSearchParams()
  const workspaceId = params.get('workspace') || null
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [cards, setCards] = useState<KnowledgeCard[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editor, setEditor] = useState<KnowledgeCard | 'new' | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    setLoading(true); setError(''); setCards([])
    try {
      const [teams, items] = await Promise.all([workspaceService.list(), knowledgeService.list(workspaceId)])
      setWorkspaces(teams); setCards(items)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法读取知识库。') }
    finally { setLoading(false) }
  }, [workspaceId])
  useEffect(() => { setEditor(null); setNotice(''); if (storageMode === 'remote') void refresh() }, [refresh])
  async function remove(id: string) {
    setBusy(true); setError('')
    try { await knowledgeService.remove(id); setPendingDelete(null); setNotice('知识卡片已删除。'); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '删除失败。') }
    finally { setBusy(false) }
  }
  if (storageMode === 'local') return <div className="page-wrap"><div className="page-heading"><div><h1>科研知识库</h1><p>将原文、讨论与人工研究记录关联起来。</p></div></div><Card className="team-gate"><EmptyState icon={<BookOpen size={20} />} title="科研知识库需要远程模式" description="个人知识卡片仅自己可见，团队卡片仅成员可见。切换模式不会改动已有本地文献和笔记。" /><Button variant="primary" onClick={() => setStorageMode('remote', '/knowledge')}>切换到远程模式</Button></Card></div>
  const source = { workspaceId, paperId: null, annotationId: null, commentId: null }
  return <div className="page-wrap knowledge-page"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> RESEARCH KNOWLEDGE</div><h1>{workspaceId ? '团队知识库' : '个人知识库'}</h1><p>从论文证据到研究问题，让每次思考有来源、每次贡献有记录。</p></div><Button variant="primary" disabled={loading || Boolean(error)} onClick={() => setEditor('new')}><Plus size={16} />新建知识卡片</Button></div>
    <div className="library-toolbar"><label className="knowledge-scope">知识范围<select className="input" aria-label="知识范围" value={workspaceId ?? ''} onChange={event => setParams(event.target.value ? { workspace: event.target.value } : {})}><option value="">个人私有</option>{workspaces.map(team => <option key={team.id} value={team.id}>{team.name} · 团队公开</option>)}</select></label><div className="team-heading-actions">{workspaceId && <Link className="text-link" to={`/team/${workspaceId}`}>返回团队</Link>}<Button disabled={loading} onClick={() => void refresh()}>刷新知识库</Button></div></div>
    <div className="local-notice">{workspaceId ? '团队公开：仅当前团队成员可见，创建者及团队所有者可管理。' : '个人私有：只有你能查看、编辑或删除这些卡片。'} 所有内容均由成员人工整理；原文引用与研究推断分开呈现。</div>
    {error && <div className="operation-message operation-message--error" role="alert">{error}</div>}{notice && <div className="operation-message operation-message--success" role="status">{notice}</div>}
    {loading ? <LoadingState label="正在读取知识库..." /> : !error && !cards.length ? <Card className="team-gate"><EmptyState icon={<BookOpen size={20} />} title="还没有知识卡片" description="新建科研笔记，或在论文批注、讨论旁创建研究问题与研究记录。" /></Card> : <div className="knowledge-grid">{cards.map(card => <Card className="knowledge-card" key={card.id}><div className="knowledge-card__labels"><Badge tone="blue">{kindLabels[card.kind]}</Badge><Badge tone={card.status === 'resolved' ? 'green' : 'neutral'}>{knowledgeStatusLabels[card.status]}</Badge><span>{card.workspaceId ? '团队公开' : '个人私有'}</span></div><h2>{card.title}</h2><p className="knowledge-description">{card.description}</p>
      {card.source && <blockquote><span>论文原文 · 第 {card.source.page} 页</span><p>{card.source.quote}</p></blockquote>}{card.discussion && <div className="knowledge-discussion"><strong>关联讨论（成员观点）</strong><p>{card.discussion}</p></div>}
      {card.paperId && <Link className="text-link knowledge-source-link" to={knowledgeSourcePath(card)}>返回论文来源 · {card.paperTitle}</Link>}
      <p className="knowledge-meta">{card.author.name} 创建于 {new Date(card.createdAt).toLocaleString('zh-CN')}<br />最近由 {card.updatedBy.name} 更新于 {new Date(card.updatedAt).toLocaleString('zh-CN')}</p>
      <details className="knowledge-history"><summary>贡献记录 · {card.contributions.length}</summary><ul>{card.contributions.map(entry => <li key={entry.id}>{entry.author.name} · {{ created: '创建', edited: '编辑', 'status-changed': '更新状态' }[entry.action]} · {new Date(entry.createdAt).toLocaleString('zh-CN')}</li>)}</ul></details>
      {card.canManage && <div className="knowledge-card__actions"><Button size="small" disabled={busy} onClick={() => setEditor(card)}>编辑卡片</Button>{pendingDelete === card.id ? <><Button size="small" disabled={busy} onClick={() => void remove(card.id)}>确认删除卡片</Button><Button size="small" disabled={busy} onClick={() => setPendingDelete(null)}>取消</Button></> : <Button size="small" disabled={busy} onClick={() => setPendingDelete(card.id)}>删除卡片</Button>}</div>}
    </Card>)}</div>}
    {editor && <KnowledgeEditor key={editor === 'new' ? 'new' : editor.id} source={editor === 'new' ? source : editor} card={editor === 'new' ? undefined : editor} kind="note" onClose={() => setEditor(null)} onSaved={() => { setEditor(null); setNotice('知识卡片已保存。'); void refresh() }} />}
  </div>
}
