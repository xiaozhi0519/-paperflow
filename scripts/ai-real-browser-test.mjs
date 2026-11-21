import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readProviderConfig } from '../server/openai-provider.mjs'

const config = readProviderConfig()
const pdfPath = process.env.PAPERFLOW_PDF?.trim() || ''
const question = process.env.PAPERFLOW_QUESTION?.trim() || ''
const candidates = process.platform === 'win32' ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const executablePath = process.env.CHROME_PATH || candidates.find(existsSync)
const children = []
let browser
let pdf

async function freePort() {
  const probe = http.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  return port
}

function start(args, env) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  child.stderr.resume()
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('本地测试服务启动超时。')), 30000)
    child.stdout.on('data', part => {
      output += part.toString()
      if (/listening on|ready in/.test(output)) { clearTimeout(timer); resolve() }
    })
    child.once('error', () => { clearTimeout(timer); reject(new Error('本地测试服务启动失败。')) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('本地测试服务意外退出。')) })
  })
}

async function answer(page, action) {
  const response = page.waitForResponse(value => value.url().endsWith('/api/ai/answer') && value.request().method() === 'POST', { timeout: 160000 })
  const alert = page.getByRole('alert').waitFor({ timeout: 160000 }).then(async () => { throw new Error(`阅读器提示：${await page.getByRole('alert').first().innerText()}`) })
  const noEvidence = page.getByText('未找到匹配的原文证据，无法从当前论文确认。').waitFor({ timeout: 160000 }).then(() => { throw new Error('问题未检索到证据，请改用论文中的关键词。') })
  await action()
  const result = await Promise.race([response, alert, noEvidence])
  const data = await result.json()
  if (!result.ok()) throw new Error(`${data.code || 'AI_ERROR'}：${data.error || '模型请求失败。'}`)
  if (data.source !== 'model' || !Array.isArray(data.citations) || !data.citations.length) throw new Error('模型未返回可核验的论文引用，未将本地提示当作模型回答。')
  return data
}

async function checkCitations(citations) {
  const normalize = value => value.replace(/[\u0000-\u001f\s]+/g, '')
  const pages = new Map()
  for (const citation of citations) {
    if (!citation.paperId || !citation.chunkId || !Number.isInteger(citation.pageNumber) || citation.pageNumber < 1 || citation.pageNumber > pdf.numPages || !citation.quote) throw new Error('返回的引文结构或页码不合法。')
    if (!pages.has(citation.pageNumber)) {
      const content = await (await pdf.getPage(citation.pageNumber)).getTextContent()
      pages.set(citation.pageNumber, normalize(content.items.map(item => 'str' in item ? item.str : '').join(' ')))
    }
    if (!pages.get(citation.pageNumber).includes(normalize(citation.quote))) throw new Error('引文未能在对应 PDF 页的独立提取文本中核验。')
  }
}

try {
  if (!config.configured) throw new Error('NOT_CONFIGURED：请在本机配置 AI_BASE_URL、AI_MODEL 和 AI_API_KEY。')
  if (!pdfPath || !existsSync(pdfPath)) throw new Error('请通过 PAPERFLOW_PDF 指定本机真实论文 PDF。')
  if (!question || question.length > 1000) throw new Error('请通过 PAPERFLOW_QUESTION 指定不超过 1000 字符的论文问题。')
  if (!executablePath) throw new Error('请通过 CHROME_PATH 指定 Chromium 兼容浏览器。')
  pdf = await getDocument({ data: new Uint8Array(await readFile(pdfPath)), disableFontFace: true }).promise
  const aiPort = await freePort()
  let webPort = await freePort()
  while (webPort === aiPort) webPort = await freePort()
  const env = { ...process.env, AI_PORT: String(aiPort), AI_ALLOWED_ORIGINS: `http://127.0.0.1:${webPort}` }
  await start(['server/ai-server.mjs'], env)
  await start(['node_modules/vite/bin/vite.js', '--port', String(webPort), '--strictPort'], env)
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(160000)
  await page.goto(`http://127.0.0.1:${webPort}/library`, { waitUntil: 'networkidle' })
  await page.locator('input[type=file]').setInputFiles(pdfPath)
  await page.getByRole('status').filter({ hasText: '已保存到本地文献库' }).waitFor()
  await page.getByRole('link', { name: '开始阅读' }).click()
  await page.locator('.pdf-page canvas').waitFor()
  await page.waitForFunction(() => !document.querySelector('.pdf-rendering'))
  await page.getByRole('tab', { name: 'AI 助手' }).click()
  await page.getByText('模型已配置：', { exact: false }).waitFor()
  const overview = await answer(page, () => page.getByRole('button', { name: '论文整体解读' }).click())
  await checkCitations(overview.citations)
  await page.locator('.ai-message--assistant').first().locator('.citation-card').first().waitFor()
  await page.getByRole('textbox', { name: '向论文提问' }).fill(question)
  const qa = await answer(page, () => page.getByRole('button', { name: '发送问题' }).click())
  await checkCitations(qa.citations)
  const card = page.locator('.ai-message--assistant').nth(1).locator('.citation-card').first()
  await card.waitFor()
  const shown = (await card.locator('span').textContent()).slice(1, -1)
  if (shown !== qa.citations[0].quote) throw new Error('界面引文与服务返回不一致。')
  await card.click()
  await page.waitForFunction(expected => Number(document.querySelector('.page-counter')?.textContent?.split('/')[0].trim()) === expected, qa.citations[0].pageNumber)
  await page.waitForFunction(() => !document.querySelector('.pdf-rendering'))
  console.log(JSON.stringify({ ok: true, overview: overview.provider, question: qa.provider, checkedCitations: overview.citations.length + qa.citations.length, jumpedToPage: qa.citations[0].pageNumber }, null, 2))
} catch (error) {
  const message = error instanceof Error ? error.message : '真实论文测试未能完成。'
  console.error(JSON.stringify({ ok: false, error: message.includes(config.key) && config.key ? '测试输出包含敏感信息，已隐藏。' : message }, null, 2))
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  if (pdf) await pdf.destroy()
  for (const child of children) child.kill()
}
