# ISSUE-0186：工作副本异常恢复与缺目录删除、附件信号量死锁、进程清理竞态及文件列表路径泄露

| 项 | 值 |
|---|---|
| 状态 | fixed |
| 类型 | bug |
| 严重程度 | 高 |
| 发现于 | 2026-11-26 全项目代码审查 |
| 开启 | 2026-11-26 |
| 关闭 | 2026-11-26 |

## 现象与根因

1. `workspaces.ts` 中 `mergeGit` / `rollbackGit` 的 `catch` 分支与 `recoverOperations()` 调用 `dirtyFiles` 时漏传 `carriedSet`，导致配置了 `carryGlobs` 的项目一旦提交失败即永久锁死在 `pending` 状态；非 Git 复制的 `IGNORED` 漏排第三方凭据目录；当原项目或副本文件夹在磁盘上被用户删走时，`remove()` 在 `checkedRecord()` 抛 `ENOENT`（500），用户无法在界面删除死任务与死项目。
2. `AttachmentFileReader.acquire()` 释放槽位唤醒队首时，若队首 `signal.aborted === true`，既未递增 `active` 也未继续唤醒下一位等待者，可能造成附件下载与识图队列永久死锁。
3. `ProcessRegistry.cleanupOrphans()` 异步清理期间未跳过当前实例刚登记的存活 PID，删除语句也未匹配 `created_at`。
4. `taskFiles()` 未对照 `t.workspace_path` 计算相对路径导致暴露 `.aic-data\worktrees\...` 绝对路径，且交接到独立 Agent 后丢失前序 ACP 会话的文件改动记录。
5. `AgentService.doDetect` 异常消息未脱敏，且打开 Agent 开关时未传 `userInitiated = true` 自动探测模型列表。

## 处理方式

- `workspaces.ts` 抽出 `carriedSet(record)` 统一传给三处恢复检查，将凭据目录加入 `IGNORED`，并在 `remove()` 对缺失的原项目/副本目录执行受管路径校验后的容错清理。
- `attachment-reader.ts` 改为循环唤醒直到有效等待者接管槽位；`processes.ts` 跳过 `this.live.has(pid)` 并按 `(pid, created_at)` 精确删除；`task-files.ts` 优先相对 `workspace_path` 归一化并合并独立回执与事件工具记录；`agents/service.ts` 脱敏检测错误并在打开开关时触发 `autoProbe(kind, true)`。

## 验证

- `packages/gateway/test/review-2026-11-26.test.ts` 新增 4 项回归测试，全量 Gateway 单测通过，详见 [workbench-review-2026-11-26.md](../acceptance/workbench-review-2026-11-26.md)。

## 时间线

- 2026-11-26：全项目代码审查发现、修复并验证关闭。
