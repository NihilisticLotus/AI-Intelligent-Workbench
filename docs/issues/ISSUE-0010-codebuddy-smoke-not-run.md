# ISSUE-0010：CodeBuddy 未登录，真实会话冒烟和浏览器验收没有执行

| 项 | 值 |
|---|---|
| 状态 | open |
| 类型 | 验收未通过 |
| 严重程度 | 中 |
| 发现于 | docs/acceptance/step-1.2.md |
| 开启 | 2026-11-06 |
| 关闭 | |

## 现象

第 1.2 步联调时，CodeBuddy 检测结果为“需要登录”（Gateway 启动检测和 [重新检测] 都是这个结果，检测方式 `initialize` + `_codebuddy.ai/getUserInfo`）。按约定不替用户登录，所以 CodeBuddy 的以下项目都没有验证：

- 真实会话：只回复 OK、审批一次（新建 hello.txt）、会话内换模型和思考强度、resume / load。
- 模型列表和思考强度的实际内容（卡片显示“首次使用后显示模型列表”）。
- 网页里的登录流程（微信、Google / GitHub、iOA、在 WorkBuddy 中登录）。
- 未登录时发 prompt 的错误形态（plans/phase-1.md 6.9）。

## 复现步骤

1. 打开 Agent 页，CodeBuddy 卡片显示“需要登录：还没有登录：请在 WorkBuddy 里登录，或在这里登录”。

## 影响

第 1.2 步完成标准“三个 Agent 都能在网页里登录、选模型、完成对话、换模型不丢上下文”对 CodeBuddy 未达成。

## 根因

本机 CodeBuddy（与 WorkBuddy 共用 `~/.codebuddy`）当前处于未登录状态，见 ISSUE-0008。

## 处理方式

需要用户先在 WorkBuddy 里重新登录（或在 Agent 页点 [在 WorkBuddy 中登录]），然后：

1. 连续 3 次 [重新检测]，确认仍显示已登录（同时完成 ISSUE-0008 的验证）。
2. `AIC_REAL_AGENTS=1 AIC_REAL_AGENTS_ONLY=codebuddy` 跑冒烟测试（最多 3 条极短消息）。
3. 在网页里用 CodeBuddy 新建任务，走一次审批和换模型。

## 验证

上面 3 步都通过，结果追加到 docs/acceptance/step-1.2.md。

## 时间线

- 2026-11-06 开启：第 1.2 步联调时检测为未登录，冒烟测试只做了 detect（耗时约 5.5 秒，引擎版本 2.115.0），会话步骤全部跳过。
