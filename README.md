# AI Intelligent Workbench（AI Console）

在一个本机工作台里统一使用 Claude Code、Codex、CodeBuddy 等 AI 编码 Agent：派发任务、并行工作、审批操作、随时切换 Agent 和模型而不丢上下文。所有操作都在网页界面上完成，不需要命令行。

> 状态：第一阶段开发中（本机浏览器版）。进度见 [docs/plans/phase-1.md](docs/plans/phase-1.md)。

## 能做什么（规划）

- 统一入口：所有 Agent 的对话、任务、审批放在同一个界面里
- 并行任务：每个任务一个独立的工作副本，完成后合并或丢弃
- 无感切换：同一个 Agent 内换模型不丢上下文；换 Agent 时自动交接
- 权限与审批：分级权限，危险操作需要确认，低风险操作可以自动放行
- 后续阶段：监控与调用统计、定时任务、统一管理 MCP 和 Skill、侧边聊天、资产与三维预览、图片 / 视频 / 音效生成、桌面软件、手机应用、外网访问

## 使用

需要 Windows 和 Node.js 24 或以上。双击仓库根目录的 `启动 AI Console.bat`：首次运行会自动安装依赖，然后打开浏览器（第 1.1 步完成后可用）。

界面原型可以直接双击 [docs/prototype/index.html](docs/prototype/index.html) 查看。

## 文档

| 内容 | 位置 |
|---|---|
| 文档总目录 | [docs/README.md](docs/README.md) |
| 架构设计 | [docs/design/design.md](docs/design/design.md) |
| 界面设计 | [docs/design/ui-design.md](docs/design/ui-design.md) |
| 协作规则（人和 AI Agent 都要遵守） | [AGENTS.md](AGENTS.md) |
