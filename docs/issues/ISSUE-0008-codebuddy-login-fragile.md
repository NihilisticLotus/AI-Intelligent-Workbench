# ISSUE-0008：CodeBuddy 登录态在探测中失效，且与 WorkBuddy 共用登录

| 项 | 值 |
|---|---|
| 状态 | fixed |
| 类型 | 外部依赖 |
| 严重程度 | 高 |
| 发现于 | 第 1.2 步接入前的探测（plans/phase-1.md 6.3） |
| 开启 | 2026-11-06 |
| 关闭 | 2026-11-07 |

## 现象

- 第 1 次运行 `codebuddy.js --acp` 时 `session/new` 成功，说明当时已登录（引擎沿用 WorkBuddy 的登录，存在 `~/.codebuddy/local_storage`）。
- 同一个进程里约 11 秒后，`session/load` 和 `session/resume` 都返回 `-32000 Authentication required`。
- 之后 4 个全新进程里，`session/new` 一律返回 `{"code":-32000,"data":{"category":"auth"}}`，`_codebuddy.ai/getUserInfo` 返回 `{}`。
- 探测期间 `~/.codebuddy` 下的 sessions、projects、user-state.json、local_storage 修改时间都更新了。WorkBuddy 桌面端当时没有运行。

另外两个相关的已知行为（读源码确认，未实测）：
- 对已登录的用户调用 ACP `authenticate` 会先登出再重新登录。
- `selfhosted`（企业域名）登录方式怎么传入域名，源码里没有确认。

## 复现步骤

未能稳定复现：只发生过一次从“已登录”到“未登录”的变化。

## 影响

- 用户需要回到 WorkBuddy 重新登录，CodeBuddy 才能在工作台里使用。
- 如果是我们的启动或检查把令牌清掉了，那么工作台每次检测都可能让 WorkBuddy 掉线。
- 由于共用 `~/.codebuddy`，在工作台里登录或换账号也会影响 WorkBuddy。

## 根因

未查明。推断：存储里的令牌已过期，第 1 次运行时刷新失败，引擎按源码逻辑把 `loggedOut` 置为 true 并清空了会话。没有读凭据或日志来证实。

## 处理方式

1. 检测登录状态用 `initialize` + `_codebuddy.ai/getUserInfo`，结果缓存 10 分钟，只在 Gateway 启动、[重新检测]、登录完成时执行，不轮询。
2. 只在确认未登录时显示 [登录]；“换账号”要二次确认，写明会同时退出 WorkBuddy 里的账号。接口层面 CodeBuddy 已登录时 `POST /agents/codebuddy/login` 必须带 `force: true`。
3. 提供 [在 WorkBuddy 中登录]：由 Gateway 启动 WorkBuddy，用户在那里登录后回来点 [重新检测]。
4. 第 1.2 步暂不提供 `selfhosted`。
5. 用户在 WorkBuddy 重新登录后，重跑检测和冒烟测试，观察登录态是否保持；如果确认是检查本身导致掉线，改为默认使用隔离的 `CODEBUDDY_CONFIG_DIR` 并在这里登录。

## 验证

用户在 WorkBuddy 重新登录后：连续执行 3 次 [重新检测] 和 1 次冒烟测试，之后 WorkBuddy 桌面端和工作台都仍显示已登录。

## 时间线

- 2026-11-06 开启：接入前探测时发现，需要用户在 WorkBuddy 里重新登录。
- 2026-11-06 第 1.2 步联调：Gateway 启动检测、[重新检测] 和冒烟测试的 detect 都显示未登录（检测耗时约 5.5 秒）；用户还没有在 WorkBuddy 里重新登录，本单的验证无法进行，CodeBuddy 的真实会话验收见 ISSUE-0010。另外修复了卡片版本显示 0.0.0：`cli/package.json` 写的是 0.0.0，真实版本 2.115.0 改从 `codebuddy.js` 里嵌入的包信息读取。

- 2026-11-07 按“验证”一节执行：用户在 WorkBuddy 重新登录后，跑了 1 次真实冒烟测试，并强制检测 3 次（间隔 15 秒），每次都是已登录；用户确认 WorkBuddy 桌面端仍为已登录。工作台的检测没有把 WorkBuddy 踢下线，之前的掉线判断为当时令牌已过期。保留现有做法（检测结果缓存 10 分钟，不轮询；换账号要二次确认）。关闭。
