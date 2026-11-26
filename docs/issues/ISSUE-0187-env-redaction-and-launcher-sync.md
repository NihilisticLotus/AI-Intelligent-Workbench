# ISSUE-0187：子进程泄露 `AIC_*` 与引擎覆盖变量、脱敏正则缺口及启动器升级不重装依赖

| 项 | 值 |
|---|---|
| 状态 | fixed |
| 类型 | 安全边界 / bug |
| 严重程度 | 中 |
| 发现于 | 2026-11-26 全项目代码审查 |
| 开启 | 2026-11-26 |
| 关闭 | 2026-11-26 |

## 现象与根因

1. `packages/adapters/src/acp/launch.ts` 的 `buildNativeEnv` 与 `buildChildEnv` 未剥离工作台自身 `AIC_*` 变量（如 `AIC_DATA_DIR`、`AIC_PORT`），且 `buildNativeEnv` 漏剥 `CLAUDE_CODE_EXECUTABLE`、`CODEX_PATH`、`APP_SERVER_LOGS`、`ZCODE_BIN` 及 Claude 宿主嵌套变量。
2. `packages/adapters/src/redact.ts` 未覆盖 Google/Gemini Key（`AIza...`）、GitHub Token（`ghp_...` / `github_pat_...`）、AWS Key（`AKIA...`）、URL `?key=` 以及工作台自身 `x-aic-key` / `aic_session_` Cookie / WS 子协议凭据。
3. `scripts/start.mjs` 仅判断 `node_modules/.package-lock.json` 是否存在，仓库更新依赖（如 1.8 新增 `zcode-acp-server`）后双击启动不会自动执行 `npm ci`，且未拦截 `SIGBREAK`；`启动 AI Console.bat` 未清 `NODE_OPTIONS` 且掩盖非零退出码。

## 处理方式

- 扩展 `launch.ts` 环境变量剥离列表与 `redact.ts` 脱敏正则。
- `scripts/start.mjs` 增加 `package-lock.json` 时间戳比对与 `tsx` 缺失检测触发 `npm ci`，监听 `SIGBREAK` 与 `child.on('error')`；`启动 AI Console.bat` 检测前清空 `NODE_OPTIONS`、校验数字版本并透传退出码。

## 验证

- `packages/adapters/test/review-2026-11-26.test.ts` 新增环境变量与脱敏回归测试通过，详见 [workbench-review-2026-11-26.md](../acceptance/workbench-review-2026-11-26.md)。

## 时间线

- 2026-11-26：全项目代码审查发现、修复并验证关闭。
