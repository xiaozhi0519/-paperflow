import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { chromium } from 'playwright-core'

const candidates = process.platform === 'win32' ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const executablePath = process.env.CHROME_PATH || candidates.find(existsSync)
if (!executablePath) throw new Error('Set CHROME_PATH to an installed Chromium-compatible browser.')
async function freePort() { const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
const aiPort = await freePort()
const webPort = await freePort()
let requests = 0
const fake = http.createServer(async (req, res) => {
  let raw = ''
  for await (const part of req) raw += part
  const payload = JSON.parse(raw)
  assert.equal(req.headers.authorization, 'Bearer integration-test-key')
  assert.equal(payload.model, 'integration-stub')
  assert.match(payload.messages[0].content, /不可信的数据/)
  const input = JSON.parse(payload.messages[1].content)
  requests++
  if (input.question.includes('provider-error')) { res.writeHead(429); res.end(); return }
  const chunk = input.selection ? input.evidence.find(item => item.text.includes(input.selection)) : input.evidence[0]
  assert.ok(chunk)
  const quote = input.selection || chunk.text.slice(0, 100)
  const answer = input.task === 'overview' ? '研究问题：测试\n研究背景：测试\n核心方法：测试\n主要创新点：测试\n实验设置：测试\n实验结果：测试\n研究局限：测试' : '这是一条来自本地测试桩的模拟回答。'
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer, citations: [{ chunkId: chunk.chunkId, quote }] }) } }] }))
})
fake.listen(0, '127.0.0.1')
await once(fake, 'listening')
const env = { ...process.env, AI_PORT: String(aiPort), AI_API_KEY: 'integration-test-key', AI_MODEL: 'integration-stub', AI_BASE_URL: `http://127.0.0.1:${fake.address().port}/v1`, AI_ALLOWED_ORIGINS: `http://127.0.0.1:${webPort}` }
const children = []
function start(args) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 30000)
    child.stdout.on('data', part => { output += part; if (/listening on|ready in/.test(output)) { clearTimeout(timer); resolve(child) } })
    child.stderr.on('data', part => { output += part })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)) })
    child.once('error', reject)
  })
}
let browser
try {
  await start(['server/ai-server.mjs'])
  await start(['node_modules/vite/bin/vite.js', '--port', String(webPort), '--strictPort'])
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${webPort}/library`, { waitUntil: 'networkidle' })
  await page.locator('input[type=file]').setInputFiles(path.resolve('public/paperflow-sample.pdf'))
  await page.getByRole('status').filter({ hasText: '已保存到本地文献库' }).waitFor({ timeout: 30000 })
  await page.getByRole('link', { name: '开始阅读' }).click()
  await page.locator('.textLayer span', { hasText: 'Research grows through small' }).waitFor({ state: 'attached', timeout: 30000 })
  await page.waitForFunction(() => !document.querySelector('.pdf-rendering'))
  await page.getByRole('tab', { name: 'AI 助手' }).click()
  await page.getByText('模型已配置：integration-stub', { exact: false }).waitFor()
  await page.getByRole('button', { name: '论文整体解读' }).click()
  await page.getByText('研究问题：测试', { exact: false }).waitFor({ timeout: 30000 })
  await page.locator('.citation-card').first().click()
  assert.ok(await page.getByText('第 1 页 · 页码级引用', { exact: false }).count())
  const initialRequests = requests
  await page.getByRole('textbox', { name: '向论文提问' }).fill('zymblorbquuxnonexistent')
  await page.getByRole('button', { name: '发送问题' }).click()
  await page.getByText('未找到匹配的原文证据，无法从当前论文确认。').waitFor()
  assert.equal(requests, initialRequests)
  const line = page.locator('.textLayer span', { hasText: 'Research grows through small' }).first()
  await line.scrollIntoViewIfNeeded()
  const box = await line.boundingBox()
  assert.ok(box)
  await page.mouse.move(box.x + 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 10 })
  await page.mouse.up()
  await page.getByRole('toolbar', { name: '选段 AI 操作' }).getByRole('button', { name: '解释', exact: true }).click()
  await page.getByText('这是一条来自本地测试桩的模拟回答。').waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: '保存回答为笔记' }).click()
  await page.getByText('回答与选区已保存为高亮笔记。').waitFor()
  await page.getByRole('button', { name: '取消关联选区' }).click()
  await page.getByRole('textbox', { name: '向论文提问' }).fill('Research provider-error')
  await page.getByRole('button', { name: '发送问题' }).click()
  await page.getByRole('alert').filter({ hasText: '模型中转站返回 429' }).waitFor()
  assert.equal((await page.locator('body').innerText()).includes('integration-test-key'), false)
  assert.deepEqual(errors, [])
  console.log('Full browser → Vite proxy → AI server → local fake OpenAI-compatible provider: overview, evidence, no-evidence, selection note and error passed. No real model was called.')
} finally {
  if (browser) await browser.close()
  for (const child of children) child.kill()
  fake.closeAllConnections()
  await new Promise(resolve => fake.close(resolve))
}
