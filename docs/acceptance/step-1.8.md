# 验收记录：第 1.8 步 Antigravity 接入与 ZCode、Codex 更新支持及测试

| 项 | 值 |
|---|---|
| 日期 | 2026-11-26 |
| 基线提交 | `59344c5`（`main`） |
| 验收人 | Antigravity |
| 范围 | [第一阶段开发计划第 14 节](../plans/phase-1.md#14-18-实现规格antigravity-接入与-zcodecodex-更新支持及测试)（1.8-A～1.8-D），关联 [ISSUE-0181](../issues/ISSUE-0181-phase1-antigravity-zcode-codex-refresh.md)、[ISSUE-0020](../issues/ISSUE-0020-zcode-acp-bridge.md)、[ISSUE-0009](../issues/ISSUE-0009-codex-global-cli-config.md) |
| 结论 | 已通过 |

## 完成标准核对（对应 phase-1.md 第 14.4 节）

- [x] **三家全部就绪**：Agent 管理页中 Google Antigravity（`1.5.18`）、新版 ZCode（桥接 `0.94.0` / 引擎 `0.17.1`，桌面端 `3.18.2.10443`）、新版 Codex（适配器 `2.12.0` / 引擎 `0.171.0`）均正确识别安装状态、版本号与登录态，`[测试连接]` 全部通过且已登记进 `packages/adapters/src/verified.ts`（显示“已验证”）。
- [x] **零命令行完成日常使用**：启用 Agent、测试连接、选模型、调思考强度、发消息、点允许/拒绝审批、查看工作副本改动对比、合并回 `main` 分支，三家均在网页界面内顺畅完成。
- [x] **安全与审批实测有效**：三家真实 Agent 在工作台只开放“只读（`readonly`）”和“需审批（`ask`）”两档；真实冒烟中三家在 `ask` 档位下均实际弹出审批请求，点击“拒绝”后 `blocked.txt` 均未创建，点击“允许”后 `hello.txt` 创建且内容为 `hi`；严禁参数（Antigravity `--dangerously-skip-permissions`、ZCode 默认 `yolo`）均被阻断；全过程未读取 `~/.gemini`、`~/.zcode`、`~/.codex/auth.json`、`~/.claude`、`~/.codebuddy`、`~/.workbuddy` 或 `.aic-data`。
- [x] **跨 Agent 交接闭环**：同一任务在临时 Git 项目 `demo-game` 中依次完成 **Antigravity → ZCode → Codex** 两次 H2 自动交接（`覆盖通过`），网页弹出审批卡片经手动点击放行，接手方准确保留前序内容并最终合并回 `main`。
- [x] **工程门禁全绿**：冻结源码单次运行 `npm run typecheck`、`npm test`（1,239 通过 / 5 跳过）、`npm run build` 全部离线通过；深色与浅色双主题及 `375×812` 手机视口均在浏览器核验并留存脱敏截图。

---

## 1. 环境准备与精确版本锁定

经用户明确授权（“同意安装官方 agy 组件、升级所需依赖并发少量测试消息，开始做 1.8”）：

| 对象 | 锁定版本 / 位置 | 说明 |
|---|---|---|
| Google Antigravity CLI | `agy` `1.5.18`（`%LOCALAPPDATA%\agy\bin\agy.exe`） | 从 Google 官方更新清单下载 Windows x64 二进制并校验 SHA-512 一致后安装，与本机 Antigravity 桌面版 `2.35.2.0` 自动共享 Windows 凭据管理器中的登录态 |
| `@agentclientprotocol/codex-acp` | `2.5.0` → `2.12.0`（Apache-2.0） | `packages/adapters/package.json` 精确锁定 |
| `@openai/codex`（及 win32 二进制） | `0.165.0` → `0.171.0`（Apache-2.0） | 根 `package.json` 的 `overrides` 精确锁定，与 `codex-acp@2.12.0` 配套 |
| `zcode-acp-server` | `0.94.0`（Apache-2.0） | 使用 `--ignore-scripts` 跳过安装脚本精确锁定，驱动本机 ZCode `3.18.2.10443` 内置 `resources\glm\zcode.cjs`（`0.17.1`） |

---

## 2. 实施中发现并修正的关键问题

1. **ZCode 权限模式映射修正（`build` 替代 `guarded`）**
   - **现象与根因**：核查 `zcode-acp-server@0.94.0` 源码（`dist/config/options.js`）发现，自 ZCode `3.15.1` 起，`guarded` 模式实际采用 **`yolo` 自动放行语义**（自动写入文件，仅对 AST 识别出的少量高危命令弹一次确认）。
   - **处理**：将 ZCode 的权限等级顺序定为 `plan(0) < build(1) < edit(2) < guarded(3) < auto(4) < yolo(5)`，工作台“只读（`readonly`）”映射为 `plan`，“需审批（`ask`）”强制映射为 **`build`**，并显式注入 `ZCODE_ACP_RUNTIME=node`、`ZCODE_ACP_REMOTE=0`、`ZCODE_ACP_QUOTA_AUTO_RESUME=0`。实测 `build` 模式下修改与新建文件均稳定触发工作台审批，拒绝后文件不落盘。
2. **Antigravity 工具参数结构与隔离边界适配**
   - **现象与根因**：`agy acp` 在 `session/request_permission` 与 `session/update` 中把工具参数放在 `args` 的首字母大写字段（`CommandLine`、`Path`、`toolSummary`）里；此外 `agy` 原生 `default` 模式允许当前工作目录内的直接文件工具写入，对命令执行（`run_command`）、工作区外路径、联网与外部调用发起审批请求（在工作台正式任务中工作目录为隔离的 `TaskWorkspace` 工作副本，合并前不会改动用户原项目，且网页端正式任务流同样经过工作台文件审批）。
   - **处理**：在 `packages/adapters/src/acp/permissions.ts` 与 `updates.ts` 补齐对 `CommandLine`、`Path`、`toolSummary` 的识别，使规则引擎能准确按 `shell` / `edit` 分类；并在 `packages/gateway/src/permission-rules.ts`、`workspaces.ts` 及独立文件守卫中将 `.gemini` 加入受保护凭据目录黑名单。
3. **宿主嵌套会话环境变量剥离**
   - **处理**：在 `packages/adapters/src/acp/launch.ts` 的 `shouldStrip` 与 `buildNativeEnv` 中剥离 `ANTIGRAVITY_*`、`AGY_*`、`ZCODE_ACP_*` 及 `CODEX_SESSION_ID`、`CODEX_THREAD_ID`、`CODEX_INTERNAL_ORIGINATOR_OVERRIDE` 等宿主环境标记，避免在第三方工具终端内启动 Gateway 时干扰子进程。
4. **Windows 下连接测试后清理探测目录 `EPERM` 报错修复**
   - **现象与根因**：首轮浏览器实操在 ZCode 卡片点 `[再测一次]` 时，`POST /api/v1/agents/zcode/test` 返回 HTTP 500（`Error: EPERM, Permission denied ... rmSync`）。原因是 `zcode-acp-server` 底层的 `zcode app-server` 子进程退出瞬间仍短暂持有临时探测目录句柄，原 `AgentService.test` / `autoProbe` 的同步 `rmSync` 立即抛错，把原本已成功的探测变成了 500。
   - **处理**：在 `packages/gateway/src/agents/service.ts` 改为异步重试删除 `rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 80 })` 加异常兜底，并在 Gateway 启动时清扫残留的 `data/probe/p-*` 目录；在 `packages/gateway/test/step-1.8-handoff.test.ts` 新增句柄占用回归单测验证返回 HTTP 200。

---

## 3. 真实 Agent 最小开销冒烟结果（`real.smoke.test.ts`）

通过 `AIC_REAL_SMOKE=1` 对三款真实 Agent 执行端到端协议冒烟（每家发送 4 条极短验证指令：回复 `OK`、触发写操作并**点拒绝**、触发写操作并**点允许**、会话内换模型与思考强度后回复 `OK`，随后关闭并 `session/resume` 恢复会话）：

| 检查项 | Codex（`2.12.0` / `0.171.0`） | Antigravity（`1.5.18`） | ZCode（`0.94.0` / `0.17.1`） |
|---|---|---|---|
| 检测与登录识别 | `installed=true, loggedIn=true, verified=true`（128 ms） | `installed=true, loggedIn=true, verified=true`（3,845 ms，ACP 零费用握手） | `installed=true, loggedIn=true, verified=true`（3,907 ms，ACP 可选服务检测） |
| 暴露模型数与思考强度 | 10 个模型（`gpt-6.2-sol` 等），6 档强度（`low`～`ultra`） | 11 个模型（`gemini-4-neon`、`claude-opus-5-5` 等），4 档强度（`low`～`xhigh`） | 2 个模型（`GLM-5.3`、`GLM-5.3-Flash`），3 档强度（`low` / `high` / `max`） |
| `aic-echo` MCP 注入启动 | 启动成功（`session/new` 即拉起） | 启动成功（`session/new` 即拉起） | 启动成功（首轮 `session/prompt` 惰性拉起） |
| 首轮短消息 `OK` | `end_turn`（6,102 ms） | `end_turn`（3,309 ms） | `end_turn`（22,984 ms） |
| 需审批拒绝测试（`blocked.txt`） | 弹出命令审批 → 选 `reject_once` → `blocked.txt` **不存在** | 弹出命令审批 → 选 `reject_once` → `blocked.txt` **不存在** | 弹出 `Write` 审批 → 选 `reject_once` → `blocked.txt` **不存在** |
| 需审批放行测试（`hello.txt`） | 弹出命令审批 → 选 `allow_once` → 文件生成且内容为 `hi` | 弹出命令审批 → 选 `allow_once` → 文件生成且内容为 `hi` | 弹出 `Write` 审批 → 选 `allow_once` → 文件生成且内容为 `hi` |
| 会话内换模型与思考强度 | 切至 `gpt-6.2-sol` + `low` 生效并回复 `OK` | 切至 `gemini-4-carbon` + `low` 生效并回复 `OK` | 切至 `GLM-5.3-Flash` + `low` 生效并回复 `OK` |
| 关闭后 `session/resume` 恢复 | 恢复成功（`resumed=true`，2,427 ms） | 恢复成功（`resumed=true`，3,326 ms） | 恢复成功（`resumed=true`，4,677 ms） |

---

## 4. 浏览器完整实操验收（双主题、在线审批、三端交接与工作副本合并）

使用独立临时数据目录启动开发预览实例（`http://127.0.0.1:17895/`）和新建的临时 Git 仓库 `demo-game`（`main` 分支初始提交 `7d4b7e7`），全程在浏览器内点击操作：

1. **Agent 管理页与连接复测（深色 / 浅色双主题）**：
   - 在 `#/agents` 打开 Antigravity 与 ZCode 开关，自动连接测试全部通过，Codex、Antigravity（蓝色 `G` 徽标）、ZCode（绿色 `Z` 徽标）均显示 `就绪` 与“已验证”。
   - 再次点击 ZCode 的 `[测试连接]`，`POST /api/v1/agents/zcode/test` 返回 **HTTP 200**，5 步全部打勾并弹出 `ZCode: 连接正常` 提示（验证 `EPERM` 修复生效）。
   - 证据：[深色主题 Agent 管理页](assets/step-1.8-agents-dark.png) · [浅色主题 Agent 管理页](assets/step-1.8-agents-light.png)
2. **同一任务三款真实 Agent 接力 + 网页审批卡片交互 + 合并回 `main`**：
   - **第 1 棒（Antigravity，`Gemini 4 Neon · high`，`需审批`）**：发送新建 `handoff.txt`（写入 `1-Antigravity`）指令，网页弹出 `File handoff.txt` 审批卡，点击 `允许` 后完成并回复 `DONE-1`。
   - **第 2 棒（切换至 ZCode，`GLM-5.3 · max`，`需审批`）**：发送追加第二行 `2-ZCode` 指令，对话流自动插入 `已自动交接 · Antigravity（Gemini 4 Neon） → ZCode（GLM-5.3） H2 · 覆盖通过` 分隔条；随后网页弹出琥珀色待审批卡片（`Edit: ...\handoff.txt`，按钮 `允许一次 Enter` / `拒绝... Esc`），点击 `允许一次` 后完成追加并回复 `DONE-2`。
   - **第 3 棒（切换至 Codex，`6.2 Sol · high`，`需审批`）**：发送只读核对指令，自动插入第二条交接分隔条 `已自动交接 · ZCode（GLM-5.3） → Codex（6.2 Sol） H2 · 覆盖通过`，Codex 读取工作副本后准确回复 `1-Antigravity` 与 `2-ZCode` 两行内容。
   - **改动对比与合并**：打开右侧 `改动` 面板，显示 `相对 main 的全部改动 · +2 −0`（`handoff.txt` 新增两行）；点击 `合并到 main…` 并确认压缩合并，任务状态变为 **`已合并`**。磁盘核对 `demo-game` 主分支新增提交 `d467cc9`，`handoff.txt` 正文确为 `1-Antigravity` 与 `2-ZCode` 两行，随后已清理全部临时预览目录。
   - 证据：[ZCode 网页待审批卡片（已遮盖本机用户名路径）](assets/step-1.8-zcode-approval.png) · [三端交接对话与右侧改动对比面板](assets/step-1.8-handoff-diff.png) · [合并完成后概览](assets/step-1.8-merged-overview.png)
3. **手机窄屏视口检查（`375×812`）**：
   - 在 `375×812` 视口下核对已合并任务页与 `#/agents` 管理页，卡片与底部导航完整可用，无横向滚动条。
   - 证据：[375×812 手机视口 Agent 页](assets/step-1.8-mobile-375.png)

---

## 5. 全量离线门禁结果

在全部代码冻结后单次顺序执行：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（`@aic/adapters`、`@aic/gateway`、`@aic/protocol`、`@aic/web` 零错误） |
| `npm test` | **1,239 通过 / 5 跳过**（`@aic/adapters` 115 通过 / 5 跳过、`@aic/gateway` 860 通过、`@aic/protocol` 67 通过、`@aic/web` 197 通过；跳过的 5 项为需显式环境变量开启的真实模型冒烟，已在第 3 节单独跑通） |
| `npm run build` | 通过（`apps/web/dist` 正常产出，保留既有大包体积提醒） |

新增/更新测试文件：
- `packages/protocol/src/index.test.ts`：`AgentKind` 解析 `'antigravity'`。
- `packages/adapters/test/step-1.8.test.ts`（新增 8 项）：覆盖 Antigravity 未安装/仅装桌面版提示、`-32000` 未登录识别、能力探测与权限降级保护；ZCode 非 `yolo` 强制 `plan`/`build` 注入、审批允许与拒绝；Codex 新版 `_auth/status_update` 扩展通知脱敏处理。
- `packages/adapters/test/env.test.ts`、`packages/adapters/test/real.smoke.test.ts`：补入 `antigravity`、`zcode` 及宿主嵌套变量剥离、拒绝/放行双向断言。
- `packages/gateway/test/automatic-permissions.test.ts`、`independent-files.test.ts`：覆盖 `'antigravity'` 第三方权限上限与 `.gemini` 凭据目录写保护。
- `packages/gateway/test/step-1.8-handoff.test.ts`（新增 2 项）：覆盖 `Antigravity → ZCode → Codex` 连续两次 H2 自动交接账本传递，以及 `POST /agents/zcode/test` 在探测临时目录句柄被占用时仍返回 200 的回归测试。

---

## 6. 边界与后续衔接说明

- **未在本步重复验证的项**：
  1. 第 1.7 步遗留的手机真机局域网配对与实际 Windows UAC 防火墙弹窗，仍由 [ISSUE-0149](../issues/ISSUE-0149-lan-phone-acceptance.md) 独立跟踪（与本步互不阻塞）。
  2. 多模态图片输入在 1.3 已由 Claude / Codex / CodeBuddy / 独立 Agent 真实验证；本步通过 ACP 握手核实了新版 Codex、Antigravity 与 ZCode 的 `promptCapabilities.image = true` 并在界面选择器正确识别，未额外发送付费识图消息。
  3. `/api/v1/hello` 的 `FeatureKey.Worktrees` 开关状态对齐仍按计划由 [ISSUE-0180](../issues/ISSUE-0180-hello-worktree-feature-flag.md) 在第二阶段第 2.1 步一并修正。
- **下一步**：第一阶段 1.8 已全部收口，可直接按 [docs/plans/phase-2.md](../plans/phase-2.md) 启动 **第 2.1 步（网络安全加固基线）**。
