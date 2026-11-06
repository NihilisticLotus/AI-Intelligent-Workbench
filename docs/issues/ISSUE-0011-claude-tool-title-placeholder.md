# ISSUE-0011：Claude 的工具行标题停在“Preparing file…”

| 项 | 值 |
|---|---|
| 状态 | open |
| 类型 | bug |
| 严重程度 | 低 |
| 发现于 | docs/acceptance/step-1.2.md |
| 开启 | 2026-11-06 |
| 关闭 | |

## 现象

用 Claude Code 新建 hello.txt 时，对话里的工具行一直显示“修改 · Preparing file… · 完成”，而审批卡片的标题是“Write hello.txt”。冒烟测试里 Claude 的 `tool_start` 标题同样是“Preparing file…”。

## 复现步骤

1. 用 Claude Code 新建任务，权限“需审批”，内容“在当前目录新建 hello.txt，内容为 hi”。
2. 允许审批后，看对话里的工具行标题。

## 影响

用户看不出 Agent 实际改了哪个文件（要展开工具行才能看到输出里的路径）。

## 根因

claude-agent-acp 0.100.0 先发 `tool_call`（标题是占位的“Preparing file…”），之后在 `tool_call_update` 里才给出真实标题。`packages/adapters/src/acp/updates.ts` 对“只改标题的 update”直接丢弃；协议里也没有更新工具标题的事件。

## 处理方式

待定。可选：协议新增一个只增不改的 `tool.update`（标题、目标），或者在适配器里推迟发出 `tool.start`，直到拿到非占位的标题。

## 验证

同样的操作后，工具行显示“Write hello.txt”或文件路径。

## 时间线

- 2026-11-06 开启：第 1.2 步浏览器验收时发现。
