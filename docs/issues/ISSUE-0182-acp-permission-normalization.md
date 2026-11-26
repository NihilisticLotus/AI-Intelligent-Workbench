# ISSUE-0182：ACP 权限操作归一化漏判 ZCode / CodeBuddy / Antigravity / Claude 部分写操作与路径字段

| 项 | 值 |
|---|---|
| 状态 | fixed |
| 类型 | 安全边界 |
| 严重程度 | 高 |
| 发现于 | 2026-11-26 全项目代码审查 |
| 开启 | 2026-11-26 |
| 关闭 | 2026-11-26 |

## 现象与根因

1. `zcode-acp-server@0.94.0` 与 CodeBuddy 的部分 `session/request_permission` 报文省略 `toolCall.kind`（或固定为 `other`），将工具名放在 `_meta.claudeCode.toolName` / `_meta['codebuddy.ai/toolName']` 或标题前缀里；Claude Code 的 `NotebookEdit` 同样返回 `kind: 'other'` 且路径位于 `rawInput.notebook_path`。`packages/adapters/src/acp/permissions.ts` 因而将 `operation.tool` 降级为 `'any'`，使下游 `permission-rules.ts` 将 `write` 判为 `false`，导致写 `.git`、写系统目录或写原项目的操作漏过 `ALWAYS_DENIED` 硬禁令。
2. `permissions.ts` 与 `updates.ts` 仅提取 `path`、`file_path`、`cwd`、`Path`，漏掉了 `filePath`（驼峰）、`notebook_path`、Antigravity PascalCase 字段（`TargetFile`、`AbsolutePath`、`DirectoryPath`、`SearchPath`、`SearchDirectory`、`Cwd`）、`toolCall.content` 中的 `diff.path` 以及沙箱扩权字段 `permissions.fileSystem.write/read`；`updates.ts` 的 `tool_call_update` 也漏判 `'args' in update`。

## 处理方式

- 在 `packages/adapters/src/acp/updates.ts` 新增 `inferToolKind()` 兜底映射，补齐 `toolTarget()` 的多字段提取及 `tool_call_update` 的 `'args' in update` 检查。
- 在 `packages/adapters/src/acp/permissions.ts` 接入 `inferToolKind()`、全量路径提取、`edit_mode === 'delete'` 删除识别及跨目录 `Cwd` 标记 `complete = false`。

## 验证

- `packages/adapters/test/review-2026-11-26.test.ts` 新增 3 项回归用例，全量单测通过，详见 [workbench-review-2026-11-26.md](../acceptance/workbench-review-2026-11-26.md)。

## 时间线

- 2026-11-26：全项目代码审查发现、修复并验证关闭。
