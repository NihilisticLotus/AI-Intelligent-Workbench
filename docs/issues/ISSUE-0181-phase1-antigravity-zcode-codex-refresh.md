# ISSUE-0181：第一阶段新增 Google Antigravity 接入及 ZCode、Codex 更新兼容与回归测试

- 状态：open
- 类型：待办
- 严重度：medium
- 发现于：2026-11-26（用户指出本机已增加 Google Antigravity，且 ZCode 与 Codex 经历多次软件更新，需在第一阶段补齐支持与测试）
- 目标里程碑：1.8

## 背景与本机核查结果（2026-11-26）

1. **Google Antigravity**：
   - 本机已安装 Antigravity 桌面版 `2.35.2.0`（`%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe`），尚未安装独立的 `agy` CLI（Windows 默认安装位置 `%LOCALAPPDATA%\agy\bin\agy.exe`）。
   - 官方文档（`antigravity.google/docs/cli/acp`）确认 `agy acp` 原生提供标准 ACP v1 `stdio` 服务，与桌面版共享系统安全凭据登录态，支持模型与五档思考强度（`Low`～`Max`）、工具审批、文件差异、图片附件与会话恢复。
2. **ZCode（关联 [ISSUE-0020](ISSUE-0020-zcode-acp-bridge.md)）**：
   - 本机 ZCode 桌面版已升至 `3.18.2.10443`，内置引擎 `resources\glm\zcode.cjs`（`0.17.1`）经 `--help` 核对仍无原生 `--acp`，需通过锁定精确版本的 `zcode-acp-server`（Apache-2.0，当前 `0.94.0`）并强制将模式收紧为 `plan` / `guarded`（禁用默认 `yolo` 与远程 hub）接入对话与审批。
3. **Codex（关联 [ISSUE-0009](ISSUE-0009-codex-global-cli-config.md)）**：
   - 仓库仍锁在 2026-11-06 的 `@agentclientprotocol/codex-acp@2.5.0`（内置 `@openai/codex@0.165.0`），本机桌面端与官方上游已多次更新（当前 npm 最新 `codex-acp@2.12.0`、`@openai/codex@0.172.0`），需升级锁定并复验共享 `~/.codex/config.toml` 兼容性及全链路功能。

## 期望与验收要求

按 [docs/plans/phase-1.md 第 14 节](../plans/phase-1.md#14-18-实现规格antigravity-接入与-zcodecodex-更新支持及测试) 分四小步完成：
1. 升级并验证新版 Codex；
2. 新增 Google Antigravity 官方 `agy acp` 适配器与网页支持；
3. 接入 ZCode 受控桥接并在新版 `3.18.2` 上实测；
4. 完成离线契约测试、真实环境最小开销冒烟（对话、识图、审批允许/拒绝、换模型）及跨 Agent 交接（H2～H4）与工作副本回归，出具 `docs/acceptance/step-1.8.md`。

## 时间线

- 2026-11-26：用户提出需求，完成本机程序版本与官方协议只读核查，写入 `docs/plans/phase-1.md` 第 1.8 步（第 14 节），排在第二阶段启动之前执行。
