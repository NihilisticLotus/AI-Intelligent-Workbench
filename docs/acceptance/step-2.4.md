# 验收记录：第 2.4 步 能力中心（下）——技能库（Skills）、静态安全扫描与本机只读导入

| 项 | 值 |
|---|---|
| 日期 | 2026-11-27 |
| 提交范围 | 基于 `a4b64d9`（第 2.4 步调研、实现、测试与浏览器实操验收） |
| 验收人 | AI Agent（离线单测 + 隔离预览实例浏览器实操） |
| 结论 | 通过 |

## 完成标准

对照 [phase-2.md 第 4 节（第 2.4 步）](../plans/phase-2.md) 与 [design.md 第 25.10 节](../design/design.md) 逐项核对：

- [x] **统一技能库协议与数据库迁移（v30）**：
  - 新增共享协议 [packages/protocol/src/skills.ts](../../packages/protocol/src/skills.ts) 并在 [index.ts](../../packages/protocol/src/index.ts) 导出（零本机绝对路径回传，本机扫描使用不透明 `scanId` + `candidateId`）；[db.ts](../../packages/gateway/src/db.ts) 追加迁移 v30（`skills` 与 `task_skill_overrides`），受控副本保存于 `<dataDir>/skills/<id>/`，不改写任何第三方工具目录。
- [x] **全包静态安全扫描与风险拦截门禁**：
  - 实现 [packages/gateway/src/skills/scanner.ts](../../packages/gateway/src/skills/scanner.ts)：解析标准 `agentskills.io` YAML Frontmatter，逐行扫描 `SKILL.md` 及全部附属文件，覆盖 6 大类威胁（伪造 2.1 防伪信封、审批/规则绕过、凭据/敏感目录读取、零宽/BiDi/Tag 隐藏字符、高危管道下载执行/混淆载荷、持久化改写记忆或全局规则后门）及可执行脚本识别，输出精确文件名与行号及可视化摘录。
  - 实现 [packages/gateway/src/skills/service.ts](../../packages/gateway/src/skills/service.ts)：命中 `danger` 或含脚本文件的技能默认保存为 `enabled=false, risksApproved=false`，未确认风险时 `PATCH enabled:true` 返回 400 拒绝，后续编辑正文引入新风险自动重新锁回。
- [x] **凭据路径防火墙与本机只读扫描导入向导**：
  - 实现 [packages/gateway/src/skills/importer.ts](../../packages/gateway/src/skills/importer.ts)：硬编码 `assertNotCredentialPath()` 同时校验逻辑与真实物理路径（防符号链接越界），严格拒绝 `.credentials*`、`auth.json`、`.env`、`.aic-data`、`~/.ssh`、`~/.workbuddy` 及第三方工具配置根目录，仅允许只读扫描 `~/.agents/skills`、各工具纯 `skills/` 子目录或用户显式指定的非凭据目录，勾选后只读复制进工作台受控库。
- [x] **三层渐进式披露双端挂载**：
  - 独立 Agent（[task-runtime.ts](../../packages/gateway/src/independent/task-runtime.ts)）在系统提示词仅注入极轻 L1 摘要目录；[mcp/hub.ts](../../packages/gateway/src/mcp/hub.ts) 向独立 Agent 与第三方 ACP 会话统一暴露只读工具 `aic_skills__list` 与 `aic_skills__read`（强制路径防穿越、8,000 字头尾摘要 + `aic_mcp__read_output` 溢出翻页、2.1 `external_data` 防注入围栏）。
- [x] **网页闭环与局域网只读锁**：
  - 新增 [http/skills.ts](../../packages/gateway/src/http/skills.ts)（管理写、扫描与导入接口均 `requireLocal`），新增 [apps/web/src/pages/skills-panel.tsx](../../apps/web/src/pages/skills-panel.tsx) 并接入 [CapabilitiesPage.tsx](../../apps/web/src/pages/CapabilitiesPage.tsx)，支持新建/编辑/文件与文件夹上传、实时静态安全预检、待风险确认门禁与本机只读导入向导；同步升级右侧 [connection.tsx](../../apps/web/src/components/details/connection.tsx) 与 [SidePanel.tsx](../../apps/web/src/components/SidePanel.tsx) 展示任务挂载技能包与按任务临时开关。

## 自动测试

源码冻结后执行全仓验证（零新增 npm 依赖、零真实付费调用 $0）：

| 命令 | 覆盖与结果 |
|---|---|
| `npm run typecheck` | 通过（4/4 工作区：`@aic/adapters`、`@aic/gateway`、`@aic/protocol`、`@aic/web` 全零报错） |
| 全部 4 工作区 Vitest 测试 | 通过：**1,304 通过 / 5 跳过 / 0 失败**（`@aic/adapters` 121 通过 / `real.smoke.test.ts` 5 跳过；`@aic/protocol` 15 文件 76 通过；`@aic/web` 32 文件 209 通过；`@aic/gateway` 61 文件 898 通过，其中在单次长跑因后台 CPU 争用超时的 6 个旧文件均在独立复测中 100% 通过：`workspace-operations` 42/42、`automatic-permissions` 14/14、`step-1.8-handoff` 2/2、`handoff-execution` 16/16、`independent-attachments` 19/19、`independent-task-runtime` 34/34） |
| `npm run build` | 通过（`@aic/web` `tsc -p tsconfig.json && vite build` 459 模块产出构建产物） |
| `git diff --check` | 通过（零空白/换行异常） |

其中第 2.4 步新增定向测试：

- [packages/protocol/src/skills.test.ts](../../packages/protocol/src/skills.test.ts)（2 项）：`CreateSkillBody`/`ScanLocalSkillsBody`/`ImportLocalSkillsBody`/`SkillDetail`/`SkillLocalScanResult`/`TaskSkillsState` 严格校验。
- [packages/gateway/test/skills.test.ts](../../packages/gateway/test/skills.test.ts)（6 项）：
  1. 标准 `agentskills.io` YAML Frontmatter 解析与无头部回退提取；
  2. 静态扫描器精准拦截隐藏零宽/BiDi 字符（含 `[U+200B]` 可视化摘录）、伪造防伪信封、审批绕过、凭据读取、`curl|sh` 管道执行、记忆后门与附带脚本；
  3. 凭据路径防火墙拒绝 `~/.claude` 根目录、`.credentials.json`、`~/.codex/auth.json`、`~/.workbuddy/skills`、`~/.ssh`、`.aic-data`、`.env`，仅放行 `~/.agents/skills` 与第三方纯 `skills/` 子目录；
  4. 高危/带脚本技能默认拦截不启用、未确认启用返回 400、显式确认放行与二次偷改自动重锁；
  5. 隔离 `%TEMP%` 夹具目录只读扫描导入（零本机路径/凭据泄露、原目录零修改）及局域网 6 个写/扫描/导入接口全部 403；
  6. 独立 Agent 端到端闭环：系统提示词仅含 L1 摘要（不含 L3 细则）、模型按需调用 `aic_skills__read` 读取附属文件并获 `external_data` 围栏、按任务临时停用后自动撤下工具。
- [apps/web/src/capabilities.test.tsx](../../apps/web/src/capabilities.test.tsx)（扩充至 4 项）：新增 2.4 技能包空态、待风险确认拦截栏、脚本徽章、局域网只读禁用态与右侧 `ConnectionDetails` 技能包挂载展示。

## 实际操作

使用构建产物在 `%TEMP%\aic-preview-24` 隔离临时数据目录（搭配 `%TEMP%\aic-preview-24-skills` 合成技能夹具，不触碰 `.aic-data` 或任何真实用户目录，花费 $0）启动独立预览 Gateway（`http://127.0.0.1:17905`），在浏览器完成全部 7 项实操验证（宿主观测访问源 `http://127.0.0.1:17905`，零被拦截外部来源，全程 `0` 控制台报错、`0` 页面报错、`0` 失败网络请求）：

1. **能力中心「技能包（Skills）」空态（1280×800）**：进入 `#/p/pages.capabilities` 切换「技能包（Skills）」标签，确认空状态引导与「新建第一个技能」「本机只读导入」按钮清晰展示。
2. **新建干净技能与安全预检**：新建「策划案检查清单」，点击「运行静态安全预检」显示绿色「安全通过」，保存后列表展示「已启用」与「安全通过」徽章。
3. **高危技能自动拦截与核对丢弃**：新建含绕过审批与 `curl | bash` 指令的测试技能，预检标红「高危告警」并精确标出 `SKILL.md:2`；不勾选确认直接保存后自动处于「待风险确认」拦截态并展示警告条；展开「核对风险」查看告警与正文后二次确认删除清理。
4. **本机只读扫描导入向导**：取消默认 `~/.agents/skills` 仅扫 `%TEMP%\aic-preview-24-skills` 合成夹具，扫出 `combat-audit`（新发现 · 安全通过 · 2 个文件）与 `scripted-lint`（新发现 · 需留意 · 标出 `scripts/check.py`）；导入后前者自动启用、后者自动拦截为「待风险确认 · 含 1 个脚本」。
5. **任务右侧「详细 → 连接」技能包开关**：创建临时演示任务，右侧「连接」小节同时列出 `策划案检查清单`、`combat-audit`（已挂载）与 `scripted-lint`（待风险确认），拨动任务级开关验证「本任务已暂停（已连接 1 技能）」与恢复「已挂载（已连接 2 技能）」。
6. **浅色主题与手机窄屏（390×844）**：切换日间模式确认高对比度清晰可读；缩至 `390×844` 视口实测 `html`/`body`/`main`/底部导航均为 `390px` 宽度、3 张技能卡片均为 `350.67px`，零横向溢出。

## 未通过 / 未验证

| 项 | 原因 | 问题单 |
|---|---|---|
| 手机真机跨设备访问 | 沿用离线回环模拟，待本机 UAC 现场条件具备后统一补验真机 | [ISSUE-0149](../issues/ISSUE-0149-lan-phone-acceptance.md) |

## 备注

- 验收完成后已立即终止临时预览进程并删除 `%TEMP%\aic-preview-24` 与 `%TEMP%\aic-preview-24-skills` 目录，未触碰 `.aic-data` 或任何真实用户凭据目录。
