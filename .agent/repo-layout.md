# 目录结构与存放规则

## 1. 总览

```
AI-Intelligent-Workbench/
├─ .agent/            协作规则（本目录）、模板
├─ .claude/           Claude Code 的项目配置（launch.json、CLAUDE.md）
├─ apps/
│  └─ web/            网页界面（Vite + React）
├─ packages/
│  ├─ protocol/       共享协议：类型、校验、事件、错误码
│  ├─ gateway/        本地服务
│  └─ adapters/       各 Agent 适配器（第 1.2 步起）
├─ docs/              所有文档（见 records.md）
│  ├─ design/  research/  plans/  prototype/
│  └─ acceptance/  devlog/  issues/
├─ scripts/           开发和运维脚本（启动脚本以外的）
├─ AGENTS.md          指向 .agent/ 的入口（Codex 等工具会自动读取）
├─ README.md          项目介绍和使用方法
├─ 启动 AI Console.bat  双击启动（给用户用的唯一入口）
├─ package.json  package-lock.json  tsconfig.base.json
└─ .gitignore  .gitattributes  .editorconfig
```

## 2. 根目录白名单

根目录只允许出现上面列出的文件和目录。要在根目录新增任何东西，先改这份文件并说明理由。

常见的“想放根目录、其实不该放”的东西：

| 东西 | 放到 |
|---|---|
| 笔记、草稿、TODO | `docs/devlog/` |
| 问题、bug 记录 | `docs/issues/` |
| 截图、录屏、测试证据 | `docs/acceptance/assets/` |
| 临时脚本、一次性脚本 | 用完删除；要保留的放 `scripts/` |
| 各包自己的配置（vite、vitest、tsconfig） | 对应包的目录里 |
| 本机数据、日志、缓存 | `.aic-data/`（已忽略，不提交） |

## 3. 命名

- 目录和代码文件用英文小写加连字符：`fake-agent.ts`、`step-1.1.md`。
- 文档文件名用英文（便于链接和跨平台），内容用中文。
- 只给用户双击的入口可以用中文名：`启动 AI Console.bat`。

## 4. 换行与编码

- 统一 UTF-8；`.gitattributes` 规定文本文件用 LF，`.bat` / `.cmd` 用 CRLF，否则 Windows 的 cmd 会解析出错。
- 不提交 BOM。
