# ISSUE-0009：本机全局 codex 0.120 读不了当前的 config.toml，改用 codex-acp 自带的 0.165

| 项 | 值 |
|---|---|
| 状态 | fixed |
| 类型 | 外部依赖 |
| 严重程度 | 中 |
| 发现于 | 第 1.2 步接入前的探测（plans/phase-1.md 6.3.1） |
| 开启 | 2026-11-06 |
| 关闭 | 2026-11-26 |

## 现象

设置 `CODEX_PATH=%APPDATA%\npm\codex.cmd`（本机全局 codex-cli 0.120.0）后，`session/new` 报错：

```
{"code":-32603,"message":"Internal error","data":{"details":"failed to read configuration layers: C:\\Users\\<用户>\\.codex\\config.toml:2:16: unknown variant `default`, expected `fast` or `flex`"}}
```

单独运行 `codex.cmd login status` 也报同样的错。codex-acp 自带的 codex 0.165.0 能正常读取，`login status` 显示已登录。

## 复现步骤

1. 用 `CODEX_PATH=%APPDATA%\npm\codex.cmd` 启动 codex-acp 2.5.0。
2. initialize 后调用 `session/new`。

## 影响

design.md 6.1 原定“用 `CODEX_PATH` 指向本机版本，保证登录状态和版本一致”，在本机走不通。

## 根因

`~/.codex/config.toml` 第 2 行 `service_tier = "default"` 是新版 Codex 的写法，0.120 只认 fast / flex。这份配置很可能是同时在运行的 Codex 桌面版（和我们共用 `~/.codex`）改写的，以后还可能继续写入旧 CLI 不认识的内容。

## 处理方式

- 第 1.2 步不设 `CODEX_PATH`，使用 codex-acp 自带的 codex（0.165.0，用 `overrides` 钉成精确版本）。两者共用 `CODEX_HOME`，登录状态相同，不需要复制凭据。
- 待办：更新 design.md 6.1 中 Codex 一行的说明，并在 devlog 记录这个决定。
- 以后如果本机全局 codex 升级到能读这份配置的版本，再评估是否提供“使用本机 Codex”选项（`CODEX_PATH` 指向 `.cmd` 时由 codex-acp 用 cross-spawn 启动）。

## 验证

第 1.2 步冒烟测试中，自带 codex 能完成 session/new 和一次对话。

## 时间线

- 2026-11-06 开启：接入前探测时发现。
- 2026-11-26 归入 1.8（ISSUE-0181）：Codex 桌面端与官方上游已多次更新（`codex-acp` 至 2.12.0、`@openai/codex` 至 0.172.0），在 `plans/phase-1.md` 第 14 节升级适配器自带引擎并复验新版配置兼容性。
- 2026-11-26 完成并关闭：升级精确锁定 `@agentclientprotocol/codex-acp@2.12.0` 与配套 `@openai/codex@0.171.0`，补齐新版 `_auth/status_update` 脱敏状态监听并剥离宿主嵌套 `CODEX_*` 会话环境变量，同步更新 `design.md` 第 6.1 节说明；在本机多次更新后的共享配置下实测连接、审批拒绝/放行、换模型、恢复会话与跨 Agent 交接全部通过，详见 [docs/acceptance/step-1.8.md](../acceptance/step-1.8.md)。
