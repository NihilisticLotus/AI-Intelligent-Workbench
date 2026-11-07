# ISSUE-0021：额度错误的提示把英文原文截了一段拼进中文

| 项 | 值 |
|---|---|
| 状态 | open |
| 类型 | bug |
| 严重程度 | 低 |
| 发现于 | [第 1.2 步补验](../acceptance/step-1.2.md)（2026-11-08） |
| 开启 | 2026-11-08 |
| 关闭 | |

## 现象

Claude Code 的账号额度用完时（上游返回 429），任务暂停，错误提示的 hint 是：

> 额度预计在 or use an account with available quota {"errorKind":"rate_li 后恢复

错误本身识别对了（`agent.quota_exceeded`，带 [换模型] [换账号]），只是 hint 读不通。

## 复现步骤

1. 用额度已经用完的 Claude 账号新建任务并发一条消息。
2. 看任务里的错误提示。

## 影响

用户看到一句半中半英、读不通的提示，不知道什么时候恢复。不影响功能。

## 根因

`packages/adapters/src/acp/errors.ts` 的 `quotaHint()` 用正则 `(?:reset[s]?|try again|retry)\s*(?:at|in|after)?\s*([^.;,\n]{2,60})` 找重置时间。原文是 “wait for quota to reset or use an account with available quota …”，`reset` 后面没有时间，正则把后面的 “or use an account…” 当成了时间。

## 处理方式

第 1.3 步修：只在捕获到的内容像时间时才用（数字 + 单位、ISO 时间、`HH:MM`、“in N minutes/hours” 等），否则 hint 改为固定文案“额度或调用频率达到上限，可以稍后再试，或换个模型 / 账号”。用这次的原文加进单元测试。

## 验证

## 时间线

- 2026-11-08 开启：1.2 补验时 Claude 账号额度用完，看到这条提示。
