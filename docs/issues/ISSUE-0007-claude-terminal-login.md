# ISSUE-0007：Claude Code 订阅登录没有 ACP authenticate，能否全程图形化未实测

| 项 | 值 |
|---|---|
| 状态 | open |
| 类型 | 外部依赖 |
| 严重程度 | 中 |
| 发现于 | 第 1.2 步接入前的探测（plans/phase-1.md 6.3.3） |
| 开启 | 2026-11-06 |
| 关闭 | |

## 现象

claude-agent-acp 0.100.0 的 `authMethods` 只有两种：`claude-ai-login`（订阅）和 `console-login`（Anthropic Console），type 都是 `terminal`，args 是 `["--cli","auth","login","--claudeai"|"--console"]`。ACP 的 `authenticate` 只支持 gateway / gateway-bedrock，对这两种会返回 invalidParams。也就是说，登录必须由客户端自己启动一个进程完成。设置了 `NO_BROWSER` 或 `SSH_*` 时，又只剩进入 TUI 执行 `/login` 一种方式。

本机 npm 版 Claude Code 当前未登录（`auth status --json` 为 `loggedIn:false`）。

## 复现步骤

1. 启动 `node <claude-agent-acp>/dist/index.js`，initialize 时声明 `clientCapabilities.auth.terminal = true`。
2. 查看返回的 `authMethods`：都是 terminal 类型。
3. 对 `claude-ai-login` 调用 `authenticate`：返回 invalidParams。

## 影响

用户不使用命令行，登录必须在界面上一键完成。如果 `auth login` 中途要求在终端里按键或粘贴授权码，后台子进程会卡住。

## 根因

上游设计如此：订阅和 Console 登录交给 Claude CLI 自己完成。

## 处理方式

1. Gateway 以隐藏子进程运行 authMethod 声明的参数，注入账号的环境变量，不注入 `NO_BROWSER` / `SSH_*`。CLI 打开浏览器走 OAuth（回调到 localhost），Gateway 从 stdout 只提取白名单域名的授权链接推给界面，进程退出码为 0 后用 `auth status` 确认。
2. 如果需要粘贴授权码：界面显示输入框，通过 `POST /agents/claude/login/:loginId/code` 写入子进程的 stdin。
3. 都走不通时：引导用户添加“官方 API Key”账号；必要时考虑由 Gateway 提供一个网页终端承载 TUI 的 `/login`（需另行评估）。

## 验证

第 1.2 步冒烟测试中，在未登录的本机上从界面点 [登录] 完成一次订阅登录，记录是否需要任何终端输入。

## 时间线

- 2026-11-06 开启：接入前探测时发现，未实测登录流程（会打开浏览器、需要用户操作）。
- 2026-11-06 第 1.2 步联调：之前记录的“Claude 未登录”是检测环境造成的误报——从 Git Bash 启动时继承的 `HOME=/c/Users/...` 传给了 Windows 原生的 claude.exe，它找不到登录信息。适配器已改为在 Windows 上删掉这种 MSYS 风格的 HOME，修复后本机检测为已登录，并完成了真实冒烟。因为已登录，订阅登录流程本身仍未实测，归入 ISSUE-0013。
- 2026-11-08 重新规划（plans/phase-1.md 第 1 节）：目标步改为 1.3，和 ISSUE-0013 一起用真实未登录环境验证。
- 2026-11-08 第 1.3 步：本步真实补验尚未开始，三家图形登录与取消流程等待用户配合；保持 open，没有启动真实登录或读取凭据文件。 验收见 [step-1.3](../acceptance/step-1.3.md)。
