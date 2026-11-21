import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const candidates = process.platform === 'win32' ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const executablePath = process.env.CHROME_PATH || candidates.find(existsSync)
if (!executablePath) throw new Error('Set CHROME_PATH to an installed Chromium-compatible browser.')
if (!existsSync('dist/index.html')) throw new Error('请先运行 npm run build，再执行本地导入浏览器测试。')
const webPort = await new Promise((resolve, reject) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)) }); server.on('error', reject) })
const apiPort = await new Promise((resolve, reject) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)) }); server.on('error', reject) })
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'paperflow-import-test-'))
const base = `http://127.0.0.1:${webPort}`
const env = { ...process.env, NODE_ENV: 'development', PAPERFLOW_DATA_DIR: dataDir, DATABASE_URL: '', S3_BUCKET: '', S3_REGION: '', S3_ENDPOINT: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '', AI_API_KEY: '', AI_PORT: String(apiPort), AI_ALLOWED_ORIGINS: base, SESSION_SECRET: 'isolated-import-test-session-secret-long-enough' }
let api
let web
const output = { api: '', web: '' }
function startProcess(command, args, key, ready) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.on('data', value => { output[key] += value.toString() })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${key} startup timeout`)), 45000)
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`${key} exited: ${code}`)) })
    child.stdout.on('data', value => { output[key] += value.toString(); if (ready(output[key])) { clearTimeout(timer); resolve(child) } })
  })
}
async function stop(child) {
  if (!child || child.exitCode !== null) return
  child.kill()
  await new Promise(resolve => child.once('exit', resolve))
}
const browser = await chromium.launch({ executablePath, headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const annotationText = 'The alignment module is the core of the proposed method.'
const noteText = '导入验收笔记：需要核对对齐模块的消融实验。'
try {
  api = await startProcess(process.execPath, ['server/server.mjs'], 'api', text => text.includes('API listening'))
  web = await startProcess(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(webPort), '--strictPort'], 'web', text => /Local:\s+http:\/\/127\.0\.0\.1:\d+/.test(text.replace(/\x1b\[[0-9;]*m/g, '')))
  await page.goto(`${base}/library`, { waitUntil: 'networkidle' })
  await page.locator('input[type=file]').setInputFiles(path.resolve('public/paperflow-sample.pdf'))
  await page.getByRole('status').filter({ hasText: '已保存到本地文献库' }).waitFor({ timeout: 30000 })
  const seeded = await page.evaluate(async ({ annotationText, noteText }) => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('paperflow-library', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const readAll = store => new Promise((resolve, reject) => { const tx = db.transaction([store], 'readonly'); const query = tx.objectStore(store).getAll(); query.onsuccess = () => resolve(query.result); query.onerror = () => reject(query.error) })
    const papers = await readAll('papers')
    const files = await readAll('files')
    const source = papers[0]
    const blob = files.find(item => item.key === source.fileKey)?.blob
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const annotationId = crypto.randomUUID()
    const tx = db.transaction(['papers', 'files', 'progress', 'annotations', 'notes'], 'readwrite')
    tx.objectStore('papers').put({ ...source, id, fileKey: id, title: '导入验收论文（副本）', createdAt: now, updatedAt: now })
    tx.objectStore('files').put({ key: id, blob })
    tx.objectStore('progress').put({ paperId: id, userId: 'local-user', lastPage: 2, status: 'reading', updatedAt: now })
    tx.objectStore('annotations').put({ id: annotationId, paperId: id, userId: 'local-user', workspaceId: null, page: 1, text: annotationText, rects: [{ x: 0.1, y: 0.1, width: 0.25, height: 0.03 }], createdAt: now })
    tx.objectStore('notes').put({ id: crypto.randomUUID(), paperId: id, annotationId, authorId: 'local-user', workspaceId: null, content: noteText, updatedAt: now })
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error) })
    db.close()
    return { paperId: id, annotationId }
  }, { annotationText, noteText })
  await page.getByRole('combobox', { name: '存储模式' }).selectOption('remote')
  await page.getByRole('heading', { name: '登录远程文献库' }).waitFor()
  await page.getByRole('button', { name: '没有账号？注册' }).click()
  await page.getByRole('textbox', { name: '名称' }).fill('导入验收员')
  await page.getByRole('textbox', { name: '邮箱' }).fill(`import-${randomUUID()}@example.test`)
  await page.getByLabel('密码').fill('Import-password-123')
  await page.getByRole('button', { name: '注册并登录' }).click()
  await page.getByText('还没有文献').waitFor()
  await page.goto(`${base}/library/import`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: '导入本地文献' }).waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.import-row').length === 2)
  assert.equal(await page.locator('.import-row').count(), 2)
  const copyRow = page.locator('.import-row').filter({ hasText: '导入验收论文（副本）' })
  const sampleRow = page.locator('.import-row').filter({ hasText: 'paperflow-sample' })
  assert.equal(await copyRow.getByRole('checkbox').isChecked(), true)
  await sampleRow.getByRole('checkbox').uncheck()
  await page.getByText('已选 1 篇').waitFor()
  await page.getByRole('button', { name: '开始导入' }).click()
  await page.getByRole('button', { name: '确认导入' }).click()
  await page.getByRole('status').filter({ hasText: '已导入 1 篇文献、1 个高亮、1 条笔记' }).waitFor({ timeout: 30000 })
  const imported = await page.evaluate(async ({ paperId }) => {
    const list = await (await fetch('/api/papers')).json()
    const item = list.find(value => value.paper.id === paperId)
    const annotations = await (await fetch(`/api/papers/${paperId}/annotations`)).json()
    const note = annotations.length ? await (await fetch(`/api/annotations/${annotations[0].id}/note`)).json() : null
    return { item, annotations, note }
  }, seeded)
  assert.ok(imported.item)
  assert.equal(imported.item.paper.title, '导入验收论文（副本）')
  assert.equal(imported.item.progress.lastPage, 2)
  assert.equal(imported.item.progress.status, 'reading')
  assert.equal(imported.annotations.length, 1)
  assert.equal(imported.annotations[0].text, annotationText)
  assert.equal(imported.note.content, noteText)
  await page.evaluate(async ({ paperId }) => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('paperflow-library', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const readAll = store => new Promise((resolve, reject) => { const tx = db.transaction([store], 'readonly'); const query = tx.objectStore(store).getAll(); query.onsuccess = () => resolve(query.result); query.onerror = () => reject(query.error) })
    const papers = await readAll('papers')
    const files = await readAll('files')
    const source = papers.find(paper => paper.id === paperId)
    const blob = files.find(item => item.key === source.fileKey)?.blob
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const tx = db.transaction(['papers', 'files'], 'readwrite')
    tx.objectStore('papers').put({ ...source, id, fileKey: id, createdAt: now, updatedAt: now })
    tx.objectStore('files').put({ key: id, blob })
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error) })
    db.close()
  }, seeded)
  await page.goto(`${base}/library/import`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: '导入本地文献' }).waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.import-row').length === 3)
  assert.equal(await page.locator('.import-row').count(), 3)
  const importedRow = page.locator('.import-row').filter({ hasText: '已导入' })
  assert.equal(await importedRow.count(), 1)
  assert.equal(await importedRow.getByRole('checkbox').isDisabled(), true)
  const duplicateRow = page.locator('.import-row').filter({ hasText: '标题重复' })
  assert.equal(await duplicateRow.count(), 1)
  assert.equal(await duplicateRow.getByRole('checkbox').isChecked(), false)
  await duplicateRow.getByRole('checkbox').check()
  await page.getByRole('button', { name: '开始导入' }).click()
  await page.getByRole('button', { name: '确认导入' }).click()
  await page.waitForFunction(async title => { const list = await (await fetch('/api/papers')).json(); return list.filter(item => item.paper.title === title).length === 2 }, '导入验收论文（副本）', { timeout: 30000 })
  const preserved = await page.evaluate(async ({ paperId, annotationText, noteText }) => {
    const annotations = await (await fetch(`/api/papers/${paperId}/annotations`)).json()
    const note = annotations.length ? await (await fetch(`/api/annotations/${annotations[0].id}/note`)).json() : null
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('paperflow-library', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const readAll = store => new Promise((resolve, reject) => { const tx = db.transaction([store], 'readonly'); const query = tx.objectStore(store).getAll(); query.onsuccess = () => resolve(query.result); query.onerror = () => reject(query.error) })
    const counts = { papers: (await readAll('papers')).length, files: (await readAll('files')).length, annotations: (await readAll('annotations')).length, notes: (await readAll('notes')).length }
    db.close()
    return { annotations, note, counts, annotationText, noteText }
  }, seeded)
  assert.equal(preserved.annotations.length, 1)
  assert.equal(preserved.annotations[0].text, annotationText)
  assert.equal(preserved.note.content, noteText)
  assert.deepEqual(preserved.counts, { papers: 3, files: 3, annotations: 1, notes: 1 })
  assert.deepEqual(errors, [])
  console.log('真实浏览器本地导入：预览、冲突跳过、同名手动导入、进度/高亮/笔记迁移及本地 IndexedDB 不变通过。')
} catch (error) {
  console.error(output.api)
  console.error(output.web)
  throw error
} finally {
  await browser.close()
  await stop(web)
  await stop(api)
  await rm(dataDir, { recursive: true, force: true })
}
