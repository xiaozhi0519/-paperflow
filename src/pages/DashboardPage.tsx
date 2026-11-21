import { ArrowRight, ArrowUpRight, BookOpen, BookOpenCheck, ChevronRight, Clock3, FileText, MessageSquareText, Plus, UsersRound } from 'lucide-react'
import { Link, useOutletContext } from 'react-router-dom'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { EmptyState } from '../components/ui/States'
import { PaperCover } from '../features/dashboard/PaperCover'
import type { LayoutContext } from '../layouts/AppLayout'
import { demoActivities, demoPapers } from '../services/demoData'

export function DashboardPage() {
  const { openUpload, query } = useOutletContext<LayoutContext>()
  const filteredPapers = demoPapers.filter(paper => `${paper.title} ${paper.authors} ${paper.topic}`.toLowerCase().includes(query.trim().toLowerCase()))
  const currentPaper = demoPapers[0]

  return <div className="page-wrap dashboard">
    <div className="dashboard-heading">
      <div><div className="eyebrow"><span className="eyebrow-line" /> YOUR RESEARCH SPACE</div><h1>你好，研究者 <span className="heading-sparkle">✳</span></h1><p>每一次阅读，都让新的想法发生。</p></div>
      <Button variant="primary" onClick={openUpload}><Plus size={16} />上传论文</Button>
    </div>

    <div className="demo-notice"><span className="demo-notice__dot" />以下论文、进度和团队动态均为演示数据。PDF 技术验证在本地打开；文献库上传遵循当前存储模式。</div>

    <section className="welcome-panel">
      <div className="welcome-copy"><div className="welcome-overline"><span /> A LITTLE PROGRESS, EVERY DAY</div><h2>好研究，<br />从好阅读开始<span>。</span></h2><p>把灵感留在阅读中，让知识在每一次<br className="desktop-break" />思考与交流里慢慢生长。</p><button className="welcome-link" onClick={openUpload}>开启一篇新阅读 <ArrowRight size={16} /></button></div>
      <div className="continue-panel"><div className="continue-heading"><div><span className="continue-kicker">PICK UP WHERE YOU LEFT OFF</span><h3>继续阅读</h3></div><span className="continue-clock"><Clock3 size={16} /></span></div><div className="continue-content"><PaperCover paper={currentPaper} /><div className="continue-details"><span className="continue-label">最近阅读 · 演示</span><h4>{currentPaper.title}</h4><p>{currentPaper.authors} <span>·</span> {currentPaper.publication}</p><div className="progress-meta"><span>阅读进度</span><strong>{currentPaper.progress}%</strong></div><div className="progress-track"><span style={{ width: `${currentPaper.progress}%` }} /></div></div></div><Link className="continue-action" to="/pdf-lab">打开 PDF 验证示例 <ArrowUpRight size={15} /></Link></div>
      <div className="welcome-decoration welcome-decoration--one" /><div className="welcome-decoration welcome-decoration--two" />
    </section>

    <div className="dashboard-columns">
      <div className="dashboard-primary">
        <div className="section-heading"><div><div className="section-kicker">YOUR LIBRARY</div><h2>最近阅读 <span>{demoPapers.length.toString().padStart(2, '0')}</span></h2></div><Link to="/library" className="section-link">查看文献库 <ArrowRight size={15} /></Link></div>
        <Card className="paper-list-card">
          {filteredPapers.length ? filteredPapers.map(paper => <div className="paper-row" key={paper.id}><PaperCover paper={paper} /><div className="paper-row__body"><div className="paper-row__title">{paper.title}</div><div className="paper-row__meta">{paper.authors} <span>·</span> {paper.publication}</div><div className="paper-row__bottom"><Badge tone="blue">{paper.topic}</Badge><span>阅读 {paper.progress}%</span></div></div><div className="paper-row__aside"><span>{paper.updated}</span><Link to="/pdf-lab" title="打开 PDF 验证示例（不是该论文）" aria-label={`打开 PDF 验证示例，${paper.title} 为演示数据`}><ArrowUpRight size={17} /></Link></div></div>) : <EmptyState title="没有找到演示文献" description="试试其他标题、作者或研究方向。" />}
        </Card>
        <div className="library-footnote"><span><BookOpen size={14} /> 列表仅展示示例，点击将打开独立 PDF 验证文档。</span><span>KEEP EXPLORING <ArrowRight size={12} /></span></div>
      </div>
      <div className="dashboard-secondary">
        <div className="section-heading"><div><div className="section-kicker">BETTER TOGETHER</div><h2>团队空间</h2></div><Link to="/team" className="section-icon-link" aria-label="打开团队空间"><ArrowUpRight size={17} /></Link></div>
        <Card className="team-card"><div className="team-card__top"><span className="team-card__icon"><UsersRound size={19} /></span><Badge tone="green">演示空间</Badge></div><h3>研究小组</h3><p>一起阅读，一起发现更多可能。</p><div className="team-card__bottom"><div className="avatar-stack"><span>林</span><span>陈</span><span>周</span><i>+2</i></div><span>5 位演示成员</span><Link to="/team" aria-label="查看团队空间"><ChevronRight size={17} /></Link></div></Card>
        <div className="section-heading activity-heading"><div><div className="section-kicker">RECENT UPDATES</div><h2>团队动态</h2></div><span className="section-caption">演示</span></div>
        <Card className="activity-card">{demoActivities.map(activity => <div className="activity-item" key={activity.id}><span className={`activity-avatar activity-avatar--${activity.color}`}>{activity.initials}</span><div><p><strong>{activity.person}</strong> {activity.action}</p><span className="activity-target">{activity.target}</span><small>{activity.time}</small></div></div>)}</Card>
      </div>
    </div>
    <div className="quick-strip"><div><span className="quick-strip__icon"><BookOpenCheck size={18} /></span><div><strong>让每一次阅读都有所收获</strong><p>试试 PDF 阅读与选区高亮技术验证。</p></div></div><Link to="/pdf-lab">前往体验 <ArrowRight size={15} /></Link></div>
    <div className="dashboard-footer"><span>© PaperFlow · 研知同行</span><span><FileText size={13} /> 为好奇心而构建 <span className="footer-sep">·</span> <MessageSquareText size={13} /> 演示版本</span></div>
  </div>
}
