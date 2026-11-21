import type { DemoActivity, DemoPaper } from '../types'

export const demoPapers: DemoPaper[] = [
  {
    id: 'attention',
    title: 'Attention Is All You Need',
    authors: 'Vaswani et al.',
    publication: 'NeurIPS · 2017',
    topic: '深度学习',
    progress: 68,
    updated: '今天',
    cover: 'blue',
  },
  {
    id: 'bert',
    title: 'BERT: Pre-training of Deep Bidirectional Transformers',
    authors: 'Devlin et al.',
    publication: 'NAACL · 2019',
    topic: '自然语言处理',
    progress: 32,
    updated: '昨天',
    cover: 'sand',
  },
  {
    id: 'scaling',
    title: 'Scaling Laws for Neural Language Models',
    authors: 'Kaplan et al.',
    publication: 'arXiv · 2020',
    topic: '大语言模型',
    progress: 12,
    updated: '3 天前',
    cover: 'sage',
  },
]

export const demoActivities: DemoActivity[] = [
  { id: '1', person: '林同学', initials: '林', action: '在论文中添加了批注', target: 'Attention Is All You Need', time: '2 小时前', color: 'blue' },
  { id: '2', person: '陈同学', initials: '陈', action: '分享了一篇新文献', target: 'BERT: Pre-training of Deep...', time: '昨天', color: 'rose' },
  { id: '3', person: '周同学', initials: '周', action: '回复了团队讨论', target: '关于注意力机制的讨论', time: '2 天前', color: 'sage' },
]
