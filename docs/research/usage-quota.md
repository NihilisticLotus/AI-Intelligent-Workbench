# 用量、上下文分类与订阅额度

日期：2026-11-12。状态：阶段 1 期间的离线初稿；阶段 8 补齐资料核查，阶段 9 追加真实结果。范围和授权边界见 [phase-1 第 10 节](../plans/phase-1.md)。

## 固定版本与核查方法

仅静态阅读项目依赖中的公开代码与类型，没有启动真实 Agent，没有读取第三方用户配置或凭据。以下路径均相对仓库根目录；依赖由 package-lock.json 固定。

| 对象 | 固定版本 | 已读来源 |
|---|---|---|
| ACP SDK | 2.4.0 | `node_modules/@agentclientprotocol/sdk/dist/v1/unstable/schema/types.gen.d.ts` 的 Usage、UsageUpdate |
| Claude ACP | 0.100.0 | `node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js` 的 resetTurnScratch、sessionUsage、turnOutcome、rate_limit_event |
| Codex ACP | 2.5.0 | `node_modules/@agentclientprotocol/codex-acp/dist/index.js` 的 beginPromptTokenUsage、buildPromptUsage、toPromptUsage、handleRateLimitsUpdated |
| CodeBuddy | 2.181.0 | `node_modules/@tencent-ai/codebuddy-code/dist/codebuddy-headless.js` 的 ACP prompt、AcpUsagePublisher、UsageUtils |
| 工作台 | 阶段 1 工作区 | `packages/adapters/src/acp/usage.ts`、`packages/gateway/src/usage.ts`、`packages/gateway/src/independent/model-wire.ts` |

## 每轮用量的离线预期

| Agent | PromptResponse.usage | usage_update | 尚未验证 |
|---|---|---|---|
| Claude Code | turnOutcome 返回本轮累计输入、输出、缓存读写与合计；sessionUsage 未提供 thoughtTokens | result 分支发送 used、size 与 USD 累计费用 | 真实登录方式、模型下的字段完整性与连续轮次语义 |
| Codex | beginPromptTokenUsage 建立本轮起点，buildPromptUsage 返回本次 prompt 的用量；toPromptUsage 映射缓存读与思考 | used 与窗口存在且窗口大于零时发送 | 真实各字段是否有值、真实累计结果 |
| CodeBuddy | 目前阅读的 prompt 完成片段返回 stopReason 与 traceId，尚未确认普通主会话的六项 usage 返回链路 | AcpUsagePublisher 存在 used、size、cost 与扩展元数据发送逻辑 | PromptResponse 是否实际报告；部分 usage_update 是否缺少 size |
| 独立 Agent | 工作台按本轮生成请求账本逐项相加；任一次缺项则该项未知；排除计数请求 | 用独立上下文预检，必须标“估算” | 智谱真实服务各字段与三轮结果 |

SDK 草案 Usage 注释仍使用“跨会话 / 所有轮次”的表述，而上述两个固定适配器实现明确建立 prompt 累计边界。因此不能仅凭 SDK 字段名判定各实现的统计范围；阶段 9 必须按实际响应和连续轮次核对。工作台不自行从输入和输出推算总量，也不把缺失值补成零。

CodeBuddy 的 getCumulativeTokenUsage 用于已读到的子 Agent 状态分支，不能据此推断主会话的 PromptResponse.usage。仅检索到字段名不算接口已验证。

## 上下文分类

ACP UsageUpdate 的标准字段只有 used、size、可选 cost 与不透明 _meta，没有标准的系统提示 / 工具 / MCP / 记忆 / 对话分类。Claude 适配器包含 /context 命令入口，但分类结果能否通过机器可读扩展完整取得，仍待阶段 8 核查。

当前实现保持“分类明细 Agent 未报告”。若发现可用分类扩展，先另写包含来源、范围、时间与未知值的协议方案，等待用户决定后实施。

## 周期额度：不能与 token 用量混同

- Claude 的 `_meta.quota.token_count` 与 `model_usage` 是用量统计；后者可能包含子 Agent、压缩等额外调用，不是前者的可直接相加分解，更不是订阅剩余额度。
- Claude 的 rate_limit_event 分支会通过 usage_update 的 `_meta["_claude/rateLimit"]` 透传 rate_limit_info，且要求已有上下文用量。字段含义、周期、完整性及实际是否发送尚待验证；本步未接入。
- Codex 固定源码包含 `account/rateLimits/read` 和 `account/rateLimits/updated`，由 Agent 自己与 App Server 通信，工作台不需要也不会读取凭据。是否有适合工作台消费的稳定 ACP 扩展仍待核查，不能绕开 ACP 直接调用私有账户接口。
- CodeBuddy 的周期额度可用公开路径、zcode-acp 的智谱配额思路与独立服务适用性：待阶段 8 核查。任何新调用只能由 Gateway 使用工作台已保存的 Key 发起，不在网页直连，不展示或复制 Key。

本稿不授权新增配额请求。界面保持“额度未知”；可行方案先写清数据含义、请求频率、失败表现和凭据归属，再请用户决定。

## 真实补验

未验证。阶段 9 计划见 phase-1 第 10.14 节：Claude Code 3 条、Codex 2 条、CodeBuddy 2 条须另获批准；独立 Agent 的“智谱真实补验”3 条沿用长期授权。异常立即停止，不自动重试。
