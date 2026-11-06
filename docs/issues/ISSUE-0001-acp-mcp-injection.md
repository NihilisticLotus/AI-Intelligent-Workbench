# ISSUE-0001：部分 Agent 在 ACP 模式下忽略客户端传入的 mcpServers

| 项 | 值 |
|---|---|
| 状态 | investigating |
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
- 2026-11-06 实测（第 1.2 步接入前的探测，三家都没有调用 `session/prompt`；状态改为 investigating）。方法：在 `session/new` 的 `mcpServers` 里传入一个只回显的 stdio 服务 `aic-echo`，看它是否被拉起并完成握手。
  - Claude Code（claude-agent-acp 0.100.0，自带 claude.exe 2.1.316；改用本机 npm 版 claude.exe 结果相同）：支持注入。session/new 返回后，claude.exe（不是适配器进程）立即拉起 `aic-echo`，依次发出非标准探测 `server/discover`（回 -32601 不影响后续）、`initialize`、`notifications/initialized`、`tools/list`。源码中 `settingSources` 为 user / project / local，用户级设置确实被加载了（`available_commands_update` 里出现了用户级的技能和命令），因此推断全局 MCP 也会同时加载，未用 prompt 确认。
  - Codex（codex-acp 2.5.0，自带 codex 0.165.0）：支持注入。`aic-echo` 收到 `initialize`、`notifications/initialized`、`tools/list`，app-server 日志显示它从 starting 变为 ready。注入通过会话级的配置覆盖传下去，没有写入 config.toml。全局 MCP 仍然会加载（同一个会话里用户配置的 10 个服务也启动了），没有会话级开关可以关掉；要隔离只能换 `CODEX_HOME`。与用户配置同名的注入服务会被静默跳过（`DISABLE_MCP_CONFIG_FILTERING=true` 可以关掉这个去重），所以注入的服务名必须带 `aic-` 前缀。
  - CodeBuddy（WorkBuddy 内置引擎 2.115.0）：支持注入。`aic-echo` 在 session/new 返回前约 50ms 完成握手（`initialize` → `notifications/initialized` → `tools/list`），传入的 env 也生效。源码中 `strictMcpConfig` 默认为 false，推断还会同时加载 `~/.workbuddy/mcp.json`，未用 prompt 确认。
  - 结论：三家都接受注入，本单原来担心的“忽略传入的 mcpServers”在这三家上没有出现，不需要走“写入全局配置”的降级路径。三家都会同时加载自己的全局 MCP（Codex 已确认，另两家是推断）。
  - 仍未验证：模型能否真正调用注入的工具；Claude 和 CodeBuddy 是否连上了全局 MCP。这两项放进第 1.2 步的真实 Agent 冒烟测试（plans/phase-1.md 6.8、6.9），通过后关闭本单。
- 2026-11-06 第 1.2 步真实冒烟（docs/acceptance/step-1.2.md）：Claude Code 和 Codex 在 `session/new` 时都拉起了注入的 `aic-echo`（`mcpStarted: true`），与探测结论一致。为控制费用，冒烟测试不再让模型调用 `aic-echo`（计划 6.8 已同步修改），“模型能否真正调用注入的工具”仍未验证，放到第 1.4 步注入 `aic_history` 时一起验证。CodeBuddy 未登录，未测（ISSUE-0010）。状态保持 investigating。
