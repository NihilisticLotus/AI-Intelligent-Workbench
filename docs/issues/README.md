# 问题总表

规则见 [.agent/records.md](../../.agent/records.md) 第 3 节，模板见 [.agent/templates/issue.md](../../.agent/templates/issue.md)。编号递增、永不复用；关闭的问题保留。

| 编号 | 标题 | 状态 | 类型 | 开启 | 关闭 |
|---|---|---|---|---|---|
| [ISSUE-0001](ISSUE-0001-acp-mcp-injection.md) | 部分 Agent 在 ACP 模式下忽略客户端传入的 mcpServers | investigating | 外部依赖 | 2026-11-06 | |
| [ISSUE-0002](ISSUE-0002-gpt-image-2.6-transparency.md) | OpenAI Images 2.6 是否原生支持透明背景未确认 | deferred | 外部依赖 | 2026-11-06 | |
| [ISSUE-0003](ISSUE-0003-node-sqlite-experimental.md) | node:sqlite 仍是实验特性 | open | 技术债 | 2026-11-06 | |
| [ISSUE-0004](ISSUE-0004-start-script-first-run.md) | 启动脚本的首次运行路径未在干净环境里实测 | open | 验收未通过（未验证） | 2026-11-06 | |
| [ISSUE-0005](ISSUE-0005-401-before-pairing.md) | 配对前浏览器控制台出现 401 | open | bug | 2026-11-06 | |
| [ISSUE-0006](ISSUE-0006-always-allow-rules.md) | “总是允许”审批规则尚未实现 | deferred | 待办 | 2026-11-06 | |
| [ISSUE-0007](ISSUE-0007-claude-terminal-login.md) | Claude Code 订阅登录没有 ACP authenticate，能否全程图形化未实测 | open | 外部依赖 | 2026-11-06 | |
| [ISSUE-0008](ISSUE-0008-codebuddy-login-fragile.md) | CodeBuddy 登录态在探测中失效，且与 WorkBuddy 共用登录 | fixed | 外部依赖 | 2026-11-06 | 2026-11-07 |
| [ISSUE-0009](ISSUE-0009-codex-global-cli-config.md) | 本机全局 codex 0.120 读不了当前的 config.toml，改用 codex-acp 自带的 0.165 | open | 外部依赖 | 2026-11-06 | |
| [ISSUE-0010](ISSUE-0010-codebuddy-smoke-not-run.md) | CodeBuddy 未登录，真实会话冒烟和浏览器验收没有执行 | fixed | 验收未通过 | 2026-11-06 | 2026-11-07 |
| [ISSUE-0011](ISSUE-0011-claude-tool-title-placeholder.md) | Claude 的工具行标题停在“Preparing file…” | open | bug | 2026-11-06 | |
| [ISSUE-0012](ISSUE-0012-real-resume-and-reject-unverified.md) | 真实 Agent 的会话恢复和拒绝审批没有完整验证 | open | 验收未通过 | 2026-11-06 | |
| [ISSUE-0013](ISSUE-0013-login-and-apikey-unverified.md) | 登录流程和 API Key / 自定义地址账号没有用真实 Agent 验证 | open | 验收未通过 | 2026-11-06 | |
| [ISSUE-0014](ISSUE-0014-event-flush-raf-stall.md) | 实时事件只靠动画帧合并，窗口被遮挡时审批卡片不出现 | open | bug | 2026-11-06 | |
| [ISSUE-0015](ISSUE-0015-gateway-silent-exit.md) | Gateway 意外退出，没有留下错误信息 | investigating | bug | 2026-11-07 | |
| [ISSUE-0016](ISSUE-0016-workbuddy-engine-replaced.md) | WorkBuddy 自动更新后内置引擎变成精简版，CodeBuddy 无法使用 | investigating | 外部依赖 | 2026-11-07 | |
| [ISSUE-0017](ISSUE-0017-login-500-rec-before-init.md) | 点 CodeBuddy 的登录按钮报“服务内部错误” | fixed | bug | 2026-11-07 | 2026-11-07 |
| [ISSUE-0018](ISSUE-0018-chat-fragmented-replies.md) | 思考强度提示堆叠；Agent 回复被拆成多条 | fixed | bug | 2026-11-07 | 2026-11-07 |
| [ISSUE-0019](ISSUE-0019-reply-display-not-codex-like.md) | 回复的结构和格式与常见 Agent 软件差别大（参照 Codex） | fixed | bug | 2026-11-07 | 2026-11-07 |
