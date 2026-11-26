import http from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import express from 'express'
import session from 'express-session'
import connectSqlite from 'connect-sqlite3'
import connectPg from 'connect-pg-simple'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import multer from 'multer'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { openDatabase, migrateDatabase, migrationStatus, postgresConnection } from './database.mjs'
import { readServerConfig } from './config.mjs'
import { installHttpSecurity, logEvent } from './http-security.mjs'
import { createObjectStorage } from './object-storage.mjs'
import { registerKnowledge } from './knowledge.mjs'
import { handleAi } from './ai-server.mjs'
import { ProviderError, readProviderConfig, requestChatCompletion } from './openai-provider.mjs'

const env = process.env
const config = readServerConfig(env)
const { port, host, production } = config
const secret = env.SESSION_SECRET || randomBytes(48).toString('hex')
if (!env.SESSION_SECRET) console.log('未配置 SESSION_SECRET：本地开发会话将在服务重启后失效。')
const { db, dataDir, isPostgres } = await openDatabase(env)
if (!isPostgres) await migrateDatabase(db)
else if ((await migrationStatus(db)).pending.length) throw new Error('请先运行数据库迁移。')
const storage = await createObjectStorage(dataDir, env)
const PgStore = connectPg(session)
const SqliteStore = connectSqlite(session)
const pgPool = isPostgres ? new pg.Pool({ ...postgresConnection(env), max: 5 }) : null
pgPool?.on('error', () => logEvent('session_database_unavailable'))
const store = isPostgres ? new PgStore({ pool: pgPool, createTableIfMissing: false, errorLog: () => logEvent('session_store_unavailable') }) : new SqliteStore({ db: 'sessions.sqlite', dir: dataDir, concurrentDB: true })
store.on('error', () => logEvent('session_store_unavailable'))
const app = express()
let draining = false
installHttpSecurity(app, config)
app.get('/health/live', (req, res) => res.status(draining ? 503 : 200).json({ status: draining ? 'draining' : 'live' }))
app.get(['/health/ready', '/api/health'], async (req, res) => {
  if (draining) return res.status(503).json({ status: 'not_ready' })
  try {
    await Promise.all([db.raw('select 1').timeout(3000), pgPool?.query({ text: 'select 1 from session limit 0', query_timeout: 3000 }), storage.check()])
    return res.json({ status: 'ready' })
  } catch {
    logEvent('readiness_failed', { requestId: req.requestId })
    return res.status(503).json({ status: 'not_ready', requestId: req.requestId })
  }
})
app.use((req, res, next) => draining ? res.status(503).json({ error: '服务正在重启，请稍后重试。' }) : next())
app.use(session({ name: 'paperflow.sid', secret, store, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 7 * 24 * 60 * 60 * 1000 } }))
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/ai/')) return next()
  if (production && req.method !== 'GET' && !req.session.userId) return res.status(401).json({ error: '请先登录。' })
  return handleAi(req, res)
})
app.use(express.json({ limit: '32kb' }))
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: '登录或注册请求过多，请稍后再试。' } })
const authInput = z.object({ email: z.string().trim().email().max(254), password: z.string().min(10).max(72), name: z.string().trim().min(1).max(120).optional() })
const uuid = z.string().uuid()
const metadataInput = z.object({ title: z.string().trim().min(1).max(300), authors: z.string().max(300), abstract: z.string().max(10000), year: z.string().regex(/^(|\d{4})$/), venue: z.string().max(200), doi: z.string().max(200) })
const rect = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).refine(value => value.x + value.width <= 1.001 && value.y + value.height <= 1.001)
const annotationInput = z.object({ id: uuid, page: z.number().int().positive(), text: z.string().trim().min(1).max(10000), rects: z.array(rect).min(1).max(100), workspaceId: uuid.nullable().optional() })
const noteInput = z.object({ id: uuid, content: z.string().max(10000) })
const commentInput = z.object({ content: z.string().trim().min(1).max(4000), parentId: uuid.optional(), annotationId: uuid.optional(), workspaceId: uuid.nullable().optional() })
const summaryItemInput = z.object({ text: z.string().trim().min(1).max(800), sourceType: z.enum(['paper-evidence', 'member-opinion', 'ai-inference']), commentIds: z.array(uuid).max(20).optional(), annotationId: uuid.optional(), quote: z.string().trim().min(1).max(600).optional(), annotation: z.object({ id: uuid, page: z.number().int().positive(), quote: z.string().trim().min(1).max(600) }).optional() })
const summarySectionsInput = z.object({ overview: z.string().trim().max(2000).optional(), researchQuestions: z.array(summaryItemInput).max(10), keyPoints: z.array(summaryItemInput).max(15), disagreements: z.array(summaryItemInput).max(10), consensus: z.array(summaryItemInput).max(10), openQuestions: z.array(summaryItemInput).max(10) })
const summarySaveInput = z.object({ model: z.string().trim().max(120).optional(), summary: summarySectionsInput })
const summarySectionKeys = ['researchQuestions', 'keyPoints', 'disagreements', 'consensus', 'openQuestions']
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 1, fieldSize: 8192 } })
const now = () => new Date().toISOString()
const safeUser = row => ({ id: row.id, name: row.name, email: row.email })
const regenerate = req => new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()))
const saveSession = req => new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()))
const destroySession = req => new Promise((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()))
const requireAuth = (req, res, next) => req.session.userId ? next() : res.status(401).json({ error: '请先登录。' })

async function setLogin(req, user) {
  await regenerate(req)
  req.session.userId = user.id
  await saveSession(req)
}

app.post('/api/auth/register', authLimit, async (req, res) => {
  const input = authInput.safeParse(req.body)
  if (!input.success || !input.data.name || bcrypt.truncates(input.data.password)) return res.status(400).json({ error: '请输入有效邮箱、名称及 10–72 字节密码。' })
  const email = input.data.email.toLowerCase()
  const user = { id: randomUUID(), email, name: input.data.name, password_hash: await bcrypt.hash(input.data.password, 12), created_at: now() }
  try { await db('users').insert(user) } catch (error) {
    if (['SQLITE_CONSTRAINT', '23505'].some(code => String(error.code || '').startsWith(code))) return res.status(409).json({ error: '无法注册该账号，请检查邮箱或登录。' })
    throw error
  }
  await setLogin(req, user)
  return res.status(201).json({ user: safeUser(user) })
})
app.post('/api/auth/login', authLimit, async (req, res) => {
  const input = authInput.safeParse(req.body)
  if (!input.success || bcrypt.truncates(input.data.password)) return res.status(400).json({ error: '请输入有效邮箱及密码。' })
  const user = await db('users').where({ email: input.data.email.toLowerCase() }).first()
  const matches = await bcrypt.compare(input.data.password, user?.password_hash || '$2b$12$C6UzMDM.H6dfI/f/IKcEe.4yQj9MW4Z5L2bwavZgfpR9y9j6V6GTW')
  if (!user || !matches) return res.status(401).json({ error: '邮箱或密码不正确。' })
  await setLogin(req, user)
  return res.json({ user: safeUser(user) })
})
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await db('users').where({ id: req.session.userId }).first()
  if (!user) { await destroySession(req); return res.status(401).json({ error: '会话已失效。' }) }
  return res.json({ user: safeUser(user) })
})
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  await destroySession(req)
  res.clearCookie('paperflow.sid', { httpOnly: true, sameSite: 'lax', secure: production })
  return res.status(204).end()
})
app.patch('/api/auth/me', requireAuth, async (req, res) => {
  const input = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(req.body)
  if (!input.success) return res.status(400).json({ error: '账号名称不合法。' })
  await db('users').where({ id: req.session.userId }).update({ name: input.data.name })
  const user = await db('users').where({ id: req.session.userId }).first()
  return res.json({ user: safeUser(user) })
})
const workspaceMember = (workspaceId, userId) => uuid.safeParse(workspaceId).success ? db('workspace_members').where({ workspace_id: workspaceId, user_id: userId }).first() : Promise.resolve(null)
async function workspaceMembersJson(workspaceId, includeEmail) {
  const rows = await db('workspace_members').join('users', 'users.id', 'workspace_members.user_id').where('workspace_members.workspace_id', workspaceId).orderBy('workspace_members.created_at').select('workspace_members.user_id', 'workspace_members.role', 'workspace_members.created_at', 'users.name', 'users.email')
  return rows.map(row => ({ id: row.user_id, name: row.name, role: row.role, joinedAt: row.created_at, ...(includeEmail ? { email: row.email } : {}) }))
}
async function workspaceSummary(workspaceId, userId) {
  const membership = await workspaceMember(workspaceId, userId)
  if (!membership) return null
  const workspace = await db('workspaces').where({ id: workspaceId }).first()
  if (!workspace) return null
  const count = await db('workspace_members').where({ workspace_id: workspaceId }).count({ value: 'user_id' }).first()
  const counts = await Promise.all(['workspace_papers', 'annotations', 'comments', 'knowledge_cards'].map(table => db(table).where({ workspace_id: workspaceId }).modify(query => {
    if (table !== 'workspace_papers') query.where(function () { this.whereNull(`${table}.paper_id`).orWhereExists(function () { this.select(db.raw('1')).from('workspace_papers').where('workspace_papers.workspace_id', workspaceId).whereRaw(`workspace_papers.paper_id = ${table}.paper_id`) }) })
  }).count({ value: '*' }).first()))
  return { id: workspace.id, name: workspace.name, description: workspace.description, ownerId: workspace.owner_id, role: membership.role, createdAt: workspace.created_at, memberCount: Number(count?.value ?? 0), stats: Object.fromEntries(['papers', 'annotations', 'comments', 'knowledge'].map((key, index) => [key, Number(counts[index].value)])) }
}
app.post('/api/workspaces', requireAuth, async (req, res) => {
  const input = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(2000).default('') }).safeParse(req.body)
  if (!input.success) return res.status(400).json({ error: '空间名称或简介不合法。' })
  const workspace = { id: randomUUID(), ...input.data, owner_id: req.session.userId, created_at: now() }
  await db.transaction(async tx => { await tx('workspaces').insert(workspace); await tx('workspace_members').insert({ workspace_id: workspace.id, user_id: req.session.userId, role: 'owner', created_at: now() }) })
  return res.status(201).json(await workspaceSummary(workspace.id, req.session.userId))
})
app.get('/api/workspaces', requireAuth, async (req, res) => {
  const memberships = await db('workspace_members').where({ user_id: req.session.userId }).select('workspace_id', 'role')
  if (!memberships.length) return res.json([])
  const ids = memberships.map(row => row.workspace_id)
  const rows = await db('workspaces').whereIn('id', ids).select('id', 'name', 'description', 'owner_id', 'created_at')
  const counts = await db('workspace_members').whereIn('workspace_id', ids).groupBy('workspace_id').select('workspace_id').count({ value: 'user_id' })
  const roleMap = new Map(memberships.map(row => [row.workspace_id, row.role]))
  const countMap = new Map(counts.map(row => [row.workspace_id, Number(row.value)]))
  return res.json(rows.map(row => ({ id: row.id, name: row.name, description: row.description, ownerId: row.owner_id, role: roleMap.get(row.id), createdAt: row.created_at, memberCount: countMap.get(row.id) ?? 0 })))
})
const inviteLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, message: { error: '加入尝试过多，请稍后重试。' } })
app.post('/api/workspaces/join', requireAuth, inviteLimit, async (req, res) => {
  const input = z.object({ code: z.string().regex(/^[a-f0-9]{32}$/) }).safeParse(req.body)
  if (!input.success) return res.status(400).json({ error: '邀请码格式不正确。' })
  const tokenHash = createHash('sha256').update(input.data.code).digest('hex')
  const invite = await db('workspace_invites').where({ token_hash: tokenHash }).where('expires_at', '>', now()).first()
  if (!invite) return res.status(404).json({ error: '邀请码无效或已过期。' })
  await db('workspace_members').insert({ workspace_id: invite.workspace_id, user_id: req.session.userId, role: 'member', created_at: now() }).onConflict(['workspace_id', 'user_id']).ignore()
  return res.json(await workspaceSummary(invite.workspace_id, req.session.userId))
})
app.post('/api/workspaces/:id/invite-code', requireAuth, async (req, res) => {
  const membership = await workspaceMember(req.params.id, req.session.userId)
  if (!membership) return res.status(404).json({ error: '空间不存在或无权访问。' })
  if (membership.role !== 'owner') return res.status(403).json({ error: '只有所有者可以生成邀请码。' })
  const code = randomBytes(16).toString('hex')
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  await db('workspace_invites').insert({ workspace_id: req.params.id, token_hash: createHash('sha256').update(code).digest('hex'), expires_at: expiresAt }).onConflict('workspace_id').merge()
  return res.status(201).json({ code, expiresAt })
})
app.delete('/api/workspaces/:id/invite-code', requireAuth, async (req, res) => {
  const membership = await workspaceMember(req.params.id, req.session.userId)
  if (!membership || membership.role !== 'owner') return res.status(404).json({ error: '空间不存在或无权管理。' })
  await db('workspace_invites').where({ workspace_id: req.params.id }).delete()
  return res.status(204).end()
})
app.get('/api/workspaces/:id', requireAuth, async (req, res) => {
  const summary = await workspaceSummary(req.params.id, req.session.userId)
  if (!summary) return res.status(404).json({ error: '空间不存在或无权访问。' })
  return res.json({ ...summary, members: await workspaceMembersJson(summary.id, summary.role === 'owner') })
})
app.get('/api/workspaces/:id/members', requireAuth, async (req, res) => {
  const membership = await workspaceMember(req.params.id, req.session.userId)
  if (!membership) return res.status(404).json({ error: '空间不存在或无权访问。' })
  return res.json(await workspaceMembersJson(req.params.id, membership.role === 'owner'))
})
app.patch('/api/workspaces/:id', requireAuth, async (req, res) => {
  const membership = await workspaceMember(req.params.id, req.session.userId)
  if (!membership || membership.role !== 'owner') return res.status(404).json({ error: '空间不存在或无权管理。' })
  const input = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(2000).default('') }).safeParse(req.body)
  if (!input.success) return res.status(400).json({ error: '空间名称或简介不合法。' })
  await db('workspaces').where({ id: req.params.id }).update(input.data)
  return res.json({ id: req.params.id, ...input.data })
})
app.post('/api/workspaces/:id/members', requireAuth, async (req, res) => {
  const membership = await workspaceMember(req.params.id, req.session.userId)
  if (!membership || membership.role !== 'owner') return res.status(404).json({ error: '空间不存在或无权管理。' })
  const input = z.union([z.object({ email: z.string().trim().email().max(254) }), z.object({ userId: uuid })]).safeParse(req.body)
  if (!input.success) return res.status(400).json({ error: '请填写已注册账号的邮箱或标识。' })
  const user = 'email' in input.data ? await db('users').where({ email: input.data.email.toLowerCase() }).first() : await db('users').where({ id: input.data.userId }).first()
  if (!user) return res.status(404).json({ error: '成员账号不存在，请确认该邮箱已注册。' })
  const existing = await db('workspace_members').where({ workspace_id: req.params.id, user_id: user.id }).first()
  if (existing) return res.status(409).json({ error: '该用户已是成员。' })
  const joinedAt = now()
  await db('workspace_members').insert({ workspace_id: req.params.id, user_id: user.id, role: 'member', created_at: joinedAt })
  return res.status(201).json({ id: user.id, name: user.name, role: 'member', joinedAt })
})
app.delete('/api/workspaces/:id/members/:userId', requireAuth, async (req, res) => {
  const membership = await workspaceMember(req.params.id, req.session.userId)
  if (!membership || membership.role !== 'owner') return res.status(404).json({ error: '空间不存在或无权管理。' })
  if (!uuid.safeParse(req.params.userId).success) return res.status(400).json({ error: '成员标识不合法。' })
  const target = await workspaceMember(req.params.id, req.params.userId)
  if (!target) return res.status(404).json({ error: '成员不存在。' })
  if (target.role === 'owner') return res.status(400).json({ error: '不能移除空间所有者。' })
  await db('workspace_members').where({ workspace_id: req.params.id, user_id: req.params.userId }).delete()
  return res.status(204).end()
})
app.post('/api/workspaces/:id/leave', requireAuth, async (req, res) => {
  const membership = await workspaceMember(req.params.id, req.session.userId)
  if (!membership) return res.status(404).json({ error: '空间不存在或无权访问。' })
  if (membership.role === 'owner') return res.status(400).json({ error: '空间所有者不能退出空间。' })
  await db('workspace_members').where({ workspace_id: req.params.id, user_id: req.session.userId }).delete()
  return res.status(204).end()
})

const paperShareIds = async (paperId, userId) => (await db('workspace_papers').join('workspace_members', 'workspace_members.workspace_id', 'workspace_papers.workspace_id').where({ paper_id: paperId, user_id: userId }).select('workspace_papers.workspace_id')).map(row => row.workspace_id)
async function memberContexts(paper, userId) {
  const rows = await db('workspace_papers').join('workspace_members', 'workspace_members.workspace_id', 'workspace_papers.workspace_id').where('workspace_papers.paper_id', paper.id).andWhere('workspace_members.user_id', userId).select('workspace_papers.workspace_id', 'workspace_members.role')
  return rows.map(row => ({ workspaceId: row.workspace_id, role: row.role }))
}
async function accessPaper(id, userId) {
  if (!uuid.safeParse(id).success) return null
  const paper = await db('papers').where({ id }).first()
  if (!paper) return null
  const owner = paper.owner_id === userId
  const contexts = await memberContexts(paper, userId)
  if (!owner && !contexts.length) return null
  return { paper, owner, manager: owner || contexts.some(context => context.role === 'owner'), contexts }
}
async function resolveContext(access, userId, rawWorkspaceId) {
  if (rawWorkspaceId !== undefined && rawWorkspaceId !== null && rawWorkspaceId !== '') {
    if (typeof rawWorkspaceId !== 'string' || !uuid.safeParse(rawWorkspaceId).success) return { error: 400, message: '团队空间标识不合法。' }
    const found = access.contexts.find(context => context.workspaceId === rawWorkspaceId)
    if (!found) return { error: 404, message: '空间不存在或无权访问。' }
    return { workspaceId: rawWorkspaceId, role: found.role }
  }
  return { workspaceId: null, role: 'member' }
}
async function accessAnnotation(annotation, userId) {
  const access = await accessPaper(annotation.paper_id, userId)
  if (!access) return null
  if (annotation.workspace_id) {
    const context = access.contexts.find(item => item.workspaceId === annotation.workspace_id)
    if (!context) return null
    return { access, workspaceId: annotation.workspace_id, manager: access.owner || context.role === 'owner' }
  }
  if (annotation.user_id !== userId) return null
  return { access, workspaceId: null, manager: true }
}
function paperJson(row, workspaceIds = []) {
  return { id: row.id, ownerId: row.owner_id, workspaceId: workspaceIds.includes(row.workspace_id) ? row.workspace_id : null, workspaceIds, fileKey: row.id, fileName: row.file_name, fileSize: row.file_size, pageCount: row.page_count, title: row.title, authors: row.authors, abstract: row.abstract, year: row.year, venue: row.venue, doi: row.doi, createdAt: row.created_at, updatedAt: row.updated_at }
}
function progressJson(paperId, userId, row) {
  return { paperId, userId, lastPage: row?.last_page ?? 1, status: row?.status ?? 'unread', updatedAt: row?.updated_at ?? '' }
}
function annotationJson(row, workspaceId) {
  return { id: row.id, paperId: row.paper_id, userId: row.user_id, workspaceId, page: row.page, text: row.text, rects: typeof row.rects === 'string' ? JSON.parse(row.rects) : row.rects, createdAt: row.created_at }
}
function noteJson(row, workspaceId) {
  return { id: row.id, paperId: row.paper_id, annotationId: row.annotation_id, authorId: row.author_id, workspaceId, content: row.content, updatedAt: row.updated_at }
}
function commentJson(row, canDelete) {
  return { id: row.id, paperId: row.paper_id, parentId: row.parent_id ?? null, annotationId: row.annotation_id ?? null, workspaceId: row.workspace_id ?? null, content: row.content, createdAt: row.created_at, author: { id: row.author_id, name: row.author_name ?? '未知用户' }, canDelete }
}
async function commentAuthz(comment, userId) {
  const access = await accessPaper(comment.paper_id, userId)
  if (!access) return null
  if (comment.workspace_id) {
    const context = access.contexts.find(item => item.workspaceId === comment.workspace_id)
    if (!context) return null
    return { access, manager: access.owner || context.role === 'owner' }
  }
  return comment.author_id === userId ? { access, manager: true } : null
}
async function discussionContext(req) {
  const access = await accessPaper(req.params.id, req.session.userId)
  if (!access) return { error: 404, message: '文献不存在或无权访问。' }
  const context = await resolveContext(access, req.session.userId, req.query.workspaceId ?? req.body?.workspaceId)
  if (context.error) return { error: context.error, message: context.message }
  if (!context.workspaceId) return { error: 400, message: '讨论总结仅支持团队空间。' }
  return { access, workspaceId: context.workspaceId, role: context.role }
}
function buildDiscussionPrompt(paper, comments, annotations) {
  let budget = 12000
  const names = new Map(comments.map(row => [row.id, row.author_name ?? '成员']))
  const transcript = []
  for (const row of comments.slice(-80)) {
    const body = row.content.slice(0, 1200)
    if (budget - body.length < 0) break
    budget -= body.length
    transcript.push({ id: row.id, author: row.author_name ?? '成员', replyTo: row.parent_id ? names.get(row.parent_id) ?? '成员' : null, content: body })
  }
  const annotationList = annotations.slice(0, 40).map(row => ({ id: row.id, page: row.page, quote: row.text.replace(/\s+/g, ' ').slice(0, 400) }))
  return JSON.stringify({ paper: { title: paper.title, authors: paper.authors, year: paper.year }, annotations: annotationList, discussion: transcript })
}
function normalizeSummary(input, comments, annotations) {
  const commentIds = new Set(comments.map(row => row.id))
  const annotationMap = new Map(annotations.map(row => [row.id, row]))
  const warnings = []
  const sections = {}
  for (const key of summarySectionKeys) {
    sections[key] = []
    for (const item of input[key]) {
      if (item.sourceType === 'paper-evidence') {
        const annotation = item.annotationId ? annotationMap.get(item.annotationId) : null
        const quote = (item.quote ?? '').replace(/\s+/g, ' ').trim()
        const source = annotation ? annotation.text.replace(/\s+/g, ' ').trim() : ''
        if (!annotation || !quote || !source.includes(quote)) { warnings.push(`已移除无法核对的论文证据：${item.text.slice(0, 40)}`); continue }
        sections[key].push({ text: item.text, sourceType: 'paper-evidence', annotation: { id: annotation.id, page: annotation.page, quote } })
      } else if (item.sourceType === 'member-opinion') {
        const cited = item.commentIds ?? []
        const valid = cited.filter(id => commentIds.has(id))
        if (!valid.length) { warnings.push(`已移除未关联成员发言的观点：${item.text.slice(0, 40)}`); continue }
        if (valid.length !== cited.length) warnings.push('一条成员观点引用了不存在的发言，已缩小引用范围。')
        sections[key].push({ text: item.text, sourceType: 'member-opinion', commentIds: valid })
      } else {
        sections[key].push({ text: item.text, sourceType: 'ai-inference' })
      }
    }
  }
  return { summary: { overview: input.overview ?? '', ...sections }, warnings }
}
const providerConfig = readProviderConfig(env)
async function cleanupObjects() {
  const jobs = await db('object_deletions').limit(20)
  for (const job of jobs) {
    try { await storage.delete(job.storage_key); await db('object_deletions').where({ storage_key: job.storage_key }).delete() } catch { logEvent('object_cleanup_pending') }
  }
}
const initialCleanup = cleanupObjects().catch(() => logEvent('object_cleanup_pending'))

app.get('/api/workspaces/:id/papers', requireAuth, async (req, res) => {
  const membership = await workspaceMember(req.params.id, req.session.userId)
  if (!membership) return res.status(404).json({ error: '空间不存在或无权访问。' })
  const rows = await db('workspace_papers').join('papers', 'papers.id', 'workspace_papers.paper_id').where('workspace_papers.workspace_id', req.params.id).orderBy('workspace_papers.created_at', 'desc').select('papers.*', 'workspace_papers.created_at as added_at')
  const ids = rows.map(row => row.id)
  const progress = ids.length ? await db('reading_progress').where({ user_id: req.session.userId }).whereIn('paper_id', ids) : []
  const shares = ids.length ? await db('workspace_papers').join('workspace_members', 'workspace_members.workspace_id', 'workspace_papers.workspace_id').where('workspace_members.user_id', req.session.userId).whereIn('paper_id', ids).select('paper_id', 'workspace_papers.workspace_id') : []
  return res.json(rows.map(row => ({ paper: paperJson(row, shares.filter(share => share.paper_id === row.id).map(share => share.workspace_id)), progress: progressJson(row.id, req.session.userId, progress.find(value => value.paper_id === row.id)), addedAt: row.added_at })))
})
app.post('/api/workspaces/:id/papers', requireAuth, async (req, res) => {
  const membership = await workspaceMember(req.params.id, req.session.userId)
  if (!membership) return res.status(404).json({ error: '空间不存在或无权访问。' })
  const input = z.object({ paperId: uuid }).safeParse(req.body)
  if (!input.success) return res.status(400).json({ error: '文献标识不合法。' })
  const access = await accessPaper(input.data.paperId, req.session.userId)
  if (!access || !access.owner) return res.status(404).json({ error: '文献不存在或无权共享。' })
  const existing = await db('workspace_papers').where({ workspace_id: req.params.id, paper_id: input.data.paperId }).first()
  if (existing) return res.status(409).json({ error: '该文献已在空间中。' })
  const timestamp = now()
  await db('workspace_papers').insert({ workspace_id: req.params.id, paper_id: input.data.paperId, added_by_id: req.session.userId, created_at: timestamp })
  return res.status(201).json({ paper: paperJson(access.paper, await paperShareIds(input.data.paperId, req.session.userId)), addedAt: timestamp })
})
app.delete('/api/workspaces/:id/papers/:paperId', requireAuth, async (req, res) => {
  const membership = await workspaceMember(req.params.id, req.session.userId)
  if (!membership) return res.status(404).json({ error: '空间不存在或无权访问。' })
  if (!uuid.safeParse(req.params.paperId).success) return res.status(400).json({ error: '文献标识不合法。' })
  const link = await db('workspace_papers').where({ workspace_id: req.params.id, paper_id: req.params.paperId }).first()
  if (!link) return res.status(404).json({ error: '该文献不在空间中。' })
  const access = await accessPaper(req.params.paperId, req.session.userId)
  if (!access || (access.paper.owner_id !== req.session.userId && membership.role !== 'owner')) return res.status(403).json({ error: '无权移除该文献。' })
  await db('workspace_papers').where({ workspace_id: req.params.id, paper_id: req.params.paperId }).delete()
  return res.status(204).end()
})

app.use('/api/papers', requireAuth)
app.use('/api/annotations', requireAuth)
app.use('/api/comments', requireAuth)
app.use('/api/summaries', requireAuth)
app.get('/api/papers', async (req, res) => {
  const userId = req.session.userId
  const papers = await db('papers').where(function () {
    this.where('owner_id', userId)
      .orWhereExists(function () { this.select(db.raw('1')).from('workspace_papers').join('workspace_members', 'workspace_members.workspace_id', 'workspace_papers.workspace_id').whereRaw('workspace_papers.paper_id = papers.id').andWhere('workspace_members.user_id', userId) })
  })
  const progress = await db('reading_progress').where({ user_id: userId })
  const shares = papers.length ? await db('workspace_papers').join('workspace_members', 'workspace_members.workspace_id', 'workspace_papers.workspace_id').where('workspace_members.user_id', userId).whereIn('paper_id', papers.map(paper => paper.id)).select('paper_id', 'workspace_papers.workspace_id') : []
  return res.json(papers.map(paper => ({ paper: paperJson(paper, shares.filter(share => share.paper_id === paper.id).map(share => share.workspace_id)), progress: progressJson(paper.id, userId, progress.find(value => value.paper_id === paper.id)) })))
})
app.post('/api/papers', upload.single('file'), async (req, res) => {
  let input
  try { input = JSON.parse(req.body.metadata || '') } catch { return res.status(400).json({ error: '文献数据格式错误。' }) }
  const parsed = z.object({ id: uuid, title: z.string().trim().min(1).max(300), workspaceId: uuid.nullable() }).safeParse(input)
  const file = req.file
  if (!parsed.success || !file || !file.originalname.toLowerCase().endsWith('.pdf') || file.size < 1 || !file.buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return res.status(400).json({ error: '请选择有效且不超过 20 MB 的 PDF。' })
  if (parsed.data.workspaceId) {
    const member = await db('workspace_members').where({ workspace_id: parsed.data.workspaceId, user_id: req.session.userId }).first()
    if (!member) return res.status(404).json({ error: '空间不存在或无权访问。' })
  }
  let pageCount
  const task = getDocument({ data: new Uint8Array(file.buffer), disableFontFace: true, enableXfa: false })
  try { pageCount = (await task.promise).numPages; if (!pageCount) throw new Error('empty') } catch { return res.status(400).json({ error: 'PDF 已损坏、受密码保护或无法解析。' }) } finally { await task.destroy() }
  const key = `${randomUUID()}.pdf`
  const timestamp = now()
  const filename = path.basename(file.originalname.replace(/[\\/]/g, '_')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255)
  const paper = { id: parsed.data.id, owner_id: req.session.userId, workspace_id: parsed.data.workspaceId, storage_key: key, file_name: filename, file_size: file.size, page_count: pageCount, title: parsed.data.title, authors: '', abstract: '', year: '', venue: '', doi: '', created_at: timestamp, updated_at: timestamp }
  await storage.put(key, file.buffer)
  try {
    await db.transaction(async tx => {
      await tx('papers').insert(paper)
      await tx('reading_progress').insert({ paper_id: paper.id, user_id: req.session.userId, last_page: 1, status: 'unread', updated_at: timestamp })
      if (paper.workspace_id) await tx('workspace_papers').insert({ workspace_id: paper.workspace_id, paper_id: paper.id, added_by_id: req.session.userId, created_at: timestamp })
    })
  } catch (error) {
    try { await storage.delete(key) } catch { await db('object_deletions').insert({ storage_key: key, created_at: now() }).onConflict('storage_key').ignore().catch(() => {}) }
    if (['SQLITE_CONSTRAINT', '23505'].some(code => String(error.code || '').startsWith(code))) return res.status(409).json({ error: '文献标识已存在。' })
    throw error
  }
  return res.status(201).json({ paper: paperJson(paper, paper.workspace_id ? [paper.workspace_id] : []), progress: progressJson(paper.id, req.session.userId, { last_page: 1, status: 'unread', updated_at: timestamp }) })
})
app.get('/api/papers/:id', async (req, res) => {
  const access = await accessPaper(req.params.id, req.session.userId)
  if (!access) return res.status(404).json({ error: '文献不存在或无权访问。' })
  const progress = await db('reading_progress').where({ paper_id: access.paper.id, user_id: req.session.userId }).first()
  return res.json({ paper: paperJson(access.paper, await paperShareIds(access.paper.id, req.session.userId)), progress: progressJson(access.paper.id, req.session.userId, progress), owner: access.owner, contexts: access.contexts })
})
app.get('/api/papers/:id/file', async (req, res) => {
  const access = await accessPaper(req.params.id, req.session.userId)
  if (!access) return res.status(404).json({ error: '文献不存在或无权访问。' })
  const file = await storage.get(access.paper.storage_key)
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', 'inline')
  return res.send(file)
})
app.put('/api/papers/:id', async (req, res) => {
  const access = await accessPaper(req.params.id, req.session.userId)
  if (!access) return res.status(404).json({ error: '文献不存在或无权访问。' })
  if (!access.owner) return res.status(403).json({ error: '只有论文所有者可以修改文献信息。' })
  const parsed = metadataInput.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: '文献信息不合法。' })
  await db('papers').where({ id: access.paper.id }).update({ ...parsed.data, updated_at: now() })
  return res.status(204).end()
})
app.delete('/api/papers/:id', async (req, res) => {
  const access = await accessPaper(req.params.id, req.session.userId)
  if (!access) return res.status(404).json({ error: '文献不存在或无权访问。' })
  if (!access.owner) return res.status(403).json({ error: '只有论文所有者可以删除该文献。' })
  await db.transaction(async tx => { await tx('object_deletions').insert({ storage_key: access.paper.storage_key, created_at: now() }).onConflict('storage_key').ignore(); await tx('papers').where({ id: access.paper.id }).delete() })
  await cleanupObjects()
  return res.status(204).end()
})
app.put('/api/papers/:id/progress', async (req, res) => {
  const access = await accessPaper(req.params.id, req.session.userId)
  if (!access) return res.status(404).json({ error: '文献不存在或无权访问。' })
  const input = z.object({ page: z.number().int().positive().optional(), status: z.enum(['unread', 'reading', 'finished']).optional() }).refine(value => value.page !== undefined || value.status !== undefined).safeParse(req.body)
  if (!input.success || (input.data.page && input.data.page > access.paper.page_count)) return res.status(400).json({ error: '阅读进度不合法。' })
  const previous = await db('reading_progress').where({ paper_id: access.paper.id, user_id: req.session.userId }).first()
  const status = input.data.status ?? (input.data.page && (!previous || previous.status === 'unread') ? 'reading' : previous?.status ?? 'unread')
  const row = { paper_id: access.paper.id, user_id: req.session.userId, last_page: input.data.page ?? previous?.last_page ?? 1, status, updated_at: now() }
  await db('reading_progress').insert(row).onConflict(['paper_id', 'user_id']).merge()
  return res.json(progressJson(access.paper.id, req.session.userId, row))
})
app.get('/api/papers/:id/annotations', async (req, res) => {
  const access = await accessPaper(req.params.id, req.session.userId)
  if (!access) return res.status(404).json({ error: '文献不存在或无权访问。' })
  const context = await resolveContext(access, req.session.userId, req.query.workspaceId)
  if (context.error) return res.status(context.error).json({ error: context.message })
  const rows = await db('annotations').join('users', 'users.id', 'annotations.user_id').where({ 'annotations.paper_id': access.paper.id }).modify(query => context.workspaceId ? query.where('annotations.workspace_id', context.workspaceId) : query.whereNull('annotations.workspace_id').where('annotations.user_id', req.session.userId)).orderBy('annotations.created_at').select('annotations.*', 'users.name as author_name')
  return res.json(rows.map(row => ({ ...annotationJson(row, row.workspace_id ?? null), author: { id: row.user_id, name: row.author_name }, canManage: row.user_id === req.session.userId || Boolean(context.workspaceId && (access.owner || context.role === 'owner')) })))
})
app.post('/api/papers/:id/annotations', async (req, res) => {
  const access = await accessPaper(req.params.id, req.session.userId)
  if (!access) return res.status(404).json({ error: '文献不存在或无权访问。' })
  const parsed = annotationInput.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: '高亮数据不合法。' })
  const context = await resolveContext(access, req.session.userId, parsed.data.workspaceId ?? req.query.workspaceId)
  if (context.error) return res.status(context.error).json({ error: context.message })
  if (parsed.data.page > access.paper.page_count) return res.status(400).json({ error: '高亮数据不合法。' })
  const annotation = { id: parsed.data.id, paper_id: access.paper.id, user_id: req.session.userId, workspace_id: context.workspaceId, page: parsed.data.page, text: parsed.data.text, rects: JSON.stringify(parsed.data.rects), created_at: now() }
  await db('annotations').insert(annotation)
  return res.status(201).json(annotationJson(annotation, context.workspaceId))
})
app.post('/api/papers/:id/annotation-note', async (req, res) => {
  const access = await accessPaper(req.params.id, req.session.userId)
  if (!access) return res.status(404).json({ error: '文献不存在或无权访问。' })
  const parsed = z.object({ annotation: annotationInput, note: noteInput }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: '高亮或笔记数据不合法。' })
  const context = await resolveContext(access, req.session.userId, parsed.data.annotation.workspaceId ?? req.query.workspaceId)
  if (context.error) return res.status(context.error).json({ error: context.message })
  if (parsed.data.annotation.page > access.paper.page_count) return res.status(400).json({ error: '高亮或笔记数据不合法。' })
  const value = parsed.data.annotation
  const annotation = { id: value.id, paper_id: access.paper.id, user_id: req.session.userId, workspace_id: context.workspaceId, page: value.page, text: value.text, rects: JSON.stringify(value.rects), created_at: now() }
  const note = { id: parsed.data.note.id, paper_id: access.paper.id, annotation_id: value.id, author_id: req.session.userId, content: parsed.data.note.content, updated_at: now() }
  await db.transaction(async tx => { await tx('annotations').insert(annotation); await tx('notes').insert(note) })
  return res.status(201).json({ annotation: annotationJson(annotation, context.workspaceId), note: noteJson(note, context.workspaceId) })
})
app.delete('/api/annotations/:id', async (req, res) => {
  const annotation = uuid.safeParse(req.params.id).success ? await db('annotations').where({ id: req.params.id }).first() : null
  const authz = annotation && await accessAnnotation(annotation, req.session.userId)
  if (!authz) return res.status(404).json({ error: '高亮不存在或无权访问。' })
  if (annotation.user_id !== req.session.userId && !authz.manager) return res.status(403).json({ error: '无权删除该高亮。' })
  await db('annotations').where({ id: annotation.id }).delete()
  return res.status(204).end()
})
app.get('/api/annotations/:id/note', async (req, res) => {
  const annotation = uuid.safeParse(req.params.id).success ? await db('annotations').where({ id: req.params.id }).first() : null
  const authz = annotation && await accessAnnotation(annotation, req.session.userId)
  if (!authz) return res.status(404).json({ error: '高亮不存在或无权访问。' })
  const note = await db('notes').where({ annotation_id: annotation.id }).first()
  return res.json(note ? noteJson(note, annotation.workspace_id ?? null) : null)
})
app.put('/api/annotations/:id/note', async (req, res) => {
  const annotation = uuid.safeParse(req.params.id).success ? await db('annotations').where({ id: req.params.id }).first() : null
  const authz = annotation && await accessAnnotation(annotation, req.session.userId)
  if (!authz) return res.status(404).json({ error: '高亮不存在或无权访问。' })
  if (annotation.user_id !== req.session.userId && !authz.manager) return res.status(403).json({ error: '无权修改该笔记。' })
  const parsed = noteInput.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: '笔记数据不合法。' })
  const row = { id: parsed.data.id, paper_id: annotation.paper_id, annotation_id: annotation.id, author_id: req.session.userId, content: parsed.data.content, updated_at: now() }
  await db('notes').insert(row).onConflict('annotation_id').merge(['content', 'updated_at'])
  return res.json(noteJson(await db('notes').where({ annotation_id: annotation.id }).first(), annotation.workspace_id ?? null))
})
app.get('/api/papers/:id/comments', async (req, res) => {
  const access = await accessPaper(req.params.id, req.session.userId)
  if (!access) return res.status(404).json({ error: '文献不存在或无权访问。' })
  const context = await resolveContext(access, req.session.userId, req.query.workspaceId)
  if (context.error) return res.status(context.error).json({ error: context.message })
  const rows = await db('comments').leftJoin('users', 'users.id', 'comments.author_id').where('comments.paper_id', access.paper.id).modify(query => context.workspaceId ? query.where('comments.workspace_id', context.workspaceId) : query.whereNull('comments.workspace_id').where('comments.author_id', req.session.userId)).orderBy('comments.created_at').select('comments.*', 'users.name as author_name')
  const moderation = access.owner || context.role === 'owner'
  return res.json(rows.map(row => commentJson(row, row.author_id === req.session.userId || moderation)))
})
app.post('/api/papers/:id/comments', async (req, res) => {
  const access = await accessPaper(req.params.id, req.session.userId)
  if (!access) return res.status(404).json({ error: '文献不存在或无权访问。' })
  const parsed = commentInput.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: '讨论内容不合法。' })
  const context = await resolveContext(access, req.session.userId, parsed.data.workspaceId ?? req.query.workspaceId)
  if (context.error) return res.status(context.error).json({ error: context.message })
  if (parsed.data.parentId) {
    const parent = await db('comments').where({ id: parsed.data.parentId }).first()
    if (!parent || parent.paper_id !== access.paper.id || (parent.workspace_id ?? null) !== (context.workspaceId ?? null) || parent.parent_id || (!context.workspaceId && parent.author_id !== req.session.userId)) return res.status(400).json({ error: '只能回复当前讨论下的主帖。' })
  }
  if (parsed.data.annotationId) {
    const annotation = await db('annotations').where({ id: parsed.data.annotationId }).first()
    if (!annotation || annotation.paper_id !== access.paper.id || (annotation.workspace_id ?? null) !== (context.workspaceId ?? null) || (!context.workspaceId && annotation.user_id !== req.session.userId)) return res.status(400).json({ error: '关联高亮不存在或不属于当前讨论。' })
  }
  const comment = { id: randomUUID(), paper_id: access.paper.id, author_id: req.session.userId, workspace_id: context.workspaceId, parent_id: parsed.data.parentId ?? null, annotation_id: parsed.data.annotationId ?? null, content: parsed.data.content, created_at: now() }
  await db('comments').insert(comment)
  const author = await db('users').where({ id: req.session.userId }).first()
  return res.status(201).json(commentJson({ ...comment, author_name: author.name }, true))
})
app.delete('/api/comments/:id', async (req, res) => {
  const comment = uuid.safeParse(req.params.id).success ? await db('comments').where({ id: req.params.id }).first() : null
  const authz = comment && await commentAuthz(comment, req.session.userId)
  if (!authz) return res.status(404).json({ error: '讨论不存在或无权访问。' })
  if (comment.author_id !== req.session.userId && !authz.manager) return res.status(403).json({ error: '无权删除该讨论。' })
  await db.transaction(async tx => { await tx('comments').where({ parent_id: comment.id }).delete(); await tx('comments').where({ id: comment.id }).delete() })
  return res.status(204).end()
})
app.post('/api/papers/:id/discussion-summary', async (req, res) => {
  const context = await discussionContext(req)
  if (context.error) return res.status(context.error).json({ error: context.message })
  const paper = context.access.paper
  const comments = await db('comments').join('users', 'users.id', 'comments.author_id').where({ 'comments.paper_id': paper.id, 'comments.workspace_id': context.workspaceId }).orderBy('comments.created_at').select('comments.*', 'users.name as author_name')
  if (!comments.length) return res.status(400).json({ error: '当前讨论为空，成员发言后才能生成总结。' })
  if (!providerConfig.configured) return res.status(503).json({ error: '模型未配置：请在服务端配置 AI_BASE_URL、AI_MODEL 与 AI_API_KEY 后再生成总结。', code: 'NOT_CONFIGURED' })
  const annotations = await db('annotations').where({ paper_id: paper.id, workspace_id: context.workspaceId }).orderBy('page')
  const system = ['你是科研团队讨论总结助手。只依据给定的讨论记录和论文高亮证据总结，不得编造事实或引文。', '必须只输出一个 JSON 对象（不要 Markdown 代码块），结构为：{"overview":"一句话概述","researchQuestions":[条目],"keyPoints":[条目],"disagreements":[条目],"consensus":[条目],"openQuestions":[条目]}。', '每个条目形如 {"text":"结论","sourceType":"paper-evidence|member-opinion|ai-inference"}。', 'sourceType 规则：论文中的原文证据必须为 paper-evidence，并提供 annotationId 与 quote（quote 必须逐字来自该高亮的原文）；成员在讨论中的明确观点必须为 member-opinion，并提供 commentIds（讨论记录中的 id）；基于多条信息做出的归纳或判断必须为 ai-inference，不得伪造来源。', '若讨论不足以支持某项结论，请放入 openQuestions 而不是编造答案。'].join('\n')
  let result
  try { result = await requestChatCompletion(providerConfig, { messages: [{ role: 'system', content: system }, { role: 'user', content: buildDiscussionPrompt(paper, comments, annotations) }], maxTokens: 1600, temperature: 0.2 }) }
  catch (error) {
    if (error instanceof ProviderError) return res.status(error.code === 'NOT_CONFIGURED' ? 503 : 502).json({ error: error.message, code: error.code })
    throw error
  }
  let parsed
  try { parsed = JSON.parse(result.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()) } catch { return res.status(502).json({ error: '模型返回的总结不是有效 JSON，请重试。', code: 'INVALID_SUMMARY' }) }
  const validated = summarySectionsInput.safeParse(parsed)
  if (!validated.success) return res.status(502).json({ error: '模型返回的总结结构不完整，请重试。', code: 'INVALID_SUMMARY' })
  const normalized = normalizeSummary(validated.data, comments, annotations)
  return res.json({ workspaceId: context.workspaceId, generatedAt: now(), model: result.model ?? providerConfig.model, discussionCount: comments.length, annotationCount: annotations.length, warnings: normalized.warnings, ...normalized.summary })
})
function summaryJson(row) {
  let summary = null
  try { summary = JSON.parse(row.content) } catch { summary = null }
  return { id: row.id, paperId: row.paper_id, workspaceId: row.workspace_id, model: row.model, createdAt: row.created_at, author: { id: row.author_id, name: row.author_name ?? '未知用户' }, summary }
}
app.get('/api/papers/:id/summaries', async (req, res) => {
  const context = await discussionContext(req)
  if (context.error) return res.status(context.error).json({ error: context.message })
  const rows = await db('discussion_summaries').join('users', 'users.id', 'discussion_summaries.author_id').where({ 'discussion_summaries.paper_id': context.access.paper.id, 'discussion_summaries.workspace_id': context.workspaceId }).orderBy('discussion_summaries.created_at', 'desc').select('discussion_summaries.*', 'users.name as author_name')
  return res.json(rows.map(summaryJson))
})
app.post('/api/papers/:id/summaries', async (req, res) => {
  const context = await discussionContext(req)
  if (context.error) return res.status(context.error).json({ error: context.message })
  const input = summarySaveInput.safeParse(req.body)
  if (!input.success) return res.status(400).json({ error: '总结内容不合法。' })
  const id = randomUUID()
  const timestamp = now()
  await db('discussion_summaries').insert({ id, paper_id: context.access.paper.id, workspace_id: context.workspaceId, author_id: req.session.userId, content: JSON.stringify(input.data.summary), model: input.data.model ?? '', created_at: timestamp })
  const author = await db('users').where({ id: req.session.userId }).first()
  return res.status(201).json(summaryJson({ id, paper_id: context.access.paper.id, workspace_id: context.workspaceId, author_id: req.session.userId, content: JSON.stringify(input.data.summary), model: input.data.model ?? '', created_at: timestamp, author_name: author.name }))
})
app.delete('/api/summaries/:id', async (req, res) => {
  const row = uuid.safeParse(req.params.id).success ? await db('discussion_summaries').where({ id: req.params.id }).first() : null
  if (!row) return res.status(404).json({ error: '总结不存在或无权访问。' })
  const access = await accessPaper(row.paper_id, req.session.userId)
  const context = access?.contexts.find(item => item.workspaceId === row.workspace_id)
  if (!access || !context) return res.status(404).json({ error: '总结不存在或无权访问。' })
  if (row.author_id !== req.session.userId && !access.owner && context.role !== 'owner') return res.status(403).json({ error: '无权删除该总结。' })
  await db('discussion_summaries').where({ id: row.id }).delete()
  return res.status(204).end()
})
registerKnowledge(app, { db, requireAuth, workspaceMember, accessPaper })
app.use((req, res) => res.status(404).json({ error: '接口不存在。', requestId: req.requestId }))
app.use((error, req, res, next) => {
  const invalid = error instanceof multer.MulterError || error.type === 'entity.too.large' || error instanceof SyntaxError
  logEvent(invalid ? 'invalid_request' : 'request_failed', { requestId: req.requestId })
  if (res.headersSent) { res.destroy(); return }
  return res.status(invalid ? 400 : 500).json({ error: invalid ? '请求格式错误或文件超过大小限制。' : '服务暂时不可用，请稍后重试。', requestId: req.requestId })
})

const server = http.createServer({ requestTimeout: 70000, headersTimeout: 15000, keepAliveTimeout: 5000 }, app)
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
console.log(`PaperFlow API listening on ${host}:${port}; database=${isPostgres ? 'postgresql' : 'sqlite'}; storage=${storage.kind}.`)
async function shutdown() {
  if (draining) return
  draining = true
  logEvent('shutdown_started')
  const deadline = setTimeout(() => { server.closeAllConnections(); logEvent('shutdown_timeout'); process.exit(1) }, 15000)
  deadline.unref()
  try {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await initialCleanup
    if (isPostgres) { await store.close(); await pgPool.end() }
    else await new Promise((resolve, reject) => store.db.close(error => error ? reject(error) : resolve()))
    await db.destroy()
    storage.close()
    clearTimeout(deadline)
    logEvent('shutdown_complete')
    process.exit(0)
  } catch { logEvent('shutdown_failed'); process.exit(1) }
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
