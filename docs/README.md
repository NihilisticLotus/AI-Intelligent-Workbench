# 文档总目录

存放规则见 [.agent/records.md](../.agent/records.md)。新增文档时同时更新这里。

## 设计

| 文档 | 说明 |
|---|---|
| [design/design.md](design/design.md) | 架构设计 v0.4.36：费用与上下文缺项不猜单位、不强转零；完整句式识别文本错误；绑定限频与受控文件快照；无回应计时排除活动工具；详细面板、真实用量与工具输出；第三方设置归属、独立任务、自有循环、三协议、预算与恢复；DeepSeek Harness 参考、文件工具版本、旧密钥清理、有限诊断及已有模型官方能力预览 |
| [design/ui-design.md](design/ui-design.md) | 界面设计 v0.3.24：费用单位未报告显示未知；返回首页按实际任务显示指引；正常报错解释不误标失败；鉴权范围内的图片缓存；无回应提醒排除活动工具；新建任务起始页、规则推荐、返回保留原任务；详细六节、常用环境与未知状态；统一选择器、附件、独立服务与模型、能力来源、任务策略 / 预算、私有审批、恢复、目录诊断、服务停止提示及已有模型能力预览 |
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

## 计划

| 文档 | 说明 |
|---|---|
| [plans/phase-1.md](plans/phase-1.md) | 第一阶段：本机浏览器版，7 步，1.1～1.4 已完成；第 2 节是接口规则，第 10.16 节是 1.4 结论 |

## 过程记录

| 目录 | 说明 |
|---|---|
| [acceptance/](acceptance/) | 每一步的验收记录 |
| [acceptance/step-1.4.md](acceptance/step-1.4.md) | 2026-11-13 第 10.15 节五项通过；853 通过 / 3 跳过，真实三轮与双主题证据、反向回归、当前进度；原生拖入未验证见 ISSUE-0070 |
| [acceptance/step-1.3.md](acceptance/step-1.3.md) | 2026-11-12 已判定通过；完整历史、真实补验和遗留问题见末尾结论，1.4 接手的 ISSUE-0060～0062 已修复 |
| [devlog/](devlog/) | 开发笔记，每月一个文件，只追加 |
| [issues/](issues/README.md) | 问题收纳：总表 + 每个问题一个文件 |

### 2026-11-14 用量审查修复

- [ISSUE-0071：部分用量覆盖提示](issues/ISSUE-0071-partial-usage-coverage.md)
- [ISSUE-0072：无回复轮次用量](issues/ISSUE-0072-missing-reply-usage.md)
- 修复验证与浏览器限制追加在 [step-1.4](acceptance/step-1.4.md)，不覆盖历史验收。
- [ISSUE-0073：收尾文件宿主复验](issues/ISSUE-0073-file-host-validation-timeout.md)
