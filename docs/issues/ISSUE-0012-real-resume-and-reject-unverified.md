# ISSUE-0012：真实 Agent 的会话恢复和拒绝审批没有完整验证

| 项 | 值 |
|---|---|
| 状态 | open |
| 类型 | 验收未通过 |
| 严重程度 | 中 |
| 发现于 | docs/acceptance/step-1.2.md |
| 开启 | 2026-11-06 |
| 关闭 | |

## 现象

第 1.2 步冒烟测试（Claude Code、Codex）里：

- close 之后 resume 都成功（Claude 约 0.8 秒，Codex 约 3.6 秒），但恢复出来的会话模型和思考强度回到了默认值：Claude 从 opus / low 变回 default / default，Codex 从 gpt-6.1-sol / medium 变回 gpt-5.6-sol / low。适配器层不会自己保留切换过的配置。
- Gateway 在恢复后会重新下发任务记录里的模型（`real-agent.test.ts` 用假 ACP Agent 验证过），但没有用真实 Agent 走过“换模型 → 进程退出或空闲回收 → 下一条消息恢复”，也没有确认恢复后 Agent 是否记得之前的对话（为控制费用没有再发消息）。
- 只测了“允许”：Claude 弹出“Write hello.txt”、Codex 在 `read-only` 模式下弹出“Edit files”，选项都是 allow_once / reject_once，允许后文件都生成了。“拒绝”之后 Agent 是否真的不写文件（尤其 Codex 在 Windows 上的 `read-only` 沙箱，plans/phase-1.md 6.3.4）没有验证。

## 复现步骤

1. `AIC_REAL_AGENTS=1 AIC_REAL_AGENTS_ONLY=claude,codex npx vitest run test/real.smoke.test.ts`（在 `packages/adapters` 下），看报告里的 `configAfter` 和 `resumedModel` / `resumedEffort`。

## 影响

如果 Gateway 的重新下发在真实 Agent 上失败，用户换过模型的任务在空闲回收或崩溃恢复后会悄悄回到默认模型。拒绝审批不生效则“需审批”形同虚设。

## 根因

适配器层：两家 Agent 的 `session/resume` 都不恢复会话级的配置，属于预期行为，需要 Gateway 重新下发。其余未验证。

## 处理方式

1.3 前补一次真实验证（每家最多 2 条极短消息）：

1. 在网页里换模型后，把并发或空闲回收时间调小，等会话被回收，再发“只回复 OK”，看 `session.config` 里的模型是否是换过的那个，并问一句“上一条我让你做了什么”。
2. “需审批”下让 Agent 新建文件，点 [拒绝]，确认文件没有生成。

## 验证

上述两项在 Claude Code、Codex 上通过（CodeBuddy 见 ISSUE-0010）。

## 时间线

- 2026-11-06 开启：第 1.2 步真实冒烟测试的结果。

- 2026-11-07 CodeBuddy 补测：恢复会话成功，但恢复后模型和思考强度回到默认（auto、enabled），和 Claude、Codex 的现象一致；Gateway 能否找回切换后的模型仍待验证。拒绝审批仍未在真实 Agent 上测试。
- 2026-11-08 重新规划（plans/phase-1.md 第 1 节）：目标步改为 1.3：恢复后配置和上下文、拒绝审批后文件确实没写、Codex 在网页里的完整对话。
- 2026-11-08 补验（docs/acceptance/step-1.2.md“补验”一节）：Codex 在网页里完整对话、拒绝审批后文件确实没写、会话内换模型后记得上下文、Gateway 重启后恢复会话（resumed=true，切换过的模型和思考强度保留，记得暗号）全部通过；CodeBuddy 会话内换模型后记得上下文。Claude 因账号额度用完没有测到，额度恢复后在 1.3 补测；补测通过后关闭本单。
- 2026-11-08 第 1.3 步：真实 Claude 暗号恢复、拒绝审批及配置持久化留在第 9.11 节计划内；尚未发送真实消息，保持 open。 验收见 [step-1.3](../acceptance/step-1.3.md)。
- 2026-11-08 真实 CodeBuddy 补验：Gateway 重启后恢复原会话，以 GLM-5.3 / 自动发起一次写入审批；网页拒绝后显示未执行并暂停，目标文件确认不存在，只有一次审批且没有重试。Claude 的对应补验仍未完成；后续沿用第三方自身配置，不用工作台 API 账号替换其认证（phase-1 9.15）。
