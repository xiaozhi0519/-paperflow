import type { DiscussionComment } from '../../services/comments'
import type { SummaryItem, SummarySections, SummarySourceType } from '../../services/summaries'

const SECTION_LABELS: Array<[keyof Omit<SummarySections, 'overview'>, string]> = [['researchQuestions', '研究问题'], ['keyPoints', '关键观点'], ['disagreements', '分歧'], ['consensus', '初步共识'], ['openQuestions', '待解决问题']]
const SOURCE_LABELS: Record<SummarySourceType, string> = { 'paper-evidence': '论文证据', 'member-opinion': '成员观点', 'ai-inference': 'AI 推断' }

function ItemMeta({ item, comments }: { item: SummaryItem; comments: DiscussionComment[] }) {
  if (item.sourceType === 'paper-evidence' && item.annotation) return <span className="summary-source">第 {item.annotation.page} 页「{item.annotation.quote}」</span>
  if (item.sourceType === 'member-opinion' && item.commentIds?.length) {
    const names = [...new Set(item.commentIds.map(id => comments.find(comment => comment.id === id)?.author.name).filter((name): name is string => Boolean(name)))]
    return <span className="summary-source">{names.length ? `${names.join('、')} 的发言` : '引用的发言已删除'}</span>
  }
  if (item.sourceType === 'ai-inference') return <span className="summary-source">由 AI 基于上述信息归纳，请人工核对</span>
  return null
}

export function SummaryView({ summary, comments, warnings }: { summary: SummarySections; comments: DiscussionComment[]; warnings?: string[] }) {
  const hasContent = summary.overview || SECTION_LABELS.some(([key]) => summary[key].length)
  if (!hasContent) return <div className="saved-empty">总结为空。</div>
  return <div className="summary-view">
    {summary.overview && <p className="summary-overview">{summary.overview}</p>}
    {SECTION_LABELS.map(([key, label]) => summary[key].length ? <section className="summary-section" key={key}><h3>{label}</h3><ul>{summary[key].map((item, index) => <li key={`${key}-${index}`}><span className={`summary-badge summary-badge--${item.sourceType}`}>{SOURCE_LABELS[item.sourceType]}</span><p>{item.text}</p><ItemMeta item={item} comments={comments} /></li>)}</ul></section> : null)}
    {warnings && warnings.length > 0 && <div className="summary-warnings" role="status"><strong>来源核验提示</strong><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
  </div>
}
