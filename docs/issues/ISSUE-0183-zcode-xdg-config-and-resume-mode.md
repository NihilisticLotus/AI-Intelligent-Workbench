# ISSUE-0183：ZCode 外部配置文件覆盖受控变量、恢复会话权限短路及连接收尾竞态

| 项 | 值 |
|---|---|
| 状态 | fixed |
| 类型 | 安全边界 / bug |
| 严重程度 | 高 |
| 发现于 | 2026-11-26 全项目代码审查 |
| 开启 | 2026-11-26 |
| 关闭 | 2026-11-26 |

## 现象与根因

1. `zcode-acp-server@0.94.0` 读取 `$XDG_CONFIG_HOME/zcode-acp/config.json` 的优先级高于 `ZCODE_ACP_*` 环境变量；若本机曾有该文件，可重新打开远程端口、自动续跑或 `yolo` 模式。
2. `AcpSession.applyInitial` 在 `resumed` 会话上直接走 `setPermission` 的相等短路，未强制向底层重发权限模式；`setPermission` 自身缺少 `modeRank` 后置校验；`startConnection` 的握手期 `pending` 通知队列从未消费；`acpProbe` 的测试消息未设超时且吞掉 `setPermission('readonly')` 错误。
3. `AcpConnection.close()` 与 `kill()` 并发调用时后者提前返回未等待子孙进程清理；NDJSON 超限单行未跳过同行残尾。
4. ZCode 单独注入 `ZCODE_MODEL` 无效，`--model` 未拦截 `-` 开关前缀，`findAntigravity` 未去引号、`findZcode` 漏检 `%ProgramFiles%`。

## 处理方式

- `packages/adapters/src/zcode/index.ts` 将 `XDG_CONFIG_HOME` 指向工作台受控空目录（不影响 `~/.zcode` 登录态），移除无效的 `ZCODE_MODEL` `launchModel` 并补 `%ProgramFiles%` 候选路径。
- `packages/adapters/src/acp/session.ts` 恢复会话强制重发权限模式、`setPermission` 增加 `modeRank` 后置校验、消费 `holder.pending` 握手期通知、清理 `replayTimer`、为 `acpProbe` 测试消息增加 60 秒超时及 `readonly` 强校验、校验 `launchModel` 合法字符。
- `packages/adapters/src/acp/connection.ts` 用统一 `closingTask` 同步并发关闭/强杀并补齐 NDJSON `droppingLine` 丢弃逻辑。

## 验证

- `packages/adapters/test/review-2026-11-26.test.ts` 与适配器全量单测通过，详见 [workbench-review-2026-11-26.md](../acceptance/workbench-review-2026-11-26.md)。

## 时间线

- 2026-11-26：全项目代码审查发现、修复并验证关闭。
