import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const uuid = z.string().uuid()
const fields = z.object({ title: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(10000), status: z.enum(['open', 'investigating', 'resolved']) })
const createInput = fields.extend({ kind: z.enum(['question', 'note', 'record']), workspaceId: uuid.nullable(), paperId: uuid.nullable(), annotationId: uuid.nullable(), commentId: uuid.nullable() }).refine(value => (!value.annotationId && !value.commentId && value.kind !== 'question') || value.paperId)

export function registerKnowledge(app, { db, requireAuth, workspaceMember, accessPaper }) {
  const now = () => new Date().toISOString()
  async function scope(workspaceId, userId) {
    if (!workspaceId) return { role: 'personal' }
    return uuid.safeParse(workspaceId).success ? workspaceMember(workspaceId, userId) : null
  }
  async function sources(input, userId) {
    if (!input.paperId) return !input.annotationId && !input.commentId
    const paper = await accessPaper(input.paperId, userId)
    if (!paper || (input.workspaceId && !paper.contexts.some(item => item.workspaceId === input.workspaceId))) return false
    if (input.annotationId) {
      const annotation = await db('annotations').where({ id: input.annotationId, paper_id: input.paperId }).first()
      if (!annotation || (annotation.workspace_id ?? null) !== input.workspaceId || (!input.workspaceId && annotation.user_id !== userId)) return false
    }
    if (input.commentId) {
      const comment = await db('comments').where({ id: input.commentId, paper_id: input.paperId }).first()
      if (!comment || (comment.workspace_id ?? null) !== input.workspaceId || (!input.workspaceId && comment.author_id !== userId)) return false
      if (input.annotationId && comment.annotation_id && comment.annotation_id !== input.annotationId) return false
    }
    return true
  }
  async function access(id, userId) {
    if (!uuid.safeParse(id).success) return null
    const row = await db('knowledge_cards').where({ id }).first()
    if (!row || (!row.workspace_id && row.author_id !== userId)) return null
    const membership = await scope(row.workspace_id, userId)
    if (!membership || !await sources({ paperId: row.paper_id, annotationId: row.annotation_id, commentId: row.comment_id, workspaceId: row.workspace_id }, userId)) return null
    return { row, canManage: row.author_id === userId || membership.role === 'owner' }
  }
  async function serialize(row, userId, canManage) {
    const [author, editor, paper, annotation, comment, contributions] = await Promise.all([
      db('users').where({ id: row.author_id }).first(), db('users').where({ id: row.updated_by_id }).first(),
      row.paper_id ? db('papers').where({ id: row.paper_id }).first() : null,
      row.annotation_id ? db('annotations').where({ id: row.annotation_id }).first() : null,
      row.comment_id ? db('comments').where({ id: row.comment_id }).first() : null,
      db('knowledge_contributions').join('users', 'users.id', 'knowledge_contributions.user_id').where('card_id', row.id).orderBy('knowledge_contributions.created_at').select('knowledge_contributions.*', 'users.name'),
    ])
    return { id: row.id, kind: row.kind, title: row.title, description: row.description, status: row.status, workspaceId: row.workspace_id, paperId: row.paper_id, annotationId: row.annotation_id, commentId: row.comment_id, createdAt: row.created_at, updatedAt: row.updated_at, author: { id: author.id, name: author.name }, updatedBy: { id: editor.id, name: editor.name }, canManage, paperTitle: paper?.title ?? null, source: annotation ? { page: annotation.page, quote: annotation.text } : null, discussion: comment?.content ?? null, contributions: contributions.map(item => ({ id: item.id, author: { id: item.user_id, name: item.name }, action: item.action, createdAt: item.created_at })) }
  }
  app.use('/api/knowledge', requireAuth)
  app.get('/api/knowledge', async (req, res) => {
    const workspaceId = req.query.workspaceId || null
    if (!await scope(workspaceId, req.session.userId)) return res.status(404).json({ error: '知识库不存在或无权访问。' })
    const rows = await db('knowledge_cards').modify(query => workspaceId ? query.where({ workspace_id: workspaceId }) : query.whereNull('workspace_id').where({ author_id: req.session.userId })).orderBy('updated_at', 'desc')
    const result = []
    for (const row of rows) {
      const permission = await access(row.id, req.session.userId)
      if (permission) result.push(await serialize(row, req.session.userId, permission.canManage))
    }
    return res.json(result)
  })
  app.get('/api/knowledge/:id', async (req, res) => {
    const permission = await access(req.params.id, req.session.userId)
    if (!permission) return res.status(404).json({ error: '知识卡片不存在或无权访问。' })
    return res.json(await serialize(permission.row, req.session.userId, permission.canManage))
  })
  app.post('/api/knowledge', async (req, res) => {
    const input = createInput.safeParse(req.body)
    if (!input.success) return res.status(400).json({ error: '请填写标题、内容和有效来源，研究问题须关联论文。' })
    const value = input.data
    if (!await scope(value.workspaceId, req.session.userId)) return res.status(404).json({ error: '知识库不存在或无权访问。' })
    if (!await sources(value, req.session.userId)) return res.status(400).json({ error: '来源不可访问，或与知识卡片的个人/团队范围不一致。' })
    const timestamp = now()
    const row = { id: randomUUID(), kind: value.kind, title: value.title, description: value.description, status: value.status, workspace_id: value.workspaceId, paper_id: value.paperId, annotation_id: value.annotationId, comment_id: value.commentId, author_id: req.session.userId, updated_by_id: req.session.userId, created_at: timestamp, updated_at: timestamp }
    await db.transaction(async tx => {
      await tx('knowledge_cards').insert(row)
      await tx('knowledge_contributions').insert({ id: randomUUID(), card_id: row.id, user_id: req.session.userId, action: 'created', created_at: timestamp })
    })
    return res.status(201).json(await serialize(row, req.session.userId, true))
  })
  app.patch('/api/knowledge/:id', async (req, res) => {
    const permission = await access(req.params.id, req.session.userId)
    if (!permission) return res.status(404).json({ error: '知识卡片不存在或无权访问。' })
    if (!permission.canManage) return res.status(403).json({ error: '只有创建者或团队所有者可以编辑。' })
    const input = fields.strict().safeParse(req.body)
    if (!input.success) return res.status(400).json({ error: '知识卡片内容不合法；来源和所属范围不可修改。' })
    const timestamp = now()
    const updated = { ...input.data, updated_by_id: req.session.userId, updated_at: timestamp }
    await db.transaction(async tx => {
      await tx('knowledge_cards').where({ id: permission.row.id }).update(updated)
      await tx('knowledge_contributions').insert({ id: randomUUID(), card_id: permission.row.id, user_id: req.session.userId, action: input.data.status !== permission.row.status ? 'status-changed' : 'edited', created_at: timestamp })
    })
    return res.json(await serialize({ ...permission.row, ...updated }, req.session.userId, true))
  })
  app.delete('/api/knowledge/:id', async (req, res) => {
    const permission = await access(req.params.id, req.session.userId)
    if (!permission) return res.status(404).json({ error: '知识卡片不存在或无权访问。' })
    if (!permission.canManage) return res.status(403).json({ error: '只有创建者或团队所有者可以删除。' })
    await db('knowledge_cards').where({ id: permission.row.id }).delete()
    return res.status(204).end()
  })
}
