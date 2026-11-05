# 调研：自动交接（切换模型 / Agent 时不需要人工检查）

> 2026-11-06 · 补充 `context.md`（那里已有的 ACP 能力表、Cline/Roo/Aider 基本情况不再重复）
> 开源项目均读过 GitHub 源码；闭源产品只能看官方文档和论坛，标"推断"的是根据文档行为推出来的。

## 1. 结论先行

1. 同一工具内换模型，主流做法是完整历史转写，不做摘要。Zed、Cline、Roo Code、Kilo Code / OpenCode、Continue、Aider 的源码都确认了这一点：历史以内部中立格式保存，每次请求时按目标厂商的格式转换工具调用。思考内容跨厂商时一律丢弃或降级成纯文本，因为签名和加密内容不能跨厂商使用。
2. 跨 Agent（跨进程、跨 harness）时，没有一家能把原生的工具调用消息注入另一个 Agent。能做到的上限是：把历史渲染成"引用文本"，放进新会话的首条消息。Google ADK 的写法是 `For context: [agent] said …`，mem0 OpenMemory 的 PortableSession 只带文本轮次。ACP 也没有导入会话的原语（未查到相关 RFD），只能用 `session/new` 加首条 prompt（可带嵌入资源）。
3. "不需要人检查"在业界靠的不是更好的摘要，而是三件事：
   - 关键事实不经过 LLM，原样保留。Codex 保留用户消息原文（20k token），Claude Code 摘要里有 All user messages 一节，并在压缩后重读最近的文件，Goose 要求报错逐字引用。
   - 用 schema 强制摘要结构。OpenHands 通过 function-calling 强制 18 个字段，Goose 输出 JSON 且字段为空就省略、不许编造。
   - 让新 Agent 可以回查原始记录，同时保留工作区检查点，出错可以回退。Factory 的评测显示，所有压缩方法在"记得动过哪些文件"上得分都最低（2.19~2.45/5），这一项必须由确定性数据补齐。
4. 推荐方案（第 6 节）：
   - 交接分 4 级，默认全自动。
   - 摘要平时增量维护，切换时只做补齐。
   - 发送前做确定性覆盖校验和探针问答，未通过就自动修补或升级到更高一级。
   - 新 Agent 可以通过 MCP 工具查询旧会话。
   - 只有 4 类情况才打扰用户。
   - 事后在交接分隔条上查看，一键切回原会话并恢复检查点。

## 2. 各产品的实际做法

### 2.1 会话内换模型（同一工具）

| 产品 | 做法 | 工具调用 | 思考内容 | 来源 |
|---|---|---|---|---|
| Zed Agent | 完整历史转写（源码） | 内部 ToolUse/ToolResult → OpenAI `tool_calls` / `role=tool`，或 Anthropic `tool_use` / `tool_result` | 发给 Anthropic：只保留带签名的非空 thinking；发给 OpenAI Chat：放进 `reasoning_content`，模型不支持时当普通文本；Responses 路径丢弃 | [anthropic](https://github.com/zed-industries/zed/blob/main/crates/anthropic/src/completion.rs) · [open_ai](https://github.com/zed-industries/zed/blob/main/crates/open_ai/src/completion.rs) |
| Cline | 历史存为 Anthropic 格式，完整转写（源码） | `openai-format.ts` 负责互转 | 旧版 OpenAI 路径没有 thinking 分支，相当于丢弃 | [openai-format.ts](https://github.com/cline/cline/blob/v3.30.0/src/core/api/transform/openai-format.ts) |
| Roo Code | 完整转写；压缩时先给孤立的 tool_call 补一个合成的 tool_result，再把工具块转成文本交给摘要模型；旧消息只打 `condenseParent` 标签，不删除 | 同上，另处理 OpenRouter `reasoning_details` | 按 index / type 合并 `reasoning_details` | [condense](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/condense/index.ts) |
| Kilo Code / OpenCode | 完整转写，规则最明确（源码） | provider/model 变化时去掉 `callProviderMetadata`，按目标厂商规则清洗 toolCallId | 模型变化时：reasoning 转纯文本，空的丢弃，签名和加密内容不带过去；模型不变时原样保留 | [message-v2.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/session/message-v2.ts) · [transform.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/provider/transform.ts) |
| Continue | 内部统一 ChatMessage，思考单独存成 `role=thinking`（源码推断为整段转写） | 一个 tool 消息对应一个 `tool_result` | Anthropic 路径剥掉无签名的 thinking；OpenAI 路径转成 `reasoning_content` | [openaiTypeConverters.ts](https://github.com/continuedev/continue/blob/main/core/llm/openaiTypeConverters.ts) |
| Aider | `/model` 后新 Coder 继承 `done_messages` 和 `cur_messages`；只有 edit_format 变化时才做摘要 | 历史是纯文本，不涉及 | 不涉及 | [base_coder.py](https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py) |
| Cursor | 官方答复：同一个 chat 里换模型，新模型能看到之前的上下文；部分版本禁止换，绕法是 Fork Chat 后换 | 未查到 | 未查到 | [论坛 1](https://forum.cursor.com/t/if-i-change-a-model-will-the-new-model-know-the-previous-context/43939) · [论坛 2](https://forum.cursor.com/t/switching-models-is-unavailable-in-this-conversation-start-a-new-conversation-to-use-a-different-model/157132) |
| Copilot Chat | 换模型保留完整上下文（文档）；压缩时摘要较旧的部分，保留近期原文 | 未查到 | 压缩后，把被摘要部分最后一个 thinking 接到摘要后的第一轮 | [文档](https://docs.github.com/en/copilot/using-github-copilot/ai-models/changing-the-ai-model-for-copilot-chat) · [源码](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/extension/prompts/node/agent/summarizedConversationHistory.tsx) |
| Warp | `/model` 中途切换，文档提示换模型会让缓存失效（推断为带完整历史）；另有 `/fork-and-compact` | 未查到 | 未查到 | [文档](https://docs.warp.dev/guides/configuration/how-to-use-tokens-efficiently-with-ai-coding-agents/) |
| Windsurf | 下拉框切换，Adaptive 模式自动选模型 | 未查到 | 未查到 | [文档](https://docs.windsurf.com/windsurf/adaptive) |
| Vercel AI SDK / LiteLLM / OpenRouter | 中间层的规则：reasoning 元数据按厂商命名空间存放，非本厂商的签名一律跳过；OpenRouter 用 `reasoning_details` 原样回传（含 `format` 字段，例如 `anthropic-claude-v1`） | — | 签名只能在同厂商内回传 | [ai-sdk](https://github.com/vercel/ai/blob/main/packages/anthropic/src/convert-to-anthropic-prompt.ts) · [LiteLLM](https://docs.litellm.ai/docs/reasoning_content) · [OpenRouter](https://openrouter.ai/docs/use-cases/reasoning-tokens) |

### 2.2 跨 Agent / 子任务 / 压缩

| 产品 | 交接内容 | 来源 |
|---|---|---|
| vibe-kanban | 同一 session 内换 executor 会被后端拒绝（`ExecutorMismatch`）；换 Agent 只能新开 session，不转交 transcript，只共享 worktree | [follow_up.rs](https://github.com/BloopAI/vibe-kanban/blob/main/crates/executors/src/actions/coding_agent_follow_up.rs) |
| Conductor | 建议把交接笔记放在 gitignored 的 `.context`；没有自动生成 | [文档](https://docs.conductor.build/tips/workspaces-and-branches) |
| Claude Squad / Crystal / Sculptor | 只做 worktree / tmux 隔离；跨 Agent 交接未查到 | [claude-squad](https://github.com/smtg-ai/claude-squad) |
| Agent Deck | fork 继承完整历史（仅 Claude）；换账号的流程是复制会话文件、备份、校验大小，再 `--resume` | [README](https://github.com/asheshgoplani/agent-deck/blob/main/README.md) |
| Zed 外部 Agent | 只能导入同一个 Agent 自己的历史会话；A 的线程不能交给 B，官方讨论确认各会话完全隔离 | [文档](https://zed.dev/docs/ai/external-agents) · [#62933](https://github.com/zed-industries/zed/discussions/62933) |
| mem0 OpenMemory | `openmemory port --from --to`，中间格式 PortableSession：`turns[{role,text,model}]`、`droppedTurns`，以 `sourceSessionId` 作幂等键；v1 不带工具块和 thinking | [ir.ts](https://github.com/mem0ai/openmemory/blob/main/cli/src/ir.ts) |
| Roo Orchestrator | 父任务调 `new_task(mode, message, todos)`，子任务只拿到 message；子任务用 `attempt_completion(result)` 结束，结果以 tool_result 形式回到父任务 | [new_task.ts](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/prompts/tools/native-tools/new_task.ts) |
| Claude Code subagent | 非 fork 的子 Agent 从空上下文开始，只拿到 prompt 字符串，只返回最终消息；fork 型复制父对话 | [subagents](https://code.claude.com/docs/en/agent-sdk/subagents) |
| Claude Code `/compact` | 先写 `<analysis>` 自查，再输出 9 节摘要；压缩后清空文件缓存，重新注入最近读过的文件、plan 和 skills；另有不调 LLM 的 microcompact，只清理旧工具结果 | [提取的提示词](https://gist.github.com/sxalexander/8915f30f8bc97a272620a1a6c67a7148) · [反混淆](https://gist.github.com/sam-saffron-jarvis/9d8e291c4e696ac7948702d6c4884448) |
| Codex `/compact` | 提示词是 "Create a handoff summary for another LLM that will resume the task"；摘要加前缀 "Another language model started to solve this problem…"；保留用户消息原文，上限 20k；远程压缩返回加密的 compaction item，并重新注入 AGENTS.md | [prompt.md](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/compact/prompt.md) · [compact.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs) · [compaction API](https://developers.openai.com/api/docs/guides/compaction) |
| OpenHands | StructuredSummaryCondenser 用 function-calling 强制 18 个字段；新 SDK 的摘要分段要求保留任务 ID | [structured](https://raw.githubusercontent.com/OpenHands/OpenHands/0.59.0/openhands/memory/condenser/impl/structured_summary_condenser.py) · [summarizing_system.j2](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/context/condenser/prompts/summarizing_system.j2) |
| Goose | token 用量到 80% 自动 compact；先写 `<analysis>`（丢弃），再输出 JSON；报错逐字引用，字段为空就省略；subagent 继承 extensions | [compaction.md](https://github.com/aaif-goose/goose/blob/main/crates/goose-context-management/src/prompts/compaction.md) |

### 2.3 框架与协议

| 框架 / 协议 | 交接机制 | 来源 |
|---|---|---|
| OpenAI Agents SDK | 默认把完整历史交给下一个 Agent；`input_filter` 可裁剪（如 `remove_all_tools`）；beta 选项 `nest_handoff_history` 把历史折叠成一条 `<CONVERSATION HISTORY>` 摘要消息；`input_type` 是交接参数的 schema（reason、summary 等） | [handoffs](https://openai.github.io/openai-agents-python/handoffs/) |
| LangGraph | 用 `Command(goto, update)` 交接；supervisor 的 `output_mode` 可选 `full_history` 或 `last_message`（默认后者）；swarm 共享同一份 messages；`content_blocks` 把各厂商的消息统一成标准块（含 reasoning） | [supervisor.py](https://github.com/langchain-ai/langgraph-supervisor-py/blob/main/langgraph_supervisor/supervisor.py) · [messages](https://docs.langchain.com/oss/python/langchain/messages) |
| AutoGen / AG2 | `HandoffMessage.context: List[LLMMessage]` 携带上下文；AG2 用 `context_variables` 作共享状态 | [messages.py](https://github.com/microsoft/autogen/blob/main/python/packages/autogen-agentchat/src/autogen_agentchat/messages.py) |
| CrewAI | 委托工具 `(task, context, coworker)`，提示词要求 "share absolute everything you know" | [collaboration](https://docs.crewai.com/en/concepts/collaboration) |
| Google ADK | 其他 Agent 的事件改写成 user 消息：`For context: [agent] said:`、`[agent] called tool …`，并经过不可信内容转义；`include_contents='none'` 表示不带历史；事件压缩可以按轮次（带重叠）或按 token 触发 | [_fencing.py](https://github.com/google/adk-python/blob/main/src/google/adk/flows/llm_flows/context/_fencing.py) · [compaction](https://adk.dev/context/compaction/) |
| A2A | `contextId` 把多个 Task 归到同一会话，`referenceTaskIds` 引用相关任务；规范只规定查询历史，没规定向另一个 Agent 注入外来历史 | [规范](https://a2a-protocol.org/latest/specification/) |
| ACP | `session/load` 要求 Agent 回放完整会话（以 `session/update` 流出）；有 fork、resume、compaction 的 RFD；首条 prompt 可以带 `resource`（需要 `embeddedContext` 能力）或 `resource_link`；`session/new` 可以传 `mcpServers`；跨 Agent 导入会话的 RFD 未查到 | [session-setup](https://agentclientprotocol.com/protocol/session-setup) · [content](https://agentclientprotocol.com/protocol/content) · [RFDs](https://github.com/agentclientprotocol/agent-client-protocol/tree/main/docs/rfds) |

## 3. 交接策略比较

| 策略 | 代表 | 保真度 | token 成本 | 实现难度 | 出错能否自动发现 |
|---|---|---|---|---|---|
| 完整历史转写（原生消息格式） | Zed、Cline、OpenCode 同进程换模型 | 最高（思考除外） | 最高，且换厂商后缓存失效 | 中：工具 ID 清洗、孤立工具调用补齐、思考降级 | 能：格式错误会直接收到 API 400 |
| 完整历史转写（引用文本） | ADK、OpenMemory | 高：信息不丢，但工具调用变成了"别人说过的话" | 高 | 低 | 部分能：可以数轮次和丢弃项；新 Agent 误读则发现不了 |
| 自动压缩摘要（自由文本） | Codex、Aider | 中，文件轨迹最弱 | 低，一次 LLM 调用 | 低 | 不能，除非额外做探针 |
| 结构化摘要（schema） | OpenHands、Goose、Claude Code 9 节 | 中高 | 低 | 中 | 能查结构：缺字段、空字段一目了然 |
| 增量锚定摘要 | Factory | 中高，多轮压缩不漂移 | 摊到每一轮，切换时近乎零 | 中 | 能：可以对每段做差异校验 |
| 结构化状态对象（确定性提取） | OpenHands TASK_TRACKING、AG2 context_variables、本项目 L1 | 对事实保真，对"为什么"弱 | 很低 | 中 | 能：和 git / 事件库直接比对 |
| 事件回放 | ACP `session/load`、OpenHands View | 最高 | 高 | 低（只适用同 Agent） | 能 |
| 按需检索（新 Agent 用工具查旧记录） | Anthropic 结构化笔记、本项目 `.aic/*.md` | 视查询而定 | 按需付费 | 中：需要一个 MCP 服务 | 能：可以记录 Agent 是否查过、查了什么 |
| 共享工作区 + 任务文件 | Conductor、vibe-kanban、Anthropic 长任务 harness（progress 文件 + git log） | 代码层面完整 | 无 | 低 | 能：对比 git 和检查点 |

另外两条数据：

- JetBrains 在 SWE-bench Verified 上的实测：观察遮蔽（把旧工具输出折叠掉）成本减半，解决率与 LLM 摘要持平（[arXiv 2508.21433](https://arxiv.org/abs/2508.21433)）。
- Factory 的探针评测总分：Factory 4.04，Anthropic 3.74，OpenAI 3.43（[factory.com](https://factory.com/news/evaluating-compression)）。

## 4. 重点问题

### 4.1 有没有跨模型 / 跨 Agent 直接转写完整历史的？

- 跨模型（同一工具内）：有，而且是主流，见 2.1 表。转换要点：
  - 工具调用：先存成中立格式，再按目标厂商转换。需要清洗 toolCallId（不同厂商的字符集和长度限制不同），给孤立的 tool_call 补合成结果（Roo），去掉原厂商的私有元数据（OpenCode）。
  - 思考内容：Anthropic 的 signature 和 OpenAI 的 encrypted reasoning 都只能回传给同一厂商。跨厂商时有三种处理：丢弃（Zed Responses 路径、Vercel AI SDK）；降级为纯文本（OpenCode / Kilo）；只保留同厂商带签名的（Continue、Zed Anthropic 路径）。
- 跨 Agent：没有找到原生转写的产品，最多做到引用文本（ADK、OpenMemory）。原因是 ACP 和各 CLI 都不接受外部注入的 assistant 或 tool 消息，只接受用户 prompt。所以本项目的"完整历史"只能是文本形式的转写，做不到原生消息格式。

### 4.2 不让用户检查，怎么保证质量？

| 手段 | 谁在用 | 本项目可否用 |
|---|---|---|
| 关键事实不经过 LLM：用户消息原文、报错原文、文件列表 | Codex、Claude Code、Goose | 直接用：来自事件库和 git |
| schema 强制，字段为空就省略、不许编造 | OpenHands、Goose | 直接用 |
| 先写 `<analysis>` 再输出；next step 要引用用户原话 | Claude Code、Goose | 直接用 |
| 增量锚定：每轮只摘要新增部分，再合并进持久摘要 | Factory | 直接用：本项目 L1 已经是增量更新的 |
| 探针问答 + 评委打分（recall / artifact / continuation / decision 四类） | Factory，离线评测用 | 改成在线轻量版：探针从事件库确定性生成，答案已知，不需要 LLM 评委 |
| 压缩后重读最近的文件 | Claude Code | 用：交接包列出文件，并要求先读再改 |
| 外部持久状态 + 可执行验证（progress 文件、git log、init.sh、端到端测试） | Anthropic 长任务 harness（[文章](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)） | 用：`.aic/` 文件，交接后跑一次项目自带的检查命令 |
| 让新 Agent 复述理解 | 未查到有产品默认这样做 | 可选：放在首轮内部，不展示给用户（见 6.3） |
| 交接后自动对比工作区状态 | 未查到产品实现；Agent Deck 换账号时校验会话文件大小 | 用：检查点对比 + 行为守卫 |

### 4.3 交接内容该放什么（各家摘要模板取并集）

| 内容 | 出现在 | 本项目现状 |
|---|---|---|
| 原始需求与意图 | Claude Code、Roo、Goose、OpenCode、Cline | 有（目标与约束） |
| 所有用户消息原文 / 用户纠正 | Claude Code（All user messages）、Codex（保留用户消息原文）、Goose | 缺：只有"最近对话" |
| 报错和修复，失败的尝试和原因 | Claude Code、Roo、Goose（逐字引用） | 部分：只有失败命令，没有"试过什么、为什么不行" |
| 文件和关键代码片段（读过的、改过的） | 所有模板；Cline SDK 区分 Read 和 Edited | 只有改过的，缺读过的和关键片段 |
| 任务追踪（保留任务 ID：已完成 / 进行中 / 阻塞） | OpenHands、OpenCode、Cline SDK | 有计划快照，没有分状态 |
| 版本控制状态（分支、提交、未提交的改动、PR） | OpenHands、OpenCode（"保留提交/推送状态"） | 缺 |
| 测试状态（写了哪些、哪些在失败） | OpenHands | 缺 |
| 依赖和环境变化 | OpenHands（dependencies） | 缺 |
| 技术概念、决策及原因 | 所有模板 | 有 |
| 当前进行中的工作 + 下一步（引用用户原话） | Claude Code、Codex | 有，但没有要求引用原话 |
| 精确的路径、命令、错误串；不要提及压缩本身 | OpenCode 规则 | 缺 |

## 5. 对现有设计的判断

- 7.4 第 3 种情况里"向用户展示 pkg 并确认"是用户反馈的直接来源，应该改为默认不弹窗（见 6.4）。
- 7.5 的 8 段内容偏"最近发生了什么"，缺 4.3 表里标"缺"的 6 项。其中 5 项能确定性生成（用户消息原文、读过的文件、VCS 状态、测试状态、环境），不需要多花 LLM 费用。
- 7.5 的"小会话直接回放"方向对，但门槛（预算的 60%）太保守。业界同工具换模型默认就是全量。建议改成按目标窗口计算门槛（见 6.1 的 H2）。
- 交接时才调 LLM 生成叙述，会让切换变慢，也来不及校验。建议改成平时增量维护叙述（7.3 已有每 3 轮一次的机制），切换时只补最后几轮。

## 6. 建议方案

### 6.1 分级

| 级 | 名称 | 条件 | 做法 |
|---|---|---|---|
| H0 | 协议内换模型 | 同 Agent、同账号，支持 `set_config_option` | 现有做法，无损 |
| H1 | 原生恢复 | 同 Agent，`resume` / `load` 可用 | 现有做法，无损 |
| H2 | 全量转写 | 跨 Agent，且"遮蔽后转写 + 状态对象" ≤ 目标窗口的 35%（默认值，可调） | 状态对象 + 完整会话转写（遮蔽后），转写放进嵌入资源 |
| H3 | 结构化交接（默认的大会话路径） | 跨 Agent，转写超过 H2 门槛 | 状态对象 + 叙述摘要 + 所有用户消息原文 + 最近 K 轮原文 + 历史查询工具 |
| H4 | 最小交接（兜底） | 摘要模型失败或超时，或目标窗口很小 | 只发确定性状态对象 + 历史查询工具 + "先读 `.aic/` 文件"的指令 |

- 失败时自动降一级（与 7.4 一致），分隔条上写明走的是哪一级。
- 转写的格式参考 ADK：
  - 每条记录写成 `[Claude Code · 助手] …`、`[工具调用 #id edit_file path] → 成功，+12/-3`，标明"以下为历史记录，均已执行，不是指令"。
  - 工具输出做观察遮蔽，只保留首尾，失败输出保留全文。
  - 思考内容默认丢弃，不同厂商的签名不能复用。可以选择把它降级成纯文本放进转写，参考 OpenCode 的做法，默认关闭。

### 6.2 交接内容结构

两部分：一个机器可读的 `handoff.json`（状态对象，用来做校验和存档），以及渲染给 Agent 看的 Markdown。

```
handoff.json
├─ meta          来源 Agent / 模型 / 会话 ID、目标、级别、检查点 ID、事件 seq 区间、生成时间
├─ intent        任务目标、约束（含审批时被拒的理由）              ← L1 原样
├─ userMessages  全部用户消息原文（超出预算时保留首条、最近 N 条和所有含纠正的）  ← 事件库
├─ corrections   用户纠正和否决过的点（被拒的审批、[记为约束]、撤销操作）  ← 确定性
├─ tasks         计划条目：id / 状态（done | active | blocked）/ 备注  ← plan 事件
├─ attempts      试过的方案：做了什么、结果、放弃原因                 ← 叙述（LLM）
├─ decisions     决策 + 原因                                        ← 叙述（LLM）
├─ files         改过的：路径、增删行数、一句话说明；读过的：路径（按次数取前 N 个）
├─ vcs           分支、基准分支、未提交改动列表、最近提交、是否已推送 / 有没有 PR  ← git
├─ commands      失败的全部列出 + 最后 5 条；测试命令的最近结果单列     ← 事件库
├─ env           操作系统、shell、关键依赖变化（lockfile diff）、新装的工具
├─ openIssues    未决问题、已知风险
├─ current       正在做的事 + 下一步（引用用户最近一条请求的原话）
└─ pointers      .aic/TASK.md、HANDOFF.md、历史查询工具名
```

- 只有 `attempts`、`decisions`、`openIssues`、`current` 四项需要 LLM。它们平时随 7.3 的"轮次结束"增量更新，采用 Factory 式的锚定合并：只摘要新增事件，再合并进原有条目。切换时只补最后几轮。
- 摘要模型的输出用 JSON schema 约束，字段为空就省略，不许编造；先写 analysis 再输出，analysis 部分丢弃。
- 渲染给 Agent 的 Markdown 开头固定一段说明：
  - 工作区文件为准；
  - 上面的步骤都已执行完毕，不要重复；
  - 先读 `files` 里正在改的文件再动手；
  - 不确定的地方先调用 `aic_history` 查询。

### 6.3 自动质量保证（全部在后台完成，不弹窗）

| 步骤 | 时机 | 做法 | 未通过时 |
|---|---|---|---|
| ① 覆盖校验（确定性） | 发送前 | git diff 里的每个文件、每条失败命令、每条纠正和约束、每个未完成的计划 ID，都必须出现在交接内容里 | 自动从事件库补齐，不调 LLM |
| ② 一致性校验 | 发送前 | 叙述字段里出现的路径、命令、函数名都要能在事件库或工作区找到；"已完成"的任务不能和失败的测试冲突 | 删掉找不到依据的句子，或标"待确认"；冲突项写进 openIssues |
| ③ 探针问答（可关） | 发送前，H3 才做 | 从事件库确定性生成 5~8 个答案已知的问题（改了哪些文件、最近一个失败的报错、用户否决过什么、下一步是什么），让便宜模型只凭交接包回答，再用字符串或集合比对打分 | 低于阈值：先把答错的事实补进交接包；仍然不过就升到 H2（窗口允许时），或附上相关原文片段 |
| ④ 新 Agent 复述（可关，默认开） | 首轮 | 首条消息要求新 Agent 先输出一段很短的确认：目标、下一步、它准备先读的文件，然后直接开始干活，不用停下等待 | 和 `current` / `files` 比对；明显偏离时，Gateway 自动追加一条更正消息；复述内容折叠显示 |
| ⑤ 历史查询工具 | 整个新会话期间 | `session/new` 时通过 `mcpServers` 挂上 Gateway 自带的 `aic_history` MCP：`search(query)`、`get_events(seq 区间)`、`get_file_at(checkpoint, path)`、`list_decisions()` | 记录调用次数和命中率，用来调整下一次交接的预算分配 |
| ⑥ 行为守卫 | 新会话的前 N 个工具调用 | 发现以下情况就告警：重新执行已成功的命令、改回 `tasks.done` 涉及的改动、修改 `corrections` 里明确禁止碰的文件 | 记一条告警；破坏性的操作走现有审批（第 9 节） |
| ⑦ 离线回归 | 开发期 | 用历史任务回放 ③，比较不同预算和级别下的得分，校准 7.6 的份额 | — |

### 6.4 什么情况下打扰用户

只有以下 4 种情况：

1. 切换时当前 Agent 正在执行，或者有未决的审批（沿用 7.4 的询问）。
2. 自动修补和升级之后，③ 仍然不及格，并且目标窗口连 H4 加关键原文都放不下。提示用户：换大窗口的模型、精简任务，或者仍然继续。
3. 内容要发给另一家厂商时，命中了敏感信息规则（密钥、`.env` 内容等）。被命中的内容自动打码，第一次遇到时询问用户，之后按设置处理。
4. ⑥ 检测到破坏性操作。这一项走现有审批，不是交接专属的打扰。

另外在设置里提供一个"交接前让我确认"的开关，默认关闭，给需要的用户保留现在的弹窗流程。

### 6.5 事后查看与撤销

- 查看位置：
  - 对话流里的交接分隔条（`ui-design.md` 6.8）显示：级别（H2/H3…）、质量分（探针通过数）、自动补齐了几项、新 Agent 的复述，以及 [查看交接内容]，点开是渲染后的 Markdown 和 json 的 diff 视图。
  - 右侧"上下文"面板保留每次交接的历史记录。
  - 文件位置：`.aic/handoffs/<seq>.json` 和对应的 `.md`。
- 撤销方式：
  - [切回原会话]：原会话不删除（7.4 已有），走 H0 / H1 原生恢复，可以选择把工作区恢复到交接时的检查点。
  - [重新交接]：换一个级别（例如强制 H2），或者编辑交接内容后，重新开一个新会话。
  - 用户事后修改的交接内容会写回 L1。如果是纠正，记为 `corrections`，下次交接自动带上。
