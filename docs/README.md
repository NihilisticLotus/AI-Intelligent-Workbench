# 文档总目录

存放规则见 [.agent/records.md](../.agent/records.md)。新增文档时同时更新这里。

## 设计

| 文档 | 说明 |
|---|---|
| [design/design.md](design/design.md) | 架构设计 v0.4.15：多服务模型、内部循环、项目工具、三协议传输、附件、输入预检与逐请求预算 |
| [design/ui-design.md](design/ui-design.md) | 界面设计 v0.3.5：多服务模型、发现预览与来源核对、批量导入、人工修订及冲突处理 |
| [prototype/index.html](prototype/index.html) | 可点击原型（双击打开）：工作台、看板、Agent、资产、生成、自动化、监控、能力 |

## 调研

| 文档 | 日期 | 说明 |
|---|---|---|
| [research/context.md](research/context.md) | 2026-11-05 | 切换模型不丢上下文：记忆方案、同类产品、ACP 能力 |
| [research/handoff.md](research/handoff.md) | 2026-11-06 | 各家工作台的会话交接做法，自动交接方案 |
| [research/media-gen.md](research/media-gen.md) | 2026-11-06 | 图片 / 视频 / 音频生成选型，28 条关键断言已独立核查 |
| [research/independent-agent.md](research/independent-agent.md) | 2026-11-08 | 独立 Agent 调研总论：多 API / 多模型、能力识别、执行器底线与验证门槛 |
| [research/cc-switch-model-metadata.md](research/cc-switch-model-metadata.md) | 2026-11-08 | CCSwitch 固定源码：模型列表、预设与 models.dev 补全的真实边界 |
| [research/model-capability-detection.md](research/model-capability-detection.md) | 2026-11-08 | 各协议模型元数据、上下文语义、图片与思考参数、来源及未知状态 |
| [research/independent-agent-engines.md](research/independent-agent-engines.md) | 2026-11-08 | Pi、Cline、OpenCode、Goose 的能力矩阵、认证风险与离线选型门槛 |

## 计划

| 文档 | 说明 |
|---|---|
| [plans/phase-1.md](plans/phase-1.md) | 第一阶段：本机浏览器版，7 步（2026-11-08 重新规划，1.1、1.2 已完成）；第 2 节是接口规则，第 7 节是进度盘点 |

## 过程记录

| 目录 | 说明 |
|---|---|
| [acceptance/](acceptance/) | 每一步的验收记录 |
| [acceptance/step-1.3.md](acceptance/step-1.3.md) | 稳定、补验与输入框：部分通过；独立命令基础、多服务模型与发现导入已实现，正式运行时与真实补验仍待完成（ISSUE-0029、0030） |
| [devlog/](devlog/) | 开发笔记，每月一个文件，只追加 |
| [issues/](issues/README.md) | 问题收纳：总表 + 每个问题一个文件 |
