export interface DemoPaper {
  id: string
  title: string
  authors: string
  publication: string
  topic: string
  progress: number
  updated: string
  cover: 'blue' | 'sand' | 'sage'
}

export interface DemoActivity {
  id: string
  person: string
  initials: string
  action: string
  target: string
  time: string
  color: 'blue' | 'rose' | 'sage'
}

export interface HighlightRect {
  x: number
  y: number
  width: number
  height: number
}

export interface HighlightAnchor {
  id: string
  page: number
  text: string
  rects: HighlightRect[]
}
