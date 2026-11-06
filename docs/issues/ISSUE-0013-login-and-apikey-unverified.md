# ISSUE-0013：登录流程和 API Key / 自定义地址账号没有用真实 Agent 验证

| 项 | 值 |
|---|---|
| 状态 | open |
| 类型 | 验收未通过 |
| 严重程度 | 中 |
| 发现于 | docs/acceptance/step-1.2.md |
| 开启 | 2026-11-06 |
| 关闭 | |

## 现象

第 1.2 步验收时，Claude Code 和 Codex 都已经是本机登录状态，CodeBuddy 未登录但按约定不替用户登录，所以下列功能只有单元测试 / 假 Agent 测试，没有真实验证：

- 网页里的登录流程：Claude 订阅登录（后台跑 `auth login`，是否要粘贴授权码，ISSUE-0007）、Codex ChatGPT 登录、CodeBuddy 的几种登录。
- API Key 账号：Claude 用 API Key 时 `auth status` 是否显示 API 计费；Codex 的 `CODEX_CONFIG` + `env_key` 方案（plans/phase-1.md 6.4.2）；CodeBuddy 的 API Key 环境变量（标为实验）。
- 自定义地址账号：真实中转地址上的模型列表拉取和对话。
- 未登录时发 prompt 的错误形态（三家，plans/phase-1.md 6.9）。

网页同事报告过用假密钥做了 API Key 账号的增改删和 Claude 测试连接，日志里没有密钥；本次联调扫描了 `.aic-data/logs`、事件表和审计表，没有发现形如密钥的文本。

## 复现步骤

不适用（未验证项）。

## 影响

第 1.2 步完成标准“三个 Agent 都能在网页里登录”只验证了“已登录时能检测出来”。

## 根因

不适用。

## 处理方式

需要用户配合（会打开浏览器授权、需要真实密钥、会产生少量费用）：

1. 在 Agent 页给 Claude 或 Codex 添加一个“订阅登录”的隔离账号，走一遍登录，记录是否需要终端输入（同时完成 ISSUE-0007 的验证）。
2. 用户提供一个 API Key 时，添加 API Key 账号，点 [测试连接] 和 [发送测试消息]。

## 验证

上述步骤通过，结果追加到 docs/acceptance/step-1.2.md。

## 时间线

- 2026-11-06 开启：第 1.2 步联调与真实冒烟时记录。
