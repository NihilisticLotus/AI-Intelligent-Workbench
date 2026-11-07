# ISSUE-0020：ZCode 还不能对话，需要接入 zcode-acp 桥接

| 项 | 值 |
|---|---|
| 状态 | open |
| 类型 | 待办 |
| 严重程度 | 低 |
| 发现于 | 用户要求把 ZCode 纳入管理并测试连接（2026-11-07） |
| 开启 | 2026-11-07 |
| 关闭 | |

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
