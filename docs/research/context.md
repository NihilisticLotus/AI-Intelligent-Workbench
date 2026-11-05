# 调研：切换模型 / Agent 时保留上下文

> 2026-11-05 · 配套 `design.md` v0.3
> 资料均为当日从官方仓库、npm registry、官方文档实际读取；标"待验证"的未能核实。

## 1. 结论先行

1. 没有通用的跨 Agent 会话格式。同类产品跨 Agent 迁移靠"共享工作区文件 + 交接摘要"，同 Agent 内靠原生 resume / 会话内切换模型。
2. ACP 已经把"会话内换模型"标准化：用 `session/set_config_option`（model 类别已稳定），`session/resume`、`session/list`、`session/close` 也已稳定；`session/fork` 仍在 unstable。原设计里"按适配器静态声明能力"应改为"按 ACP 握手结果动态判断"。
3. TencentDB-Agent-Memory 设计思路（L0–L3 分层 + BM25/向量/RRF 混合检索 + 预算截断）值得借鉴，但它是 Proxy 形态、处于 beta、依赖较重，不适合嵌入 Gateway 核心。只作为可选的外部长期记忆服务预留接口。
4. 推荐方案：Gateway 自己实现三层记忆：
   - 事件日志：append-only，加 OpenHands 式的压缩墓碑事件。
   - 任务账本：结构化记录事实、决策、文件索引、未决问题。
   - 项目记忆：SQLite FTS5 检索，向量检索可选。

   切换时按能力分级选择：会话内切换 → 原生恢复 → 交接包。交接包带 token 预算控制。

## 2. 记忆 / 上下文方案

| 方案 | 要点 | 本地 Node 可用性 | 许可证 | 结论 |
|---|---|---|---|---|
| TencentDB-Agent-Memory | 见第 3 节 | 可本地跑（SQLite + sqlite-vec），但需要 3 个服务，提炼依赖 LLM 和 embedding API | MIT（附腾讯声明） | 可选外部服务；借鉴分层与检索 |
| mem0（`mem0ai` 3.3.1） | 从对话中由 LLM 抽取事实和偏好；TS 版本地模式默认 better-sqlite3 向量存储，另支持 20 多种后端 | 可嵌入 | Apache-2.0 | 可作"项目记忆"插件；不适合存事件 |
| OpenMemory（mem0ai/openmemory） | 在 Claude Code、Codex、OpenCode 之间迁移会话的 CLI/TUI，beta，约 100 star | 可参考 | MIT | 参考它的会话格式转换；实时同步还在规划中 |
| Letta / letta-code | memory blocks（Agent 自己改写的上下文块）；MemFS 用 git 管理上下文版本；dreaming（后台子 Agent 整理记忆）；原 Python 服务端已归档 | 它本身是完整的 Agent harness | Apache-2.0 | 可作为一个 ACP Agent 接入；借鉴"后台整理记忆" |
| Graphiti / Zep | 双时态知识图谱，事实带有效期，信息变化时旧事实自动失效；需要 Neo4j 或 FalkorDB；Zep 仅云服务 | 不适合（Python + 图数据库） | Apache-2.0 | 借鉴"事实失效"字段，在 SQLite 上自行简化实现 |
| LangGraph.js | checkpointer 按 thread 存状态快照，`@langchain/langgraph-checkpoint-sqlite` 基于 better-sqlite3；JS 版 Store 只确认有 InMemory 实现（SQLite 版待验证） | 可嵌入 | MIT | 借鉴 thread + checkpoint 模型；不引入整套框架 |
| OpenHands condenser | 新版 SDK 主策略是 LLMSummarizingCondenser：超过 240 个事件或 token 上限时，把前半段换成一条摘要（保留前 2 条）。事件日志只追加，压缩记为一条 Condensation 事件，再由 View 动态应用。旧版还有 ObservationMasking、RecentEvents、StructuredSummary 等策略 | 策略容易用 TS 重写 | MIT | 直接采用"墓碑事件 + 视图"的思路和观察遮蔽 |
| SQLite FTS5 / sqlite-vec | better-sqlite3 默认编译了 FTS5；sqlite-vec 0.1.9 有 windows-x64 预编译包，但仍是 pre-v1，默认暴力 KNN | 可嵌入 | sqlite-vec：Apache-2.0（是否双许可待验证） | 推荐作检索底座：一个库文件里放 FTS5 和 vec0，用 RRF 融合两路结果 |
| Claude Code | `/compact [重点]`，可设自动压缩阈值；CLAUDE.md 分四层（Managed、用户、项目、本地），`@import` 最多嵌套 4 层；`--resume` / `--continue` / `--fork-session`；会话 jsonl 存在 `~/.claude/projects/` 下，内部格式会变 | — | — | 不解析它的 jsonl，只通过 ACP 恢复 |
| Codex CLI | 会话存在 `~/.codex/sessions`；支持 `codex resume` / `fork` / `exec resume`，`/compact`、`/model`；app-server 提供 thread/start、resume、fork、rollback 等方法 | — | — | 同上 |
| A2A v1.0.1 | 面向远程、黑盒 Agent 之间的协作，用 Task + contextId 组织；不涉及文件、终端和审批 | — | Apache-2.0 | 本地编排不用；以后对外暴露工作台时再考虑 |

来源：
[mem0-ts](https://github.com/mem0ai/mem0/tree/main/mem0-ts) ·
[openmemory](https://github.com/mem0ai/openmemory) ·
[letta-code](https://github.com/letta-ai/letta-code) ·
[Letta memory](https://docs.letta.com/letta-code/memory) ·
[graphiti](https://github.com/getzep/graphiti) ·
[langgraphjs checkpoint-sqlite](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-sqlite) ·
[OpenHands condenser](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/context/condenser/README.md) ·
[OpenHands 旧版 condenser](https://github.com/OpenHands/OpenHands/tree/0.59.0/openhands/memory/condenser/impl) ·
[sqlite-vec](https://github.com/asg017/sqlite-vec) ·
[better-sqlite3 编译选项](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/compilation.md) ·
[Claude Code memory](https://code.claude.com/docs/en/memory) ·
[Claude Code sessions](https://code.claude.com/docs/en/sessions) ·
[Codex app-server](https://github.com/openai/codex) ·
[A2A 规范](https://a2a-protocol.org/latest/specification/)

## 3. TencentDB-Agent-Memory 评估

来源：https://github.com/TencentCloud/TencentDB-Agent-Memory （README、`MemoryCore/package.json`、`MemoryCore/tdai-gateway.standalone.yaml`）

| 项 | 内容 |
|---|---|
| 解决的问题 | 团队级的 Agent 记忆中枢：把对话、文档、代码沉淀成 Chat Memory、Skill、LLM-Wiki、CodeGraph 四类资产，由 Memory Hub 负责权限和共享 |
| 分层 | L0 原始对话 → L1 原子事实 → L2 场景块 → L3 画像，由异步 LLM 管道逐层提炼 |
| 检索 | 先用 L2/L3 快速定位；需要具体细节时用 BM25 + 向量 + RRF 回查 L1/L0；按条数、字符预算和超时截断 |
| 接入方式 | MemoryProxy：Agent 把模型 base URL 指向它（支持 anthropic / openai-chat / openai-responses 协议），由它在请求里注入记忆 |
| 运行时 | TypeScript，Node ≥22.16；standalone 模式默认用 SQLite + sqlite-vec（0.1.7-alpha），监听 127.0.0.1:8420，不依赖腾讯云；TCVDB、MongoDB、Redis、Kafka 等是可选依赖 |
| 许可证 / 状态 | MIT；仓库 2026-04 创建，API 读数约 3 万 star，open issue 约 900，默认分支是 `feat/server_team`，仍是 beta |

对本项目的判断：

- 不进 Gateway 核心，原因有三：
  - 形态冲突：Proxy 要接管模型请求的 base URL。这和订阅登录（OAuth）方式能否共存待验证；即使能共存，也绕开了 ACP 这条链路。
  - 偏重：需要多个服务，记忆提炼还要额外的 LLM 和 embedding 费用。
  - 不稳定：beta、默认分支是功能分支、API 变动风险高。
- 可借鉴的设计：
  - L0–L3 分层，对应我们的事件 → 任务账本 → 项目记忆。
  - 混合检索加 RRF 融合。
  - 注入时同时设预算和超时。
- 预留位置：项目级长期记忆层的 `MemoryProvider` 插件。以后可以写一个适配器，调用它的本地 HTTP 服务做检索，而不是用 Proxy 方式（它的检索接口细节待验证）。

## 4. ACP 与适配器现状（修正 v0.2）

来源：[ACP 仓库 schema/v1/meta.json](https://github.com/agentclientprotocol/agent-client-protocol)（v1.15.1，2026-11-02）· [TS SDK](https://registry.npmjs.org/@agentclientprotocol/sdk)

| 类别 | 稳定 | 仅 unstable |
|---|---|---|
| 会话 | `session/new` `load` `list` `resume` `close` `delete` `prompt` `cancel` | `session/fork` `archive` `set_title` |
| 模式 / 模型 | `session/set_mode`；`session/set_config_option`（model 类别） | `setSessionModel`（旧方法，部分适配器仍实现） |
| Client 端 | `session/request_permission`、`fs/*`、`terminal/*`、`elicitation/*` | MCP-over-ACP |
| `session/update` 类型 | 消息 / 思考分块、tool_call、plan、available_commands、current_mode、config_option、usage_update、compaction_update、compaction_summary_chunk | plan_update、subagent_update |

| Agent | 适配器（npm） | 已确认能力 |
|---|---|---|
| Claude Code | `@agentclientprotocol/claude-agent-acp` 0.100.0（`@zed-industries/claude-code-acp` 已废弃） | loadSession、list/resume/fork/close、set_mode、set_config_option |
| Codex | `@agentclientprotocol/codex-acp` 2.5.0（内置 `@openai/codex`，可用 `CODEX_PATH` 指定本机 codex；`zed-industries/codex-acp` 已归档） | loadSession、list/resume/fork/close/delete、set_mode、set_config_option |
| CodeBuddy | 原生 `--acp`（[官方文档](https://www.codebuddy.ai/docs/cli/acp)） | 文档提到 loadSession 和 `_codebuddy.ai/*` 私有扩展；其余待验证 |
| OpenCode / Gemini CLI | `opencode acp` / `gemini --acp` | 可作为后续接入对象 |

AGENTS.md 读取规则（影响 v0.2 第 7.4 节）：

- Codex：从仓库根到 cwd 逐级读取，越近的文件优先级越高，总上限默认 32 KiB（[文档](https://developers.openai.com/codex/guides/agents-md)）。
- Claude Code：v2.1.277 起，只有在不存在 CLAUDE.md 时才读 AGENTS.md，或者需要在 CLAUDE.md 里写 `@AGENTS.md` 导入（[文档](https://code.claude.com/docs/en/memory)）。

所以"写 AGENTS.md 就能被所有 Agent 读到"这个假设不成立。

## 5. 同类产品

| 产品 | 上下文 / 切换 | 隔离 | 审批 |
|---|---|---|---|
| [vibe-kanban](https://github.com/BloopAI/vibe-kanban)（已宣布停止维护） | 同一 workspace 的多个会话共享文件，但不共享对话 | worktree | 按 Agent Profile 设审批级别；可在 diff 上写行内评论回传给 Agent |
| [Conductor](https://www.conductor.build/docs/concepts/git-worktrees) | 交接笔记放在 gitignored 的 `.context` 目录 | worktree；gitignored 文件按复制规则补进去，并配置 setup 脚本 | 依赖 Agent 自身的审批 |
| [Claude Squad](https://github.com/smtg-ai/claude-squad) | 每个 Agent 一个 tmux 会话 | worktree | `-y` 自动同意 |
| [Crystal → Nimbalyst](https://github.com/stravu/crystal) | — | worktree | — |
| [OpenCode](https://opencode.ai/docs/config/) | 多 provider，`/models` 切换；compaction 可配置（自动、修剪、预留） | `/undo` 基于 git | edit/bash 可分别设 ask/allow/deny，支持命令匹配 |
| [Cline](https://docs.cline.bot/features/checkpoints) | `/newtask` 把计划、进度、文件、下一步打包成交接包；`/smol` 原地压缩；Memory Bank 是一组 md 文件 | 影子 git checkpoint，大仓库会变慢 | Plan 模式只读；Plan 和 Act 可用不同模型 |
| [Roo Code](https://docs.roocode.com/features/boomerang-tasks) | Orchestrator 拆子任务，子任务只把摘要返回给父任务；压缩阈值和提示词可配置 | 影子 git，含二进制文件 | 按模式区分 |
| [Aider](https://aider.chat/docs/repomap.html) | repo map（tree-sitter + 图排序，默认 1k token）；`/model` 切换；architect + editor 双模型 | git 提交 | — |
| [Zed](https://zed.dev/docs/ai/external-agents) | 外部 Agent 走 ACP，从 ACP Registry 安装；可导入外部 Agent 的历史会话并续聊 | — | 由 ACP 的 request_permission 驱动 |
| [claude-code-router](https://github.com/musistudio/claude-code-router) | 本地模型网关，按规则路由，支持回退链 | — | — |
| [LiteLLM](https://github.com/BerriAI/litellm) | 统一 100 多种模型接口的代理，提供虚拟 key 和花费统计 | — | — |
| [Sculptor](https://github.com/imbue-ai/sculptor) / [Agent Deck](https://github.com/asheshgoplani/agent-deck) | 同一 workspace 可放多个 Agent；支持会话 fork | worktree / Docker | Agent Deck：Agent 忙时消息排队 |
| [Crush](https://github.com/charmbracelet/crush) | 会话中途换模型并保留上下文 | — | — |

共性：

- 隔离：主流是 worktree。worktree 不带 gitignored 文件，要靠复制规则或 setup 脚本补。
- 跨 Agent：都靠文件加摘要，没有一家做通用的会话格式转换。
- 大文件资产：没有一家专门处理美术等大二进制资产，需要我们自己设计（见 design.md 第 11 节）。

## 6. 上下文迁移策略对比

| 策略 | 同 Agent 换模型 | 跨 Agent | 保真度 | 成本 | 风险 |
|---|---|---|---|---|---|
| 协议内切换（set_config_option） | 首选 | 不适用 | 完整 | 无 | 新模型上下文窗口更小时，会触发 Agent 自己的压缩 |
| 原生 resume / load | 次选（换账号、进程重启） | 不适用 | 完整 | 无 | 会话存储可能随账号或版本隔离 |
| 交接摘要（LLM） | 兜底 | 主力 | 中 | 一次 LLM 调用 | 摘要漏掉细节或产生幻觉 |
| 事件回放（把原文作为首条消息） | 不需要 | 仅小会话 | 高 | token 多 | 超出窗口；新 Agent 会误以为工具调用已经执行过 |
| 结构化记忆（事实 / 决策 / 文件索引） | 辅助 | 主力 | 中高，可核对 | 可以确定性提取，便宜 | 需要维护，过期事实要标记失效 |
| 检索增强（FTS5 / 向量） | 不需要 | 按需补充细节 | 视命中情况 | 低 | 召回噪声 |
| 共享工作区文件（代码 + 任务文件） | 天然 | 天然 | 代码层面完整 | 无 | 各 Agent 读取规则不同（见第 4 节） |

## 7. 对本项目的推荐

1. 能力分级切换：
   - 会话内 `set_config_option` → `session/resume` / `load` → 交接包。
   - 能力以 ACP `initialize` 握手和 `configOptions` 的实际返回为准，界面如实显示走的是哪一级。
2. 交接包 = 确定性部分 + 叙述部分：
   - 确定性部分从事件和 git 提取：改动文件、执行过的命令及结果、审批记录、计划。
   - 叙述部分由 LLM 生成：决策原因、未决问题、下一步。
   - 小会话可以直接附上"观察遮蔽后的原文"（工具输出折叠成一行）。
   - 整体按目标模型的上下文窗口设预算。
3. 任务文件不改用户已跟踪的文件：
   - 写到工作区里的 `.aic/TASK.md` 和 `.aic/HANDOFF.md`，并加入 git exclude。
   - 每次会话的首条消息用 ACP `resource_link` 或嵌入资源引用它们。
   - 不再依赖各 Agent 是否会自动读取 AGENTS.md。
4. 项目记忆：任务合并时提取事实和决策，存 SQLite + FTS5，用户可在界面里查看和编辑；向量检索作为可选项。mem0 和 TencentDB-Agent-Memory 作为 `MemoryProvider` 插件预留。
5. 压缩：Agent 内部的压缩交给 Agent 自己，通过 ACP 的 `compaction_update` 和 `usage_update` 记录和显示。Gateway 只在生成交接包和显示上下文用量时，用 OpenHands 式的墓碑事件做视图压缩。
