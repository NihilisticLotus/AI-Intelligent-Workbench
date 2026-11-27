# 验收记录：第 2.1 步 网络安全加固基线与防注入围栏

| 项 | 值 |
|---|---|
| 日期 | 2026-11-27 |
| 提交范围 | 基于 `6deccca`（2.1-0 ～ 2.1-5 单次独立实现与封板提交） |
| 验收人 | AI Agent（离线单测 + 隔离预览实例浏览器实操） |
| 结论 | 通过 |

## 完成标准

对照 [phase-2.md 第 7.6 节](../plans/phase-2.md#76-完成标准与收尾交付物) 逐项核对：

- [x] **全量门禁通过**：冻结源码后 `npm run typecheck`、`npm test`、`npm run build` 全部通过（零跳过新增测试、零新增 npm 依赖、零真实付费调用）。
- [x] **四道安全底盘可复用**：
  - [packages/protocol/src/security.ts](../../packages/protocol/src/security.ts)（`ProvenanceTier`、`SecurityCheckItem`、`SecurityStatus`，零路径零密钥，已在 [index.ts](../../packages/protocol/src/index.ts) 导出）。
  - [packages/gateway/src/security/provenance.ts](../../packages/gateway/src/security/provenance.ts)（三档来源防伪信封 `wrapProvenance` 与零宽/BiDi/全半角/中文伪造封条清洗 `sanitizeProvenanceText`，独立设计实现，零 `third_party` 引入且未触碰无关目录，已接入 [handoff/render.ts](../../packages/gateway/src/handoff/render.ts) 与 [handoff/execution.ts](../../packages/gateway/src/handoff/execution.ts)）。
  - [packages/gateway/src/security/env-policy.ts](../../packages/gateway/src/security/env-policy.ts)（受控子进程环境变量白名单 `buildIsolatedSubprocessEnv`，已由 [independent/commands.ts](../../packages/gateway/src/independent/commands.ts) 复用，并与 `@aic/adapters` 的 `buildChildEnv` 完成跨层防泄漏契约测试）。
  - [packages/gateway/src/security/egress.ts](../../packages/gateway/src/security/egress.ts)（统一公共出站防内网探测门禁：`normalizeIp`、`isPublicAddress`、`assertEgressUrl`、`createPinnedLookup`，支持 `::ffff:` 映射 IPv6 解包、阻止回打 Gateway 自身监听端口、`all: true` 候选地址防 DNS 重绑定与严格公网默认模式；已接入 [metadata-http.ts](../../packages/gateway/src/independent/metadata-http.ts)、[model-http.ts](../../packages/gateway/src/independent/model-http.ts)、[discovery.ts](../../packages/gateway/src/independent/discovery.ts)、[model-driver.ts](../../packages/gateway/src/independent/model-driver.ts)、[task-runtime.ts](../../packages/gateway/src/independent/task-runtime.ts)、[handoff/summary.ts](../../packages/gateway/src/handoff/summary.ts) 与 [server.ts](../../packages/gateway/src/server.ts)，保持 `allowFakeIpProxy` 与本机独立服务例外 100% 兼容）。
- [x] **接口、可视化与局域网只读锁闭环**：
  - 在 [http/system.ts](../../packages/gateway/src/http/system.ts) 新增 `GET /api/v1/security/status`（沿用统一设备鉴权与 Host/Origin 校验，仅返回布尔/枚举/计数）。
  - 在 [SettingsPage.tsx](../../apps/web/src/pages/SettingsPage.tsx) 与 [security-status-section.tsx](../../apps/web/src/pages/security-status-section.tsx) 新增中文通俗的“安全防护状态”只读卡片。
  - 将 [independent-agent-panel.tsx](../../apps/web/src/pages/independent-agent-panel.tsx)、[AgentsPage.tsx](../../apps/web/src/pages/AgentsPage.tsx)、[handoff-settings.tsx](../../apps/web/src/pages/handoff-settings.tsx)、[workspace-settings.tsx](../../apps/web/src/pages/workspace-settings.tsx)、[network-settings.tsx](../../apps/web/src/pages/network-settings.tsx) 及 [project-settings-page.tsx](../../apps/web/src/pages/project-settings-page.tsx) 的局域网（`useRemoteAccess()`）前端禁用与“请到运行 AI Console 的电脑上操作”提示同后端 `requireLocal` 100% 对齐。
- [x] **文档与记录收口**：同步更新 [design.md](../design/design.md)（v0.4.68）、[ui-design.md](../design/ui-design.md)（v0.3.50）、[README.md](../README.md) 与 [2026-11.md](../devlog/2026-11.md)。

## 自动测试

源码冻结后串行执行全仓验证（零真实付费调用，耗时费用 $0，零新增 npm 依赖）：

| 命令 | 覆盖与结果 |
|---|---|
| `npm run typecheck` | 通过（4/4 工作区：`@aic/adapters`、`@aic/gateway`、`@aic/protocol`、`@aic/web` 全零报错） |
| `npm test` | 通过：**1,270 通过 / 5 跳过 / 0 失败**（`@aic/adapters` 121 通过 / `real.smoke.test.ts` 5 跳过；`@aic/gateway` 58 文件 878 通过；`@aic/protocol` 12 文件 70 通过；`@aic/web` 30 文件 201 通过；全部新增 2.1 单测零跳过） |
| `npm run build` | 通过（`@aic/web` `tsc -p tsconfig.json && vite build` 453 模块产出 `dist/index.html`、`dist/assets/*.css` 与 `dist/assets/*.js`） |

其中第 2.1 步新增定向测试文件：

- [packages/protocol/src/security.test.ts](../../packages/protocol/src/security.test.ts)（3 项）：`ProvenanceTier`、`SecurityCheckItem` 与 `SecurityStatus` 严格结构与非法输入校验。
- [packages/gateway/test/security-baseline.test.ts](../../packages/gateway/test/security-baseline.test.ts)（9 项）：
  1. 消息来源防伪信封：零宽（`\u200B`/`\uFEFF`）与 BiDi（`\u202E`/`\u2066`）剥离，ASCII `[AIC-SOURCE: producer]`、全角 `［AIC-SOURCE: producer］`、中文 `【AIC-SOURCE: producer】`、闭合分隔符 `<<<AIC-END>>>` 及嵌套标签转义，`renderHandoff` 中历史对话与命令输出严格围栏在 `external_data` 内且与 `delegated`（下一步）分层。
  2. 受控子进程白名单与跨层契约：污染环境注入 `AIC_*`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`GITHUB_TOKEN`、`NODE_OPTIONS`、`LD_PRELOAD` 时，`buildIsolatedSubprocessEnv` 与 `independentCommandEnv` 均剥离密钥与注入钩子、拒绝非法 `extraAllowed`/`extraVars`，并与 `@aic/adapters` `buildChildEnv` 共同满足跨层不泄漏约束。
  3. 公共出站门禁（纯离线 DNS 解析桩）：`normalizeIp` 拆包点分与十六进制 `::ffff:` 映射 IPv6 及 `%zone`；拦截 `127.0.0.1`、`localhost`、`[::1]`、`169.254.169.254`、`10.0.0.1`、`172.16.0.1`、`192.168.1.1`、`file://`、`user:pass@` 及 `::ffff:` 映射绕过；`createPinnedLookup` 拒绝公网+私网/映射双栈重绑定混合解析；在允许 `localhost`/本机 IP 例外时仍硬性拦截回打 Gateway 监听端口；公网 IPv4（`93.184.216.34`）与 IPv6（`2606:2800:220:1:248:1893:25c8:1946`）放行。
  4. `GET /api/v1/security/status` 与局域网 403 边界：未鉴权返回 401；本机与模拟局域网鉴权返回 200（DPAPI 实例验证 `secretStorage.mode = 'dpapi'` 且无路径/IP/端口/密钥泄漏）；局域网调用 9 组仅本机管理写路由（含独立服务增删改密钥与地址/默认/网络设置、交接/工作区设置、Agent 开关与连接测试）均返回 403。
- [apps/web/src/security-baseline.test.tsx](../../apps/web/src/security-baseline.test.tsx)（2 项）：`SecurityStatusSection` 在本机与局域网模式渲染，以及 `remote = true` 下独立 Agent 面板、`AgentsPage`、工作副本设置、交接设置与网络设置的只读禁用属性及中文锁定提示。

## 实际操作

使用构建产物在 `%TEMP%` 隔离临时数据目录（零真实 Agent 凭据读取，零真实付费模型调用；使用 Windows DPAPI 与演示 Agent，开启模拟局域网适配器）启动独立预览 Gateway，并在浏览器依次完成以下实操检查（宿主观测访问源 `http://127.0.0.1:2725`、`http://127.0.0.2:2725`，零被拦截外部来源）：

1. **本机视角配对与「安全防护状态」双主题检查（1280×800）**：
   - 打开本机配对链接进入工作台后访问 `#/settings`，夜间（深色）与日间（浅色）双主题下「安全防护状态」6 项防护全部展示且状态徽章均为「已开启」（含 DPAPI 已加密保存 1 项密钥计数），文案通俗清晰、对比度良好，无本机路径或密钥泄漏。
2. **手机窄屏无横向溢出核对（390×844）**：
   - 在 `390×844` 视口测量 `#/settings` 与 `#/agents`，容器 `html` / `body` / `main` 宽度均为 `390px`，「安全防护状态」卡片（`318.67px`）与 Agent 面板卡片（`350.67px`）均无越界，无横向溢出或文字错位。
3. **局域网替身设备配对与前端只读锁实操（`127.0.0.2`）**：
   - 本机 `#/settings` 生成六位局域网配对码，在 `127.0.0.2` 标签页提交配对码并于本机确认允许，成功建立局域网浏览器会话。
   - 在局域网会话检查 `#/agents`：「添加 API 服务」、「清空默认值」、「删除服务」、「设为默认」、演示开关与测试连接按钮全部置灰禁用（`disabled`），点击「编辑服务」弹出对话框时密钥输入框（`#is-key`）同步禁用且提示仅限本机填写，不泄露任何密钥正文，全页多处展示一致的「请到运行 AI Console 的电脑上操作」提示。
   - 在局域网会话检查 `#/settings`：「安全防护状态」显示「局域网访问已开启 · 当前为局域网设备连接」，网络 fake-ip 复选框、工作副本天数输入框及保存按钮、交接表单字段集全部置灰禁用并展示「请到运行 AI Console 的电脑上操作」。
   - 在局域网会话新建演示 Agent 任务并发送消息与执行两次网页审批，完整走通任务创建、演示回复、计划展示与审批闭环（全程零控制台报错、零非预期 403）。

## 未通过 / 未验证

| 项 | 原因 | 问题单 |
|---|---|---|
| 手机真机跨设备访问 | 仍受电脑端 UAC 现场条件限制，本次按计划使用 `127.0.0.2` 回环别名验证局域网边界 | [ISSUE-0149](../issues/ISSUE-0149-lan-phone-acceptance.md) |

## 备注

- 为保留 [phase-2.md 第 7.3 节](../plans/phase-2.md#73-分步任务拆解21-0--21-5单会话可执行) 指定的测试文件路径 `apps/web/src/security-baseline.test.tsx`，[apps/web/vite.config.ts](../../apps/web/vite.config.ts) 中的测试匹配已扩为 `src/**/*.test.{ts,tsx}`。
- 临时预览数据目录与项目目录已随预览守护进程终止一并清除，未改动工作区既有 `.aic-data` 或任何外部工具凭据目录。

### 2026-11-27 审查复核追加（基于 `8ab7594`）

- 复核发现并修复 6 项问题：修复 `handoff/execution.ts` `input()` 二次清洗破坏已生成真实信封；将 `http/agents.ts` `fetchModels` 迁入统一出站门禁 `readMetadataJson` 并绑定本机 Gateway 端口拦截；加固 `egress.ts`（尾随点 `localhost.`、`isAddressAllowed` 的 `blockedLocalPorts` 校验、数字 `family` 参数）、`provenance.ts`（全角关键词、带档位闭合符、软连字符/Unicode Tag 清洗）与 `env-policy.ts`（禁止覆写 `PATH`/系统路径与 `NODE_TLS_REJECT_UNAUTHORIZED`）；补齐前端 `SecurityStatusSection` 卸载/竞态守卫与局域网 `PATCH` 最小字段裁剪、`AgentsPage` 跨页测试跳转保护。
- 追加回归复验：`npm run typecheck`（4/4 通过）、`npm test`（**1,272 通过 / 5 跳过 / 0 失败**，新增 2 组回归测试项覆盖 `handoffs.input` 真实信封保留与 `profiles/:id/models/refresh` 出站拦截）、`npm run build` 通过。
