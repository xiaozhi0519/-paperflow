import { LoaderCircle, SearchX } from 'lucide-react'
import type { ReactNode } from 'react'

export function EmptyState({ title, description, icon = <SearchX size={20} /> }: { title: string; description: string; icon?: ReactNode }) {
  return <div className="empty-state"><span className="empty-state__icon">{icon}</span><strong>{title}</strong><p>{description}</p></div>
}

export function LoadingState({ label = '正在加载...' }: { label?: string }) {
  return <div className="loading-state" role="status"><LoaderCircle size={19} className="spin" /><span>{label}</span></div>
}
