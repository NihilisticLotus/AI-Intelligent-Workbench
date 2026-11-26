# ISSUE-0185：局域网明文接口访问边界缺口、敏感目录项目注册与设备吊销 WS 关闭窗口

| 项 | 值 |
|---|---|
| 状态 | fixed |
| 类型 | 安全边界 |
| 严重程度 | 高 |
| 发现于 | 2026-11-26 全项目代码审查 |
| 开启 | 2026-11-26 |
| 关闭 | 2026-11-26 |

## 现象与根因

1. `GET /api/v1/fs/browse`、`POST/PATCH /projects`、`POST/DELETE /independent/services`（无 `apiKey` 时）、`PUT /independent/default|network`、`PUT /settings/handoff|workspaces`、`PATCH /agents/:kind`、`POST /agents/:kind/test` 缺少 `requireLocal`，局域网设备可在明文 HTTP 下遍历宿主机磁盘、注册敏感目录、改写交接/默认模型或修改网络设置；`DELETE /tasks/:id` 在任务无活动工作副本时跳过 `confirmRemote`。
2. `validateProjectDir` 未阻止将磁盘根目录、`homedir()` 本身、符号链接或 `.claude`/`.ssh` 等凭据目录注册为项目，且 `normalizeDirPath` 未拦截 Windows 保留设备名。
3. `packages/gateway/src/ws.ts` 在设备吊销时仅发 `ws.close()`，在最长 30 秒关闭握手期间仍执行 `ws.on('message')` 指令；`lan/pairing.ts` 在临近倒计时结束点允许时未延长手机领取窗口。

## 处理方式

- 为上述高危本机配置与目录接口补齐 `requireLocal`，将 `DELETE /tasks/:id` 改为局域网无条件走 `confirmRemote`。
- 在 `fsbrowse.ts` 中拒绝 Windows 保留设备名、符号链接、磁盘根目录、用户主目录本身、系统目录与凭据目录。
- 在 `ws.ts` 引入 `revoked` 标志立即丢弃被吊销连接的一切消息，并在 250ms 后兜底 `terminate()`；在 `lan/pairing.ts` 点允许后至少保留 30 秒领取窗口。

## 验证

- `packages/gateway/test/review-2026-11-26.test.ts` 及全部既有局域网测试通过，详见 [workbench-review-2026-11-26.md](../acceptance/workbench-review-2026-11-26.md)。

## 时间线

- 2026-11-26：全项目代码审查发现、修复并验证关闭。
