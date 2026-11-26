# PaperFlow · 研知同行｜部署工程与安全验收

5A / 5B-1：2026-11-21；5B-2：2026-11-21 至 2026-11-22；5B-3：2026-11-22。**最新故障诊断、本地复验与 Linux 接入条件见第 12 节；首次发布快照见第 11 节；工程配置和命令见第 10 节；第 1–9 节保留历史审计记录，不代表当前代码或发布状态。**

**结论：静态测试前端已发布，最新受众为 selected；同源健康、注册、登录、me、知识库请求均实测返回平台 409，Function 和独立 Node 未部署。** 本轮真实 Node + 隔离 SQLite 的 API 与双账号浏览器测试通过，但公网业务尚未修复。用户已选择复用已有 Linux 主机，仍缺具体访问目标、HTTPS 入口及隔离 PG/S3 配置和相应授权；没有连接或修改远端。Sites 平台 SDK/应用 Cookie 能力及完整公网验收仍待完成，生产 AI 保持关闭。

5A 至 5B-2 未创建或发布站点。5B-3 按用户授权仅创建并发布一个静态测试站点，没有开通 Functions、平台数据库/Storage 或 AI，也没有执行付费资源购买、DNS 修改、真实数据库迁移、既有 IndexedDB/默认后端数据修改或 Git 提交/push。保留检查点 42c78d8 和此前未提交修改；后文主机与数据库命令仍需相应资源及操作授权，未在本轮执行。

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

## 9. 5B-1 实际修复与部署可行性验收（2026-11-21）

### 9.1 检查点、实际版本与修复范围

- 升级前建立本地 Git 检查点 **42c78d8**，83 个源码、配置、测试和文档文件；未推送远端。真实 `.env`、`.paperflow-data`、node_modules、dist 不在提交内；原始 `Qoder.pdf` 和需求 DOCX 保持未跟踪且未修改。后续修复留在工作区供审阅，未擅自再提交。
- `pdfjs-dist` 从实际安装的 **5.7.284 → 6.2.108**，manifest 精确锁定修复版，而不是无范围升级到 latest 6.5.438。官方 registry 元数据确认最低 Node 仍为 `>=22.13.0 || >=24`，实际测试 Node 为 22.19.0。
- `connect-sqlite3` 保持 **0.9.18**；其可选 sqlite3 原为 **5.1.7**，通过只针对该包的 `overrides.connect-sqlite3.sqlite3 = "$sqlite3"` 复用项目原有 **sqlite3 6.0.1**。已核对库只使用 Database/run/get/all/exec 等接口，两个 require 路径实际解析到同一驱动；未更改业务库或会话库文件路径、格式与表结构。
- 驱动链保留原有 **node-gyp 12.4.0 / tar 7.5.23**；删除旧 SQLite 5、node-gyp 8、tar 6 和相关传递依赖共 **103 个锁条目**。PDF.js 要求的可选原生画布 **@napi-rs/canvas 0.1.100 → 1.2.0**，其平台包同步；除此之外没有无关包的版本变化。
- npm 10.9.3 首次 install 保留了旧的无效嵌套 SQLite 锁分支，定向 update/dedupe 的预演也没有解决；仅移除该旧 sqlite3 锁条目后，由 `npm install --package-lock-only --ignore-scripts` 重新解析、裁剪无用依赖，再正常 install。没有删除整个锁文件，没有手写替代包元数据或 integrity，没有 `npm audit fix --force`，没有强制降级。
- **修复后官方全量 audit 与 `--omit=dev` audit 均为 0（info/low/moderate/high/critical 全为 0）**；`npm ls` 无 invalid 条目。另在新临时目录复制两份 manifest 后执行真实 `npm ci`，确认单一 SQLite 6.0.1、PDF 6.2.108，并执行原生内存数据库 SQL 成功。测试进程内清理原生 DLL 曾被 Windows 占用阻止，进程退出后单独清理；不涉及用户数据。

### 9.2 全部 High / Critical 公告及实际暴露面

修复前本轮重新请求 `https://registry.npmjs.org` 的有效报告是 **1 Critical + 5 High + 2 Low 依赖条目**，不是独立漏洞数。相比 5A 的缓存式上游传播结果，本轮准确定位到 sqlite3 5.1.7 / node-gyp 8.4.1，不再把根 sqlite3 6.0.1 / node-gyp 12.4.0 一并列为受影响节点。

| 报告包 / 实装版本 | 等级 | 引入路径与公告 | 实际影响 / 修复 |
| --- | --- | --- | --- |
| pdfjs-dist 5.7.284 | High | PaperFlow 直接 dependency；**CVE-2026-16633 / GHSA-hq66-cqwq-w95j** | 用户 PDF 进入浏览器与上传校验解析；版本受影响。公告利用前提是开启 enableScripting 且没有限制脚本的 CSP。项目此前只接 Canvas/TextLayer，没有 Viewer/ScriptingManager，因此没有证据表明原样可利用；仍必须升级。已到 6.2.108 |
| tar 6.2.1（两个锁路径） | Critical | connect-sqlite3 → sqlite3 5.1.7 → tar；同一路径 → node-gyp 8.4.1 → tar，或 → make-fetch-happen 9.1.0 → cacache 15.3.0 → tar；全部 High/Critical 编号见下表 | 归档解包/替换的文件读写与资源耗尽，主要涉及依赖安装/构建链。应用没有 tar 解包接口，不能等同于已验证的远程 API 漏洞；旧链已移除，剩余 7.5.23 |
| sqlite3 5.1.7 | High（传播） | connect-sqlite3 0.9.18 的 optionalDependency → sqlite3 → tar / node-gyp；继承下表公告 | 不是本次报告证明 SQLite SQL 引擎存在上述漏洞；从生产 dependencies 可达，optional 不等于 dev-only。旧副本替换为 6.0.1 |
| node-gyp 8.4.1 | High（传播） | 旧 sqlite3 → node-gyp → tar / make-fetch-happen；继承下表公告 | 原生构建链，非业务 HTTP 处理；旧副本移除，根 12.4.0 不受本轮报告影响 |
| make-fetch-happen 9.1.0 | High（传播） | 旧 sqlite3 → node-gyp → make-fetch-happen → cacache / http-proxy-agent | tar 告警向上传播；还继承 @tootallnate/once 的 Low 告警。旧链移除 |
| cacache 15.3.0 | High（传播） | 旧 sqlite3 → node-gyp → make-fetch-happen → cacache → tar 6.2.1 | npm 构建下载缓存归档处理；继承 tar 公告，旧链移除 |

`tar@6.2.1` 的全部 High/Critical 直接公告（边界取自本轮 npm JSON；GHSA 即可唯一标识，无未验证的 CVE 配对）：

| GHSA | npm 等级 | 受影响版本边界 | 实际危险操作 |
| --- | --- | --- | --- |
| [GHSA-34x7-hfp2-rc4v](https://github.com/advisories/GHSA-34x7-hfp2-rc4v) | High | <7.5.7 | 硬链接路径穿越，创建/覆盖文件 |
| [GHSA-8qq5-rm4j-mr97](https://github.com/advisories/GHSA-8qq5-rm4j-mr97) | High | <=7.5.2 | 路径清洗不足，文件覆盖/符号链接污染 |
| [GHSA-83g3-92jg-28cx](https://github.com/advisories/GHSA-83g3-92jg-28cx) | High | <7.5.8 | 经符号链接链逃逸的硬链接，文件读写 |
| [GHSA-qffp-2rhf-9h96](https://github.com/advisories/GHSA-qffp-2rhf-9h96) | High | <=7.5.9 | Windows drive-relative 硬链接路径穿越 |
| [GHSA-9ppj-qmqm-q256](https://github.com/advisories/GHSA-9ppj-qmqm-q256) | High | <=7.5.10 | drive-relative 符号链接路径穿越 |
| [GHSA-r6q2-hw4h-h46w](https://github.com/advisories/GHSA-r6q2-hw4h-h46w) | High | <=7.5.3 | macOS APFS Unicode 连字冲突导致路径预留竞态 |
| [GHSA-23hp-3jrh-7fpw](https://github.com/advisories/GHSA-23hp-3jrh-7fpw) | Critical | <=7.5.18 | 无界解压/解析导致资源耗尽 |
| [GHSA-8x88-c5mf-7j5w](https://github.com/advisories/GHSA-8x88-c5mf-7j5w) | High | <=7.5.17 | archive replace 的负 entry size 导致无限循环 |
| [GHSA-r292-9mhp-454m](https://github.com/advisories/GHSA-r292-9mhp-454m) | High | <=7.5.20 | 长路径成员筛选递归导致栈溢出 |

同一旧 tar 聚合项还含三个 Moderate：GHSA-vmf3-w455-68vh、GHSA-w8wr-v893-vjvp、GHSA-gvwx-54wh-qm9j，随旧链一并消除。另两个 Low 包条目为 `@tootallnate/once@1.1.2`（GHSA-vpq2-c234-7xj6，<2.0.1）及继承它的 `http-proxy-agent@4.0.1`，也已移除。

**CVE 核对来源与限制：** npm 官方审计给出 GHSA 和 `>=5.6.83 <6.2.108`；[GitLab advisory](https://advisories.gitlab.com/npm/pdfjs-dist/CVE-2026-16633/)明确把它对应为 CVE-2026-16633，并确认 enableScripting/CSP 前提及修复版 6.2.108。[Snyk](https://security.snyk.io/vuln/SNYK-JS-PDFJSDIST-18592344)给出的起点是 5.6.205，但同样覆盖本项目 5.7.284，修复终点一致；本报告范围以 npm 官方审计为准。CVE.org 页面本次仅返回 JS 壳、CVE API 404、NVD 页面未返回记录正文，不能称为已成功读取这些原始记录；没有运行恶意 PDF 或 tar 攻击样本，也没有声称复现任意代码执行。

**生产/开发分类：** connect-sqlite3 是生产 dependencies，旧子链标为 optional 而非 dev，正常生产安装不能只靠 `--omit=dev` 消除它。选择 PG 后不执行 SQLite 会话分支，不会自动把这些包从部署安装物中删掉；本轮修复了依赖图本身，而不是隐藏审计项。

### 9.3 PDF 安全配置与回归证据

实际源码改动：

- 三处浏览器 getDocument 与服务端上传解析均显式 `enableXfa: false`，不启用非必需 XFA 表单；继续只渲染 Canvas 与 TextLayer，不引入 PDF Viewer、PDFScriptingManager、sandbox 或执行 PDF action 的桥接。
- **没有把 `enableScripting:false` 或已不存在的 `isEvalSupported:false` 假塞进 getDocument。** 安装版的 getDocument 类型并不支持这些字段；enableScripting 属于 Viewer/AnnotationLayer 的脚本集成配置。XFA 开关不是 CVE 补丁的替代品，真正的版本修复是 6.2.108。
- 生产构建注入 CSP：`script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'self'`。不允许 inline 或 JavaScript unsafe-eval；wasm-unsafe-eval 仅保留 PDF 解码所需 Wasm，不等于允许 JS eval。开发 HMR 不注入该生产策略，因此另以真实构建 preview 做验收。该策略不是完整生产响应头部署；仍需入口侧 frame-ancestors/HSTS 等。
- 主库及 Worker 仍从同一 `pdfjs-dist` 包导入，Worker 由 Vite `?url` 打包，不用独立 CDN/手拷版本。当前 dist 只有一个 PDF Worker，11 文件、**2,219,988 字节**；这是本地产物，不是 Sites 发布包已受理。
- 在既有文献库测试中加入无外部访问的 PDF 文档脚本探针，验证不弹窗、不写全局标记；生产预览另验证浏览器确实阻止内联脚本。探针只是应用未接脚本能力的回归，不是完整 CVE 利用测试。
- 团队浏览器脚本新增 `PAPERFLOW_TEST_PREVIEW=1`，同一真实交互套件可验收构建产物/CSP，而非只测开发服务器；所有业务权限仍在服务端。

**本轮实际回归结果：** 后端使用临时 SQLite/文件目录与随机端口；浏览器使用独立 Chromium 上下文，未读取或修改用户已有浏览器数据库。生产预览仅指 Vite 构建产物加 CSP，后端仍是隔离的开发模式 SQLite，不等于生产 HTTPS/PG/S3 验收。

| 验收类别 | 实际执行与结果 | 证据边界 |
| --- | --- | --- |
| 类型 / 构建 | `npm run typecheck`、`npm run build` 通过 | Windows、Node 22.19.0；不是目标 Linux 原生安装验收 |
| 依赖 / 干净安装 | 全量和 omit-dev 官方 audit 都为 0；临时目录真实 npm ci、SQLite 原生查询与两条 require 解析一致通过 | 已清理测试目录；Windows 原生 DLL 的首次清理失败发生在功能断言全部通过之后，退出加载进程后清理成功 |
| 真实浏览器：生产产物 | `PAPERFLOW_TEST_PREVIEW=1 PAPERFLOW_RUN_REGRESSIONS=1 npm run test:collaboration-browser` 通过；包含 PDF、文献库、桌面和移动端完整回归 | 使用真实浏览器与本地 API，不用 API 写入制造双账号主流程，也没有模型 Mock |
| PDF 选区 / 高亮 / 原文锚点 | 拖选、跨行矩形、保存、缩放、重渲染、翻页、刷新恢复、讨论/知识来源跳转通过；高亮几何差异仍按 **<3 px** 断言；原始中文 25 页 PDF 上传/渲染/续读通过 | 没有修改选区算法或放宽容差；不能推广为全部复杂 PDF 格式通过 |
| PDF 脚本 / CSP | 文档脚本探针未执行，页面正常渲染；生产 CSP 在浏览器中确实阻止注入的内联脚本 | 非 CVE 攻击复现；文献库故障路径另外包含既有 IndexedDB 配额 Mock |
| 真实浏览器：开发模式双账号 | 单独重跑 `npm run test:collaboration-browser` 通过，覆盖注册、建队、邀请码、共享文献、批注编辑、跨账号回复、问题卡片、人工记录、贡献、私有隔离、重登、移动端与退出失效 | 未登录 401、退出后团队/PDF/知识库 404 是额外的**浏览器内只读 API 断言**，不冒称全部由 UI 验证 |
| 真实浏览器：本地导入 | `npm run test:import-browser` 通过；预览、冲突跳过、同名手动导入、进度/高亮/笔记迁移及源 IndexedDB 保留 | 只在新测试上下文内直接构造部分 IndexedDB 夹具，并以只读 API 核对迁移；不属于完全无造数测试 |
| SQLite API 集成 | `npm run test:backend` 通过；真实数据库/文件系统、会话重启恢复、个人隔离、跨团队来源、Owner/Member 权限、邀请码轮换/撤销/过期、知识卡片与贡献、退出立即失效 | 没有外部 PG/S3，也不是浏览器 UI 测试 |
| AI Mock | `npm run test:team`、`npm run test:ai-server`、`npm run test:ai-integration` 通过；最后一项实际经过浏览器→Vite→AI 服务→本机假供应商，验证证据引用、无证据不调用、选区保存笔记与供应商错误 | **全部使用本机假模型，不证明真实 AI 中转站或模型可用** |
| 未执行项 | 真实 PG、S3、Sites 网关、正式 HTTPS、多实例、迁移/恢复演练、真实模型 | 保持未验收；不能用本地成功替代 |

一次开发模式运行在编辑本报告时被 Vite 全页热刷新打断，登录等待超时；停止所有项目文件写入后，用同一脚本、不改断言重新运行通过，后续导入和 Mock 引用集成也通过。该次失败保留为测试环境干扰记录，没有通过延长超时或跳过登录检查掩盖。

可重复命令（Git Bash，在项目根目录执行；浏览器测试期间不要编辑项目文件）：

```bash
npm run typecheck
npm run build
npm ls pdfjs-dist connect-sqlite3 sqlite3 node-gyp tar
npm audit --registry=https://registry.npmjs.org
npm audit --omit=dev --registry=https://registry.npmjs.org
npm run test:backend
npm run test:team
npm run test:ai-server
PAPERFLOW_TEST_PREVIEW=1 PAPERFLOW_RUN_REGRESSIONS=1 npm run test:collaboration-browser
npm run test:collaboration-browser
npm run test:import-browser
npm run test:ai-integration
```

不要运行会调用真实模型的 `test:ai-provider` / `test:ai-real`。本轮测试已经自行关闭测试浏览器、停止其子进程并清理隔离数据；没有停止用户原有服务。

### 9.4 Sites 当前账号与平台边界

实际执行了 **get_context、list_sites(scope=owned)、list_sites(scope=shared)**；本地 `sites=[] / developmentSites=[]`，账号 owned/shared 均 `total_size=0`、无后续页。没有可用于 get_site 的真实 Site ID，因此数据库、Storage、Functions 的已开通状态、配额、费用、地区和运行结果均**无法直接验证**，不是“账号没有权限”或“免费可用”的结论。

| 核验项 | 本轮实证结论 |
| --- | --- |
| React + Vite | 本地生产构建及浏览器验收可行；官方静态契约接受 dist，根路径、spa=true 有支持。没有上传或发布，云端深链、Worker MIME/缓存仍待验 |
| 常驻 Node REST | 官方 Functions 入口为 edge/index.ts/Deno.serve，不是启动 Express 进程；不支持照搬当前服务器与原生 sqlite3/Knex/文件系统假设 |
| Agent App / QCA | 文档架构为浏览器 → 同源 Function → Cloud Agents，并单独涉及 QODER_PAT；不证明可运行任意 Node 后端。本轮没有开通 qoder/PAT，没有模型调用 |
| 数据库 / Storage | 文档有 function_backend 与注入的 backend/storage SDK；不是已提供给外部 Node 的 PostgreSQL DSN/S3 凭据，也没有完成事务/Session 适配。主方案无需重复开通这两项平台数据资源 |
| Server Functions | 文档支持业务 HTTP 子路由；账号实际可开通性、Cookie/Set-Cookie、20 MiB 文件透传、超时/出网未知。只读列表不能替代实际验收 |
| 自定义环境变量 | 静态 Vite 构建值公开，只可放非密钥；Function 应用 Secrets 经 Sites Settings 专用输入，Deno.env 读取，保留名称不能用。Node Secret 独立放后端托管系统；没有把静态环境变量当运行时密钥 |
| HTTPS | 平台认证文档以正式 HTTPS Host 为目标；无本项目站点，不能声称证书/跳转/Secure Cookie 已验收。localhost HTTP 的会话测试不证明生产 HTTPS |
| 跨域 | Sites 不自动使外部 API 支持 CORS；当前代码 /api、same-origin 凭据、Lax Cookie 不支持直接任意跨站调用。主方案用同源 Function 转接避免第三方 Cookie 依赖，但仍须验收 Origin/CSRF |
| SPA / API 路径 | spa=true 有 index fallback；`/api` 是平台保留路径，现有 Vite proxy 不会随 dist 上云，必须显式改业务 API 前缀。fallback 的 HTML 200 不是资源或 API 成功 |

核对依据为第 2.1 节链接的当前宿主官方文档，另查阅 [Agent App 技能](file:///D:/tool/Qoder/resources/extensions/qoder.sites/dist/plugin/skills/sites-build-agent-app/SKILL.md)、[静态契约](file:///D:/tool/Qoder/resources/extensions/qoder.sites/dist/plugin/skills/sites-building/references/static-site.md)和[应用认证凭据透传](file:///D:/tool/Qoder/resources/extensions/qoder.sites/dist/plugin/skills/sites-building/references/application-auth.md#L98)。

**需要用户在 Qoder 界面完成的核验，不在本轮自动开通：**

1. 在 Sites 列表确认登录的是预期账号；当前列表无站点。若使用其他账号的现有站点，先切换正确账号或取得管理共享，再检查真实站点状态，不能编造站点 ID。
2. 经下一轮明确授权后，为本项目建立隔离、未对生产开放的验证站点，打开该站点 **Settings / 站点设置**，记录 Functions、数据库、Storage 的实际状态及开通提示、额度、计费；出现付费或额外授权要求时先停止。无需为了验证 Node 架构而开通 Sites 数据库/Storage，更不需要 qoder/PAT。
3. Functions 准备后在 Settings 检查 readiness 与应用 Secrets 专用输入/同步反馈；只查看配置能力，不在聊天粘贴密钥。静态站点 Settings 不会自动分配 Functions。
4. 向平台支持确认当前 Gateway/Worker 的 `forwardApplicationCredentials`、Set-Cookie 返回保护、入站大文件/响应体上限、超时、固定外部 HTTPS 访问、可信客户端 IP 与费用。即使后端状态 ready，也需在授权测试发布后实际验收，不能只凭页面图标通过。
5. 确认站点访问范围允许预期的两位真实使用者；默认私有的 Qoder 准入和 PaperFlow 注册登录是两个边界，不自动改公开。配置验证站点后再检查正式 HTTPS、深链刷新与两账户隔离。

### 9.5 收敛架构、环境与上线阻断

**唯一主方案：Qoder Sites 静态前端 + 薄同源 Function 网关 + 独立常驻 Node API + PostgreSQL + 私有 S3 兼容存储。** 保留现有科研业务、账号密码/Session、服务端团队鉴权与 AI Provider；网关只转接固定目标的允许路径/方法，不承载数据库业务，也不开通冗余 Sites 数据库/Storage。Node 首选可复用的 Linux 常驻主机/容器与同机反向代理，数据库和存储优先复用满足隔离、备份及 TLS 条件的已有服务，不擅自购买。

该方案以第 2.2 节的 Cookie、原始 Origin、文件体积、超时、入口认证与限流门槛通过为前提，**不是本轮已经可部署的结论**。本轮不提前重构前端 API 或实现没有目标环境可验收的网关。

**唯一备用方案：同一可控 HTTPS 入口提供 dist 与 /api 反代，后端继续 Node + 同样的 PG/S3。** 当 Sites 网关能力、额度或凭据门槛无法满足时采用；改动更少、无需重写认证，代价是产品前端不由 Sites 承载。两方案均可复用已验收的两个应用账号协作逻辑，未来 AI 仅接服务器侧 Provider；本地双测试账号通过不等于真实公网双账号已验收。

必需环境与服务（均通过部署方专用安全配置，不把值写入源码）：

| 位置 | 配置 / 服务 |
| --- | --- |
| Node | 受支持且打补丁的 Node LTS、`NODE_ENV=production`、现有读取名 `AI_PORT`、稳定至少 32 字符 `SESSION_SECRET`、精确 HTTPS 前端来源 `AI_ALLOWED_ORIGINS` |
| PostgreSQL | `DATABASE_URL`（验证 TLS/CA、应用最小权限）；001/002/003 显式迁移、pg Session 表、自动备份和恢复条件 |
| S3 | 私有 bucket；`S3_BUCKET`、`S3_REGION`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`；兼容服务可加 HTTPS `S3_ENDPOINT`。公开权限禁用、最小对象权限、加密/备份独立验收 |
| Sites 前端 | 只上传 dist、spa=true；下一轮统一 API 前缀为 `/functions/v1/app/api/*`。当前没有已经生效的 `VITE_API_BASE_URL`，不把它写进配置就声称完成 |
| Sites 薄网关（待实现） | 固定外部 API HTTPS 目标与服务间验证方式；可能使用 `APP_API_ORIGIN` / `APP_GATEWAY_TOKEN`，目前只是拟定名称，双方代码尚不读取。实际新增时再声明并安全输入，不使用平台保留 DATABASE_URL/QODER_* |
| AI | `AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY` 继续空；`AI_TIMEOUT_MS=30000` 可保留。密钥缺失不阻塞非 AI 功能，不能为测试填真实模型 |

**剩余安全/上线阻断（依赖 audit 清零不等于系统无漏洞）：**

- Sites 网关及 API 前缀尚未实现；Cookie/Set-Cookie、源站绕过保护、20 MiB + multipart、可信 IP/限流、HTTPS/Secure Cookie 和两层访问范围未实测。
- PostgreSQL/S3 真实联调、历史数据 ETL、备份恢复与对象对账尚未执行；不得把强制清空 DATABASE_URL 的 SQLite 脚本冒充 PG 测试。
- 总结保存 API 的来源复核缺口、上传/解析资源配额、账号恢复/注册策略、健康检查/优雅退出/日志脱敏、删除任务排空等第 8 节未修复项仍在；本轮不扩大为业务安全重构。
- 当前增加的是生产 HTML CSP，尚无最终入口的 frame-ancestors/HSTS 等响应头验收；复杂/扫描 PDF、Wasm 解码格式与目标浏览器仍需目标环境样本基线，不夸大样本覆盖率。
- 原生安装链仍含上游标记 deprecated 的 `prebuild-install@7.1.3`；当前 audit 无告警但需关注维护状态。Windows/npm 对此前运行进程占用的旧原生库产生 cleanup EPERM，旧副本已不在锁树和当前 require 路径；未强杀现有服务，部署时必须全新 npm ci，已有本地服务需有计划地重启后使用新代码，不复制 node_modules。
- 本机 Node 22.19.0 仅证明兼容；本轮没有审计或升级 Node/OS 本身。上线选目标 OS 上仍受支持且已打补丁的 LTS，并重新跑原生依赖和回归，不能把最低 engines 版本当安全认证。

### 9.6 下一轮可直接执行的任务顺序

1. **先做本地最小适配，不开云资源：** 汇总所有 API 调用到同一个 base 路径配置，默认保留本地 `/api`，Sites 构建使用 `/functions/v1/app/api`；覆盖 auth/文献/团队/讨论/知识库/AI 与文件地址，不引入跨站 Cookie 捷径。
2. **实现固定目标薄网关与本机负向测试：** 允许路由/方法、保留真实 Origin、无任意 URL、无重试业务写入、过滤平台/伪造代理头、Cookie/Set-Cookie 与二进制透明传递、超时与安全错误；明确独立 Node 入口仅接受受信任转接的机制。
3. **补齐上线安全和运行缺口：** 总结保存来源复核、健康/优雅退出、上传/解析并发与总配额、脱敏请求 ID、可信 IP/账号限流；保持已有服务端权限和即时撤权测试。
4. **经授权配置隔离资源并联调：** 用户完成前述 Settings/额度确认，选择测试用 Node/PG/私有 S3；增加真正使用 PG/S3 的测试入口，执行空库迁移、约束、会话重启、上传下载删除、匿名拒绝与备份恢复。先核对成本，不默认购买。
5. **仅在批准的非生产入口做端到端验收：** Sites Functions ready 不等于功能 ready；实际用两账号验证登录、共享/私有隔离、撤权、20 MiB 上传、刷新深链、Worker、HTTPS Cookie、CSRF 和源站绕过。任一平台门槛失败则停主方案，按备用方案验证，不靠削弱鉴权补洞。
6. **迁移演练后才申请生产发布：** 完整备份、仅对副本做 SQLite→PG 与 PDF→S3 对账；IndexedDB 由用户明确导入，禁止自动清空。确认域名/受众/预算、恢复方案与观测通过后，再按新的明确授权执行生产切换；AI 留空。

## 10. 5B-2 部署工程交付（2026-11-21 至 2026-11-22）

### 10.1 最终架构与适配边界

```text
主方案（Sites 平台门槛待验）
浏览器 → Sites dist，SPA 回退
       → 同源 /functions/v1/app/api/*
       → 薄 Function（应用 Cookie、原始 Origin、固定 HTTPS 上游）
       → 受控 HTTPS 反向代理 → 独立常驻 Node
                              ├─ PostgreSQL：业务 + Session
                              └─ 私有 S3：PDF

唯一备用（不依赖 Sites 网关 SDK）
浏览器 → 同一受控 HTTPS 入口：dist + /api/* 反代
       → 同样的独立 Node / PostgreSQL / 私有 S3
```

现有业务可以复用，不需要迁到 Sites 数据库或 Cloud Agents。两方案都避免跨站 Cookie：前端只接受同源绝对 API 路径，保持 HttpOnly / SameSite=Lax，正式环境 Secure；不启用任意来源 CORS，也不把 Cookie 改成 None 来绕过平台限制。独立 Node 不直接接公网流量，默认只监听回环地址，由同机反代传递经过覆盖的代理头。

**Sites 主方案是带明确验收门槛的候选，不是已证实可在当前账号部署的成品。** 官方应用认证示例使用 `createSiteContext(..., { forwardApplicationCredentials: true })`、注入的 `_qoder/backend.mjs`，并列出 `function_backend` 与 database/functions 前提；不能据此推断纯 Functions、`databaseAccess: none` 的分配也一定注入该 SDK。本项目不需要平台数据库，故没有为了 SDK 擅自开库。必须先由目标平台确认 SDK 注入、凭据透传、可信入口及响应保护；若不能支持无冗余数据库的薄网关，采用备用方案，而不是私自复制平台 SDK、伪造可信头或开通付费数据资源。

本轮只读查询仍是本地无站点绑定、owned/shared 站点列表均为空；没有真实 Site ID、权益或费用证明。没有调用 prepare/publish/ensure_backend，没有创建 QODER_PAT、平台数据库/Storage，也没有接入真实 AI。

### 10.2 已实现的配置与文件清单

以下为 **5B-2** 增量；工作树中的 lockfile、PDF 配置、阅读器与 library-test 等还包含保留的 **5B-1** 修改，不应重复认定为本轮升级。

| 文件 | 本轮用途 |
| --- | --- |
| `src/services/api.ts`（新增） | 统一读取构建时同源 API 前缀 |
| `src/services/auth.tsx`、`remoteLibrary.ts`、`workspaces.ts`、`comments.ts`、`summaries.ts`、`knowledge.ts`、`aiClient.ts` | 认证、文献及 PDF 文件、团队、讨论、知识库、AI 全部走统一地址；无业务模型重写 |
| `vite.config.ts` | 普通构建默认 `/api`；Sites 构建固定 `/functions/v1/app/api`；拒绝跨域地址；保留生产 CSP、根路径和本机代理 |
| `server/config.mjs`、`http-security.mjs`、`start.mjs`（新增） | 缺配置失败退出、精确 Host/Origin、可信代理 IP/CIDR、HTTPS、服务间令牌、安全 JSON 日志 |
| `server/server.mjs`、`ai-server.mjs` | 统一入口保护、健康、JSON 错误/请求 ID、会话池错误脱敏、关闭连接及资源；保留原服务端鉴权 |
| `server/database.mjs`、`migrate.mjs` | PG TLS/CA 共用配置、只读迁移状态、生产显式 apply；原 001/002/003 迁移文件未改 |
| `server/object-storage.mjs` | 生产 HTTPS S3、path-style 选项、HeadBucket 就绪探测、操作超时和关闭客户端 |
| `functions/index.ts`、`functions/gateway.mjs`（新增） | Deno 入口候选与可单独测试的固定目标网关；白名单路由/方法、应用 Cookie 筛选、无写入重试、无重定向、限体积和时间 |
| `.env.production.example`、`deploy/sites.env.example`（新增） | 分离的 Node 与 Sites 变量模板，不含真实值 |
| `deploy/nginx-sites.conf.example`、`deploy/nginx-same-origin.conf.example`（新增） | 二选一的 HTTPS/反代模板；拒绝不匹配 Host、覆盖代理头、响应安全头；备用方案有 SPA 回退及 mjs MIME |
| `deploy/paperflow.service`（新增） | 非 root systemd 常驻服务模板；只读系统目录、私有临时目录、重启与关闭时限 |
| `scripts/check-production-config.mjs`、`deployment-test.mjs`、`migration-test.mjs`、`verify-deployment.mjs`、`gateway-local.mjs`（新增） | 配置预检、安全边界、隔离迁移、只读/拒绝路径验收、本机网关适配器 |
| `scripts/backend-test.mjs`、`team-test.mjs`、`collaboration-browser-test.mjs`、`import-browser-test.mjs`、`ai-integration-test.mjs` | 隔离新增环境变量；健康故障恢复；网关真实浏览器链路；构建模式提前检查 |
| `package.json`、`.env.example`、`.gitignore` | 新命令、开发配置说明与生产空模板白名单；本轮未更改依赖版本 |
| `docs/DEPLOYMENT_PLAN.md` | 当前交付、可执行步骤、证据及阻断 |

运行规则：
- `npm start` 强制 production，不自动读取开发 `.env`；只使用宿主注入的变量。也可由 Node `--env-file` 显式加载工作区以外的服务端配置。
- PG 业务连接与 Session pool 都验证证书；生产不允许 disable，不允许 URL 中 `ssl*` 参数覆盖 TLS 设置。私有 CA 通过 `PG_SSL_CA_FILE` 加载。远程开发 PG 也须 verify-full。
- 生产缺 PG、S3、稳定会话密钥、精确来源/Host/代理配置即拒绝启动。Sites 模式还要求随机服务间令牌。预检成功仅代表配置形状有效，不代表连通。
- `TRUSTED_PROXIES` 仅接受 IP/CIDR，拒绝 `/0` 和“信任一跳/所有代理”；业务 HTTP 被拒绝，健康路径允许受 Host 限制的本机 HTTP 探测。
- `GET /health/live` 只反映进程；`GET /health/ready` 检查业务库、PG Session 表及 S3 HeadBucket（开发检查私有文件目录）。失败 503；不返回连接细节。`/api/health` 供普通入口使用，Sites 网关的 `/api/health` 映射至上游 `/health/ready`。
- 请求日志包含新生成的 requestId、方法、参数化路由、状态和耗时，不记录 Cookie、密码、请求体、原始 SQL 或 URL 查询。代理/平台自己的日志仍须另行验证脱敏和留存。
- SIGTERM/SIGINT 停止接入、等待连接及启动清理、关闭 Session/数据库/S3，15 秒超时退出。Linux/systemd 的实际信号、排空与故障重启未在 Windows 本机验收。
- 网关只转 `paperflow.sid`，不转平台 Cookie、Authorization 或客户端 X-Forwarded-*；源站验证共享令牌。仅接收固定 API 路由、固定上游；不跟随重定向、不重试写请求。请求/响应上限为 20 MiB + 64 KiB，总期限 65 秒；当前为有界缓冲而非流式，平台内存/期限必须实测。
- `npm run build:sites` 与 `npm run build` 使用同一 dist，会互相替换生成产物。预览脚本按对应模式运行，不能以普通构建冒充网关验证；本机网关适配器禁止 production 和非回环上游。
- 生产 AI 配置必须留空。这是当前部署安全门槛；后续解除前需完成 AI 授权、来源、额度等验收。Provider 源码保留，Mock 验证不调用真实模型。

### 10.3 必需环境变量与安全配置

| 位置 | 必需/条件变量及约束 |
| --- | --- |
| Node 运行 | `NODE_ENV=production`，`DEPLOYMENT_MODE=sites` 或 `same-origin`，`AI_PORT=8787`（沿用已有名称），`BIND_HOST=127.0.0.1`；容器拓扑如不同需同步修改反代/防火墙 |
| Node 网络 | `ALLOWED_HOSTS` 精确匹配反代传给 Node 的 Host，模板为 `127.0.0.1:8787,localhost:8787`；`TRUSTED_PROXIES` 只填实际直连代理网段，模板为回环；`AI_ALLOWED_ORIGINS` 填真实前端 HTTPS origin，无尾斜线 |
| Node 会话 | `SESSION_SECRET` 高熵随机且至少 32 字符，跨重启稳定；不使用测试脚本的固定值 |
| Node PG | `DATABASE_URL`、`PG_SSL_MODE=verify-full`；私有 CA 时加 `PG_SSL_CA_FILE`，禁止关闭校验；运行账号与迁移账号分离 |
| Node S3 | `S3_BUCKET`、`S3_REGION`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`；兼容服务加 HTTPS `S3_ENDPOINT`；`S3_FORCE_PATH_STYLE` 可空/true/false，自定义 endpoint 默认 true，AWS 默认 false |
| Node ↔ Sites | Sites 模式要求 `APP_GATEWAY_TOKEN`，用 32 字节或更多随机源编码为 43–128 字符 base64url；Node 与 Function 值一致，只在服务端保存 |
| Sites Function | `APP_ORIGIN` 为正式前端 HTTPS origin，`APP_API_ORIGIN` 为固定 Node 反代 HTTPS origin，`APP_GATEWAY_TOKEN`；只在 Sites Settings 的 Secret 专用入口输入 |
| 前端构建 | 普通模式可指定同源 `VITE_API_BASE_URL`，默认 `/api`；Sites 模式强制正确前缀，无需配置后端域名；任何密钥不得以 `VITE_*` 命名 |
| AI | `AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY` 均空；可保留 `AI_TIMEOUT_MS=30000` |

生产模板空值是故意的，不能直接作为有效配置启动。后端配置保存在如 `/etc/paperflow/production.env` 的受限文件或托管平台 Secrets，**不放进项目根目录的 `.env.production`**，不让 Vite 构建进程继承后端 Secrets。Unix 可使用 root:paperflow、0640，并限制目录访问；密钥不要粘贴到聊天、命令行或文档。

PG 运行角色需要业务与 session 的最小 DML、migration 记录的 SELECT，不应具备建库/超级用户权限。S3 仅给指定私有 bucket 的 Get/Put/DeleteObject 和 HeadBucket 所需的 bucket 权限（AWS 通常为 ListBucket）；不授权公开 ACL 或管理所有 buckets。HeadBucket 成功不证明对象写删权限、匿名拒绝、加密、版本或备份已通过。

### 10.4 可执行命令（本机回归与后续部署分开）

以下命令从项目根目录执行。Git Bash/Linux 可直接使用 `VAR=value`；Windows PowerShell 应改用对应环境变量语法。不要覆盖已有 `.env`、用户数据库或 PDF 目录。

**A. 本地可重复验收，无需真实云端凭据**

```bash
npm ci
npm run typecheck
npm run test:backend
npm run test:migrations
npm run test:deployment
npm run test:team
npm run test:ai-server
npm run build
PAPERFLOW_TEST_PREVIEW=1 PAPERFLOW_RUN_REGRESSIONS=1 npm run test:collaboration-browser
npm run test:import-browser
npm run test:ai-integration
npm run build:sites
PAPERFLOW_TEST_SITES=1 PAPERFLOW_RUN_REGRESSIONS=1 npm run test:collaboration-browser
```

`npm ci` 用于新检出的干净目录/目标 OS，不在运行服务的 node_modules 上覆盖安装。本轮复用已安装依赖并实际执行下表中的命令，没有再次安装或升级。浏览器测试启动/关闭自己创建的回环服务、临时 SQLite/文件和独立会话；用户现有浏览器 IndexedDB 不参与。

默认 `test:migrations` 仅运行临时真实 SQLite，并打印 PG SKIP。**经授权且只对专用测试数据库**，将 `PAPERFLOW_TEST_DATABASE_URL` 放在独立受限配置后可运行：

```bash
PAPERFLOW_DATABASE_TEST_APPROVAL=isolated-schema PG_SSL_MODE=verify-full \
  node --env-file=/etc/paperflow/test-database.env scripts/migration-test.mjs
```

这会在选定测试库中创建两个随机 `paperflow_test_*` schema，完成后仅清理这些 schema；不是对生产运行的命令。不能把 `test:backend` 强制清空 DATABASE_URL 后的成功当作 PG API 验收，完整 PG/S3 业务链仍要另行测试。

**B. 独立 Linux Node 服务（本轮未执行，不要求 Docker）**

前提：用户批准目标主机、预算和测试范围，完成受支持且已打补丁的 Node LTS、非 root paperflow 用户、TLS 证书、PG/S3、备份和角色授权；源码部署到 `/srv/paperflow/current`。先确认实际 `node` 路径，再修正 service 中的 `/usr/bin/node`。不要复用本机 node_modules 或导入默认 `.paperflow-data`。

```bash
npm ci --omit=dev
node --env-file=/etc/paperflow/production.env scripts/check-production-config.mjs
node --env-file=/etc/paperflow/migration.env server/migrate.mjs --production --status
```

status 是只读检查；待迁移时退出 1，并列出文件名。核对目标、备份、变更审核后，**仅在明确批准执行迁移时**运行下一组，不把 status 的退出 1 当成自动迁移授权：

```bash
node --env-file=/etc/paperflow/migration.env server/migrate.mjs --production --apply
node --env-file=/etc/paperflow/production.env server/migrate.mjs --production --status
node --env-file=/etc/paperflow/production.env server/start.mjs
```

migration.env 仅需相应迁移角色的 PG/TLS 配置；production.env 使用低权限运行账号。已有进程应由服务管理器管理，不同时启动第二个监听相同端口的手工进程。平台已安全注入环境时，对应命令是 `npm run check:production`、`npm run db:status:prod`、经批准的 `npm run db:migrate:prod` 和 `npm start`；**不要使用会读取开发 `.env` 的 db:migrate/dev:server 作为正式命令**。

需要 systemd 时，审核并安装 `deploy/paperflow.service`（先确认目标文件不存在或已备份），不把迁移加入 ExecStart：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now paperflow
sudo systemctl status paperflow --no-pager
curl --fail http://127.0.0.1:8787/health/live
curl --fail http://127.0.0.1:8787/health/ready
```

反代模板二选一，放入 nginx 的 http 上下文；替换 **所有**示例 host（含 Host 条件和跳转）、证书路径，检查主配置加载标准 mime.types。模板会覆盖 X-Forwarded-Proto/For，不信任入站 Forwarded/X-Forwarded-Host；上游 Host 固定为 Node 白名单值。使用外部 LB 时必须重新验证信任链，不填写全网 CIDR。部署前执行：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Sites 主方案使用 `nginx-sites.conf.example`，透传共享令牌供 Node 验证；备用方案使用 `nginx-same-origin.conf.example`、`DEPLOYMENT_MODE=same-origin` 和 **普通** `npm run build` 的 dist。SPA 深链回退到 index，但不存在的脚本/Worker 返回 404，不能返回 HTML 冒充 JavaScript。这里没有已安装或验证过 nginx/systemd 的声明。

**C. Sites 步骤（下一轮明确授权后，不能直接在本轮执行）**

1. 确认正确账号、站点归属、预期访问者、Functions 额度/费用，以及 10.1 的纯网关 SDK 门槛。没有确认 SDK 能力时不要先创建不可转换的 functions-only allocation，也不要为解决该问题自动建库。
2. 使用当前官方 Sites 工具重新读取 schema/context；复用已有 ID，或在得到新建隔离站点授权后由官方工具登记站点，不能手写 `.qoder.site` 或猜测公网地址。
3. 保持 `projectRoot` 为原项目，候选准备参数为 `webDirectory: dist`、`functionDirectory: functions`、`spa: true`、无平台数据库业务依赖；只有平台确认无库网关契约后才使用 `databaseAccess: none`、不带 schemaRef。Function Secret 名仅 APP_ORIGIN / APP_API_ORIGIN / APP_GATEWAY_TOKEN。不上传 `_qoder`、测试适配器、server、node_modules、`.env*` 或用户文件。
4. 准备 Function 可能开通资源，必须在预算和授权范围内。用真实返回地址配置来源和 Secret 值，在 Settings 检查同步；不启用 QCA/PAT，不改变默认访问范围，不把静态页面成功当完整产品成功。
5. 只在批准的隔离入口发布完整候选，核验目标版本和真实 Functions 状态；完成下节门槛，再考虑生产。SDK/透传能力不满足时停止主方案，用唯一备用同域入口验证。

**D. 正式 HTTPS 入口的只读/拒绝路径探测**

将真实 frontend origin 和对应 `/functions/v1/app/api` 或 `/api` 放入专用 verify.env 的 `PAPERFLOW_VERIFY_ORIGIN` / `PAPERFLOW_VERIFY_API_BASE`，再运行：

```bash
node --env-file=/etc/paperflow/verify.env scripts/verify-deployment.mjs
```

它不注册、登录、迁移或写业务数据，仅检查首页/SPA/脚本 MIME、就绪、匿名 401 和应被拒绝的跨站 logout；不跟随重定向、不打印响应正文。私有 Sites 门禁可能使未登录命令行请求失败，此时需在获准的真实浏览器会话中验证，**不能为让脚本通过而公开站点或粘贴平台 Cookie**。此命令成功也不代表 Cookie、双账号、S3 写入或恢复通过。

### 10.5 本轮验证证据矩阵

| 实际检查 | 结果及证据性质 |
| --- | --- |
| TypeScript、普通 build、build:sites | 均通过；Vite 1636 modules。仅验证前端，不包含 Deno SDK 入口 |
| test:backend | 真实临时 SQLite/文件系统：健康 200→目录暂不可用 503→恢复 200、安全 JSON 错误、会话重启、认证、私有/跨团队权限、邀请码、退出立即失效通过 |
| test:migrations | 临时 SQLite 空库 001/002/003、从 001 升级、回填/JSON/Session/外键及再次迁移无变化通过；PG 明确 SKIP |
| test:deployment 配置 | 真正运行预检/生产入口，缺配置均退出 1；生产字段、来源、代理、PG TLS/S3 HTTPS/AI 留空负向断言通过，不连接假域名 |
| test:deployment Cookie | 真实 Express/session 中间件 + 内存 Session，在本机 HTTP 模拟受信任 HTTPS 终止；Secure/HttpOnly/Lax、假 Host/Origin/协议/Token 拒绝通过；非线上 TLS 或 PG Session |
| test:deployment 网关 | 实际 gateway.mjs、Mock fetch：逻辑/物理子路由、固定目标与方法、Cookie/Origin、重定向/HTML 拒绝、错误不泄密通过；20 MiB 随机字节 + multipart 可透传、超限实际读取拒绝；不是有效 20 MiB PDF 的平台解析验收 |
| test:deployment S3 | 实际 AWS SDK → 本机假 S3 HTTP 服务，签名请求、HeadBucket、Put/Get/Delete 字节一致性通过；非真实服务、TLS、ACL/权限或加密验收 |
| 普通生产预览 + 完整回归 | 真实两会话浏览器黄金流程、API 只读权限断言、CSP 阻止内联脚本、PDF JS 未执行、中文 25 页 PDF、本地库、选区/高亮/笔记/缩放/恢复、桌面与移动端通过 |
| Sites 生产预览 + 完整回归 | 同一真实 UI 黄金流程经过 Vite 同源代理 → 本机 Node 适配的真实 gateway.mjs → SQLite API；无 API 写入造数、无模型 Mock，禁止绕过网关；不是 Deno/SDK/公网测试 |
| verify-deployment --local | 两种生产预览均通过 SPA、脚本 MIME、就绪、匿名隔离和 CSRF 拒绝 |
| 开发模式协作浏览器 | 本轮通过；不以生产预览代替开发模式结果 |
| 导入浏览器 / AI integration | 正确普通构建顺序下复验通过：冲突跳过、同名导入、进度/高亮/笔记迁移、本地数据不变；浏览器→Vite→AI server→假 Provider 的证据/无证据/选区笔记/错误通过。导入部分 IndexedDB 数据由夹具注入，不是纯 UI 造数；无真实模型 |
| test:team / test:ai-server | 本机 Mock Provider 的来源过滤、权限、分类、超时和既有 Provider 回归通过；不等于任意总结保存入口的来源缺口已修复 |
| npm audit / --omit=dev | 官方 registry 均 0 项已知漏洞；本轮未改依赖版本 |
| 构建配置/产物 | 跨域 API Base 在构建配置加载时被拒绝；Sites dist 11 文件 / 2,220,023 字节，无私有目录、源映射或后端 Secret 变量名。应用 API 是同源路径；React Router 内部仍有 localhost URL 解析占位符，非 API 上游，不篡改第三方包来消除该字样 |
| 目视检查 | 实际查看桌面/移动端阅读器截图，PDF、高亮、笔记/讨论呈现正常；未扩展 UI 功能 |
| 真实线上环境 | 没有运行；无站点/PG/S3/HTTPS 凭据与目标，不用本机成功替代 |

开发中两类测试夹具问题均保留记录：Node fetch 未发送测试期望的自定义 Host，换用原生 HTTP 客户端后仍维持同样安全断言；假 S3 以完整 URL 而非对象路径存储，SDK 的操作 query 导致 Get 404，修正假服务后字节测试通过。另一次导入脚本误读 Sites dist 导致本机网关端口拒绝连接，已增加模式提前检查并按普通构建顺序复验；没有削弱服务端校验或 UI 断言。

本机 Node 实际版本 22.19.0；没有 Deno、psql 或 nginx 可执行程序。Docker CLI 28.5.1 存在，但 Desktop Linux Engine 管道不可用，未启动守护进程、拉镜像或创建容器。没有新增 Dockerfile，非 Docker 模板不受此影响。目标 LTS 补丁、Linux 原生依赖安装和 systemd 仍需实际验收。

### 10.6 尚未通过的生产验收与下一轮顺序

**当前不得据此报告“整个产品已部署成功”或直接进行生产切换。**

1. **平台与预算：** 用户在 Qoder Sites Settings/账号页面核实 Functions/SDK、额度/计费、应用 Secret 输入、预期访问者与正式 HTTPS 地址；独立 Node、PG、S3 由用户选定或授权复用。未授权不得购买、新建资源或改变受众。
2. **Sites 门槛：** 无库 SDK 注入、forwardApplicationCredentials、Set-Cookie/getSetCookie、平台 Cookie/保留头剥离、物理入口不可绕过私有准入、20 MiB 有效 PDF、65 秒以内行为、网关内存/并发、Worker MIME/缓存/深链均需真实目标验收。当前不转发未经证明的客户端 IP，所以限流会聚合到网关出口；账号/可信 IP 限流与预算仍是上线阻断，不能靠信任客户端 XFF 修复。
3. **数据库：** 专用 PG 库先跑隔离 schema 迁移，再跑真正 PG 的多账号 API/Session 重启、约束、连接失败恢复、证书/CA/最小权限。原 SQLite 通过不代表 PG 已验收。对真实数据只备份副本并设计 ETL/对账，不自动迁移默认数据。
4. **对象存储：** 专用私有 bucket 验证有效 PDF 上传、字节下载、删除/失败重试、匿名直接访问拒绝、最小 IAM、TLS、加密/版本/生命周期及恢复。HEAD 就绪探测不能取代这些验收。
5. **入口与运维：** 实际 nginx -t、systemd 启停/信号排空、HTTPS 跳转/Secure Cookie/续期/退出、代理头伪造与源站绕过、响应安全头、平台/反代/应用日志脱敏和告警、备份恢复。现有 Host/Origin/Cookie 单元/本机测试仅提供本地证据。
6. **既有业务安全：** 任意总结保存的来源复核、上传/解析并发与总配额、公开注册/账号恢复策略、持续对象删除队列排空和数据库/对象对账等 5A 未闭合项仍未修复；本轮没有把部署适配扩展成产品功能重构。生产 AI 继续关闭。
7. **获准隔离入口的端到端：** 两个真实获准访问者经过完整平台准入与应用登录，测试注册/退出/共享/私有笔记/撤权/刷新/PDF、失败恢复；主方案门槛不满足就验唯一备用方案，不降低认证要求。
8. **最终发布申请：** 完成前述测试及恢复演练，明确域名、受众、预算、维护窗口、数据校验和回滚版本后，再取得新的生产发布/迁移授权。保留原数据与源码检查点；不自动清空 IndexedDB，不把旧站点开成公开，不接入真实模型。

## 11. 5B-3 首次发布记录与当时暂停条件（2026-11-22）

本节保留首次静态发布的快照；后续受众变化、API 网络证据、本地复验和用户选择见第 12 节，不将当时的 private 状态或资源选择状态当作最新结果。

### 11.1 Sites 测试前端已发布，不等于应用验收完成

- 实际测试地址：<https://paperflow-test-200fmn04qwb.qoder.website>。
- 发布操作返回 `succeeded`、`committed: true`、`published: true`；随后站点查询确认 `active`、`hasPublishedContent: true`、`access_mode: private`。
- 本轮初始 context、owned/shared 列表均无已有站点；创建的是隔离静态测试站。没有调整访问范围；“公网 HTTPS 地址”不等于“匿名公开访问”。
- 使用原项目 `dist`、`spa: true`、`databaseAccess: none`，没有提交 Function 目录或 Secret 依赖。实际 backend 为 `disabled`、capabilities 和 functions 均为空；不能把通用的 functionPublicationStatus 字段解释成已部署业务 Function。
- 本轮重新运行 `npm run build:sites`（含 TypeScript）通过；发布包共 11 个文件、2,220,023 字节。仅 HTML/JS/CSS/favicon 和原创双页示例 PDF，没有源映射、后端源码、`.env`、用户数据库、私人论文或根目录需求文档。浏览器运行必需的编译后 JavaScript 会提供给获准访问者，不是将私有源码仓库公开。
- 静态文件逐项白名单和敏感配置名称扫描通过；原创 PDF 已提取两页文字核对。主脚本为 `assets/index-CCM5L5Bp.js`，SHA-256 为 `485e6645cc7e30d44089dfa8c9d67393524f191136bc55119c26c9db165fb4ab`；线上文件哈希比对尚待登录。
- 平台生成项目根目录 `.PaperFlow · 研知同行（测试站）.qoder.site`；不得手写其发布字段或用新站点绕过登录。后续更新复用该绑定。

### 11.2 实际线上验证与未执行项目

| 项目 | 本轮真实结果 |
| --- | --- |
| Sites 发布 | 已成功，仍为私有测试站；未开通业务后端 |
| HTTPS 入口 | Node 原生 HTTPS 请求启用 `rejectUnauthorized: true`，证书校验成功、协商 TLS 1.2，首页匿名请求返回 401 JSON；这是平台准入响应，不是 PaperFlow API 响应 |
| 浏览器访问 | 从真实站点地址进入后跳到 Qoder 登录页；未代填账号、未提交登录、未提取或注入 Cookie |
| 首页与静态资源 | 应用页面未进入，未完成线上验证；发布平台验包不能替代浏览器加载检查 |
| SPA 深层路由刷新 | 发布参数已启用回退，但真实路由刷新未验收 |
| 移动端布局/PDF Worker | 本轮线上未验收；不能引用 5B-2 本机结果作为线上通过 |
| 前端 API 地址 | Sites 产物固定 `/functions/v1/app/api`，没有应用 localhost 上游；对应 Function 和独立 Node 尚未上线，不能认为 API 已可用 |
| Node 与健康 | 尚未选定或授权托管目标，没有后端公网地址，未运行线上健康检查；现有探针是 `/health/live`、`/health/ready` 和 `/api/health`，没有单独的 `/health` 路由 |
| CORS 与会话 | 当前代码为同源请求，不开放跨站凭据 CORS；Session 为 HttpOnly、SameSite=Lax、生产 Secure。仅有代码及 5B-2 本机证据，没有线上 Cookie、登录/退出或跨站拒绝的验收证据 |
| 数据与 AI | 未连接生产用户库、未迁移任何 IndexedDB、未上传私人论文、未配置或调用真实 AI；无 DNS 修改或 Git 提交/push |

本轮临时浏览器登录页已关闭，没有改动用户已有页面。后续从测试站地址重新进入，由用户亲自完成登录；不记录登录密码或平台凭据。

### 11.3 用户需要完成的授权与资源选择

1. **站点访问：** 使用发布该站点的 Qoder 账号登录测试地址，再通知继续验收。若目标是无需登录的公开演示，需要用户明确批准将这个静态测试站改为匿名公开；不以测试失败为理由自动放开权限，也不开放未上线的业务 API。
2. **Node 托管：** 优先复用经授权的独立 Linux 测试主机，使用 Node LTS + Nginx + systemd；需提供目标、允许部署的目录及安全管理通道。使用已经配置的 HTTPS 主机名与有效证书，不改 DNS、不新购实例；若没有现成资源，先由用户确定服务商、区域、规格、预算或核实免费额度，再授权创建，当前暂停创建步骤。
3. **配置输入：** 后端和数据库凭据只通过目标主机受限环境文件/托管平台 Secrets 输入，不在聊天、命令行或前端配置中粘贴。继续保持 AI 三项为空。
4. **Sites 网关：** 后端地址就绪后再确认无库 SDK 注入及应用 Cookie 透传契约，并取得 Functions 资源开通授权。当前仅发布静态前端，不会为了通过健康检查把一个固定成功响应当作现有 Node 服务。

### 11.4 独立 Node 的最小可执行路径（尚未执行）

保留第 10.1 节架构及 REST API，不改业务模型、不降低生产启动门槛：Sites 前端 → 同源薄 Function → 已有 HTTPS 入口的 Nginx → 回环 Node。部署使用第 10.4.B 节现成命令与 `deploy/paperflow.service`、`deploy/nginx-sites.conf.example`；这套方案不依赖 Docker，也不要求公开源码仓库。

1. 在批准的全新测试目录私密部署完整 `server/`、`package.json`、`package-lock.json`，以及预检需要的 `scripts/check-production-config.mjs`；按需包含 `scripts/verify-deployment.mjs` 和经审核的部署模板。使用目标 OS 的 Node LTS，运行 `npm ci --omit=dev`；不复制本机 node_modules、`.env` 或 `.paperflow-data`。Node 运行不依赖前端 build；第 10.4 的隔离迁移测试另需 `scripts/migration-test.mjs`，仅在获准的测试环境部署和运行。
2. 注入隔离测试库/私有 bucket、稳定 SESSION_SECRET、精确来源/Host/可信代理和网关令牌，运行 `check:production`。现有服务在数据库/存储初始化后才监听，因此无 PG/S3 时连 `/health/live` 也不能启动；不切换 development 或连接生产库来绕过。
3. 仅在另获**测试空库建表授权**后应用 001/002/003 schema，不导入生产、SQLite 或 IndexedDB 数据。先核对目标并运行只读 status；不自动执行迁移。
4. 安装并检查已有 systemd/Nginx 模板。Node 只监听回环；只向外开放现有 HTTPS 入口，源站 API 要求服务间令牌。验证 `/health/ready` 返回依赖真实状态，异常返回 503，再验证同源网关路径。未经网关授权，不直接把浏览器改成跨域携带 Cookie 调用 Node。
5. 后端真实就绪及网关发布后，再运行已有 `verify:deployment` 的完整验收；当前静态站不具备它要求的 API，不把失败改成跳过后宣称全链路通过。

### 11.5 下一轮 PostgreSQL / S3 联调前置条件

- 专用空 PostgreSQL 测试数据库，支持经验证的 TLS/CA；迁移角色和低权限运行角色分开。允许后端网络访问，并明确仅测试库/schema 可执行迁移和清理；不得使用生产用户库。
- PostgreSQL 中需要业务表及 session 表；先按第 10.4 节在授权测试库的随机 schema 运行迁移测试，再批准运行服务所用的空 schema。验证 PG 连接、Session 持久化与证书拒绝，不能沿用 SQLite 成功结论。
- 专用私有 S3 兼容 bucket，明确区域、HTTPS endpoint 和 path-style；最小权限包括 HeadBucket 及指定对象的 Get/Put/Delete，禁止公开 ACL。健康阶段可只探测 HeadBucket，不上传论文；对象验收仅使用明确授权的原创样本并清理测试对象。
- 明确数据留存、费用限制、合成测试账号、可用网络/防火墙、故障恢复范围和清理授权；涉及创建资源、付费、DNS 或正式数据迁移时再次暂停确认。
- 当前停止点：前端访问等待用户登录/受众授权，后端等待用户选定并授权资源。**最小“前端页面 + Node 健康”在线链路尚未闭合。**

## 12. 线上故障诊断、本地复验与 Linux 接入（2026-11-22）

### 12.1 根因与真实网络、平台日志证据

**根因是部署链路缺失：浏览器已有静态前端，但 `/functions/v1/app/api` 没有已发布的应用 Function，独立 Node 业务服务也没有部署。** 不通过切回本地模式、Mock 健康接口、放宽 CORS 或重新发布同一静态包掩盖问题。

- 重新查询发布结果仍为 `published: true`、站点 `active`；最新 `access_mode: selected`，与首次发布时的 private 不同。本助手没有更改受众，也不推断是谁更改。
- 最新 backend 为 `disabled`，capabilities 和 functions 均为空。仓库存在 `functions/index.ts` 不等于该 Function 已上线；平台通用发布字段也不证明 Function 存在。
- 内置浏览器进入 `/knowledge` 仍跳转 Qoder 登录；之后进入真实同源 API 页面，执行带 `credentials: same-origin` 的手动 fetch，并从浏览器 Network 读取以下记录。它们是实际网络请求，不是已登录应用页面点击产生的流量。

| 浏览器请求 ID | 方法与站点内路径 | 实际响应 |
| --- | --- | --- |
| 23 | GET `/functions/v1/app/api/health` | 409，`sites_gateway_supabase_not_ready` |
| 24 | GET `/functions/v1/app/api/auth/me` | 409，同上 |
| 25 | GET `/functions/v1/app/api/knowledge` | 409，同上 |
| 26 | POST `/functions/v1/app/api/auth/register` | 409，同上；仅发送无效空对象 `{}` |
| 27 | POST `/functions/v1/app/api/auth/login` | 409，同上；仅发送无效空对象 `{}` |

所有响应均为可读取的 JSON，固定消息为 `Supabase backend is not ready`。没有提交真实账号资料或创建线上应用账号。平台报错不意味着既有 Node 业务应改写成 Supabase 业务。

- 原生 HTTPS 客户端开启证书校验，交叉检查三个 GET 路径，也收到相同 409。直接请求 Sites 域名的 `/health/ready` 得到 401 `sites_gateway_login_required`；这不是独立 Node 的健康响应。
- 平台 Function 的 requests 和 output 日志查询均返回 `sites_function_logs_not_ready`。日志能力当前不可用，不能写成“日志为空”或“服务端没有错误”；没有已部署 Node 的日志可供本轮读取。
- 本轮失败不是浏览器 CORS 拦截：请求与站点同源，浏览器可以读取完整响应。没有 `Access-Control-Allow-Origin` 在此并非异常；Cookie、业务身份和会话尚未进入真实线上 Node，不能据此宣称已通过或定位为 Cookie 故障。
- 409 是平台后端未就绪，既不是 PaperFlow 的登录失败 401，也不是业务路由 404。Node 路由在本地确实存在并已复验。

前端 `src/services/api.ts` 与 `vite.config.ts` 在 Sites 模式使用同源 `/functions/v1/app/api`，没有将 localhost 写成生产 API 上游。Vite 的 `/api`、`/functions/v1/app` 代理仅在本地开发/预览进程运行，不随静态产物上线。开发 SQLite 也不是 Sites 的持久化服务。

右上角“远程模式”来自 `src/services/libraryStore.ts` 读取的 `paperflow-storage-mode`，表示所选存储模式，不表示后端连接成功；`src/services/auth.tsx` 遇 me 非 401 错误进入 unavailable，页面显示远程服务不可用。没有清空或更改用户的 localStorage / IndexedDB。

### 12.2 本轮隔离本地复验

实际执行以下命令，两项均退出 0；没有借用真实 AI 配置：

```bash
AI_BASE_URL= AI_MODEL= AI_API_KEY= npm run test:backend
AI_BASE_URL= AI_MODEL= AI_API_KEY= \
  PAPERFLOW_TEST_SITES=0 PAPERFLOW_TEST_PREVIEW=0 PAPERFLOW_RUN_REGRESSIONS=0 \
  npm run test:collaboration-browser
```

- **API 集成：** 真实 Node、临时 SQLite/Session 和私有文件系统。健康 200→文件目录暂不可用 503→恢复 200、注册/登录/me、服务重启后的会话与个人笔记恢复、PDF/进度、知识库、邀请码/团队/讨论及权限隔离通过；未使用线上 PG/S3。
- **真实浏览器：** 脚本启动当前 Node 与 Vite 开发服务器，两个独立浏览器会话，经同源 `/api` 操作注册、建队/加入、原创 PDF 上传/阅读、选区批注/编辑、跨账号回复、知识卡片/人工记录、重登、原文定位、移动端和成员退出。没有用 API 写入代替这些 UI 操作，没有模型 Mock。
- **证据边界：** 浏览器脚本中的匿名 401、退出后团队/PDF/知识库 404 是浏览器内只读 API 断言，不冒充 UI 点击。个人笔记与服务重启恢复由 API 集成专项证明；浏览器重登和硬导航覆盖身份恢复，但本轮没有单列 F5 后 me 的专项 UI 断言。
- 生成六张本地合成测试截图；实际目视核对桌面阅读器、桌面团队页和移动知识库。截图不含私人论文；它们不是公网截图。
- 本轮没有重建/重发静态站，没有修改认证、协作、UI 源码、依赖或生产配置模板；不把既有 5B-2 的生产预览/Mock 适配测试当作本轮公网证据。

| 验收项 | 本地结果 | 公网结果 |
| --- | --- | --- |
| 首页、资源与 SPA 深链 | 本轮未单独复验首页；历史 5B-2 生产预览已通过。当前协作页面、阅读器和知识库实际浏览器加载通过 | **尚未测试**应用页面；内置浏览器停在平台登录。静态发布成功不等于加载验收通过 |
| 后端健康 | **本地通过**：真实依赖正常/故障/恢复状态 | **失败**：同源 health 返回平台 409，没有 Node 在线健康结果 |
| 注册、登录、me | **本地通过**：注册/重登 UI + API 身份校验 | **失败**：路由探针均为平台 409；有效账号流程尚未测试 |
| 刷新与会话恢复 | **本地部分通过**：API 服务重启与 me 恢复、UI 重登/硬导航通过；专项 F5 断言尚未测试 | **尚未测试**：Secure Cookie、刷新恢复、退出与过期 |
| 科研知识库 | **本地通过**：创建、读取、贡献、人工记录、私有范围与移动端操作 | **失败**：GET 列表返回平台 409；其余业务流程尚未测试 |
| PDF 上传和阅读 | **本地通过**：原创样本上传、PDF Worker、页码、选区与原文定位；无效 PDF 拒绝 | **尚未测试**：真实 S3、平台上传限额与 Worker 加载 |
| 两账号团队协作 | **本地通过**：建队、邀请加入、共享、角色差异、退出 | **尚未测试**：两个获准平台访问者的完整线上流程 |
| 批注、回复、笔记持久化 | **本地通过**：UI 编辑/跨账号回复/重登重读；API 重启恢复个人笔记与知识记录 | **尚未测试**：真实 PG/S3 持久化 |
| 权限隔离 | **本地通过**：个人/跨团队隔离、Owner/Member 限制、退出立即失效 | **尚未测试**：线上账号隔离、源站绕过与平台准入边界 |

本轮没有任何一项公网 PaperFlow 业务通过；已通过的是此前平台静态发布/HTTPS 入口，以及本轮隔离本地业务测试。

### 12.3 最小部署方案与尚缺目标信息

采用 **A：Sites 静态前端 + 同源薄 Function + 独立 Linux Node + PostgreSQL + 私有 S3**。用户已选择“已有 Linux 主机”，不再要求重新选择托管方式。B 的 Edge/Deno 适配涉及 Express、Session、数据库和存储接口，不是最小改动；不重写已有认证或协作。

目前只确认资源类别，尚未提供可操作的具体目标；没有尝试连接任意 SSH 主机，也没有扫描凭据或猜测域名。继续前需由用户通过适当通道补齐：

| 信息/操作 | 非敏感信息或安全输入方式 |
| --- | --- |
| 主机身份 | 已配置的 SSH 别名，或主机地址、端口、用户名；确认允许使用的测试主机及其管理方式 |
| 授权范围 | 可用的新部署目录、是否允许安装 systemd 服务/Nginx 站点及 reload；保留已有站点和服务 |
| HTTPS 入口 | 已有 API 主机名及有效证书的部署位置；不发送证书私钥，不自动修改 DNS |
| PostgreSQL | 确认专用空测试库、网络/TLS 可用、迁移及低权限运行角色；连接串仅写入目标受限环境文件 |
| 私有对象存储 | 确认已有测试 bucket、区域、HTTPS endpoint、path-style 和受限权限；Access Key/Secret 只在安全环境配置 |
| Sites | 登录该测试站以完成浏览器验收；单独确认 Functions 额度/费用、开通授权及应用 Cookie SDK 能力，不改变 selected 受众 |

选择 Linux 不等于已提供主机登录方式，也不等于授权创建付费 PG/S3、迁移生产库、覆盖 Nginx 配置或公开站点。缺少目标时暂停远端操作，不用临时 SQLite 冒充生产持久化。

### 12.4 可执行配置与接入顺序（远端均尚未执行）

复用 `.env.production.example`、`deploy/sites.env.example`、`deploy/paperflow.service`、`deploy/nginx-sites.conf.example` 及第 10.4.B 节命令；生产模板中的示例域名不可直接使用。

1. **只读核对获准目标：** 确认 Node LTS 实际路径/版本、Linux/Nginx/systemd、可用目录、现有服务/端口与证书；不安装、不 reload、不输出环境变量或配置文件中的密钥。SSH 通过已配置密钥/代理并核验主机指纹，不关闭主机密钥校验。
2. **私密传输最小运行文件：** 按第 11.4 节清单部署到新目录，保留完整 migrations 和预检脚本；在该目录执行 `npm ci --omit=dev`。不公开源码仓库，不复制 Windows node_modules、真实 `.env`、`.paperflow-data`、私人 PDF 或需求文档。Node 无前端编译步骤；前端仍使用 `npm run build:sites`，目前没有前端改动需要重发。
3. **安全填写环境：** Node 使用 production/sites、8787、回环监听，Host 和可信代理按模板精确限制。`AI_ALLOWED_ORIGINS` 填 `https://paperflow-test-200fmn04qwb.qoder.website`；稳定 `SESSION_SECRET` 仅存服务器，网关令牌为随机 base64url 43–128 字符，Node 与 Sites 使用同一个值。PG 必须 verify-full，S3 必须私有且通过 HTTPS；AI 三项全部留空。环境文件限必要管理员/服务读取，不放 Web 目录、不在聊天或日志显示值。
4. **配置与依赖检查：** 执行第 10.4.B 的 `check-production-config.mjs` 和迁移 `--status`。配置检查只读且不连接依赖，不能证明服务就绪；生产入口在 PG/Session/存储初始化后才监听。只有明确批准专用空测试库建表后，才运行 `--apply`，随后再次 status。禁止将 status 的退出 1 当作迁移授权。
5. **托管与反代：** 审核目标文件与既有服务后安装 systemd/Nginx 模板。使用实际 `node` 路径、非 root 服务账号，检查 `nginx -t` 后才在授权范围内启用/reload。分别验证回环 `/health/live`、`/health/ready` 与已有 HTTPS 入口 `/health/ready`；后者必须反映真实 PG/Session/S3 检查，不返回固定成功值。8787 不直接暴露公网。
6. **接通 Sites 网关：** 先确认该账户/Worker 支持候选 SDK 注入及 `forwardApplicationCredentials`/应用 Cookie 透传，再在明确授权下开通所需 Functions。不能假定 functions-only + databaseAccess:none 一定满足契约；不为解决平台 409 擅自创建额外数据库，不启用 QCA/PAT。Secret 值通过现有 Sites Settings 安全输入：`APP_ORIGIN` 是上述站点来源，`APP_API_ORIGIN` 是核验后的真实后端 HTTPS origin，`APP_GATEWAY_TOKEN` 与 Node 一致。复用现有站点，完整发布同时包含 dist 和 functions，不仅重发静态包。
7. **验收真实链路：** Cookie 维持 HttpOnly、Secure、SameSite=Lax、Path=/，浏览器始终同源 `/functions/v1/app/api`，不开放跨站凭据 CORS。先验证网关 health 真正到达 Node，再用两个获准测试账号按第 12.2 表逐项执行；查看真实浏览器 Network、可用 Function 请求日志、脱敏 Nginx/Node 日志。日志不可用即记录未验收，绝不打印 Cookie、密码、网关令牌、连接串或对象存储密钥。
8. **无法满足 Sites SDK 契约时：** 停止该网关发布，说明实际限制；只有用户同意变更入口后，才采用第 10 节唯一备用的同一 HTTPS 域名托管 dist + `/api`，不自行切换域名或削弱认证。

本轮临时 API 诊断浏览器页已关闭，用户存储和站点受众未更改。**当前停止点：本地业务通过，线上仍不可用；缺具体 Linux/HTTPS 目标、隔离 PG/S3 安全配置及 Sites Functions/迁移操作授权，尚未达到可登录和协作的线上交付目标。**
