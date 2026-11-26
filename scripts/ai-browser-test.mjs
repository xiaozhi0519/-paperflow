import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const candidates = process.platform === 'win32' ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const executablePath = process.env.CHROME_PATH || candidates.find(existsSync)
if (!executablePath) throw new Error('Set CHROME_PATH to an installed Chromium-compatible browser.')
const root = fileURLToPath(new URL('../', import.meta.url))
const baseURL = new URL(process.env.PAPERFLOW_URL || 'http://127.0.0.1:5173').origin
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname), 'Browser mocks must run against a loopback dev server')
const models = ['gpt-6.1-sol', 'glm-5.3-flash']
const mockAnswer = '这是测试桩返回的解释。'
const unexpectedRequests = []
// Register before navigation in EVERY context, including migration and mobile.
// Never fall through to a developer's configured AI or remote library service.
async function installAiMock(target) {
  const state = { configured: false, outcome: 'success', expectedModel: models[0], requests: [] }
  await target.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== baseURL) { unexpectedRequests.push(url.href); await route.abort('blockedbyclient'); return }
    if (url.pathname.endsWith('/ai/status') && request.method() === 'GET') {
      await route.fulfill({ json: { configured: state.configured, model: state.configured ? models[0] : null, models } })
      return
    }
    if (url.pathname.endsWith('/ai/answer') && request.method() === 'POST') {
      assert.equal(state.configured, true, 'An unconfigured status must not issue model requests')
      const body = request.postDataJSON()
      assert.equal(body.model, state.expectedModel)
      assert.ok(models.includes(body.model))
      state.requests.push(body)
      if (state.outcome === 'http-error') { await route.fulfill({ status: 503, json: { error: '模拟模型服务不可用' } }); return }
      if (['explain', 'translate'].includes(body.mode)) assert.ok(body.selection)
      const chunk = body.selection ? body.chunks.find(item => item.text.includes(body.selection)) : body.chunks[0]
      assert.ok(chunk, 'Mock citations must come from the submitted sample evidence')
      const result = { source: 'model', answer: mockAnswer, citations: [{ paperId: body.paperId, pageNumber: chunk.pageNumber, chunkId: chunk.chunkId, quote: body.selection || chunk.text.slice(0, 100) }], provider: { model: body.model, modelStatus: 'valid', usage: null, usageStatus: 'missing' } }
      const events = state.outcome === 'success'
        ? [{ type: 'delta', text: mockAnswer.slice(0, 7) }, { type: 'delta', text: mockAnswer.slice(7) }, { type: 'done', result }]
        : [{ type: 'delta', text: `不可保存的模拟草稿 ${state.outcome}` }, ...(state.outcome === 'stream-error' ? [{ type: 'error', error: '模拟流式生成失败', code: 'UPSTREAM_ERROR' }] : [])]
      await route.fulfill({ contentType: 'application/x-ndjson; charset=utf-8', body: events.map(event => JSON.stringify(event)).join('\n') + '\n' })
      return
    }
    const staticFetch = url.protocol === 'blob:' || /^\/(?:@|src\/|node_modules\/|assets\/)/.test(url.pathname) || url.pathname === '/paperflow-sample.pdf'
    if (request.method() !== 'GET' || /^\/(?:api|functions)(?:\/|$)/.test(url.pathname) || (['fetch', 'xhr'].includes(request.resourceType()) && !staticFetch)) {
      unexpectedRequests.push(`${request.method()} ${url.href}`)
      await route.fulfill({ status: 503, json: { error: 'Unmocked API request blocked by browser test' } })
      return
    }
    await route.continue()
  })
  return state
}
async function storedAnswers(target) {
  return target.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('paperflow-library')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['aiHistory', 'notes', 'annotations'])
      const result = {}
      for (const name of tx.objectStoreNames) {
        const request = tx.objectStore(name).getAll()
        request.onsuccess = () => { result[name] = request.result }
      }
      tx.oncomplete = () => { db.close(); resolve(result) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }))
}
const browser = await chromium.launch({ executablePath, headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
const mock = await installAiMock(context)
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const waitForRender = () => page.waitForFunction(() => !document.querySelector('.pdf-rendering'))
async function dragSelection() {
  const line = page.locator('.textLayer span', { hasText: 'Research grows through small' }).first()
  await line.scrollIntoViewIfNeeded()
  const box = await line.boundingBox()
  assert.ok(box && box.width > 40)
  await page.mouse.move(box.x + 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height / 2, { steps: 10 })
  await page.mouse.up()
  await page.getByRole('toolbar', { name: '选段 AI 操作' }).waitFor()
}
async function chunks() {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('paperflow-library')
    open.onsuccess = () => { const tx = open.result.transaction('chunks'); const request = tx.objectStore('chunks').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) }
    open.onerror = () => reject(open.error)
  }))
}
try {
  const migration = await browser.newContext({ serviceWorkers: 'block' })
  await installAiMock(migration)
  const oldPage = await migration.newPage()
  oldPage.on('pageerror', error => errors.push(error.message))
  await oldPage.goto(`${baseURL}/pdf-lab`, { waitUntil: 'networkidle' })
  await oldPage.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('paperflow-library', 1)
    open.onupgradeneeded = () => {
      const db = open.result
      db.createObjectStore('papers', { keyPath: 'id' })
      db.createObjectStore('files', { keyPath: 'key' })
      db.createObjectStore('progress', { keyPath: 'paperId' })
      db.createObjectStore('annotations', { keyPath: 'id' }).createIndex('paperId', 'paperId')
      db.createObjectStore('notes', { keyPath: 'annotationId' }).createIndex('paperId', 'paperId')
      const tx = open.transaction
      tx.objectStore('papers').add({ id: 'legacy', ownerId: 'local-user', workspaceId: null, fileKey: 'legacy', fileName: 'legacy.pdf', fileSize: 1, pageCount: 1, title: 'Legacy Paper', authors: '', abstract: '', year: '', venue: '', doi: '', createdAt: '2025-01-01', updatedAt: '2025-01-01' })
      tx.objectStore('files').add({ key: 'legacy', blob: new Blob(['x']) })
      tx.objectStore('progress').add({ paperId: 'legacy', userId: 'local-user', lastPage: 1, status: 'reading', updatedAt: '2025-01-01' })
      tx.objectStore('annotations').add({ id: 'a', paperId: 'legacy', userId: 'local-user', workspaceId: null, page: 1, text: 'legacy', rects: [], createdAt: '2025-01-01' })
      tx.objectStore('notes').add({ id: 'n', annotationId: 'a', paperId: 'legacy', authorId: 'local-user', content: 'old note', workspaceId: null, updatedAt: '2025-01-01' })
    }
    open.onsuccess = () => { open.result.close(); resolve() }
    open.onerror = () => reject(open.error)
  }))
  await oldPage.goto(`${baseURL}/library`)
  await oldPage.getByRole('link', { name: 'Legacy Paper' }).waitFor()
  const migrated = await oldPage.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('paperflow-library')
    request.onsuccess = () => { const db = request.result; const tx = db.transaction(['papers', 'files', 'progress', 'annotations', 'notes', 'chunks', 'aiHistory']); Promise.all([...tx.objectStoreNames].map(name => new Promise(done => { const count = tx.objectStore(name).count(); count.onsuccess = () => done([name, count.result]) }))).then(counts => { db.close(); resolve({ version: db.version, counts: Object.fromEntries(counts) }) }) }
  }))
  assert.equal(migrated.version, 2)
  assert.deepEqual(migrated.counts, { aiHistory: 0, annotations: 1, chunks: 0, files: 1, notes: 1, papers: 1, progress: 1 })
  await migration.close()
  console.log('IndexedDB v1-to-v2 migration preserved papers, files, progress, annotations and notes.')

  await page.goto(`${baseURL}/library`, { waitUntil: 'networkidle' })
  await page.locator('input[type=file]').setInputFiles(path.join(root, 'public/paperflow-sample.pdf'))
  await page.getByRole('status').filter({ hasText: '已保存到本地文献库' }).waitFor({ timeout: 30000 })
  await page.getByRole('link', { name: '开始阅读' }).click()
  await page.locator('.textLayer span', { hasText: 'Research grows through small' }).waitFor({ state: 'attached', timeout: 30000 })
  await waitForRender()
  await dragSelection()
  await page.getByRole('toolbar', { name: '选段 AI 操作' }).getByRole('button', { name: '解释', exact: true }).click()
  await page.getByText('本地检索演示 · 非 AI').waitFor({ timeout: 30000 })
  await page.getByText('AI 服务未连接：以下仅为本地检索到的原文片段', { exact: false }).waitFor()
  const citation = page.locator('.citation-card').first()
  const quote = await citation.locator('span').innerText()
  const allChunks = await chunks()
  assert.ok(allChunks.length >= 2)
  assert.ok(allChunks.some(chunk => chunk.pageNumber === 1 && chunk.text.includes(quote.slice(1, -1))))
  await citation.click()
  await page.getByRole('status').filter({ hasText: '唯一匹配并突出显示原文' }).waitFor()
  assert.ok(await page.locator('.citation-highlight').count() > 0)
  await page.screenshot({ path: path.join(os.tmpdir(), 'paperflow-ai-demo.png'), fullPage: true })
  await page.getByRole('button', { name: '取消关联选区' }).click()
  await page.getByRole('textbox', { name: '向论文提问' }).fill('zymblorbquuxnonexistent')
  await page.getByRole('button', { name: '发送问题' }).click()
  await page.getByText('未找到匹配的原文证据，无法从当前论文确认。').waitFor()
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('tab', { name: 'AI 助手' }).click()
  await page.getByText('未找到匹配的原文证据，无法从当前论文确认。').waitFor()
  await page.getByRole('button', { name: '论文整体解读' }).click()
  await page.getByText('整体解读仅基于有限抽样片段', { exact: false }).waitFor()
  const secondPage = page.locator('.citation-card').filter({ hasText: '第 2 页' }).last()
  await secondPage.click()
  await waitForRender()
  assert.equal(await page.locator('.page-counter').innerText(), '2 / 2')
  await page.getByRole('status').filter({ hasText: /引用页|原文/ }).waitFor()

  assert.equal(mock.requests.length, 0, 'The absent-AI demo and no-evidence path must stay local')
  mock.configured = true
  await page.getByRole('button', { name: '上一页' }).click()
  await waitForRender()
  // Remount the panel so it reads the explicitly mocked configured status.
  await page.getByRole('tab', { name: '高亮与笔记' }).click()
  await page.getByRole('tab', { name: 'AI 助手' }).click()
  const selector = page.getByRole('combobox', { name: '选择 AI 模型' })
  await selector.waitFor()
  await selector.locator(`option[value="${models[1]}"]`).waitFor({ state: 'attached' })
  assert.equal(await selector.inputValue(), models[0])
  assert.deepEqual(await selector.locator('option').evaluateAll(options => options.map(option => option.value)), models)
  mock.expectedModel = models[1]
  await selector.selectOption(models[1])
  await dragSelection()
  await page.getByRole('toolbar', { name: '选段 AI 操作' }).getByRole('button', { name: '翻译', exact: true }).click()
  const modelMessage = page.locator('.ai-message--assistant').filter({ hasText: mockAnswer })
  await modelMessage.waitFor()
  await page.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' })
  assert.equal(mock.requests.length, 1)
  assert.equal(mock.requests[0].model, models[1])
  assert.equal(mock.requests[0].mode, 'translate')
  assert.ok(mock.requests[0].selection)
  assert.equal(await modelMessage.locator('.citation-card span').innerText(), `“${mock.requests[0].selection}”`)
  assert.equal(await page.locator('.ai-message').filter({ hasText: '生成中 · 引用待校验' }).count(), 0)
  await modelMessage.getByRole('button', { name: '保存回答为笔记' }).click()
  await page.getByText('回答与选区已保存为高亮笔记。').waitFor()
  await page.getByRole('tab', { name: '高亮与笔记' }).click()
  await page.locator('.saved-item__text').first().click()
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="高亮笔记"]')?.value === '这是测试桩返回的解释。')
  await page.screenshot({ path: path.join(os.tmpdir(), 'paperflow-ai-note.png'), fullPage: true })
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('tab', { name: 'AI 助手' }).click()
  await page.getByText(mockAnswer, { exact: true }).waitFor()
  mock.expectedModel = models[0]
  await selector.selectOption(models[0])
  const beforeFailures = await storedAnswers(page)
  for (const outcome of ['truncated', 'stream-error', 'http-error']) {
    mock.outcome = outcome
    await page.getByRole('textbox', { name: '向论文提问' }).fill(`Research ${outcome}`)
    const received = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/ai/answer') && response.request().method() === 'POST')
    await page.getByRole('button', { name: '发送问题' }).click()
    await (await received).finished()
    const alert = page.getByRole('alert')
    await alert.waitFor()
    await page.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' })
    if (outcome === 'stream-error') assert.match(await alert.innerText(), /模拟流式生成失败/)
    if (outcome === 'http-error') assert.match(await alert.innerText(), /模拟模型服务不可用/)
    assert.equal(await page.locator('.ai-message').filter({ hasText: '生成中 · 引用待校验' }).count(), 0)
    assert.equal((await page.locator('body').innerText()).includes('不可保存的模拟草稿'), false)
    assert.equal(await selector.isEnabled(), true)
    assert.deepEqual(await storedAnswers(page), beforeFailures, 'Failed NDJSON responses must not persist partial answers or notes')
  }
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('tab', { name: 'AI 助手' }).click()
  await page.getByText(mockAnswer, { exact: true }).waitFor()
  assert.equal((await page.locator('body').innerText()).includes('不可保存的模拟草稿'), false)
  assert.deepEqual(await storedAnswers(page), beforeFailures)
  await page.goto(`${baseURL}/library`)
  await page.getByRole('button', { name: '删除 paperflow-sample' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '确认删除' }).click()
  await page.getByText('还没有文献').waitFor()
  assert.equal((await chunks()).length, 0)
  const historyCount = await page.evaluate(() => new Promise(resolve => { const open = indexedDB.open('paperflow-library'); open.onsuccess = () => { const request = open.result.transaction('aiHistory').objectStore('aiHistory').count(); request.onsuccess = () => resolve(request.result) } }))
  assert.equal(historyCount, 0)
  // Keep the API deny-by-default routes installed for blank/private-PDF regressions too.
  mock.configured = false
  mock.outcome = 'success'
  const blank = await PDFDocument.create()
  blank.addPage([612, 792])
  await page.locator('input[type=file]').setInputFiles({ name: 'no-text.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await blank.save()) })
  await page.getByRole('status').filter({ hasText: '已保存到本地文献库' }).waitFor()
  await page.getByRole('link', { name: '开始阅读' }).click()
  await page.getByRole('tab', { name: 'AI 助手' }).click()
  await page.getByRole('button', { name: '论文整体解读' }).click()
  await page.getByRole('alert').filter({ hasText: 'PDF 没有可提取的文字' }).waitFor()
  await page.goto(`${baseURL}/library`)
  await page.getByRole('button', { name: '删除 no-text' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '确认删除' }).click()
  await page.getByText('还没有文献').waitFor()
  // Never inspect or upload a private root document in the normal sample-only suite.
  if (process.env.PAPERFLOW_TEST_PRIVATE_PDF === '1' && existsSync(path.join(root, 'Qoder.pdf'))) {
    await page.locator('input[type=file]').setInputFiles(path.join(root, 'Qoder.pdf'))
    await page.getByRole('status').filter({ hasText: '已保存到本地文献库' }).waitFor({ timeout: 60000 })
    await page.getByRole('link', { name: '开始阅读' }).click()
    await page.locator('.pdf-page canvas').waitFor({ timeout: 30000 })
    await waitForRender()
    await page.getByRole('tab', { name: 'AI 助手' }).click()
    await page.getByRole('button', { name: '论文整体解读' }).click()
    await page.getByText('本地检索演示 · 非 AI').waitFor({ timeout: 60000 })
    const originalChunks = await chunks()
    assert.ok(originalChunks.length > 0)
    assert.ok(originalChunks.every(chunk => chunk.pageNumber >= 1 && chunk.pageNumber <= 25 && chunk.text && chunk.chunkId && chunk.paperId))
    const originalPdf = await getDocument({ data: new Uint8Array(await readFile(path.join(root, 'Qoder.pdf'))), disableFontFace: true }).promise
    const cards = page.locator('.citation-card')
    for (let i = 0; i < await cards.count(); i++) {
      const card = cards.nth(i)
      const text = (await card.locator('span').innerText()).slice(1, -1)
      const label = await card.locator('strong').innerText()
      const number = Number(label.match(/第 (\d+) 页/)[1])
      assert.ok(originalChunks.some(chunk => chunk.pageNumber === number && chunk.text.includes(text)))
      const source = await (await originalPdf.getPage(number)).getTextContent()
      const normalize = value => value.replace(/[\u0000-\u001f\s]+/g, '')
      const sourceText = normalize(source.items.filter(item => 'str' in item).map(item => item.str).join(''))
      assert.ok(sourceText.includes(normalize(text)), `Quote does not match PDF page ${number}`)
    }
    await originalPdf.destroy()
    console.log(`Original Chinese PDF: extracted ${originalChunks.length} local chunks; displayed quotes match independently extracted source pages.`)
  }
  assert.deepEqual(errors, [])
  console.log('AI reader: absent-AI demo, selection, no-evidence, verified citation jump, history, exact model choices, NDJSON model note, truncated/error responses and cascade deletion passed with intercepted APIs.')

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  const mobileMock = await installAiMock(mobile)
  const mobilePage = await mobile.newPage()
  mobilePage.on('pageerror', error => errors.push(error.message))
  await mobilePage.goto(`${baseURL}/library`, { waitUntil: 'networkidle' })
  await mobilePage.locator('input[type=file]').setInputFiles(path.join(root, 'public/paperflow-sample.pdf'))
  await mobilePage.getByRole('status').filter({ hasText: '已保存到本地文献库' }).waitFor({ timeout: 30000 })
  await mobilePage.getByRole('link', { name: '开始阅读' }).click()
  await mobilePage.getByRole('tab', { name: 'AI 助手' }).click()
  await mobilePage.getByRole('button', { name: '论文整体解读' }).click()
  await mobilePage.getByText('本地检索演示 · 非 AI').waitFor({ timeout: 30000 })
  assert.equal(mobileMock.requests.length, 0)
  const demoOverflow = await mobilePage.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  assert.equal(demoOverflow.scroll, demoOverflow.width)
  mobileMock.configured = true
  await mobilePage.getByRole('tab', { name: '高亮与笔记' }).click()
  await mobilePage.getByRole('tab', { name: 'AI 助手' }).click()
  const mobileSelector = mobilePage.getByRole('combobox', { name: '选择 AI 模型' })
  await mobileSelector.waitFor()
  await mobileSelector.locator(`option[value="${models[1]}"]`).waitFor({ state: 'attached' })
  assert.equal(await mobileSelector.inputValue(), models[0])
  assert.deepEqual(await mobileSelector.locator('option').evaluateAll(options => options.map(option => option.value)), models)
  mobileMock.expectedModel = models[1]
  await mobileSelector.selectOption(models[1])
  await mobilePage.getByRole('button', { name: '论文整体解读' }).click()
  await mobilePage.getByText(mockAnswer, { exact: true }).waitFor()
  await mobilePage.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' })
  assert.equal(mobileMock.requests.at(-1).model, models[1])
  const overflow = await mobilePage.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  assert.equal(overflow.scroll, overflow.width)
  await mobilePage.screenshot({ path: path.join(os.tmpdir(), 'paperflow-ai-mobile.png'), fullPage: true })
  await mobile.close()
  assert.deepEqual(errors, [])
  assert.deepEqual(unexpectedRequests, [])
  console.log('Mobile AI model selector and overflow passed. Screenshots are in the system temp directory. No real provider latency or compatibility was measured.')
} finally { await browser.close() }
