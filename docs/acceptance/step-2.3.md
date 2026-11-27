# 验收记录：第 2.3 步 能力中心（上）——MCP 工具管家与结果限流网关

| 项 | 值 |
|---|---|
| 日期 | 2026-11-27 |
| 提交范围 | 基于 `fc2c8d5`（第 2.3 步完整实现与文档收口） |
| 验收人 | AI Agent（离线单测 + 隔离预览实例浏览器实操） |
| 结论 | 通过 |

## 完成标准

对照 [phase-2.md 第 4 节（第 2.3 步）](../plans/phase-2.md) 与 [design.md 第 25 节](../design/design.md) 逐项核对：

- [x] **MCP 服务登记与智能粘贴解析**：
  - 新增共享协议 [packages/protocol/src/mcp.ts](../../packages/protocol/src/mcp.ts) 并在 [index.ts](../../packages/protocol/src/index.ts) 导出，密钥只写不回显；[db.ts](../../packages/gateway/src/db.ts) 追加迁移 v29（`mcp_servers` 与 `task_mcp_overrides`）。
  - 实现智能粘贴解析器 [packages/gateway/src/mcp/parser.ts](../../packages/gateway/src/mcp/parser.ts)：支持 JSON 片段（含 Markdown 代码块与多服务对象）、`claude mcp add` 命令、单行启动命令与 HTTP/HTTPS URL，自动识别桌面独占软件并拒绝命令拼接元字符、直接注册 Shell、受保护环境变量及 `file://`/含凭据 URL。
  - 所有环境变量与请求头密钥经 `SecretService`（Windows DPAPI）加密存入 `secrets` 表，数据库配置行零明文残留。
- [x] **一键连接测试、环境白名单与 45 秒看门狗**：
  - 实现 [packages/gateway/src/mcp/client.ts](../../packages/gateway/src/mcp/client.ts)：stdio 模式固定 `shell: false`、`windowsHide: true`，复用 2.1 `buildIsolatedSubprocessEnv` 隔离环境，登记 `ProcessRegistry` 并在超时或结束时 `killTree` 回收整棵进程树；HTTP 模式复用 2.1 `assertEgressUrl` + `createPinnedLookup` 拦截回打 Gateway 自身端口与内网/元数据探测。
- [x] **结果限流、超 40 工具折叠、防注入围栏与双端挂载**：
  - 实现 [packages/gateway/src/mcp/hub.ts](../../packages/gateway/src/mcp/hub.ts) 与 [acp-bridge.mjs](../../packages/gateway/src/mcp/acp-bridge.mjs)：单次返回自动剥除注入密钥、超 8,000 字符截断并生成结构化摘要、强制包裹 2.1 `external_data` 防伪信封；单服务工具数 > 40 自动折叠为 `search_tools` / `describe_tool` / `call_tool` 三步；`exclusive` 独占锁串行排队；接入独立 Agent（[task-runtime.ts](../../packages/gateway/src/independent/task-runtime.ts) 审批调用）与第三方 ACP 会话（[tasks.ts](../../packages/gateway/src/tasks.ts) 一次性令牌 `aic-mcp-hub` 桥接）。
- [x] **能力中心页与右侧连接面板闭环**：
  - 开启 `FeatureKey.PageCapabilities: true`（[http/system.ts](../../packages/gateway/src/http/system.ts)），新增 [http/mcp.ts](../../packages/gateway/src/http/mcp.ts) 路由（管理写与测试接口全部 `requireLocal`），新增 [CapabilitiesPage.tsx](../../apps/web/src/pages/CapabilitiesPage.tsx) 并补齐任务右侧 [connection.tsx](../../apps/web/src/components/details/connection.tsx) 真实 MCP 列表与按任务临时停用开关。
- [x] **全量门禁与文档收口**：零新增 npm 依赖、零真实付费调用（$0），同步 [design.md](../design/design.md)（v0.4.70）、[ui-design.md](../design/ui-design.md)（v0.3.52）、[README.md](../README.md) 与 [2026-11.md](../devlog/2026-11.md)。

## 自动测试

源码冻结后串行执行全仓验证（零真实付费调用，花费 $0，零新增 npm 依赖）：

| 命令 | 覆盖与结果 |
|---|---|
| `npm run typecheck` | 通过（4/4 工作区：`@aic/adapters`、`@aic/gateway`、`@aic/protocol`、`@aic/web` 全零报错） |
| `npm test` | 通过：**1,293 通过 / 5 跳过 / 0 失败**（`@aic/adapters` 121 通过 / `real.smoke.test.ts` 5 跳过；`@aic/gateway` 60 文件 890 通过；`@aic/protocol` 14 文件 74 通过；`@aic/web` 32 文件 208 通过；全部新增 2.3 单测零跳过） |
| `npm run build` | 通过（`@aic/web` `tsc -p tsconfig.json && vite build` 457 模块产出构建产物） |
| `git diff --check` | 通过（零空白/换行异常） |

其中第 2.3 步新增定向测试文件：

- [packages/protocol/src/mcp.test.ts](../../packages/protocol/src/mcp.test.ts)（2 项）：`CreateMcpServerBody` 的 stdio/http 互斥约束及 `McpServerSummary`/`McpParseResult`/`TaskMcpConnections` 严格校验。
- [packages/gateway/test/mcp.test.ts](../../packages/gateway/test/mcp.test.ts)（7 项，含离线夹具 [fake-mcp-server.mjs](../../packages/gateway/test/fixtures/fake-mcp-server.mjs)）：
  1. 智能粘贴 4 种格式（JSON / `claude mcp add` / 单行命令 / URL）与桌面独占自动识别；
  2. 拒绝命令注入（`&&` / `;` / `|` / `$(...)`）、直接注册 Shell、受保护环境变量（`AIC_*` / `NODE_OPTIONS` / `PATH`）及非法 URL；
  3. 密钥走 `secrets` 表加密且数据库与响应零明文残留，真实 stdio 握手、子进程环境变量白名单隔离、密钥脱敏、>8,000 字截断与 `external_data` 防注入信封转义 `[AIC-SOURCE: producer]`；
  4. 45 个工具服务自动折叠为 `search_tools` / `describe_tool` / `call_tool` 三步调用，挂起工具触发看门狗超时强杀后 `ProcessRegistry.livePids()` 为空（零孤儿进程）；
  5. HTTP MCP 走 2.1 出站门禁（放行独立本地测试服务，拦截回打 Gateway 自身监听端口与 `169.254.169.254`）；
  6. `/hello` 开放 `pages.capabilities`、按任务临时停用 MCP、局域网 GET 200 且 5 个管理写/测接口全部 403；
  7. 独立 Agent 任务端到端挂载、弹出审批并放行后调用本地假 MCP，模型收到 `external_data` 围栏结果并完成回复，`GET /tasks/:id/mcp` 显示 `activeForTask: true, lastCalledTool: 'echo'`。
- [apps/web/src/capabilities.test.tsx](../../apps/web/src/capabilities.test.tsx)（3 项）：空状态、独占锁/折叠徽章/DPAPI 加密计数、局域网只读禁用态与右侧 `ConnectionDetails` 真实列表渲染。

## 实际操作

使用构建产物在 `%TEMP%` 隔离临时数据目录（不触碰 `.aic-data` 或任何外部凭据目录；演示 Agent + 离线本地 `fake-mcp-server.mjs` + `127.0.0.2` 模拟局域网，花费 $0）启动独立预览 Gateway，在浏览器完成全部 7 项实操验证（宿主观测访问源 `http://127.0.0.1:6903`、`http://127.0.0.2:6903`，零被拦截外部来源，全程 `0` 控制台/页面报错）：

1. **本机配对与侧栏「能力」入口（1280×800）**：自动配对进入工作台后侧栏展示「能力」（`#/p/pages.capabilities`），空状态引导清晰。
2. **智能粘贴识别与 DPAPI 加密保存**：在智能粘贴框输入 `claude mcp add studio-demo -e DEMO_SECRET=... -- node fake-mcp-server.mjs`，点击「智能识别并填表」成功自动拆解名称、命令、参数与密钥行；保存后列表显示「已通过 DPAPI 加密保存 1 项」，页面可见正文与 DOM HTML 均零明文密钥残留。
3. **实时连接测试与工具清单预览**：点击「测试连接」421 ms 完成握手，状态变为绿色「就绪」、显示「2 个工具」与三步绿色勾测试日志，展开清单可见 `echo` 与 `hang` 及其中文说明。
4. **任务右侧「详细 → 连接」按任务开关联动**：打开演示任务展开右侧「连接」小节，摘要显示「已连接 1 个 MCP」，列表显示 `studio-demo`（`STDIO · 2 个工具 · 已挂载`），拨动任务级开关成功切至「本任务已暂停」并切回「已挂载」。
5. **浅色主题与手机窄屏（390×844）**：切至日间模式验证对比度及「技能包（Skills）」2.4 占位标签；在 `390×844` 视口确认容器宽度 ≤ 390px 零横向溢出，底部导航清晰显示「能力」图标。
6. **真实双标签局域网配对与只读锁（`127.0.0.2`）**：本机生成六位配对码并在 `127.0.0.2` 提交、本机点击「允许」后，局域网视角打开能力中心可见「已通过局域网连接」与温和提示「请到运行 AI Console 的电脑上操作（管理与测试 MCP 工具连接仅限本机）。」，且「添加 MCP」、启停开关、「测试连接」、「编辑」、「删除」按钮全部确认 `disabled`。

## 未通过 / 未验证

| 项 | 原因 | 问题单 |
|---|---|---|
| 手机真机跨设备访问 | 沿用第 1.7 / 2.1 / 2.2 步离线回环模拟（`127.0.0.2`），待现场电脑 UAC 条件具备后补验真机 | [ISSUE-0149](../issues/ISSUE-0149-lan-phone-acceptance.md) |

## 备注

- 预览完成后已立即终止临时守护进程并清理 `%TEMP%\aic-preview-*` 目录，未改动 `.aic-data` 或任何外部工具凭据目录。

---

## 第 2.3-R 步审查修复与架构加固补充验收（2026-11-27）

基于 `887c033` 完成全量对抗式代码审查与行业方案调研（对照 Anthropic `ToolSearch` / Claude Code、MetaMCP、Docker MCP Gateway、IBM ContextForge），采纳方案 A 落地 7 项审查缺陷修复与 4 项架构升级（零新增 npm 依赖、零真实付费调用 $0）：

1. **常驻 Stdio 单实例进程池 + Windows 无 Shell 解析（[pool.ts](../../packages/gateway/src/mcp/pool.ts)）**：
   - 每个启用中的 Stdio MCP 常驻单实例复用于多任务/多轮调用（有状态工具保持上下文、免反复冷启动）；空闲 10 分钟自动回收，45 秒看门狗超时或 `stdout` 单行超 2 MB OOM 防护时同步移出池并 `killTree` 强杀，崩溃后自动拉起自愈；改配置/停用/删除/Gateway 退出（[server.ts](../../packages/gateway/src/server.ts)）立刻回收。
   - Windows 下通过 `resolveStdioSpawn` / `resolveNpmCmdShim` 将 `npx`/`npm` 及标准 npm `.cmd` 垫片解析为 `node.exe` 直启（严禁 `shell: true`），拒绝非 Node `.cmd`/`.bat` 与 `wsl`/`mshta`/`wscript`/`cscript`。
2. **全局渐进式工具发现（[hub.ts](../../packages/gateway/src/mcp/hub.ts)）**：
   - 跨当前任务所有已启用 MCP 总工具数 > 25 或总 Schema > 24 KB 或单服务 > 40 时，自动收敛为全局统一 3 元工具（`aic_mcp__search_tools` / `aic_mcp__describe_tool` / `aic_mcp__call_tool`），支持跨服务检索与同名工具消歧。
3. **头尾摘要截断 + 任务级沙盒溢出分页回查（[overflow.ts](../../packages/gateway/src/mcp/overflow.ts) + [client.ts](../../packages/gateway/src/mcp/client.ts)）**：
   - 超过 8,000 字符按 UTF-16 代理对安全切分保留前 70% + 后 30%（避免丢掉末尾报错与劈断表情），完整脱敏正文暂存到受控内存缓存（不透明短 ID `out_xxxxxxxxxxxx`、零本机路径、任务级严格隔离、TTL/删任务清除），提供只读工具 `aic_mcp__read_output` 按页回查（单次上限 8,000 字符且必套 `external_data` 围栏）。
4. **Streamable HTTP 完整兼容、游标分页与并发/容错修复**：
   - [client.ts](../../packages/gateway/src/mcp/client.ts) 补齐 `event: message` SSE 解析、`notifications/initialized`、`Mcp-Session-Id` 会话复用与 404 自动重握手，`tools/list` 支持 `nextCursor` 分页（协议上限提升至 500 工具）。
   - [task-runtime.ts](../../packages/gateway/src/independent/task-runtime.ts) 捕获 MCP 运行时故障转为结构化工具错误交回模型（不再误触发 `recovery_required=1` 锁死任务）；[hub.ts](../../packages/gateway/src/mcp/hub.ts) 修复 `patch()` 改端点未清旧 `tools_json`、`test()` 并发停用覆写状态与 `authenticateBridge` 活动会话核验；[tasks.ts](../../packages/gateway/src/tasks.ts) 补齐启动失败吊销 `mcpBridge`；[SidePanel.tsx](../../apps/web/src/components/SidePanel.tsx) 补齐切换任务与卸载守卫。

### 补充验证结果

- **自动测试**：
  - `npm run typecheck`：4/4 工作区通过；
  - `npm test`：**1,295 通过 / 5 跳过 / 0 失败**（`@aic/gateway` 60 文件 892 通过，其中 [mcp.test.ts](../../packages/gateway/test/mcp.test.ts) 扩充至 9 项全通过）；
  - `npm run build`：457 模块产出构建产物。
- **隔离预览浏览器实操（`http://127.0.0.1:17904`，`%TEMP%\aic-preview-23r`，0 控制台/页面/网络报错）**：
  - 验证能力中心新版介绍文案、智能粘贴 `claude mcp add pool-demo ... --paged` 与 DPAPI 加密零明文泄露；
  - 验证「测试连接」229 ms 通过并显示「3 个工具（分页 2 页：echo / counter / hang）」与「已加入常驻共享池」步骤日志；
  - 验证任务右侧「详细 → 连接」挂载展示与按任务临时暂停/恢复开关稳定联动；验收后已终止预览进程并清理临时目录。
