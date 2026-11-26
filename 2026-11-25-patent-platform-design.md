# Patent 功能合并设计文档（PaperFlow 内嵌版）

- 日期：2026-11-26（基于 2026-11-25 独立平台版修订）
- 状态：待评审
- 项目目录：本仓库（PaperFlow）
- 技能资产来源：`D:\myAgent\patent-skills-master`（patent-skills v1.0.0，复制为本仓库根目录 `skill-assets/`，含 `SKILL.md`、`prompts/`、`references/`、`assets/`、`tools/`、`scripts/`；注意 `render_disclosure_docx.py` 在 `scripts/` 下）

## 0. 合并原则（本次修订的核心）

原设计为独立新项目（FastAPI + Vue 3 + JWT + SQLAlchemy）。经确认，**技术栈以 PaperFlow 现有实现为准，以最小代价合并**：

1. **不引入第二套技术栈**：不新建 FastAPI/Vue 服务。后端为统一后端（`server/server.mjs`）新增专利路由模块，前端为 React 19 + Tailwind 现有设计系统新增页面。
2. **复用现有能力**：账号会话（express-session + bcrypt）、AI Provider（`server/openai-provider.mjs`，OpenAI 兼容 Chat Completions）、PDF 存储与校验（multer + pdfjs-dist + `.paperflow-data/pdf/`）、SSE、HTTP 安全中间件（`http-security.mjs`）、Knex 迁移体系。
3. **Python 工具以子进程保留**：DOCX 渲染（`tools/md_to_docx.py`、`scripts/render_disclosure_docx.py`）与 CNIPA 查新（`tools/cnipa_epub_search.py`，Playwright）不翻译，由 Node `child_process` 调用；Python 环境不可用时明确降级，不伪造结果。
4. **案件与文献库联动**：专利案件的输入是文献库中的一篇论文（`paper_id`），支持"从已有文献发起"与"上传新论文并发起"两条入口，复用现有上传校验与文件存储。
5. **业务设计不变**：流水线状态机、坑埋点、提案契约、精确匹配打补丁与版本规则（§7、§8）沿用原设计。

### 非目标（本期不做）

- 多人实时协同编辑交底书
- 与专利代理机构系统对接、CPC 提交
- 计费系统
- 移动端专项适配（沿用现有响应式布局）
- 专利案件进入团队空间共享（本期案件一律个人私有）

## 1. 背景与目标

现有 patent-skills 是运行在 Codex/Claude 会话内的 Agent Skill（Markdown 指令 + Python 工具）。本项目将其改造为 PaperFlow 内的 Web 功能：

1. **用户界面**：从文献库选择或上传 PDF 论文 → 服务端调用已配置的 LLM 执行专利流水线 → 返回技术交底书（可选升级为完整申请书）→ 在线预览与下载 → 填写使用反馈；另提供独立的专利关键词查新搜索框。
2. **管理员界面**：查看系统自动记录的"坑"（结构化异常事件）与用户反馈；周期性触发 AI 汇总分析，生成**修改提案**（精确原文片段 + 建议内容 + 理由 + 证据来源）；管理员对每条提案**接受 / 拒绝 / 自行修改**；接受的提案应用后记录版本号。
3. **硬约束**：AI 在任何情况下不直接修改技能资产文件；所有变更由管理员批准触发，经 git 提交留档（仅限 `skill-assets/` 路径），可回滚。

## 2. 角色与核心流程

复用现有账号体系，不新建用户表。`004` 迁移为 `users` 增加 `is_admin` 标记（默认 0）；启动时按环境变量 `PATENT_ADMIN_EMAILS`（逗号分隔）幂等提升对应账号，不内置种子密码账号。**专利功能全程要求登录（远程模式），包括 M1。**

### 2.1 用户（研究者）

```
登录 → 新建案件（选文献库论文，或上传 PDF 同时入库）
     → 查看流水线进度（SSE 实时推送）
     → 回答缺口追问（表单）→ 预览交底书（Markdown 渲染）
     → 下载 .md / .docx（DOCX 依赖服务器 Python 环境，不可用时明确提示）
     → [可选] 点击"升级为完整申请书"（独立异步任务）
     → 填写反馈（评分 + 文字）
```

独立查新：输入关键词词块 → 后台执行查新 → 结果对比表（含可核验 URL）。

### 2.2 管理员（技能维护者）

```
登录（is_admin 账号）→ 看板（坑日志统计、反馈列表、案件量、token 用量）
     → 周期任务（MVP 手动触发；周期窗口 = 上次应用以来）
     → 提案审批页：逐条查看 diff、理由、证据（可跳转原始记录）
     → 裁决：接受 / 拒绝 / 编辑后接受
     → 点击"应用本周期已接受提案" → 精确匹配打补丁 → git commit（仅 skill-assets）
     → 技能版本号 +1，版本历史留档
```

隐私说明：坑日志与反馈可能包含用户论文相关内容，管理员可见性需在界面与文档中明示；本期不做匿名化。

## 3. 总体架构

```
┌─ 前端 React 19 + Tailwind（现有设计系统 src/components/ui）─┐
│ 用户：案件列表/详情(进度/缺口/预览/下载/反馈)/独立查新        │
│ 管理员：看板/坑与反馈/周期/提案审批(diff)/版本历史            │
└──────────────┬─────────────────────────────────────────────┘
               │ REST + SSE（express-session 会话，is_admin 校验）
┌─ 统一后端 server/server.mjs ┴──────────────────────────────┐
│ registerPatent()（新增模块，仿 registerKnowledge 模式）      │
│   api        专利路由（/api/patent/*）                       │
│   pipeline   编排器（状态机，进程内任务队列）+ 各步骤          │
│              LLM 调用复用 openai-provider.mjs                │
│   services   PDF 文本提取(pdfjs-dist) / Python 子进程封装     │
│              / 查新 Provider / 坑日志记录器                   │
│   iteration  收集 → AI 提案 → 审批应用（git 路径限定提交）     │
│ 存储：现有 SQLite/PG（Knex 004 迁移）                        │
│       案件产物 .paperflow-data/patent/{案件}/                 │
└──────────────┬─────────────────────────────────────────────┘
┌─ skill-assets/（仓库根目录，git 管理，唯一被迭代的对象）──────┐
│ SKILL.md  prompts/  references/  assets/  tools/  scripts/   │
│ 每个案件记录生成时所用 skill_version                          │
└─────────────────────────────────────────────────────────────┘
```

关键原则：

- **技能资产与平台代码分离**。平台代码只读取 `skill-assets/`；自我迭代只作用于 `skill-assets/`，不改平台代码。`skill-assets/` 与 `.qoder/skills/`（Qoder 开发环境技能，不由网页服务调用）互不干扰。
- **LLM 复用现有 Provider**。`requestChatCompletion`（Chat Completions、usage 校验、上游错误分类）已可用，配置沿用 `AI_BASE_URL / AI_MODEL / AI_API_KEY`。不新建适配层。分钟级长任务拆分为**按章节/按步骤的多次调用**，每次控制在 `AI_TIMEOUT_MS`（上限 120s）内；单步失败可重试。
- **查新可插拔**。`SearchProvider` 接口，三级实现按配置选择：
  1. `CnipaProvider`：子进程调用 `skill-assets/tools/cnipa_epub_search.py`（需服务器 Python + Playwright，外网可用时优先）
  2. `WebSearchProvider`：搜索 API（内网走网关时，API 选型见开放问题）
  3. `NullProvider`：明确返回"查新未执行"，绝不伪造结果
  当前生效 Provider 在管理员看板可见；Python 缺失时自动降级并记录 pitfall。
- **长任务全部异步**。进程内任务队列（每案件串行）+ SSE 推进度；不引入 Celery/Redis/BullMQ。**运行状态落库**：服务启动时把中断的 running 步骤标记为 failed（可重试），不静默丢失。
- **PDF 解析复用 pdfjs-dist**。服务端已用其做上传校验；扩展为按页 `getTextContent` 提取，清理与分块规则对齐现有浏览器端实现（`src/features/ai/`）。不引入 PyMuPDF。公式/图片/扫描件为已知局限，走 pitfall 埋点。上传限制与文献库一致：**仅 PDF、≤20MB**（原 50MB 作废）。

## 4. 技术栈（对照原设计的变更）

| 层 | 原设计 | 合并后 | 说明 |
|---|---|---|---|
| 后端 | FastAPI + SQLAlchemy | Express（现有统一后端）+ Knex | 新增 `server/patent/` 模块，`registerPatent()` 挂载 |
| LLM | 新建 llm_client.py | 复用 `server/openai-provider.mjs` | 协议已确认：OpenAI 兼容 Chat Completions |
| PDF 解析 | PyMuPDF | pdfjs-dist（已有依赖，服务端已引入） | 公式/扫描件局限不变 |
| 查新 | Playwright 直用 | 子进程调 Python 脚本 / 搜索 API / 降级 | 三级 Provider 不变 |
| DOCX | Python 脚本直用 | 子进程调 `md_to_docx.py` / `render_disclosure_docx.py` | Python 不可用 → 仅 MD 下载 + pitfall |
| 前端 | Vue 3 + Element Plus + Pinia | React 19 + react-router + Tailwind + 现有 ui 组件 | 状态沿用现有 store 模式 |
| 预览 | markdown-it | markdown-it（新增小依赖，框架无关） | MVP：预览 MD、下载 DOCX |
| Diff | diff2html | diff2html（框架无关，保留） | 编辑框用现有表单组件 |
| 定时 | APScheduler | MVP 仅手动触发，不引入调度依赖 | 后续如需定时再加 node-cron |
| 认证 | JWT + passlib | express-session + bcrypt（现有） | `users.is_admin` 区分角色 |
| 部署 | Docker / 裸 Python | 沿用现有 nginx 同源反代 + systemd（deploy/） | Python 为可选组件，见 §12 |

## 5. 目录结构（新增部分）

```
-paperflow/
├── 2026-11-25-patent-platform-design.md   # 本文档（需求文档按惯例留根目录）
├── skill-assets/                          # 复制自 patent-skills-master，git 管理
├── server/
│   ├── migrations/004_patent.cjs          # 专利表 + users.is_admin
│   └── patent/
│       ├── index.mjs                      # registerPatent()：路由注册
│       ├── orchestrator.mjs               # 案件状态机 + 任务队列 + 启动恢复
│       ├── steps/                         # parse / convert / search / draft / export / upgrade
│       ├── services/
│       │   ├── pdf-text.mjs               # pdfjs-dist 服务端提取
│       │   ├── python.mjs                 # 子进程封装（超时/编码/错误捕获）
│       │   ├── search/                    # cnipa / websearch / null Provider
│       │   └── pitfall.mjs
│       └── iteration/
│           ├── collector.mjs  proposer.mjs  applier.mjs
├── src/
│   ├── pages/                             # PatentCasesPage / PatentCasePage / PatentSearchPage / PatentAdminPage
│   ├── features/patent/                   # 进度 stepper、缺口表单、MD 预览、提案审批 diff
│   └── services/patent.ts                 # API 客户端 + SSE 订阅
├── scripts/
│   ├── patent-backend-test.mjs            # 隔离 SQLite + 假 Provider + applier 单测
│   └── patent-browser-test.mjs            # 真实 UI 端到端
└── .paperflow-data/patent/{案件}/          # 案件产物（gitignore，随数据目录）
```

## 6. 数据模型（Knex 004 迁移）

沿用现有风格：字符串 UUID 主键、字符串时间戳、外键 + 索引、提供 `down`。表名统一 `patent_` 前缀避免冲突。

| 表 | 关键字段 | 说明 |
|---|---|---|
| users（改） | + is_admin（默认 0） | 启动时按 PATENT_ADMIN_EMAILS 幂等提升 |
| patent_cases | id, user_id, paper_id, title, status, skill_version, created_at | paper_id 外键关联现有 papers；案件输入即文献库论文 |
| patent_artifacts | id, case_id, kind, version_ts, path | kind: disclosure_md / disclosure_docx / application_md / application_docx；文件名 `{案件名}_{YYYYMMDDHHmmss}.{ext}`，继承 skill 命名约定，不覆盖旧稿 |
| patent_runs | id, case_id, step, status, error, tokens, usage_status, started_at, finished_at | 每步一条；token 统计来自 Provider 的 usage 校验，缺失标记 missing，不伪造 |
| patent_gap_answers | id, case_id, questions_json, answers_json | 缺口追问与回答留档 |
| patent_search_tasks | id, user_id, case_id(可空), keywords, provider, status, hits_json | 独立查新 case_id 为空 |
| patent_feedbacks | id, case_id, user_id, rating(1-5), content, created_at | 反馈栏 |
| patent_pitfalls | id, case_id(可空), run_id(可空), category, severity, context_json, created_at | 结构化埋点，见 §8.1 |
| patent_cycles | id, window_start, window_end, summary_md, status, created_at | collecting/proposed/applied/closed |
| patent_proposals | id, cycle_id, target_file, original_snippet, proposed_snippet, reason, evidence_json, status, admin_edited_snippet, reviewed_by, reviewed_at, applied_version | 核心契约，见 §8.2 |
| patent_skill_versions | id, version(semver), git_commit, changelog_md, cycle_id(可空), created_at | 版本历史 |

与文献库的关系：

- 新建案件两条入口：选择已有论文；或上传 PDF（走现有上传校验与存储，先入库再建案件）。
- 删除论文时若存在关联案件，提示用户并**级联删除案件及其产物记录与文件**（与现有知识卡片级联行为一致）。
- 案件仅创建者可见，不进团队空间；本地 IndexedDB 模式不支持专利功能（需服务端流水线），界面明确引导切换到远程模式。

## 7. 流水线状态机（案件，沿用原设计）

```
uploaded → parsing → converting → searching → drafting
        → review_ready（交底书产物就绪，等用户预览）
        → exported（用户首次下载任一交底书产物即置为此态）
review_ready/exported → upgrading → upgrade_ready（申请书产物就绪）
任意步骤失败 → failed（记录 pitfall，用户可重试该步骤）
converting 中若材料缺口 → awaiting_gaps（前端表单追问）→ converting
```

- 每步实现 = 读取 `skill-assets/prompts/对应.md` + `references/regulatory-standards.md` → 调 `requestChatCompletion` → zod 校验结构化产出 → 落盘产物。
- drafting 按交底书章节拆分多次调用，规避单次超时；章节产物合并后整体校验。
- 规范核验（standards）：按 `prompts/standards_lookup.md` 执行联网核验；不可用时记录 pitfall 并在产物中标注"规范未联网核验"。
- 中间产物 JSON 化：缺口清单、查新命中、修订摘要均为 JSON + Markdown 双输出。
- upgrade 为用户显式触发的独立异步任务，产物单独记录；触发处固定展示免责声明。
- 服务重启：启动时将所有 running 状态步骤置为 failed（error=服务重启中断），案件可重试，不自动续跑。

## 8. 自我迭代闭环（业务核心，沿用原设计）

### 8.1 坑的定义（结构化埋点）

| category | 触发条件 |
|---|---|
| pdf_parse_low_quality | 提取文本字数/页数低于阈值，或疑似扫描件 |
| search_zero_hits | 查新 0 结果 |
| search_timeout / search_captcha | Python 查新脚本超时 / 遇验证码 |
| search_degraded | Provider 降级（cnipa→websearch→null，含 Python 缺失） |
| llm_api_error | API 超时/报错/重试（复用 Provider 错误分类） |
| llm_output_invalid | 产出缺章节、zod 校验失败 |
| gaps_exceeded | 缺口追问超过 3 轮仍未补齐 |
| docx_render_error | Python 渲染失败或环境缺失 |
| standards_offline | 规范联网核验不可用 |

每条含上下文（案件、步骤、原始错误、耗时），供周期汇总统计。

### 8.2 提案契约（不变）

```json
{
  "id": 42, "cycle_id": 7,
  "target_file": "prompts/convert.md",
  "original_snippet": "……目标文件中的精确原文片段……",
  "proposed_snippet": "……建议改成的内容……",
  "reason": "为什么这样改",
  "evidence": [{"type": "pitfall", "id": 113}, {"type": "feedback", "id": 58}],
  "status": "pending",
  "admin_edited_snippet": null,
  "applied_version": null
}
```

- proposer 将周期内全部坑 + 反馈 + 目标文件当前内容交给 LLM，要求仅输出符合此 schema 的提案列表；`original_snippet` 必须逐字来自当前文件（生成时校验，不合法的提案直接丢弃并记录）。
- 提案只允许指向 `skill-assets/` 内文件；指向平台代码的提案拒绝生成。
- 每条提案必须携带至少一条真实存在的 evidence ID，前端可跳转原始记录。

### 8.3 提案状态机与审批（不变）

```
pending → accepted / rejected / modified（管理员编辑后接受）
accepted/modified → applied（周期应用时成功打补丁）
                  → conflict（原文片段不匹配或多次出现，待复核）
```

管理员界面（React）：左侧提案列表（状态过滤），右侧 diff 视图（diff2html）+ 理由 + 证据链接 + 三个操作按钮（接受/拒绝/编辑后接受，编辑框预填 proposed_snippet）。

### 8.4 应用与版本规则（git 隔离为合并后新增约束）

- 管理员点击"应用本周期已接受提案"触发 applier：
  1. 逐条在目标文件中做**精确唯一匹配**；不匹配或不唯一 → 标记 conflict，跳过，绝不模糊替换。
  2. 全部可应用提案写入文件后，**路径限定提交**：`git commit -m "skill: cycle {id} proposals {ids}" -- skill-assets`，只提交 `skill-assets/` 内变更，**绝不卷入仓库其他未提交改动**（合并进主仓库后的关键约束）。
  3. 版本号规则：周期批量应用 → minor +1；手动热修 → patch +1；不兼容重构 → major +1（人工判定）。同步更新 `SKILL.md` frontmatter version，打 tag **`skill/v{X.Y.Z}`**（前缀隔离，不与 PaperFlow 自身版本混淆）。
  4. 写入 `patent_skill_versions`（版本、commit、changelog、cycle）。
- **环境前提**：applier 要求运行目录是 git 仓库且服务进程有提交权限。不满足时（如 Qoder Sites / 无 git 的部署）应用操作明确报错并禁用按钮，文件不被修改；可在开发机执行应用后随代码部署。
- 回滚 = `git revert` 对应 commit（M4 提供界面按钮，MVP 命令行操作）。
- 每个案件创建时固化 `skill_version`，用于回答"新版本是否更好"。

## 9. API 清单（前缀 /api/patent，会话认证）

全部走现有会话与 `http-security.mjs`（Host/Origin/大小校验）；admin 路由服务端校验 `is_admin`；案件/产物访问校验归属，不信任前端提交的用户 ID。

| 方法/路径 | 角色 | 说明 |
|---|---|---|
| POST /cases | user | 传 paper_id 建案件并启动流水线（上传入口复用现有论文上传 API） |
| GET /cases | user | 我的案件列表 |
| GET /cases/{id} | user | 详情（状态、产物、缺口问题） |
| GET /cases/{id}/events | user | SSE：步骤进度/产物就绪/失败（沿用现有 SSE 模式） |
| POST /cases/{id}/gaps | user | 提交缺口回答，恢复流水线 |
| POST /cases/{id}/retry | user | 重试失败步骤 |
| POST /cases/{id}/upgrade | user | 触发完整申请书任务 |
| GET /cases/{id}/artifacts/{aid} | user | 产物内容（MD 原文供预览） |
| GET /cases/{id}/artifacts/{aid}/download | user | 下载 .md/.docx（鉴权读取，不公开静态路径） |
| POST /cases/{id}/feedback | user | 评分 + 文字 |
| POST /search | user | 关键词查新（异步） |
| GET /search/{id} | user | 查新状态与命中结果 |
| GET /admin/dashboard | admin | 坑分类计数、反馈、案件量、token 用量、当前 Provider |
| GET /admin/pitfalls /admin/feedbacks | admin | 记录列表（过滤/分页） |
| POST /admin/cycles/trigger | admin | 手动触发迭代周期 |
| GET /admin/cycles /admin/cycles/{id} | admin | 周期与汇总报告 |
| GET /admin/proposals | admin | 提案列表（按周期/状态过滤） |
| POST /admin/proposals/{id}/decision | admin | accept / reject / modify(附编辑内容) |
| POST /admin/cycles/{id}/apply | admin | 应用已接受提案 → 路径限定 commit → 版本 |
| GET /admin/versions | admin | 版本历史 |

## 10. 前端页面（React）

路由：`/patent`（案件列表 + 新建）、`/patent/cases/:id`（详情）、`/patent/search`（独立查新）、`/patent/admin`（管理端，is_admin 可见入口）。

**用户**：案件列表；新建（选文献库论文 / 上传）；案件详情（stepper 进度 + 缺口表单 + MD 预览 Tab（交底书/申请书切换）+ 下载按钮 + 升级按钮（附免责声明）+ 反馈栏）；独立查新页（词块输入 + 结果对比表）。复用 `src/components/ui/` 与现有布局。

**管理员**：看板；坑日志/反馈浏览页；周期列表与汇总报告页；提案审批页（diff + 证据 + 裁决）；版本历史页。

## 11. 合规与安全

- 每次交付预览/下载处固定展示 skill 原文免责声明（不写入文档正文）；升级入口提示"需专利代理师审核"。
- 脱敏：draft 步骤继承 `references/desensitization.md`，服务端校验产出。
- 上传校验复用现有实现：仅 PDF、≤20MB、文件头检查、随机文件名；产物路径由服务端生成，杜绝路径穿越。
- PDF 内容视为数据而非指令：拼入 prompt 时包裹在明确的材料区块中，防提示注入（与现有 AI 功能口径一致，引用校验不能完全防注入，文档明示）。
- 认证复用现有会话机制（HttpOnly/SameSite Cookie、登录限流、Origin 校验）；不引入 JWT。
- LLM API 密钥仅存服务器环境变量，不下发前端（现状已满足）。
- Python 子进程：参数以数组传递不经 shell 拼接；脚本路径固定在 `skill-assets/` 内；超时强杀。
- 管理员可见他人反馈与坑日志（可能含论文内容），界面明示该可见性。

## 12. 部署（沿用现有方案）

- 跟随现有 nginx 同源反代 + systemd（`deploy/`）；无新增常驻服务。
- **Python 为可选组件**：服务器安装 Python 3.10+ 及 `skill-assets/tools/requirements-cnipa.txt`、DOCX 渲染依赖后，DOCX 下载与 CNIPA 查新可用；未安装时功能明确降级（仅 MD / 查新走 WebSearch 或 Null），不影响主流水线。
- 迭代应用功能要求部署目录为 git 仓库（见 §8.4）；Qoder Sites 等无 git/Python 环境仅运行用户侧流水线（降级模式），管理端应用按钮禁用。
- 新增环境变量：`PATENT_ADMIN_EMAILS`、查新 Provider 选择与搜索 API 配置、`PATENT_PYTHON`（Python 可执行路径，默认自动探测）。

## 13. 里程碑与验收标准

| 里程碑 | 范围 | 验收 |
|---|---|---|
| M1 用户流水线 | 登录 + 从文献库/上传建案件 → parse→convert→search→draft→export；MD 预览 + MD 下载（Python 可用时含 DOCX）；SSE 进度；004 迁移 | 一篇真实 PDF 论文端到端产出交底书，产物含时间戳命名与免责声明；重启后中断案件标记 failed 且可重试 |
| M2 完整用户侧 | 独立查新页；缺口表单；反馈栏；坑埋点全量；is_admin 角色；upgrade 可选升级 | 查新降级路径可切换验证（含 Python 缺失）；每类埋点可人工触发入库 |
| M3 迭代闭环 | 管理员看板；周期汇总；提案生成/审批/编辑；精确匹配应用；路径限定 git commit + skill/v 标签 | 构造坑+反馈跑通完整周期：提案→接受/拒绝/改后接受→应用→版本号+1→`git log -- skill-assets` 可查且**不含仓库其他改动**；冲突提案正确跳过；无 git 环境应用被禁用 |
| M4 部署与质量 | 随现有部署上服务器；评测集（≥3 篇标准论文+期望要点）；回滚按钮；DOCX 预览评估 | 服务器上线；改 prompt 后评测可跑并输出对比 |

## 14. 测试策略（对齐现有 scripts 模式）

- `scripts/patent-backend-test.mjs`：隔离临时 SQLite + 真实文件系统 + 假 Provider（沿用 `test:team` 模式）；覆盖编排状态机、重启恢复、鉴权越权、applier 精确匹配/冲突/路径限定提交/版本规则（applier 断言为必须项）。
- `scripts/patent-browser-test.mjs`：自启动隔离前后端，真实 UI 走建案件→进度→预览→下载→反馈；管理端提案裁决流。
- Python 子进程用固定 fixture 脚本 mock，不依赖真实 CNIPA 网络；真实查新单独手动验证。
- 评测集（M4）：真实 LLM 跑标准论文，检查期望要点命中率，作为 prompt 迭代防退化闸门。
- 现有回归（`test:backend`、`test:collaboration-browser` 等）必须保持通过，004 迁移纳入 `test:migrations`（up/down/up 保留既有数据）。

## 15. 开放问题（不阻塞 M1 开发）

| 问题 | 影响 | 兜底 |
|---|---|---|
| 服务器 Python/Playwright 可用性 | DOCX 下载、CNIPA 查新 | 明确降级 + pitfall，主流水线纯 Node 不受影响 |
| WebSearchProvider 的搜索 API 选型 | 内网查新 | NullProvider 明确"未执行"，不伪造 |
| PDF 公式/扫描件解析质量 | 转换质量 | pdf_parse_low_quality 埋点暴露，迭代循环消化 |
| 用户规模/并发 | 是否引入任务队列中间件、PG | 进程内队列起步，Knex 已支持 PG |
| 分钟级 drafting 的章节拆分粒度 | 超时与产出一致性 | 按交底书模板章节拆分，单章失败单章重试 |

### 已解决（原开放问题关闭）

- ~~团队 LLM API 协议待确认~~：复用现有 OpenAI 兼容 Provider 与配置。
- ~~部署双模式择一~~：跟随现有 nginx + systemd 方案。
- ~~认证方案~~：复用现有会话体系，不引入 JWT。