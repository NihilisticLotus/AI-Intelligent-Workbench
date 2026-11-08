# DeepSeek Harness：独立 Agent 框架参考

日期：2026-11-08。用户建议：独立 Agent 框架也参考 `deepseek-ai/deepseek-harness`。

核查状态：已阅读官方架构、包文档、部分关键源码与许可证；固定源码为 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，提交时间 2026-11-04，循环与 Pi 适配包标记 `0.2.2-rc.1`。这是源码版本观察，不代表已经核实 npm 发行包、运行兼容或长期稳定性。未安装、启动或导入项目，未读取本机 Agent 凭据，未发送模型请求。

## 1. 结论与位置

适合加入独立 Agent 的框架参考，尤其是**可替换服务、确定的请求快照、受控工具流水线、失败尝试记录和可追溯上下文整理**。官方采用 Cordis 插件树，模型、工具、会话与循环都可替换；同时声明处于快速变化的开发预览。它是完整的 Agent 宿主体系，不能只凭“插件化”就当作无状态工具循环库。[架构]、[项目说明]

AI Console 已有自有持久循环、三协议 HTTP driver、SQLite 会话、审批、附件和逐请求预算，当前基线为 `92fec29`，实现进度见 [step-1.3](../acceptance/step-1.3.md)。建议先借鉴机制并做离线对照，保留当前宿主；本次没有选定、替换或引入 DeepSeek Harness / Cordis / Pi 运行依赖。此前四引擎报告是当时的候选研究，新补充以本报告为准，不回写其历史结论。

## 2. 框架分层与我们的对应关系

| 官方机制 | AI Console 当前对应 | 可借鉴的具体内容 |
|---|---|---|
| Cordis 服务、事件与插件作用域；卸载时清理注册和资源 | Gateway 自有模块与任务资源所有权 | 明确注册、运行、取消、等待收尾、释放的生命周期；不必把整个 Gateway 改成 Cordis |
| `dsh-agent-loop` 管 turn / step，工具执行器独立负责批次 | `independent/turn-engine.ts`、`task-runtime.ts` | 继续把模型循环和工具权限 / 副作用分开；以后并发只开放经过验证的工具，写操作保持冲突保护 |
| `dsh-llm` 定义统一模型服务，适配器负责供应商协议 | `model-driver.ts`、`model-wire.ts` | 将能力解析、配置快照、请求编译和传输边界分清；公共类型仍只定义在 protocol |
| 会话事实可重建模型输入，实时流另有进程内通道 | `conversation.ts`、私有续传与公开进度事件 | 区分原始记录、模型可见上下文、界面进度；不能用展示事件代替可恢复会话 |

以上是我们的映射与建议，不是两个项目的接口兼容声明。循环包清单还要求 Cordis、session、persistence、projection、system-prompt、tools 等多个协作包，直接嵌入须评估双存储、双审批和生命周期的成本。[架构]、[循环包]、[循环清单]

## 3. 优先借鉴的机制

### 3.1 请求在发送前固定，能力与实际路由使用同一代配置

官方 `prepareCall` 捕获适配器与模型信息，先校验思考强度、输出默认值，再记录和发送；循环构造的输入被冻结，避免插件修改已记下的请求。供应商专用 replay state 也不能任意跨适配器复用。[模型层]、[请求配置源码]

我们已按绑定修订检查服务 / 模型，并在最终编码后做输入预检和逐 POST 预留。后续应针对“预检后配置变化”“旧能力搭配新地址”“换模型后私有续传泄漏”做离线对照，仍以现有 9.22～9.26 契约为准；不能为了复用框架改用环境认证或放宽绑定。

### 3.2 工具声明与宿主校验一致，最终拒绝不能被插件推翻

官方参数 DSL 的 `parameterSchemaSpecToJsonSchema` 从属性表生成根 `object` / `properties` / `required`，`validateArgs` 使用同一生成结果校验。它支持属性值层的 `oneOf`，没有据此宣称所有兼容服务都接受任意 schema。其隐式根没有自动加 `additionalProperties:false`，不能把该实现描述为已经满足所有供应商的 strict schema。[工具 schema 源码]

工具流水线将参数快照、策略、执行、结果处理分开；公开 `guard` 用于在可扩展策略后添加不可撤销的拒绝。输入改写不能导致审批 / 记录参数与实际执行参数不一致，取消后的工具必须等实际收尾。[工具包]、[流水线源码]

这对 [ISSUE-0042](../issues/ISSUE-0042-bigmodel-responses-tool-failure.md) 的价值是**建立对照实验**：比较现有写工具顶层联合与显式属性对象的实际 wire schema，检查必填、额外字段、条件分支和宿主约束是否同义。可先用假接口捕获三个协议的最终 JSON，并验证空对象、缺必填、非法分支不会到达审批或执行。

这不是根因结论。不得通过补默认路径、猜参数、删除宿主约束或把两种操作的联合草率摊平来“修复”；若将创建 / 替换拆成不同模型工具，必须明确版本、参数到宿主意图的映射与回归，旧共享协议只增不改。真实 A/B 仍需预算确认，目前诊断草稿不发送。

### 3.3 失败尝试有自己的记录，不能伪装成正式回复

官方循环将不少失败、重试和异常流结算为 `assistant/attempt`，与成功进入上下文的 `assistant/message` 分开。但源码在取消异常路径中也可能把已交付片段保存为 `assistant/message` 并标 `interrupted:true`；不能概括成“所有中断文本都绝不进入历史”。[循环源码]

我们继续坚持当前规则：只有完整终态通过校验才能提交正式独立助手消息，片段只作进度。可以研究增加**私有、受限、脱敏的尝试诊断**，保留失败阶段、终态类别、字段路径、绑定修订和请求指纹，以区分工具参数错误、半流、坏终态和 usage 缺失。不能直接复制完整上游响应、任意 headers 或附件内容到日志 / 事件；访问与保留策略需另定。本次未新增诊断字段或持久表。

### 3.4 压缩保留来源与工具配对，估算与账单分开

官方将 compaction 作为可选能力，记录开始、总结、结束及被覆盖的原始范围；选区检查工具调用 / 结果配对，失败和中断可辨认，不靠删除历史缩短上下文。其 token meter 区分成功 usage 锚点与启发式估计，界面压力值也不能充当计费或发送门槛。[压缩]、[用量估计]

我们已有人工作为总结来源的尾摘要检查点、原文回查、请求前预检和人工金额预留。先保持显式人工总结；未来自动总结、图片卸载或工具结果裁剪要记录被投影的内容、原始来源、模型 / 配置和额外请求费用，保留失败恢复。不能因参考了自动压缩就默认产生额外付费请求，或把上次 usage 当作新请求的精确 token。

### 3.5 子 Agent 是有资源所有权的执行，不只是多发几个请求

官方区分持久子会话和一次活跃 activation，启动时核对能力、深度、目录与输出约束，结果要等资源释放和通知后结算，历史存在不自动赋予继续运行能力。[子 Agent]

这适合未来并行任务 / 能力中心：子任务应有独立身份、可见状态、父子取消、审批边界与累计预算。是否继承上下文、工具和模型要明确展示；不能复制整份配置 / 密钥或让子任务绕过父级次数和金额约束。本次不新增子 Agent 功能，不提前开启跨 Agent 交接或后台并行收费。

## 4. 多 API、模型与能力识别：可借鉴与保留差异

官方模型服务提供供应商目录、模型列表 / 发现和 exact-model 能力解析，Pi 适配支持自定义地址、协议、手填模型、单模型修订和思考档位到 wire 值的映射。这可参考配置分层与模型选择体验；目录与声明仍不能证明服务真实工具 / 视觉兼容。[模型层]、[Pi 适配]

| 已核实行为 | AI Console 的采用边界 |
|---|---|
| Pi 适配器可用安装目录或端点发现；模型条目可声明窗口、模态、思考档位 | 继续逐字段保留供应商 / 公共目录 / 人工来源、时效、冲突与未知；不按名字猜能力，不把可列出写成已实测 |
| Pi 适配对未描述模型提供 `defaultContextWindow:1000000`、`defaultMaxTokens:128000` 回退 | 不照搬为真实规格；未知仍未知，本地上限单列为人工策略 |
| Pi 路由省略显式凭据时可能走 provider-native ambient discovery | 自有 API 始终只使用任务固定服务的 DPAPI Key；不引入第三方 / 环境凭据发现 |
| 路由 retry policy 默认正常模式、最多五次；由可选 retry 插件执行 | 保持自有 HTTP 无自动重试；任何未来额外请求都须有明确策略、次数 / 金额预留与审计 |
| 文本模型可以收到图片占位投影，图片整理也有独立机制 | 保留现有能力拦截和用户明确换模型流程，不默默把用户图片变成占位文本后声称已看图 |

上述数字与默认值仅描述固定快照的 Pi 适配包，不代表所有 dsh 适配器、供应商模型或 AI Console 的默认值。[Pi 适配]、[模型层]

## 5. 安全、许可证与直接采用门槛

官方安全说明明确为实验预览、未经安全审计。沙箱接口还区分完整 / 部分执行；Windows ACL 后端有硬链接、未隔离读取等边界，网络与进程可见性不在该文件效果策略范围内。不能以“已有 Windows sandbox”推导能保护本机其他 Agent 的凭据。[安全]、[沙箱]

审批服务对拒绝、取消、不可用都不放行，单次许可绑定具体动作；这与我们当前保守边界一致，但其事件形态不能替代现有 Gateway 的私有审批详情和任务权限检查。[审批]

源码使用 MIT；若未来复制代码或分发包，要保留适用的版权和许可证，并另核查完整依赖及原项目品牌，不将项目许可证当成全依赖结论。[许可证]

直接引入前至少验证：

1. **最小组合**：列出所有加载包与生命周期；不能默认启动第二套 Web / 数据库 / 登录、插件安装或遥测服务。锁精确发行版本及 lockfile，核实仍维护和发行内容。
2. **自有路由与类型**：只走工作台配置和现有 `/api/v1`；共享类型仍归 protocol，不用 Cordis 声明扩展绕开接口规则。
3. **工具与恢复**：假的三协议接口验证参数、拒绝、晚到批准、并发写冲突、取消收尾和重启不重放；恢复不能制造成功或返还未知费用。
4. **请求可数**：标题、压缩、重试、子任务等全部模型生产者都必须接持久预算，默认测试离线；没有确认不启动真实供应商对照。
5. **证据边界**：Windows 安装、性能、资源泄漏、系统隔离和发行包一致性单列实测，不能用本次源码阅读替代。

## 6. 建议顺序与本轮结果

近期先用其工具 schema 和失败尝试分层帮助离线分析 ISSUE-0042；随后对照绑定快照、拒绝不放宽、取消等待收尾和原始记录恢复。上下文整理、token 统计体验衔接 1.4 / 1.6；插件能力与子 Agent 作为后续专题，不改变现有步骤的开放条件。

本轮只形成研究与设计参考，未修改运行时、共享协议或 UI，未安装依赖，未运行候选测试，没有新增真实调用或费用；**未验证**：dsh 在本机的实际兼容、性能、工具可靠性，以及能否解决智谱失败。1.3 仍部分通过，ISSUE-0042 / 0028 / 0029 保持原状态。

## 一手来源

以下均固定到本报告提交；网页入口只用于发现，关键行为以上文实际阅读的源码和官方文档为准。

[项目说明]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/README.md
[架构]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.md
[循环包]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/README.md
[循环清单]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/package.json
[模型层]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm/README.md
[请求配置源码]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm/src/call-config.ts
[工具包]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/README.md
[工具 schema 源码]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/schema.ts
[流水线源码]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/pipeline.ts
[循环源码]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/agent.ts
[压缩]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/compaction.md
[用量估计]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/token-meter.md
[子 Agent]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/subagent.md
[Pi 适配]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm-pi-ai/README.md
[安全]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/SAFETY.md
[沙箱]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/sandbox.md
[审批]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/approval.md
[许可证]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/LICENSE
