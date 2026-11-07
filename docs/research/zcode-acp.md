# 调研：用 zcode-acp 接入 ZCode

> 2026-11-07 · 用户提供链接 https://github.com/william0wang/zcode-acp · 只读查看源码、README、npm，没有安装和运行

## 背景

本机 ZCode 0.17.1 没有 `--acp`，只有 `zcode app-server`（自家的 ZCode Protocol，stdio 上的 JSON 行）。实测：app-server 启动后推送 `startup/storageState`；发 ACP 的 initialize 收到 `invalid-message`。所以工作台不能直接和它对话，原计划在 M6 自己写桥接（design.md 6.5）。

## zcode-acp 是什么

- npm 包 `zcode-acp-server`，最新 0.82.3，Apache-2.0，Node 22 以上（要用 `node:sqlite`）。
- 做法和我们原计划一样：启动 `zcode app-server --stdio` 作为子进程，把它的事件翻译成 ACP 的 `session/update`。不走 shell，Windows 上自动查找 `%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs`，也可以用 `ZCODE_BIN` 指定。
- 作者在 AGENTS.md 里写明对照 ZCode 桌面版 3.17.1 / app-server 0.17.1 审计过，正好是本机版本。
- 项目情况（2026-11-07）：82 star，最近一次提交就是当天；近一个月约 100 次提交，主要是作者本人和自动发版；几乎每天发一个 npm 版本；只有 1 个未解决的 issue。基本是一个人维护。

## 能力（来源：子任务读源码，未实测）

| ACP 能力 | 情况 |
|---|---|
| initialize | 有，声明 loadSession、list、resume、fork、图片 |
| session/new、流式输出、思考内容、工具调用 | 有 |
| 中途审批 | 有：优先 `elicitation/create`，客户端不支持时回退 `session/request_permission` |
| 会话恢复（load / resume） | 有 |
| 换模型、思考强度 | 有 `set_config_option`，另有扩展方法 |
| 取消 | 有 |

## 风险（已核对 README 和 npm 元数据）

1. **默认全自动**：`ZCODE_ACP_MODE` 默认是 `yolo`，所有工具不经审批直接执行。工作台必须按权限级别设置初始模式（只读 → `plan`，需审批 → `guarded` 或 `edit`），并实测审批确实会弹出来。
2. **postinstall 脚本**：安装时会运行 `node dist/remote/hub-upgrade-notify.js`，通知它自己的本机 hub。工作台安装依赖时要跳过安装脚本。
3. **依赖范围不是精确版本**：`@agentclientprotocol/sdk ^1.3.0`、`ws ^8.21.3`。它跑在单独的进程里，和我们用的 SDK 2.4.0 不冲突，但协议能不能对上要实测。
4. **功能远超所需**：远程访问 hub（默认端口 8377）、配额查询（唯一的外部请求，访问 open.bigmodel.cn / api.z.ai）、终端界面等。工作台只用它的 stdio 服务，不启动 hub。
5. **凭据**：它读取 ZCode 桌面版保存的登录（`~/.zcode/v2/config.json`），不经过工作台。这和我们“登录信息由 Agent 自己保存”的原则一致；工作台不读这个文件。
6. **发版太快**：几乎每天一版，接口可能变化。锁定一个版本，升级前在本机冒烟测试。

## 结论

可行，建议作为 ZCode 的适配器使用，替代自己写桥接：

- 锁定 `zcode-acp-server` 的精确版本，安装时跳过安装脚本；
- Gateway 用自己的 Node 启动它的 `dist/index.js`，传 `ZCODE_BIN`（本机 zcode.cjs）和 `ZCODE_ACP_MODE`（按权限级别）；
- 不启动 hub、不开远程访问；
- 第一次接入时实测：审批是否弹出、拒绝是否生效、会话恢复、换模型、思考内容，并和 SDK 2.4.0 对接。

自己重写的话，要逆向一套没有公开、版本之间变化很多的私有协议，工作量和维护成本都明显更高。

预计工作量 1～2 天，作为单独一步（ISSUE-0020）。在此之前，ZCode 在 Agent 页显示“暂不支持”，[测试连接] 能检查引擎和 app-server 是否正常。
