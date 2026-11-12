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

## 阶段 8 核查补充（2026-11-13）

结论：每轮统计按已实现的标准字段接收；上下文分类仍显示“分类明细 Agent 未报告”，周期额度仍显示“额度未知”。下面区分静态可行路径与真实已验证能力，不因发现内部方法就宣称工作台已支持。没有调用任何账户额度接口，没有安装或运行 zcode-acp，没有读取第三方凭据。

### 三家固定源码的进一步核对

- Claude ACP 0.100.0：`acp-agent.js` 的 `turnQuotaMeta / quotaMeta`（约 9972 行）确实也包含 `_meta.quota`，注释明确主循环与按模型的更大统计范围可能不相等。因此初稿的 Claude 归属无误；Codex 2.5.0 的 `buildQuotaMeta`（约 53716 行）也提供同名结构。二者均不是周期剩余额度。
- Claude `/context` 属于 `LOCAL_ONLY_COMMANDS`，可以沿 prompt 路径处理本地命令；这不等于提供结构化分类。已核对 `startTurn`、本地命令输出、`usage_update` 和 `_meta` 生成处，未找到将系统提示、工具、MCP、记忆、对话分类发送给 ACP 客户端的明确合同。固定适配器里结构化辅助方法针对 `/usage`，不是 `/context`。分类经 ACP 扩展取得：本轮未找到；真实命令输出未验证，不抓取终端图表或从自然语言反推分类。
- Claude `/usage` 由 `localCommandMarkdown` 调用 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`，经 `usage-markdown.js` 验证后转为 Markdown；失败或超时保留原输出。其内部 schema 包含 five_hour、seven_day、模型窗口、utilization、resets_at、extra_usage，并允许未知值。它由 Agent 自己使用登录，工作台无需读凭据，但当前只向客户端展示文本，方法明确不稳定，不能当作稳定额度 API。
- Claude `rate_limit_event` 只有在已有 lastAssistantTotalUsage 时才附 `_claude/rateLimit`。可研究被动展示已报告的限流状态，但事件可能不来，也不保证每个窗口都有剩余额度；它与 `/usage` 不能无条件互相补零。
- Codex `/status` 分支调用 `refreshRateLimits`，读取 App Server，再用 `formatRateLimitLines` 输出 Markdown。`handleRateLimitsUpdated` 只维护适配器内部 Map。已核对所有 rateLimits 引用，未找到周期额度转发为稳定 ACP `_meta` 的链路；`buildQuotaMeta` 仅包含本轮 token 信息。
- CodeBuddy 2.181.0：主 prompt 的完成分支创建 stopReason 和 `_meta`（traceId、请求关联、错误等），已读分支没有六项标准 usage。AcpUsagePublisher 在 prompt_end 等时机另发 usage_update，允许 used / size 缺失，并发送费用与 `codebuddy.ai/usageByCategory`、`codebuddy.ai/requestCredits` 等扩展。不能把积分、上下文分类或子 Agent 累计字段冒充主回合六项 token。静态阅读预期：标准每轮用量可能未报告；真实以阶段 9 为准。未找到周期剩余额度的稳定 ACP 返回合同，超额错误结构也不代表完整周期快照。

### 公开来源与适用边界

核查日期均为 2026-11-13。项目依赖仍为前表固定版本；官网是当天文档，可能比锁定实现新，不能据此推断已安装适配器支持。

| 来源 | 已核查结论 | 未核实部分 |
|---|---|---|
| [OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt) | account/rateLimits/read 与 updated 提供窗口使用比例、窗口分钟数和秒级重置时间，可存在多个额度桶 | 当前账号实际字段和 ACP 机器可读转发；本轮未调用 |
| [CodeBuddy 用量说明](https://www.codebuddy.cn/docs/ide/Account/usage) | 官方支持在头像 → 个人主页 → 套餐与用量查看积分 | 该页面没有给出供工作台调用的 ACP 周期额度合同；不抓登录页面或复制会话 Cookie |
| [zcode-acp 固定提交的 quota 客户端](https://github.com/william0wang/zcode-acp/blob/ed3408dd42235aacc0dab41ff35cf5e29029a8db/src/quota/client.ts) | GET `/api/monitor/usage/quota/limit`，国内主机 open.bigmodel.cn、国际 api.z.ai，Bearer Key，8 秒超时 | 不是已核实的供应商稳定接口合同；本机 Key 的适用性、账户及套餐范围未知 |
| [同项目解析器](https://github.com/william0wang/zcode-acp/blob/ed3408dd42235aacc0dab41ff35cf5e29029a8db/src/quota/parse.ts)与[类型](https://github.com/william0wang/zcode-acp/blob/ed3408dd42235aacc0dab41ff35cf5e29029a8db/src/quota/types.ts) | 参考实现处理 limits、百分比、绝对计数及重置时间 | number=5/7、单位与百分比方向是参考实现的约定，仍需供应商响应核实，不能直接承诺 |

zcode-acp 本次只读来源固定为提交 `ed3408dd42235aacc0dab41ff35cf5e29029a8db`，公开 package.json 为 0.84.2；与 2026-11-07 旧报告的 0.82.3 不混用。原项目从 ZCode 配置取凭据的方式不适用于工作台；只参考请求和解析思路。本次没有运行其凭据函数、安装脚本、hub 或自动恢复逻辑。

### 可选扩展草案：需用户决定后才能实现

建议本步先完成现有标准用量和界面验收，保留未知提示；以下作为可选后续增量，不静默加入新请求。

1. Claude 被动限流扩展：在 packages/protocol 新增独立的额度快照类型，不改变 session.usage / turn.usage 含义。只接收 Agent 已发送的白名单字段，保留来源、接收时间、窗口类型、可空重置时间与状态。只报告状态时仅展示状态，不生成剩余百分比。没有事件就是未知，不额外轮询。若要完整 `/usage` 结构，需要上游稳定扩展或单独维护桥接，不能解析 Markdown 后冒充稳定数据。
2. Codex 周期额度：App Server 有公开路径，由 Agent 自己认证可避免工作台读凭据；现有 ACP 仅提供 `/status` 文本。建议先推动或验证上游结构化扩展，不直接连接另一进程的私有端口，不以文本抓取更新面板。未来扩展需保留 limitId、窗口时长、已用比例、重置时间、来源时间；未知桶和未知值不合并。
3. 智谱独立服务试验：经用户批准后，仅 Gateway 从已保存的服务绑定中取 Key；网页只发 `/api/v1` 的请求。精确校验官方 HTTPS 主机与服务归属，不采用参考实现的字符串包含判断或“未知主机默认发国内”行为，不向自定义代理转发 Key。首次限一次只读请求，8 秒超时、禁止跳转、响应体限额，异常立即停止且不重试；返回只保存脱敏字段，Key 和原始错误体不进入日志。若验证后正式接入，建议手动刷新、同服务缓存 60 秒，不后台轮询；账号/Key 修订后清空。显示账户级周期快照与更新时间，绝不和本任务 token 合计相加。
4. 建议合同：来源、服务引用、接收时间、状态（未知/已报告/暂不可用）、窗口列表；每项含稳定标识、供应商报告的单位、可空已用/总额/剩余/已用百分比/重置时间。只接受有限数值，缺失不强转 0；百分比不从未知计数猜算，未知时间单位不换算。鉴权失败、限流、超时或无法理解的响应统一保留“额度未知”，可提示本次刷新未成功，不写 0% 或 100%。

上述方案尚未实现、未授权真实查询，不会改变已完成阶段的界面和数据语义。Claude /context 分类没有找到可直接接入的机器可读来源，本步不新增分类协议。

2026-11-13 用户决定：1.4 保持“额度未知”，后续再做。上述可选方案不在本步实施；仍不授权任何账户额度查询。

## 真实补验

未验证。阶段 9 计划见 phase-1 第 10.14 节：Claude Code 3 条、Codex 2 条、CodeBuddy 2 条须另获批准；独立 Agent 的“智谱真实补验”3 条沿用长期授权。异常立即停止，不自动重试。
