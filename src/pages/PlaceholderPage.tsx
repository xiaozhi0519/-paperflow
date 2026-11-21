import { Construction } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Card } from '../components/ui/Card'
import { EmptyState } from '../components/ui/States'

export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return <div className="page-wrap"><div className="page-heading"><div><div className="eyebrow">PAPERFLOW WORKSPACE</div><h1>{title}</h1><p>为更好的科研体验，持续构建中。</p></div></div><Card className="placeholder-card"><EmptyState icon={<Construction size={21} />} title="功能尚未开放" description={description} /><Link className="text-link" to="/">返回工作台 →</Link></Card></div>
}
