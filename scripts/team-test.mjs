import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import net from 'node:net'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'paperflow-team-test-'))
const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)) }); server.on('error', reject) })
const fake = http.createServer(async (req, res) => {
  let raw = ''
  for await (const part of req) raw += part
  assert.equal(req.headers.authorization, 'Bearer team-test-key')
  const body = JSON.parse(raw)
  assert.equal(body.stream, false)
  const input = JSON.parse(body.messages[1].content)
  const annotation = input.annotations[0]
  const root = input.discussion.find(item => !item.replyTo)
  assert.ok(annotation && root)
  const content = JSON.stringify({
    overview: '团队围绕多模态对齐失败原因展开讨论。',
    researchQuestions: [{ text: '多模态对齐的失败案例有哪些？', sourceType: 'member-opinion', commentIds: [root.id] }],
    keyPoints: [
      { text: '缺少失败案例的系统梳理', sourceType: 'member-opinion', commentIds: [root.id] },
      { text: '伪造的论文原文不应保留', sourceType: 'paper-evidence', annotationId: annotation.id, quote: 'This sentence is not in the highlight.' },
      { text: '高亮强调对齐模块是方法核心', sourceType: 'paper-evidence', annotationId: annotation.id, quote: 'alignment module is the core' },
    ],
    disagreements: [{ text: '成员对失败诱因存在分歧', sourceType: 'ai-inference' }],
    consensus: [{ text: '需要补充跨模态噪声消融实验', sourceType: 'ai-inference' }],
    openQuestions: [{ text: '跨模态噪声的来源尚未讨论', sourceType: 'ai-inference' }],
  })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ model: 'stub-summary-model', usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 }, choices: [{ message: { content } }] }))
})
fake.listen(0, '127.0.0.1')
await new Promise(resolve => fake.once('listening', resolve))
const fakePort = fake.address().port
const origin = 'http://127.0.0.1:5173'
const env = { ...process.env, NODE_ENV: 'development', PAPERFLOW_DATA_DIR: dataDir, DATABASE_URL: '', S3_BUCKET: '', S3_REGION: '', S3_ENDPOINT: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '', AI_API_KEY: 'team-test-key', AI_MODEL: 'stub-model', AI_BASE_URL: `http://127.0.0.1:${fakePort}/v1`, AI_PORT: String(port), AI_ALLOWED_ORIGINS: origin, SESSION_SECRET: 'isolated-team-test-session-secret-long-enough' }
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
async function call(endpoint, { method = 'GET', cookie, body, expected = 200 } = {}) {
  const headers = {}
  if (cookie) headers.cookie = cookie
  if (method !== 'GET') headers.origin = origin
  if (body && !(body instanceof FormData)) headers['content-type'] = 'application/json'
  const response = await fetch(`${base}${endpoint}`, { method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined })
  const type = response.headers.get('content-type') || ''
  const data = response.status === 204 ? null : type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())
  assert.equal(response.status, expected, `${method} ${endpoint}: ${JSON.stringify(data)}`)
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}
function form(id, workspaceId = null, title = '讨论总结验收论文') {
  const result = new FormData()
  result.append('metadata', JSON.stringify({ id, title, workspaceId }))
  result.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'summary-fixture.pdf')
  return result
}
const pdfBytes = await readFile('public/paperflow-sample.pdf')
try {
  await start()
  const a = await call('/api/auth/register', { method: 'POST', body: { name: '总结甲', email: 'summary-a@example.test', password: 'Team-password-123' }, expected: 201 })
  const b = await call('/api/auth/register', { method: 'POST', body: { name: '总结乙', email: 'summary-b@example.test', password: 'Team-password-456' }, expected: 201 })
  const c = await call('/api/auth/register', { method: 'POST', body: { name: '总结丙', email: 'summary-c@example.test', password: 'Team-password-789' }, expected: 201 })
  const workspace = (await call('/api/workspaces', { method: 'POST', cookie: a.cookie, body: { name: '总结验收空间' }, expected: 201 })).data
  await call(`/api/workspaces/${workspace.id}/members`, { method: 'POST', cookie: a.cookie, body: { userId: b.data.user.id }, expected: 201 })
  const paperId = randomUUID()
  await call('/api/papers', { method: 'POST', cookie: a.cookie, body: form(paperId, workspace.id), expected: 201 })
  const personalId = randomUUID()
  await call('/api/papers', { method: 'POST', cookie: a.cookie, body: form(personalId, null, '个人总结论文'), expected: 201 })
  const annotation = (await call(`/api/papers/${paperId}/annotations`, { method: 'POST', cookie: b.cookie, body: { id: randomUUID(), page: 1, text: 'In this work the alignment module is the core of the proposed method.', rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.03 }], workspaceId: workspace.id }, expected: 201 })).data
  const root = (await call(`/api/papers/${paperId}/comments`, { method: 'POST', cookie: b.cookie, body: { content: '多模态对齐为什么失败？我们缺少失败案例的系统梳理。', workspaceId: workspace.id }, expected: 201 })).data
  const reply = (await call(`/api/papers/${paperId}/comments`, { method: 'POST', cookie: a.cookie, body: { content: '同意，需要补充跨模态噪声消融实验。', parentId: root.id, annotationId: annotation.id, workspaceId: workspace.id }, expected: 201 })).data
  await call(`/api/papers/${paperId}/discussion-summary`, { method: 'POST', cookie: a.cookie, body: {}, expected: 400 })
  await call(`/api/papers/${personalId}/discussion-summary`, { method: 'POST', cookie: a.cookie, body: {}, expected: 400 })
  await call(`/api/papers/${paperId}/discussion-summary`, { method: 'POST', cookie: c.cookie, body: { workspaceId: workspace.id }, expected: 404 })
  const generated = (await call(`/api/papers/${paperId}/discussion-summary`, { method: 'POST', cookie: b.cookie, body: { workspaceId: workspace.id } })).data
  assert.equal(generated.workspaceId, workspace.id)
  assert.equal(generated.model, 'stub-summary-model')
  assert.equal(generated.discussionCount, 2)
  assert.equal(generated.annotationCount, 1)
  assert.equal(generated.overview, '团队围绕多模态对齐失败原因展开讨论。')
  assert.equal(generated.keyPoints.length, 2)
  assert.equal(generated.keyPoints[0].sourceType, 'member-opinion')
  assert.deepEqual(generated.keyPoints[0].commentIds, [root.id])
  assert.equal(generated.keyPoints[1].sourceType, 'paper-evidence')
  assert.equal(generated.keyPoints[1].annotation.id, annotation.id)
  assert.equal(generated.keyPoints[1].annotation.page, 1)
  assert.equal(generated.keyPoints[1].annotation.quote, 'alignment module is the core')
  assert.equal(generated.warnings.length, 1)
  assert.match(generated.warnings[0], /已移除无法核对的论文证据/)
  assert.deepEqual(generated.researchQuestions[0].commentIds, [root.id])
  assert.equal(generated.openQuestions[0].sourceType, 'ai-inference')
  const summary = { overview: generated.overview, researchQuestions: generated.researchQuestions, keyPoints: generated.keyPoints, disagreements: generated.disagreements, consensus: generated.consensus, openQuestions: generated.openQuestions }
  const savedByB = (await call(`/api/papers/${paperId}/summaries`, { method: 'POST', cookie: b.cookie, body: { workspaceId: workspace.id, model: generated.model, summary }, expected: 201 })).data
  assert.equal(savedByB.summary.keyPoints[1].annotation.quote, 'alignment module is the core')
  assert.equal(savedByB.author.id, b.data.user.id)
  const savedByA = (await call(`/api/papers/${paperId}/summaries`, { method: 'POST', cookie: a.cookie, body: { workspaceId: workspace.id, model: generated.model, summary }, expected: 201 })).data
  await call(`/api/summaries/${savedByA.id}`, { method: 'DELETE', cookie: b.cookie, expected: 403 })
  await call(`/api/summaries/${savedByA.id}`, { method: 'DELETE', cookie: c.cookie, expected: 404 })
  await call(`/api/papers/${paperId}/summaries?workspaceId=${workspace.id}`, { cookie: c.cookie, expected: 404 })
  const list = (await call(`/api/papers/${paperId}/summaries?workspaceId=${workspace.id}`, { cookie: b.cookie })).data
  assert.deepEqual(list.map(item => item.id).sort(), [savedByA.id, savedByB.id].sort())
  await call(`/api/summaries/${savedByA.id}`, { method: 'DELETE', cookie: a.cookie, expected: 204 })
  await stop(); output = ''; await start()
  const afterRestart = (await call(`/api/papers/${paperId}/summaries?workspaceId=${workspace.id}`, { cookie: b.cookie })).data
  assert.deepEqual(afterRestart.map(item => item.id), [savedByB.id])
  assert.equal(afterRestart[0].summary.keyPoints[1].annotation.quote, 'alignment module is the core')
  assert.equal(root.author.id, b.data.user.id)
  assert.equal(reply.parentId, root.id)
  console.log('团队总结（本地假模型服务）：来源校验、伪造证据剔除、成员观点关联、越权与持久化通过。')
} catch (error) {
  console.error(output)
  throw error
} finally {
  await stop()
  fake.close()
  await rm(dataDir, { recursive: true, force: true })
}
