import type { DemoPaper } from '../../types'

export function PaperCover({ paper, large = false }: { paper: DemoPaper; large?: boolean }) {
  return <div className={`paper-cover paper-cover--${paper.cover} ${large ? 'paper-cover--large' : ''}`} aria-hidden="true"><div className="paper-cover__top"><span>RESEARCH PAPER</span><span>↗</span></div><div className="paper-cover__title">{paper.title}</div><div className="paper-cover__lines"><i /><i /><i /></div><div className="paper-cover__bottom">PAPER<span>FLOW.</span></div></div>
}
