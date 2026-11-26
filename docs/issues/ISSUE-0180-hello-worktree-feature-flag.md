# ISSUE-0180：`/api/v1/hello` 中 `FeatureKey.Worktrees` 仍固定为 `false`

- 状态：fixed
- 类型：bug
- 严重度：low
- 发现于：2026-11-26（第二阶段调研盘点代码基线时发现）
- 关闭：2026-11-26
- 目标里程碑：2.1（提前于 2026-11-26 全项目审查修复）

## 现象

第 1.5 步已完成 Git Worktree 与非 Git 项目的隔离工作副本（`TaskWorkspace`、改动对比、合并、丢弃与回滚），但 `packages/gateway/src/http/system.ts` 第 36 行返回 `/api/v1/hello` 时仍将 `[FeatureKey.Worktrees]`（即 `'workspace.worktree'`）硬编码为 `false`。

## 复现

1. 查看 `packages/protocol/src/index.ts` 第 587 行：`Worktrees: 'workspace.worktree'` 注释注明“1.3 起”（重排后对应 1.5）。
2. 查看 `packages/gateway/src/http/system.ts` 第 36 行：`[FeatureKey.Worktrees]: false`。
3. 全局检索 `FeatureKey.Worktrees`：网页端目前直接通过任务返回的 `workspace` 字段判断，未读取该布尔开关，因此界面功能未受阻塞，但握手元数据与真实服务端能力不一致，后续桌面端或手机客户端若按 `/hello` 开关渲染会产生误判。

## 期望

核对客户端与测试对该开关的依赖后，使 `/api/v1/hello` 中的 `FeatureKey.Worktrees` 如实反映服务端已支持工作副本的真实状态（`true`），并补齐对应握手断言测试。

## 定位

- `packages/gateway/src/http/system.ts`（第 36 行）
- `packages/protocol/src/index.ts`（第 587 行）

## 决定

本次仅做调研与规划，按要求不修改功能代码；登记本问题单，排入第二阶段第 2.1 步一并核对修复。

## 时间线

- 2026-11-26：盘点工作台现有文档与代码差异时发现并建单，排入 `docs/plans/phase-2.md` 第 2.1 步。
- 2026-11-26 修复并关闭：全项目代码审查中将 `packages/gateway/src/http/system.ts` 的 `/api/v1/hello` 开关改为动态读取真实服务端状态（`Worktrees: s.workspaces.git.available`、`RealAgents: s.agents.all().some(a => a.real)`、`FsBrowse: isLocalRequest(c)`），补齐回归测试 `packages/gateway/test/review-2026-11-26.test.ts`，详见 [workbench-review-2026-11-26.md](../acceptance/workbench-review-2026-11-26.md)。
