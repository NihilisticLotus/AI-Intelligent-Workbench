# 问题总表

规则见 [.agent/records.md](../../.agent/records.md) 第 3 节，模板见 [.agent/templates/issue.md](../../.agent/templates/issue.md)。编号递增、永不复用；关闭的问题保留。

| 编号 | 标题 | 状态 | 类型 | 开启 | 关闭 |
|---|---|---|---|---|---|
| [ISSUE-0001](ISSUE-0001-acp-mcp-injection.md) | 部分 Agent 在 ACP 模式下忽略客户端传入的 mcpServers | investigating | 外部依赖 | 2026-11-06 | |
| [ISSUE-0002](ISSUE-0002-gpt-image-2.6-transparency.md) | OpenAI Images 2.6 是否原生支持透明背景未确认 | deferred | 外部依赖 | 2026-11-06 | |
| [ISSUE-0003](ISSUE-0003-node-sqlite-experimental.md) | node:sqlite 仍是实验特性 | open | 技术债 | 2026-11-06 | |
| [ISSUE-0004](ISSUE-0004-start-script-first-run.md) | 启动脚本的首次运行路径未在干净环境里实测 | fixed | 验收未通过（未验证） | 2026-11-06 | 2026-11-11 |
| [ISSUE-0005](ISSUE-0005-401-before-pairing.md) | 配对前浏览器控制台出现 401 | fixed | bug | 2026-11-06 | 2026-11-08 |
| [ISSUE-0006](ISSUE-0006-always-allow-rules.md) | “总是允许”审批规则尚未实现 | fixed | 待办 | 2026-11-06 | 2026-11-15 |
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
| [ISSUE-0074](ISSUE-0074-watchdog-stuck-tool.md) | Agent 卡在工具里不发结束事件时，无回应看门狗永远不会停下 | fixed | bug | 2026-11-15 | 2026-11-15 |
| [ISSUE-0075](ISSUE-0075-image-recommend-demo.md) | 起始页带图片时推荐演示 Agent 或未就绪的 Agent | fixed | bug | 2026-11-15 | 2026-11-15 |
| [ISSUE-0076](ISSUE-0076-sidepanel-log-scan.md) | 详细面板每收到一个事件都把整段任务事件复制三遍 | fixed | 技术债 | 2026-11-15 | 2026-11-15 |
| [ISSUE-0077](ISSUE-0077-workspace-protection-contract.md) | 1.5 工作区默认方案与项目写入保护边界冲突 | fixed | 设计约束冲突 | 2026-11-15 | 2026-11-15 |
| [ISSUE-0078](ISSUE-0078-watchdog-test-timing.md) | 并行长工具测试依赖固定延时造成时序误判 | fixed | 测试稳定性 | 2026-11-15 | 2026-11-15 |
| [ISSUE-0079](ISSUE-0079-db-migration-handle.md) | 数据库迁移抛错时没有关闭连接 | fixed | bug | 2026-11-15 | 2026-11-15 |
| [ISSUE-0080](ISSUE-0080-managed-workspace-file-guard.md) | 独立文件宿主误拦数据目录内的登记副本 | fixed | 接入兼容 | 2026-11-15 | 2026-11-15 |
| [ISSUE-0081](ISSUE-0081-diff-content-revision.md) | 统计相同时单文件差异可能停留在旧内容 | fixed | bug | 2026-11-15 | 2026-11-15 |
| [ISSUE-0082](ISSUE-0082-git-config-callbacks.md) | 继承 git 配置可能触发钩子与外部程序 | fixed | bug | 2026-11-15 | 2026-11-15 |
| [ISSUE-0083](ISSUE-0083-copy-snapshot-original-bytes.md) | 影子快照换行规范化改变回滚原文 | fixed | bug | 2026-11-15 | 2026-11-15 |
| [ISSUE-0084](ISSUE-0084-new-task-isolation-footer.md) | 新任务底部仍提示直接修改原项目 | fixed | bug | 2026-11-15 | 2026-11-15 |
| [ISSUE-0085](ISSUE-0085-permission-canonical-path.md) | 权限判定混用 Windows 长短路径 | fixed | bug | 2026-11-15 | 2026-11-15 |
| [ISSUE-0086](ISSUE-0086-permission-command-options.md) | 权限命令选项与复杂通配需要完整判定 | fixed | bug | 2026-11-15 | 2026-11-15 |
| [ISSUE-0087](ISSUE-0087-rule-keyboard-focus.md) | 新权限规则调序后丢失键盘焦点 | fixed | bug | 2026-11-15 | 2026-11-15 |
| [ISSUE-0088](ISSUE-0088-native-auto-permission-bypass.md) | 原生自动权限模式会跳过工作台规则入口 | deferred | 设计冲突 | 2026-11-15 | |
| [ISSUE-0089](ISSUE-0089-windows-test-host-timeouts.md) | Windows 文件宿主全量回归出现超时 | fixed | 验收未通过 | 2026-11-15 | 2026-11-15 |
| [ISSUE-0090](ISSUE-0090-board-pointer-drag.md) | 内嵌浏览器拖动看板卡片未更新队列 | fixed | 验收未通过 | 2026-11-15 | 2026-11-15 |
| [ISSUE-0091](ISSUE-0091-codebuddy-workspace-real-quota.md) | CodeBuddy 自带模型无额度，核对自定义模型补验 | deferred | 外部依赖 | 2026-11-15 | |
| [ISSUE-0092](ISSUE-0092-board-independent-failure.md) | 看板遗漏独立 Agent 请求失败原因 | fixed | bug | 2026-11-15 | 2026-11-15 |
| [ISSUE-0093](ISSUE-0093-explicit-model-fallback.md) | 显式模型失效后自动回退并发送消息 | fixed | bug | 2026-11-15 | 2026-11-15 |
| [ISSUE-0094](ISSUE-0094-codebuddy-copy-acceptance-timeout.md) | CodeBuddy 非 git 补验等待审批超过观察上限 | deferred | 验收未通过 | 2026-11-15 | |
| [ISSUE-0095](ISSUE-0095-independent-copy-output-limit.md) | 智谱非 git 补验写入成功但最终回复触及预算 | open | 验收未通过 | 2026-11-15 | |
| [ISSUE-0096](ISSUE-0096-full-auto-unparsed-command.md) | “全自动”放行无法核对范围的命令，能绕过始终禁止清单 | fixed | bug | 2026-11-16 | 2026-11-16 |
| [ISSUE-0097](ISSUE-0097-lfs-merge-pointer.md) | Git LFS 项目合并或撤销会把资产写成指针文本 | fixed | bug | 2026-11-16 | 2026-11-16 |
| [ISSUE-0098](ISSUE-0098-user-repo-hooks-signing.md) | 在用户仓库生成的合并 / 撤销提交跳过了用户的提交钩子和签名 | fixed | bug | 2026-11-16 | 2026-11-16 |
| [ISSUE-0099](ISSUE-0099-carried-files-committed.md) | 带入工作副本的本地文件会被提交，并让合并永远被拦下 | fixed | bug | 2026-11-16 | 2026-11-16 |
| [ISSUE-0100](ISSUE-0100-changes-full-rehash.md) | 每个工具结束都全量读取并哈希整个工作副本 | fixed | 技术债 | 2026-11-16 | 2026-11-16 |
| [ISSUE-0101](ISSUE-0101-copy-apply-unrelated-drift.md) | 非 git 项目里任何无关改动都阻止“应用结果”和撤销 | fixed | bug | 2026-11-16 | 2026-11-16 |
| [ISSUE-0102](ISSUE-0102-git-config-per-command.md) | 每条 git 命令前都多启动一次 git config | fixed | 技术债 | 2026-11-16 | 2026-11-16 |
| [ISSUE-0103](ISSUE-0103-read-allow-notice-noise.md) | 每次自动允许的读取都在对话里插一条提示 | fixed | bug | 2026-11-16 | 2026-11-16 |
| [ISSUE-0104](ISSUE-0104-legacy-applied-aic.md) | 旧任务撤销应用时可能涉及项目自己的 .aic 文件 | fixed | 升级兼容 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0105](ISSUE-0105-memory-action-hidden.md) | 主对话里的“记为约束”跟随隐藏的消息标题消失 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0106](ISSUE-0106-queue-cancel-summary.md) | 取消排队任务时被工作副本说明写入拖住 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0107](ISSUE-0107-summary-unrelated-secret.md) | 写任务说明时解密了与内容无关的工作台旧密文 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0108](ISSUE-0108-tracked-task-file.md) | 项目已跟踪同名任务说明时，副本文件与工作台目标不同 | fixed | 升级兼容 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0109](ISSUE-0109-preview-live-copy.md) | 非 git 副本的交接预览遗漏最后一次快照之后的文件 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0110](ISSUE-0110-await-workspace-approval.md) | 等待审批时拒绝还原的用例依赖启动速度 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0111](ISSUE-0111-environment-quoted-line.md) | 后续对话引用环境文件中的无赋值文本时未打码 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0112](ISSUE-0112-handoff-path-redaction.md) | 环境配置的值与真实改动路径重合时显示错误文件名 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0113](ISSUE-0113-checkpoint-shared-objects.md) | 私有索引仍会把副本内容写进原项目的 Git 对象库 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0114](ISSUE-0114-handoff-binary-attachment.md) | 新消息中的二进制附件会绕过交接正文打码 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0115](ISSUE-0115-handoff-source-continuity.md) | 无原生恢复能力时交接失败会丢失来源会话状态 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0116](ISSUE-0116-return-confirmation.md) | 反向交接草稿确认请求被拒 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0117](ISSUE-0117-handoff-summary-budget.md) | 交接摘要模型与任务执行模型使用不同的请求预算绑定 | fixed | 待办 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0118](ISSUE-0118-forced-handoff-window.md) | 手动强制完整转写时可能超过目标模型的整个窗口 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0119](ISSUE-0119-handoff-live-feedback.md) | 已发送后仍可点击撤销，任务账本没有及时显示计划 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0120](ISSUE-0120-handoff-session-slots.md) | 保留原会话时模拟第三方 Agent 无法取得接收名额 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0121](ISSUE-0121-approval-watchdog-test-start.md) | 无回应计时用例在审批请求登记之前快进时间 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0122](ISSUE-0122-handoff-without-history-tools.md) | 接收模型禁用工具时，交接正文和分隔条仍称可以查历史 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0123](ISSUE-0123-handoff-history-approval-title.md) | 历史工具审批丢失同一次调用的名称 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0124](ISSUE-0124-handoff-approval-expiry.md) | 接收首轮审批到期仍会发布成功交接收据 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0125](ISSUE-0125-handoff-return-chain.md) | 原生切回后较早的交接分隔条缺少切回按钮 | fixed | bug | 2026-11-18 | 2026-11-18 |
| [ISSUE-0126](ISSUE-0126-handoff-failed-session-selection.md) | 重新交接失败后继续到了错误的会话 | fixed | bug | 2026-11-18 | 2026-11-18 |
| [ISSUE-0127](ISSUE-0127-handoff-environment-attachment-history.md) | 已发送环境附件的值未持续用于后续交接脱敏 | fixed | bug | 2026-11-18 | 2026-11-18 |
| [ISSUE-0128](ISSUE-0128-workspace-deleted-owned-artifact.md) | 副本中已删除的项目自有说明被工作台重新创建 | fixed | bug | 2026-11-18 | 2026-11-18 |
| [ISSUE-0129](ISSUE-0129-idle-watchdog-test-start.md) | 无回应提醒用例提前开始计时 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0130](ISSUE-0130-handoff-acceptance-streamed-reply.md) | 真实交接验收漏读流式回复 | fixed | 验收未通过 | 2026-11-18 | 2026-11-18 |
| [ISSUE-0131](ISSUE-0131-luna-handoff-result-missing.md) | Luna 接收真实 Claude 交接后未创建成果文件 | open | 验收未通过 | 2026-11-18 | |
| [ISSUE-0132](ISSUE-0132-claude-stopped-tool-before-handoff.md) | Claude 首轮撤回一次编辑，完整交接验收提前停止 | open | 验收未通过 | 2026-11-18 | |
| [ISSUE-0133](ISSUE-0133-luna-handoff-read-command.md) | Luna 接手仅新增文件的任务时尝试用命令读取旧文件 | open | 验收未通过 | 2026-11-18 | |
| [ISSUE-0134](ISSUE-0134-handoff-tool-records.md) | 工具记录归并不完整影响转写脱敏与已读清单 | fixed | bug | 2026-11-18 | 2026-11-18 |
| [ISSUE-0135](ISSUE-0135-handoff-attachment-only.md) | 仅发送附件换 Agent 时接收方误收切回等待指令 | fixed | bug | 2026-11-18 | 2026-11-18 |
| [ISSUE-0136](ISSUE-0136-acp-handoff-resource-order.md) | ACP 首轮请求把历史资料放在本轮用户指令之后 | fixed | bug | 2026-11-18 | 2026-11-18 |
| [ISSUE-0137](ISSUE-0137-handoff-return-model-effort.md) | 切回原 Agent 或强制重新交接丢失模型选择或思考强度 | fixed | bug | 2026-11-18 | 2026-11-18 |
| [ISSUE-0138](ISSUE-0138-handoff-receiver-partial-turn.md) | 接收方首轮中途失败或被停止时交接被静默撤回 | fixed | bug | 2026-11-19 | 2026-11-19 |
| [ISSUE-0139](ISSUE-0139-handoff-return-restore-order.md) | 切回原 Agent 时先恢复检查点，切换失败后文件已被改回 | fixed | bug | 2026-11-19 | 2026-11-19 |
| [ISSUE-0140](ISSUE-0140-handoff-narrative-incremental.md) | 第二次交接的摘要只看新事件，丢掉上次的尝试与决策 | fixed | bug | 2026-11-19 | 2026-11-19 |
| [ISSUE-0141](ISSUE-0141-handoff-env-over-redaction.md) | 环境文件里的普通配置值被全局打码 | fixed | bug | 2026-11-19 | 2026-11-19 |
| [ISSUE-0142](ISSUE-0142-history-query-recompute.md) | 历史查询每次调用都重新投影与打码全部事件 | fixed | bug | 2026-11-19 | 2026-11-19 |
| [ISSUE-0143](ISSUE-0143-events-session-index.md) | 交接守卫按会话查询事件但没有索引 | fixed | bug | 2026-11-19 | 2026-11-19 |
| [ISSUE-0144](ISSUE-0144-merge-private-history-stuck.md) | 任务分支提交过 .aic 后永远无法合并 | fixed | bug | 2026-11-19 | 2026-11-19 |
| [ISSUE-0145](ISSUE-0145-handoff-cancel-cleanup.md) | 取消交接确认后留下待确认记录、检查点和说明文件 | fixed | bug | 2026-11-19 | 2026-11-19 |
| [ISSUE-0146](ISSUE-0146-handoff-edit-tool-hint.md) | 交接说明硬编码 Codex 的 apply_patch 工具名 | fixed | bug | 2026-11-19 | 2026-11-19 |
