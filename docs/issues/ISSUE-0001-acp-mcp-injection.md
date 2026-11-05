# ISSUE-0001：部分 Agent 在 ACP 模式下忽略客户端传入的 mcpServers

| 项 | 值 |
|---|---|
| 状态 | open |
| 类型 | 外部依赖 |
| 严重程度 | 中 |
| 发现于 | 设计阶段调研（design.md 25.2） |
| 开启 | 2026-11-06 |
| 关闭 | |

## 现象

ACP 的 `session/new` 允许客户端传入 `mcpServers`。社区有报告称：Cursor 的 ACP Agent 会悄悄忽略传入的 mcpServers；Kiro 在 ACP 模式下又不加载自己的全局 MCP 配置。

- https://forum.cursor.com/t/acp-agent-silently-ignores-mcpservers-in-session-new/153623
- https://github.com/kirodotdev/Kiro/issues/11717

## 影响

能力中心（design.md 第 25 节）的 MCP Hub，以及交接用的 `aic_history` 工具（7.5.3），都依赖通过 ACP 注入 MCP。某个 Agent 不支持注入时，需要改为把 Hub 入口写进它的全局配置。

## 根因

各 Agent 对 ACP 规范的实现程度不同。

## 处理方式

第 1.2 步接入真实 Agent 时，逐个实测 Claude Code、Codex、CodeBuddy 是否接受注入的 mcpServers，结果记录在本单；不支持的走“写入一条配置”的降级路径。

## 验证

## 时间线

- 2026-11-06 开启：设计阶段调研时发现。
