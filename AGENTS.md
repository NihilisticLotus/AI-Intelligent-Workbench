# AGENTS.md：所有 AI Agent 和协作者的入口

Codex、CodeBuddy、ZCode、Cursor 等工具会自动读取本文件；Claude Code 通过 `.claude/CLAUDE.md` 引用本文件。这里放必须遵守的核心规则，细则在 `.agent/` 里。

## 项目

AI Console（AI 智能工作台）：本机常驻的 Gateway，通过 ACP 接入 Claude Code、Codex、CodeBuddy 等编码 Agent，用网页界面统一派发任务、审批、切换模型。用户是游戏制作人，不使用命令行，所以所有功能都必须能在界面上完成。

- 设计：`docs/design/design.md`（架构）、`docs/design/ui-design.md`（界面）
- 当前计划：`docs/plans/phase-1.md`（第 2 节“接口规则”是硬约束）
- 界面验收参照：`docs/prototype/index.html`

## 核心规则

1. 接口：客户端只通过 `/api/v1` 的 REST + WebSocket 访问 Gateway；类型只在 `packages/protocol` 里定义。网页里不出现本机路径拼接，也不绕过接口。详见 `docs/plans/phase-1.md` 第 2 节。
2. 安全：所有请求都校验设备令牌、Host 和 Origin，本机也不例外。不提交任何密钥、令牌，以及 `.aic-data/` 里的内容。
3. 目录：新文件先按 `.agent/repo-layout.md` 决定放哪。根目录只允许白名单里的文件，不要在根目录堆笔记、草稿、截图。
4. 记录：
   - 设计、调研、计划、原型、验收、开发笔记、问题收纳，全部放进 `docs/` 下对应的子目录。
   - 开发笔记和问题单只追加，不改写历史，保证可以溯源。
   - 详见 `.agent/records.md`。
5. 提交：标题写 `<type>(<scope>): 一句话动机与结果`，带配套文档时用 ` + ` 连接。正文三段式：动机 → `本提交:` → `验收:`。验收只写真实做过的验证。详见 `.agent/commit-convention.md`。
6. 验证：改代码后 `npm run typecheck`、`npm test`、`npm run build` 都要通过。改了界面要在浏览器里实际操作一遍，`.claude/launch.json` 里的 `app` 配置用于开发预览。
7. 依赖：锁定精确版本，不全局安装任何东西。新增依赖前先确认它仍在维护。
8. 语言：界面文案、文档、代码注释、提交信息一律用中文；标识符和文件名用英文。

## 细则

| 文件 | 内容 |
|---|---|
| `.agent/commit-convention.md` | 提交规范、type 和 scope 表、提交粒度、分支与推送 |
| `.agent/repo-layout.md` | 目录结构、根目录白名单、命名、换行和编码 |
| `.agent/records.md` | 文档和记录的存放位置、写法、互相引用规则 |
| `.agent/templates/` | 开发笔记、问题单、验收记录的模板 |
