# 第一阶段开发计划：本机浏览器版

> 2026-11-06 · 依据 `docs/design/design.md` v0.4、`docs/design/ui-design.md`、`docs/prototype/`
> 2026-11-08 用户澄清认证归属：第三方 Agent 沿用自身配置；AI Console 独立 Agent 使用工作台自定义 API 与模型。最新规则见 9.15、9.16，覆盖第 6 节及 9.11 中代登录、API 账号替换的旧要求；设计已同步为 v0.4.4。第三方边界整改已提交 0abbda6，独立执行器、多 API / 多模型能力发现与清理仍未完成（ISSUE-0029、0028）。
> 2026-11-08 重新规划（用户要求：原型和设计改动较多，1.1 不动，从 1.2 起按现在的进度重新排）：1.2 判定为已通过，遗留项并入新的 1.3；原型 2026-11-07 的改动（轻量化、上下文与 token 统计、“详细”面板、新建任务起始页、对话导航条、统一的模型选择器、附件与图片）拆成新的 1.3、1.4；原来的 1.3～1.5 顺延为 1.5～1.7。进度盘点见第 7 节，原因见 devlog 2026-11-08。
> 范围：在本机浏览器里使用的完整工作台。桌面软件（Tauri）、手机应用、外网访问放到后续阶段，但从第一行代码开始就按“多端共用同一套接口”来写，以后接入不需要返工。

## 1. 阶段划分

| 步 | 状态 | 内容 | 对应设计 | 完成标准 |
|---|---|---|---|---|
| 1.1 骨架 | 已完成 | 工程结构、共享协议包、Gateway（HTTP + WebSocket、令牌鉴权、事件库）、假 Agent、网页外壳（侧栏、对话、右侧面板）、双击启动脚本 | 2、3、10、13、14、15、16.4 | 双击启动后浏览器自动打开；和假 Agent 完成一次带工具调用和审批的对话；刷新页面、断网重连后对话完整恢复 |
| 1.2 接入真实 Agent | 已通过，遗留项并入 1.3 | ACP 客户端；Claude Code、Codex、CodeBuddy 适配器；能力探测；Agent 管理页；账号配置；会话内换模型和思考强度；启用开关；草稿与注释；回复按轮显示 | 6、7.4（H0/H1） | 三个 Agent 都能在网页里登录、选模型、完成对话、换模型不丢上下文（验收见 `docs/acceptance/step-1.2.md`，未验证项见第 7.2 节） |
| 1.3 稳定、补验与输入框 | 部分通过，独立 Agent 与清理未完成 | 稳定性、真实补验、统一选择器与附件；第三方边界已整改，独立 Agent 的执行器规格及自有 API 功能待补齐 | design 6.4、15.2、17；ui 5.5、6.5、6.16 | 见 8.1、9.15 |
| 1.4 界面改版与用量 | 未开始 | 轻量化样式；新建任务起始页；右侧“详细”（环境、计划、上下文、会话 token 用量、连接、输出）；上下文圆环；每轮用量；对话导航条；账号额度和上下文明细的调研 | design 15.1、15.5；ui 6.11～6.15 | 见 8.2 |
| 1.5 任务与工作区 | 未开始（原 1.3） | git worktree；非 git 项目的影子快照；改动（diff）面板；合并 / 丢弃 / 回滚；权限规则和“总是允许”；开放“工作区内自动 / 全自动”；看板；“详细 → 输出”改为工作副本的改动 | 8、9、13 | 在 git 项目和非 git 项目各完成一个改代码的任务，并分别合并和回滚 |
| 1.6 上下文与交接 | 未开始（原 1.4） | 任务账本、`.aic/TASK.md`、自动交接 H2–H4、覆盖校验、`aic_history` 工具、交接分隔条；换 Agent 发送消息时才交接；换账号的交接 | 7；ui 6.5、6.8 | 同一任务从 Claude Code 交接到 Codex，全程不弹窗，交接后继续完成且不重复已做的改动；选了别的 Agent 但没发消息时不交接、可以撤销 |
| 1.7 局域网浏览器 | 未开始（原 1.5） | 局域网开关、防火墙规则、配对码、设备管理 | 16 | 在手机浏览器上配对后完成一次审批 |

编号对照（2026-11-08 之前的记录里写的步号）：原 1.3 → 1.5，原 1.4 → 1.6，原 1.5 → 1.7。旧的验收记录、devlog、问题单不改写；仍未关闭的问题单在时间线里追加新目标。

后续阶段（不在本计划内）：监控和调用统计（用 1.4 的用量数据）、自动化、快速判断、能力中心（MCP / Skill，“详细 → 连接”的完整列表在这里）、侧聊、资产和三维预览、媒体生成、ZCode 桥接（ISSUE-0020，用户决定先不接）、桌面软件、手机应用、外网中转。

排序理由：1.3 先把已有功能修稳、验实，界面和用量统计是用户最近反复确认的需求，所以 1.3、1.4 排在工作区之前；“输出”一节和改动面板依赖工作副本，交接依赖任务账本和工作副本的 diff，所以工作区在交接前面。

## 2. 接口规则（所有阶段都必须遵守）

这些规则保证以后加桌面软件、手机应用、外网访问时，Gateway 和网页不用改。

1. 客户端只通过一套接口访问 Gateway：REST `/api/v1/*` 加一条 WebSocket `/api/v1/ws`。网页界面也是这套接口的普通客户端，没有任何“只有本机网页能用”的捷径。
2. 接口带版本号。`GET /api/v1/hello` 返回服务端版本、协议版本、功能开关和本机信息。客户端连上后先调用它，按功能开关决定显示哪些功能。
3. 所有类型定义只写在 `packages/protocol` 一处，Gateway 和网页都从这里引用。请求和事件在边界上用 zod 校验，不信任客户端传来的任何数据。
4. 鉴权从第一天就有：每个请求都必须带令牌，本机也不例外。同时校验 Host 和 Origin 头，不开 CORS。令牌按设备发放，设备列表里可以吊销（16.3、16.4）。
5. 实时数据只走事件：每个事件都有全局递增的 `seq`。客户端重连时带上 `lastSeq`，服务端补发缺失的事件。客户端发出的每条指令都带 `id`，服务端用 `ack` 回应，重复的 `id` 不会重复执行。事件类型只增不改：客户端必须忽略不认识的事件类型（WebSocket 推送和 `GET /tasks/:id/events` 历史分页都一样，逐条解析、跳过不认识的，不能让整页失败；分页按原始条数和 `seq` 翻页）。
6. 客户端不接触本机路径和进程：选文件夹走 `GET /fs/browse`，读文件走 `GET /tasks/:id/files/*`，大文件用 HTTP Range。客户端代码里不出现 Windows 路径拼接。
7. 和运行环境相关的能力（通知、选文件夹、在 IDE 中打开、打开外部链接、复制到剪贴板、安全存储）都封装在网页的 `Platform` 接口里。现在只实现浏览器版本，以后桌面软件和手机应用各自提供一份实现。
8. 统一错误格式：`{ code, message, hint, actions[] }`。`message` 写给用户看，`actions` 是界面可以直接渲染的按钮，例如“重新登录”。
9. ID 一律是不透明字符串，时间一律是毫秒时间戳，文本一律 UTF-8。分页用游标，不用页码。
10. 不在接口里假设网络位置：客户端只认一个基础地址。以后通过局域网或外网中转访问时，只是换了这个地址。

## 3. 技术选择（已核对版本，2026-11-06）

| 部分 | 选择 | 说明 |
|---|---|---|
| 工程管理 | npm workspaces | 本机没有 pnpm；npm 11 的 workspaces 够用，不需要另外安装 |
| 语言 | TypeScript 5.9.3 | 不用刚发布的 7.0，等生态跟上再说 |
| Gateway | Node 24 + Hono 4 + `@hono/node-server` + `ws` | — |
| 存储 | Node 内置的 `node:sqlite` | 不需要编译原生模块，Windows 上没有安装问题。目前还是实验特性，用一层薄封装隔离，必要时可以换成 better-sqlite3 |
| ACP | `@agentclientprotocol/sdk` 2.4.0；`claude-agent-acp` 0.100.0；`codex-acp` 2.5.0 | 锁定版本 |
| 网页 | React 19 + Vite + TypeScript；样式沿用原型的设计令牌 | 原型的视觉和交互是验收依据 |
| 测试 | Vitest；接口契约测试用假 Agent | — |
| 启动 | `启动 AI Console.bat`：检查依赖 → 启动 Gateway → 打开浏览器 | 用户不需要敲命令 |

## 4. 工程结构

```
AI_Console/
├─ packages/
│  ├─ protocol/   共享类型、zod 模式、事件定义、错误码
│  ├─ gateway/    本地服务：API、事件库、会话、Agent 适配器
│  └─ adapters/   （1.2 起）各 Agent 适配器；1.1 先放 fake
├─ apps/
│  └─ web/        网页界面（Vite + React）
├─ docs/        设计、调研、计划、原型、验收、开发笔记、问题收纳（规则见 .agent/records.md）
└─ 启动 AI Console.bat
```

## 5. 每一步怎么做、怎么验收

- 先写协议（`packages/protocol`），再并行写 Gateway 和网页。两边只靠协议对接。
- 每一步结束都做三件事：自动测试全部通过；在浏览器里按完成标准实际点一遍；独立审查（找 bug、找接口规则违例、找安全问题）。
- 数据库结构从 1.1 起就用版本号迁移，后面加表不需要删库。
- 代码进 git，在分支上提交，用户确认后快进合并到 main 并推送到 GitHub（规则见 `.agent/commit-convention.md`）。

## 6. 1.2 实现规格

> 认证归属更正（2026-11-08）：本节保留 1.2 实施时的规格供追溯。6.3 的工作台代登录、6.4 的按第三方 Agent 注入工作台 API 账号，以及相应界面和补验要求，已被用户在 9.15 确认的新边界覆盖，不得继续按旧规格新增认证或开展 API 账号替换测试。未被覆盖的接口、安全和任务规则继续有效。

> 2026-11-08 注：1.2 已通过，本节保留为当时的规格。文中“第 1.3 步”“第 1.4 步”按新编号分别是 1.5、1.6（见第 1 节编号对照）；6.9 里没验证的项改在 1.3 完成（8.1）。
> 2026-11-06 · 依据：本文第 1.2 步与第 2 节；design.md 6、7.4、9；ISSUE-0001；三个 Agent 的本机实测（未调用 `session/prompt`，未验证项汇总在 6.9）。
> 实测环境：Windows 11、Node 24.14；claude-agent-acp 0.100.0（自带 claude.exe 2.1.316）、codex-acp 2.5.0（自带 codex 0.165.0）、CodeBuddy 引擎 2.115.0。

### 6.1 总体与约束

- 新建 `packages/adapters`（`@aic/adapters`），Gateway 依赖它。适配器接口从 `packages/gateway/src/agents/registry.ts` 移到 `packages/adapters/src/types.ts`；`registry.ts` 只保留 `AgentRegistry`，并重新导出这些类型，Gateway 里现有的引用路径不变。演示 Agent `fake.ts` 一并移入（第 4 节已约定），行为不变。
- 依赖精确锁定：`@agentclientprotocol/sdk` 2.4.0、`@agentclientprotocol/claude-agent-acp` 0.100.0、`@agentclientprotocol/codex-acp` 2.5.0。适配器的传递依赖里带着引擎（`@anthropic-ai/claude-agent-sdk` 与 `-win32-x64` 0.3.316，`@openai/codex` 与 `-win32-x64` ^0.165.0），在根 `package.json` 的 `overrides` 里钉成精确版本，并在验收记录里写下 lockfile 中的实际版本。
  - 安装时不得使用 `--omit=optional`，否则没有 win32 二进制。
  - codex-acp 自带一份嵌套的 SDK ~2.1.0，和我们的 2.4.0 并存，不处理。
  - 自带的 claude.exe 约 335MB，只在 `node_modules` 里，不进仓库。
- SDK 2.4.0 已删除 `ClientSideConnection`。客户端统一这样写：`acp.client({ name, version }).onRequest(...).onNotification(...).connect(acp.ndJsonStream(Writable.toWeb(stdin), Readable.toWeb(stdout)))`，得到长连接（`.agent / .closed / .close()`）。handler 收到的是 ctx，参数在 `ctx.params`。`session/resume`、`session/close`、`session/set_config_option` 等从 `@agentclientprotocol/sdk/unstable` 引入；`session/set_model` 不在 `methods` 常量里，用字符串调用。
- 本步任务的 cwd 直接是项目目录（工作副本在 1.3 才有）。真实 Agent 默认权限为“需审批”，并且只开放“只读”和“需审批”两档（6.3.4）。
- 注入 MCP：本步 `mcpServers` 一律传 `[]`（`aic_history` 在 1.4）。以后注入的服务名一律带 `aic-` 前缀，因为 Codex 会静默跳过与用户配置同名的服务（ISSUE-0001）。
- 凭据边界：Gateway 和适配器不读取、不复制任何 Agent 自己的凭据文件（`~/.claude`、`~/.codex/auth.json`、`~/.codebuddy`、`~/.workbuddy`）。登录状态只通过 Agent 自己的命令或 ACP 方法判断，并且只取“是否已登录 / 登录方式”这类字段。

### 6.2 `packages/adapters` 结构

```
packages/adapters/
├─ package.json
├─ src/
│  ├─ index.ts            createAdapters()、类型导出
│  ├─ types.ts            AgentAdapter / AgentConnection / AgentUpdate / AgentCaps（自 gateway 迁入并扩展）
│  ├─ fake.ts             演示 Agent（自 gateway 迁入）
│  ├─ verified.ts         已验证版本表
│  ├─ redact.ts           日志与错误文本脱敏
│  ├─ acp/
│  │  ├─ launch.ts        启动方式解析、spawn、进程树清理
│  │  ├─ connection.ts    AcpConnection：进程 + ACP 客户端 + 超时 + stderr
│  │  ├─ session.ts       AcpSession：实现 AgentConnection，三家共用
│  │  ├─ updates.ts       session/update → AgentUpdate
│  │  ├─ permissions.ts   request_permission 选项归一化
│  │  ├─ config.ts        configOptions 解析（按 category 找模型、思考强度、模式）
│  │  └─ errors.ts        ACP 错误 → ApiError（登录失效、额度、找不到会话）
│  ├─ claude/index.ts
│  ├─ codex/index.ts
│  └─ codebuddy/index.ts
└─ test/
   ├─ fixtures/fake-acp-agent.mjs   假 ACP Agent 进程（6.8）
   ├─ *.test.ts                     契约测试
   └─ real.smoke.test.ts            真实 Agent 冒烟（AIC_REAL_AGENTS=1 才运行）
```

在 1.1 的接口上只增不改：

- `SpawnOptions` 增加 `env`（Gateway 算好的账号环境变量，6.4）、`resume?: { agentSessionId }`、`signal?`。
- `AgentConnection` 增加：`caps`；`config()`，返回当前的模型、思考强度、模式及各自的可选项（`SessionConfigState`）；`onExit(cb)`，进程意外退出时回调；`resumed`，表示这次是恢复的还是新建的。
- `AgentUpdate` 增加 `usage { used, size, cost? }`、`mode { modeId }`、`config_options { state }`、`notice { level, text }`。
- `buildEnv(profile, secret: string | null)`：密钥由 Gateway 解密后传入，适配器不接触密钥存储。
- `DetectResult` 增加 `adapterVersion`、`engineVersion`、`engineSource`（`bundled` / `local` / `app`）、`verified`、`authMethods`（归一化后的登录方式，6.3）。

#### 6.2.1 AcpConnection（三家共用）

启动（`launch.ts`）：

- 一律用 Gateway 自己的 Node 运行 js 入口：`spawn(process.execPath, [入口 js, ...args], { shell: false, windowsHide: true, stdio: 'pipe', cwd, env })`。
  - Claude：`require.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')`。
  - Codex：`require.resolve('@agentclientprotocol/codex-acp/dist/index.js')`。
  - CodeBuddy：`%LOCALAPPDATA%\Programs\WorkBuddy\resources\app.asar.unpacked\cli\dist\codebuddy.js`，参数 `--acp`。
- 不启动 `.cmd` / `.bat`。Node 24 不经 shell 启动 `.cmd` 会报 EINVAL（CVE-2024-27980 的修复），而 `shell: true` 有命令注入风险。遇到 npm shim 时，解析出它最终执行的 js 入口或 exe 再启动。例如 `CLAUDE_CODE_EXECUTABLE` 只能指向 `claude.exe`，不能指向 `claude` / `claude.cmd`。
- 环境变量：以 `process.env` 为底，先删掉会串号的变量，再叠加 `SpawnOptions.env`。删除清单：`ANTHROPIC_*`、`CLAUDE_CODE_USE_*`、`CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_EXECUTABLE`、`OPENAI_*`、`CODEX_*`、`CODEBUDDY_*`、`NO_BROWSER`、`SSH_CONNECTION` / `SSH_CLIENT` / `SSH_TTY`、`CLAUDE_CODE_REMOTE`、`APP_SERVER_LOGS`、`ACC_PRODUCT_CONFIG*`。这样用户在命令行里用 `claude-api` 之类工具设的全局变量不会混进来，`SSH_*` 也不会让 Claude 只剩 TUI 登录。
- 日志里只写入口、参数和环境变量的名字，不写值。

进程树清理：

- 进程树：Claude 是 node → claude.exe → MCP；Codex 是 node → node(codex.js) → codex.exe → MCP；CodeBuddy 是 node → MCP。实测结束顶层进程后子进程都退出了，但仍要兜底。
- `close()` 的顺序：支持 `session/close` 就先调用（-32002 视为成功）→ 关闭 stdin → 等 3 秒 → `child.kill()` → 再等 2 秒还在，就 `execFile('taskkill', ['/PID', pid, '/T', '/F'])`。
- Gateway 退出时（SIGINT、SIGTERM、`beforeExit`、未捕获异常），对所有存活的 Agent 进程同步执行 `taskkill /T /F`。
- 新表 `agent_processes(pid, created_at, agent, session_id)` 记录启动过的进程。Gateway 下次启动时，对仍然存在且创建时间一致的 pid 执行 `taskkill /T /F`，然后清表。创建时间用 `Get-CimInstance Win32_Process` 的 `CreationDate` 核对，防止 pid 被复用后误杀。

stderr：

- 按行读取，每行截断到 2000 字符，经 `redact.ts` 脱敏后写进 Gateway 日志，前缀 `[agent:<kind>:<sessionId>]`。内存里保留最后 200 行，供崩溃诊断用。stderr 不进事件库，也不发给客户端。
- 脱敏规则：本次启动注入的每个密钥原文；`sk-[A-Za-z0-9_-]{16,}`；`Bearer\s+\S+`；`(api[_-]?key|token|secret|password)\W*[:=]\s*\S+`。命中的一律替换为 `***`。事件里的 `error.message` 也走同一个函数。
- stdout 只应有 NDJSON。出现非 JSON 行时记一条警告（前 200 字符，脱敏后），跳过该行，不断开连接。

超时：

| 阶段 | 超时 | 超时后 |
|---|---|---|
| 进程启动到 `initialize` 返回 | 30 秒（实测 0.3–1.4 秒，留出首次启动的余量） | 结束进程树，报 `agent.start_timeout` |
| `session/new` | 60 秒（Codex 还要在后台拉起 10 多个全局 MCP） | 同上 |
| `session/resume` / `session/load` | 60 秒 | 同上，然后按“无法恢复”处理（6.5.4） |
| `set_config_option` / `set_mode` | 15 秒 | 报错，界面保留切换前的值 |
| `session/prompt` | 不设总超时 | 用户点 [停止] 时发 `session/cancel`；10 秒内没有返回就结束进程树 |

initialize：

- clientCapabilities 为 `{ fs: { readTextFile: false, writeTextFile: false }, terminal: false }`；Claude 额外加 `auth: { terminal: true }`，否则拿不到 authMethods。
- 三家都请求 `protocolVersion: 1`，不启用 ACP v2。

Agent 发来的请求和通知：

- 只处理 `session/request_permission`。`fs/*`、`terminal/*` 没有声明，收到就回 -32601；`elicitation/*` 本步也回 -32601，表单卡片放到后续。
- `onNotification('*')` 接住所有私有通知（`_auth/status_update`、`_codebuddy.ai/*` 等）。认识的交给适配器处理，不认识的只记类型名，不报错。

#### 6.2.2 session/update → 协议事件

| ACP `sessionUpdate` | AgentUpdate | 协议事件 | 规则 |
|---|---|---|---|
| `agent_message_chunk` | `message` | `message.delta` | 只取 `content.type == "text"`；图片、资源块写成“[图片]”“[附件：名称]”。有 `messageId` 就用；没有就由 AcpSession 为每段连续回复生成一个。遇到其他类型的更新或回合结束时补发 `message_done` → `message.done` |
| `agent_thought_chunk` | `thought` | `thought.delta` | 同上。收到第一条后把 `caps.thoughts` 置为 true，写回能力缓存 |
| `user_message_chunk` | — | — | 正常回合里丢弃（用户消息已由 Gateway 记录）；`session/load` 回放期间同样丢弃（6.5.4） |
| `tool_call` | `tool_start` | `tool.start` | `toolCallId` 加会话前缀作为 toolId，避免跨会话撞号。kind：read→read，edit / move→edit，delete→delete，search→search，execute→execute，fetch→fetch，think→think，其他（含 switch_mode、缺省）→other。target 取 `locations[0].path`，没有时依次取 `rawInput.command` / `file_path` / `path`，都没有为 null。如果 status 已经是 completed / failed，紧接着补一条 `tool_end` |
| `tool_call_update` | `tool_output` / `tool_end` | `tool.output` / `tool.end` | content 里的 text 块 → `tool.output`；diff 块 → `tool.output`，内容写“修改 <path>（+a −b）”，diff 正文留给 1.3 的 diff 面板；terminal 块不会出现（没有声明 terminal）。status completed → `ok=true`；failed → `ok=false`；如果这个工具的审批被拒绝过，带 `rejected: true`。toolCallId 没见过时，先补一条 `tool.start`（title 用 update 里的 title，没有就写“工具调用”）。只改 title 的 update 丢弃 |
| `plan` | `plan` | `plan.update` | `entries[].content / status` 直接对应，priority 丢弃 |
| `usage_update` | `usage` | `session.usage`（新增） | `{ used, size, cost? }`。7.4 换模型时据此判断新模型的窗口够不够 |
| `current_mode_update` | `mode` | `session.config`（新增可选字段 `agentMode`） | 同时检查模式漂移：Agent 的模式比当前权限级别映射到的模式更宽松时（例如退出计划模式时选了 bypass），立即用 `set_mode` 改回映射值，并发一条 `notice` |
| `config_option_update` | `config_options` | `session.config`（新增可选字段 `models`、`efforts`） | 用推送的全量 configOptions 覆盖 AcpSession 的配置状态。CodeBuddy 一次切换可能连发 2–3 条，100ms 内的合并成一条事件 |
| `available_commands_update` | — | — | 只把命令名存进能力缓存，本步界面不用 |
| `session_info_update` | — | — | 只用来识别 CodeBuddy 的回放边界（`_meta["codebuddy.ai/historyReplay"]` 的 start / end），其余丢弃 |
| 未知类型 | — | — | 不报错。日志记一条 debug（只记类型名），按类型计数存进能力缓存的 `unknownUpdates`，Agent 测试页能看到 |

回合结束时 stopReason 的映射：end_turn→end_turn，cancelled→cancelled，refusal→refusal；max_tokens 和 max_turn_requests 也映射为 end_turn，另发一条 `notice`：“回复达到长度上限，可以让它继续”。

#### 6.2.3 request_permission → 工作台审批

每个请求生成一张 `approval.requested` 卡片：

- title 用 `toolCall.title`；没有时按工具生成，例如“Claude Code 请求执行命令”。CodeBuddy 的请求里没有 title 和 kind，用 `_meta["codebuddy.ai/toolName"]` 生成。
- detail 是完整的命令或文件路径（来自 `rawInput`），cwd 是任务目录。
- 用户点击后，回传 Agent 给的原始 `optionId`。

选项 kind 的对应关系：

| Agent 给的 kind | 卡片 kind | 说明 |
|---|---|---|
| `allow_once` | `allow_once` | |
| `allow_always` | `allow_always` | 本步隐藏，见下 |
| `reject_once` | `reject_once` | |
| `reject_always` | `reject_always` | 本步隐藏 |
| `allow`（CodeBuddy 沙箱拦截时用的非标准值） | optionId 含 `session` 或 `always` → `allow_always`，否则 `allow_once` | 归一化后按上面的规则显示 |
| `reject`（同上） | `reject_once` | |
| 其他未知值 | 丢弃该选项并记警告 | 一个可选项都不剩时，自动选一个 reject 类选项（没有就回 `cancelled`），并发 `error` 事件说明 |

- 隐藏“总是”类选项有两个原因：本步还没有自己的规则引擎（ISSUE-0006）；Agent 自己的“总是允许”会写进它的配置文件（例如 Claude 的 `allow-with-updates` 会改 settings），违反 design 6.4“不修改用户的全局配置”。例外：没有任何 `allow_once` 时保留 allow_always。例如 Claude 退出计划模式时，只显示 allow_once 的 `exit-plan-default`，其余 `exit-plan-*` 都不显示。
- 如果 SDK 2.4.0 对非标准 kind 做 schema 校验并拒绝请求，就改用 `onRequest('*')` 宽松接收，再自己校验。假 Agent 的 `nonstandard-kinds` 场景（6.8）锁定这个行为。
- 权限级别层面的自动决定（两层同时生效，取更严格的一方，design 9.3）：
  - 只读：所有请求自动选 reject 类选项，不弹卡片，对话里记为 `tool.end rejected`。
  - 需审批：全部弹卡片。
- 超时沿用 1.1 的 30 分钟，到期回 `cancelled`，任务暂停。Agent 进程崩溃或 Gateway 退出时，未决审批一律 `expired`。
- 用户填写的拒绝理由（`note`）ACP 不支持回传，本步只存在审批记录里。

#### 6.2.4 能力探测与缓存

- 新表 `agent_caps(agent, profile_id, adapter_version, engine_version, caps_json, catalog_json, commands_json, probed_at)`，主键 `(agent, profile_id)`。
- `caps_json` 由 initialize 结果和 session/new 的返回推导：
  - `loadSession`、`resume / list / close / fork`：取自 `sessionCapabilities`。
  - `modelSwitch`：有 category 为 model 的 configOption → `configOption`；只有 `models` 字段 → `unstableSetModel`；都没有 → `none`。
  - `modes`、`prompt`、`mcp`：照抄。
  - `extensions`：私有前缀，例如 `_codebuddy.ai/*`。
  - `thoughts`：收到第一条思考后更新。
- `catalog_json` 是最近一次拿到的模型列表、思考强度列表和模式列表（6.3.2）。
- 缓存失效条件：adapter 或引擎版本变了；用户点了 [重新检测]；距上次探测超过 24 小时（design 6.6 的每日探测）。
- 每次真实的 `session/new` / `resume` 都顺带刷新缓存，不额外花钱。
- 已验证版本表（`verified.ts`）：claude-agent-acp 0.100.0 + claude 2.1.316；codex-acp 2.5.0 + codex 0.165.0；CodeBuddy 2.115.0。版本不在表里时照常使用，但 `verified=false`，卡片标黄“未验证版本”（design 6.3）。

### 6.3 三个适配器

#### 6.3.1 总表

| | Claude Code | Codex | CodeBuddy |
|---|---|---|---|
| 启动 | `node claude-agent-acp/dist/index.js` | `node codex-acp/dist/index.js` | `node <WorkBuddy>/…/cli/dist/codebuddy.js --acp` |
| 引擎 | 默认用适配器自带的 claude.exe（版本和适配器一起锁定、一起测过）。Agent 设置里可以改成“使用本机 Claude Code”：注入 `CLAUDE_CODE_EXECUTABLE=<npm 全局>\node_modules\@anthropic-ai\claude-code\bin\claude.exe`。两者读同一个配置目录，登录态共享 | 只用适配器自带的 codex 0.165，不设 `CODEX_PATH`。本机全局 0.120 读不了当前的 `~/.codex/config.toml`（ISSUE-0009）；两者共用 `CODEX_HOME`，登录态相同 | WorkBuddy 内置引擎。找不到时扫描 `%LOCALAPPDATA%\Programs` 下的同名目录（design 6.3），仍找不到就让用户点选安装目录 |
| detect：是否安装 | 适配器包能 resolve，并且引擎 exe 存在 | 适配器包能 resolve，并且自带的 `codex.js` 存在 | `codebuddy.js` 存在 |
| detect：版本 | adapter 读 `package.json`；引擎执行 `claude.exe --version` | adapter 读 `package.json`；引擎读 `@openai/codex/package.json` | 读 `cli/package.json` 的 `version` |
| detect：是否已登录 | `claude.exe auth status --json`，只解析 `loggedIn`、`authMethod`、`apiProvider`，其余字段丢弃，stdout 不写日志；运行时再以 `_auth/status_update` 的 `kind` 校正（`none` 表示未登录） | `node codex.js login status`，只用正则匹配 `^Logged in using (ChatGPT|an API key)`，不写日志；运行时以 session/new 是否返回 -32000 为准 | initialize 后调用扩展方法 `_codebuddy.ai/getUserInfo`，看有没有 `userInfo.userId`；结果只保留“已登录”这个布尔值，不存用户信息。这个检查要启动一次引擎，结果缓存 10 分钟，只在 Gateway 启动、[重新检测] 和登录完成时执行（ISSUE-0008） |
| 登录方式（来自 initialize） | `claude-ai-login`（订阅）、`console-login`（Console，按 API 计费），type 都是 terminal | `chat-gpt`、`api-key` | `iOA`、`external`（Google / GitHub）、`internal`（微信）、`selfhosted`（企业域名） |
| 模型 | configOption `model`（default / opus / fable / sonnet / haiku）；未登录时也能拿到 | configOption `model`；本机只有 1 项，来自用户自定义的 provider | configOption `model`（auto、glm-5.1 等）；`models.availableModels[]._meta` 带 supportsImages / supportsReasoning |
| 思考强度 | configOption `effort`，category `thought_level`；选项随模型变化 | configOption `reasoning_effort`，category `thought_level` | configOption `thought_level`；选项随模型变化，非法组合会报 -32603 |
| 其他配置项 | `ultracode`（model_config）、`agent`（人格）：本步不显示，保持默认 | `collaboration_mode`：本步不显示，保持 default | `sandbox`：本步不显示，保持 Agent 默认值 |
| 恢复 | `resume`（首选）、`load` | `resume`（首选）、`load` | 只用 `load`（sessionCapabilities 没有声明 resume / close / list） |
| 关闭 | `session/close` | `session/close` | 不支持，只能结束进程 |
| 每个进程的会话数 | 1（统一按每个任务会话一个进程） | 1 | 1（引擎内部只有一个 `sessionDeferred`，并发 session/new 可能冲突） |

#### 6.3.2 模型和思考强度（三家共用）

- 一律按 category 找配置项，不写死 id：category `model` 是模型，`thought_level` 是思考强度，`mode` 是模式。
- 列表来源的优先级：
  1. 当前会话最新的 configOptions（session/new、resume、每次 set 的返回、`config_option_update` 推送）。
  2. 能力缓存里的 `catalog_json`。
  3. 旧字段 `models.availableModels`。Codex 的旧字段是 `<model>[<effort>]` 组合 id，要拆开：方括号前是模型，方括号里是强度，去重后使用。
  4. 都没有：模型列表为空，界面只显示“Agent 默认模型”（`model = null`，不下发）；思考强度为 null，界面不提供调节。
- 没有会话时（新建任务的下拉框）从缓存取。缓存为空时：
  - Claude：自动做一次探测会话。session/new 不花钱、不需要登录，cwd 是 `.aic-data/probe/<随机>`，用完删除。
  - Codex、CodeBuddy：不自动探测。前者会拉起全部全局 MCP，后者需要登录，且登录态脆弱（ISSUE-0008）。只在用户点 [测试连接] 或 [重新检测]，以及第一次真实会话时探测；在那之前界面显示“首次使用后显示模型列表”。
- 思考强度的可选项随模型变化：每次切换模型后，以返回的 configOptions 为准重新渲染。如果原来选的强度不在新列表里，改用新的 `currentValue`，并发 `notice`：“新模型不支持 xx，已改为 yy”。
- 切换（H0，design 7.4）：
  - `caps.modelSwitch == 'configOption'` → `session/set_config_option { configId: <model 项的 id>, value }`。
  - `unstableSetModel` → `session/set_model`。
  - `none` → 走 H1：结束进程 → 带新参数重启 → resume / load → 重新下发配置。
  - 每次 set 返回全量 configOptions，直接覆盖会话状态，并发 `session.config`。
  - 非法值（-32602 / -32603）：保留原值，把 Agent 给的说明放进 `error.hint`。
- 恢复之后重新下发一遍任务保存的模型、思考强度和模式。实测 Codex 在没跑过回合的情况下 resume 后，配置会回到默认值。

#### 6.3.3 登录

总原则：用户在界面上点一个按钮完成登录，不出现命令行窗口。能用 ACP `authenticate` 就用；需要浏览器授权的，由 Gateway 在本机打开浏览器，同时把授权链接推给界面（`agent.login` 事件），界面显示“浏览器没有自动打开？点这里”。

| Agent | 方法 | 做法 | 已知限制 |
|---|---|---|---|
| Claude | `claude-ai-login` / `console-login`（terminal 类型，ACP `authenticate` 不支持） | Gateway 以隐藏子进程运行 authMethod 里声明的参数：`node <adapter>/dist/index.js --cli auth login --claudeai`（或 `--console`），注入账号的环境变量，不注入 `NO_BROWSER` / `SSH_*`。CLI 会打开浏览器走 OAuth，回调到 localhost。Gateway 从 stdout 里只提取 `https://claude.ai/`、`https://console.anthropic.com/`、`https://platform.claude.com/` 开头的链接推给界面，其余输出不记录。进程退出码为 0 后再跑一次 `auth status` 确认。最长等 10 分钟，界面有 [取消] | 是否会要求在终端里按回车或粘贴授权码，没有实测（ISSUE-0007）。如果需要粘贴，界面显示输入框，经 `POST …/login/:id/code` 写入子进程的 stdin。完全走不通时，引导用户添加“官方 API Key”账号 |
| Codex | `chat-gpt` | ACP `authenticate { methodId: 'chat-gpt' }`。适配器先检查现有的 ChatGPT 登录，有效就直接返回；否则用本机默认浏览器打开授权页，等完成通知后返回 | 浏览器开在 Gateway 所在的电脑上。手机或局域网场景要用 `chat-gpt-device-code`（需要客户端支持 URL elicitation），放到 1.5 |
| Codex | `api-key` | 不调用 `authenticate`，因为它会把密钥写进 `CODEX_HOME/auth.json`。改用账号配置（6.4）在启动时注入 | — |
| CodeBuddy | `external` / `internal` / `iOA` | ACP `authenticate { methodId }`。引擎会先发 `_codebuddy.ai/authUrl` 通知（转成 `agent.login` 事件推给界面），再打开系统浏览器，等用户登录完才返回。返回里的 `_meta["codebuddy.ai/userinfo"]` 只取“是否有 userId”，其余丢弃 | 对已登录的用户调用 `authenticate` 会先登出。所以只在 getUserInfo 确认未登录时才显示 [登录]；“换账号”要二次确认，文案写明“会同时退出 WorkBuddy 里的账号”（两者共用 `~/.codebuddy`）。另提供 [在 WorkBuddy 中登录]：由 Gateway 启动 WorkBuddy.exe，用户在 WorkBuddy 里登录后回来点 [重新检测] |
| CodeBuddy | `selfhosted` | 本步不提供：企业域名怎么传入，源码里没有确认 | 记在 ISSUE-0008 |

- 登录的生命周期：`POST /agents/:kind/login` 返回 `loginId` → 事件 `agent.login`（started → waiting_browser → succeeded / failed / cancelled，可能带 `authUrl`）→ 完成后重新 detect，并推送 `agent.status`。同一个 Agent 同时只允许一个登录流程，重复请求返回进行中的那个 `loginId`。
- 登出：本步不做（ACP 有 `logout` 能力，放到账号管理完善时再做）。

#### 6.3.4 权限级别 → Agent 模式

| 级别 | Claude | Codex | CodeBuddy | 本步是否开放 |
|---|---|---|---|---|
| 只读 | `plan` | `read-only` | `plan` | 开放；Gateway 另外自动拒绝所有权限请求（6.2.3） |
| 需审批（默认） | `default` | `read-only`（on-request：写文件和越出沙箱的命令都要申请，正好对应“修改、执行要审批”；`workspace-write` 下工作区内的修改不会询问，不符合 9.1） | `default` | 开放 |
| 工作区内自动 | `acceptEdits` | `workspace-write` | `acceptEdits` | 不开放 |
| 全自动 | `bypassPermissions` | `agent-full-access` | `bypassPermissions`（不用 `fullAccess`） | 不开放 |

- 本步不开放后两档。原因：cwd 就是项目目录，没有工作副本可以丢弃；而且 Agent 在这两档下不再发权限请求，Gateway 的“始终禁止”清单拦不住（规则引擎在 1.3）。真实 Agent 的任务选这两档时，接口返回 `permission.level_unavailable`，界面把这两档置灰，并提示“第 1.3 步有了工作副本后开放”。演示 Agent 不受影响。
- 不使用的模式：Claude 的 `auto`，Codex 的 `agent`（auto_review），CodeBuddy 的 `auto`、`dontAsk`、`fullAccess`。
- 模式用 `session/set_config_option { configId: <mode 项的 id> }` 设置，失败时退回 `session/set_mode`。会话建立、恢复、改权限级别后都要设置一次，并且以 `current_mode_update` 校验（模式漂移的处理见 6.2.2）。
- Claude 的初始模式会受用户 settings 里 `permissions.defaultMode` 影响，所以 session/new 之后总是显式设置一次，不依赖默认值。
- 待实测：Codex 在 Windows 上的 `read-only` 沙箱是否真能拦住写操作（6.9）。拦不住的话，需审批级别改用 Gateway 自动拒绝 + 卡片的组合，并开问题单。

### 6.4 账号配置（design.md 6.4）

#### 6.4.1 表结构（数据库迁移 v3，只追加）

```sql
CREATE TABLE agent_profiles (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'subscription' | 'apiKey' | 'customEndpoint'
  config_dir TEXT NOT NULL,        -- 'shared'：用 Agent 的默认配置目录；'isolated'：.aic-data/profiles/<id>/
  base_url TEXT,                   -- customEndpoint 必填
  auth_header TEXT,                -- customEndpoint：'x-api-key' | 'bearer'
  models_json TEXT,                -- 手填或从 /models 拉取的模型列表
  secret_id TEXT,                  -- 指向 secrets.id；subscription 为空
  is_default INTEGER NOT NULL DEFAULT 0,
  last_test_at INTEGER, last_test_ok INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_profiles_default ON agent_profiles(agent) WHERE is_default = 1;
CREATE TABLE secrets (
  id TEXT PRIMARY KEY, scheme TEXT NOT NULL,  -- 'dpapi-user-v1'
  blob TEXT NOT NULL,                         -- base64 密文
  hint TEXT NOT NULL,                         -- 末 4 位，界面显示“结尾 …7Q2c”
  created_at INTEGER NOT NULL
);
CREATE TABLE agent_processes (pid INTEGER NOT NULL, created_at TEXT NOT NULL, agent TEXT NOT NULL, session_id TEXT);
-- agent_caps 见 6.2.4；tasks 增加 profile_id（可空，空 = 该 Agent 的默认账号）
ALTER TABLE tasks ADD COLUMN profile_id TEXT;
```

- 每个 Agent 首次检测时自动建一个默认账号“本机登录”（`subscription`，`config_dir = shared`），也就是用户在这台电脑上已有的登录状态。CodeBuddy 的这个账号显示为“沿用 WorkBuddy 登录”。
- 删除账号：有运行中的会话时拒绝（`profile.in_use`）；引用它的任务改为使用默认账号；对应的 secrets 一并删除；`isolated` 的目录保留，界面提示可以手动删除（避免误删会话记录）。
- `sessions.profile_id` 1.1 已有，开始写入。

#### 6.4.2 各类账号注入的环境变量

只在启动 Agent 进程时注入（`SpawnOptions.env`），不写进任何配置文件，不修改用户的全局配置。所有账号都先经过 6.2.1 的删除清单，再注入下表的变量。

| | 订阅登录 | 官方 API Key | 自定义地址（第三方中转） |
|---|---|---|---|
| Claude | `shared`：不注入；`isolated`（第二个订阅账号）：`CLAUDE_CONFIG_DIR=<profile 目录>/claude`，然后在这个目录里走 6.3.3 的登录 | `ANTHROPIC_API_KEY=<密钥>`；配置目录 `shared`，保留用户的设置、技能和 MCP | `ANTHROPIC_BASE_URL=<base_url>`；鉴权头为 x-api-key 时注入 `ANTHROPIC_API_KEY`，为 bearer 时注入 `ANTHROPIC_AUTH_TOKEN`；如果手填了模型，注入 `ANTHROPIC_CUSTOM_MODEL_OPTION=<第一个模型>` |
| Codex | `shared`：不注入（`CODEX_HOME` 默认 `~/.codex`，和 Codex 桌面版共用）；`isolated`：`CODEX_HOME=<profile 目录>/codex`，在这个目录里走 chat-gpt 登录 | `CODEX_HOME=<profile 目录>/codex`；`CODEX_CONFIG` 里声明一个 provider `aic`（`base_url` 为官方地址，`env_key: "AIC_PROVIDER_KEY"`），并注入 `AIC_PROVIDER_KEY=<密钥>` | 同左，`base_url` 换成用户填的地址，`wire_api` 由用户选（默认 `responses`） |
| CodeBuddy | `shared`：不注入（沿用 WorkBuddy）；`isolated`：`CODEBUDDY_CONFIG_DIR=<profile 目录>/codebuddy` | `CODEBUDDY_API_KEY=<密钥>`（实验性） | `CODEBUDDY_BASE_URL` + `CODEBUDDY_API_KEY`（或 `CODEBUDDY_AUTH_TOKEN`）（实验性） |

- Codex 的 API Key 方案用 provider 的 `env_key` 从环境变量读密钥，目的是不让密钥落盘。`CODEX_CONFIG` 与用户 config.toml 的合并方式还没有实测（6.9）；实测不通时退回“在 isolated `CODEX_HOME` 里调用 `authenticate api-key`”，这样密钥会以 Codex 自己的格式存在 `.aic-data/profiles/<id>/codex/auth.json`，需在界面和问题单里写明。
- CodeBuddy 的 API Key 和自定义地址只有源码依据，没有实测，界面标“实验”。
- 自定义地址的模型列表：先请求 `<base_url>/models`（10 秒超时，带同一个密钥）；拿不到就用手填列表。账号卡片上有 [刷新模型列表]。
- 账号环境变量的值不进日志、不进事件；日志里只写变量名。

#### 6.4.3 密钥存储：Windows DPAPI

- 实现：`SecretStore` 接口有两个实现。`DpapiSecretStore` 用于 win32；`MemorySecretStore` 只用于测试。非 Windows 平台第一阶段不支持保存密钥（返回 `secret.unavailable`）。
- 加密：`execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', <固定脚本>])`。脚本里 `Add-Type -AssemblyName System.Security`，然后调用 `[System.Security.Cryptography.ProtectedData]::Protect(bytes, entropy, 'CurrentUser')`。
  - 明文和 entropy 通过 stdin 传入（base64），绝不放在命令行参数里，因为命令行参数在进程列表里谁都能看到。
  - 输出 base64 密文到 stdout；解密的流程对称。
  - entropy 是安装时生成的 32 字节随机数，存在 `meta` 表里。这样密文同时绑定 Windows 用户和这份数据目录。
  - 用 Windows PowerShell 5.1（系统自带），不依赖 PowerShell 7。不用 `ConvertTo-SecureString`：底层同样是 DPAPI，但取回明文还要绕道 `Marshal`，脚本更长，并不更安全。
- 解密时机：只在启动 Agent 进程、请求 `/models`、[测试连接] 时解密。明文只存在于传给 `spawn` 的 env 对象和这次请求里，不缓存，不写日志。
- 为什么不用 Windows 凭据管理器：Node 没有原生绑定，常用的 keytar 需要编译原生模块，而且已经不再维护，违背“不需要编译原生模块”的选择（第 3 节）；`cmdkey` 能写不能读；PowerShell 自带的命令里没有读取凭据的命令，要靠第三方模块或 WinRT 的 `PasswordVault`，在 5.1 和 7 之间行为不一致。凭据管理器底层也是用户级 DPAPI，换成它并不会更安全。
- 安全性：
  - 能防住的：数据库文件被复制到别的电脑或别的 Windows 用户下、进了备份或网盘、被误提交——这些情况下密文都解不开。
  - 防不住的：以同一 Windows 用户身份运行的恶意程序可以调用 DPAPI 解密（凭据管理器也一样）。这一点在设置页的“安全说明”里写明。
  - 接口不返回明文：GET 只返回 `hasSecret` 和 `hint`（末 4 位）；修改密钥只能整个替换。
- 原型 agents.html 里“保存在 Windows 凭据管理器”的文案，实现时改为“已加密保存在本机（Windows 数据保护）”。

### 6.5 Gateway 的变化

#### 6.5.1 会话运行时

- `AgentRegistry` 注册 fake、claude、codex、codebuddy 四个适配器。`TaskService.ensureRuntime` 不变，仍是 `adapterFor → spawn → probeCapabilities`，只是多了几步：
  - 解析任务的账号（`tasks.profile_id`，为空用默认账号）。
  - 解密密钥，调用 `buildEnv`。
  - 查上一个会话：同一个任务存在 `sessions` 记录，且 `agent_session_id` 非空、agent 和账号都相同时，带上 `resume`（6.5.4）。
- 测试时通过 `createServices({ adapters })` 注入假 Agent，默认测试不注册真实适配器（6.8）。
- 并发上限：每个 Agent 同时最多 2 个会话进程（Agent 设置里可以改为 1–4）。超出时任务进入 `queued`，有进程空出来就按排队顺序启动。
- 空闲回收：会话 30 分钟没有活动（没有回合、没有未决审批）就关闭进程，下次发消息时自动恢复（6.5.4）。会话不结束，只是进程没了。
- `/hello` 的功能开关：`agents.real = true`；新增 `agents.profiles = true`。

#### 6.5.2 cwd 与权限

- cwd 直接用项目目录（1.3 起改为工作副本）。
- 新建任务时，选了真实 Agent，界面在发送按钮上方显示：“这个任务会直接修改项目里的文件（第 1.3 步起改为在独立的工作副本里修改）。”
- 权限默认“需审批”，只开放“只读”和“需审批”（6.3.4）。`POST /tasks` 和 `PATCH /tasks/:id` 对真实 Agent 校验这一点，不满足时返回 `permission.level_unavailable`。

#### 6.5.3 异常处理

| 情况 | 识别方式 | 任务状态 | 界面 |
|---|---|---|---|
| 进程意外退出 | `child.on('exit')`，且不是我们主动关闭的 | 回合进行中 → `interrupted`；空闲 → 不变 | `error`：`agent.crashed`，“Claude Code 意外退出”，按钮 [继续]（重新发消息时自动恢复会话）。stderr 的最后 200 行写进 Gateway 日志，不进事件。未决审批改为 `expired`。会话记录 `status = ended`，`agent_session_id` 保留，用于恢复 |
| 启动或握手超时 | 6.2.1 的超时表 | `failed` | `agent.start_timeout`，按钮 [再试一次]、[测试连接] |
| 登录失效 | ACP 错误码 -32000 / authRequired；CodeBuddy 的 `data.category == "auth"`；Claude 推送 `_auth/status_update` 且 kind 为 none | `paused` | `agent.auth_required`，按钮 [去登录]（打开 Agent 页对应的账号）。同时推送 `agent.status`（`needs_login`），这个 Agent 的能力缓存里登录状态失效 |
| 额度或限流 | 错误信息或 `data` 里匹配 `rate.?limit\|quota\|usage limit\|429\|insufficient\|credit\|余额\|额度` | `paused` | `agent.quota_exceeded`，能解析出重置时间就写进 `hint`；按钮 [换模型]、[换账号] |
| 会话不存在 | resume / load 返回 -32002 或 Resource not found | 不变 | 见 6.5.4 |
| 其他 ACP 错误 | 其余 JSON-RPC 错误 | `failed` | `agent.failed`（1.1 已有）；message 经过脱敏 |

不自动重试，不自动换账号或模型。额度错误后任务暂停（design 10.1 的 TaskScheduler 职责），等用户决定。

#### 6.5.4 重启后恢复（H1）

- Gateway 启动时：沿用 1.1 的 `recoverOnStartup`（运行中的任务改为 `interrupted`，未决审批作废），另外清理遗留的 Agent 进程（6.2.1）。不在启动时预先拉起 Agent。
- 用户在中断或空闲回收过的任务里发下一条消息时，`ensureRuntime` 执行恢复：
  1. `caps.resume` 为真 → `session/resume { sessionId: agent_session_id, cwd, mcpServers: [] }`。Agent 不回放历史，Gateway 的事件库里本来就有完整对话。
  2. 否则 `caps.loadSession` 为真 → `session/load`。回放期间收到的 `session/update` 全部丢弃，直到 load 返回；CodeBuddy 另外用 historyReplay 的 start / end 标记界定回放范围。
  3. 恢复成功后重新下发模型、思考强度、模式（6.3.2），新的 `sessions` 记录写 `parent_session_id`，`session.started` 带 `resumed: true`。
  4. 返回 -32002 / Resource not found（例如 Claude 从没 prompt 过的会话），或恢复超时：新建会话，并发 `session.notice`：“原来的会话无法恢复，已新建会话；Agent 不记得之前的对话。”（自动交接 H2 在 1.4 做，到时候这里改为走交接。）
- 换账号（同一个 Agent）：结束进程 → 用新账号的环境变量重启 → resume。如果新账号的配置目录不同、会话不存在，本步直接返回 `session.not_recoverable`，提示“换账号需要交接，第 1.4 步提供”。
- 跨 Agent 切换：沿用 1.1 的行为，返回 `agent.unavailable`（1.4 做）。

### 6.6 接口（全部写在 `packages/protocol`，只增不改）

已有字段一律不改名、不改类型；新增字段都是 optional，老客户端可以忽略。

#### 6.6.1 类型

```ts
// AgentInfo 增加的可选字段
adapterVersion?: string | null;  engineVersion?: string | null;
engineSource?: 'bundled' | 'local' | 'app';
engineLocation?: string | null;  // 只用于展示的文本，客户端不解析、不拼接
authMethods?: { id: string; name: string; description: string | null;
                flow: 'browser' | 'apiKey' | 'external_app' }[];
caps?: { loadSession; resume; close; modelSwitch; thoughts; modes: {id,name}[];
         prompt: {image,audio,embeddedContext} };
modelsSource?: 'session' | 'cache' | 'manual' | 'none';
runningSessions?: number;  concurrencyLimit?: number;
checkedAt?: Ts;
profiles?: ProfileSummary[];     // 该 Agent 的账号概要

// 账号（不含密钥明文）
AgentProfile = { id, agent: AgentKind, name, kind: 'subscription'|'apiKey'|'customEndpoint',
                 configDir: 'shared'|'isolated', baseUrl: string|null, authHeader: 'x-api-key'|'bearer'|null,
                 models: ModelInfo[], hasSecret: boolean, secretHint: string|null,
                 isDefault: boolean, loggedIn: boolean|null, experimental: boolean,
                 lastTestAt: Ts|null, lastTestOk: boolean|null, createdAt: Ts, updatedAt: Ts }

AgentTestResult = { ok: boolean; steps: { ts: Ts; label: string; ok: boolean; ms: number; detail?: string }[] }

// Task 增加 profileId?: Id | null；CreateTaskBody、PatchTaskBody、switch 指令增加 profileId?
```

ModelInfo 不改：`contextWindow` 来自 configOption 时为 null，等模型资料表（design 6.6）再填。

#### 6.6.2 REST

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/agents` | 已有。返回的 AgentInfo 带上 6.6.1 的扩展字段；读缓存，不触发探测 |
| POST | `/agents/redetect` | 重新检测全部 Agent（版本、登录、能力缓存失效）。返回 `{ items: AgentInfo[] }`，同时为每个 Agent 推送 `agent.status` |
| POST | `/agents/:kind/login` | body：`{ profileId?, methodId }`；`methodId` 用 AgentInfo.authMethods 里的 id，CodeBuddy 另有 `workbuddy-app`（启动 WorkBuddy）。返回 202 `{ loginId }`，进度走 `agent.login` 事件。CodeBuddy 已登录时返回 409 `resource.conflict`，必须带 `force: true`（界面二次确认后）才执行 |
| POST | `/agents/:kind/login/:loginId/cancel` | 取消登录，结束登录子进程 |
| POST | `/agents/:kind/login/:loginId/code` | body：`{ code }`；给需要粘贴授权码的登录流程（ISSUE-0007 的备选） |
| POST | `/agents/:kind/test` | body：`{ profileId?, sendMessage?: boolean }`。依次执行：找到引擎 → initialize → session/new（临时目录，不注入 MCP）→ 读模型列表 → 关闭。`sendMessage: true` 时多发一条“只回复 OK”（会产生少量费用，界面按钮写“发送测试消息（会产生少量费用）”）。返回 `AgentTestResult`，对应原型里的测试日志 |
| PATCH | `/agents/:kind` | body：`{ concurrencyLimit?, engine?: 'bundled' \| 'local' }`（`engine` 只对 Claude 有效） |
| GET | `/profiles` | query：`agent?`。返回 `Page<AgentProfile>` |
| POST | `/profiles` | body：`{ agent, name, kind, configDir?, baseUrl?, authHeader?, apiKey?, models? }`。`apiKey` 只在请求体里出现一次，Gateway 收到后立即 DPAPI 加密，不进日志、不进审计详情。`baseUrl` 必须是 `https://`，或者 `http://` 加 127.0.0.1 / localhost |
| PATCH | `/profiles/:id` | 同上，字段都可选；`apiKey` 传入就整个替换；`isDefault: true` 设为默认账号 |
| DELETE | `/profiles/:id` | 有运行中的会话时返回 409 `profile.in_use`；默认的“本机登录”账号不能删除 |
| POST | `/profiles/:id/models/refresh` | 只对自定义地址：请求 `<baseUrl>/models`，返回更新后的 AgentProfile |

全部接口沿用 1.1 的鉴权（设备令牌 + Host + Origin），请求体用 zod 校验。登录、建账号、删账号、改密钥写审计日志（`audit_log`），详情里只写账号 ID 和名称。

#### 6.6.3 事件与指令

| 事件 | data | 说明 |
|---|---|---|
| `agent.login`（新增） | `{ loginId, kind, profileId, state: 'started'\|'waiting_browser'\|'need_code'\|'succeeded'\|'failed'\|'cancelled', authUrl?, message? }` | 全局事件（taskId 为空）。`authUrl` 只放从 Agent 输出里提取并且过了白名单的链接 |
| `session.usage`（新增） | `{ used, size, cost?: { amount, currency } }` | 来自 `usage_update` |
| `session.notice`（新增） | `{ level: 'info'\|'warn', text }` | 降级、恢复失败、强度被重置等需要告诉用户的情况，显示为对话里的灰色提示行 |
| `session.started`（扩展） | 增加可选的 `profileId`、`resumed` | |
| `session.config`（扩展） | 增加可选的 `agentMode`、`models: ModelInfo[]`、`efforts: string[] \| null` | 切换器用 `models`、`efforts` 渲染当前会话的可选项 |
| `agent.status`（已有） | — | 检测结果、登录状态变化时推送 |
| `switch` 指令（扩展） | 增加可选的 `profileId` | 同 Agent 换账号（6.5.4） |

ErrorCode 增加：`agent.auth_required`、`agent.quota_exceeded`、`agent.crashed`、`agent.start_timeout`、`agent.protocol_error`、`permission.level_unavailable`、`profile.in_use`、`secret.unavailable`、`session.not_recoverable`。FeatureKey 增加 `agents.profiles`。

### 6.7 界面（参照 `docs/prototype/agents.html` 和 workbench.html 的切换器）

- Agent 管理页：每个 Agent 一张卡片，显示状态（就绪 / 需要登录 / 未安装 / 出错）、版本（未验证时标黄）、引擎来源、账号、运行中的会话数。顶部有 [重新检测] 和“上次检测：…”。
- 详情区：
  - 账号列表，[添加账号] 下面三种方式：订阅登录 / 官方 API Key / 自定义地址。密钥输入框是 password 类型，保存后只显示结尾 4 位。
  - 登录进行中显示“已在浏览器中打开授权页面”和备用链接，[取消]；需要授权码时显示输入框。
  - 默认模型、并发上限、引擎（仅 Claude：自带 / 本机）。
  - [测试连接] 和测试日志。
- 工作台切换器（H0）：模型和思考强度两个下拉框，选项来自 `session.config.models / efforts`（没有会话时用 AgentInfo 里的缓存）。切换后等 ack；失败时恢复原值，并显示 error 的 message。思考强度为 null 时隐藏强度下拉框。
- 新建任务：真实 Agent 下“工作区内自动”和“全自动”置灰，并显示原因；发送按钮上方显示“会直接修改项目文件”的提示（6.5.2）。
- 所有错误按 `actions` 渲染按钮（[去登录]、[换模型]、[继续]）。网页不拼本机路径：引擎位置只显示 AgentInfo 的 `engineLocation` 文本。

### 6.8 测试策略

默认的 `npm test` 不启动任何真实 Agent，不联网，不花钱。

假 ACP Agent 进程（`packages/adapters/test/fixtures/fake-acp-agent.mjs`）：

- 用 `@agentclientprotocol/sdk` 2.4.0 的 Agent 端（`acp.agent()` / `AgentApp`）写成一个真正的子进程，走和真实 Agent 一样的 `AcpConnection`（spawn、NDJSON、stderr、超时、进程树清理）。
- 剧本通过环境变量 `AIC_FAKE_SCENARIO=<剧本 JSON 路径>` 传入。剧本描述 initialize 的返回、configOptions，以及每轮 prompt 依次发出的 update、权限请求和结束方式。

| 场景 | 覆盖的内容 |
|---|---|
| `basic` | 消息、思考、tool_call / tool_call_update（含 diff、失败）、plan、usage_update → 6.2.2 每一行的事件；未知 sessionUpdate 类型被计数、不报错 |
| `permission` | allow_once / allow_always / reject_once 的显示与隐藏规则；回传原始 optionId；拒绝后 `tool.end rejected`；只读级别自动拒绝；30 分钟超时回 `cancelled`（用假时钟） |
| `nonstandard-kinds` | CodeBuddy 式的 `kind: "allow" / "reject"` 能被接收和归一化；全是未知 kind 时自动拒绝 |
| `switch` | set_config_option 返回全量 configOptions；思考强度选项随模型变化，原强度失效时改用 currentValue 并发 `session.notice`；非法值报错后保留原值；只有 `models` 旧字段时走 `session/set_model`；Codex 式的 `<model>[<effort>]` 组合 id 能拆开 |
| `mode-drift` | Agent 自己把模式改宽后，Gateway 用 set_mode 改回 |
| `crash` | 回合中 `process.exit(1)` → `agent.crashed`、任务 `interrupted`、未决审批 `expired`；下一条消息触发 resume |
| `grandchild` | 假 Agent 再拉起一个子进程；`close()` 和 Gateway 退出后两个进程都不在（Windows 上用 `tasklist` 核对） |
| `hang` | initialize 不返回 → 30 秒超时（测试里把超时改小）→ 进程树被结束 |
| `noise` | stdout 夹杂非 JSON 行、stderr 输出含 `sk-…` 和注入密钥的行 → 连接不断，日志里只有 `***` |
| `auth` | session/new 返回 -32000 → `agent.auth_required`、任务 `paused`、`agent.status` 变为需要登录 |
| `quota` | prompt 返回额度错误 → `agent.quota_exceeded`、任务 `paused` |
| `resume` | resume 成功（不回放，重新下发配置）；resume 返回 -32002 → 新建会话并发 `session.notice`；只支持 load 时回放期间的 update 被丢弃 |

其他测试：

- Gateway 集成测试：用假 Agent 进程注册成一个真实形态的适配器，经 WebSocket 走完“建任务 → 对话 → 审批 → 换模型 → 崩溃 → 恢复”，断言事件序列和 1.1 的契约一致。
- 协议包：新增 schema 的正反例；老版本事件（没有新字段）仍能通过校验。
- 账号与密钥：`MemorySecretStore` 下的 REST 契约（响应里永远没有明文，`hint` 正确）；env 构建是纯函数，逐格对照 6.4.2 的表；删除清单生效。
- DPAPI：只在 win32 上运行（其他平台跳过）。往返加解密一致；数据库文件里搜不到明文；PowerShell 的命令行参数里没有明文。
- 真实 Agent 冒烟测试 `real.smoke.test.ts`：只在 `AIC_REAL_AGENTS=1` 时运行，可用 `AIC_REAL_AGENTS_ONLY=claude,codex` 只跑一部分。每个 Agent：detect → initialize → session/new（临时目录，“需审批”，注入 `aic-echo` 只检查能否拉起）→ 一条“只回复 OK” → 一条“新建 hello.txt”（应出现一次审批，允许后文件确实生成）→ 切换模型和思考强度 → 再一条“只回复 OK” → close → resume（不再发消息）。每个 Agent 最多 3 条极短的消息；让模型调用 `aic-echo` 工具不在冒烟测试里做（联调时为控制费用调整，见 devlog 2026-11-06“第 1.2 步联调与真实冒烟”）。结果写进验收记录，不进默认测试。会产生少量费用，运行前在验收记录里注明。

### 6.9 未验证项与问题单

以下都需要真实 prompt 才能确认，放进冒烟测试和 1.2 验收：

- 三家：未登录时 prompt 的错误形态；已有对话的会话能否 resume / load；resume 后切换过的配置是否保留；模型能否真正调用注入的 MCP 工具（ISSUE-0001）；实际弹出的权限选项。
- Claude：订阅登录能否完全在后台子进程里完成（ISSUE-0007）；用 API Key 时 `auth status` 是否显示为 API 计费。
- Codex：`read-only` 沙箱在 Windows 上能否拦住写操作（6.3.4）；`CODEX_CONFIG` 与用户 config.toml 的合并方式，以及 `env_key` 方案（6.4.2）。
- CodeBuddy：登录态为什么会在探测中失效、我们的检查会不会让 WorkBuddy 掉线（ISSUE-0008）；API Key 环境变量；一个进程能否跑多个会话。

问题单（本次新开）：

- ISSUE-0007：Claude 订阅登录没有 ACP authenticate，只能由 Gateway 代跑 `auth login` 子进程，能否全程图形化未实测。
- ISSUE-0008：CodeBuddy 登录态在探测中失效，并与 WorkBuddy 共用登录。
- ISSUE-0009：本机全局 codex 0.120 读不了当前的 config.toml，改用 codex-acp 自带的 0.165（design.md 6.1 写的“用 `CODEX_PATH` 指向本机版本”待更新）。
- ISSUE-0001 的实测结论已追加到该问题单的时间线。

### 6.10 开发顺序

1. 协议包：6.6 的类型、事件、错误码，以及测试。
2. `packages/adapters`：接口迁移、AcpConnection、映射、假 ACP Agent 和契约测试（6.8 全部场景先通过）。
3. 三个适配器的 detect / login / 模型 / 权限映射；冒烟测试脚本。
4. Gateway：迁移 v3、账号与 DPAPI、REST、运行时接入、异常处理、恢复。
5. 网页：Agent 管理页、账号、登录流程、切换器、新建任务的提示。
6. 冒烟测试（`AIC_REAL_AGENTS=1`）与浏览器验收，写 `docs/acceptance/step-1.2.md`，6.9 里没通过的项开问题单。

## 7. 进度盘点（2026-11-08）

依据：代码现状（逐个查了路由、协议、迁移、适配器和网页组件）、`docs/acceptance/step-1.1.md`、`step-1.2.md`、问题总表，以及原型 2026-11-07 的四次改动。

### 7.1 正式版已经有的

| 部分 | 现状 |
|---|---|
| Gateway | `/api/v1` 下系统、项目与分组、任务、草稿、审批、Agent、账号的 REST；WebSocket 事件和指令带 seq 补发；数据库迁移到 v4（项目、分组、任务、会话、事件、审批、设备、审计、账号、密钥、Agent 进程与能力缓存、草稿） |
| 鉴权 | 配对码、设备令牌、Host / Origin 校验、设备列表和吊销；只监听 127.0.0.1 |
| 适配器 | Claude Code、Codex、CodeBuddy 能检测、登录入口、新建 / 恢复会话、换模型和思考强度、权限映射（只开放“只读”“需审批”）；WorkBuddy 只在完整引擎时可用；ZCode 只能检测和测试连接 |
| 账号 | 订阅 / API Key / 自定义地址三种账号，密钥用 DPAPI 保存，事件写库前脱敏 |
| 网页 | 侧栏（按项目 / 分组、未分类）、Ctrl+K 搜索任务、对话按轮显示（“用时 N 秒”、Markdown）、审批卡片、输入框（一个切换器包含 Agent / 账号 / 模型 / 思考强度、权限按钮）、注释和草稿、Agent 管理页、账号对话框、设置页、配对页 |
| 用量 | 适配器已把 ACP `usage_update` 转成 `session.usage` 事件；网页还没读 |
| 测试 | protocol 8、gateway 约 96、adapters 约 63（另 3 项真实冒烟默认跳过）、web 约 67 |

### 7.2 1.2 没验证或没修完的（并入 1.3）

| 项 | 问题单 |
|---|---|
| 窗口被遮挡时审批卡片不出现（已改，没用真实审批复测） | ISSUE-0014 |
| Gateway 意外退出，没有留下错误信息 | ISSUE-0015 |
| 网页里的登录流程、API Key / 自定义地址账号、未登录时发消息的错误 | ISSUE-0013、ISSUE-0007 |
| 恢复会话后配置和上下文是否保留；拒绝审批后文件确实没写；Codex 在网页里的完整对话（2026-11-08 补验：Codex 全部通过，CodeBuddy 换模型后记得上下文；Claude 额度用完没测到） | ISSUE-0012 |
| 额度错误提示读不通；回合长时间没有事件也没有超时（2026-11-08 补验发现） | ISSUE-0021、ISSUE-0022 |
| Claude 工具行标题停在“Preparing file…” | ISSUE-0011 |
| 模型能否真正调用注入的 MCP 工具 | ISSUE-0001（随 1.6 的 `aic_history` 一起验） |
| 启动脚本在干净环境的首次运行；配对前控制台 401 | ISSUE-0004、ISSUE-0005 |
| WorkBuddy 精简引擎能否驱动 | ISSUE-0016（不阻塞，可推迟） |

### 7.3 原型有、正式版还没有的（2026-11-07 的改动）

| 原型 | 正式版现状 | 放在 |
|---|---|---|
| 统一选择器：第一级 Agent，二级模型 · 思考强度 · 账号；新建任务和对话共用（ui 6.5） | 有切换器，但是一整块弹出层，新建任务里另一套 | 1.3 |
| 附件与图片：粘贴、拖入、选择；模型看不了图时警告并拦下（ui 6.16） | prompt 只能发文字，附件按钮置灰；`promptCapabilities.image` 已读取 | 1.3 |
| 轻量化样式（ui 6.11） | 旧样式 | 1.4 |
| 新建任务起始页（ui 6.15） | 对话框 | 1.4 |
| 右侧“详细”：环境、计划、上下文、会话 token 用量、连接、输出，可折叠（ui 6.13） | 右侧只有“计划”“改动”（改动是占位） | 1.4（“输出”完整版在 1.5） |
| 上下文圆环、每轮用量（ui 6.12） | 没有 | 1.4 |
| 对话导航条（ui 6.14） | 没有 | 1.4 |
| 换 Agent 发送时才交接（ui 6.5） | 换 Agent 置灰（交接没做） | 1.6 |

### 7.4 还没开始的

工作区（worktree、影子快照、改动面板、合并 / 丢弃 / 回滚、权限规则、看板）、交接、局域网，按第 1 节排在 1.5～1.7。

## 8. 新步骤的范围

1.3、1.4 的详细实现规格在开工前另写（像第 6 节那样），这里先定范围和完成标准。

### 8.1 第 1.3 步：稳定、补验与输入框

> 详细实现规格见第 9 节（2026-11-08）。下面是范围摘要。
> 此后用户澄清的认证与独立 Agent 范围见 9.15；未完成该整改前不能宣布本步全部通过。

做什么：

1. 稳定性：ISSUE-0014 用真实审批复测；ISSUE-0015 找到退出原因（兜底日志已加），Gateway 被结束时网页提示“工作台服务已停止”并能一键重启；ISSUE-0011 标题更新。
2. 补验 1.2：按 7.2、9.11、9.15 的最新边界用真实 Agent 跑一遍；第三方沿用软件自身认证，自定义 API 只用于工作台独立 Agent。需要用户配合时先记消息预算和费用再确认，不再开展工作台代登录或第三方 API 账号替换。通过的关单，不通过的修。
3. 统一选择器：按 ui 6.5 改写输入框的切换器，新建任务对话框也用它（起始页在 1.4，组件直接复用）；思考强度在新建任务里也能选，`POST /tasks` 增加可选的 `effort`。
4. 附件与图片（ui 6.16、design 15.2）：
   - 协议只增不改：`prompt` 指令和 `POST /tasks` 增加可选的 `attachments`（先上传，再按 id 引用）；新增 `POST /tasks/:id/attachments`（大小、数量、类型校验，存在 `.aic-data/` 下，按任务清理）；`AgentInfo` / 模型信息带 `vision: true | false | null`。
   - 适配器把图片转成 ACP 的 image 内容块，其他文件转成资源链接；Agent 没声明 `promptCapabilities.image` 时 Gateway 拒绝带图片的消息（`attachment.unsupported`），不悄悄丢掉。
   - 网页：粘贴、拖入、选择；缩略图、看大图、删除；看不了图时警告、拦下、推荐能看图的模型。
5. 换 Agent 在 1.3 仍不可用（交接在 1.6），选择器里照旧标明原因。
6. 界面和错误提示里写的步号按新编号改（网页和 Gateway 里共 20 来处“第 1.3 / 1.4 / 1.5 步”，分别改为 1.5 / 1.6 / 1.7），最好改成不写步号的说法，例如“有了工作副本后开放”。

完成标准：

- Claude Code、Codex 各在网页里完成一次带截图的对话（Ctrl+V 粘贴），回复里能说出图片内容；选一个看不了图的模型时被拦下并能一键换成能看图的模型。
- CodeBuddy 在网页里完成一次对话、换一次模型（2026-11-08 补验已通过，1.3 改完输入框后再跑一次）。
- 7.2 里除 ISSUE-0001、ISSUE-0016 外的项都有真实验证结果（通过，或开了新问题单）。Codex 的恢复会话、拒绝审批、网页对话已在 2026-11-08 补验通过；Claude 因账号额度用完没测到，留在本步。
- 窗口被遮挡 10 分钟后，新的审批卡片仍会出现；Gateway 被结束后网页 3 秒内给出提示。
- 回合 60 秒没有任何事件时界面有提示，10 分钟自动停止（ISSUE-0022）；额度错误的提示读得通（ISSUE-0021）。
- 自动测试、类型检查、构建全部通过；第 9.12 节列出的新测试都在。

### 8.2 第 1.4 步：界面改版与用量

做什么：

1. 轻量化样式（ui 6.11），以原型 `lite.css` 为准，所有页面统一。
2. 新建任务起始页（ui 6.15）：替换对话框，所有“新建任务”入口打开它；快捷入口、Agent 推荐（推荐先用简单规则，快速判断在后续阶段）。
3. 右侧“详细”（ui 6.13）：
   - 环境：本机、项目和路径、分支；[存为常用] 保存一组“设备 · 项目 · 分支”，新建任务时可选。
   - 计划：沿用现在的计划。
   - 上下文：总量和窗口来自 `session.usage`；分类明细 Agent 不报告时只显示总量，不编造（design 15.5）。
   - 会话 token 用量：整个会话所有轮次的累计。需要适配器接每轮 `PromptResponse.usage`，协议新增 `TurnUsage` 和 `GET /tasks/:id/usage`，按会话段汇总；没报告的段写“未报告”。
   - 连接：本任务可用的 MCP 和状态（这一步先列出 Agent 报告的和工作台注入的，[重新连接] 只对工作台注入的服务有效；完整的能力中心在后续阶段）。
   - 输出：这一步先列出 Agent 改过的文件（来自工具调用的 diff），1.5 有了工作副本后改为工作副本的改动。
   - 每节可以折叠，默认只展开计划和上下文。
4. 输入框的上下文圆环和每轮用量小字（ui 6.12）。
5. 对话导航条（ui 6.14）。
6. 调研：订阅账号的周期额度、上下文分类明细能否拿到（Claude Code `/context`、zcode-acp 的配额接口思路），结论写进 `docs/research/`，拿不到的界面写“额度未知”。

完成标准：

- 和原型逐项对照：起始页、详细面板六节（含折叠和默认展开）、圆环悬停文字、每轮用量、导航条（悬停预览、点击跳转、键盘操作）都在真实 Agent 的任务里能用；深浅两套主题都看过。
- 用 Claude Code 连续对话 3 轮，“会话 token 用量”合计等于每轮用量之和；圆环数字与 `session.usage` 一致；中途交接或换 Agent 不在本步，只验证单段会话。
- 没报告用量的 Agent（如果有）显示“未报告”，不显示 0。

### 8.3 第 1.5～1.7 步

范围同第 1 节，开工前各自写实现规格。1.6 额外包含原型里“换 Agent 发送时才交接、可撤销”的交互（ui 6.5），以及恢复 1.2 遗留的“换账号需要交接”。

## 9. 1.3 实现规格

> 2026-11-08 · 依据：本文 8.1；ui-design.md 6.5、6.16；design.md 15.2、17；问题单 ISSUE-0004、0005、0007、0011～0015、0021、0022；`docs/acceptance/step-1.2.md`“补验（2026-11-08）”一节；原型 `docs/prototype/assets/interact.js`（`aicAgentPicker`）、`attach.js`。
> 代码现状核对到 2026-11-08 的 main（提交 7eb16a6 之后）。下文的 `文件:行号` 是当天的位置，改动后以函数名为准。

### 9.1 总体与约束

- 第 2 节接口规则全部适用。协议只增不改：新字段一律可选，新事件和错误码只追加；老客户端忽略不认识的字段和事件。
- 本步不碰工作副本、交接、局域网。换 Agent 仍不可用（1.6），选择器里照旧说明原因，但说法改成不写步号（9.10）。
- 新增依赖前先确认仍在维护，锁精确版本。本步预计不需要新的运行时依赖：上传用 Hono 自带的 `c.req.parseBody()` / `arrayBuffer()`；图片尺寸和类型靠文件头魔数判断，不引入图片库。
- 凭据边界不变：不读取、不复制任何 Agent 自己的凭据文件；附件文件不进日志，日志里只写文件名、大小、类型。
- 默认 `npm test` 不启动真实 Agent、不联网、不花钱。真实验证写在 9.11，单独执行。

### 9.2 工作分解

| # | 工作 | 主要文件 | 问题单 |
|---|---|---|---|
| A | 实时事件在窗口被遮挡时不停（复测与补测试） | `apps/web/src/state/app.ts` | ISSUE-0014 |
| B | Gateway 退出：找原因、网页提示、一键重启 | `packages/gateway/src/server.ts`、`crash-log.ts`，`apps/web/src/api/ws.ts`，启动脚本 | ISSUE-0015 |
| C | 回合长时间没有事件：提醒与自动取消 | `packages/gateway/src/tasks.ts`（`runTurn`） | ISSUE-0022 |
| D | 额度错误提示、不支持的模型 | `packages/adapters/src/acp/errors.ts`，`codex/index.ts` | ISSUE-0021，补验发现 |
| E | 工具行标题更新 | `packages/adapters/src/acp/updates.ts`，协议 | ISSUE-0011 |
| F | 统一的 Agent · 模型 · 思考强度选择器 | `apps/web/src/components/Composer.tsx`、`NewTaskDialog.tsx`，新组件 | — |
| G | 附件与图片 | 协议、Gateway 新路由、`acp/session.ts`、网页新组件 | — |
| H | 旧步号文字、配对前 401、启动脚本首次运行 | 见 9.10 | ISSUE-0004、0005 |
| I | 真实补验：登录、API Key、Claude、遮挡 10 分钟 | 验收记录 | ISSUE-0007、0012、0013、0014 |

建议顺序：E、D、C（适配器和 Gateway 的小改，先把错误和卡住的问题修好）→ A、B → G 的协议和 Gateway → G 的适配器 → F → G 的网页 → H → I。F 和 G 的网页部分都改输入框，同一个人做，避免冲突。

### 9.3 A：实时事件在窗口被遮挡时不停（ISSUE-0014）

现状：`apps/web/src/state/app.ts:56-69` 的 `enqueueEvent` 已改为 rAF 和 `setTimeout` 谁先到谁执行（可见时 100ms，不可见时 16ms），`done` 防止重复执行。2026-11-08 补验在“页面可见、没有焦点、面板在后台”时审批卡片正常出现。

要做：

1. 把调度逻辑拆成可测试的纯函数，例如 `apps/web/src/state/flush.ts` 导出 `createFlusher({ raf, setTimeout, visibility, flush })`，`app.ts` 里只组装。不改行为。
2. 单元测试（node 环境，注入假的 raf / setTimeout）：raf 永远不调用时 100ms 内 flush；raf 先到时只 flush 一次；不可见时 16ms 内 flush；连续入队 1000 条只 flush 一次。
3. 审批到来时除了渲染卡片，再调用 `Platform.notify`（已有接口）发系统通知，标题“有审批等你处理”，正文是审批标题；页面有焦点时不发。用户拒绝过通知权限时静默。
4. 真实复测见 9.11 第 4 项。

### 9.4 B：Gateway 退出（ISSUE-0015）

现状：`crash-log.ts` 已记录 `unhandledRejection`（ERROR，继续运行）和 `uncaughtException`（FATAL，退出），写 `<数据目录>/logs/gateway.log`；`server.ts:302/319/327` 记录启动、已启动、正常退出。网页只有“正在重新连接…”，不知道 Gateway 已经不在了。

要做：

1. 补齐退出记录：`process.on('exit', code)` 记录退出码；关掉控制台窗口的 `SIGHUP` 已经处理（`server.ts:334-336`，3 秒内停止），在它和 SIGINT、SIGTERM 里各记一条 INFO 写明原因（“控制台窗口被关闭”“按了 Ctrl+C”“收到结束信号”）；`SIGBREAK`（Ctrl+Break）按 SIGINT 处理。每条带 pid 和已运行时长。
2. 启动时检查上一次的结尾：读 `gateway.log` 最后一条，如果是“启动”或“已启动”而没有对应的“退出”，记一条 WARN“上次运行没有正常退出（pid N，最后记录在 …）”。这条信息也放进 `GET /hello` 的可选字段 `lastExit: { clean: boolean, at: number, reason: string | null } | null`，网页设置页“关于”里显示。
3. 网页判断“服务已停止”：`ws.ts` 连续连接失败达到 3 次后（现有 0.5 / 1 秒退避，约 1.5 秒），用 `fetch(baseUrl + '/api/v1/hello')` 探测；连不上（网络错误，不是 401）时 `ConnState` 新增 `'down'`（只增），界面：
   - 输入框上方的提示改为“工作台服务已停止，对话不会丢。双击桌面上的“启动 AI Console”可以重新打开；打开后这里会自动恢复。”；
   - 侧栏状态点变红，文字“服务已停止”；
   - 之后每 5 秒探测一次，恢复后自动重连并补齐事件（沿用 `resyncAfterReconnect`）。
   - “一键重启”：浏览器页面没法拉起本机进程（接口规则 7：不绕过接口），所以本步只做提示和自动恢复；真正的一键重启放在桌面软件（Tauri 托盘）里，`Platform` 增加可选方法 `restartGateway?(): Promise<boolean>`，浏览器版不提供，界面有这个方法时才显示 [重新启动] 按钮。
4. 测试：Gateway 测试里起一个 Gateway、停掉，检查 `gateway.log` 有退出记录；再起一个，`/hello` 的 `lastExit.clean` 为 true。人为写入一条没有退出记录的日志后启动，`clean` 为 false。网页：`ws.ts` 的状态机测试（已有 `api/ws.test.ts`），连续失败 + 探测失败进入 `down`，探测成功回到 `connecting`。
5. 真实复测：开发预览里停止 Gateway，网页 3 秒内显示“工作台服务已停止”；重新启动后自动恢复，对话完整。

### 9.5 C：回合长时间没有事件（ISSUE-0022）

现状：`tasks.ts` 的 `runTurn`（约 :561）等 `rt.conn.prompt()` 返回，期间不看有没有事件。补验时 Claude 额度用完，3 分 25 秒才报 429；恢复会话后第二次 2 分钟以上没有任何事件。

要做：

1. 每个回合记录最后一次收到 Agent 事件的时间（任何 `session/update`、权限请求都算；我们自己发的 `task.updated` 不算）。等待审批期间不计时。
2. 60 秒没有事件：发 `session.notice`（level `warn`）：“Agent 已经 1 分钟没有回应，可能在重试或网络不稳定。可以继续等，也可以停止这一轮。”。之后每 2 分钟更新一次同一条提示（用固定的 notice id 替换，不堆叠，见 ISSUE-0018 的做法），写明已等待多久。
3. 10 分钟没有事件：自动 `session/cancel`，任务暂停，发 `error`，错误码新增 `agent.no_response`（`ErrorCode.AgentNoResponse`，HTTP 504），message“Agent 10 分钟没有回应，这一轮已停止”，hint“可以重新发送，或换个模型 / 账号”，actions `[重试] [换模型]`。
4. 两个时间做成 `TaskServiceOptions` 的可选项（默认 60 秒、10 分钟），测试里改小。
5. 网页：“正在处理 · N 秒”在收到这条 notice 后变成琥珀色，旁边一个 [停止] 按钮（已有停止功能，放到这里方便点）。
6. 查 claude-agent-acp 0.100.0 和自带 claude.exe 2.1.316 有没有缩短上游重试的设置（环境变量或 `_meta.claudeCode.options`），有就设成最多重试 2 次；结论写进 ISSUE-0022。只看源码和文档，不读凭据。
7. 测试：假 ACP Agent 的剧本加 `sleep` 步（已有）模拟长时间不发事件，用假时钟验证 notice、替换、自动取消、错误码；等待审批时不触发。

### 9.6 D：额度提示与不支持的模型（ISSUE-0021，补验发现）

1. `packages/adapters/src/acp/errors.ts` 的 `quotaHint()`：只在捕获的内容像时间时才用。认可的格式：ISO 时间、`HH:MM`（可带时区）、`in N (seconds|minutes|hours|days)`、`N (s|m|h)`、`after <星期几或日期>`。其余一律用固定 hint“额度或调用频率达到上限，可以稍后再试，或换个模型 / 账号”。单元测试用补验时的原文：
   `API Error: Request rejected (429) · upstream account quota usage limit has been reached; wait for quota to reset or use an account with available quota`，期望得到固定 hint。另加 3 条能解析出时间的正例。
2. 上游拒绝模型：Codex 选 gpt-5.5 时，回复正文是上游 400 原文（“The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account”），任务进入“待验收”。处理：
   - 适配器在回合结束时，如果这一轮只有一段消息、没有工具调用，并且文本匹配已知的上游错误模式（`model is not supported`、`upstream_status: HTTP 4\d\d`、`API Error: Request rejected`），把它当成错误：发 `error`（`agent.failed`，或额度类的 `agent.quota_exceeded`），任务暂停而不是“待验收”；原文保留在消息里。
   - 这个“文本里的错误”规则放在一个表里（`errors.ts` 的 `TEXT_ERROR_PATTERNS`），每条都有测试，避免误判正常回复：只在整段回复以这些前缀开头、长度小于 600 字时才判定。
   - 模型列表：不做按账号过滤（ACP 拿不到账号能用哪些模型）。选了一次失败的模型后，在这个账号下记住“上次失败：不支持”，切换器里这个模型后面标灰字“上次失败”，鼠标悬停显示原因。存在 `agent_caps.catalog_json` 旁边的新列不划算，用新表 `model_failures(agent, profile_id, model, reason, at)`（和 9.9.2 的 `attachments` 表放在同一个迁移 v5 里，只追加）。

### 9.7 E：工具行标题更新（ISSUE-0011）

现状：`updates.ts:151-164` 处理 `tool_call_update`，第一次见到的 id 才发 `tool_start`；之后只改 `title` 的更新被丢弃（:160 的注释），Claude 的工具行停在“Preparing file…”。

要做：

1. 协议新增事件 `tool.update`：`{ toolId, title?: string, target?: string | null, kind?: ToolKind }`（只增；字段都可选，只带变化的部分）。
2. 适配器：已见过的 id 收到带 `title`（或 `locations`、`kind`）的更新且和上次不同时，发 `tool_update`；内容和状态照旧走 `tool.output` / `tool.end`。
3. Gateway 照常写库、推送。网页 `state/core.ts` 处理 `tool.update`：更新时间线里对应的工具行；老事件流里没有它也不影响。
4. 测试：适配器契约测试（剧本里先 `tool_call` 标题“Preparing file…”再 `tool_call_update` 改标题）；网页 core 测试；协议正反例。

### 9.8 F：统一的 Agent · 模型 · 思考强度选择器（ui-design 6.5）

参照原型 `docs/prototype/assets/interact.js` 的 `aicAgentPicker`（和 `new-task.js` 里的调用）。现状：`Composer.tsx:165-335` 的 `Switcher` 是一块弹出层（Agent 列表、账号、模型、思考强度分段放在一起），`NewTaskDialog.tsx` 里是三个 `<select>`。

新组件 `apps/web/src/components/AgentPicker.tsx`：

- 触发按钮：`徽标 Agent名 模型名 · 思考 X ▾`。思考强度为 null（Agent 不支持）时不显示“· 思考 X”。`title` 显示当前账号。
- 第一级菜单（`role="menu"`）：只列已启用的 Agent（`isEnabled`），外加当前任务的 Agent（即使后来被关掉）。每行：徽标、名称，右侧是
  - 当前 Agent：`模型 · 思考 X ✓`；
  - 状态不是就绪：状态文字（“需要登录”“登录已过期”“未连接”），琥珀色；
  - 其他：`N 个模型`。
  - 末尾一行提示：“换模型、账号、思考强度都保留完整上下文。换 Agent 需要交接，现在还不能直接换。”（1.6 做完交接后改为“发送时才交接”）。
- 鼠标移到某个 Agent（或按 →）在旁边展开二级菜单，内容自上而下：
  1. 模型（`menuitemradio`），当前打勾。模型的数据用 `pickModels(info, session)`（已有）。
  2. 思考强度：`pickEfforts(info, session)` 不为 null 时用分段按钮（`role="radiogroup"`）；为 null 时写“由模型自己决定，这里不能调”。CodeBuddy 的列表末尾有 `enabled`（补验看到：`minimal, low, medium, high, xhigh, max, enabled`，当前值是 `enabled`），显示为“自动”，放在最前面。
  3. 账号：只在“当前 Agent 且有多个账号”时出现，沿用 `profileSwitchKind` 的规则（存放位置不同的账号置灰，说明原因）。
  4. 看不了图的模型后面标“不能看图”（9.9 的 `vision === false`），上次失败的模型标“上次失败”（9.6）。
- 打开时自动展开当前 Agent 的二级菜单，焦点在当前 Agent 那一行。
- 行为：
  - 当前 Agent 的思考强度：点了立即生效（发 `switch`），菜单不关；
  - 当前 Agent 的模型：发 `switch`，菜单关闭；
  - 其他 Agent：在对话里选择时显示一个说明对话框“换 Agent 需要交接，会在之后的版本提供；现在可以用这个 Agent 新建任务”，带 [用它新建任务]（预填当前任务的描述）和 [取消]；在新建任务里选择则直接生效（新任务还没有会话）。
  - 正在执行时换模型：沿用现有的 `switchNeedsTurnEnd` + `choiceDialog`（等这一步结束 / 立即中断）。
  - 失败时恢复原值，显示 error 的 message（沿用现有 `ErrorNotice`）。
- 收起：再点一次按钮、Esc（二级菜单里先回到一级，再按一次关闭）、点外面。
- 键盘：一级 ↑↓ 移动、→ / Enter 进二级；二级 ↑↓、← 返回、Enter 选择、Space 选思考强度。全部有 `aria-expanded`、`aria-haspopup`。
- 放置：按钮在屏幕下半部分时向上开，否则向下；二级菜单放在一级右边，放不下就放左边，且不超出屏幕。
- 输入框里的旧 `Switcher` 换成它；账号按钮不再单独显示。`NewTaskDialog` 的三个 `<select>` 换成它（`POST /tasks` 已支持 `model`、`effort`、`profileId`，不需要改接口）。
- 测试（web 是 node 环境，没有 DOM）：把“第一级每行显示什么、二级有哪些项、点了发什么”写成纯函数 `lib/picker.ts`，覆盖：当前 Agent 显示、状态文字、`enabled` 显示为“自动”、思考强度为 null、多账号、不能看图标注、上次失败标注、其他 Agent 在对话里和在新建任务里的不同行为。

### 9.9 G：附件与图片（ui-design 6.16、design 15.2）

参照原型 `docs/prototype/assets/attach.js`。

#### 9.9.1 协议（全部只增）

```ts
// 附件：先上传，再在消息里按 id 引用
export const AttachmentInfo = z.object({
  id: Id,                       // 'att_' 开头的不透明 id
  name: z.string().max(255),    // 显示用的文件名（服务端清洗过）
  mime: z.string(),             // 服务端按文件头判断的类型，不信客户端给的
  size: z.number().int(),
  kind: z.enum(['image', 'file']),
  width: z.number().int().nullable(),   // 图片才有
  height: z.number().int().nullable(),
  createdAt: z.number().int(),
});
// prompt 指令：增加可选 attachments（id 列表，最多 10 个）
op('prompt', z.object({ taskId: Id, text: z.string().max(100_000), attachments: z.array(Id).max(10).optional() }))
// text 由 min(1) 改为：text 和 attachments 至少有一个（用 superRefine，老客户端只发 text 不受影响）
// CreateTaskBody：增加可选 attachments（同上）
// message.user 事件：增加可选 attachments: AttachmentInfo[]
// 模型能不能看图：ModelInfo 增加可选 vision: boolean | null
```

- 能不能看图的判断顺序：`ModelInfo.vision`（Agent 报告了模型级信息时）→ `AgentInfo.caps.prompt.image`（ACP initialize 的 `promptCapabilities.image`）→ null（未知）。工具函数 `visionOf(info, modelId): true | false | null` 写在 `packages/protocol`，两边共用。
  - 2026-11-08 实现核查：CodeBuddy 的 `toAcpModelInfo` 在模型 `_meta.supportsImages` 中明确报告图片能力，`_codebuddy.ai/models/refresh` 和会话模型列表共用它；解析明确的布尔值到 `ModelInfo.vision`。没有这个字段的模型保持未知并按上述顺序回退，不按模型名猜测。源码依据和真实验证边界见验收记录。
- 新增错误码：`attachment.unsupported`（415，Agent 不能看图）、`attachment.too_large`（413）、`attachment.too_many`（400）、`attachment.not_found`（404）、`attachment.bad_type`（415）。

#### 9.9.2 Gateway

- 新路由 `POST /tasks/:id/attachments`：请求体是文件本身（`Content-Type` 为文件类型，`X-AIC-Filename` 头带 URL 编码的文件名），不用 multipart，便于流式写盘和统一限制。
  - 这个路由单独设 body 上限 20 MB（`app.ts:87` 的全局 1 MB 限制对它放开，其他路由不变）。
  - 文件类型按文件头判断：PNG、JPEG、GIF、WebP 判为图片，并读出宽高；其他按文本 / 二进制判为 file。拒绝可执行文件头（MZ、ELF）。SVG 当作 file，不当图片（避免脚本）。
  - 每个任务最多 50 个附件、总计 200 MB，超出返回 `attachment.too_many`。
  - 存放：`<数据目录>/attachments/<taskId>/<attId>`，文件名只用 id，原文件名存在库里。新表 `attachments(id, task_id, name, mime, size, kind, width, height, sha256, created_at, used_at)`（迁移 v5，和 9.6 的 `model_failures` 同一个迁移）。
  - 返回 `AttachmentInfo`。
- `GET /tasks/:id/attachments/:attId`：返回文件内容（`Content-Type` 用库里的 mime，图片之外一律 `Content-Disposition: attachment`，加 `X-Content-Type-Options: nosniff`），给网页显示缩略图和大图用。鉴权同其他接口。
- 元数据路由 `GET /tasks/:id/attachments/:attId/info` 返回 `AttachmentInfo`，供刷新后恢复草稿；同样校验令牌、Host、Origin 和任务归属。
- 发送：`prompt` 和 `POST /tasks` 带 `attachments` 时，Gateway 校验每个 id 都属于这个任务、文件存在；有图片且 `visionOf` 为 false 时返回 `attachment.unsupported`（message “X · 模型 看不了图片”，actions `[换模型]`）。为 null 时照常发送（网页那边已经问过用户）。
- 清理：任务删除时删掉整个目录；上传后 24 小时没有被任何消息引用的附件删除（启动时和每小时检查一次）。
- `message.user` 事件里带 `attachments`（只有元数据，不带内容）。
- 日志：只写 id、大小、类型，不写文件名之外的内容；文件名经过脱敏函数。

#### 9.9.3 适配器

- `AgentAdapter` 的 `prompt(text, signal)` 改为 `prompt(input: { text: string; attachments?: PromptAttachment[] }, signal)`，`PromptAttachment = { kind, mime, name, path, uri }`；旧签名的调用点一并改（fake 适配器、测试）。
- ACP（`acp/session.ts:270`）：`prompt` 数组依次放：
  - 文本块 `{ type: 'text', text }`（文本为空时省略）；
  - 每张图片一个 `{ type: 'image', mimeType, data: <base64> }`（ACP 规范的 ImageContent；单张 base64 前不超过 5 MB，更大的先在 Gateway 拒绝或缩小，本步先拒绝并提示“图片太大，最大 5 MB”）；
  - 每个文件一个 `{ type: 'resource_link', uri: 'file:///…', name, mimeType }`（Agent 在本机，可以直接读路径）。Agent 声明 `embeddedContext` 且是小文本文件（< 256 KB）时，改用 `{ type: 'resource', resource: { uri, text, mimeType } }`。
- Agent 没声明 `promptCapabilities.image` 却收到图片：适配器再检查一次，抛 `AgentError('attachment.unsupported')`，不发出去。
- 假 ACP Agent：`session/prompt` 处理（fixture :168）已经记录参数，契约测试核对 content 数组的形状和 base64 长度。
- 演示 Agent（fake）：收到图片时回复“收到 N 张图片：文件名、宽 × 高”，方便在不花钱的情况下演示。

#### 9.9.4 网页

新组件 `apps/web/src/components/Attachments.tsx`，`Composer` 和 `NewTaskDialog` 共用：

- 三种加法：输入框上 `paste`（剪贴板里有文件时加为附件；同时有文字时文字照常粘贴）、拖入（拖入时输入框高亮）、[附件] 按钮（`<input type="file" multiple>`，不再置灰）。
- 选中后立即上传（`POST /tasks/:id/attachments`）；新建任务时还没有任务 id，先暂存在内存里，任务建好后再上传并随第一条消息发送（`POST /tasks` 带 `attachments` 需要任务 id，所以新建任务的流程是：建任务（不带附件、`prompt` 先不发）→ 上传 → 发 `prompt`）。为此 `CreateTaskBody` 增加可选 `deferPrompt: boolean`，为 true 时只建任务不启动回合。
- 输入框里显示附件：图片缩略图（`GET` 回来的地址）、文件名、大小，上传中显示进度，失败显示原因和 [重试]；点缩略图看大图；× 删除（只从这条消息里去掉，服务端的文件按 24 小时规则清理）。
- 粘贴的截图没有文件名时，用“截图-时分秒.png”。
- 能不能看图：用 `visionOf(info, model)`：
  - false：输入框上方琥珀提示“X · 模型 看不了图片，这 N 张图片发过去它收不到”，缩略图描琥珀边；按钮 [换成 Y]（同 Agent 能看图的模型优先；没有时不推荐别的 Agent，因为换 Agent 要交接）和 [去掉图片]；点发送被拦下，提示条晃一下（减少动态效果时改为描边）。
  - null：提示“没有报告能不能看图片，可能收不到”，多一个 [仍然发送]。
  - 换模型后提示随之更新。
- 对话里你的消息显示附件：图片缩略图（最多 120 × 90，点开看大图），文件显示为一行带图标的文件名；图片地址同样走 `GET` 接口。
- 每个任务的输入框附件和草稿一起保存？不保存：附件已经上传在服务端，草稿只多存一个附件 id 列表（`TaskDraft` 增加可选 `attachments: Id[]`），刷新后恢复缩略图；24 小时清理规则对草稿里的附件也适用，过期的从草稿里去掉并提示。`GET /draft` 可选返回 `expiredAttachments: true` 告知本次移除了过期引用；该字段只在响应里出现。
- 纯函数测试（`lib/attachments.ts`）：粘贴事件的文件筛选、截图命名、超限判断、`visionOf` 的提示文案和推荐模型。

### 9.10 H：零碎修复

1. 旧步号文字（ISSUE-0004 之外的 20 处，2026-11-08 盘点）：
   - 第 1.3 步（工作副本）：`Composer.tsx:113`（附件按钮，本步本来就要改掉）、`dialogs.tsx:59`、`NewTaskDialog.tsx:188`、`SidePanel.tsx:88`、`:93`、`TaskView.tsx:57`、`lib/agents.ts:57`（`PERM_LOCKED_REASON`）、`:66`（`DIRECT_EDIT_WARNING`）、`packages/gateway/src/tasks.ts:250`。
   - 第 1.4 步（交接）：`Composer.tsx:284`、`:285`、`:299`、`:328`、`lib/agents.ts:107`、`:117`、`packages/adapters/src/types.ts:296`、`packages/gateway/src/tasks.ts:496`、`:646`、`:673`、`:674`、`:721`、`packages/protocol/src/index.ts:159`。
   - 第 1.5 步（局域网）：`SettingsPage.tsx:59`。
   - 改法：界面和错误提示不写步号，说做完什么之后开放，例如“有了独立工作副本后开放”“换 Agent 需要交接，之后的版本提供”“局域网访问之后的版本提供”。代码注释可以写新步号（1.5 / 1.6 / 1.7）。改完 `grep -rn "第 1\.[3-5] 步" apps packages` 应该只剩注释。
2. 配对前控制台 401（ISSUE-0005）：网页启动时先检查本地凭据；没有凭据时直接显示配对页，有凭据时再调 `GET /hello`（仍校验设备令牌、Host 和 Origin）。不再发明知缺少令牌的请求。测试：`api/credentials.test.ts` 或新建的启动流程纯函数测试，覆盖“没有凭据时不发需要令牌的请求”。
3. 启动脚本首次运行（ISSUE-0004）：在 Windows 沙盒（如果用户电脑开着这个功能）或一个新建的空用户目录里实测两条路径：删掉 `node_modules` 后双击（应自动 `npm ci` 并打开浏览器）；PATH 里没有 Node 时双击（应弹出中文提示并打开下载页）。不能在本机删 Node；做不了沙盒就把这一项留在问题单里，验收记录写“未验证”。

### 9.11 I：真实补验（需要用户配合）

> 2026-11-08 更正：第 2、3 项的工作台代登录与第三方 API 账号替换暂停；第 8 项的 Claude 账号替换也不再按旧方案执行。改按 9.15 验证第三方自身配置与工作台独立 Agent，既有真实结果只追加记录，不作废或改写。用户已要求结束本轮 Claude 登录。

先在验收记录里写明预计的消息条数和费用，用户同意后再跑。每个 Agent 最多 5 条极短的消息，都在空的临时目录里。

| # | 项 | 怎么做 | 需要用户 | 问题单 |
|---|---|---|---|---|
| 1 | Claude 网页对话、恢复、拒绝审批 | 照 2026-11-08 对 Codex 的做法（暗号 → 拒绝新建文件 → 会话内换模型问暗号 → 重启 Gateway 后问暗号） | Claude 账号额度恢复 | ISSUE-0012 |
| 2 | 网页登录流程 | 三家各在“未登录”状态下点 [登录]，记录是否需要任何终端输入、要多久、取消是否有效。未登录状态由用户准备：建议用 Agent 管理里“添加账号 → 订阅登录”新建一个账号（工作台给它单独的配置目录，见 6.4.2），这样不影响用户现在的登录 | 用户在浏览器里完成授权 | ISSUE-0013、ISSUE-0007 |
| 3 | API Key / 自定义地址账号 | 用户提供一个测试用的、额度很小的 API Key；在 Agent 管理里添加，发一条“只回复 OK”，确认用的是这个 Key（Claude `auth status` 显示 API 计费；Codex 的 `env_key` 方案生效）；然后删除账号，确认 DPAPI 密钥和账号目录都被清掉 | API Key | ISSUE-0013 |
| 4 | 窗口被遮挡 10 分钟后审批卡片出现 | 浏览器打开任务，把窗口最小化或被别的窗口完全挡住 10 分钟，期间由另一个任务（或接口）触发一次真实审批；恢复窗口时卡片已经在，系统通知也出现过 | 用户的电脑不进入睡眠 | ISSUE-0014 |
| 5 | Gateway 被结束后的提示 | 关掉 Gateway 的控制台窗口，网页 3 秒内显示“工作台服务已停止”；重新双击启动后自动恢复 | — | ISSUE-0015 |
| 6 | 回合没有回应的提示 | 用假 ACP Agent 演示即可（真实 Agent 很难稳定复现）；如果 Claude 额度又用完，顺便看真实表现 | — | ISSUE-0022 |
| 7 | 带截图的对话 | Claude、Codex、CodeBuddy 各 Ctrl+V 一张截图，问“图里写了什么”；再选一个 `vision === false` 的模型（如果有）看是否被拦下 | — | — |
| 8 | 统一选择器 | 三家各换一次模型和思考强度（CodeBuddy 的“自动”）、Claude 换一次账号（需要第二个账号时和第 3 项一起做） | — | — |

做完：通过的关单（时间线写验收记录的位置和提交哈希）；不通过的修，修不了的开新问题单。

### 9.12 测试清单（默认 `npm test` 里）

| 包 | 新增 |
|---|---|
| protocol | `prompt` 只有附件、只有文字、两者都没有（应失败）；`AttachmentInfo`、`tool.update`、`ModelInfo.vision` 正反例；`visionOf` 的三种来源；老事件（没有新字段）仍然通过 |
| adapters | `quotaHint` 补验原文与 3 条正例；`TEXT_ERROR_PATTERNS` 的命中与不误判；`tool_update`（标题变化）；`session/prompt` 的 content 数组（文字 + 图片 base64 + resource_link + 小文本 resource）；没声明图片能力时拒绝；fake 适配器回复图片信息 |
| gateway | 上传：类型按文件头判断、SVG 当文件、可执行文件拒绝、20 MB 上限、每任务 50 个上限、文件名清洗、`GET` 的响应头；发送：附件不属于这个任务、图片发给不能看图的 Agent、`deferPrompt`；清理：24 小时未引用删除、删任务删目录；无回应：60 秒提示、提示替换不堆叠、10 分钟自动取消、等待审批不计时；退出记录与 `lastExit`；迁移 v5 |
| web | `flush.ts` 调度；`ws.ts` 的 `down` 状态；`picker.ts` 的显示和行为；`attachments.ts` 的筛选、命名、提示；`core.ts` 处理 `tool.update` 和带附件的 `message.user`；没有凭据时不发需要令牌的请求 |

### 9.13 验收记录

写 `docs/acceptance/step-1.3.md`（模板 `.agent/templates/acceptance.md`），包括：8.1 完成标准逐条打勾；9.11 每一项的真实结果（含消息条数和费用）；自动测试、类型检查、构建的结果；浏览器里的操作步骤和截图（截图放 `docs/acceptance/assets/`）；没通过、没验证的项和问题单。

### 9.14 开发顺序

1. 协议（9.6 的错误码、9.7 的 `tool.update`、9.9.1 全部）和测试。
2. 适配器：E、D、9.9.3；契约测试。
3. Gateway：C、B、9.9.2、迁移 v5；集成测试。
4. 网页：A、B 的界面、F、9.9.4、H 的 1 和 2。
5. `npm run typecheck`、`npm test`、`npm run build` 全部通过后，开发预览里用演示 Agent 把界面走一遍（截图）。
6. 9.11 真实补验（和用户约好时间），9.10 第 3 项，写验收记录，关单或开新单。
7. 本次按用户明确要求直接在原分支 main 分段提交，不再新建分支、不推送。提交格式沿用 `.agent/commit-convention.md`，每个代码提交均通过测试。

### 9.15 用户澄清：第三方配置与工作台独立 Agent（2026-11-08）

用户要求：无论哪家 Agent，都使用它们自己的设置，工作台不替换或更改其 API、登录；工作台有自己的一套 Agent 使用自定义 API。添加自定义模型保留原有认证和模型。配套设计为 design.md 6.4、ui-design.md 5.5 / 6.5；实现缺口见 ISSUE-0029。

#### 已确定的边界

1. 第三方 Agent：沿用自身配置，通过自身能力报告模型（包括其已配置并暴露的自定义模型）；工作台只做任务会话操作，不注入工作台 Key / Base URL，不代登录、登出或替换账号，不读写、复制凭据文件。
2. 工作台独立 Agent：单独的执行者，使用工作台管理的 API 服务与模型；有自己的会话、工具与审批。现有演示 Agent 不算独立 Agent 实现；将第三方进程换成 API 认证也不算完成。
3. 服务、模型分别管理：添加服务和添加模型均为追加，不覆盖原认证、模型或默认选项。第三方模型与工作台模型目录不串用。API 失败不回退第三方订阅或另一服务。
   - 2026-11-08 用户补充：必须支持多个 API 服务与多个模型，自动识别上下文大小、图片、思考强度等能力，参考 CCSwitch；固有能力与选型按专项调研补齐，见 9.16。
4. 工作台配置仍通过 `/api/v1` 管理，Key 使用 DPAPI；所有新类型只在 protocol 中定义，并保持协议只增不改。客户端不直连上游服务；默认测试离线、不启动真实 Agent、不花钱。
5. 旧的工作台测试账号停止使用，列明来源与状态；其迁移 / 清理只涉及工作台自己的数据，不读取或操作第三方凭据。测试账号尚未清理时必须明确记录。

#### 调整顺序与实现缺口

1. 本次先同步架构、界面设计、计划、真实验收和问题单；保留历史结果，停止旧认证补验。
2. 整改第三方适配器与管理界面，移除工作台替换其 API / 登录的入口和启动注入链路；增加回归测试，保证沿用软件设置、任务内换模型不改全局默认。
3. 为独立 Agent 补充具体执行器方案：可复用独立引擎或实现工作台执行逻辑，但必须满足上述配置与认证隔离。引擎、首批上游协议、工具执行和迁移规格尚未确定，不因本次需求澄清擅自安装引擎或引入依赖。
4. 按协议 → 执行器 / Gateway → 网页 → 自动测试 → 演示 → 真实补验实现。新增真实调用先更新消息预算与费用并获得用户同意；本轮已有消息仍计入原上限，不自动重发。

#### 新验收边界

- 接入第三方 Agent 前后，其自身认证、API 配置及原有模型保持不变；只通过软件自身状态与会话能力核对，不读取凭据文件。
- 工作台独立 Agent 在不依赖第三方订阅认证的条件下，通过自有 API 服务完成一次短对话和一次可拒绝的工具审批；出错不使用其他账号兜底。
- 添加第二个自定义模型后，第一个模型和原服务仍可选；默认值仅在用户明确设置时改变，密钥不出现在接口读取结果、日志、事件和截图中。
- 工作台服务与原有第三方配置相互独立；删除工作台测试服务的清理范围明确，第三方登录和模型保持不变。删除策略未落实不记为通过。
- 类型检查、默认测试、构建及界面实操均通过；按实际完成范围记录。第三方原生配置界面与 Agent 管理原型已验证，独立执行器及其服务 / 模型管理界面和原型仍标记未验证；不沿用早期“所有界面尚未调整”的状态。

#### 第三方边界整改接口与迁移（2026-11-08）

- AgentInfo 可选追加 `usesNativeConfig`；真实第三方适配器返回 true、`authMethods: []`。管理页显示软件自身配置说明，模型和强度仅来自原生会话能力，不展示工作台认证切换。
- AgentProfile 可选追加 `retired`。原版本保存的第三方非本机账号只读保留，标为停用，不出现在任务选择器；默认解析只选择本机配置。创建、编辑、登录、测试和刷新旧账号均返回追加的 `agent.native_configuration`（409），在读写密钥或启动进程前阻断。
- 若旧任务上一个会话曾使用停用账号，即使任务的 profileId 为空，也阻止恢复；不悄悄改用本机登录计费。旧任务、会话和密钥不自动删除或迁移。旧删除逻辑会把任务改到默认账号，先停用该清理入口；具体清理方案继续由 ISSUE-0028 跟踪。
- 启动第三方进程保留其 API、认证和配置目录环境，只清理工作台旧认证请求及宿主嵌套会话标识。工作台不创建第三方配置目录；会话换模型基于完整继承环境合并，保留原 provider，无法解析配置时停止。原有任务权限保护和用户设置来源不因整改而放宽。
- 本次只完成第三方边界这一段；AI Console 独立 Agent 的执行器与自有 API 配置功能仍待实现，不能以移除旧入口代替整体完成。

### 9.16 独立 Agent 专项调研后的需求细化（2026-11-08）

用户明确要求多个 API、多模型及上下文 / 图片 / 思考强度等自动识别，并授权多路子智能体调研。成果见 [独立 Agent 总报告](../research/independent-agent.md) 及其三个专项报告。以下补充目标与验证门槛，未把源码调研当作实现完成；具体共享类型、路由、数据库迁移和引擎版本须在离线验证后补成可实施契约。

#### 配置与模型能力

1. API 服务与服务内模型分别管理。相同模型 ID 可在两个服务下具有不同能力；任务固定所选服务、模型、协议及配置修订。创建 / 导入 / 刷新按主键追加或合并，不替换用户已有模型、手动值及默认项；切换默认值是明确的单独操作。
2. 先读取所选上游的有据元数据，随后按精确的服务 / 协议 / 套餐 / 模型匹配官方规格和公共目录。字段独立保留自动值、人工覆盖、来源版本、日期、适用范围、冲突和过期状态。目录和示例地址不参与凭据路由，也不触发安装、脚本或工具执行。
3. 至少表达总窗口、最大输入、最大输出、图片 / 模态、工具调用、推理控制、流式与 usage。布尔能力区分支持 / 不支持 / 未知，数值未知保持 null；思考开关、effort 枚举、预算各有语义，不能猜同一套档位。保留已有 ModelInfo 字段，仅追加可选信息，所有新类型只在 protocol 定义。
4. 当前协议、执行器和权限与模型能力共同决定可用操作。模型声明不能启用尚未实现的传输或工具。切换模型后重新校验参数、图片与预算；缺失元数据不自动得出不支持，兼容默认也不包装成已支持。
5. 发现和刷新不发送模型消息，不以长上下文或图片试探测极限。design 6.6 原有用户决定的“模型资料联网调研”是独立后台任务，使用其明确选定的服务与预算，单列调用；不把它混入元数据刷新，也不取消原有需求。真实能力验证必须另列目标、条件、上游请求次数和费用，等待用户授权；一次成功只能记录该样本成功。默认 npm test 使用固定 fixture 与假模型，不能请求实时目录或启动真实 Agent。

#### 固有能力与接入门槛

- 首个可用独立执行器应实现完整工具循环、项目规则与搜索读取、受控修改和冲突检查、经审批的命令 / 验证、取消与进程树收尾、持久化恢复、可回查压缩、附件、状态和用量。不能用仅聊天、假文件改动或只有调用工具的样例代替。
- 复用已有 Gateway 任务 / 事件 / 审批 / DPAPI；执行器、模型传输、会话记录、工具环境分开。工具不得继承工作台服务密钥，不能读取第三方凭据或自动执行项目 hooks。候选 SDK 不默认加载 CLI、原生工具、登录发现、用户扩展或全局配置。
- 引擎选择先做离线假模型验证，检查协议流、审批、拒绝无副作用、取消、恢复、服务密钥与地址不回退。通过后才确定依赖和精确版本；维护与许可证核查不等于运行验证。自建和复用的对比见专项报告。
- 任意命令的 Windows 文件 / 网络权限隔离单独验证；cwd、环境白名单和审批不能代替系统沙箱。未实现、未验证时明确实际保护范围，不能声称工具无法访问工作区外文件。
- worktree / 合并 / 回滚沿用 1.5，跨 Agent 交接和项目记忆沿用 1.6，MCP / Skill 与专用游戏工具沿用能力中心计划；分别标记状态，不宣称模型 API 天然具备这些执行能力。

#### 新增离线与界面验收

| 范围 | 必须覆盖 |
|---|---|
| 多服务 / 多模型 | 两服务各两个模型；重名 ID 隔离；追加与刷新保留原项、人工 false、默认值；停用 / 删除不让任务换服务计费 |
| 能力发现 | 只含 ID、完整字段、分页、空字段、未知 schema、坏条目、缓存过期、同级冲突、目录失效、准确匹配和无法匹配；手动覆盖可恢复自动值 |
| 协议与预算 | 不同 API 的窗口语义 / 推理参数；图片与工具三态；换模型重新校验；流中断 usage 不计为零；工具调用与结果成对 |
| 执行循环 | 假模型驱动真实临时文件搜索 / 修改与命令；审批拒绝未执行；旧内容冲突不覆盖；输出截断有提示；预算 / 调用次数上限可见 |
| 取消与恢复 | 流式、命令、审批期间取消或重启；不残留进程，不自动重放副作用不明的工具，保留拒绝理由与原始记录 |
| 网络与凭据 | `/api/v1` 令牌 / Host / Origin；密钥仅用于所选服务；目录不接收凭据 / 任务，不改变请求目标；重定向与恶意目录不能外泄密钥或执行内容 |
| 界面 | 添加两服务、批量 / 手动加模型、查看能力来源、刷新冲突、手动修订、换模型更新强度、工具审批、停止和恢复均实际操作 |

第 9.12 原清单仍需满足；本节是新独立 Agent 的补充，当前均未记为通过。实际实现和真实补验继续追加 step-1.3，ISSUE-0029 保持 investigating。

#### 2026-11-08 第一轮离线验证进度

新增开发验证脚本 `scripts/dev/verify-independent-agent.mjs`，仅加载忽略目录中固定的 Pi 1.5.0 候选。27 项假模型与临时文件场景通过，覆盖三种模拟协议、工具续传、部分审批 / 取消 / 恢复接缝；具体结果与八组门槛缺口见 [step-1.3](../acceptance/step-1.3.md#独立执行器第一轮离线验证2026-11-08)。这是候选验证进展，不是正式引擎选型通过；项目运行依赖未变，独立 Agent 未实现。SDK 默认参数转换、error 终态、缺 usage 零值及 Messages beta 路径的正式适配由 ISSUE-0030 跟踪；真实命令进程树、崩溃恢复、路径与上下文等验证仍须继续。
