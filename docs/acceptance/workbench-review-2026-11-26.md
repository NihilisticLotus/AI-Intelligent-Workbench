# 2026-11-26 全项目代码审查与修复验收

日期为 2026-11-26。本次审查在 `ec4495b`（第 1.8 步封板）基线上覆盖整个工作台：启动器（`scripts/start.mjs`、`启动 AI Console.bat`）、共享协议（`packages/protocol`）、ACP 适配器与脱敏层（`packages/adapters`）、Gateway 服务端（`packages/gateway`）与网页前端（`apps/web`）。验证全部使用临时数据目录、演示 Agent 与假 ACP 子进程，**零真实模型调用、花费 0 元**。

## 审查范围

| 维度 | 核对的实现模块 |
|---|---|
| 适配器与启动器 | `packages/adapters/src/acp/{connection,launch,permissions,session,updates}.ts`、`antigravity/`、`zcode/`、`redact.ts`、`scripts/start.mjs`、`启动 AI Console.bat` |
| 任务、权限与工作副本 | `packages/gateway/src/{permission-rules,workspaces,tasks,task-files,processes,attachment-reader}.ts`、`agents/service.ts` |
| 鉴权、局域网与路由边界 | `packages/gateway/src/http/{system,projects,independent,agents,tasks,access-guard}.ts`、`fsbrowse.ts`、`ws.ts`、`lan/pairing.ts` |
| 协议与网页前端 | `packages/protocol`、`apps/web/src/components/{Chat,Composer,AgentPicker,Sidebar}.tsx`、`pages/{AgentsPage,new-task-page,network-settings}.tsx`、`api/{http,ws}.ts`、`state/app.ts`、`platform/browser.ts` |

## 本轮修复（8 个问题单）

| 问题单 | 根因与修复结果 | 对应回归用例 |
|---|---|---|
| [ISSUE-0180](../issues/ISSUE-0180-hello-worktree-feature-flag.md) | `/api/v1/hello` 改为动态上报 `FeatureKey.Worktrees`（按 `workspaces.git.available`）、`RealAgents`（按已注册真实适配器）与 `FsBrowse`（仅本机请求为 `true`），不再硬编码。 | `packages/gateway/test/review-2026-11-26.test.ts` |
| [ISSUE-0182](../issues/ISSUE-0182-acp-permission-normalization.md) | ACP 工具名与路径归一补齐 `inferToolKind()` 回退（含 `_meta`、`u.name`、无冒号 `NotebookEdit`）、扩展路径字段、`diff` 与 `permissions.fileSystem` 提取、删除动作识别及跨目录 `cwd` 标为 `complete: false`。 | `packages/adapters/test/review-2026-11-26.test.ts` |
| [ISSUE-0183](../issues/ISSUE-0183-zcode-xdg-config-and-resume-mode.md) | ZCode 注入隔离空白 `XDG_CONFIG_HOME` 防止宿主机配置覆写 `ZCODE_ACP_REMOTE=0`/模式并移除无效 `ZCODE_MODEL` 透传；Antigravity 修复带引号 `PATH` 与 `--model=` 参数；`AcpSession` 恢复会话不再短路跳过权限模式重设、补齐 `modeRank` 校对、`replayTimer` 清理、`safeLaunchModel` 校对与探测 60 秒超时；`AcpConnection` 统一 `close()`/`kill()` 并丢弃超长残行。 | `packages/adapters/test/review-2026-11-26.test.ts` |
| [ISSUE-0184](../issues/ISSUE-0184-permission-rules-path-and-git-guards.md) | `permission-rules.ts` 拒绝 `~` 与 UNC 路径、收紧脚本参数与首参读保护、剥离尾部点/空格与 NTFS 备用数据流、补全 `.claude.json`/`.ssh`/`.aws`/`.azure`/`.npmrc`/`.netrc`/`.pypirc`/私钥与工作区外 `.aic-data` 保护、用命令词法识别替代贪婪 Git 正则（拦 `git push/fetch/pull/remote/config/clone/ls-remote` 且不误伤 `git diff vite.config.ts`）、拦截含 `$`/`%` 的壳删除并拒绝悬空符号链接。 | `packages/gateway/test/review-2026-11-26.test.ts`、`permission-rules.test.ts` |
| [ISSUE-0185](../issues/ISSUE-0185-lan-route-boundaries-and-ws-revoke.md) | 补齐 10 处局域网 `requireLocal` 边界（目录浏览、项目增改、独立服务增删及默认/网络设置、交接/工作区设置、Agent 启停与连接测试），`DELETE /tasks/:id` 局域网无条件走电脑端二次确认；`fsbrowse.ts` 拦截 Windows 保留设备名、软链/联接点、驱动器根、完整用户主目录与系统/凭据目录；`ws.ts` 吊销后同步丢弃排队帧并 250ms 强断；`pairing.ts` 临近超时点允许自动续期 ≥30 秒。 | `packages/gateway/test/review-2026-11-26.test.ts` |
| [ISSUE-0186](../issues/ISSUE-0186-workspace-recovery-semaphore-and-files.md) | `workspaces.ts` 扩展复制忽略凭据目录、恢复/失败分支统一传入 `carriedSet` 并安全容错缺失副本目录；`attachment-reader.ts` 修复队首已取消时的信号量唤醒断链；`processes.ts` 清理孤儿进程跳过活跃 PID 并按 `(pid, created_at)` 精准删除；`task-files.ts` 优先相对工作副本归一化且合并 ACP 与独立回执时保留 `independent` 来源；`agents/service.ts` 脱敏检测错误且开启 Agent 时自动触发探测。 | `packages/gateway/test/review-2026-11-26.test.ts`、`independent-task-runtime.test.ts` |
| [ISSUE-0187](../issues/ISSUE-0187-env-redaction-and-launcher-sync.md) | `acp/launch.ts` 显式剥离 Gateway 私有环境变量（`AIC_DATA_DIR`、`AIC_PORT`、`AIC_PROVIDER_KEY` 等）与第三方宿主覆盖变量；`redact.ts` 补齐 `AIza`、`ghp_`/`github_pat_`、`AKIA`、`?key=`、`x-aic-key`、`aic_session_` 等打码规则；`scripts/start.mjs` 与 `启动 AI Console.bat` 同步锁文件依赖检查、清 `NODE_OPTIONS`、校验数字版本号与退出码透传。 | `packages/adapters/test/review-2026-11-26.test.ts` |
| [ISSUE-0188](../issues/ISSUE-0188-web-markdown-handoff-and-draft-fixes.md) | `Chat.tsx` 与 `browser.ts` 拦截 Markdown 远程图片静默外联并将非 `http(s)` 链接降级为纯文本；`Composer.tsx` 与 `AgentPicker.tsx` 修复待交接目标丢失思考强度且支持直接点选目标强度与切回原选择；`new-task-page.tsx` 修复创建失败后表单锁死及冗余推荐；`AgentsPage.tsx` 消除开关切换误报错误并隐藏未安装卡片的“未验证版本”；`Sidebar.tsx`、`network-settings.tsx`、`ws.ts`、`http.ts`、`app.ts` 补齐局域网文案、未知事件推进游标、重启清登录态及非 JSON 401 处理。 | `apps/web/src/review-2026-11-26.test.ts` |

## 浏览器实操验证

在隔离临时数据目录（`%TEMP%\aic-review-1126\data`，端口 `17896`）与临时 Git 项目（`demo-proj`）中启动预览 Gateway，全程仅派发内置**演示 Agent**，验证结果如下：

- **本机配对与 `/api/v1/hello`**：通过随机配对码完成配对，核对 `/api/v1/hello` 返回 HTTP 200，`features["workspace.worktree"] = true`、`features["fs.browse"] = true`。
- **Agent 页（深色主题）**：核对全部 Agent 卡片渲染正常，未安装或停用项不出现误导性的“未验证版本”；切换演示 Agent 启停开关（关 → 开）无任何误报错误提示。
- **设置页（浅色主题与网络说明）**：核对“网络”一节明确列出 `Claude Code、Codex、Antigravity、CodeBuddy、ZCode`；切至日间浅色主题后对比度与排版正常。
- **演示任务与待交接思考强度选择**：添加 `demo-proj` 并用演示 Agent 运行一条任务、在网页审批卡片点击“允许一次”至完成；在底部输入框切换交接目标为 `Claude Code`（未发送），核对 5 个模型与全部 6 档思考强度（`default`～`max`）均正常可见可点并出现待交接提示，切回演示 Agent 后干净恢复。
- **窄屏响应式（`390×844`）**：深浅双主题下逐页检查 `#/agents`、`#/settings` 与任务详情页，6 组页面 `scrollWidth === 390`，均无横向滚动溢出。

## 全量门禁结果

冻结代码后单次串行执行全仓门禁，零失败：

| 检查项 | 结果 |
|---|---|
| `npm run typecheck` | 4 个工作区（`@aic/adapters`、`@aic/gateway`、`@aic/protocol`、`@aic/web`）全部通过 |
| `npm test` | **1,256 项通过，5 项真实 Agent 冒烟按配置跳过，0 失败**（其中 `@aic/adapters` 121 通过 / 5 跳过，`@aic/gateway` 869 通过，`@aic/protocol` 67 通过，`@aic/web` 199 通过；较 1.8 新增 17 项审查回归用例） |
| `npm run build` | 网页构建通过（`dist/index.html`、`dist/assets/index-*.css` / `.js`，保留既有的 Vite 单块体积提示） |

## 边界与后续承接

- **未阻塞且留待后续阶段处理的审查记录**：
  1. 真实手机、系统软键盘与 Windows UAC 现场验收仍由 [ISSUE-0149](../issues/ISSUE-0149-lan-phone-acceptance.md) 跟踪；
  2. 多账号切换并发互斥与跨队列名额抢占等复杂调度优化，留待第二阶段第 2.6 步（多岗位协作调度器）统一重构；
  3. 专项网络安全体系（消息来源防伪信封、通用子进程白名单、公共出站防内网探测门禁、安全状态自检可视化）已细化排入 [phase-2.md 第 7 节（2.1 实现规格）](../plans/phase-2.md#7-第-21-步实现规格与任务拆解网络安全加固基线与防注入围栏)。
