# 问题总表

规则见 [.agent/records.md](../../.agent/records.md) 第 3 节，模板见 [.agent/templates/issue.md](../../.agent/templates/issue.md)。编号递增、永不复用；关闭的问题保留。

| 编号 | 标题 | 状态 | 类型 | 开启 | 关闭 |
|---|---|---|---|---|---|
| [ISSUE-0001](ISSUE-0001-acp-mcp-injection.md) | 部分 Agent 在 ACP 模式下忽略客户端传入的 mcpServers | investigating | 外部依赖 | 2026-11-06 | |
| [ISSUE-0002](ISSUE-0002-gpt-image-2.6-transparency.md) | OpenAI Images 2.6 是否原生支持透明背景未确认 | deferred | 外部依赖 | 2026-11-06 | |
| [ISSUE-0003](ISSUE-0003-node-sqlite-experimental.md) | node:sqlite 仍是实验特性 | open | 技术债 | 2026-11-06 | |
| [ISSUE-0004](ISSUE-0004-start-script-first-run.md) | 启动脚本的首次运行路径未在干净环境里实测 | fixed | 验收未通过（未验证） | 2026-11-06 | 2026-11-11 |
| [ISSUE-0005](ISSUE-0005-401-before-pairing.md) | 配对前浏览器控制台出现 401 | fixed | bug | 2026-11-06 | 2026-11-08 |
| [ISSUE-0006](ISSUE-0006-always-allow-rules.md) | “总是允许”审批规则尚未实现 | deferred | 待办 | 2026-11-06 | |
| [ISSUE-0007](ISSUE-0007-claude-terminal-login.md) | Claude Code 订阅登录没有 ACP authenticate，能否全程图形化未实测 | wontfix | 外部依赖 | 2026-11-06 | 2026-11-08 |
| [ISSUE-0008](ISSUE-0008-codebuddy-login-fragile.md) | CodeBuddy 登录态在探测中失效，且与 WorkBuddy 共用登录 | fixed | 外部依赖 | 2026-11-06 | 2026-11-07 |
| [ISSUE-0009](ISSUE-0009-codex-global-cli-config.md) | 本机全局 codex 0.120 读不了当前的 config.toml，改用 codex-acp 自带的 0.165 | open | 外部依赖 | 2026-11-06 | |
| [ISSUE-0010](ISSUE-0010-codebuddy-smoke-not-run.md) | CodeBuddy 未登录，真实会话冒烟和浏览器验收没有执行 | fixed | 验收未通过 | 2026-11-06 | 2026-11-07 |
| [ISSUE-0011](ISSUE-0011-claude-tool-title-placeholder.md) | Claude 的工具行标题停在“Preparing file…” | fixed | bug | 2026-11-06 | 2026-11-08 |
| [ISSUE-0012](ISSUE-0012-real-resume-and-reject-unverified.md) | 真实 Agent 的会话恢复和拒绝审批没有完整验证 | fixed | 验收未通过 | 2026-11-06 | 2026-11-08 |
| [ISSUE-0013](ISSUE-0013-login-and-apikey-unverified.md) | 登录流程和 API Key / 自定义地址账号没有用真实 Agent 验证 | wontfix | 验收未通过 | 2026-11-06 | 2026-11-08 |
| [ISSUE-0014](ISSUE-0014-event-flush-raf-stall.md) | 实时事件只靠动画帧合并，窗口被遮挡时审批卡片不出现 | fixed | bug | 2026-11-06 | 2026-11-08 |
| [ISSUE-0015](ISSUE-0015-gateway-silent-exit.md) | Gateway 意外退出，没有留下错误信息 | investigating | bug | 2026-11-07 | |
| [ISSUE-0016](ISSUE-0016-workbuddy-engine-replaced.md) | WorkBuddy 自动更新后内置引擎变成精简版，CodeBuddy 无法使用 | investigating | 外部依赖 | 2026-11-07 | |
| [ISSUE-0017](ISSUE-0017-login-500-rec-before-init.md) | 点 CodeBuddy 的登录按钮报“服务内部错误” | fixed | bug | 2026-11-07 | 2026-11-07 |
| [ISSUE-0018](ISSUE-0018-chat-fragmented-replies.md) | 思考强度提示堆叠；Agent 回复被拆成多条 | fixed | bug | 2026-11-07 | 2026-11-07 |
| [ISSUE-0019](ISSUE-0019-reply-display-not-codex-like.md) | 回复的结构和格式与常见 Agent 软件差别大（参照 Codex） | fixed | bug | 2026-11-07 | 2026-11-07 |
| [ISSUE-0020](ISSUE-0020-zcode-acp-bridge.md) | ZCode 还不能对话，需要接入 zcode-acp 桥接 | open | 待办 | 2026-11-07 | |
| [ISSUE-0021](ISSUE-0021-quota-hint-garbled.md) | 额度错误的提示把英文原文截了一段拼进中文 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0022](ISSUE-0022-turn-hang-no-timeout.md) | Claude 回合卡住两分钟以上没有任何输出，也没有超时 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0023](ISSUE-0023-step-1.3-real-input-unverified.md) | 第 1.3 步真实截图和选择器仍待补验 | fixed | 验收未通过（未验证） | 2026-11-08 | 2026-11-11 |
| [ISSUE-0024](ISSUE-0024-profile-model-catalog.md) | 切换账号仍显示另一账号的模型 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0025](ISSUE-0025-codex-api-auth-required.md) | Codex API 账号建会话前误要求登录 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0026](ISSUE-0026-claude-profile-settings-routing.md) | Claude 用户设置可能覆盖 API 账号路由 | wontfix | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0027](ISSUE-0027-codebuddy-auto-label.md) | CodeBuddy 自动强度在提示和面板中显示 enabled | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0028](ISSUE-0028-api-profile-delete-policy.md) | API 账号删除时的目录与凭据清理规则冲突（旧工作台密钥已按授权清理，目录与历史保留） | fixed | 验收未通过 | 2026-11-08 | 2026-11-08 |
| [ISSUE-0029](ISSUE-0029-custom-api-agent-boundary.md) | 工作台自定义 API 被错误归属到第三方认证 | fixed | 验收未通过 | 2026-11-08 | 2026-11-11 |
| [ISSUE-0030](ISSUE-0030-pi-runtime-contracts.md) | Pi 候选的参数、终态与用量语义需宿主适配 | investigating | 外部依赖 | 2026-11-08 | |
| [ISSUE-0031](ISSUE-0031-nested-transaction-rollback.md) | 捕获内层事务错误后会提交半次修改 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0032](ISSUE-0032-capability-form-config-revision.md) | 旧能力表单可能写入已变更的服务范围 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0033](ISSUE-0033-discovery-conflict-submit.md) | 模型发现冲突后仍可重复提交旧预览 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0034](ISSUE-0034-interrupted-tool-continuation.md) | 工具明确中断后仍继续请求模型 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0035](ISSUE-0035-concurrent-hardlink-write.md) | 文件共享锁不能阻止校验后的并发硬链接 | fixed | 安全边界 | 2026-11-08 | 2026-11-08 |
| [ISSUE-0036](ISSUE-0036-model-cancel-resource-barrier.md) | 模型取消在连接收尾前释放会话资格 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0037](ISSUE-0037-model-terminal-consistency.md) | 矛盾的 Responses 终态仍可能返回工具调用 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0038](ISSUE-0038-large-base64-stack.md) | 合法大附件触发 base64 校验栈溢出 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0039](ISSUE-0039-attachment-read-path.md) | 附件下载跟随目录联接且未复核上传摘要 | fixed | 安全边界 | 2026-11-08 | 2026-11-08 |
| [ISSUE-0040](ISSUE-0040-independent-image-prompt-guard.md) | 独立任务图片校验未使用自有模型能力 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0041](ISSUE-0041-independent-config-event.md) | 独立任务换模型后输入框沿用旧会话配置 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0042](ISSUE-0042-bigmodel-responses-tool-failure.md) | 智谱 Responses 真实工具补验遇到空参数与协议失败 | fixed | 验收未通过 | 2026-11-08 | 2026-11-10 |
| [ISSUE-0043](ISSUE-0043-terminal-fragment-progress.md) | 任务已失败但未确认片段仍显示正在处理 | fixed | bug | 2026-11-08 | 2026-11-08 |

| [ISSUE-0044](ISSUE-0044-same-binding-continuation.md) | 同模型重新保存配置导致私有续传失效 | fixed | bug | 2026-11-08 | 2026-11-08 |

| [ISSUE-0045](ISSUE-0045-gateway-down-notice-visibility.md) | 服务停止提示不明显且占位仍写重新连接 | fixed | bug | 2026-11-08 | 2026-11-08 |


| [ISSUE-0046](ISSUE-0046-switch-model-failure-marker.md) | 会话内切换被拒绝后缺少失败模型标记 | fixed | bug | 2026-11-08 | 2026-11-08 |

| [ISSUE-0047](ISSUE-0047-native-default-model-picker.md) | 新任务选择第三方时无法保留软件默认模型 | fixed | bug | 2026-11-08 | 2026-11-08 |

| [ISSUE-0048](ISSUE-0048-codex-proxy-text-error.md) | Codex 代理模型拒绝正文在自动压缩后仍显示待验收 | fixed | bug | 2026-11-08 | 2026-11-08 |

| [ISSUE-0049](ISSUE-0049-terminal-error-redaction.md) | Gateway 兜底终端错误输出绕过脱敏 | fixed | bug | 2026-11-08 | 2026-11-08 |

| [ISSUE-0050](ISSUE-0050-discovery-parse-failure-diagnostics.md) | 目录解析失败缺少固定校验分类 | fixed | 技术债 | 2026-11-08 | 2026-11-08 |

| [ISSUE-0051](ISSUE-0051-model-pagination-null-cursor.md) | Messages 模型分页的空游标被当作列表结束 | fixed | bug | 2026-11-08 | 2026-11-08 |
| [ISSUE-0052](ISSUE-0052-child-pipe-epipe-crash.md) | 子进程被外部结束时，写管道的 EPIPE 会让整个 Gateway 退出 | fixed | bug | 2026-11-09 | 2026-11-09 |
| [ISSUE-0053](ISSUE-0053-fake-ip-proxy-blocks-metadata.md) | 本机代理把供应商域名解析到 198.18.x，元数据读取被网络规则拒绝 | fixed | 外部依赖 | 2026-11-09 | 2026-11-09 |
| [ISSUE-0054](ISSUE-0054-coding-plan-tool-request-protocol.md) | Coding Plan 服务上带工具定义的独立 Agent 请求失败（protocol / reasoning_missing） | fixed | 验收未通过 | 2026-11-09 | 2026-11-10 |
| [ISSUE-0055](ISSUE-0055-approval-wait-counts-toward-turn-limit.md) | 独立 Agent 等待用户审批的时间被算进回合时限 | fixed | bug | 2026-11-10 | 2026-11-10 |
| [ISSUE-0056](ISSUE-0056-continuation-basis-drift.md) | 项目规则、人工总结或工具开关变化后，独立任务每条消息都失败 | fixed | bug | 2026-11-11 | 2026-11-11 |
| [ISSUE-0057](ISSUE-0057-last-exit-false-alarm.md) | 旧格式日志下，启动时把本次的启动行当成上次运行，误报“上次没有正常退出” | fixed | bug | 2026-11-11 | 2026-11-11 |
| [ISSUE-0058](ISSUE-0058-model-fake-ip-hint.md) | 独立 Agent 对话被 fake-ip 规则拦下时没有对应提示 | fixed | bug | 2026-11-11 | 2026-11-11 |
| [ISSUE-0059](ISSUE-0059-official-evidence-expiry.md) | 内置智谱官方能力资料 2026-11-15 到期，到期后带工具的任务无法使用且无法刷新 | fixed | bug | 2026-11-11 | 2026-11-12 |
| [ISSUE-0060](ISSUE-0060-independent-host-overhead.md) | 独立 Agent 的几处重复开销：每个流式片段查库、看图和改文件反复启动受控宿主 | fixed | 技术债 | 2026-11-11 | 2026-11-13 |
| [ISSUE-0061](ISSUE-0061-watchdog-long-tool.md) | 无回应看门狗会停掉长时间没有输出的工具 | fixed | bug | 2026-11-11 | 2026-11-13 |
| [ISSUE-0062](ISSUE-0062-text-error-heuristic.md) | 按回复开头文字判定模型失败，可能把正常的简短回答当成错误 | fixed | bug | 2026-11-11 | 2026-11-13 |
| [ISSUE-0063](ISSUE-0063-step-1.4-baseline-environment.md) | 1.4 开工环境无法通过既有 Windows 进程与文件宿主测试 | fixed | 验收未通过 / 外部依赖 | 2026-11-12 | 2026-11-12 |
| [ISSUE-0064](ISSUE-0064-sidebar-new-button-shrink.md) | 项目较多时侧栏新建任务按钮被挤扁 | fixed | bug | 2026-11-12 | 2026-11-12 |
| [ISSUE-0065](ISSUE-0065-independent-badge-light-contrast.md) | 浅色主题独立 Agent 徽标文字对比度不足 | fixed | bug | 2026-11-12 | 2026-11-12 |
| [ISSUE-0066](ISSUE-0066-plan-hidden-text-overflow.md) | 计划辅助文字溢出导致定位时整页滚动 | fixed | bug | 2026-11-13 | 2026-11-13 |
| [ISSUE-0067](ISSUE-0067-home-existing-tasks-message.md) | 从起始页返回首页后，有任务仍显示空列表文案 | fixed | bug | 2026-11-13 | 2026-11-13 |
| [ISSUE-0068](ISSUE-0068-reported-cost-without-unit.md) | 上游费用缺少单位时，面板仍展示无单位数字 | fixed | bug / 外部依赖 | 2026-11-13 | 2026-11-13 |
| [ISSUE-0069](ISSUE-0069-invalid-context-usage-coercion.md) | 空上下文用量被强制转换成零 | fixed | bug | 2026-11-13 | 2026-11-13 |
| [ISSUE-0070](ISSUE-0070-native-attachment-drag-verification.md) | 起始页原生文件拖入路径尚未补验 | open | 验收未通过（未验证） / 外部依赖 | 2026-11-13 | — |
| [ISSUE-0071](ISSUE-0071-partial-usage-coverage.md) | 部分用量合计缺少完整性提示 | fixed | bug | 2026-11-14 | 2026-11-14 |
| [ISSUE-0072](ISSUE-0072-missing-reply-usage.md) | 无回复的失败或取消轮次漏掉用量 | fixed | bug | 2026-11-14 | 2026-11-14 |
| [ISSUE-0073](ISSUE-0073-file-host-validation-timeout.md) | P2 收尾文件宿主中断与超时 | fixed | 验收未通过 | 2026-11-14 | 2026-11-14 |
