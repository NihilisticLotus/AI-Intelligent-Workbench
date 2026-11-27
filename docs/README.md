# 文档总目录

存放规则见 [.agent/records.md](../.agent/records.md)。新增文档时同时更新这里。

## 设计

| 文档 | 说明 |
|---|---|
| [design/design.md](design/design.md) | 架构设计 v0.4.69：第二阶段 2.2 监控告警、调用账本与花费/Token 双口径上限阀门（迁移 v28 `usage_cap_rules`、`MonitorService`、`/monitor/*` 接口与 `PageMonitor` 开关）；2.1 网络安全加固基线与防注入围栏；2026-11-26 全项目审查安全与稳定性加固；Antigravity 原生接入、受控 ZCode 桥接与新版 Codex 适配，`.gemini` 写保护、局域网 UAC、G1/N2、独立任务与交接契约 |
| [design/ui-design.md](design/ui-design.md) | 界面设计 v0.3.51：开放监控页（概览四格、80%/100% 预警横幅、花费与 Token 上限阀门及局域网只读锁、近 7 天 SVG 趋势与诚实口径账本、Agent 健康与最近动态）；2.1 设置页「安全防护状态」卡片与局域网只读锁对齐；Antigravity 与 ZCode 接入、局域网设备与访问、手机布局及统一选择器 |
| [prototype/index.html](prototype/index.html) | 可点击原型（双击打开）：工作台、看板、Agent、资产、生成、自动化、监控、能力 |

## 调研

| 文档 | 日期 | 说明 |
|---|---|---|
| [research/usage-quota.md](research/usage-quota.md) | 2026-11-13 | 1.4 用量与额度调研：固定版本、官方来源、三家及独立 Agent 三轮真实结果；用户决定本步保持额度未知 |
| [research/context.md](research/context.md) | 2026-11-05 | 切换模型不丢上下文：记忆方案、同类产品、ACP 能力 |
| [research/handoff.md](research/handoff.md) | 2026-11-06 | 各家工作台的会话交接做法，自动交接方案 |
| [research/media-gen.md](research/media-gen.md) | 2026-11-06 | 图片 / 视频 / 音频生成选型，28 条关键断言已独立核查 |
| [research/independent-agent.md](research/independent-agent.md) | 2026-11-08 | 独立 Agent 调研总论：多 API / 多模型、能力识别、执行器底线与验证门槛 |
| [research/cc-switch-model-metadata.md](research/cc-switch-model-metadata.md) | 2026-11-08 | CCSwitch 固定源码：模型列表、预设与 models.dev 补全的真实边界 |
| [research/model-capability-detection.md](research/model-capability-detection.md) | 2026-11-08 | 各协议模型元数据、上下文语义、图片与思考参数、来源及未知状态 |
| [research/independent-agent-engines.md](research/independent-agent-engines.md) | 2026-11-08 | Pi、Cline、OpenCode、Goose 的能力矩阵、认证风险与离线选型门槛 |
| [research/deepseek-harness.md](research/deepseek-harness.md) | 2026-11-08 | DeepSeek Harness 固定源码：服务与循环、工具 schema、失败尝试、上下文与能力声明；对照现有宿主及后续采用门槛 |
| [research/openmausbot-openmanus.md](research/openmausbot-openmanus.md) | 2026-11-26 | OpenMausBot 与 OpenManus 固定版本只读调研：9 维能力与安全核查、对照矩阵、取舍、Apache-2.0 借用边界及网络安全前置条件 |

## 计划

| 文档 | 说明 |
|---|---|
| [plans/phase-1.md](plans/phase-1.md) | 第一阶段：本机浏览器版，8 步（1.8 已完成 Antigravity 及 ZCode、Codex 更新支持与测试，见第 14.5 节；仅剩 1.7 手机真机待现场补验）；第 2 节是接口规则 |
| [plans/phase-2.md](plans/phase-2.md) | 第二阶段：安全加固基线（含第 7 节 2.1 实现规格与任务拆解）、监控与花费上限、能力中心、常驻岗位与长期记忆、多岗位协作与侧聊、日常自动化及受控浏览朗读（9 步） |

## 过程记录

| 目录 | 说明 |
|---|---|
| [acceptance/](acceptance/) | 每一步的验收记录 |
| [acceptance/step-2.2.md](acceptance/step-2.2.md) | 2026-11-27 第二阶段第 2.2 步通过：监控告警、调用账本（诚实口径不伪造 `$0`）与 Token/费用双口径上限阀门、`MonitorPage` 开放及深浅双主题/阈值联动/390×844/双标签局域网实操验收，1,280 / 5 |
| [acceptance/step-2.1.md](acceptance/step-2.1.md) | 2026-11-27 第二阶段第 2.1 步通过：网络安全加固基线与防注入围栏、自检接口与设置页「安全防护状态」、局域网前端只读锁对齐及双主题/390×844/回环局域网实操验收，1,270 / 5 |
| [acceptance/workbench-review-2026-11-26.md](acceptance/workbench-review-2026-11-26.md) | 2026-11-26 全项目代码审查与修复验收：关闭 ISSUE-0180、0182～0188，新增 17 项回归单测，全仓 1,256 / 5，深浅双主题与 390×844 浏览器复核 |
| [acceptance/step-1.8.md](acceptance/step-1.8.md) | 2026-11-26 第 1.8 步通过：Antigravity 官方 `agy acp` 接入、ZCode 受控桥接（`build` 模式）、Codex 2.12.0 升级，三家真实冒烟与三端自动交接合并验收，1,239 / 5 |
| [全工作台代码审查](acceptance/workbench-review-2026-11-21.md) | 2026-11-21 全工作台审查范围、问题与回归验证 |
| [acceptance/step-1.7.md](acceptance/step-1.7.md) | 局域网浏览器和手机端适配的分阶段验收、证据与当前进度 |
| [acceptance/step-1.6.md](acceptance/step-1.6.md) | 上下文与交接的分阶段验收、第 12.13 节逐项结论及失败后续聊的双主题复核 |
| [acceptance/step-1.5.md](acceptance/step-1.5.md) | 1.5 按批准范围收尾；1067 / 3、逐条完成标准、真实补验缺口与当前进度 |
| [acceptance/step-1.4.md](acceptance/step-1.4.md) | 2026-11-13 第 10.15 节五项通过；853 通过 / 3 跳过，真实三轮与双主题证据、反向回归、当前进度；原生拖入未验证见 ISSUE-0070 |
| [acceptance/step-1.3.md](acceptance/step-1.3.md) | 2026-11-12 已判定通过；完整历史、真实补验和遗留问题见末尾结论，1.4 接手的 ISSUE-0060～0062 已修复 |
| [devlog/](devlog/) | 开发笔记，每月一个文件，只追加 |
| [issues/](issues/README.md) | 问题收纳：总表 + 每个问题一个文件 |
| [ISSUE-0147](issues/ISSUE-0147-lan-pairing-qr.md) | 局域网扫码暂缓，保留地址与配对码流程 |
| [ISSUE-0148](issues/ISSUE-0148-lan-port-test-exclusion.md) | Windows 回环顺延测试的相邻端口夹具 |
| [ISSUE-0149](issues/ISSUE-0149-lan-phone-acceptance.md) · [ISSUE-0179](issues/ISSUE-0179-lan-uac-preflight.md) | 手机真机验收与 Windows UAC 现场条件 |
| [ISSUE-0180](issues/ISSUE-0180-hello-worktree-feature-flag.md) | `/api/v1/hello` 的 `Worktrees`/`RealAgents`/`FsBrowse` 功能开关动态对齐（已于 2026-11-26 审查修复关闭） |
| [ISSUE-0181](issues/ISSUE-0181-phase1-antigravity-zcode-codex-refresh.md) | 第一阶段 1.8：Google Antigravity 接入与新版 ZCode、Codex 适配测试（已完成关闭） |
| [ISSUE-0182～0188](issues/README.md) | 2026-11-26 全项目代码审查修复项（ACP 权限归一、ZCode 配置隔离、权限规则守卫、局域网接口边界、工作区恢复、环境脱敏与网页安全/交接体验，已全部关闭） |

### 2026-11-14 用量审查修复

- [ISSUE-0071：部分用量覆盖提示](issues/ISSUE-0071-partial-usage-coverage.md)
- [ISSUE-0072：无回复轮次用量](issues/ISSUE-0072-missing-reply-usage.md)
- 修复验证与浏览器限制追加在 [step-1.4](acceptance/step-1.4.md)，不覆盖历史验收。
- [ISSUE-0073：收尾文件宿主复验](issues/ISSUE-0073-file-host-validation-timeout.md)

### 2026-11-15 任务看板

- [ISSUE-0090：看板拖动手柄验收](issues/ISSUE-0090-board-pointer-drag.md)
- [ISSUE-0091：CodeBuddy 真实补验额度限制](issues/ISSUE-0091-codebuddy-workspace-real-quota.md)
- [ISSUE-0092：独立任务看板失败原因](issues/ISSUE-0092-board-independent-failure.md)
- [1.5 验收与当前进度](acceptance/step-1.5.md)

- [ISSUE-0093：显式模型自动回退](issues/ISSUE-0093-explicit-model-fallback.md)

### 2026-11-18 交接实现审查

- [原会话恢复](issues/ISSUE-0126-handoff-failed-session-selection.md)
- [历史环境附件脱敏](issues/ISSUE-0127-handoff-environment-attachment-history.md)
- [工作副本保留项目自有说明的删除状态](issues/ISSUE-0128-workspace-deleted-owned-artifact.md)
- [无回应计时用例的起点](issues/ISSUE-0129-idle-watchdog-test-start.md)
- [真实交接验收的流式回复](issues/ISSUE-0130-handoff-acceptance-streamed-reply.md)
- [真实交接后缺少成果文件](issues/ISSUE-0131-luna-handoff-result-missing.md)
- [工具记录归并不完整影响转写脱敏与已读清单](issues/ISSUE-0134-handoff-tool-records.md)
- [仅发送附件换 Agent 时接收方误收切回等待指令](issues/ISSUE-0135-handoff-attachment-only.md)
- [ACP 首轮请求把历史资料放在本轮用户指令之后](issues/ISSUE-0136-acp-handoff-resource-order.md)
- [切回原 Agent 或强制重新交接丢失模型选择或思考强度](issues/ISSUE-0137-handoff-return-model-effort.md)

### 2026-11-21 局域网浏览器代码复核

- [第 1.7 步验收记录](acceptance/step-1.7.md)
- [访问审计清理误删其他模块的历史记录](issues/ISSUE-0154-lan-audit-retention.md)
- [设备吊销和一次性配对领取的状态不一致](issues/ISSUE-0155-lan-pairing-revocation.md)
- [电脑新标签页漏掉已有的待确认请求](issues/ISSUE-0156-lan-pending-confirmation-sync.md)
- [手机时钟偏差造成配对倒计时和重试时间错误](issues/ISSUE-0157-lan-pairing-relative-time.md)
- [网卡转为公用网络后第二监听仍在运行](issues/ISSUE-0158-lan-running-profile-change.md)
- [本机配对请求和失败结果缺少访问审计](issues/ISSUE-0159-lan-local-pairing-audit.md)
- [设备吊销后旧弹窗遮住手机配对页](issues/ISSUE-0160-revoked-device-overlays.md)
- [正常顺延多个端口时局域网用例误报](issues/ISSUE-0161-lan-port-fallback-assertion.md)
