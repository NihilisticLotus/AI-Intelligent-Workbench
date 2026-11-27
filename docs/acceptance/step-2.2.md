# 验收记录：第 2.2 步 监控告警、调用账本与花费上限阀门

| 项 | 值 |
|---|---|
| 日期 | 2026-11-27 |
| 提交范围 | 基于 `1ae6cfa`（第 2.2 步完整实现与文档收口） |
| 验收人 | AI Agent（离线单测 + 隔离预览实例浏览器实操） |
| 结论 | 通过 |

## 完成标准

对照 [phase-2.md 第 2.1 节 #3（D-2）与第 4 节（第 2.2 步）](../plans/phase-2.md) 逐项核对：

- [x] **全局调用与用量账本（诚实口径）**：
  - 新增共享协议 [packages/protocol/src/monitor.ts](../../packages/protocol/src/monitor.ts)（`TaskSource`、`UsageCapRule`、`UpsertUsageCapBody`、`UsageCapEvaluation`、`MonitorOverview` 等），在 [index.ts](../../packages/protocol/src/index.ts) 导出并新增 `ErrorCode.UsageCapExceeded`、`ErrorActionKey.OpenMonitor` 与 `Task.source` / `CreateTaskBody.source`。
  - 在 [packages/gateway/src/monitor.ts](../../packages/gateway/src/monitor.ts) 实现 `MonitorService`：按本地自然日与自然月准确统计 `turn_usage`、近 7 天每日趋势，以及独立请求预留（`independent_request_attempts`、`handoff_summary_requests`）和第三方 ACP `session.usage` 显式上报费用（按会话与币种取最大累计值去重、跳过 `independent` 防重算）。
  - 严守诚实口径：未报告 Token 字段保持 `null`、前端以斜体“未报告”展示；无上报金额的订阅制 Agent 保持 `reportedCosts: []`、`usedCostMicros: null`，前端明确提示“未报告金额（订阅制不估价）”，绝不猜测单价或伪造 `$0`。
- [x] **Token 与费用双口径上限阀门**：
  - [packages/gateway/src/db.ts](../../packages/gateway/src/db.ts) 增量迁移至 v28（`CREATE TABLE IF NOT EXISTS usage_cap_rules` + `idx_turn_usage_at` / `idx_events_type_ts`），与全量历史版本升级回归 100% 兼容。
  - 支持配置全工作台或单 Agent、每日或每月的 Token 上限和/或费用上限（整数 micros + 三字母币种）。
  - 80% 触发黄色告警（`warn`，不拦截）；100% 触发超限（`exceeded`），在 [tasks.ts](../../packages/gateway/src/tasks.ts) 的 `create()`（非草稿）与 `prompt()` 启动新回合前校验：默认 `block_unattended` 仅拦 `automation`/`webhook`/`delegated`（返回 `429 usage.cap_exceeded` 与 `open_monitor` 按钮）并放行制作人 `manual` 消息；`block_all` 同步拦截手动新回合；**绝不打断正在运行中的回合**。
- [x] **接口与导航闭环**：
  - 新增 [packages/gateway/src/http/monitor.ts](../../packages/gateway/src/http/monitor.ts) 挂载 `GET /api/v1/monitor/overview`、`GET /api/v1/monitor/caps`、`PUT /api/v1/monitor/caps`（`requireLocal`）与 `DELETE /api/v1/monitor/caps/:id`（`requireLocal`）；[http/system.ts](../../packages/gateway/src/http/system.ts) 开启 `FeatureKey.PageMonitor: true`。
  - 新增 [apps/web/src/pages/MonitorPage.tsx](../../apps/web/src/pages/MonitorPage.tsx)，接入侧栏与移动端底部导航（`#/p/pages.monitor` 与 `#/monitor`），支持深浅双主题 8 色图表色板、纯 SVG 7 天堆叠柱状图、`[按 Agent | 按项目]` / `[图表 | 表格]` / `[今日 | 本月]` 切换、Agent 健康状态与快捷操作、最近动态筛选，以及局域网下（`useRemoteAccess()`）全部上限写操作温和禁用与统一提示。
- [x] **全量门禁与文档收口**：冻结源码通过 `npm run typecheck`、`npm test`、`npm run build`、`git diff --check`（零新增 npm 依赖、零真实付费调用 $0），同步 [design.md](../design/design.md)（v0.4.69）、[ui-design.md](../design/ui-design.md)（v0.3.51）、[README.md](../README.md) 与 [2026-11.md](../devlog/2026-11.md)。

## 自动测试

源码冻结后串行执行全仓验证（零真实付费调用，花费 $0，零新增 npm 依赖）：

| 命令 | 覆盖与结果 |
|---|---|
| `npm run typecheck` | 通过（4/4 工作区：`@aic/adapters`、`@aic/gateway`、`@aic/protocol`、`@aic/web` 全零报错） |
| `npm test` | 通过：**1,280 通过 / 5 跳过 / 0 失败**（`@aic/adapters` 121 通过 / `real.smoke.test.ts` 5 跳过；`@aic/gateway` 59 文件 883 通过；`@aic/protocol` 13 文件 72 通过；`@aic/web` 31 文件 204 通过；全部新增 2.2 单测零跳过） |
| `npm run build` | 通过（`@aic/web` `tsc -p tsconfig.json && vite build` 455 模块产出构建产物） |
| `git diff --check` | 通过（零空白/换行异常） |

其中第 2.2 步新增定向测试文件：

- [packages/protocol/src/monitor.test.ts](../../packages/protocol/src/monitor.test.ts)（2 项）：`TaskSource` 枚举、`UpsertUsageCapBody` 合法与非法组合（空上下限、global 携带 agent、agent 缺失 agent、非法币种）及 `MonitorOverview` 严格结构校验。
- [packages/gateway/test/monitor.test.ts](../../packages/gateway/test/monitor.test.ts)（3 项）：
  1. 跨自然日（`2026-11-30 23:59:59+08:00` → `2026-12-01 00:00:00+08:00`）与跨自然月清零、7 天趋势保留；订阅制无金额保持 `reportedCosts: []` 不伪造 `$0`；ACP `session.usage` 多次累计金额取最大值去重并与 `handoff_summary_requests` 独立预留准确加总。
  2. 80% 黄色告警（`level: 'warn'`，不拦截）、100% 默认 `block_unattended` 拦截 `automation`/`webhook`/`delegated`（`429 usage.cap_exceeded` + `open_monitor`）同时放行 `manual`、上限拦截记为 `cap` 动态不误计 Agent 故障；`block_all` 拦截手动新任务但**正在运行中的演示回合顺利跑完进入 `review`**；删除规则后立即恢复放行。
  3. `/hello` 返回 `features['pages.monitor'] === true`；未鉴权 401；本机与模拟局域网（`127.0.0.2`）GET 均 200，局域网 `PUT/DELETE /monitor/caps` 全部返回 403。
- [apps/web/src/monitor.test.tsx](../../apps/web/src/monitor.test.tsx)（3 项）：空状态友好提示且无 `$0` 伪造；80% 黄色告警横幅、`.meter.hot`、SVG 图表与斜体“未报告”；100% 红色超限横幅、`.meter.over`、已报告费用展示及局域网 `remote = true` 禁用上限写操作与登录按钮。

## 实际操作

使用构建产物在 `%TEMP%` 隔离临时数据目录（不触碰 `.aic-data` 或任何外部凭据目录；演示 Agent，零真实付费调用，预设近 3 日 600 / 1,200 / 1,800 Token 调用账本并开启 `127.0.0.2` 模拟局域网）启动独立预览 Gateway，在浏览器完成全部 7 项实操验证（宿主观测访问源 `http://127.0.0.1:12611`、`http://127.0.0.2:12611`，零被拦截外部来源，全程 `0` 控制台/页面报错）：

1. **本机配对与侧栏导航（1280×800）**：打开本机配对链接进入工作台，侧栏可见「监控」入口，点击进入 `#/p/pages.monitor`。
2. **深色主题数据与视图切换**：概览四格正常展示（「今日消耗」显示 `1,800` 及「未报告金额（订阅制不估价）」，无 `$0`）；近 7 天 SVG 堆叠柱状图正确绘制 3 日柱形（`11-25`、`11-26`、`11-27`）及图例；切换「表格」/「图表」、「按项目」（战棋演示项目 `1,800`）与「本月」（3 回合 `3,600`）均平滑无报错。
3. **Token 上限阈值三态联动实操**：
   - 新增全工作台每日上限 `2000`（90%）→ 出现黄色预警横幅「接近花费或 Token 上限（1 条规则已达 80%）」、「接近上限」徽章与 `.meter.hot` 黄色进度条。
   - 编辑上限降至 `1500`（120%）→ 切换为红色达限横幅「已触及花费或 Token 上限（1 条规则达 100%）」「已自动暂停后台无人值守任务，你亲手发送的消息不受影响」及 `.meter.over` 红色进度条。
   - 编辑上限提高至 `10000`（18%）→ 顶部横幅立即消失，状态恢复「正常」。
4. **浅色主题检查**：点击侧栏主题按钮切至日间模式（`data-theme="light"`），卡片、状态徽章与浅色 `.viz` 图表色板对比度清晰。
5. **移动端窄屏核对（390×844）**：`html` / `body` / `main` 容器宽度均为 `390px`，卡片与可横向滚动表格均在视口内无页面横向溢出，底部导航清晰显示「监控」图标。
6. **真实双标签局域网配对与只读锁核对（`127.0.0.2`）**：在本机 `#/settings` 生成六位配对码并于 `127.0.0.2` 提交、本机点击「允许」建立真实局域网会话；打开 `http://127.0.0.2:12611/#/p/pages.monitor`，侧栏左下显示「已通过局域网连接」，完整读取账本与 `1,800 / 10,000（18%）` 上限进度，展示温和提示「请到运行 AI Console 的电脑上操作（修改花费与 Token 上限仅限本机）。」，且「新增上限」、规则启停开关、「编辑」、「删除」按钮全部确认 `disabled`。

## 未通过 / 未验证

| 项 | 原因 | 问题单 |
|---|---|---|
| 手机真机跨设备访问 | 沿用第 1.7 / 2.1 步离线回环模拟（`127.0.0.2`），待现场电脑 UAC 条件具备后补验真机 | [ISSUE-0149](../issues/ISSUE-0149-lan-phone-acceptance.md) |

## 备注

- 预览完成后已立即终止临时守护进程并清理 `%TEMP%\aic-preview-*` 目录，未改动 `.aic-data` 或任何外部工具凭据目录。
