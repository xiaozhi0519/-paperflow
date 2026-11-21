import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import net from 'node:net'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import knex from 'knex'

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'paperflow-api-test-'))
const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)) }); server.on('error', reject) })
const origin = 'http://127.0.0.1:5173'
const env = { ...process.env, NODE_ENV: 'development', PAPERFLOW_DATA_DIR: dataDir, DATABASE_URL: '', S3_BUCKET: '', S3_REGION: '', S3_ENDPOINT: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '', AI_API_KEY: '', AI_PORT: String(port), AI_ALLOWED_ORIGINS: origin, SESSION_SECRET: 'isolated-test-session-secret-long-enough' }
const base = `http://127.0.0.1:${port}`
let child
let output = ''
async function start() {
  child = spawn(process.execPath, ['server/server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.on('data', value => { output += value.toString() })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 30000)
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`server exited: ${code}`)) })
    child.stdout.on('data', value => { output += value.toString(); if (output.includes('API listening')) { clearTimeout(timer); resolve() } })
  })
}
async function stop() {
  if (!child || child.exitCode !== null) return
  const current = child
  current.kill()
  await new Promise(resolve => current.once('exit', resolve))
}
async function call(endpoint, { method = 'GET', cookie, body, expected = 200, sendOrigin = true } = {}) {
  const headers = {}
  if (cookie) headers.cookie = cookie
  if (method !== 'GET' && sendOrigin) headers.origin = origin
  if (body && !(body instanceof FormData)) headers['content-type'] = 'application/json'
  const response = await fetch(`${base}${endpoint}`, { method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined })
  const type = response.headers.get('content-type') || ''
  const data = response.status === 204 ? null : type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())
  assert.equal(response.status, expected, `${method} ${endpoint}: ${JSON.stringify(data)}`)
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}
function form(id, bytes, workspaceId = null, name = 'test.pdf') {
  const result = new FormData()
  result.append('metadata', JSON.stringify({ id, title: '测试论文', workspaceId }))
  result.append('file', new Blob([bytes], { type: 'application/pdf' }), name)
  return result
}
try {
  await start()
  const pdf = await readFile('public/paperflow-sample.pdf')
  const a = await call('/api/auth/register', { method: 'POST', body: { name: '账户甲', email: 'alpha@example.test', password: 'Test-password-123' }, expected: 201 })
  const b = await call('/api/auth/register', { method: 'POST', body: { name: '账户乙', email: 'beta@example.test', password: 'Test-password-456' }, expected: 201 })
  const c = await call('/api/auth/register', { method: 'POST', body: { name: '账户丙', email: 'gamma@example.test', password: 'Test-password-789' }, expected: 201 })
  assert.ok(a.cookie && b.cookie && c.cookie)
  await call('/api/auth/login', { method: 'POST', body: { email: 'alpha@example.test', password: 'wrong-password' }, expected: 401 })
  await call('/api/auth/me', { expected: 401 })
  const spoofedHostStatus = await new Promise((resolve, reject) => { http.get(`${base}/api/auth/me`, { headers: { host: 'untrusted.example', cookie: a.cookie } }, response => { response.resume(); resolve(response.statusCode) }).on('error', reject) })
  assert.equal(spoofedHostStatus, 403)
  await call('/api/auth/logout', { method: 'POST', cookie: a.cookie, expected: 403, sendOrigin: false })
  await call('/api/auth/me', { method: 'PATCH', cookie: a.cookie, body: { name: '甲更新' } })
  assert.equal((await call('/api/auth/me', { cookie: a.cookie })).data.user.name, '甲更新')
  const paperId = randomUUID()
  await call('/api/papers', { method: 'POST', cookie: a.cookie, body: form(paperId, pdf), expected: 201 })
  await call('/api/papers', { method: 'POST', cookie: a.cookie, body: form(randomUUID(), Buffer.from('bad')), expected: 400 })
  await call('/api/papers', { method: 'POST', cookie: a.cookie, body: form(randomUUID(), Buffer.alloc(20 * 1024 * 1024 + 1)), expected: 400 })
  assert.deepEqual((await call(`/api/papers/${paperId}/file`, { cookie: a.cookie })).data, pdf)
  assert.equal((await call('/api/papers', { cookie: b.cookie })).data.length, 0)
  await call(`/api/papers/${paperId}`, { cookie: b.cookie, expected: 404 })
  await call(`/api/papers/${paperId}/file`, { cookie: b.cookie, expected: 404 })
  await call(`/api/papers/${paperId}/file`, { expected: 401 })
  await call(`/api/papers/${paperId}/progress`, { method: 'PUT', cookie: a.cookie, body: { page: 3 }, expected: 400 })
  await call(`/api/papers/${paperId}/progress`, { method: 'PUT', cookie: a.cookie, body: { page: 2 } })
  await call(`/api/papers/${paperId}/progress`, { method: 'PUT', cookie: b.cookie, body: { page: 1 }, expected: 404 })
  const annotation = { id: randomUUID(), page: 1, text: 'Research grows through small', rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.03 }] }
  const note = { id: randomUUID(), content: '持久化笔记' }
  await call(`/api/papers/${paperId}/annotation-note`, { method: 'POST', cookie: a.cookie, body: { annotation, note }, expected: 201 })
  await call(`/api/annotations/${annotation.id}/note`, { cookie: b.cookie, expected: 404 })
  const workspace = (await call('/api/workspaces', { method: 'POST', cookie: a.cookie, body: { name: '测试空间' }, expected: 201 })).data
  await call(`/api/workspaces/${workspace.id}/members`, { method: 'POST', cookie: b.cookie, body: { userId: c.data.user.id }, expected: 404 })
  await call(`/api/workspaces/${workspace.id}/members`, { method: 'POST', cookie: a.cookie, body: { userId: b.data.user.id }, expected: 201 })
  const teamPaper = randomUUID()
  await call('/api/papers', { method: 'POST', cookie: c.cookie, body: form(randomUUID(), pdf, workspace.id), expected: 404 })
  await call('/api/papers', { method: 'POST', cookie: a.cookie, body: form(teamPaper, pdf, workspace.id), expected: 201 })
  await call(`/api/papers/${teamPaper}`, { cookie: b.cookie })
  await call(`/api/papers/${teamPaper}`, { cookie: c.cookie, expected: 404 })
  await call(`/api/papers/${teamPaper}`, { method: 'DELETE', cookie: b.cookie, expected: 403 })
  await call(`/api/papers/${teamPaper}/progress`, { method: 'PUT', cookie: b.cookie, body: { page: 2 } })
  assert.equal((await call(`/api/papers/${teamPaper}`, { cookie: a.cookie })).data.progress.lastPage, 1)
  assert.equal((await call(`/api/papers/${teamPaper}`, { cookie: b.cookie })).data.progress.lastPage, 2)
  await call(`/api/workspaces/${workspace.id}/papers`, { method: 'POST', cookie: a.cookie, body: { paperId }, expected: 201 })
  await call(`/api/workspaces/${workspace.id}/papers`, { method: 'POST', cookie: a.cookie, body: { paperId }, expected: 409 })
  await call(`/api/workspaces/${workspace.id}/papers`, { method: 'POST', cookie: b.cookie, body: { paperId }, expected: 404 })
  await call(`/api/workspaces/${workspace.id}/papers`, { method: 'POST', cookie: c.cookie, body: { paperId }, expected: 404 })
  const sharedPapers = (await call(`/api/workspaces/${workspace.id}/papers`, { cookie: b.cookie })).data
  assert.deepEqual(sharedPapers.map(value => value.paper.id).sort(), [paperId, teamPaper].sort())
  assert.deepEqual((await call(`/api/papers/${paperId}/annotations`, { cookie: a.cookie })).data.map(value => value.id), [annotation.id])
  assert.deepEqual((await call(`/api/papers/${paperId}/annotations`, { cookie: b.cookie })).data, [])
  const teamAnnotation = { id: randomUUID(), page: 1, text: 'Team shared highlight', rects: [{ x: 0.1, y: 0.2, width: 0.2, height: 0.03 }], workspaceId: workspace.id }
  await call(`/api/papers/${paperId}/annotations`, { method: 'POST', cookie: a.cookie, body: teamAnnotation, expected: 201 })
  const teamVisible = (await call(`/api/papers/${paperId}/annotations?workspaceId=${workspace.id}`, { cookie: b.cookie })).data
  assert.deepEqual(teamVisible.map(value => value.id), [teamAnnotation.id])
  assert.equal(teamVisible[0].workspaceId, workspace.id)
  assert.deepEqual((await call(`/api/papers/${paperId}/annotations`, { cookie: a.cookie })).data.map(value => value.id), [annotation.id])
  await call(`/api/annotations/${teamAnnotation.id}`, { method: 'DELETE', cookie: b.cookie, expected: 403 })
  const rootComment = (await call(`/api/papers/${paperId}/comments`, { method: 'POST', cookie: b.cookie, body: { content: '乙的团队提问', workspaceId: workspace.id }, expected: 201 })).data
  assert.equal(rootComment.author.id, b.data.user.id)
  assert.equal(rootComment.canDelete, true)
  assert.equal(rootComment.workspaceId, workspace.id)
  await call(`/api/papers/${paperId}/comments`, { method: 'POST', cookie: b.cookie, body: { content: '   ', workspaceId: workspace.id }, expected: 400 })
  await call(`/api/papers/${paperId}/comments`, { method: 'POST', cookie: c.cookie, body: { content: '无权讨论', workspaceId: workspace.id }, expected: 404 })
  await call(`/api/papers/${paperId}/comments`, { method: 'POST', cookie: b.cookie, body: { content: '关联不存在的高亮', annotationId: randomUUID(), workspaceId: workspace.id }, expected: 400 })
  const reply = (await call(`/api/papers/${paperId}/comments`, { method: 'POST', cookie: a.cookie, body: { content: '甲的回复', parentId: rootComment.id, annotationId: teamAnnotation.id, workspaceId: workspace.id }, expected: 201 })).data
  assert.equal(reply.canDelete, true)
  await call(`/api/papers/${paperId}/comments`, { method: 'POST', cookie: a.cookie, body: { content: '不允许二级回复', parentId: reply.id, workspaceId: workspace.id }, expected: 400 })
  const thread = (await call(`/api/papers/${paperId}/comments?workspaceId=${workspace.id}`, { cookie: b.cookie })).data
  assert.deepEqual(thread.map(value => value.id), [rootComment.id, reply.id])
  assert.equal(thread[1].parentId, rootComment.id)
  assert.equal(thread[1].annotationId, teamAnnotation.id)
  assert.deepEqual((await call(`/api/papers/${paperId}/comments`, { cookie: a.cookie })).data, [])
  await call(`/api/papers/${paperId}/comments?workspaceId=${workspace.id}`, { cookie: c.cookie, expected: 404 })
  await call(`/api/papers/${paperId}/discussion-summary`, { method: 'POST', cookie: a.cookie, body: { workspaceId: workspace.id }, expected: 503 })
  await call(`/api/comments/${reply.id}`, { method: 'DELETE', cookie: b.cookie, expected: 403 })
  await call(`/api/comments/${rootComment.id}`, { method: 'DELETE', cookie: c.cookie, expected: 404 })
  await call(`/api/comments/${rootComment.id}`, { method: 'DELETE', cookie: b.cookie, expected: 204 })
  assert.deepEqual((await call(`/api/papers/${paperId}/comments?workspaceId=${workspace.id}`, { cookie: b.cookie })).data, [])
  await call(`/api/papers/${paperId}/discussion-summary`, { method: 'POST', cookie: a.cookie, body: { workspaceId: workspace.id }, expected: 400 })
  const summaryBody = { workspaceId: workspace.id, model: 'test-model', summary: { overview: '讨论概况', researchQuestions: [], keyPoints: [], disagreements: [], consensus: [], openQuestions: [{ text: '补充消融实验', sourceType: 'ai-inference' }] } }
  const savedSummary = (await call(`/api/papers/${paperId}/summaries`, { method: 'POST', cookie: b.cookie, body: summaryBody, expected: 201 })).data
  assert.equal(savedSummary.summary.openQuestions[0].text, '补充消融实验')
  await call(`/api/papers/${paperId}/summaries`, { method: 'POST', cookie: a.cookie, body: { model: 'x', summary: summaryBody.summary }, expected: 400 })
  await call(`/api/papers/${paperId}/summaries`, { method: 'POST', cookie: a.cookie, body: { workspaceId: workspace.id, summary: { overview: 'x' } }, expected: 400 })
  const summaries = (await call(`/api/papers/${paperId}/summaries?workspaceId=${workspace.id}`, { cookie: a.cookie })).data
  assert.deepEqual(summaries.map(value => value.id), [savedSummary.id])
  await call(`/api/summaries/${savedSummary.id}`, { method: 'DELETE', cookie: c.cookie, expected: 404 })
  await call(`/api/summaries/${savedSummary.id}`, { method: 'DELETE', cookie: a.cookie, expected: 204 })
  assert.deepEqual((await call(`/api/papers/${paperId}/summaries?workspaceId=${workspace.id}`, { cookie: b.cookie })).data, [])
  const personalComment = (await call(`/api/papers/${paperId}/comments`, { method: 'POST', cookie: a.cookie, body: { content: '个人笔记式讨论' }, expected: 201 })).data
  assert.equal(personalComment.workspaceId, null)
  const teamCommentOnUploaded = (await call(`/api/papers/${teamPaper}/comments`, { method: 'POST', cookie: a.cookie, body: { content: '上传到空间的讨论', workspaceId: workspace.id }, expected: 201 })).data
  assert.equal((await call(`/api/papers/${teamPaper}/comments?workspaceId=${workspace.id}`, { cookie: b.cookie })).data[0].id, teamCommentOnUploaded.id)
  await call(`/api/workspaces/${workspace.id}`, { method: 'PATCH', cookie: a.cookie, body: { name: '科研协作组', description: '真实数据库团队简介' } })
  assert.equal((await call(`/api/workspaces/${workspace.id}`, { cookie: b.cookie })).data.description, '真实数据库团队简介')
  await call(`/api/workspaces/${workspace.id}/invite-code`, { method: 'POST', cookie: b.cookie, expected: 403 })
  const oldInvite = (await call(`/api/workspaces/${workspace.id}/invite-code`, { method: 'POST', cookie: a.cookie, expected: 201 })).data
  const inviteCode = (await call(`/api/workspaces/${workspace.id}/invite-code`, { method: 'POST', cookie: a.cookie, expected: 201 })).data
  await call('/api/workspaces/join', { method: 'POST', cookie: c.cookie, body: { code: 'invalid' }, expected: 400 })
  await call('/api/workspaces/join', { method: 'POST', cookie: c.cookie, body: { code: oldInvite.code }, expected: 404 })
  await call('/api/workspaces/join', { method: 'POST', cookie: c.cookie, body: { code: inviteCode.code } })
  assert.equal((await call('/api/workspaces/join', { method: 'POST', cookie: a.cookie, body: { code: inviteCode.code } })).data.role, 'owner')
  const privateB = { ...annotation, id: randomUUID(), text: '乙的私有批注' }
  await call(`/api/papers/${paperId}/annotation-note`, { method: 'POST', cookie: b.cookie, body: { annotation: privateB, note: { id: randomUUID(), content: '乙的私有笔记不共享' } }, expected: 201 })
  assert.deepEqual((await call(`/api/papers/${paperId}/annotations`, { cookie: b.cookie })).data.map(value => value.id), [privateB.id])
  await call(`/api/annotations/${privateB.id}/note`, { cookie: a.cookie, expected: 404 })
  await call(`/api/annotations/${privateB.id}/note`, { method: 'PUT', cookie: a.cookie, body: { id: randomUUID(), content: '试图覆盖' }, expected: 404 })
  await call(`/api/annotations/${privateB.id}`, { method: 'DELETE', cookie: a.cookie, expected: 404 })
  await call(`/api/annotations/${teamAnnotation.id}/note`, { method: 'PUT', cookie: b.cookie, body: { id: randomUUID(), content: '越权编辑' }, expected: 403 })
  await call(`/api/annotations/${teamAnnotation.id}/note`, { method: 'PUT', cookie: a.cookie, body: { id: randomUUID(), content: '公开批注补充' } })
  assert.equal((await call(`/api/annotations/${teamAnnotation.id}/note`, { cookie: b.cookie })).data.content, '公开批注补充')
  const memberAnnotation = { ...teamAnnotation, id: randomUUID(), text: '成员公开批注' }
  await call(`/api/papers/${paperId}/annotations`, { method: 'POST', cookie: b.cookie, body: memberAnnotation, expected: 201 })
  const memberNote = { id: randomUUID(), content: '作者编辑自己的批注' }
  await call(`/api/annotations/${memberAnnotation.id}/note`, { method: 'PUT', cookie: b.cookie, body: memberNote })
  await call(`/api/annotations/${memberAnnotation.id}/note`, { method: 'PUT', cookie: c.cookie, body: memberNote, expected: 403 })
  await call(`/api/annotations/${memberAnnotation.id}/note`, { method: 'PUT', cookie: a.cookie, body: { ...memberNote, content: '所有者管理公开批注' } })
  await call(`/api/annotations/${memberAnnotation.id}`, { method: 'DELETE', cookie: c.cookie, expected: 403 })
  await call(`/api/annotations/${memberAnnotation.id}`, { method: 'DELETE', cookie: a.cookie, expected: 204 })
  await call(`/api/annotations/${memberAnnotation.id}/note`, { cookie: b.cookie, expected: 404 })
  const privateCommentB = (await call(`/api/papers/${paperId}/comments`, { method: 'POST', cookie: b.cookie, body: { content: '乙的个人讨论' }, expected: 201 })).data
  assert.ok(!(await call(`/api/papers/${paperId}/comments`, { cookie: a.cookie })).data.some(value => value.id === privateCommentB.id))
  await call(`/api/papers/${paperId}/comments`, { method: 'POST', cookie: a.cookie, body: { content: '越权回复', parentId: privateCommentB.id }, expected: 400 })
  const knowledgeBody = { kind: 'question', title: '可复现性研究问题', description: '人工提出：需要进一步验证。', status: 'open', workspaceId: workspace.id, paperId, annotationId: teamAnnotation.id, commentId: null }
  await call('/api/knowledge', { expected: 401 })
  await call('/api/knowledge', { method: 'POST', cookie: b.cookie, body: { ...knowledgeBody, paperId: null, annotationId: null }, expected: 400 })
  await call('/api/knowledge', { method: 'POST', cookie: b.cookie, body: { ...knowledgeBody, annotationId: privateB.id }, expected: 400 })
  await call('/api/knowledge', { method: 'POST', cookie: b.cookie, body: { ...knowledgeBody, annotationId: null, commentId: privateCommentB.id }, expected: 400 })
  const card = (await call('/api/knowledge', { method: 'POST', cookie: b.cookie, body: knowledgeBody, expected: 201 })).data
  assert.equal(card.author.id, b.data.user.id)
  assert.equal(card.source.page, teamAnnotation.page)
  assert.equal(card.source.quote, teamAnnotation.text)
  assert.equal(card.contributions[0].author.id, b.data.user.id)
  assert.equal((await call(`/api/knowledge/${card.id}`, { cookie: c.cookie })).data.canManage, false)
  const fields = { title: card.title, description: '团队所有者人工整理', status: 'investigating' }
  await call(`/api/knowledge/${card.id}`, { method: 'PATCH', cookie: c.cookie, body: fields, expected: 403 })
  await call(`/api/knowledge/${card.id}`, { method: 'DELETE', cookie: c.cookie, expected: 403 })
  await call(`/api/knowledge/${card.id}`, { method: 'PATCH', cookie: b.cookie, body: { ...fields, workspaceId: null }, expected: 400 })
  const updatedCard = (await call(`/api/knowledge/${card.id}`, { method: 'PATCH', cookie: a.cookie, body: fields })).data
  assert.equal(updatedCard.updatedBy.id, a.data.user.id)
  assert.equal(updatedCard.contributions.length, 2)
  assert.equal(updatedCard.contributions[1].action, 'status-changed')
  const personalCard = (await call('/api/knowledge', { method: 'POST', cookie: b.cookie, body: { ...knowledgeBody, kind: 'note', workspaceId: null, annotationId: privateB.id }, expected: 201 })).data
  await call(`/api/knowledge/${personalCard.id}`, { cookie: a.cookie, expected: 404 })
  await call(`/api/knowledge/${personalCard.id}`, { method: 'PATCH', cookie: a.cookie, body: fields, expected: 404 })
  assert.equal((await call('/api/knowledge', { cookie: a.cookie })).data.length, 0)
  const record = (await call('/api/knowledge', { method: 'POST', cookie: a.cookie, body: { ...knowledgeBody, kind: 'record', paperId: teamPaper, annotationId: null, commentId: teamCommentOnUploaded.id }, expected: 201 })).data
  assert.equal(record.discussion, teamCommentOnUploaded.content)
  const otherTeam = (await call('/api/workspaces', { method: 'POST', cookie: a.cookie, body: { name: '另一个团队' }, expected: 201 })).data
  await call(`/api/workspaces/${otherTeam.id}/papers`, { method: 'POST', cookie: a.cookie, body: { paperId }, expected: 201 })
  assert.deepEqual((await call(`/api/papers/${paperId}`, { cookie: b.cookie })).data.paper.workspaceIds, [workspace.id])
  await call('/api/knowledge', { method: 'POST', cookie: a.cookie, body: { ...knowledgeBody, workspaceId: otherTeam.id }, expected: 400 })
  assert.deepEqual((await call(`/api/workspaces/${workspace.id}`, { cookie: a.cookie })).data.stats, { papers: 2, annotations: 1, comments: 1, knowledge: 2 })
  await call(`/api/workspaces/${workspace.id}/leave`, { method: 'POST', cookie: c.cookie, expected: 204 })
  for (const endpoint of [`/api/workspaces/${workspace.id}`, `/api/knowledge?workspaceId=${workspace.id}`, `/api/knowledge/${card.id}`, `/api/papers/${paperId}/file`, `/api/annotations/${teamAnnotation.id}/note`]) await call(endpoint, { cookie: c.cookie, expected: 404 })
  await call(`/api/knowledge/${card.id}`, { method: 'PATCH', cookie: c.cookie, body: fields, expected: 404 })
  await call(`/api/workspaces/${workspace.id}/invite-code`, { method: 'DELETE', cookie: a.cookie, expected: 204 })
  await call('/api/workspaces/join', { method: 'POST', cookie: c.cookie, body: { code: inviteCode.code }, expected: 404 })
  const expiring = (await call(`/api/workspaces/${workspace.id}/invite-code`, { method: 'POST', cookie: a.cookie, expected: 201 })).data
  const inviteSql = knex({ client: 'sqlite3', connection: { filename: path.join(dataDir, 'paperflow.sqlite') }, useNullAsDefault: true })
  try {
    const row = await inviteSql('workspace_invites').where({ workspace_id: workspace.id }).first()
    assert.notEqual(row.token_hash, expiring.code)
    assert.equal(row.token_hash.length, 64)
    await inviteSql('workspace_invites').where({ workspace_id: workspace.id }).update({ expires_at: '2000-01-01T00:00:00.000Z' })
  } finally { await inviteSql.destroy() }
  await call('/api/workspaces/join', { method: 'POST', cookie: c.cookie, body: { code: expiring.code }, expected: 404 })
  console.log('API 集成（真实 SQLite，无模型）：邀请码轮换/撤销/过期、个人隔离、跨团队来源校验、知识卡片权限/贡献及退出立即失效通过。')
  await call(`/api/workspaces/${workspace.id}/papers/${paperId}`, { method: 'DELETE', cookie: b.cookie, expected: 403 })
  await call(`/api/workspaces/${workspace.id}/papers/${paperId}`, { method: 'DELETE', cookie: a.cookie, expected: 204 })
  await call(`/api/papers/${paperId}`, { cookie: b.cookie, expected: 404 })
  await call(`/api/papers/${paperId}/annotations`, { cookie: b.cookie, expected: 404 })
  await call(`/api/papers/${paperId}/comments`, { cookie: b.cookie, expected: 404 })
  assert.deepEqual((await call('/api/papers', { cookie: b.cookie })).data.map(value => value.paper.id), [teamPaper])
  await call(`/api/knowledge/${card.id}`, { cookie: a.cookie, expected: 404 })
  assert.deepEqual((await call(`/api/knowledge?workspaceId=${workspace.id}`, { cookie: b.cookie })).data.map(value => value.id), [record.id])
  assert.deepEqual((await call(`/api/workspaces/${workspace.id}`, { cookie: a.cookie })).data.stats, { papers: 1, annotations: 0, comments: 1, knowledge: 1 })
  const sql = knex({ client: 'sqlite3', connection: { filename: path.join(dataDir, 'paperflow.sqlite') }, useNullAsDefault: true })
  const userRow = await sql('users').where({ id: a.data.user.id }).first()
  assert.match(userRow.password_hash, /^\$2[aby]\$/)
  assert.notEqual(userRow.password_hash, 'Test-password-123')
  await sql.destroy()
  assert.equal((await readdir(path.join(dataDir, 'pdf'))).length, 2)
  await stop(); output = ''; await start()
  assert.equal((await call('/api/auth/me', { cookie: a.cookie })).data.user.id, a.data.user.id)
  assert.equal((await call(`/api/papers/${paperId}`, { cookie: a.cookie })).data.progress.lastPage, 2)
  assert.equal((await call(`/api/annotations/${annotation.id}/note`, { cookie: a.cookie })).data.content, '持久化笔记')
  assert.equal((await call(`/api/papers/${teamPaper}/comments?workspaceId=${workspace.id}`, { cookie: b.cookie })).data[0].content, '上传到空间的讨论')
  assert.equal((await call(`/api/knowledge/${record.id}`, { cookie: b.cookie })).data.description, knowledgeBody.description)
  await call('/api/auth/logout', { method: 'POST', cookie: a.cookie, expected: 204 })
  await call('/api/auth/me', { cookie: a.cookie, expected: 401 })
  const login = await call('/api/auth/login', { method: 'POST', body: { email: 'alpha@example.test', password: 'Test-password-123' } })
  assert.equal((await call(`/api/papers/${paperId}`, { cookie: login.cookie })).data.paper.id, paperId)
  await call(`/api/papers/${paperId}`, { method: 'DELETE', cookie: login.cookie, expected: 204 })
  await call(`/api/papers/${paperId}`, { cookie: login.cookie, expected: 404 })
  assert.equal((await readdir(path.join(dataDir, 'pdf'))).length, 1)
  const finalSql = knex({ client: 'sqlite3', connection: { filename: path.join(dataDir, 'paperflow.sqlite') }, useNullAsDefault: true })
  try {
    assert.equal((await finalSql('knowledge_cards').whereIn('id', [card.id, personalCard.id])).length, 0)
    assert.equal((await finalSql('knowledge_contributions').where('card_id', card.id)).length, 0)
  } finally { await finalSql.destroy() }
  await call(`/api/knowledge/${record.id}`, { method: 'DELETE', cookie: login.cookie, expected: 204 })
  await call(`/api/knowledge/${record.id}`, { cookie: b.cookie, expected: 404 })
  console.log('真实 SQLite/文件系统：注册、登录、会话重启恢复、PDF、进度、笔记、团队共享、讨论线程、账号隔离、Owner/Member 权限及删除通过。')
} catch (error) {
  console.error(output)
  throw error
} finally {
  await stop()
  await rm(dataDir, { recursive: true, force: true })
}
