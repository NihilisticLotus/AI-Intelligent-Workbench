# ISSUE-0184：权限规则存在 `~` 家目录展开、含变量删除、PowerShell `-enc`、悬空软链与 `git` 正则误杀

| 项 | 值 |
|---|---|
| 状态 | fixed |
| 类型 | 安全边界 / bug |
| 严重程度 | 高 |
| 发现于 | 2026-11-26 全项目代码审查 |
| 开启 | 2026-11-26 |
| 关闭 | 2026-11-26 |

## 现象与根因

1. `packages/gateway/src/permission-rules.ts` 中 `relativePermissionPath` 将 `~` / `~/Desktop` 当作副本内相对路径返回 `outside = false`，导致 `Remove-Item ~/Desktop` 绕过硬禁令。
2. 删除硬拦截漏检 `!parsed.simple`，导致 `rm -rf $HOME/Desktop` 绕过 `ALWAYS_DENIED`；脚本参数检查漏掉 PowerShell 缩写 `-enc` / `-ec` / `-com` 与 `--eval` / `-p`，且跳过 `tokens[0]` 外部路径。
3. `protectedTarget` 漏掉 `.aic-data`、`.claude.json`、`.ssh`、`.aws`、`.azure`、Windows 尾部点 `.zcode.` 与 UNC 写入；`decide()` 遇悬空符号链接时回退原始相对名导致保护失效。
4. `git` 硬拦截使用贪婪正则 `[\s\S]*`，误杀 `git diff vite.config.ts` 等正常命令，同时漏拦 `git pull` / `git clone`。

## 处理方式

- 收紧 `relativePermissionPath`（拒绝 `~` 与 UNC）、`commandPaths`（纳入路径型 `tokens[0]` 与 PowerShell 缩写脚本参数）、`protectedTarget`（剥离尾部点空格与 NTFS 数据流并补全敏感目录）与 `decide()`（悬空符号链接直接 `deny`）。
- 改为按命令段解析 `git` 子命令的 `hasBlockedGitCommand()`，精确拦截 `push / fetch / pull / remote / config / clone / ls-remote`，不再误伤普通文件名与提交说明。

## 验证

- `packages/gateway/test/review-2026-11-26.test.ts` 新增针对性回归测试通过，详见 [workbench-review-2026-11-26.md](../acceptance/workbench-review-2026-11-26.md)。

## 时间线

- 2026-11-26：全项目代码审查发现、修复并验证关闭。
