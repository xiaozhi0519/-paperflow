import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('../', import.meta.url))
const models = ['gpt-6.1-sol', 'glm-5.3-flash']
const candidates = process.platform === 'win32' ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const executablePath = process.env.CHROME_PATH || candidates.find(existsSync)
if (!executablePath) throw new Error('Set CHROME_PATH to an installed Chromium-compatible browser.')
async function freePort() { const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function bounded(promise, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 30000) })]) }
  finally { clearTimeout(timer) }
}
const requests = []
const pending = []
const plans = []
const providerErrors = []
function enqueue(answer, { model = models[0], outcome = 'success' } = {}) {
  const plan = { answer, partial: answer.slice(0, Math.ceil(answer.length / 2)), model, outcome, seen: deferred(), release: deferred(), contentSent: deferred(), complete: deferred(), closed: deferred() }
  pending.push(plan); plans.push(plan)
  return plan
}
const fake = http.createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/v1/chat/completions')
    let raw = ''
    for await (const part of req) raw += part
    const payload = JSON.parse(raw)
    const plan = pending.shift()
    assert.ok(plan, 'Unexpected upstream request; every response must have an explicit test plan')
    res.once('close', () => plan.closed.resolve({ premature: !res.writableEnded }))
    assert.equal(req.headers.authorization, 'Bearer integration-test-key')
    assert.equal(payload.model, plan.model)
    assert.equal(payload.stream, true, 'The browser path must request OpenAI SSE, not the separate nonstream check path')
    assert.match(payload.messages[0].content, /不可信的数据/)
    const input = JSON.parse(payload.messages[1].content)
    requests.push(payload)
    const chunk = input.selection ? input.evidence.find(item => item.text.includes(input.selection)) : input.evidence[0]
    assert.ok(chunk)
    const quote = plan.outcome === 'forged' ? 'This fabricated quotation does not exist in the authored sample PDF.' : input.selection || chunk.text.slice(0, 100)
    if (plan.outcome === 'forged') assert.ok(input.evidence.every(item => !item.text.includes(quote)))
    plan.citation = { paperId: chunk.paperId, pageNumber: chunk.pageNumber, chunkId: chunk.chunkId, quote }
    plan.seen.resolve({ payload, input })
    if (plan.outcome === 'provider-error') {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Synthetic rate limit' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
    res.flushHeaders()
    const frame = (content, finishReason = null) => `data: ${JSON.stringify({ model: payload.model, choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finishReason }] })}\n\n`
    const content = JSON.stringify({ answer: plan.answer, citations: [{ chunkId: chunk.chunkId, quote }] })
    const prefix = `{"answer":${JSON.stringify(plan.partial).slice(0, -1)}`
    assert.ok(content.startsWith(prefix))
    res.write(': synthetic provider heartbeat\n\n')
    res.write(frame(prefix))
    // Completion cannot arrive until the browser has asserted the visible draft.
    // A disconnect also releases this handler, without completing the provider response.
    await Promise.race([plan.release.promise, plan.closed.promise])
    if (res.destroyed) return
    if (plan.outcome === 'truncated-json') { res.end(); return }
    if (plan.outcome === 'stream-error') {
      // A later error invalidates even syntactically complete answer/citation JSON.
      res.write(frame(content.slice(prefix.length)))
      res.write(`data: ${JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Synthetic streaming error' } })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    res.write(frame(content.slice(prefix.length)))
    res.write(frame(null, 'stop'))
    // Even valid JSON plus finish_reason is not success without the SSE [DONE] marker.
    if (plan.outcome === 'missing-done') { res.end(); return }
    plan.contentSent.resolve()
    await Promise.race([plan.complete.promise, plan.closed.promise])
    if (!res.destroyed) res.end('data: [DONE]\n\n')
  } catch (error) {
    providerErrors.push(error.message)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Synthetic provider assertion failed' }))
  }
})
fake.listen(0, '127.0.0.1')
await once(fake, 'listening')
const aiPort = await freePort()
let webPort = await freePort()
while (webPort === aiPort) webPort = await freePort()
const baseURL = `http://127.0.0.1:${webPort}`
// Only inherit OS essentials, never a developer's provider credentials, NODE_OPTIONS or VITE_* settings.
const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
Object.assign(env, { NODE_ENV: 'development', VITE_API_BASE_URL: '/api', ALLOWED_HOSTS: `127.0.0.1:${aiPort},localhost:${aiPort}`, AI_PORT: String(aiPort), AI_API_KEY: 'integration-test-key', AI_MODEL: models[0], AI_BASE_URL: `http://127.0.0.1:${fake.address().port}/v1`, AI_ALLOWED_ORIGINS: baseURL, AI_TIMEOUT_MS: '120000' })
const children = []
function start(args) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 30000)
    child.stdout.on('data', part => { output += part; if (/listening on|ready in/.test(output)) { clearTimeout(timer); resolve(child) } })
    child.stderr.on('data', part => { output += part })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
  })
}
async function stored(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('paperflow-library')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['aiHistory', 'annotations', 'notes'])
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
const messages = snapshot => snapshot.aiHistory.flatMap(row => row.messages)
const eventsFrom = async (page, response) => {
  assert.match(response.headers()['content-type'], /^application\/x-ndjson\b/)
  const key = response.request().postData()
  await page.waitForFunction(key => window.__aiStreams?.[key]?.finished, key)
  const recorded = await page.evaluate(key => window.__aiStreams[key], key)
  assert.equal(recorded.error, undefined)
  assert.ok(recorded.text.endsWith('\n'), 'Downstream events must be newline-terminated JSON')
  return recorded.text.trim().split('\n').map(line => JSON.parse(line))
}
let browser
try {
  await start([path.join(root, 'server/ai-server.mjs')])
  // Inline Vite configuration prevents both vite.config.ts and .env* loading.
  await start(['--input-type=module', '--eval', `
    import { createServer } from 'vite'
    import react from '@vitejs/plugin-react'
    import tailwindcss from '@tailwindcss/vite'
    const server = await createServer({
      root: ${JSON.stringify(root)}, configFile: false, envFile: false,
      cacheDir: ${JSON.stringify(path.join(os.tmpdir(), `paperflow-ai-integration-cache-${process.pid}`))},
      plugins: [react(), tailwindcss()],
      define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api') },
      server: { host: '127.0.0.1', port: ${webPort}, strictPort: true, proxy: { '/api': {
        target: 'http://127.0.0.1:${aiPort}', changeOrigin: true,
        configure(proxy) { proxy.on('proxyReq', (proxyRequest, request, response) => { response.once('close', () => { if (!response.writableEnded) proxyRequest.destroy() }) }) }
      } } }
    })
    await server.listen()
    console.log('Integration Vite listening on ${baseURL}')
  `])
  browser = await chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  const blocked = []
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    const api = /^\/(?:api|functions)(?:\/|$)/.test(url.pathname)
    if (url.origin !== baseURL || (api && !['/api/ai/status', '/api/ai/answer'].includes(url.pathname))) {
      blocked.push(url.href); await route.abort('blockedbyclient'); return
    }
    await route.continue()
  })
  // Chromium may discard its response-body cache when the client stops reading at the terminal event.
  await context.addInitScript(() => {
    const fetchOriginal = window.fetch.bind(window)
    window.__aiStreams = {}
    window.fetch = async (input, init) => {
      const response = await fetchOriginal(input, init)
      if (String(input).endsWith('/ai/answer') && response.headers.get('content-type')?.startsWith('application/x-ndjson')) {
        const record = window.__aiStreams[init.body] = { finished: false }
        void response.clone().text().then(text => { record.text = text }).catch(error => { record.error = error.message }).finally(() => { record.finished = true })
      }
      return response
    }
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const selector = page.getByRole('combobox', { name: '选择 AI 模型' })
  const drafts = page.locator('.ai-message').filter({ hasText: '生成中 · 引用待校验' })
  const stop = page.getByRole('button', { name: '停止生成', exact: true })
  async function ask(question) {
    await page.getByRole('textbox', { name: '向论文提问' }).fill(question)
    await page.getByRole('button', { name: '发送问题' }).click()
  }
  async function partial(plan, action) {
    const before = await stored(page)
    const citationCount = await page.locator('.citation-card').count()
    const responsePromise = page.waitForResponse(response => response.url() === `${baseURL}/api/ai/answer` && response.request().method() === 'POST')
    await action()
    await bounded(plan.seen.promise, 'the fake provider request')
    await drafts.waitFor({ state: 'visible' })
    await page.waitForFunction(text => [...document.querySelectorAll('.ai-message__text')].some(node => node.textContent === text), plan.partial)
    assert.equal(await drafts.locator('.ai-message__text').innerText(), plan.partial)
    assert.equal(await drafts.locator('.citation-card').count(), 0)
    assert.equal(await drafts.getByRole('button', { name: '保存回答为笔记' }).count(), 0)
    assert.equal(await page.locator('.citation-card').count(), citationCount)
    assert.equal(await selector.isDisabled(), true)
    assert.equal(await stop.isEnabled(), true)
    assert.deepEqual(await stored(page), before, 'Drafts must not write history or notes before validation')
    const response = await responsePromise
    assert.equal(response.status(), 200)
    assert.equal(response.request().postDataJSON().model, plan.model)
    assert.match(response.headers()['content-type'], /^application\/x-ndjson\b/)
    return { before, response }
  }
  async function settle(plan, response) {
    const beforeCompletion = await stored(page)
    const citationCount = await page.locator('.citation-card').count()
    plan.release.resolve()
    if (['success', 'forged'].includes(plan.outcome)) {
      await bounded(plan.contentSent.promise, 'complete upstream JSON before the gated DONE marker')
      await page.waitForFunction(text => [...document.querySelectorAll('.ai-message__text')].some(node => node.textContent === text), plan.answer)
      assert.equal(await drafts.count(), 1)
      assert.equal(await drafts.locator('.ai-message__text').innerText(), plan.answer)
      assert.equal(await drafts.locator('.citation-card').count(), 0)
      assert.equal(await drafts.getByRole('button', { name: '保存回答为笔记' }).count(), 0)
      assert.equal(await page.locator('.citation-card').count(), citationCount)
      assert.equal(await selector.isDisabled(), true)
      assert.deepEqual(await stored(page), beforeCompletion, 'Valid-looking JSON is still only a draft before upstream DONE')
      plan.complete.resolve()
    }
    const events = await eventsFrom(page, response)
    await stop.waitFor({ state: 'hidden' })
    assert.equal(await drafts.count(), 0)
    assert.equal(await selector.isEnabled(), true)
    assert.ok(events.length >= 2)
    for (const event of events.slice(0, -1)) {
      assert.equal(event.type, 'delta')
      assert.equal(typeof event.text, 'string')
      assert.equal('citations' in event, false)
      assert.equal('result' in event, false)
    }
    return events
  }
  async function success(plan, response) {
    const events = await settle(plan, response)
    const final = events.at(-1)
    assert.equal(final.type, 'done')
    assert.equal(final.result.source, 'model')
    assert.equal(final.result.answer, plan.answer)
    assert.equal(final.result.provider.model, plan.model)
    assert.equal(events.slice(0, -1).map(event => event.text).join(''), plan.answer)
    assert.deepEqual(final.result.citations, [plan.citation])
    const submitted = response.request().postDataJSON()
    for (const citation of final.result.citations) {
      assert.ok(submitted.chunks.some(chunk => chunk.paperId === citation.paperId && chunk.pageNumber === citation.pageNumber && chunk.chunkId === citation.chunkId && chunk.text.includes(citation.quote)))
    }
    const message = page.locator('.ai-message--assistant').filter({ hasText: plan.answer })
    await message.waitFor()
    assert.equal(await message.locator('.citation-card').count(), 1)
    assert.equal(await message.locator('.citation-card span').innerText(), `“${plan.citation.quote}”`)
    assert.ok(messages(await stored(page)).some(item => item.source === 'model' && item.text === plan.answer))
    return message
  }
  await page.goto(`${baseURL}/library`, { waitUntil: 'networkidle' })
  const status = await page.evaluate(async () => (await fetch('/api/ai/status')).json())
  assert.equal(status.configured, true)
  assert.equal(status.model, models[0])
  assert.deepEqual(status.models, models)
  await page.locator('input[type=file]').setInputFiles(path.join(root, 'public/paperflow-sample.pdf'))
  await page.getByRole('status').filter({ hasText: '已保存到本地文献库' }).waitFor({ timeout: 30000 })
  await page.getByRole('link', { name: '开始阅读' }).click()
  await page.locator('.textLayer span', { hasText: 'Research grows through small' }).waitFor({ state: 'attached', timeout: 30000 })
  await page.waitForFunction(() => !document.querySelector('.pdf-rendering'))
  await page.getByRole('tab', { name: 'AI 助手' }).click()
  await selector.waitFor()
  await selector.locator(`option[value="${models[1]}"]`).waitFor({ state: 'attached' })
  assert.equal(await selector.inputValue(), models[0])
  assert.deepEqual(await selector.locator('option').evaluateAll(options => options.map(option => option.value)), models)

  const overview = enqueue('研究问题：测试\n研究背景：测试\n核心方法：测试\n主要创新点：测试\n实验设置：测试\n实验结果：测试\n研究局限：测试')
  const overviewRun = await partial(overview, () => page.getByRole('button', { name: '论文整体解读' }).click())
  await page.screenshot({ path: path.join(os.tmpdir(), `paperflow-ai-stream-partial-${process.pid}.png`), fullPage: true })
  const overviewMessage = await success(overview, overviewRun.response)
  await overviewMessage.locator('.citation-card').click()
  assert.ok(await page.getByText('第 1 页 · 页码级引用', { exact: false }).count())
  await page.getByText('整体解读仅基于有限抽样片段', { exact: false }).waitFor()

  const initialRequests = requests.length
  for (const model of [undefined, 'unsupported-test-model']) {
    const body = { ...overviewRun.response.request().postDataJSON(), model }
    const invalid = await page.evaluate(async body => {
      const response = await fetch('/api/ai/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: response.status, type: response.headers.get('content-type'), body: await response.json() }
    }, body)
    assert.ok(invalid.status >= 400 && invalid.status < 500)
    assert.match(invalid.type, /^application\/json\b/)
    assert.equal(typeof invalid.body.error, 'string')
  }
  await ask('zymblorbquuxnonexistent')
  await page.getByText('未找到匹配的原文证据，无法从当前论文确认。').waitFor()
  assert.equal(requests.length, initialRequests)

  await selector.selectOption(models[1])
  assert.equal(await selector.inputValue(), models[1])
  const line = page.locator('.textLayer span', { hasText: 'Research grows through small' }).first()
  await line.scrollIntoViewIfNeeded()
  const box = await line.boundingBox()
  assert.ok(box)
  await page.mouse.move(box.x + 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 10 })
  await page.mouse.up()
  const selection = enqueue('这是一条来自本地测试桩的模拟回答。', { model: models[1] })
  const selectionRun = await partial(selection, () => page.getByRole('toolbar', { name: '选段 AI 操作' }).getByRole('button', { name: '解释', exact: true }).click())
  const selectionMessage = await success(selection, selectionRun.response)
  await selectionMessage.getByRole('button', { name: '保存回答为笔记' }).click()
  await page.getByText('回答与选区已保存为高亮笔记。').waitFor()
  assert.ok((await stored(page)).notes.some(note => note.content === selection.answer))
  await selector.focus()
  await page.screenshot({ path: path.join(os.tmpdir(), `paperflow-ai-model-choice-${process.pid}.png`), fullPage: true })

  const forged = enqueue('伪造引用的测试回答绝不能保存为模型历史或笔记。', { model: models[1], outcome: 'forged' })
  const forgedRun = await partial(forged, () => ask('Research forged quotation'))
  const forgedEvents = await settle(forged, forgedRun.response)
  const refusal = forgedEvents.at(-1)
  assert.equal(refusal.type, 'done')
  assert.equal(refusal.result.source, 'local')
  assert.match(refusal.result.answer, /无法从当前论文确认/)
  assert.deepEqual(refusal.result.citations, [])
  assert.notEqual(refusal.result.answer, forged.answer)
  const refusalMessage = page.locator('.ai-message--assistant').last()
  assert.match(await refusalMessage.innerText(), /无法从当前论文确认/)
  assert.equal(await refusalMessage.locator('.citation-card').count(), 0)
  assert.equal(await refusalMessage.getByRole('button', { name: '保存回答为笔记' }).count(), 0)
  const afterForged = await stored(page)
  assert.deepEqual(messages(afterForged).filter(item => item.source === 'model'), messages(forgedRun.before).filter(item => item.source === 'model'))
  assert.equal(JSON.stringify(afterForged).includes(forged.partial), false)
  assert.equal((await page.locator('body').innerText()).includes(forged.partial), false)
  assert.deepEqual(afterForged.notes, forgedRun.before.notes)
  assert.deepEqual(afterForged.annotations, forgedRun.before.annotations)

  const cancelled = enqueue('取消请求的测试草稿不能留下会话历史或高亮笔记。', { model: models[1] })
  const cancelRun = await partial(cancelled, () => ask('Research cancellation'))
  await stop.click()
  const closed = await bounded(cancelled.closed.promise, 'cancellation to close the upstream SSE connection')
  assert.equal(closed.premature, true)
  await stop.waitFor({ state: 'hidden' })
  assert.equal(await drafts.count(), 0)
  assert.equal(await selector.isEnabled(), true)
  assert.deepEqual(await stored(page), cancelRun.before)
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('tab', { name: 'AI 助手' }).click()
  await selector.waitFor()
  await page.getByText(selection.answer, { exact: true }).waitFor()
  assert.equal(await drafts.count(), 0)
  assert.equal((await page.locator('body').innerText()).includes(cancelled.partial), false)
  assert.deepEqual(await stored(page), cancelRun.before)
  // A fresh panel uses the advertised default, rather than an arbitrary model alias.
  await selector.selectOption(models[0])

  for (const outcome of ['truncated-json', 'missing-done', 'stream-error']) {
    const plan = enqueue(`失败草稿 ${outcome}：不能作为完成的回答保留。`, { outcome })
    const run = await partial(plan, () => ask(`Research ${outcome}`))
    const events = await settle(plan, run.response)
    assert.equal(events.at(-1).type, 'error')
    assert.equal(typeof events.at(-1).error, 'string')
    assert.ok(events.at(-1).error.length > 0)
    assert.equal(events.some(event => event.type === 'done'), false)
    await page.getByRole('alert').waitFor()
    assert.equal((await page.locator('body').innerText()).includes(plan.partial), false)
    assert.deepEqual(await stored(page), run.before)
  }
  const beforeError = await stored(page)
  const providerError = enqueue('不会发送的回答', { outcome: 'provider-error' })
  const errorResponse = page.waitForResponse(response => response.url() === `${baseURL}/api/ai/answer` && response.request().method() === 'POST')
  await ask('Research provider-error')
  await bounded(providerError.seen.promise, 'the synthetic HTTP error request')
  const response = await errorResponse
  assert.ok(response.status() >= 400)
  assert.match(response.headers()['content-type'], /^application\/json\b/)
  assert.match((await response.json()).error, /模型中转站返回 429/)
  await page.getByRole('alert').filter({ hasText: '模型中转站返回 429' }).waitFor()
  assert.equal(await drafts.count(), 0)
  assert.deepEqual(await stored(page), beforeError)
  assert.equal((await page.locator('body').innerText()).includes('integration-test-key'), false)
  const departed = enqueue('离开助手面板时，这段未校验草稿必须丢弃。')
  const departedRun = await partial(departed, () => ask('Research leave panel'))
  await page.getByRole('tab', { name: '高亮与笔记' }).click()
  assert.equal((await bounded(departed.closed.promise, 'panel unmount to cancel the provider')).premature, true)
  await page.getByRole('tab', { name: 'AI 助手' }).click()
  await selector.waitFor()
  await page.getByText(selection.answer, { exact: true }).waitFor()
  assert.equal(await drafts.count(), 0)
  assert.equal((await page.locator('body').innerText()).includes(departed.partial), false)
  assert.deepEqual(await stored(page), departedRun.before)
  assert.equal(pending.length, 0)
  assert.deepEqual(providerErrors, [])
  assert.deepEqual(blocked, [])
  assert.deepEqual(errors, [])
  console.log('Isolated browser → Vite → AI server → loopback SSE fake: gated drafts, both exact models, final citations, overview/evidence/selection notes, no-evidence, cancellation, forged citations and stream/HTTP failures passed. No real provider latency or compatibility was measured. Screenshots are in the system temp directory.')
} finally {
  if (browser) await browser.close()
  for (const plan of plans) { plan.release.resolve(); plan.complete.resolve() }
  for (const child of children) child.kill()
  fake.closeAllConnections()
  await new Promise(resolve => fake.close(resolve))
}
