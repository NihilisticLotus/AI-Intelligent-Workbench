# ISSUE-0020：ZCode 还不能对话，需要接入 zcode-acp 桥接

| 项 | 值 |
|---|---|
| 状态 | fixed |
| 类型 | 待办 |
| 严重程度 | 低 |
| 发现于 | 用户要求把 ZCode 纳入管理并测试连接（2026-11-07） |
| 开启 | 2026-11-07 |
| 关闭 | 2026-11-26 |

## 现象

Agent 页打开 ZCode 后，测试连接显示：找到引擎 ✓、读取版本 0.17.1 ✓、启动 app-server ✓、开始对话 ✗。卡片状态为“暂不支持”。

## 根因

ZCode 没有 ACP 模式，只有自家协议的 `zcode app-server`；发 ACP 的 initialize 收到 `invalid-message`。

## 处理方式

用户提供了 zcode-acp（ACP 桥接，开源）。调研结论是可以用，但默认全自动、带安装脚本，需要加防护后再接入，详见 `docs/research/zcode-acp.md`。

下一步：锁定 `zcode-acp-server` 精确版本、跳过安装脚本；Gateway 按权限级别传 `ZCODE_ACP_MODE`；实测审批、拒绝、恢复会话、换模型。

## 验证

- 现在：`packages/adapters/src/zcode/index.ts` 的检测和连接测试，在本机 ZCode 0.17.1 上实测通过（结果如上）。
- 接入后：真实冒烟测试（≤3 条消息）。

## 时间线

- 2026-11-07 开启：ZCode 纳入 Agent 管理，暂不支持对话；调研 zcode-acp 可行。
- 2026-11-08 重新规划（plans/phase-1.md 第 1 节）：不变：用户决定先不接 zcode-acp，放在第一阶段之后。
- 2026-11-26 提入 1.8（ISSUE-0181）：本机 ZCode 桌面版已升至 3.18.2.10443（内置 zcode.cjs 仍无原生 `--acp`，`zcode-acp-server` 现为 0.94.0），按用户要求纳入第一阶段第 1.8 步完成受控桥接接入与真实审批测试。
- 2026-11-26 完成并关闭：以 `--ignore-scripts` 精确锁定 `zcode-acp-server@0.94.0`，重写 `packages/adapters/src/zcode/index.ts`，固定 `ZCODE_ACP_RUNTIME=node`、`ZCODE_ACP_REMOTE=0`、`ZCODE_ACP_QUOTA_AUTO_RESUME=0`；核查源码确认 `guarded` 具有自动写文件的 `yolo` 语义，故将工作台 `readonly` 映射为 `plan`、`ask` 强制映射为 `build`。在本机 ZCode 3.18.2（引擎 0.17.1）上通过真实冒烟（审批拒绝未写盘、放行写盘、换模型、恢复会话）及浏览器三端交接合并验收，详见 [docs/acceptance/step-1.8.md](../acceptance/step-1.8.md)。
