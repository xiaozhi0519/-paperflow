import { useEffect, useState, type FormEvent } from 'react'
import { CornerDownRight, MessageSquare, RefreshCw, Send, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { commentService, type DiscussionComment } from '../../services/comments'
import { summaryService, type GeneratedSummary, type SavedSummary, type SummarySections } from '../../services/summaries'
import { SummaryView } from './SummaryView'
import type { Annotation } from '../../types/library'
import { getAiStatus } from '../../services/aiClient'
import type { KnowledgeKind, KnowledgeSource } from '../../services/knowledge'

type Props = {
  paperId: string
  workspaceId: string | null
  annotations: Annotation[]
  onOpenAnnotation: (annotation: Annotation) => void
  focusAnnotationId: string | null
  focusCommentId: string | null
  onCreateKnowledge: (source: KnowledgeSource, kind: KnowledgeKind) => void
}

export function DiscussionPanel({ paperId, workspaceId, annotations, onOpenAnnotation, focusAnnotationId, focusCommentId, onCreateKnowledge }: Props) {
  const [comments, setComments] = useState<DiscussionComment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState('')
  const [anchorId, setAnchorId] = useState('')
  const [busy, setBusy] = useState(false)
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyDraft, setReplyDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [generated, setGenerated] = useState<GeneratedSummary | null>(null)
  const [generating, setGenerating] = useState(false)
  const [saved, setSaved] = useState<SavedSummary[]>([])
  const [viewing, setViewing] = useState<string | null>(null)
  const [pendingSummaryDelete, setPendingSummaryDelete] = useState<string | null>(null)
  const [aiConfigured, setAiConfigured] = useState(false)
  useEffect(() => { let active = true; void getAiStatus().then(value => { if (active) setAiConfigured(value.configured) }).catch(() => { if (active) setAiConfigured(false) }); return () => { active = false } }, [])
  useEffect(() => { setAnchorId(focusAnnotationId ?? '') }, [focusAnnotationId])
  useEffect(() => {
    if (loading || !focusCommentId) return
    window.document.getElementById(`comment-${focusCommentId}`)?.scrollIntoView({ block: 'center' })
  }, [loading, focusCommentId])

  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    void commentService.list(paperId, workspaceId).then(items => { if (active) setComments(items) }).catch((cause: unknown) => { if (active) { setComments([]); setError(cause instanceof Error ? cause.message : '无法加载讨论。') } }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [paperId, workspaceId, reloadKey])
  useEffect(() => {
    if (!workspaceId) { setSaved([]); return }
    let active = true
    void summaryService.list(paperId, workspaceId).then(items => { if (active) setSaved(items) }).catch(() => { if (active) setSaved([]) })
    return () => { active = false }
  }, [paperId, workspaceId, reloadKey])

  async function submitRoot(event: FormEvent) {
    event.preventDefault()
    if (!draft.trim() || busy) return
    setBusy(true); setError(''); setNotice('')
    try { const created = await commentService.create(paperId, { content: draft.trim(), workspaceId, annotationId: anchorId || undefined }); setComments(current => [...current, created]); setDraft(''); setAnchorId(''); setNotice('讨论已发布。') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '讨论发布失败。') }
    finally { setBusy(false) }
  }
  async function submitReply(parentId: string) {
    if (!replyDraft.trim() || busy) return
    setBusy(true); setError(''); setNotice('')
    try { const created = await commentService.create(paperId, { content: replyDraft.trim(), parentId, workspaceId }); setComments(current => [...current, created]); setReplyDraft(''); setReplyTo(null); setNotice('回复已发布。') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '回复失败。') }
    finally { setBusy(false) }
  }
  async function remove(id: string) {
    setBusy(true); setError(''); setNotice('')
    try { await commentService.remove(id); setComments(current => current.filter(comment => comment.id !== id && comment.parentId !== id)); setPendingDelete(null); setNotice('讨论已删除。') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '删除失败。') }
    finally { setBusy(false) }
  }
  async function generateSummary() {
    if (!workspaceId || generating) return
    setGenerating(true); setError(''); setNotice('')
    try { setGenerated(await summaryService.generate(paperId, workspaceId)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '生成总结失败。') }
    finally { setGenerating(false) }
  }
  async function saveSummary() {
    if (!workspaceId || !generated) return
    setBusy(true); setError(''); setNotice('')
    const sections: SummarySections = { overview: generated.overview, researchQuestions: generated.researchQuestions, keyPoints: generated.keyPoints, disagreements: generated.disagreements, consensus: generated.consensus, openQuestions: generated.openQuestions }
    try { const item = await summaryService.save(paperId, workspaceId, generated.model, sections); setSaved(current => [item, ...current]); setGenerated(null); setViewing(item.id); setNotice('总结已保存到团队空间。') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存总结失败。') }
    finally { setBusy(false) }
  }
  async function removeSummary(id: string) {
    setBusy(true); setError(''); setNotice('')
    try { await summaryService.remove(id); setSaved(current => current.filter(item => item.id !== id)); if (viewing === id) setViewing(null); setPendingSummaryDelete(null); setNotice('总结已删除。') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '删除总结失败。') }
    finally { setBusy(false) }
  }
  function annotationLabel(annotationId: string) {
    const annotation = annotations.find(item => item.id === annotationId)
    if (!annotation) return <span className="discussion-anchor discussion-anchor--missing">关联高亮已删除</span>
    return <button type="button" className="discussion-anchor" onClick={() => onOpenAnnotation(annotation)}>关联高亮 · 第 {annotation.page} 页「{annotation.text.slice(0, 40)}{annotation.text.length > 40 ? '…' : ''}」</button>
  }
  const roots = comments.filter(comment => !comment.parentId)
  return <div className="discussion-panel">
    <div className="inspector-heading"><span className="inspector-icon"><MessageSquare size={18} /></span><div><h2>团队讨论</h2><p>{workspaceId ? '仅空间成员可见，围绕这篇论文展开讨论' : '仅自己可见的个人讨论'}</p></div><button className="discussion-refresh" aria-label="刷新讨论" disabled={loading || busy} onClick={() => setReloadKey(value => value + 1)}><RefreshCw size={15} /></button></div>
    {error && <div className="operation-message operation-message--error" role="alert">{error}</div>}{notice && <div className="operation-message operation-message--success" role="status">{notice}</div>}
    {workspaceId && <section className="summary-block">
      <div className="summary-block__header"><span className="summary-block__title"><Sparkles size={14} />AI 讨论总结</span><Button size="small" disabled={!aiConfigured || generating || loading || busy} onClick={() => void generateSummary()}>{!aiConfigured ? 'AI 尚未配置' : generating ? '正在生成...' : '生成总结'}</Button></div>
      <p className="summary-hint">仅生成预览，需手动保存为团队总结；不会写入或覆盖任何笔记。每条内容都会标注来源类型。</p>
      {generated && <div className="summary-preview"><div className="summary-preview__meta">预览 · 基于 {generated.discussionCount} 条讨论与 {generated.annotationCount} 条团队高亮{generated.model ? ` · ${generated.model}` : ''}</div><SummaryView summary={generated} comments={comments} warnings={generated.warnings} /><div className="summary-preview__actions"><Button size="small" disabled={busy} onClick={() => setGenerated(null)}>放弃预览</Button><Button size="small" variant="primary" disabled={busy} onClick={() => void saveSummary()}>保存为团队总结</Button></div></div>}
      {saved.length > 0 && <div className="summary-saved"><div className="summary-saved__heading">已保存总结 {saved.length}</div>{saved.map(item => <div className="summary-saved__item" key={item.id}><div className="summary-saved__row"><button className="summary-saved__toggle" onClick={() => setViewing(viewing === item.id ? null : item.id)}>{new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })} · {item.author.name}{item.model ? ` · ${item.model}` : ''}</button>{pendingSummaryDelete === item.id ? <span className="discussion-delete"><button disabled={busy} onClick={() => void removeSummary(item.id)}>确认删除</button><button disabled={busy} onClick={() => setPendingSummaryDelete(null)}>取消</button></span> : <button className="delete-anchor" aria-label="删除总结" disabled={busy} onClick={() => setPendingSummaryDelete(item.id)}><Trash2 size={14} /></button>}</div>{viewing === item.id && <SummaryView summary={item.summary} comments={comments} />}</div>)}</div>}
    </section>}
    <div className="annotation-actions"><Button size="small" onClick={() => onCreateKnowledge({ workspaceId, paperId, annotationId: focusAnnotationId, commentId: null }, 'record')}>人工整理研究记录</Button></div>
    {focusAnnotationId && <div className="local-notice">正在围绕所选批注讨论：{annotationLabel(focusAnnotationId)}。发布内容会关联该批注。</div>}
    <form className="discussion-compose" onSubmit={event => void submitRoot(event)}><textarea className="input" aria-label="发布讨论" maxLength={4000} value={draft} onChange={event => setDraft(event.target.value)} placeholder="提出研究问题、补充观点或指出分歧..." disabled={busy} /><div className="discussion-compose__actions"><select className="input discussion-anchor-select" aria-label="关联高亮" value={anchorId} disabled={busy || !annotations.length} onChange={event => setAnchorId(event.target.value)}><option value="">{annotations.length ? '关联高亮（可选）' : '暂无可关联的高亮'}</option>{annotations.map(annotation => <option key={annotation.id} value={annotation.id}>第 {annotation.page} 页 · {annotation.text.slice(0, 30)}{annotation.text.length > 30 ? '…' : ''}</option>)}</select><span>{draft.length} / 4000</span><Button type="submit" variant="primary" size="small" disabled={busy || !draft.trim()}><Send size={14} />发布讨论</Button></div></form>
    {loading ? <div className="saved-empty">正在加载讨论...</div> : roots.length === 0 ? <div className="saved-empty">还没有讨论。围绕本文的问题、观点与分歧都可以从这里开始。</div> : <div className="discussion-threads">{roots.map(root => {
      const replies = comments.filter(comment => comment.parentId === root.id)
      return <article id={`comment-${root.id}`} className={`discussion-thread${root.id === focusCommentId || root.annotationId === focusAnnotationId && focusAnnotationId ? ' discussion-thread--focused' : ''}`} key={root.id}><header className="discussion-thread__meta"><span className="discussion-avatar">{root.author.name.slice(0, 1)}</span><div><strong>{root.author.name}</strong><small>{new Date(root.createdAt).toLocaleString('zh-CN', { hour12: false })}</small></div>{root.canDelete && (pendingDelete === root.id ? <span className="discussion-delete"><button disabled={busy} onClick={() => void remove(root.id)}>确认删除</button><button disabled={busy} onClick={() => setPendingDelete(null)}>取消</button></span> : <button className="delete-anchor" aria-label="删除讨论" disabled={busy} onClick={() => setPendingDelete(root.id)}><Trash2 size={14} /></button>)}</header><p className="discussion-content">{root.content}</p>{root.annotationId && <div className="discussion-thread__anchor">{annotationLabel(root.annotationId)}</div>}
        {replies.map(reply => <div id={`comment-${reply.id}`} className="discussion-reply" key={reply.id}><header className="discussion-thread__meta"><span className="discussion-avatar discussion-avatar--small">{reply.author.name.slice(0, 1)}</span><div><strong>{reply.author.name}</strong><small>{new Date(reply.createdAt).toLocaleString('zh-CN', { hour12: false })}</small></div>{reply.canDelete && (pendingDelete === reply.id ? <span className="discussion-delete"><button disabled={busy} onClick={() => void remove(reply.id)}>确认删除</button><button disabled={busy} onClick={() => setPendingDelete(null)}>取消</button></span> : <button className="delete-anchor" aria-label="删除回复" disabled={busy} onClick={() => setPendingDelete(reply.id)}><Trash2 size={13} /></button>)}</header><p className="discussion-content">{reply.content}</p>{reply.annotationId && <div className="discussion-thread__anchor">{annotationLabel(reply.annotationId)}</div>}</div>)}
        {replyTo === root.id ? <div className="discussion-reply-form"><textarea className="input" aria-label="回复讨论" maxLength={4000} value={replyDraft} onChange={event => setReplyDraft(event.target.value)} placeholder={`回复 ${root.author.name}...`} disabled={busy} /><div className="discussion-compose__actions"><Button size="small" disabled={busy} onClick={() => { setReplyTo(null); setReplyDraft('') }}>取消</Button><Button size="small" variant="primary" disabled={busy || !replyDraft.trim()} onClick={() => void submitReply(root.id)}><Send size={13} />回复</Button></div></div> : <button className="discussion-reply-toggle" disabled={busy} onClick={() => { setReplyTo(root.id); setReplyDraft(''); setPendingDelete(null) }}><CornerDownRight size={14} />回复</button>}
        <div className="annotation-actions"><Button size="small" onClick={() => onCreateKnowledge({ workspaceId, paperId, annotationId: root.annotationId, commentId: root.id }, 'question')}>创建研究问题</Button><Button size="small" onClick={() => onCreateKnowledge({ workspaceId, paperId, annotationId: root.annotationId, commentId: root.id }, 'record')}>整理为研究记录</Button></div>
      </article>
    })}</div>}
  </div>
}
