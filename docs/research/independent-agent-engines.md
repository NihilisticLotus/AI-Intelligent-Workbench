# AI Console 独立编码 Agent：能力底线与开源引擎调研

日期：2026-11-08。状态：一手资料与固定源码核查完成；未安装、未启动候选引擎，未读取本机凭据，未发送模型请求，未完成兼容性或性能验收。

本报告只研究独立 Agent。它使用 AI Console 自己管理的多个 API 服务、模型和凭据，不改变、不借用 Claude Code、Codex、CodeBuddy、WorkBuddy、ZCode 的设置或认证。复用开源工具循环不等于复用这些产品的账号。结论是**离线 PoC 候选建议**，不是已选型、已接入或已验证可用的承诺。

## 1. 结论

本仓库已经有 Node + TypeScript Gateway、任务与审批状态、持久事件和 `/api/v1` 客户端边界。最值得先做离线 PoC 的路线是：**AI Console 自有执行器与工具，按需复用 pi-agent-core 的循环及 pi-ai 的协议适配层**。不要直接把 Pi CLI、OpenCode 服务、Goose Desktop 或 Cline Hub 的默认配置塞进 Gateway；默认运行时会引入第二套发现、存储、认证或后台服务机制。

这不是把 Agent 缩成聊天：文件读取、文件名与内容搜索、带冲突检查的编辑、创建文件、命令执行、审批、取消、失败恢复、上下文控制和费用记录仍是自有执行器的完整职责。复用 pi 只减少模型流、工具调用调度和部分消息表示的重复实现。若 PoC 不能证明可控的请求边界、工具前持久化和取消行为，就退回自建小而完整的循环；不能为了复用 SDK 放宽认证边界或删掉核心能力。

Cline 当前也有分层 TypeScript SDK，不能沿用“只有 VS Code 插件、无法嵌入”的旧结论。`@cline/agents` 是值得保留的第二个循环层候选；`@cline/core` 比纯循环重，提供会话、工具、插件与 Hub 等能力，但与 Gateway 已有职责重叠。OpenCode 适合另起独立服务作为完整引擎候选；Goose 的 Rust 状态机适合参考持久化与取消设计，对当前 Node 项目直接嵌入的成本较高。[P1][P2][C1][C2][O1][G1]

## 2. 核查方法、版本与许可证

以官方仓库、项目随源码发布的文档和许可证为依据；网页文档用于发现能力，关键接口以下表固定 commit 为准。`main` / `dev` 的固定快照不是稳定 API 保证。GitHub 旧地址发生跳转时记录规范地址，不把迁移误判为停更。

| 项目 | 本报告固定源码 commit | 当天观察到的发布与维护信号 | 源码许可证 |
|---|---|---|---|
| OpenCode，`anomalyco/opencode` | `c33eaa170ed5093c08f1684862a695aae036dcda`，`dev`，提交日期 2026-11-07 | 发布列表有 `v2.2.6`（2026-11-06），tag 指向 `dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06`；`/releases/latest` 同时返回 `v1.19.5`（2026-10-28），不能只据该端点判断系列；快照 core 包标 `2.2.5` | MIT，见 [O0] |
| Pi，旧 `badlogic/pi-mono` → `earendil-works/pi` | `a4ccccbd64d4ccea1644f5a07bb94ef09075b219`，`main`，2026-11-07 | `v1.5.0`（2026-11-02），tag `f9a26365568127461c47a07a37dcb42c140a3ac5`；循环包版本为 `1.5.0` | MIT，见 [P0] |
| Goose，旧 `block/goose` → `aaif-goose/goose` | `4facf56cbab049142809d9afa4648ebe6823ba80`，`main`，2026-11-06 | `v1.57.0`（2026-10-28），tag `30bba95105e59bc3e7df624cf6b4d433690cfe12` | Apache-2.0，见 [G0] |
| Cline，`cline/cline` | `94eecbbe1a2f899c66b118d13656651b0a884e1f`，`main`，2026-11-06 | `v4.1.26`（2026-10-26），tag `a459f1d04dea030833b558be645011ab739c463b`；SDK 包自己的版本是 `0.2.0`，不能当成 CLI 的 `4.1.26` | Apache-2.0，见 [C0] |

以上日期、tag、commit 来自 GitHub 官方 API 的仓库、commit、release/ref 元数据；四库当日均未标记归档，有近期提交或发布。它们说明仍在维护，不证明长期支持、无漏洞或 Windows 完全兼容。实际引入必须锁定已审计的**包版本与 lockfile 完整依赖**，另核查该发行包与源码快照的一致性，不能直接装 `latest`。

MIT 与 Apache-2.0 都允许按各自条件复用和分发；需要保留适用的许可证/版权/NOTICE，Apache-2.0 还包含专利条款及修改标识等义务。这里只核实项目许可证，不把它当成传递依赖、商标、模型服务条款的完整审核，也不承诺可直接使用原项目品牌。

## 3. 编码 Agent 的能力底线

Agent 的实际能力来自“模型 + 工具循环 + 工具实现 + 运行策略 + 状态”，不是模型列表。基本闭环必须是：接收目标 → 建上下文 → 请求模型 → 校验工具调用 → 判断权限并等待审批 → 执行工具 → 写入结果 → 把结果交回模型 → 继续直到完成或明确停止。工具异常、拒绝、超时、取消都要形成可解释结果。普通聊天请求只能覆盖其中一个步骤。[P2][G1][C1]

| MVP 必需 | 最低可验收行为 |
|---|---|
| 自有多服务、多模型 | 服务与模型分别建模；每次请求固定 `profileId`、协议、endpoint、模型、凭据引用与能力；不根据模型名猜 API 协议，不自动切到其他服务或订阅凭据 |
| 文件读取与搜索 | 目录枚举、文件名 glob/匹配、内容搜索；限制范围、二进制、大文件和输出长度，返回行号、截断与可继续读取信息；不能靠模型凭空猜文件，也不能把“有 shell”当作已经有可靠搜索 |
| 创建与编辑 | 结构化 patch 或唯一旧文本匹配；应用前检查基准内容/hash；审批展示真实目标与 diff；并发修改应报冲突，不能覆盖用户刚改的文件；写操作按文件或工作区串行 |
| 命令执行 | 显式 cwd、shell/argv 与环境；流式 stdout/stderr、退出码、输出上限、超时；挂起交互要可取消；把测试/构建结果返回模型后继续处理 |
| 审批与策略 | 复用 Gateway 审批；只读也有路径与凭据边界；拒绝不执行、超时不默认批准；批准绑定调用 ID、已校验参数、工作区/基准版本，参数变化重新判断 |
| 取消与终态 | 取消模型网络、等待审批、排队工具与已启动进程；对不响应的进程有强制结束策略；区分完成、拒绝、预算结束、失败、用户取消、运行中断 |
| 会话恢复与审计 | 保存模型消息、工具调用及结果、配置版本、审批决定；重启后恢复可见历史和可发送的上下文；已执行命令不能因为重放历史再次执行；未知执行结果保留为“中断/待核对” |
| 上下文和预算 | 保留调用与结果配对；有输入/输出/轮数/时长限制、工具输出截断、按需压缩与原始记录回查；不能安全整理时显式停止并说明，不能默默丢历史；摘要调用费用单列 |
| 附件 | 复用 Gateway 附件 ID、类型/大小校验、持久引用与能力检测；文本文件可明确展开，图片仅送支持视觉的模型；不支持的类型应提示，不偷偷忽略 |
| 可观测性 | 每轮模型/协议/服务、请求与工具耗时、输入/输出/cache token、重试/摘要开销、停止原因；费用有来源和“估算/未提供”，不能把未知费用展示为零 |

后续能力：完整 MCP/Skill 管理界面、MCP 资源与 OAuth 管理、跨任务记忆与检索、语义搜索、LSP、浏览器操作、计划与子 Agent、交接与分支、自动化、复杂 checkpoint/回滚。实现扩展接口可以提前，但不能以它们为借口推迟 MVP 的搜索、冲突检查、审批、恢复和基本上下文管理。

不应承诺：任意“OpenAI 兼容”接口都能正确调用工具；所有模型都支持图片/思考强度；跨模型无损上下文；摘要永不遗漏；取消能撤销已经发生的写入/网络副作用；仅 cwd 或权限弹窗即可形成系统沙箱；费用等于账单/余额；恢复等于任意外部副作用 exactly-once。

**任意 shell 是单独的真实门槛。** cwd、路径校验、私有 HOME、环境白名单和审批都不是操作系统沙箱。只要命令仍以当前 Windows 用户运行，它通常仍能直接读取该用户可访问的其他软件文件、启动程序或访问网络；换一个配置目录只能约束引擎的正常发现路径，不能阻止生成的命令越界。工具不继承 API Key 能减少泄漏，但不能因此保证“不读其他 Agent 凭据”。若产品要作这种强保证，必须采用经过验证的系统级隔离（例如受限账户/访问控制或虚拟化环境），并核实实际文件、网络与进程权限；否则只能承诺应用自身不主动读取/导入第三方认证，不能承诺任意命令无越界能力。当前 Windows 系统级隔离未实现、未实测，这一点不因选任何 SDK 而消失。[P5][O7][G6]

## 4. 固有能力矩阵

“有”表示固定源码/官方文档提供能力或接口，**不表示 AI Console 已接入或实测通过**。循环层、完整运行时与 CLI 的差别必须保留；表内涉及完整运行时的特性不会自动出现在底层循环包里。

| 维度 | OpenCode | Pi | Goose | Cline |
|---|---|---|---|---|
| 复用形态 | HTTP 服务/SDK；另有 core，但内部服务面较大 | `pi-ai` 模型层、`pi-agent-core` 循环、`pi-coding-agent` 完整会话 SDK、RPC 分层 | Rust `goose-agent` 状态机；完整 Goose/ACP；GDK 跨语言绑定 | `@cline/llms` 模型、`@cline/agents` 循环、`@cline/core` 完整 Node 运行时、SDK 重导出 |
| 工具循环 | 有完整会话执行与工具结果反馈 | 有；自定义 `AgentTool`、流事件、逐轮上下文钩子 | 有；按持久会话推进 Operation/Effect，支持工具审批步骤 | 有；Agent 可自定义模型与全部工具，Core 加完整工具/会话 |
| 读写、搜索、命令 | read/write/edit/patch、glob/grep、shell | 完整 SDK 有 read/edit/write、grep/find/ls、bash/powershell；循环层无内置文件工具 | 完整产品 Developer 扩展有 shell、text_editor、read_image；纯状态机由宿主供工具 | Core 的 read_files、search_codebase、editor/apply_patch、run_commands；纯 Agents 无内置工具 |
| 审批 | allow/ask/deny、规则、事件与回复 | 循环 `beforeToolCall` 可异步阻止；CLI 默认并非逐工具审批，宿主须接审批 | 完整产品有自动/手动/智能/纯聊天模式，默认自动；状态机有 ToolApprovalOperation | toolPolicies 与 requestToolApproval；**未列的工具默认启用并自动批准** |
| 取消、超时 | 有会话停止/中断；shell 源码有超时及强杀参数 | abort/waitForIdle；工具接 AbortSignal；shell 超时需工具层配合 | CancellationToken、取消收尾与中断结果；MCP 扩展 timeout | abort；工具/运行限制；CLI 有 task timeout；宿主工具仍须实现进程终止 |
| 会话恢复 | 有自身数据库/会话机制；不是 Gateway 的库 | 完整 SDK JSONL 树/branch/fork/恢复；循环只保留 messages，可由宿主持久化 | 完整产品本地会话库/恢复/fork；状态机提供 SessionLoader/EffectHandler 抽象 | Core 有会话存储/恢复/checkpoint；Agents 有 snapshot/restore，持久化由宿主做 |
| 上下文 | 有 compaction、保留尾部及 usage 记录 | 完整 SDK 有自动/手动 compaction、分支摘要；循环有 transformContext/prepareRequest | 完整产品有自动/手动 compaction、工具结果缩减、轮数限制 | Core 有 compaction/checkpoint；Agents 可提供历史与限制，不能当成自动继承全部 Core 功能 |
| MCP/技能 | 完整产品支持 | 当前 CLI 有内置 MCP/codemode 扩展；**SDK 默认不装配 MCP**，需显式 extensionFactories/bindExtensions；技能可受 ResourceLoader 控制 | MCP 是主要扩展机制；技能发现可指定 roots；纯 GDK 绑定不等于完整宿主 | Core 有 MCP/skills/plugins；纯 Agents 只运行提供的工具 |
| 附件 | 有媒体/文件消息表示；实际发送受模型能力约束 | 支持图片与文件上下文；循环可传图片内容，类型处理由宿主负责 | 完整 Developer 的 read_image；跨语言类型有丰富内容；UI 能力不能直接当 SDK 上传接口 | CLI 可 `@` 图片；SDK 消息/工具能力分层，需逐类型验证，不能承诺任意文件 |
| token/费用/事件 | 有 token、usage、费用及 compaction 计费 | 有 usage/cost 与流/工具事件；摘要 usage 可单独记录 | 有 usage 事件、成本估算、可选 observability hook | 有 usage-updated/result usage、Core accumulated usage、可注入日志/telemetry |

证据：OpenCode [O1–O7]；Pi [P1–P8]；Goose [G1–G7]；Cline [C1–C7]。表格不比较模型聪明程度；模型是否稳定遵循工具 schema、补丁准确性、工具并发与长任务表现均未实测。

## 5. 四个候选的适配价值与风险

### 5.1 Pi：优先验证“模型层/循环层”，不是默认启动完整 CLI

源码可证明：`pi-agent-core` 的 `Agent` 接受自定义 `streamFn`、`initialState.tools/messages`、`beforeToolCall`、`prepareRequest`、`transformContext`、`finishTurn`；工具执行函数得到 `AbortSignal` 并可流式报告结果。工具事件足以归一化到现有 `AgentUpdate`。该包仅依赖自己的 ai/schema 包，不需要 coding-agent 的文件工具、资源发现和会话文件。[P1][P2]

固定快照中的实际包名是 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai` 和 `@earendil-works/pi-schema`，版本均为 `1.5.0`，前两者声明 Node `>=22.19.0`。这是源码标注，不是已安装包的验收。循环层只有两个直接依赖，**不等于完整依赖很少**：pi-ai 还依赖多家模型 SDK、代理支持和自身 telemetry 包。离线 PoC 必须核查最终安装图、导入时副作用与网络行为；按需导入协议模块也不自动减少安装包或证明没有隐式联网。包清单见 [agent/package.json](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/agent/package.json)、[ai/package.json](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/ai/package.json)。

因此**可以只复用模型层与循环，完全不用原生工具与磁盘会话存储**。Gateway 可提供自己的读写搜索命令，使用自己的 SQLite/事件库作为权威记录，每次请求前从已提交消息恢复模型上下文。注意 `agent.state.messages` 只是内存状态，不会自动变成 Gateway 的可靠事务；`agent.subscribe` 与 `prepareRequest` 提供了接缝，不提供副作用 exactly-once。[P2]

若使用高层 `createAgentSession()`，也能覆盖 `modelRuntime`、`settingsManager`、`sessionManager`、`resourceLoader` 和工具，官方 full-control 示例明确展示“无 discovery、显式配置”。`SessionManager.inMemory()` 能避免 Pi 会话文件，但它仍是 Pi SessionManager 的格式/语义，不能把任意 Gateway 存储直接强转进去；可做导入投影或另写适配。MVP 若已经有完整 Gateway 存储，优先低层循环会更清楚。[P3][P4]

默认风险必须正视：高层工厂会创建 ModelRuntime、文件设置、持久 SessionManager、DefaultResourceLoader；安全文档说明 cwd 不是文件隔离、扩展在宿主进程执行、默认不会每次工具都询问。项目可信机制也不会禁用所有上下文文件。原生 grep/find 通过工具管理器找 rg/fd，缺失时可能查询最新版本并下载；`PI_OFFLINE` 可跳过该下载，但不能替代替换原生工具的审计。不要为了获得“自带搜索”而接受运行时自动下载。[P3][P5][P6]

### 5.2 OpenCode：适合完整子进程服务，版本与默认发现面更重

OpenCode 官方提供 headless HTTP Server 和客户端 SDK；这适合“私有子进程引擎 → Gateway 翻译事件”的架构。浏览器仍只能访问 AI Console `/api/v1`，不直连 OpenCode，不开放第二套未经 Gateway 鉴权的端口。完整运行时的优势是工具、权限、MCP、会话和压缩整合程度高。[O1][O2]

源码快照是 V2，网页同时存在 V1/V2 文档，permission/action/工具名、包和路由不能混用。V2 config discovery 会查系统、global、项目，以及 `.claude`、`.agents` 资源；其选项支持关闭若干来源，但不能凭“传一个 config 路径”推断隔离完成。当前 core 还有可选 Claude Agent SDK provider 与 ChatGPT/Copilot 等 provider；它们不是自有 API 执行器所需。必须仅允许 AI Console 显式 provider，关闭外部认证、原厂/目录发现和可执行资源加载，单独审计迁移与外部凭据路径。[O3][O4][O5]

V1 固定发布源码的 config 还可启动背景依赖安装，证明把“配置文件只是一段 JSON”当成安全假设不成立；V2 的插件解析、包加载、LSP/formatter 等自动安装行为须按实际打包版本重新审计，不能把某个关闭开关当成全局禁止安装保证。[O8]

对当前项目，它增加第二套事件、审批、凭据、数据库和 HTTP 生命周期；复用完整产品的收益必须超过翻译、版本漂移和隔离成本。不能直接导入 core 就宣称拥有稳定精简 SDK。[O2][O3]

### 5.3 Goose：持久状态机是有价值的参考，GDK 名字不等于全套 Agent

`goose-agent` 把循环拆成 Operation、Effect、SessionLoader/EffectHandler 和 CancellationToken。工具批准步骤先保存确认请求再让用户操作，取消时保存已收到内容，为未完成调用补中断结果；这些设计对 Gateway 很有参考价值。文档同时明确：丢弃 future 不能撤销外部动作，也不能保证停止已开始的阻塞工作。[G1]

但 `goose-sdk` README 描述的 UniFFI Python/Kotlin 表面主要是 provider 构造、模型调用、丰富消息和 observability，不应把它写成“Node 下一个 SDK 直接具备持久编码 Agent”。完整 Goose 才装配本地会话、Developer、权限、MCP、压缩等。当前 Node/Windows 项目若直接嵌入 Rust 循环，还要负责绑定、发布与工具宿主；完整 Goose 子进程则回到双存储/双生命周期问题。[G1][G2]

`GOOSE_PATH_ROOT` 可把数据/配置/状态放专属目录，但系统 keyring 默认开启，需另处理 `GOOSE_DISABLE_KEYRING` 和凭据来源；工具 shell 继承环境，扩展可配置 `npx`/`uvx` 等命令并发生下载/执行。自动会话命名可能额外发模型请求，官方有 `GOOSE_DISABLE_SESSION_NAMING` 开关。它们都说明仅隔离文件夹不等于无凭据复用、无隐式请求或无安装。[G3][G6][G7]

### 5.4 Cline：当前有真正分层 SDK，低层可作备选

当前官方 SDK 不是 VS Code UI 包装：`@cline/agents` 是独立循环，`@cline/core` 是带工具、持久化、插件等的 Node 运行时，`@cline/llms` 负责模型网关。直接 Agent 支持自定义 `model` 或 provider/baseUrl/apiKey、全部工具、initialMessages、restore/snapshot、abort；Core 有完整工具和审批回调。SDK 包 `0.2.0` 与应用版本分开，API 漂移及发行物一致性仍需核验。[C1][C2][C3]

适配关键是改掉默认宽松审批：未列入 toolPolicies 的工具默认启用并自动批准，不能靠“注册了 requestToolApproval 回调”推断所有工具都会询问。若采用低层循环，应把 Gateway 工具注册表作为唯一来源，并为全部工具明确政策，插件后加工具也不得绕过。[C4]

完整 Core 支持 local/auto/hub/remote；官方 Hub 方案会发现本机锁文件、连接/启动后台 Hub、共享会话。当前项目已有 Gateway，不应使用默认 auto 或接入用户已有 Cline Hub；须显式 local、私有状态和显式模型配置，再审计 plugins/MCP/配置加载、legacy migration 与 telemetry。该隔离组合尚未通过离线 PoC，不能因 CLI 有 `--config`/`--data-dir` 就承诺 SDK 不碰全局状态。[C5][C6][C7]

## 6. pi-ai 的请求与认证边界：已证实与待验证

这部分特意区分高层模型注册表与直接协议适配器，避免沿用旧版包名/API 的经验。

1. **高层默认会回退。** 当前 `Models` 默认使用内存 CredentialStore，但默认 AuthContext 读取 `process.env`，并提供本机文件存在检查；`resolveProviderAuth` 的优先级是显式 apiKey → 已存凭据（可能 OAuth 刷新）→ provider 的环境/ambient 认证。内置 `openaiProvider` 自带原厂 `https://api.openai.com/v1` 与 OAuth；这不是 AI Console 要默认接受的行为。[P9][P10][P11]
2. **当前直接 OpenAI API 适配器不在缺 Key 时自行查环境。** `api/openai-completions.ts` 和 `api/openai-responses.ts` 的 `getClientApiKey()` 在缺非空 Key、也没有 Authorization 等 header 时抛错。它们把 `model.baseUrl` 作为 OpenAI client 的 baseURL，并接受注入 fetch。但这只证明这两个固定适配器路径，不证明所有 provider 或历史 compat 层都如此。[P12][P13]
3. **空 env 不是禁止回退。** `getProviderEnvValue` 使用 `env[name] || process.env[name] || ...`；给 `env: {}` 不能屏蔽宿主变量。Responses 适配器另有针对 provider=`openai`、原厂地址和特定 Key 形态的 ChatGPT sign-in 分支。因此自定义服务必须有自己的 provider ID、明确 wire API 和显式 endpoint，避免误进订阅逻辑。[P13][P14]

建议的 PoC 调用边界如下，尚未实现：

- 只导入必要的 core/direct API 适配器，不加载 compat、CLI、OAuth、全 provider catalog 或默认 ModelRuntime。pi-ai 主入口明确声明没有自动 catalog、provider factory、OAuth 实现等装配；仍须审计被选择的适配器及依赖。[P15]
- `streamFn` 从 Gateway 当前批准的服务快照取 endpoint、wire API、模型、非空 Key、headers 与能力；缺任一必需值则在 SDK 前失败。模型返回的内容、repo 文件或工具参数不能更改 endpoint/Key。多个服务即使模型名相同，也使用不同服务身份，不共享 credential 槽位。
- 若用 Models，则显式提供不读磁盘的 CredentialStore 和封闭 AuthContext，不允许环境/文件检查兜底，不注册 OAuth，并限制 provider 注册；显式覆盖 apiKey 不是跳过后续 endpoint 审计的理由。
- 对已验证支持注入 fetch 的适配器统一包一层：只放行本次 endpoint 的 origin 与必要 path，检查最终请求和重定向，不跟随到未配置 origin；重试、压缩、标题生成同样经过此边界。禁止 SDK 在失败后切原厂、切服务或另发隐藏请求。仅支持完成该审计的协议，其他 provider 显示未支持。
- Key 只在模型请求 worker 内存/私有 IPC 中出现，不放进 `process.env`、工具参数、会话消息或日志；启动工具进程显式构造最小 env，不继承模型 worker 的认证变量。若工具与模型在同一进程，恶意扩展仍可读内存，所以禁止非审核代码扩展，且不要把这个实现称为安全沙箱。
- 自定义服务的价格、contextWindow、工具/图片支持及最大输出由 Gateway 配置/探测结果决定；不能继承同名原厂模型的价格与能力后宣称精确。

以上接口接缝均有源码依据；“禁止触达用户凭据文件、无额外网络、无 Key 泄漏、Windows 取消和恢复正确”必须由下节验收获得，当前没有这些实测结论。

## 7. 与本仓库的映射及方案取舍

仓库核查位置：`packages/adapters/src/types.ts` 已定义 `AgentConnection.prompt`/`close`、`SessionHost.requestPermission(req, signal)`、`AgentUpdate` 的消息/工具/usage；`packages/protocol/src/index.ts` 已有任务状态、approval、message/tool/session.usage 事件；`packages/gateway/src/tasks.ts` 约定先落 EventStore 再推送；`packages/gateway/src/ws.ts` 做重放。新执行器应遵守这些边界，不另建浏览器直连 SDK 的捷径。新增协议类型仍只在 `packages/protocol`，内部第三方消息类型必须在适配层转换。

| 路线 | 收益 | 自己仍要完成 | 对当前仓库建议 |
|---|---|---|---|
| 自建小而完整执行器 | 完全掌握认证、工具与持久化，无默认全局发现；易与 Gateway 审批/事件一致 | 多协议流式工具调用拼接、schema 校验、调用/结果配对、重试/超限、取消、恢复、所有文件与命令语义 | 保留为基线与回退；不能只做一次聊天 HTTP 请求 |
| 复用 pi-ai + pi-agent-core | 减少模型流、消息类型、工具调度与钩子重复；工具与存储可完全自有 | 本报告全部 MVP 工具、策略、冲突检查、事务/恢复、网络与凭据边界、适配事件 | **优先做离线 PoC**，通过后再作正式选型 |
| 复用 Cline agents/llms | 同为 TypeScript，模型与循环可替换 | 与 pi 同样需要工具/持久化/边界；处理 SDK 0.x 漂移和默认审批 | 第二候选，不默认引入完整 Core/Hub |
| 嵌入完整 Pi/Cline Core | 直接得到压缩、资源与存储的较完整装配 | 双存储一致性、默认发现和认证审计、精简工具策略、取消/恢复映射 | 只有复用收益明确且隔离 PoC 通过再考虑 |
| OpenCode/Goose 独立子进程 | 成熟产品工具、MCP、会话等较齐全；进程故障可隔离 | 私有配置/数据、默认扩展/认证/安装审计、双协议与事件、端口/后台进程、部署更新 | 保留为完整引擎候选；当前不优先 |

自有工具实现建议作为 Gateway 可替换的 ToolExecutor，不绑定 pi 的工具名或 session 文件；模型循环通过统一事件回调接 SessionHost。审批时先把规范化调用与输入基准存下，再请求 Gateway 的权限；执行前重新检查文件基准，授权和执行之间发生变化就报冲突。每个副作用调用至少有 `pending → approved/rejected → running → succeeded/failed/interrupted` 记录；恢复只恢复上下文和待处理状态，不重放 succeeded 的副作用。

底层循环可并行工具，不代表应该并行写文件。MVP 默认按轮顺序执行副作用，读/搜索可在明确无冲突时并行。tool_start 事件也不等于副作用已启动，界面和恢复日志需记录准确阶段。现有 `usage.used/size` 不能天然表达每轮输入输出/cache 及估算来源，后续协议扩展需设计，不要把累计 token 冒充当前上下文占用。

## 8. 进入实现前的离线 PoC 门槛

全程用假模型响应、临时工作区、假凭据和受控 fetch；不调用真实模型、不读取用户认证。PoC 可以读候选发行包源码并锁版本，但不能把本次“资料调研”写成已完成这些测试。

1. **完整闭环**：假模型要求搜索 → 读文件 → patch → 执行一个失败再成功的测试命令 → 收到结果后继续 → 输出终态；验证文件搜索和实际写入，不能只测文本回复。
2. **请求边界**：未配置 Key/baseUrl 立即失败；宿主放诱饵 OPENAI/ANTHROPIC 变量和假的全局配置仍不得使用；模拟 401、重试、重定向、超限和摘要，所有请求只去当前显式服务；切服务不串 Key、不用同名模型覆盖服务身份。
3. **全局无触达**：监控文件、网络、进程；禁止/记录访问用户 Agent 配置与凭据、全局 keyring、系统配置、隐藏目录、自动安装/下载/升级/telemetry 和 Hub 发现。仅“文件没被改”不能证明“没被读”。
4. **审批**：用户批准前无写入/进程；拒绝、过期、取消都不执行；参数或文件基准变化必须重新判断；审批先落库再显示，重连/重复回复不造成重复执行。
5. **冲突**：唯一旧文本不匹配、多处匹配、审批期间用户编辑、两个任务同时编辑、大小写/软链接/目录逃逸、CRLF/UTF-8；均不能静默覆盖。不要把 SDK 的旧文本匹配等同于全工作区乐观并发控制。
6. **取消与超时**：模型慢流、正在等审批、排队工具、大输出、挂起命令及子孙进程；验证 Windows 的实际进程树已终止、流不再推进、审批无悬挂、晚到事件不能把 cancelled 改成 completed。AbortSignal 的存在不是通过标准。
7. **恢复**：在调用记录落库后、启动工具前、文件写入后但结果落库前分别中止 worker/Gateway；重启后历史完整、工具调用配对合法、不重复外部副作用；未知结果保留待核对而不是假装失败后自动重跑。
8. **上下文与用量**：长工具输出截断可追溯，调用/结果配对不被裁开；超限/预算正常终止；重试/摘要 usage 算入实际运行；未知 token/价格不显示为精确值或零；附件从持久 ID 恢复且受模型能力约束。

通过后才有依据决定采用哪个包、是否需要独立 worker，以及哪些能力能在界面开放。任何一项隔离或副作用恢复门槛失败都应记录具体限制，不以“开源引擎已有此功能”代替 AI Console 的验收。

## 9. 来源索引

以下均为项目官方仓库/官方文档；固定源码链接可复查。发布信号另见各仓库 [OpenCode releases](https://github.com/anomalyco/opencode/releases)、[Pi releases](https://github.com/earendil-works/pi/releases)、[Goose releases](https://github.com/aaif-goose/goose/releases)、[Cline releases](https://github.com/cline/cline/releases)。

### OpenCode

- [O0：固定 LICENSE](https://github.com/anomalyco/opencode/blob/c33eaa170ed5093c08f1684862a695aae036dcda/LICENSE)。
- [O1：官方 Server 文档](https://docs.opencode.ai/docs/server/)、[官方 SDK 文档](https://docs.opencode.ai/docs/sdk/)；这组仍可能展示 V1，不能直接套到 V2。
- [O2：固定 core package.json](https://github.com/anomalyco/opencode/blob/c33eaa170ed5093c08f1684862a695aae036dcda/packages/core/package.json)。
- [O3：固定 ConfigDiscovery](https://github.com/anomalyco/opencode/blob/c33eaa170ed5093c08f1684862a695aae036dcda/packages/core/src/config/discovery.ts)。
- [O4：固定 permission 实现](https://github.com/anomalyco/opencode/blob/c33eaa170ed5093c08f1684862a695aae036dcda/packages/core/src/permission.ts)、[官方 V2 权限说明](https://opencode.ai/docs/permissions/)。
- [O5：固定 credential 实现](https://github.com/anomalyco/opencode/blob/c33eaa170ed5093c08f1684862a695aae036dcda/packages/core/src/credential.ts)、[provider 插件目录](https://github.com/anomalyco/opencode/tree/c33eaa170ed5093c08f1684862a695aae036dcda/packages/core/src/plugin/provider)。
- [O6：固定 compaction](https://github.com/anomalyco/opencode/blob/c33eaa170ed5093c08f1684862a695aae036dcda/packages/core/src/session/compaction.ts)、[附件 blob](https://github.com/anomalyco/opencode/blob/c33eaa170ed5093c08f1684862a695aae036dcda/packages/core/src/session/blob.ts)。
- [O7：固定 shell 工具](https://github.com/anomalyco/opencode/blob/c33eaa170ed5093c08f1684862a695aae036dcda/packages/core/src/tool/bash.ts)、[MCP 实现](https://github.com/anomalyco/opencode/tree/c33eaa170ed5093c08f1684862a695aae036dcda/packages/core/src/mcp)。
- [O8：V1 v1.19.5 固定 config，背景依赖安装依据](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/config/config.ts)。

### Pi

- [P0：固定 LICENSE](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/LICENSE)。
- [P1：循环 package.json](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/agent/package.json)。
- [P2：循环 README，工具、事件、钩子、取消与上下文接口](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/agent/README.md)。
- [P3：固定 SDK 文档](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/coding-agent/docs/sdk.md)、[SDK 工厂源码](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/coding-agent/src/core/sdk.ts)。
- [P4：full-control 示例](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/coding-agent/examples/sdk/12-full-control.ts)、[CLI/RPC 集成与重命名](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/coding-agent/docs/cli-integration.md)。
- [P5：固定安全说明](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/coding-agent/docs/security.md)。
- [P6：工具下载管理器](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/coding-agent/src/utils/tools-manager.ts)、[环境与离线开关](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/coding-agent/docs/environment-variables.md)。
- [P7：compaction 与摘要计费](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/coding-agent/docs/compaction.md)、[会话格式](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/coding-agent/docs/session-format.md)。
- [P8：原生 edit 的唯一匹配语义](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/coding-agent/src/core/tools/edit.ts)。
- [P9：Models 工厂默认 credential/auth context](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/ai/src/models.ts)、[默认 AuthContext](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/ai/src/auth/context.ts)。
- [P10：认证解析优先级](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/ai/src/auth/resolve.ts)、[envApiKeyAuth](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/ai/src/auth/helpers.ts)。
- [P11：内置 OpenAI provider](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/ai/src/providers/openai.ts)。
- [P12：直接 Chat Completions 适配器](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/ai/src/api/openai-completions.ts)。
- [P13：直接 Responses 适配器](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/ai/src/api/openai-responses.ts)。
- [P14：provider-env 回退规则](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/ai/src/utils/provider-env.ts)。
- [P15：pi-ai 主入口装配边界](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/ai/src/index.ts)、[AuthContext/CredentialStore 接口](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/ai/src/auth/types.ts)。

### Goose

- [G0：固定 LICENSE](https://github.com/aaif-goose/goose/blob/4facf56cbab049142809d9afa4648ebe6823ba80/LICENSE)。
- [G1：goose-agent 状态机、审批、取消与持久化边界](https://github.com/aaif-goose/goose/blob/4facf56cbab049142809d9afa4648ebe6823ba80/crates/goose-agent/README.md)。
- [G2：GDK/SDK 实际绑定范围及 observability](https://github.com/aaif-goose/goose/blob/4facf56cbab049142809d9afa4648ebe6823ba80/crates/goose-sdk/README.md)。
- [G3：环境变量、路径、keyring、标题和用量开关](https://github.com/aaif-goose/goose/blob/4facf56cbab049142809d9afa4648ebe6823ba80/documentation/docs/guides/environment-variables.md)。
- [G4：权限模式及默认自动](https://github.com/aaif-goose/goose/blob/4facf56cbab049142809d9afa4648ebe6823ba80/documentation/docs/guides/managing-tools/goose-permissions.md)。
- [G5：压缩、context 与费用估算](https://github.com/aaif-goose/goose/blob/4facf56cbab049142809d9afa4648ebe6823ba80/documentation/docs/guides/sessions/smart-context-management.md)、[会话恢复](https://github.com/aaif-goose/goose/blob/4facf56cbab049142809d9afa4648ebe6823ba80/documentation/docs/guides/sessions/session-management.md)。
- [G6：Developer 工具及环境继承](https://github.com/aaif-goose/goose/blob/4facf56cbab049142809d9afa4648ebe6823ba80/documentation/docs/mcp/developer-mcp.md)。
- [G7：扩展命令、npx/uvx、timeout](https://github.com/aaif-goose/goose/blob/4facf56cbab049142809d9afa4648ebe6823ba80/documentation/docs/getting-started/using-extensions.md)、[headless 模式限制](https://github.com/aaif-goose/goose/blob/4facf56cbab049142809d9afa4648ebe6823ba80/documentation/docs/tutorials/headless-goose.md)。

### Cline

- [C0：固定 LICENSE](https://github.com/cline/cline/blob/94eecbbe1a2f899c66b118d13656651b0a884e1f/LICENSE)。
- [C1：官方随源码 SDK 介绍与分层](https://github.com/cline/cline/blob/94eecbbe1a2f899c66b118d13656651b0a884e1f/docs/sdk/overview.mdx)、[Agents package.json](https://github.com/cline/cline/blob/94eecbbe1a2f899c66b118d13656651b0a884e1f/sdk/packages/agents/package.json)。
- [C2：Agent API](https://github.com/cline/cline/blob/94eecbbe1a2f899c66b118d13656651b0a884e1f/docs/sdk/reference/agent.mdx)、[固定 agent-runtime 源码](https://github.com/cline/cline/blob/94eecbbe1a2f899c66b118d13656651b0a884e1f/sdk/packages/agents/src/agent-runtime.ts)。
- [C3：Core API](https://github.com/cline/cline/blob/94eecbbe1a2f899c66b118d13656651b0a884e1f/docs/sdk/reference/cline-core.mdx)、[工具分层](https://github.com/cline/cline/blob/94eecbbe1a2f899c66b118d13656651b0a884e1f/docs/sdk/tools.mdx)。
- [C4：审批与默认自动批准](https://github.com/cline/cline/blob/94eecbbe1a2f899c66b118d13656651b0a884e1f/docs/sdk/guides/permission-handling.mdx)。
- [C5：Hub-spoke、默认 backend 与会话存储](https://github.com/cline/cline/blob/94eecbbe1a2f899c66b118d13656651b0a884e1f/docs/sdk/architecture/hub-spoke.mdx)。
- [C6：模型、自定义 endpoint 与成本接口](https://github.com/cline/cline/blob/94eecbbe1a2f899c66b118d13656651b0a884e1f/docs/sdk/model-providers.mdx)、[生产化与监控](https://github.com/cline/cline/blob/94eecbbe1a2f899c66b118d13656651b0a884e1f/docs/sdk/guides/going-to-production.mdx)。
- [C7：CLI 参数和附件（不能冒充 SDK 参数）](https://github.com/cline/cline/blob/94eecbbe1a2f899c66b118d13656651b0a884e1f/docs/usage/cli-overview.mdx)、[Core 版本与依赖](https://github.com/cline/cline/blob/94eecbbe1a2f899c66b118d13656651b0a884e1f/sdk/packages/core/package.json)。
