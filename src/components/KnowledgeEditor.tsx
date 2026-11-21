import { useEffect, useState, type FormEvent } from 'react'
import { Button } from './ui/Button'
import { knowledgeService, kindLabels, knowledgeStatusLabels, type KnowledgeCard, type KnowledgeKind, type KnowledgeSource, type KnowledgeStatus } from '../services/knowledge'
import { libraryStore } from '../services/libraryStore'
import { workspaceService } from '../services/workspaces'

type Props = { source: KnowledgeSource; kind?: KnowledgeKind; card?: KnowledgeCard; onClose: () => void; onSaved: () => void }
export function KnowledgeEditor({ source, kind: initialKind = 'question', card, onClose, onSaved }: Props) {
  const [kind, setKind] = useState<KnowledgeKind>(card?.kind ?? initialKind)
  const [title, setTitle] = useState(card?.title ?? '')
  const [description, setDescription] = useState(card?.description ?? '')
  const [status, setStatus] = useState<KnowledgeStatus>(card?.status ?? 'open')
  const [paperId, setPaperId] = useState(source.paperId ?? '')
  const [papers, setPapers] = useState<{ id: string; title: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(!source.paperId && !card)
  const [error, setError] = useState('')
  useEffect(() => {
    if (source.paperId || card) return
    let active = true
    const request = source.workspaceId ? workspaceService.listPapers(source.workspaceId) : libraryStore.listPapers()
    void request.then(items => { if (active) setPapers(items.map(item => item.paper)) }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : '无法读取来源论文。') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [source.paperId, source.workspaceId, card])
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const fields = { title: title.trim(), description: description.trim(), status }
      if (card) await knowledgeService.update(card.id, fields)
      else await knowledgeService.create({ ...source, ...fields, kind, paperId: paperId || null })
      onSaved()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败。') }
    finally { setBusy(false) }
  }
  return <div className="dialog-backdrop"><div className="confirm-dialog confirm-dialog--wide knowledge-editor" role="dialog" aria-modal="true" aria-labelledby="knowledge-editor-title"><h2 id="knowledge-editor-title">{card ? '编辑知识卡片' : '创建知识卡片'}</h2><p>{source.workspaceId ? '团队公开 · 所有团队成员可见' : '个人私有 · 仅自己可见'}。人工整理内容不等同于论文原文事实。</p><form className="metadata-form" onSubmit={event => void save(event)}>
    <label>卡片类型<select className="input" aria-label="卡片类型" value={kind} disabled={Boolean(card) || busy} onChange={event => setKind(event.target.value as KnowledgeKind)}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>标题<input className="input" aria-label="知识标题" required maxLength={200} autoFocus value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label>内容与研究描述<textarea className="input" aria-label="知识内容" required maxLength={10000} rows={6} value={description} onChange={event => setDescription(event.target.value)} placeholder="写下研究问题、个人思考或人工整理的共识，并明确区分原文与推断。" /></label>
    {!source.paperId && !card ? <label>来源论文{kind === 'question' ? '（必选）' : '（可选）'}<select className="input" aria-label="来源论文" required={kind === 'question'} value={paperId} disabled={loading || busy} onChange={event => setPaperId(event.target.value)}><option value="">{loading ? '正在读取论文...' : '请选择来源论文'}</option>{papers.map(paper => <option key={paper.id} value={paper.id}>{paper.title}</option>)}</select></label> : <p className="knowledge-source-hint">已关联来源论文{source.annotationId ? '、原文批注' : ''}{source.commentId ? '、讨论' : ''}，保存后可返回来源。来源与可见范围不可修改。</p>}
    <label>研究状态<select className="input" aria-label="研究状态" value={status} onChange={event => setStatus(event.target.value as KnowledgeStatus)}>{Object.entries(knowledgeStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {error && <p className="storage-error" role="alert">{error}</p>}<div className="form-actions"><Button type="button" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" variant="primary" disabled={busy || loading || !title.trim() || !description.trim() || (kind === 'question' && !paperId)}>{busy ? '保存中...' : '保存知识卡片'}</Button></div>
  </form></div></div>
}
