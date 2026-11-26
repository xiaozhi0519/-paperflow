import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const candidates = process.platform === 'win32' ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const executablePath = process.env.CHROME_PATH || candidates.find(existsSync)
if (!executablePath) throw new Error('请设置 CHROME_PATH 指向已安装的 Chromium 浏览器。')
const sites = process.env.PAPERFLOW_TEST_SITES === '1'
const apiBase = sites ? '/functions/v1/app/api' : '/api'
const preview = sites || process.env.PAPERFLOW_TEST_PREVIEW === '1'
if (preview && !existsSync('dist/index.html')) throw new Error('请先运行 npm run build。')
if (preview) {
  const script = readFileSync('dist/index.html', 'utf8').match(/<script[^>]+src="([^"]+)"/)?.[1]
  assert.ok(script)
  const usesSites = readFileSync(path.join('dist', script.replace(/^\//, '')), 'utf8').includes('/functions/v1/app/api')
  assert.equal(usesSites, sites, `构建模式不匹配，请先运行 npm run ${sites ? 'build:sites' : 'build'}。`)
}
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }); server.on('error', reject) })
const webPort = await freePort()
const apiPort = await freePort()
const gatewayPort = await freePort()
const base = `http://127.0.0.1:${webPort}`
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'paperflow-collaboration-'))
const env = { ...process.env, NODE_ENV: 'development', DEPLOYMENT_MODE: sites ? 'sites' : 'same-origin', BIND_HOST: '127.0.0.1', ALLOWED_HOSTS: `127.0.0.1:${apiPort},localhost:${apiPort}`, TRUSTED_PROXIES: '', VITE_API_BASE_URL: apiBase, PAPERFLOW_DATA_DIR: dataDir, DATABASE_URL: '', PG_SSL_CA_FILE: '', S3_BUCKET: '', S3_REGION: '', S3_ENDPOINT: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '', S3_FORCE_PATH_STYLE: '', AI_BASE_URL: '', AI_MODEL: '', AI_API_KEY: '', AI_PORT: String(apiPort), AI_ALLOWED_ORIGINS: base, SESSION_SECRET: 'isolated-collaboration-test-session-secret', APP_ORIGIN: base, APP_API_ORIGIN: `http://127.0.0.1:${apiPort}`, APP_GATEWAY_TOKEN: 'isolated_gateway_test_token_012345678901234567890123456789', PAPERFLOW_GATEWAY_PORT: String(gatewayPort) }
const children = []
let output = ''
function start(args, marker) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  return new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error('服务启动超时')), 45000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`服务提前退出 ${code}`)) })
    child.stderr.on('data', value => { output += value })
    child.stdout.on('data', value => { output += value; text += value.toString().replace(/\x1b\[[0-9;]*m/g, ''); if (text.includes(marker)) { clearTimeout(timer); resolve() } })
  })
}
async function stop(child) {
  if (child.exitCode !== null) return
  await new Promise(resolve => { child.once('exit', resolve); child.kill() })
}
const browser = await chromium.launch({ executablePath, headless: true })
const contextA = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const contextB = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const a = await contextA.newPage()
const b = await contextB.newPage()
const errors = []
let modelCalls = 0
for (const page of [a, b]) {
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`) })
  page.on('request', request => {
    if (/\/api\/(ai\/answer|papers\/[^/]+\/discussion-summary)/.test(request.url())) modelCalls++
    if (sites && new URL(request.url()).pathname.startsWith('/api/')) errors.push('Sites 构建绕过了 Function 网关')
  })
}
const password = 'Collaboration-password-123'
const renderReady = async page => { await page.locator('.textLayer span').first().waitFor({ state: 'attached', timeout: 30000 }); await page.waitForFunction(() => !document.querySelector('.pdf-rendering')) }
const notice = (page, text) => page.getByRole('status').filter({ hasText: text }).waitFor({ timeout: 30000 })
async function register(page, name, email) {
  await page.goto(`${base}/team`)
  await page.getByRole('button', { name: '切换到远程模式', exact: true }).click()
  await page.getByRole('button', { name: '没有账号？注册' }).click()
  await page.getByRole('textbox', { name: '名称', exact: true }).fill(name)
  await page.getByRole('textbox', { name: '邮箱' }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '注册并登录' }).click()
  await page.getByText('还没有团队空间', { exact: true }).waitFor()
}
async function relogin(page, email) {
  await page.getByRole('button', { name: '退出登录' }).click()
  await page.getByRole('heading', { name: '登录远程文献库' }).waitFor()
  await page.getByRole('textbox', { name: '邮箱' }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('button', { name: '退出登录' }).waitFor()
}
async function highlight(page) {
  await renderReady(page)
  const line = page.locator('.textLayer span', { hasText: 'Research is rarely a straight line.' }).first()
  await line.scrollIntoViewIfNeeded()
  const box = await line.boundingBox()
  assert.ok(box)
  await page.mouse.move(box.x + 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 12 })
  await page.mouse.up()
  const quote = await page.locator('.selection-box p').innerText()
  await page.getByRole('button', { name: '保存高亮', exact: true }).click()
  await notice(page, '高亮已保存')
  await page.locator('.saved-item__text').first().click()
  return quote
}
async function fillCard(page, title, text) {
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '知识标题' }).fill(title)
  await dialog.getByRole('textbox', { name: '知识内容' }).fill(text)
  await dialog.getByRole('button', { name: '保存知识卡片', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
}
async function screenshot(page, name) {
  const file = path.join(os.tmpdir(), `paperflow-${name}.png`)
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' })
  console.log(`截图：${file}`)
}
try {
  await start(['server/server.mjs'], 'API listening')
  if (sites) await start(['scripts/gateway-local.mjs'], 'local gateway listening')
  await start(['node_modules/vite/bin/vite.js', ...(preview ? ['preview'] : []), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], `http://127.0.0.1:${webPort}`)
  console.log(`浏览器验收模式：${preview ? '生产构建 + CSP' : 'Vite 开发服务器'}；${sites ? '本机 Function 处理器网关（非平台 SDK）' : '同源 /api 代理'}`)
  if (preview) await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/verify-deployment.mjs', '--local'], { env: { ...env, PAPERFLOW_VERIFY_ORIGIN: base, PAPERFLOW_VERIFY_API_BASE: apiBase }, stdio: 'inherit' })
    children.push(child)
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`部署只读验证失败：${code}`)))
  })
  await Promise.all([register(a, '研究员甲', 'browser-a@example.test'), register(b, '研究员乙', 'browser-b@example.test')])
  await a.getByRole('button', { name: '创建空间', exact: true }).click()
  await a.getByRole('textbox', { name: '空间名称' }).fill('跨学科共读小组')
  await a.getByRole('textbox', { name: '团队简介' }).fill('围绕证据开展讨论，将研究问题沉淀为可追溯的知识。')
  await a.getByRole('dialog').getByRole('button', { name: '创建空间', exact: true }).click()
  await a.getByRole('heading', { name: '跨学科共读小组', exact: true }).waitFor()
  const teamPath = new URL(a.url()).pathname
  const teamId = teamPath.split('/').pop()
  await a.getByRole('button', { name: '编辑团队', exact: true }).click()
  await a.getByRole('textbox', { name: '团队简介' }).fill('围绕证据共读论文，记录问题、观点与研究进展。')
  await a.getByRole('button', { name: '保存名称' }).click()
  await notice(a, '空间名称已更新')
  await a.getByRole('button', { name: '生成新邀请码' }).click()
  const invite = a.getByRole('textbox', { name: '团队邀请码' })
  await invite.waitFor()
  const code = await invite.inputValue()
  await b.getByRole('button', { name: '邀请码加入', exact: true }).click()
  await b.getByRole('textbox', { name: '邀请码', exact: true }).fill('invalid')
  await b.getByRole('button', { name: '加入团队', exact: true }).click()
  await b.getByRole('dialog').getByRole('alert').filter({ hasText: '邀请码格式不正确' }).waitFor()
  await b.getByRole('textbox', { name: '邀请码', exact: true }).fill(code)
  await b.getByRole('button', { name: '加入团队', exact: true }).click()
  await b.getByRole('heading', { name: '跨学科共读小组', exact: true }).waitFor()
  assert.equal(await b.getByRole('button', { name: '生成新邀请码' }).count(), 0)
  await a.getByLabel('上传团队 PDF', { exact: true }).setInputFiles({ name: 'invalid.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not-pdf') })
  await a.getByRole('alert').filter({ hasText: '文件不是有效的 PDF' }).waitFor()
  await a.getByLabel('上传团队 PDF', { exact: true }).setInputFiles(path.resolve('public/paperflow-sample.pdf'))
  await notice(a, '论文已上传到团队')
  await a.getByRole('button', { name: '刷新概览' }).click()
  await a.getByRole('link', { name: '团队阅读', exact: true }).waitFor()
  await screenshot(a, 'collaboration-team-desktop')
  await a.getByRole('link', { name: '团队阅读', exact: true }).click()
  await renderReady(a)
  await a.getByRole('button', { name: '下一页' }).click()
  await renderReady(a)
  const quote = await highlight(a)
  const paperId = new URL(a.url()).pathname.split('/')[2]
  const readerPath = `/library/${paperId}/read?workspace=${teamId}`
  await a.getByRole('textbox', { name: '高亮笔记' }).fill('共享批注：研究过程可能需要反复验证。')
  await a.getByRole('button', { name: '保存笔记', exact: true }).click()
  await notice(a, '笔记已保存')
  await a.getByRole('textbox', { name: '高亮笔记' }).fill('共享批注已编辑：这是成员观点，不是实验结论。')
  await a.getByRole('button', { name: '保存笔记', exact: true }).click()
  await notice(a, '笔记已保存')
  await a.getByRole('button', { name: '查看 / 回复批注', exact: true }).click()
  assert.equal(await a.getByRole('button', { name: 'AI 尚未配置' }).isDisabled(), true)
  await a.getByRole('textbox', { name: '发布讨论', exact: true }).fill('这段原文如何指导可复现实验设计？')
  await a.getByRole('button', { name: '发布讨论', exact: true }).click()
  await notice(a, '讨论已发布')

  await b.getByRole('button', { name: '刷新概览' }).click()
  await b.getByRole('link', { name: '团队阅读', exact: true }).click()
  await renderReady(b)
  await b.locator('.saved-item__text').first().click()
  await renderReady(b)
  assert.equal(await b.locator('.page-counter').innerText(), '2 / 2')
  await b.waitForFunction(() => document.querySelector('textarea[aria-label="高亮笔记"]')?.value === '共享批注已编辑：这是成员观点，不是实验结论。')
  assert.equal(await b.getByRole('textbox', { name: '高亮笔记' }).isDisabled(), true)
  assert.equal(await b.getByRole('button', { name: '删除高亮', exact: true }).count(), 0)
  await b.getByRole('button', { name: '查看 / 回复批注', exact: true }).click()
  await b.locator('.discussion-thread').getByRole('button', { name: '回复', exact: true }).click()
  await b.getByRole('textbox', { name: '回复讨论', exact: true }).fill('建议先记录实验条件，再逐步验证可重复性。')
  await b.locator('.discussion-reply-form').getByRole('button', { name: '回复', exact: true }).click()
  await notice(b, '回复已发布')
  await a.getByRole('button', { name: '刷新讨论' }).click()
  await a.getByText('建议先记录实验条件，再逐步验证可重复性。', { exact: true }).waitFor()
  await a.locator('.discussion-thread').getByRole('button', { name: '创建研究问题', exact: true }).click()
  await fillCard(a, '怎样提高研究过程的可复现性？', '人工研究问题：依据原文与团队讨论，验证实验条件记录是否足够。')
  await notice(a, '知识卡片已保存')
  await a.locator('.discussion-thread').getByRole('button', { name: '整理为研究记录', exact: true }).click()
  await fillCard(a, '共读研究记录', '人工整理：甲提出问题，乙建议记录实验条件；尚未开展实验，不能作为论文结论。')
  await a.getByRole('link', { name: '打开知识库', exact: true }).click()
  await a.getByRole('heading', { name: '怎样提高研究过程的可复现性？', exact: true }).waitFor()
  const questionA = a.locator('.knowledge-card').filter({ hasText: '怎样提高研究过程的可复现性？' })
  await questionA.getByRole('button', { name: '编辑卡片' }).click()
  await a.getByRole('combobox', { name: '研究状态' }).selectOption('investigating')
  await a.getByRole('button', { name: '保存知识卡片', exact: true }).click()
  await notice(a, '知识卡片已保存')
  await questionA.getByText('贡献记录 · 2', { exact: true }).waitFor()
  await screenshot(a, 'collaboration-knowledge-desktop')

  await b.getByRole('link', { name: '打开知识库', exact: true }).click()
  const questionB = b.locator('.knowledge-card').filter({ hasText: '怎样提高研究过程的可复现性？' })
  await questionB.waitFor()
  assert.equal(await questionB.getByRole('button', { name: '编辑卡片' }).count(), 0)
  assert.ok((await questionB.innerText()).includes(quote))
  await questionB.getByRole('link', { name: /返回论文来源/ }).click()
  await renderReady(b)
  await b.locator('.discussion-thread--focused').waitFor()
  assert.equal(await b.locator('.page-counter').innerText(), '2 / 2')
  assert.ok(new URL(b.url()).searchParams.get('comment'))
  const alignment = await b.evaluate(quote => {
    const span = [...document.querySelectorAll('.textLayer span')].find(element => element.textContent?.includes(quote))
    const anchor = document.querySelector('.reader-highlight--active')
    if (!span?.firstChild || !anchor) return null
    const start = span.textContent.indexOf(quote)
    const range = document.createRange(); range.setStart(span.firstChild, start); range.setEnd(span.firstChild, start + quote.length)
    const expected = range.getBoundingClientRect(); const actual = anchor.getBoundingClientRect()
    return ['x', 'y', 'width', 'height'].map(key => Math.abs(expected[key] - actual[key]))
  }, quote)
  assert.ok(alignment && alignment.every(value => value < 3), `原文锚点误差 ${JSON.stringify(alignment)}`)
  await screenshot(b, 'collaboration-reader-desktop')

  await b.getByRole('combobox', { name: '批注可见范围' }).selectOption('')
  await renderReady(b)
  assert.equal(await b.locator('.saved-item').count(), 0)
  await highlight(b)
  await b.getByRole('textbox', { name: '高亮笔记' }).fill('乙的私密笔记，不应向甲展示。')
  await b.getByRole('button', { name: '保存笔记', exact: true }).click()
  await notice(b, '笔记已保存')
  await b.getByRole('button', { name: '存为知识笔记' }).click()
  await fillCard(b, '乙的私有知识笔记', '个人私密内容，不共享给团队。')
  await b.getByRole('link', { name: '打开知识库', exact: true }).click()
  await b.getByRole('heading', { name: '乙的私有知识笔记', exact: true }).waitFor()
  await a.goto(`${base}/knowledge`)
  await a.getByText('还没有知识卡片', { exact: true }).waitFor()
  assert.equal(await a.getByText('乙的私有知识笔记', { exact: true }).count(), 0)
  await a.goto(`${base}${readerPath}`)
  await renderReady(a)
  assert.equal(await a.locator('.saved-item').count(), 1)
  await a.getByRole('combobox', { name: '批注可见范围' }).selectOption('')
  await renderReady(a)
  assert.equal(await a.locator('.saved-item').count(), 0)

  await Promise.all([relogin(a, 'browser-a@example.test'), relogin(b, 'browser-b@example.test')])
  await b.getByRole('heading', { name: '乙的私有知识笔记', exact: true }).waitFor()
  await b.goto(`${base}/knowledge?workspace=${teamId}`)
  await b.getByRole('heading', { name: '怎样提高研究过程的可复现性？', exact: true }).waitFor()
  await a.goto(`${base}${readerPath}`)
  await renderReady(a)
  await a.locator('.saved-item__text').first().click()
  await a.waitForFunction(() => document.querySelector('textarea[aria-label="高亮笔记"]')?.value === '共享批注已编辑：这是成员观点，不是实验结论。')
  await a.getByRole('button', { name: '查看 / 回复批注', exact: true }).click()
  await a.getByText('建议先记录实验条件，再逐步验证可重复性。', { exact: true }).waitFor()
  await b.setViewportSize({ width: 390, height: 844 })
  await b.waitForFunction(() => document.querySelector('.app-main').getBoundingClientRect().left < 1)
  await screenshot(b, 'collaboration-knowledge-mobile')
  assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
  assert.ok(await b.locator('.knowledge-card').first().evaluate(element => element.getBoundingClientRect().width >= innerWidth - 60))
  await b.getByRole('button', { name: '新建知识卡片' }).click()
  await b.getByRole('combobox', { name: '卡片类型' }).selectOption('note')
  await fillCard(b, '移动端临时笔记', '用手机记录一条思考。')
  const mobileCard = b.locator('.knowledge-card').filter({ hasText: '移动端临时笔记' })
  await mobileCard.getByRole('button', { name: '删除卡片', exact: true }).click()
  await mobileCard.getByRole('button', { name: '确认删除卡片' }).click()
  await mobileCard.waitFor({ state: 'hidden' })
  await b.goto(`${base}${readerPath}`)
  await renderReady(b)
  await b.locator('.saved-item__text').first().click()
  await renderReady(b)
  await screenshot(b, 'collaboration-reader-mobile')
  assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
  await b.goto(`${base}${teamPath}`)
  await b.getByRole('heading', { name: '跨学科共读小组', exact: true }).waitFor()
  await screenshot(b, 'collaboration-team-mobile')
  await b.getByRole('button', { name: '退出空间', exact: true }).click()
  await b.getByRole('button', { name: '确认退出', exact: true }).click()
  await b.getByText('还没有团队空间', { exact: true }).waitFor()
  await b.goto(`${base}${readerPath}`)
  await b.getByRole('alert').filter({ hasText: '无权访问' }).waitFor()
  assert.equal(await b.locator('.saved-item').count(), 0)
  await b.goto(`${base}/knowledge?workspace=${teamId}`)
  await b.getByRole('alert').filter({ hasText: '无权访问' }).waitFor()
  assert.equal(await b.locator('.knowledge-card').count(), 0)
  assert.equal(modelCalls, 0)
  assert.deepEqual(errors, [])
  console.log('真实双会话浏览器（无 API 写入造数、无模型 Mock）：注册/建队/邀请码/上传/选区批注/编辑/跨账号回复/问题卡片/人工记录/贡献/原文定位/私有隔离/重登/移动端/退出失效通过。')
  const outsider = await browser.newContext()
  const outsiderPage = await outsider.newPage()
  await outsiderPage.goto(base)
  const anonymousStatus = await outsiderPage.evaluate(async ({ teamId, apiBase }) => (await fetch(`${apiBase}/knowledge?workspaceId=${teamId}`)).status, { teamId, apiBase })
  assert.equal(anonymousStatus, 401)
  const revokedStatuses = await b.evaluate(async ({ teamId, paperId, apiBase }) => Promise.all([`${apiBase}/workspaces/${teamId}`, `${apiBase}/papers/${paperId}/file`, `${apiBase}/knowledge?workspaceId=${teamId}`].map(async url => (await fetch(url)).status)), { teamId, paperId, apiBase })
  assert.deepEqual(revokedStatuses, [404, 404, 404])
  await outsider.close()
  console.log('浏览器内 API 只读断言（非 UI 操作）：未登录 401、退出后团队/PDF/知识库 404 通过。')
  if (process.env.PAPERFLOW_RUN_REGRESSIONS === '1') {
    for (const script of ['browser-test.mjs', 'library-test.mjs']) {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [`scripts/${script}`], { env: { ...env, PAPERFLOW_URL: base }, stdio: 'inherit' })
        children.push(child)
        child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${script} failed: ${code}`)))
      })
    }
  }
} catch (error) {
  console.error(output)
  await screenshot(a, 'collaboration-failure-a').catch(() => {})
  await screenshot(b, 'collaboration-failure-b').catch(() => {})
  throw error
} finally {
  await browser.close()
  for (const child of [...children].reverse()) await stop(child)
  await rm(dataDir, { recursive: true, force: true })
}
