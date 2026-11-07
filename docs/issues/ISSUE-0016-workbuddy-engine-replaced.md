# ISSUE-0016：WorkBuddy 自动更新后内置引擎变成精简版，CodeBuddy 无法使用

| 项 | 值 |
|---|---|
| 状态 | investigating（CodeBuddy 部分已处理，WorkBuddy 部分待研究） |
| 类型 | 外部依赖 |
| 严重程度 | 高 |
| 发现于 | 排查 ISSUE-0015 时 |
| 开启 | 2026-11-07 |
| 关闭 | |

## 现象

- WorkBuddy 在 2026-11-07 11:16～11:17 自动更新：2.115.0 → 2.165.0。`cli/dist/codebuddy.js` 不见了，只剩 `bin/codebuddy` 和精简引擎 `dist/codebuddy-lite-wb.mjs`。
- 工作台的 [测试连接] 报“没有找到 WorkBuddy”（找的是旧文件名）。
- 改为走 `bin/codebuddy` 后，它在 `--acp` 模式下要加载 headless 或完整引擎，都不存在，报 `Cannot find module '../dist/codebuddy'`。
- 加上 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` 让它加载精简引擎：`--version`、`--help` 正常，但在 ACP 模式下发 `initialize` 没有任何输出，进程在 stdin 关闭后正常退出。

## 影响

借用 WorkBuddy 内置引擎的 CodeBuddy 完全不可用；而且 WorkBuddy 每次自动更新都可能再次破坏接入，我们无法控制。

## 根因

WorkBuddy 2.165.0 只打包了给它自己用的精简引擎，ACP 启动方式和独立版不同（推测需要 WorkBuddy 自己的宿主进程提供的环境），没有公开文档。

## 处理方式（用户决定：两个独立的 Agent）

1. CodeBuddy：改用官方独立版引擎 `@tencent-ai/codebuddy-code`，作为 packages/adapters 的依赖，锁定版本 2.181.0（MIT 风格许可，约 220 MB）。它带完整引擎，原生支持 ACP，登录在工作台里完成（浏览器授权），不再依赖 WorkBuddy 的安装目录和更新。
2. WorkBuddy：作为单独的 Agent 保留。使用 WorkBuddy 自己的内置引擎，登录在 WorkBuddy 里完成。只带精简引擎（2.165.0 起）时，检测结果为“暂不支持”并写明原因，不会启动引擎；带完整引擎的旧版本照常可用。
3. 待研究：精简引擎能否通过 ACP 驱动（需要弄清 WorkBuddy 启动它时的参数和环境变量）。研究清楚之前，WorkBuddy 在工作台里保持“暂不支持”。

## 验证

- `codebuddy-split.test.ts` 5 项：Agent 列表里是两个 Agent；CodeBuddy 的引擎来自 node_modules；精简引擎识别；WorkBuddy 检测为不支持；两者的登录方式分开。
- 实测（独立版 2.181.0，没有发消息）：检测通过，initialize 握手 1.7 秒；session/new 返回“需要登录”。本机 `~/.codebuddy` 目前没有有效登录。
- 浏览器实测：Agent 页出现两张卡片。CodeBuddy 显示“工作台自带的官方独立版引擎 · 需要登录 · 2.181.0（已验证）”；WorkBuddy 显示“出错：这个版本的 WorkBuddy 只带精简引擎……（ISSUE-0016）”。
- 待完成：用户在工作台里登录 CodeBuddy 后，跑一次真实冒烟测试。

## 时间线

- 2026-11-07 开启：排查 ISSUE-0015 时发现；按用户决定把 CodeBuddy 和 WorkBuddy 拆成两个 Agent。
- 2026-11-07 用户在工作台里登录 CodeBuddy 独立版后，冒烟测试通过（docs/acceptance/step-1.2.md「CodeBuddy 独立版补测」）。CodeBuddy 部分已解决；WorkBuddy 精简引擎能否接入仍在调研，保持 investigating。
- 2026-11-08 重新规划（plans/phase-1.md 第 1 节）：不阻塞第一阶段，WorkBuddy 精简引擎的研究推迟到 1.7 之后。
