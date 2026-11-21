# PaperFlow · 研知同行｜5A 生产部署准备与环境审计

审计日期：2026-11-21。范围：当前工作区源码、构建产物、本机运行条件、依赖公告、当前 Qoder Sites 插件契约与只读上下文。

**结论：当前不满足正式生产部署条件。** 本地协作 MVP 可用不等于生产就绪。主要阻断为已发现的依赖安全公告、Sites 路由/运行时适配、尚未实测的 PostgreSQL/S3/HTTPS 会话链路，以及迁移、恢复和运维能力缺口。真实 AI 密钥缺失不是非 AI 功能上线的阻断条件。

本轮没有创建或发布站点，没有购买或开通云资源，没有运行真实数据库迁移，没有修改既有 IndexedDB 或默认后端数据，没有调用真实模型，也没有修改业务代码或依赖。仅新增本文档、重建生成产物，并运行隔离临时 SQLite 测试。下文部署、修复和迁移步骤都是后续经授权执行的方案，不是已完成事项。

## 1. 当前架构

### 1.1 架构与源码证据

```text
浏览器
├─ React / BrowserRouter / PDF.js
├─ 本地模式 → 当前浏览器、当前来源的 IndexedDB
└─ 远程模式 → 同源 /api/*
                 ↓ Vite dev/preview 代理（仅本机）
              Express，127.0.0.1:8787
              ├─ SQLite 业务库 + 独立 SQLite 会话库
              ├─ 本地私有 PDF 目录
              ├─ 可选 PostgreSQL + PostgreSQL 会话存储
              ├─ 可选 S3 兼容适配器
              └─ 可选 Chat Completions Provider（当前未配置）
```

| 审计项 | 已实现及约束 | 主要证据 |
| --- | --- | --- |
| 前端构建 | React、TypeScript、Vite；构建执行类型检查并生成 `dist`。生产不是运行 Vite 开发服务器 | [package.json:6–29](../package.json#L6)、[vite.config.ts:5–14](../vite.config.ts#L5) |
| 路由 | BrowserRouter history 模式；`/library/:paperId/read`、`/team/:id`、`/knowledge` 等深链需要 index.html fallback | [src/main.tsx:12](../src/main.tsx#L12)、[src/App.tsx:38–50](../src/App.tsx#L38) |
| API 地址 | 认证、文献、团队、讨论、知识库、AI 均使用相对 `/api`；没有现成的通用生产 API base URL 配置。大部分请求显式 `credentials: same-origin`，AI fetch 使用浏览器默认同源凭据 | [src/services/auth.tsx:10–30](../src/services/auth.tsx#L10)、[src/services/remoteLibrary.ts:10](../src/services/remoteLibrary.ts#L10)、[src/services/aiClient.ts:7–15](../src/services/aiClient.ts#L7) |
| Node 后端 | 统一入口 `server/server.mjs`；读取 `AI_PORT`，不是通用 `PORT`；固定监听回环地址。没有生产 start 脚本、健康检查端点或 SIGTERM 优雅退出逻辑 | [server/server.mjs:20–39](../server/server.mjs#L20)、[server/server.mjs:621](../server/server.mjs#L621) |
| SQLite | 未配置 DATABASE_URL 时使用 `.paperflow-data/paperflow.sqlite`；单连接、启用外键。启动自动迁移；会话另存 `sessions.sqlite` | [server/database.mjs:8–21](../server/database.mjs#L8)、[server/server.mjs:28–36](../server/server.mjs#L28) |
| PostgreSQL | Knex pg 适配和单独的 pg 会话连接池已存在；生产强制配置。启动检查 001/002/003 迁移记录，必须先显式迁移 | [server/database.mjs:10–16](../server/database.mjs#L10)、[server/migrate.mjs:3–12](../server/migrate.mjs#L3) |
| 数据模型 | 外键、唯一约束、索引、JSON、非原生枚举和事务均有实现。001 的部分唯一索引、002 的回填 SQL 本身不是已证实的 PG 语法错误，但仍须在真实 PG 验证 | [001_initial.cjs:16–96](../server/migrations/001_initial.cjs#L16)、[002_team_collaboration.cjs:1–38](../server/migrations/002_team_collaboration.cjs#L1)、[003_research_knowledge.cjs:1–34](../server/migrations/003_research_knowledge.cjs#L1) |
| PDF 上传/访问 | 登录后上传；20 MiB 限制、扩展名/文件头检查及服务端 PDF.js 解析；随机 storage_key。下载先查论文访问权，不提供公开 PDF 目录 | [server/server.mjs:375–432](../server/server.mjs#L375) |
| 文件存储 | 本地随机文件名、独占创建，权限参数 0600；Windows 实际访问边界还取决于 NTFS ACL。S3 支持自定义 HTTPS endpoint、path-style；Put/Get/Delete 已实现 | [server/object-storage.mjs:5–37](../server/object-storage.mjs#L5) |
| 删除一致性 | 数据库事务写 object_deletions 再删论文；对象删除失败保留任务。启动及删除请求触发清理，每次最多 20 条；无定时排空/告警 | [server/server.mjs:333–339](../server/server.mjs#L333)、[server/server.mjs:443–448](../server/server.mjs#L443) |
| AI | 只在 Node 服务读取基础地址、模型和密钥；缺失时明确未配置/503，不伪造总结。Provider 限定 HTTPS（本机测试例外），禁止重定向，设超时并过滤上游错误 | [server/openai-provider.mjs:13–26](../server/openai-provider.mjs#L13)、[server/openai-provider.mjs:77–102](../server/openai-provider.mjs#L77)、[server/server.mjs:559–579](../server/server.mjs#L559) |

### 1.2 认证与网络现状

- 使用 **Cookie + 服务端 Session**，不是 JWT；密码使用 bcrypt cost 12，登录/注册后 regenerate 会话 ID，退出销毁会话。不能将此误报为“没有会话固定攻击防护”。
- Cookie 名为 `paperflow.sid`，HttpOnly、SameSite=Lax、生产 Secure、有效期七天；未配置 Domain，按当前浏览器接收响应的主机约束。开发缺少 SESSION_SECRET 会导致重启后登录失效；生产要求至少 32 字符。
- 写请求必须匹配精确 Origin 白名单，缺失 Origin 也拒绝；GET/HEAD/OPTIONS 不做此检查。这是现有 CSRF 防护的一部分，不能称为“完全没有 CSRF 防护”。当前没有 CSRF token；如果改变入口或跨站凭据策略，必须重新评估。
- `AI_ALLOWED_ORIGINS` 虽名为 AI，统一后端也用它限制所有写请求。它**不是** CORS 配置：服务没有完整 Access-Control-Allow-Origin/Credentials 及预检处理。Vite 的 `changeOrigin: true` 改的是上游 Host，不是允许任意网页跨域。
- 原始 Host 只接受 `127.0.0.1:AI_PORT` 或 `localhost:AI_PORT`。生产 `trust proxy = 1` 依赖恰好受信任的代理拓扑，不能把客户端伪造的 X-Forwarded-* 直接传入。
- 参考 [server/server.mjs:23–54](../server/server.mjs#L23)、[server/server.mjs:69–108](../server/server.mjs#L69)。

### 1.3 本机条件与本轮验证

| 检查 | 结果及证据边界 |
| --- | --- |
| 实际 shell 运行时 | Node **v22.19.0**，npm **10.9.3**；Node 路径为 `D:\Program Files\nodejs\node.exe`。宿主元信息显示另一个 Node 版本，部署以实际可执行文件为准；项目最低要求 22.13.0，不等于该版本仍满足未来安全基线 |
| 外部服务条件 | 进程环境未设置 DATABASE_URL、S3、SESSION_SECRET、AI 凭据；根目录只有 `.env.example`，没有真实 `.env*` 配置。未在 PATH 找到 psql、pg_dump、aws；有 Docker CLI，但 Docker Desktop Linux engine 管道不可用。未启动引擎或扫描网络，不能据此断言整台机器绝无其他服务 |
| 构建 | 本轮 `npm run build` 通过，实际 Vite 6.4.6。产物 11 个文件、2,168,675 字节，最大约 1.23 MB 的 PDF Worker；仅按体积看低于 Sites 文档的 50 MiB artifact 限制，尚未打包/上传验收 |
| 产物隐私检查 | 未发现 `.env`、SQLite、私钥、source map 文件或 AI_API_KEY/S3_SECRET_ACCESS_KEY/SESSION_SECRET/DATABASE_URL 等敏感标记；这是有限扫描，不是完整泄密审计。public 只有 favicon 和原创 PDF 样本；真实用户 PDF 不在其中 |
| 后端测试 | 本轮 `npm run test:backend` 通过；使用脚本自建临时目录、随机端口、真实 SQLite/文件系统与测试账户，强制清空 PG/S3/AI Key。覆盖重启会话、团队/个人隔离、来源约束、退出后拒绝访问、删除等；不是 PostgreSQL/S3 测试，也不是浏览器测试 |
| 浏览器证据 | 第四阶段真实双浏览器会话、移动端及本地阅读器已有通过记录。本轮没有 UI 修改，没有重新声称云端浏览器或生产 Cookie 验收通过 |
| Sites 上下文 | 只调用了 get_context；本目录返回 sites=[]、developmentSites=[]，未返回 unavailableSites。Desktop 支持专用 Secret 输入，但当前没有本项目站点或部署结果可验收 |
| 未执行 | 真实 PG/S3/模型调用、生产 HTTPS/反向代理、云端 Cookie/SPA/文件权限、恢复演练、容量测试及部署 |

本地依赖还包括：Vite 代理、固定回环绑定、开发端口、当前目录解析的数据路径、SQLite 原生模块及浏览器同源存储。新生产域名看不到 localhost 的 IndexedDB；切换域名不是数据同步。

### 1.4 依赖安全审计：已获得有效报告，不再只是镜像阻塞

第一次 `npm audit --json --fetch-retries=0 --fetch-timeout=15000` 被现用 npmmirror 的审计接口 404/NOT_IMPLEMENTED 阻断。随后用**单次命令参数**指定官方接口，未改变 npm 配置：

```bash
npm audit --json --registry=https://registry.npmjs.org --fetch-retries=0 --fetch-timeout=15000
npm ls pdfjs-dist vite sqlite3 tar react-router-dom express --depth=3
npm ls tar --all
```

第二次返回完整审计 JSON，退出码 1 表示发现风险，不是接口不可用。报告统计为 **8 个受影响依赖条目：1 critical、5 high、2 low**；不等于八种独立漏洞，更不表示已复现八条攻击链。

- `pdfjs-dist` 实装 **5.7.284**，落入审计报告的 `>=5.6.83 <6.2.108` 范围；公告 [GHSA-hq66-cqwq-w95j](https://github.com/advisories/GHSA-hq66-cqwq-w95j) 描述打开恶意 PDF 时的任意 JavaScript 执行风险。项目浏览器与服务端确实解析用户 PDF，必须优先核实适用条件并修复；本轮未运行恶意样本或断言已被利用。
- `connect-sqlite3@0.9.18 → sqlite3@5.1.7` 及其构建链保留 **tar@6.2.1**；对应锁文件条目含 optional=true，但不是 dev-only。另一个顶层 sqlite3@6.0.1 使用 tar@7.5.23，不能据此忽略旧嵌套副本。
- tar 报告包含路径穿越、文件覆盖和资源耗尽等公告，最高等级 critical，例如 [GHSA-23hp-3jrh-7fpw](https://github.com/advisories/GHSA-23hp-3jrh-7fpw)、[GHSA-34x7-hfp2-rc4v](https://github.com/advisories/GHSA-34x7-hfp2-rc4v)。它主要涉及依赖安装/归档处理链；未发现应用提供任意 tar 上传解包端点，不能直接等同于可远程利用的 PaperFlow API 漏洞。
- 其余受影响条目为 cacache、make-fetch-happen、node-gyp、sqlite3、http-proxy-agent、@tootallnate/once，部分是风险传递。
- 不执行 `npm audit fix --force`。报告部分 fixAvailable 建议回退 sqlite3 到 5.0.2，不能机械接受。后续需评估受支持版本/构建链调整、PDF.js 升级兼容性，保留本地存储功能并回归；仅切到 PG 不会自动移除顶层 import 的 SQLite 包。

## 2. 推荐生产架构

### 2.1 Qoder Sites 能力核实矩阵

依据当前宿主内置 Sites 技能文档及实际工具 schema；**文档支持、项目适配、云端实测是三件事**。没有为核验而创建资源。

| 能力 | 当前可确认结论 | 对 PaperFlow 的影响 |
| --- | --- | --- |
| 现有 Node/Express 常驻进程 | 当前发布契约是静态 Web + `edge` Function，入口 index.ts / HTTP handler（如 Deno.serve），明确不是 Express 启动命令或常驻后台进程 | 不支持直接上传 server 目录启动现有 API；sqlite3/native 模块、磁盘目录、Knex 事务不能靠复制 node_modules 搬过去 |
| 持久化数据库 | Sites 有 database/functions/storage 能力；新数据库走 function_backend 和平台 SDK、迁移/权限契约 | “平台有数据库”不等于给外部 Node 提供可用 PG DSN，也不等于兼容当前 Knex schema/session。保留独立 PostgreSQL，勿擅取平台内部连接凭据 |
| 环境变量/服务端密钥 | Function 支持应用 Secrets，服务端 Deno.env 读取；Desktop 专用输入可用；DATABASE_URL、POSTGRES_*、SUPABASE_*、QODER_* 等名称保留 | Node 的数据库/S3/会话密钥放 Node 托管方 Secret 系统，不迁入前端或保留名称。静态构建变量是公开内容，不是密钥保险箱 |
| SPA 刷新 | prepare_site 的 spa=true 支持 index.html fallback，返回 200 | 前端具备静态 SPA 适配基础；需验收深链、PDF Worker/MIME。缺失脚本也可能返回 HTML 200，不能只检查状态码 |
| 任意 API 反向代理 | 当前 prepare/schema 不提供任意 rewrite/proxy 配置；应用 Function 入口 `/functions/v1/app`，`/api` 属平台保留命名空间 | 当前 `/api/*` 不能照搬；Vite proxy 不会被上传后自动生效。需要薄 Function 转接或另一套经过验证的网络架构 |
| 域名 | update_site 只支持显示名或平台 subdomain 前缀；未发现绑定自有域名/证书的受支持入口 | 不能把“改平台地址前缀”写成“已支持任意自定义域名”；自有域名须另行得到平台能力确认，不作为首版前提 |
| HTTPS | 现有应用认证参考以 HTTPS 正式 Host 为预期入口；本项目尚无实际分配的站点 | 没有本项目证书/续期/HTTP 跳转/HSTS 的实测证据。部署时须验证真实 Host；外部 API 的 TLS 独立配置和验收 |

本次查阅的本机平台参考（插件升级后须重新核验）：

- [static-site.md:20–42](file:///D:/tool/Qoder/resources/extensions/qoder.sites/dist/plugin/skills/sites-building/references/static-site.md#L20)：SPA、保留路径及包限制。
- [functions.md:3–7](file:///D:/tool/Qoder/resources/extensions/qoder.sites/dist/plugin/skills/sites-building/references/functions.md#L3)：edge 运行时，而非 Express。
- [functions.md:48–65](file:///D:/tool/Qoder/resources/extensions/qoder.sites/dist/plugin/skills/sites-building/references/functions.md#L48)：Secrets 与数据库依赖。
- [function-backend.md:34–57](file:///D:/tool/Qoder/resources/extensions/qoder.sites/dist/plugin/skills/sites-building/references/function-backend.md#L34)：数据库 SDK/身份边界；不是任意跨请求事务替代品。
- [application-auth.md:98–130](file:///D:/tool/Qoder/resources/extensions/qoder.sites/dist/plugin/skills/sites-building/references/application-auth.md#L98)：应用 Cookie/Authorization 透传依赖 Worker/Gateway 能力，旧版本可能剥离凭据。
- [deployment.md:17–37](file:///D:/tool/Qoder/resources/extensions/qoder.sites/dist/plugin/skills/sites-hosting/references/deployment.md#L17)：真实发布输入，不执行构建、不自动迁移。
- [sites-management/SKILL.md:30–36](file:///D:/tool/Qoder/resources/extensions/qoder.sites/dist/plugin/skills/sites-management/SKILL.md#L30)：平台子域名前缀编辑范围；另核对了实际 update_site 工具 schema。

### 2.2 首选方案 A：Sites 前端 + 薄转接层 + 独立 Node/PG/S3

这是**有验收门槛的推荐方案，转接层尚未实现**，不是当前代码可一键发布的承诺。

```text
浏览器 → Qoder Sites HTTPS 站点
          ├─ dist 静态 SPA
          └─ 同源 /functions/v1/app/api/*
                    ↓ 薄 Function 转接（固定目标，不承载科研业务或数据库）
                 外部 API HTTPS 入口 /api/*
                    ↓ 受信任反向代理
                 同机 Node 127.0.0.1:8787
                    ├─ 私网/TLS PostgreSQL（业务 + Session）
                    └─ 私有 S3 兼容 Bucket
```

必需的后续改动及验收门槛：

1. 收敛全部前端请求入口，包括 auth、remoteLibrary、workspaces、comments、summaries、knowledge、aiClient；将 Sites 发布版业务请求映射到 `/functions/v1/app/api/*`。本轮不添加一个实际上没人读取的环境变量冒充适配完成。
2. 转接层只允许固定 HTTPS API 目标与明确路径/方法，保留查询参数、JSON 和 multipart 二进制；剥离平台身份/保留头，不能把 Qoder 登录 token 当 PaperFlow 会话，不能成为任意 URL 代理。
3. 验证 `paperflow.sid` 的请求 Cookie、响应 Set-Cookie（包括退出清除）、Secure/HttpOnly/Path/SameSite，以及跨发布、刷新、下载的实际行为。若 Gateway/Worker 剥离凭据，先修复正式支持链路，不在 localStorage 存会话替代。
4. 保留真实浏览器 Origin 并验证；不得把任何非法/缺失 Origin 一律改成允许值。Node 的白名单填 Sites 实际前端来源。服务端转接本身不需要浏览器 CORS，但仍需要端到端 CSRF 验证。
5. 在目标环境确认 Function/Gateway 能传递 **20 MiB PDF + multipart 开销**、PDF 响应和所需超时；核验请求/响应上限、内存、外连及费用。静态 ZIP 50 MiB 上限不代表 Function HTTP 请求也允许 50 MiB。
6. 外部 API 入口采用受信任转接来源限制或经审查的服务间认证；新凭据只放专用 Secret 系统。不得把 Origin 当作服务器调用者身份。
7. 正确区分代理连接 IP 与可信终端 IP。未经验证的 X-Forwarded-For 不能采信；只把 Function IP 传给现有 30 次/15 分钟限流又会让所有用户共享配额。上线前完成可信 IP/账号限流设计并验证，而不是简单增大 trust proxy。
8. 平台站点访问控制与 PaperFlow 账号是两层独立边界；默认私有站点可能先要求 Qoder 准入。须确认真实受众能访问，不能擅自改公开，也不能以平台登录替代科研资源权限。

在 Cookie 透传、20 MiB 文件或代理安全门槛任一未通过时，**停止方案 A 的完整产品发布**。无需为保留现有系统而把全部 Express/Knex 业务重写为平台 Function。

### 2.3 备选与明确不推荐的捷径

- **备选 B：同源入口托管静态前端 + 独立 Node 进程 + PG/S3。** 经用户同意后，使用可控 HTTPS 反向代理分别服务 dist 与 `/api`，例如同一主机的静态 Web 服务和 Node API。这保留现有 Cookie/相对 API 的语义，改动较小；代价是不以 Sites 承载产品前端，且自行承担证书、静态分发和运维。
- **Sites 页面直接跨站请求外部 API**不是零改动备选。当前 `same-origin` 凭据、Lax Cookie、没有 CORS 预检均不满足它。不同站点域名通常还要 SameSite=None; Secure + credentials=include + 精确 ACAO/ACAC/预检 + CSRF 防护；第三方 Cookie 屏蔽仍可能使登录失败，不能只改 CORS 就承诺可用。
- 若未来已确认 Sites 支持自有域名，可以另行评估同站点子域名分离（仍然跨 origin，需要 CORS/include）；当前没有该能力证据。成熟 token/OIDC 方案也是另一个认证项目，不在 5A 偷换为 JWT。
- 不把平台内部 `/api`、Vite dev proxy、静态 HTML fallback、公开 Bucket或浏览器内置密钥当作后端替代。

### 2.4 服务与费用待核验

不报价、不承诺“永久免费”，本轮未开通任何服务。采购前逐项记录套餐、地域、币种、税费、免费期/额度、超额行为和预算告警。

| 服务 | 必需核验的费用、限制与运行条件 |
| --- | --- |
| Qoder Sites 静态托管 | 站点/访客权限、构建包额度、流量、访问次数、地区可达性、正式 HTTPS、数据驻留；方案 A 另需 Functions |
| Sites Functions | 调用次数、CPU/内存/超时、请求/响应体上限、出网费用、冷启动、应用 Cookie 支持和日志保留；不得从静态套餐推断 |
| Node 托管 | 常驻进程、休眠规则、实际受支持 Node LTS、内存/CPU、发布流量、出网、重启和日志；当前回环绑定适合同机代理，不能直接适配要求 0.0.0.0:$PORT 的平台 |
| PostgreSQL | 存储、连接数、私网/TLS、计算/休眠、PITR、自动备份/恢复、跨区和出网；Knex 池上限 10，另有独立 Session 池，需按实例总数计算预算 |
| S3 兼容存储 | 容量、PUT/GET/DELETE 请求费、下载与跨区流量、版本历史、备份副本、加密费用、最小计费与生命周期规则 |
| 域名与 TLS | 外部 API 域名、注册/续费、DNS、证书管理；Sites 自定义域名尚未确认，不能先购买再假定支持 |
| 日志/监控/备份 | 保留期、索引、告警、异地副本、恢复演练及隐私访问控制 |
| AI | 当前三项留空、无调用费用；未来启用前另核计费、额度、模型、数据政策及授权 |

## 3. 部署前检查

下列复选框均是**未完成的发布门槛**，不因本地测试通过自动勾选。

- [ ] 解决 PDF.js 高危公告，审查并处置 tar/SQLite 构建链告警；重跑全量及 `--omit=dev` 官方依赖审计，记录适用条件和残余风险批准，禁止强制降级“清零”。
- [ ] 确定方案 A 或 B、正式来源/访问范围、运行地域、预算和负责人；方案 A 通过 Cookie/文件大小/超时/受信任转接验证。
- [ ] 固定受支持且已打补丁的 Node 版本和锁文件；在目标 OS 用 npm ci 可复现安装，验证 sqlite3 等原生依赖，不复制 Windows node_modules 到 Linux。
- [ ] 准備隔离 PostgreSQL 和私有 S3 测试资源并完成真实联调；采用独立 staging/prod 数据库、Bucket及凭据，不共用测试账号和真实数据。
- [ ] PostgreSQL TLS 证书校验在 Knex 与 Session 两个客户端均生效；若供应商要求自定义 CA，验证真实驱动/DSN配置，不设置 NODE_TLS_REJECT_UNAUTHORIZED=0。
- [ ] 完成 001→002→003 空库迁移及带历史数据升级、约束/级联/JSON/Session 到期测试。现有测试脚本强制使用 SQLite，单纯传 DATABASE_URL 不会变成 PG 测试。
- [ ] 单独的迁移账号/应用最小权限账号；迁移只由一个发布步骤执行，应用账号可访问业务、会话及迁移记录但不具备无关管理权限。
- [ ] S3 Bucket 禁止公共读写、最小对象权限、默认加密、版本/备份及生命周期策略；实际验证匿名下载被拒绝。
- [ ] 修复总结保存入口来源复核缺口；配置上传配额/并发/请求限制、错误日志脱敏、健康检查和优雅退出。
- [ ] HTTPS 代理、Host、Origin、Cookie 和可信客户端 IP 经过实际双用户浏览器验收；补充适配后的 CSRF 负向测试和安全响应头。
- [ ] 审核注册受众、邮箱验证/账号恢复/MFA政策；公开注册前解决滥用与账号恢复，封闭试点也需明确人工恢复与访问控制方案。
- [ ] 完成全量备份与隔离恢复演练、迁移对账、回滚演练、监控/值班安排；确认可接受 RPO/RTO。
- [ ] 冻结可恢复的发布源代码、锁文件、构建产物、迁移清单及校验和。当前目录没有 Git；这不妨碍方案设计，但必须建立可靠版本归档，不能只留本机 dist。
- [ ] 区分演示工作台与真实团队统计；不把 Dashboard 演示论文/进度当生产用户数据。AI 未配置提示保留，避免暗示系统已完成真实模型联调。

## 4. 部署操作步骤

**以下仅为后续执行手册；先获得实施/资源/迁移授权，且第 3 节门槛通过后再操作。** 本轮没有执行本节云端或生产命令。

### 4.1 构建与发布候选

1. 在独立构建环境取已归档源码及锁文件；选择经核验的运行时。构建环境不得注入真实 AI、S3、数据库或会话密钥。
2. 安装、审计、类型检查并构建；有风险时进入修复流程，不继续发布。

```bash
node --version
npm --version
npm ci
npm audit --json --registry=https://registry.npmjs.org
npm audit --omit=dev --json --registry=https://registry.npmjs.org
npm run build
```

3. `dist` 仅含可公开静态文件；再次检查密钥、source map、源码、真实 PDF/账户数据，记录校验和。后端包包含 server、迁移、package/锁文件等所需内容，不包含 `.paperflow-data` 或真实 `.env`。
4. 后续依赖更新必须测试目标运行时、PDF Worker、中文 PDF、文本选区/缩放/刷新、本地导入、协作权限；不能为适配 PG 删除仍被本地开发使用的 SQLite 功能。

### 4.2 隔离服务准备与迁移

1. 经批准分配 staging PG 与 S3；先验证 TLS、ACL、网络和备份，切勿使用真实库运行测试脚本。
2. 用迁移专用身份安全注入 DATABASE_URL 等变量；确认实际数据库名/环境标签和备份编号，密码不得进入终端历史或日志。
3. 执行下列命令只创建/升级目标数据库结构，**不会导入原 SQLite 业务数据或复制 PDF**。采用直接 Node 入口，避免脚本意外加载工作区旧 `.env`。

```bash
node server/migrate.mjs
node server/server.mjs
```

4. 运行前须确保进程环境已注入 `NODE_ENV=production` 及第 5 节全部必需值。生产服务不会自动补迁移；缺少 PG、S3或合格 SESSION_SECRET 时应失败关闭，不能临时改 development 绕过。
5. 使用应用身份启动长期运行的 API；由服务管理器监控、自动重启并设置最小权限。不要运行独立 `dev:ai` 作为生产 API，它没有统一后端完整账号/权限链，也与统一后端争用端口。
6. 当前程序监听 `127.0.0.1:8787`，因此首版宜选同机 HTTPS 代理的受控主机。容器跨网络命名空间、托管平台 PORT/0.0.0.0、健康探针需要先适配代码，不在文档中假定已经支持。
7. 后续增加 live/ready 检查并单独测试：存活不查询敏感数据，就绪检查依赖且失败返回不可服务；新增之前没有现成 `/health`。`/api/ai/status` 的 200 只证明请求可达，不能证明数据库/对象存储就绪。

### 4.3 HTTPS、代理与网络

- 外部只开放必要 HTTPS 入口；Node 回环端口、PG 与私有存储控制面不直接对浏览器开放。PG 尽量私网，外部连接严格 TLS；S3 经 HTTPS。
- 代理必须把后端收到的 Host 设为 `127.0.0.1:8787`，同时保留原浏览器 Origin。终止 TLS 后提供正确的 X-Forwarded-Proto；连接拓扑与 trust proxy 一致。
- 禁止缓存 `/api` 的私有数据和 Set-Cookie；后端已有 Cache-Control:no-store，但仍需验证 CDN/Function 未覆盖。静态哈希资产可长缓存，index.html 应能及时重新验证。
- 以下仅是**方案 B 的单跳同源 Nginx server 内配置片段**；证书、server_name、防火墙、路径和安全头另行配置。`/srv/paperflow/current/dist` 是待创建的部署路径示例，不是本机已存在目录。

```nginx
root /srv/paperflow/current/dist;
client_max_body_size 21m;

location ^~ /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host 127.0.0.1:8787;
    proxy_set_header Origin $http_origin;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Host "";
    proxy_read_timeout 150s;
    proxy_cache off;
}

location /assets/ {
    try_files $uri =404;
}

location / {
    try_files $uri $uri/ /index.html;
}
```

21 MiB 代理限制为 20 MiB 文件外的 multipart 元数据留余量，应用仍保留 20 MiB 文件硬限制。禁止把数据目录放入静态根目录。代理要覆盖用户提供的转发头而不是盲目累加；如前面还有 CDN、BFF或负载均衡，上述 IP 处理需要重新设计，不能原样宣称适用。

方案 A 的 Node 前置代理同样需正确 Host/Proto，但其来源认证、可信终端 IP与原始 Origin 的传递必须按 2.2 单独落地；不能把这段 Nginx 配置当作已经实现的 Sites 转接层。

### 4.4 Sites 前端发布路径（仅方案 A）

1. 先实现并在授权的隔离环境验证薄 Function 和全部请求前缀适配，完成二进制/会话/拒绝路径测试；不替换现有账号体系。
2. 经授权准备完整站点，使用真实项目目录、`webDirectory: dist`、`spa: true`、真实自包含 functionDirectory。转接层不读平台数据库时设置 databaseAccess=none；不需要为它额外开通 Sites 数据库或 Storage。
3. APP_API_ORIGIN、转接凭据等仅是**拟新增 Function 配置**，通过受支持的专用 Secret 输入配置，先验证同步；不能传进前端构建。Node DATABASE_URL 等只放外部 API 服务。
4. 使用当前 Sites 技能的 prepare → 就绪核验 → publish → 状态核验流程；普通“ready”或静态预览不等于发布成功。受众范围按明确授权处理，不擅自公开。
5. 发布后实际验证业务、访问范围、HTTPS、深链刷新和 Set-Cookie；确认发布状态与线上版本一致。站点可打开但 API 不工作时，报告“静态部分可用，产品未完成”，不报全栈上线成功。
6. 任一平台门槛不满足时暂停，提交方案 B 供用户决定，不重复创建站点、扩大权限或购买资源绕过。

### 4.5 正式切换

staging 验收后才进入维护窗口：停止旧系统写入 → 一致性备份 → 导出/迁移/文件对账 → 启动新环境 → 小范围验收 → 经批准开放受众。旧数据与源码保持可恢复但不允许新旧系统同时接收独立写入；观察会话、错误率、存储和数据库指标后再结束窗口。

## 5. 环境变量模板

以下是**独立 Node 服务**模板。`__...__` 必须在 Secret 管理系统替换为真实值；它们不是可用配置。不得把真实值填入本文档、聊天、命令参数、前端或版本库。

```dotenv
NODE_ENV=production
AI_PORT=8787
AI_ALLOWED_ORIGINS=__EXACT_FRONTEND_HTTPS_ORIGIN__
SESSION_SECRET=__RANDOM_SECRET_AT_LEAST_32_CHARACTERS__
DATABASE_URL=__PRIVATE_POSTGRES_CONNECTION_WITH_VERIFIED_TLS__
S3_BUCKET=__PRIVATE_BUCKET_NAME__
S3_REGION=__PROVIDER_REGION__
S3_ACCESS_KEY_ID=__SCOPED_SERVICE_ACCESS_KEY__
S3_SECRET_ACCESS_KEY=__SCOPED_SERVICE_SECRET_KEY__
S3_ENDPOINT=
AI_BASE_URL=
AI_MODEL=
AI_API_KEY=
AI_TIMEOUT_MS=30000
```

| 变量/配置 | 用途及要求 |
| --- | --- |
| NODE_ENV | 必须 production；启用 Secure Cookie、生产配置门槛和代理信任逻辑 |
| AI_PORT | 统一 API 的端口；有效整数，默认 8787，必须与代理一致。当前不读取 PORT/BIND_HOST |
| AI_ALLOWED_ORIGINS | 填真实前端的 scheme + host + 必要端口，无路径/尾随斜杠；逗号分隔精确来源。不使用 `*`，生产去掉 localhost 与未经审核的预览来源 |
| SESSION_SECRET | 持久、随机，至少 32 字符，建议由密钥系统生成；多实例一致。轮换会影响现存会话，当前没有多密钥平滑轮换接口 |
| DATABASE_URL | 指向隔离且明确的 PG 目标；同时用于 Knex 和 Session Pool。迁移与运行可注入不同权限身份；TLS/CA 两条连接均需实测 |
| S3 四项必填 | Bucket、Region、Access Key ID、Secret Access Key 必须齐全。程序不验证 Bucket 是否私有，不替运维创建 Bucket或策略 |
| S3_ENDPOINT | 使用 AWS 默认 endpoint 时可留空；兼容服务填实际 HTTPS endpoint，代码启用 forcePathStyle。没有 S3_SESSION_TOKEN 支持，也没有使用默认 IAM role 凭据链的实现，须按供应商身份方案另评估 |
| AI 三项 | 当前保持全空；Provider 代码保留。将来只有明确授权发送论文片段并接受计费后才配置，不自动运行真实模型测试 |
| AI_TIMEOUT_MS | 默认 30000，代码约束 1000–120000；代理/Function 超时需协同但不因此启用 AI |
| PAPERFLOW_DATA_DIR | 本地开发/隔离测试可设独立目录；生产 PG/S3 路径不以它提供持久化。不得把它当缺少外部服务时的生产降级方案 |

普通前端没有需要保密的配置。不得创建 `VITE_AI_API_KEY`、`VITE_DATABASE_URL` 或把 process.env 整体注入前端。候选 `VITE_API_BASE_URL` **尚未被当前代码读取**；只有完成入口适配后才可作为公开配置讨论。

方案 A 新增的 Function 参数候选为 APP_API_ORIGIN（固定可信目标）、APP_GATEWAY_TOKEN（若采用服务间认证）；不是现有应用已支持的变量。原始浏览器来源应来自可信校验链，而不是靠一个参数强行覆写。不得借用平台保留 DATABASE_URL 或管理 PAT。

## 6. 数据迁移和备份方案

### 6.1 三种数据不能混为一谈

1. **浏览器 IndexedDB**：绑定用户浏览器/设备/旧来源。生产域名无法读取 localhost 的本地库。现有“导入本地文献”只会读取当前来源的数据，不能自动完成跨域迁移。
2. **服务端 SQLite 业务库 + 本地 PDF**：需要明确的 ETL/文件复制；修改 DATABASE_URL 或执行 Knex migrate 不会迁走这些数据。
3. **Session**：本地 connect-sqlite3 的 sessions.sqlite 与 PG 的 session 表不是同一个格式/存储入口。默认不迁移旧会话，让用户重新登录；业务用户 UUID 和 bcrypt 密码哈希保持，不要求明文密码。

源文件参考 [src/services/localImport.ts:38–85](../src/services/localImport.ts#L38)。现有导入不迁移团队关系、不保证保留时间戳，不能替代服务端数据库迁移。

对旧浏览器数据的建议：先保留旧浏览器来源与本地 PDF 备份；在后续明确授权下准备同来源的迁移桥接或审核过的离线导出/导入工具，再由用户逐项确认导入目标。不修改或删除原 IndexedDB，不要求清理缓存，也不承诺当前生产页直接读到旧数据。

### 6.2 一致性备份

- 迁移前安排维护窗口，确认所有 API 写入者停止；5A 没有停止用户现有进程。
- SQLite 应使用一致性备份机制，或在正常停服后复制完整数据目录（业务库、会话库及存在的 WAL/SHM、PDF），保留文件权限/ACL。不能只复制一个正在写入的 `.sqlite` 并声称完整。
- 同时归档版本、迁移列表、表计数、对象清单、大小和 SHA-256；数据和密钥分开保管。备份本身包含敏感论文、账号和密码哈希，应加密并限制访问。
- PG 采用自动备份/PITR及独立逻辑备份，S3 采用版本或独立私有备份副本；验证供应商是否支持。S3 的版本功能不自动等于跨账户备份。
- 初始建议目标为 RPO ≤24 小时、RTO ≤4 小时，仅是待业务批准和演练的目标；切换前最终停写快照应无遗漏。需要更低 RPO 时配置并验证 PITR/对象版本，不口头保证零丢失。

未来备份/恢复可用以下标准工具流程，PGHOST/PGPORT/PGDATABASE/PGUSER/PGSSLMODE 和密码由安全的 libpq 配置注入，避免 URI 密码出现在参数中：

```bash
pg_dump --format=custom --no-owner --file="$BACKUP_FILE"
pg_restore --list "$BACKUP_FILE"
pg_restore --no-owner --no-privileges --exit-on-error --single-transaction --dbname="$RESTORE_DB" "$BACKUP_FILE"
```

先验证 BACKUP_FILE 指向新的受控文件、RESTORE_DB 指向已创建的**独立空恢复库**；不使用 `--clean`，不恢复覆盖在线生产库。备份工具版本须兼容实际 PG 服务端。本机尚无 pg_dump/psql，因此上述操作尚未演练。

### 6.3 SQLite → PostgreSQL + S3 迁移步骤

当前**没有完整的 SQLite→PG ETL 脚本**，这是待实现项，不得用不适配的 SQLite SQL dump 直接灌 PG。后续脚本先在备份副本上开发和演练：

1. 冻结源备份并确认 schema 版本。源若不是 003，在复制出来的隔离库按既有迁移升级，保留升级前副本；不要在旧真实库上试运行。
2. 在空 PG 目标执行项目 001/002/003，验证结构；不要把源 knex_migrations/lock 盲目覆盖目标的迁移历史。
3. 按依赖顺序导入：users → workspaces → workspace_members → papers → workspace_papers/reading_progress → annotations → notes → comments 主帖/回复 → discussion_summaries → workspace_invites → knowledge_cards → knowledge_contributions → object_deletions。无需来源的表可以分批，但必须遵守外键。
4. 保留主键 UUID、所有者/成员/团队关联、时间戳、摘要标记及密码哈希。将 SQLite 的 rects JSON 文本正确转为 PG JSON 值，不能双重字符串化；普通 content 文本保持原类型。会话默认不导入。
5. 使用清单逐一复制 PDF 到全新、私有的目标 Bucket，**保留 papers.storage_key**。程序没有对象前缀配置，不能任意加目录而不更新映射。校验 SHA-256/字节数及对应 paper_id；不要把 multipart ETag 当 SHA-256。
6. 上传复制与数据库写入不能跨系统原子提交。用可恢复的迁移清单记录完成状态，全部对账通过后才放流量；目标冲突先停下核对，不覆盖其他用户的记录或对象。
7. 不把已排队删除的对象当正常 PDF重新导入。object_deletions 应保留并审查；**在启动 API 自动 cleanupObjects 之前**，确认测试/恢复环境使用隔离 Bucket，避免误删原环境对象。
8. 比较各表计数、主外键、唯一 Owner、孤儿引用、PDF hash、知识来源范围、贡献历史；用两个测试账号验证私有/团队隔离和源文定位。敏感业务行不输出到公共日志。
9. 完整记录成功/失败项及切换时间，确认回滚快照有效后才开放写入。旧 SQLite/PDF 保留至批准的保留期结束，不在迁移后自动清理。

### 6.4 日常恢复与删除对账

- 定期在新的 DB/Bucket 恢复一组匹配时间点的数据，运行权限和 PDF 对账，再记录真实恢复耗时与数据损失窗口。
- 对 object_deletions 积压、DB 有记录但文件缺失、对象无对应业务记录分别告警；后续实现有节流和可观测性的排空任务。不能仅靠每次启动处理 20 条。
- 版本化 Bucket 中的 DeleteObject 可能只创建删除标记；合规删除、旧版本保留和备份清除须按政策管理，不能声称 API 删除后所有历史副本立即消失。
- 原则上保留贡献历史的业务含义；当前删除知识卡片会级联删除其贡献行，它不是不可篡改的安全审计日志。

## 7. 验收测试

### 7.1 本轮证据与后续验收的区分

| 类别 | 已有证据 | 后续要求 |
| --- | --- | --- |
| 构建/类型 | 本轮通过 | 依赖修复和网络适配后重跑 |
| SQLite API 集成 | 本轮隔离实库/文件通过 | 不能替代 PG/S3/HTTPS 测试 |
| 真实浏览器交互 | 第四阶段双独立会话/移动端通过；本轮未重跑 | 在最终发布来源、真实代理/PG/S3上重跑，使用隔离 staging 数据 |
| AI Mock | 前轮 team、ai-server 等用本机假供应商 | 只验证协议/来源过滤，不证明真实模型可用 |
| 真实 AI | 本轮不运行，未配置 | 不作为无 AI 发布条件；未来需额外授权 |
| 云端/恢复/容量 | 未验证 | 下列门槛逐项留证，不用静态预览替代 |

后续本地回归可复用：

```bash
npm run build
npm run test:backend
npm run test:import-browser
PAPERFLOW_RUN_REGRESSIONS=1 npm run test:collaboration-browser
npm run test:team
npm run test:ai-server
```

这些后端/浏览器隔离脚本默认清空 DATABASE_URL/S3，不能把其成功标作真实外部服务验收。新增 PG/S3 harness 或审核后的 staging 浏览器流程必须明确目标与清理范围，绝不对真实用户数据运行创建/删除测试。不运行 `test:ai-provider`、`test:ai-real`。

### 7.2 正式环境发布门槛

- **静态与路由**：直接打开/刷新登录、团队、知识卡片来源深链和阅读器；无效资源不返回被误判为 JS/PDF 的 HTML；PDF Worker MIME/CSP正确。桌面/手机均可用。
- **认证与 Cookie**：注册/登录、刷新、后端重启、退出后旧 Cookie 失效；Secure/HttpOnly/SameSite/Path 正确，无密钥/Session ID 出现在 localStorage或前端产物。
- **代理与 CSRF**：允许来源成功；恶意来源、缺 Origin、伪造 Host、伪造转发头被拒绝或安全处理；转接不能把非法来源洗成合法。若选跨域路径则单独验证预检、凭据及第三方 Cookie 限制。
- **双账号权限**：Owner/Member/非成员的论文、PDF、批注、私人笔记、讨论、知识库都按服务端授权；退出/移除后的后续请求拒绝。若成员仍是论文所有者或属于另一个共享团队，保留其合法论文权限，不能误测为所有访问都必须 404。
- **并发撤权**：新增在途上传/回复/知识创建与退出/移除竞争测试；目前“后续请求立即检查”不代表长请求事务期间具备严格原子撤权。
- **文件与 S3**：非法/空/损坏/加密/超限 PDF；实际 20 MiB 边界与代理开销；匿名对象访问拒绝、合法账户可读、非成员不可读；PDF字节/hash一致，删除重试与版本策略符合设计。
- **PG**：空库与历史升级、外键/唯一/枚举/check、JSON读写、Session JSON/expire、事务回滚、重启、多实例连接预算及限流一致性。
- **来源完整性**：保存总结时不能伪造引文/跨团队来源/模型身份；人工卡片和 AI 推断标注清楚。成员标注原文仍是客户端输入，引用真实性与权限校验应分别表述。
- **AI 未配置**：基础业务全部可用；AI状态明确，生成返回未配置；无真实模型出网、无假总结。未来启用另做原文权限/额度/来源/隐私验收。
- **日志/故障/恢复**：对数据库断开、对象存储失败、代理错误和进程重启做受控测试；用户看到稳定错误，日志无 Cookie/密码/密钥/完整论文；告警可定位请求。实际完成一组 DB+对象恢复和应用版本回滚。
- **容量**：在授权 staging 范围内测试预期正常并发，不进行攻击性压测；关注每次上传/下载完整 Buffer 和 PDF解析占用、列表无分页及知识卡片逐条查询。

## 8. 风险与回滚方式

### 8.1 风险清单

P0 为必须先处置的明确重大风险；P1 为上线前需修复或验证的阻断；P2 为受控试点也需记录和批准的限制。以下是本轮审计，不代表全面渗透测试。

| 级别 | 风险/事实 | 处置与证据 |
| --- | --- | --- |
| P0 | 实装 PDF.js 命中高危公告，系统处理用户 PDF | 升级/修复并验证实际适用条件和阅读器兼容性；不以一次正常样本通过替代安全处置。见 1.4 |
| P1 | tar 旧嵌套副本及 SQLite 构建链风险，审计有 critical | 区分安装/运行可达性，升级受支持链路或隔离受影响步骤，保留回归和风险结论；禁止 audit fix --force |
| P1 | Sites 不能直接托管现有常驻 Express，`/api` 保留；Function会话/大文件链路未实现 | 完成方案 A 的适配和目标验收，或经批准采用 B；不将静态成功当全栈成功 |
| P1 | PG/S3/生产 TLS、备份与迁移尚未实测 | 用隔离真实服务验证，完成 ETL与恢复，不在原数据库试错 |
| P1 | 反向代理 trust proxy=1，默认 Origin仍是开发来源，Cookie依赖准确协议/入口 | 固定正式来源、校验 Host/Proto/IP与 Secure Cookie；已有严格 Origin+Lax CSRF措施需保留，不随意开放 CORS |
| P1 | S3私有ACL/加密不由应用验证；当前静态凭据不支持角色/STS token | 云端最小权限和匿名拒绝测试，凭据轮换、默认加密/版本策略；浏览器无直连 S3需求，不需放开 Bucket CORS |
| P1 | 总结生成时做来源校验，但保存接口只校验 JSON 结构，客户端可伪造 sourceType、引文及 model | 在保存时基于当前团队批注/发言重新核验来源并可信标记模型/人工来源；[server/server.mjs:592–601](../server/server.mjs#L592)。即使 AI未配置，该写接口仍存在 |
| P1 | 资源滥用控制不足：PDF内存解析/全文件Buffer，上传与总结接口缺少针对性配额；普通鉴权限流是进程内状态 | 设置用户/团队存储配额、上传/解析并发和超时、统一分布式/边缘限流及连接预算；不能用 20 MiB 单文件限制代替总量限制 |
| P1 | 无健康/优雅退出/恢复演练；删除任务仅有限触发 | 增加可观测的运行管理、恢复与对象对账，防止发布中断丢请求；不要编造现有 /health |
| P1（启用AI前） | `/api/ai/answer` 只检查会话和客户端片段一致性，不独立核验服务端论文权属/内容；团队总结不复用该接口的模型限流 | AI保持空配置；未来建立服务端论文/团队授权、证据边界、用户额度与审计，再授权供应商出网；[server/server.mjs:48–51](../server/server.mjs#L48)、[server/ai-server.mjs:34–74](../server/ai-server.mjs#L34) |
| P2/公开注册前升级为P1 | 无邮箱验证、密码重置、MFA和完整账号生命周期 | 明确受众/恢复政策；公开注册前补齐必要能力，封闭试点需控制访问与人工处理 |
| P2 | 缺少统一 CSP/frame-ancestors/HSTS 等生产响应头 | 在最终静态入口/代理实施并验收PDF Worker、字体、Blob兼容；当前没有 dangerouslySetInnerHTML 检索命中，不据此声称不存在所有 XSS |
| P2 | 业务异常响应/Provider错误已泛化，未发现主动回传Key；日志只有“请求处理失败”等，运维可定位性弱 | 加请求ID、脱敏类别/阶段、指标与权限审计；启动异常、第三方库、代理日志仍需实测，不能为了排错记录 env、原始SQL、Cookie或论文内容 |
| P2 | 团队/个人鉴权已按请求查库；在途操作与撤权存在需核验的竞争窗口 | 后续请求拒绝已有 SQLite测试证据；并发原子性另测，不虚报所有竞态已解决 |
| P2 | 注释引文/几何由客户端提交，尚未与服务器PDF独立核验；来源标签不等于原文真实性认证 | 保留清楚标签与原文复核，评估服务器证据校验；此项不同于越权读取 |
| P2 | 列表缺少分页、知识访问/序列化逐条多次查询；贡献记录随删除级联 | 记录容量基线，按实际规模优化；若要求不可篡改安全审计需另建机制，当前贡献表不承担该保证 |
| P2 | 旧来源IndexedDB迁移与新域名隔离，已下载文件无法远程收回 | 明确用户导入/备份流程与撤权边界，不改已有浏览器数据，不承诺撤回已下载内容 |

前端/API Key检查结论：当前真实密钥只由 Node环境读取；构建未发现密钥变量注入路径，未发现真实 Key 暴露证据。`.gitignore` 只防普通误提交，不等于发布包扫描或秘密管理；根目录整包上传仍不可接受。

### 8.2 回滚与失败处理

**应用发布回滚**

1. 保留上一份完整源码、锁文件、静态产物、后端包、Secret版本标识（不是值）及兼容的 schema 清单；数据库迁移采用 expand/contract，破坏性删除放到独立变更。
2. 新版本健康、登录、隔离或文件链路失败时停止放量，保留失败证据与写入时间范围；若 schema 向后兼容，切回上一后端/静态版本，保持稳定 SESSION_SECRET，验证旧版仍能读取新数据。
3. Sites 的历史已完成 action 被新版本替代后，重复 publish 旧 action不会让它重新上线。恢复旧前端须用保留的旧源码/产物，在同一已验证项目准备**新 action**并发布，重新校验状态和业务；不删除/重建站点。新旧页面可能同时存在，转接/API要保持必要的相邻版本兼容。
4. 不能用“站点快照存在”推断源码/Function/数据库均可恢复；这三者分别归档与演练。

**数据迁移回滚**

- 首次切换尚未开放新系统写入：停掉新入口，保留新环境供排查，经批准恢复旧入口；旧 SQLite/PDF保持原样，检查会话需要重新登录的影响。
- 新 PG/S3 已接收用户写入：先进入维护状态并备份新数据。**不得直接切回旧 SQLite**而丢弃新记录；对新增/变更做经审查的回迁/合并，或采用前向修复。没有现成自动双向回迁工具。
- schema 或数据损坏时，在新的隔离 PG/Bucket 恢复匹配备份并对账，经批准切换连接；不在在线库覆盖恢复，不把恢复环境指向原 Bucket（启动清理可能删除对象）。
- 001 down 删除核心业务表；002 down 删除团队关系/讨论结构；003 down 删除知识库/邀请码。**禁止把 down 当普通生产回滚或数据恢复**，不执行未经核验的自动降级。

**凭据/文件/安全故障**

- 发现密钥泄露时先限制入口/使用受影响凭据的能力，按供应商流程轮换，检查访问记录；不能仅删除前端字符串就宣称完成处置。SESSION_SECRET 轮换应告知会话失效。
- 对象复制或删除状态不确定时先读目标与迁移清单；不重复覆盖、整桶清空或删除原数据。数据库+对象存储没有分布式原子事务，恢复必须对齐两者。
- 外部服务不可用时返回明确错误，不降级到另一份本地数据库，不伪造模型回答或上传成功。

### 8.3 5A 交付与下一阶段入口

5A 已完成审计与执行方案；生产尚不可放行。下一阶段应优先处理依赖安全、选择并验证入口架构、完成最小部署适配，再在授权隔离资源上验证 PG/S3/迁移与恢复；全部验收通过后另行安排生产发布。AI 继续留空，不需要为完成这些准备而购买模型额度。
