# ISSUE-0044：同模型重新保存配置导致私有续传失效

| 项 | 值 |
|---|---|
| 状态 | investigating |
| 类型 | bug |
| 严重程度 | 中 |
| 发现于 | step-1.3 文件工具声明离线复核，基线 2c87ccb |
| 开启 | 2026-11-08 |
| 关闭 | |

## 现象

独立任务已有带供应商私有续传的助手记录时，同服务、同模型和同修订重新应用配置（例如只调整预算），下一回合仍携带旧续传，但请求编码以 request 错误拒绝。原文和额度仍保留，不会发送生成请求。

## 复现步骤

1. 用内存数据库与合成目录配置建立绑定，通过实际 modelWire 编码保存含合成 reasoning_content 的 Chat 助手回复，循环完成回合。
2. 同一 selection 调用 catalog.rebind，四个配置字段保持一致，仅 createdAt 改变。
3. 建立下一回合并读取 conversation.context，助手仍保留旧私有续传；以当前绑定调用 modelWire，得到 request 拒绝。

## 影响

同模型仅调整任务控制值也可能阻断后续上下文；不能要求用户删历史、重置预算或反复收费重试。

## 根因

catalog.rebind 每次重写 createdAt；modelWire 的私有 scope 包含完整 binding，但 conversation.context 仅按 serviceId / modelId / configRevision / modelRevision 比较适用性，没有核对绑定时间。

## 处理方式

单独修复：配置身份未改变时保留绑定身份；对已有时间不同的历史绑定去除不适用的私有续传，保留可移植原文及原始私有记录。严格校验、预算、原始摘要和真正换模型的确认边界仍保留。

## 验证

零网络离线脚本实际输出：bindingOnlyTimeChanged=true、privateContinuationKept=true、wireRejected=request、networkRequests=0。修复与自动回归尚未完成，不能当作已修复。

## 时间线

- 2026-11-08 开启并调查：文件工具历史兼容复核时发现，内存数据库 / 实际编码零网络复现；与 ISSUE-0042 的真实失败分开，不声称是其原因。

- 2026-11-08 已实现同配置保留绑定创建时间，以及历史续传按完整绑定筛选；针对性 4 项回归通过。探针补齐请求 binding 参数后，用 5e67edd 原 rebind / context 函数复查：时间改变、私有续传仍在、request 拒绝；修正后时间不变、私有续传仍在、编码通过，均零网络。完整检查与修复提交尚待下条回执，不以初次探针字段输出代替该复查。
