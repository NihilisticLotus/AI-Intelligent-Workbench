# 问题总表

规则见 [.agent/records.md](../../.agent/records.md) 第 3 节，模板见 [.agent/templates/issue.md](../../.agent/templates/issue.md)。编号递增、永不复用；关闭的问题保留。

| 编号 | 标题 | 状态 | 类型 | 开启 | 关闭 |
|---|---|---|---|---|---|
| [ISSUE-0001](ISSUE-0001-acp-mcp-injection.md) | 部分 Agent 在 ACP 模式下忽略客户端传入的 mcpServers | investigating | 外部依赖 | 2026-11-06 | |
| [ISSUE-0002](ISSUE-0002-gpt-image-2.6-transparency.md) | OpenAI Images 2.6 是否原生支持透明背景未确认 | deferred | 外部依赖 | 2026-11-06 | |
| [ISSUE-0003](ISSUE-0003-node-sqlite-experimental.md) | node:sqlite 仍是实验特性 | open | 技术债 | 2026-11-06 | |
| [ISSUE-0004](ISSUE-0004-start-script-first-run.md) | 启动脚本的首次运行路径未在干净环境里实测 | open | 验收未通过（未验证） | 2026-11-06 | |
| [ISSUE-0005](ISSUE-0005-401-before-pairing.md) | 配对前浏览器控制台出现 401 | fixed | bug | 2026-11-06 | 2026-11-08 |
| [ISSUE-0006](ISSUE-0006-always-allow-rules.md) | “总是允许”审批规则尚未实现 | deferred | 待办 | 2026-11-06 | |
| [ISSUE-0007](ISSUE-0007-claude-terminal-login.md) | Claude Code 订阅登录没有 ACP authenticate，能否全程图形化未实测 | open | 外部依赖 | 2026-11-06 | |
| [ISSUE-0008](ISSUE-0008-codebuddy-login-fragile.md) | CodeBuddy 登录态在探测中失效，且与 WorkBuddy 共用登录 | fixed | 外部依赖 | 2026-11-06 | 2026-11-07 |
| [ISSUE-0009](ISSUE-0009-codex-global-cli-config.md) | 本机全局 codex 0.120 读不了当前的 config.toml，改用 codex-acp 自带的 0.165 | open | 外部依赖 | 2026-11-06 | |
| [ISSUE-0010](ISSUE-0010-codebuddy-smoke-not-run.md) | CodeBuddy 未登录，真实会话冒烟和浏览器验收没有执行 | fixed | 验收未通过 | 2026-11-06 | 2026-11-07 |
| [ISSUE-0011](ISSUE-0011-claude-tool-title-placeholder.md) | Claude 的工具行标题停在“Preparing file…” | fixed | bug | 2026-11-06 | 2026-11-08 |
| [ISSUE-0012](ISSUE-0012-real-resume-and-reject-unverified.md) | 真实 Agent 的会话恢复和拒绝审批没有完整验证 | open | 验收未通过 | 2026-11-06 | |
| [ISSUE-0013](ISSUE-0013-login-and-apikey-unverified.md) | 登录流程和 API Key / 自定义地址账号没有用真实 Agent 验证 | open | 验收未通过 | 2026-11-06 | |
| [ISSUE-0014](ISSUE-0014-event-flush-raf-stall.md) | 实时事件只靠动画帧合并，窗口被遮挡时审批卡片不出现 | open | bug | 2026-11-06 | |
| [ISSUE-0015](ISSUE-0015-gateway-silent-exit.md) | Gateway 意外退出，没有留下错误信息 | investigating | bug | 2026-11-07 | |
| [ISSUE-0016](ISSUE-0016-workbuddy-engine-replaced.md) | WorkBuddy 自动更新后内置引擎变成精简版，CodeBuddy 无法使用 | investigating | 外部依赖 | 2026-11-07 | |
| [ISSUE-0017](ISSUE-0017-login-500-rec-before-init.md) | 点 CodeBuddy 的登录按钮报“服务内部错误” | fixed | bug | 2026-11-07 | 2026-11-07 |
| [ISSUE-0018](ISSUE-0018-chat-fragmented-replies.md) | 思考强度提示堆叠；Agent 回复被拆成多条 | fixed | bug | 2026-11-07 | 2026-11-07 |
| [ISSUE-0019](ISSUE-0019-reply-display-not-codex-like.md) | 回复的结构和格式与常见 Agent 软件差别大（参照 Codex） | fixed | bug | 2026-11-07 | 2026-11-07 |
| [ISSUE-0020](ISSUE-0020-zcode-acp-bridge.md) | ZCode 还不能对话，需要接入 zcode-acp 桥接 | open | 待办 | 2026-11-07 | |
| [ISSUE-0021](ISSUE-0021-quota-hint-garbled.md) | 额度错误的提示把英文原文截了一段拼进中文 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0022](ISSUE-0022-turn-hang-no-timeout.md) | Claude 回合卡住两分钟以上没有任何输出，也没有超时 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0023](ISSUE-0023-step-1.3-real-input-unverified.md) | 第 1.3 步真实截图和选择器仍待补验 | open | 验收未通过（未验证） | 2026-11-08 | |
| [ISSUE-0024](ISSUE-0024-profile-model-catalog.md) | 切换账号仍显示另一账号的模型 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0025](ISSUE-0025-codex-api-auth-required.md) | Codex API 账号建会话前误要求登录 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0026](ISSUE-0026-claude-profile-settings-routing.md) | Claude 用户设置可能覆盖 API 账号路由 | investigating | bug | 2026-11-08 | |
| [ISSUE-0027](ISSUE-0027-codebuddy-auto-label.md) | CodeBuddy 自动强度在提示和面板中显示 enabled | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0028](ISSUE-0028-api-profile-delete-policy.md) | API 账号删除时的目录与凭据清理规则冲突（旧配置已阻断，清理待完成） | investigating | 验收未通过 | 2026-11-08 | |
| [ISSUE-0029](ISSUE-0029-custom-api-agent-boundary.md) | 工作台自定义 API 被错误归属到第三方认证（原生边界已整改，独立 Agent / 多 API 模型与能力识别待实现） | investigating | 验收未通过 | 2026-11-08 | |
| [ISSUE-0030](ISSUE-0030-pi-runtime-contracts.md) | Pi 候选的参数、终态与用量语义需宿主适配 | investigating | 外部依赖 | 2026-11-08 | |
| [ISSUE-0031](ISSUE-0031-nested-transaction-rollback.md) | 捕获内层事务错误后会提交半次修改 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0032](ISSUE-0032-capability-form-config-revision.md) | 旧能力表单可能写入已变更的服务范围 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0033](ISSUE-0033-discovery-conflict-submit.md) | 模型发现冲突后仍可重复提交旧预览 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0034](ISSUE-0034-interrupted-tool-continuation.md) | 工具明确中断后仍继续请求模型 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0035](ISSUE-0035-concurrent-hardlink-write.md) | 文件共享锁不能阻止校验后的并发硬链接 | fixed | 安全边界 | 2026-11-08 | 2026-11-08 |
