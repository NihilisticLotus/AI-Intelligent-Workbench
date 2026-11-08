# ISSUE-0052：子进程被外部结束时，写管道的 EPIPE 会让整个 Gateway 退出

| 项 | 值 |
|---|---|
| 状态 | open |
| 类型 | bug |
| 严重程度 | 高 |
| 发现于 | ISSUE-0015 的零调用离线审计（2026-11-09） |
| 开启 | 2026-11-09 |
| 关闭 | |

## 现象

本机合成复现（Node v24.14.0，Windows）：父进程用 `stdio: 'pipe'` 启动一个不读 stdin 的子进程，200ms 后用 `taskkill /T /F` 结束它，父进程继续 `stdin.write()`。父进程以退出码 1 结束，终端打印 `Error: write EPIPE … Unhandled 'error' event`。

同样场景只要给 `stdin` / `stdout` / `stderr` 都挂上 `error` 监听，父进程就继续运行。

## 复现步骤

1. 子进程运行中，父进程向它的 stdin 持续写入。
2. 从外部结束子进程（任务管理器、taskkill、更新程序替换文件时结束进程）。
3. 写入回调前管道已断开，`Socket` 发出 `error`；没有监听时 Node 抛出未捕获异常，进程退出。

## 影响

Gateway 整体退出，所有任务中断。代码审计（2026-11-09，提交 6a5a846）列出的子进程管道：

| 位置 | stdin | stdout | stderr |
|---|---|---|---|
| `adapters/src/acp/connection.ts`（ACP Agent 长连接） | 有监听 | 只有连接建立后的 ReadableStream 内监听 | **没有** |
| `adapters/src/acp/launch.ts` 的 `runCli`（版本、登录状态） | **没有**（`stdin.end()`） | **没有** | **没有** |
| `adapters/src/zcode/index.ts` 的 `pingAppServer` | **没有** | **没有** | **没有** |
| `gateway/src/secrets.ts` 的 DPAPI（PowerShell，stdin 写入密钥材料） | **没有** | execFile 内部处理 | execFile 内部处理 |
| `gateway/src/independent/commands.ts`（独立 Agent 命令宿主） | 有监听 | **没有** | **没有** |

## 根因

上表这些管道没有 `error` 监听，Node 的流在没有监听时把 `error` 事件当作未捕获异常抛出（已用本机合成脚本确认）。

和 ISSUE-0015 的关系：原始故障发生时 CodeBuddy 正在用 WorkBuddy 内置引擎做探测，并且同一时段 WorkBuddy 自动更新替换了安装目录。这个机制**可以**解释那次退出，但当时的日志里没有异常堆栈，现在无法确认那次退出就是 EPIPE。因此本单只修已经复现的机制，不把 ISSUE-0015 的根因写成已查明。

## 处理方式

- `launch.ts` 新增 `guardStdio(child, onError?)`，给三条管道都挂 `error` 监听；`spawnAgent` 启动后立即调用，因此 ACP 长连接和 `runCli` 都覆盖。
- `connection.ts` 另外给 stdout / stderr 管道错误记一条 warn 日志（经脱敏）。
- `zcode` 的 `pingAppServer` 调用 `guardStdio`；DPAPI 的 stdin、独立命令宿主的 stdout / stderr 补监听。
- 进程本身的结束照旧由 `exit` / `close` 事件处理，不改变已有的收尾和报错逻辑。

## 验证

- `packages/adapters/test/step-1.3.test.ts` 新增 3 项：对照组（不加监听时宿主因 EPIPE 非零退出）、同样监听下宿主保持运行、`spawnAgent` 返回的子进程三条管道都有监听且 `guardStdio` 把错误交给回调。去掉 `spawnAgent` 里的 `guardStdio` 后第三项失败，恢复后通过。
- `npm run typecheck`、`npm test`（747 项通过 / 3 项真实冒烟默认跳过）、`npm run build` 通过。没有启动真实 Agent、联网或收费。
- 未验证：真实 Agent 进程在会话中被外部结束时的完整表现（需要人为结束用户正在使用的 Agent 进程，本轮不做）。

## 时间线

- 2026-11-09 开启：为 ISSUE-0015 做零调用审计时，本机合成脚本确认未监听的 stdin 写入在子进程被结束后会让父进程以 1 退出；代码审计列出 5 处缺失的监听并修复，修复哈希见下一条。
