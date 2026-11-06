# 验收记录：第 1.2 步 接入真实 Agent

| 项 | 值 |
|---|---|
| 日期 | 2026-11-06 |
| 提交范围 | 尚未提交：分支 `step/1.2-agents` 的工作区（提交后见 `git log --grep "step-1.2"`） |
| 验收人 | Claude（联调与真实冒烟：一个 Agent 对齐接口、修复、跑真实冒烟和浏览器验收） |
| 结论 | 部分通过：Claude Code、Codex 通过；CodeBuddy 未登录，未验证（ISSUE-0010） |

## 完成标准（plans/phase-1.md 第 1.2 步）

- [ ] 三个 Agent 都能在网页里登录、选模型、完成对话、换模型不丢上下文
  - Claude Code：网页里选模型、完成对话（含一次审批）、会话内换模型和思考强度后继续对话，通过。已是登录状态，网页登录流程未实测（ISSUE-0013）。
  - Codex：冒烟测试（适配器层）里对话、审批、换模型和思考强度后继续对话，通过；网页里只验证了检测和模型列表，没有在网页里发消息。已是登录状态，网页登录流程未实测（ISSUE-0013）。
  - CodeBuddy：未登录，只验证了检测和网页上的登录入口（ISSUE-0010）。
  - “换模型不丢上下文”：换模型都是会话内切换（`session/set_config_option`），换完后的回复正常；没有专门提问验证上下文（为控制费用），见 ISSUE-0012。

## 自动测试

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（adapters、gateway、protocol、web） |
| `npm test` | 178 / 178 通过，另 3 项跳过（真实 Agent 冒烟，默认不跑）：adapters 48、gateway 76、protocol 8、web 46 |
| `npm run build` | 通过（apps/web/dist） |

## 真实冒烟测试（会产生费用）

- 运行前约定：每个 Agent 最多 3 条极短消息，在空的临时目录里进行：①“只回复 OK 两个字母，不要使用任何工具。”②“在当前目录新建 hello.txt，内容为 hi”（“需审批”下应出现审批，允许后文件确实生成）③ 会话内切换模型和思考强度后再发一次 ①。之后 close → resume，不再发消息。
- 命令（在 `packages/adapters` 下）：`AIC_REAL_AGENTS=1 AIC_REAL_AGENTS_ONLY=<kind> AIC_REAL_AGENTS_REPORT=<临时文件> npx vitest run test/real.smoke.test.ts`。报告只含布尔值、版本、模型 id、审批标题和耗时。
- 费用：Claude 在浏览器验收那一轮的 `session.usage` 报告约 0.11 美元（含缓存的系统提示），其余没有单独统计。

| 项 | Claude Code | Codex | CodeBuddy |
|---|---|---|---|
| 版本 | 适配器 0.100.0 + claude 2.1.316（已验证版本） | codex-acp 2.5.0 + codex 0.165.0（已验证版本） | 引擎 2.115.0（已验证版本） |
| 检测 | 已安装、已登录（`auth status`，0.24 秒） | 已安装、已登录（0.11 秒） | 已安装、**未登录**（ACP 检查，5.5 秒） |
| session/new | 0.7 秒；5 个模型、6 档思考强度 | 2.4 秒；9 个模型、6 档思考强度 | 未执行 |
| 注入的 `aic-echo` 被拉起 | 是 | 是 | 未执行 |
| ① 只回复 OK | 通过，4.9 秒，没有调用工具 | 通过，5.0 秒，没有调用工具 | 未执行 |
| ② 审批一次 | 通过，5.0 秒：弹出“Write hello.txt”（允许一次 / 拒绝），允许后 hello.txt 内容为 hi | 通过，26.4 秒：`read-only` 模式下弹出“Edit files”（允许一次 / 拒绝），允许后 hello.txt 内容为 hi | 未执行 |
| 会话内换模型 | 通过：default → opus | 通过：gpt-5.6-sol → gpt-6.1-sol | 未执行 |
| 会话内换思考强度 | 通过：default → low | 通过：low → medium | 未执行 |
| ③ 换完再回复 OK | 通过，2.0 秒 | 通过，4.0 秒 | 未执行 |
| close → resume | 成功，0.8 秒；恢复后模型和强度回到默认（ISSUE-0012） | 成功，3.6 秒；恢复后模型和强度回到默认（ISSUE-0012） | 未执行 |
| 适配器警告 | 无 | 无 | — |

结论：Claude Code、Codex 通过；CodeBuddy 记为“需要登录”（没有替用户登录）。

## 实际操作（浏览器）

用 `.claude/launch.json` 的 `app` 配置开发预览（`preview_start("app")`，用 `.aic-data/dev-pairing-code.txt` 的配对码配对），测完 `preview_stop`。预览面板处于后台，截图一直超时，所以本次没有截图，以页面文本和 Gateway 事件表为证据。

1. Agent 页 → 四张卡片：演示 Agent 就绪；Claude Code 就绪（模型 5 个、能力“会话内换模型、可恢复会话、可以看图片”）；Codex 就绪；CodeBuddy“需要登录”，版本 2.115.0（已验证），模型“首次使用后显示模型列表”，详情区列出微信、Google / GitHub、iOA、在 WorkBuddy 中登录四种方式和 API Key 提示。
2. 点 [重新检测] → Codex 卡片出现 9 个模型（修复前只有点 [测试连接] 才有）。
3. 添加项目：通过文件夹浏览选择空的临时目录 `%TEMP%\aic-accept-project`，显示“不是 git 仓库”，命名“冒烟测试（临时空目录）”。
4. 在该项目里新建任务：Agent 选 Claude Code，模型和思考强度下拉框列出 Agent 的真实选项；“工作区内自动”“全自动”置灰并说明原因；出现“会直接修改项目文件”提示。内容“在当前目录新建 hello.txt，内容为 hi”，权限“需审批”，派发。
5. 约 4.8 秒后服务端发出审批请求，但页面停在“运行中”，看不到审批卡片 → 查明是实时事件只靠动画帧合并（ISSUE-0014），修复并重新构建后刷新页面：审批卡片显示标题“Write hello.txt”、文件路径、运行位置、原因，按钮“允许 / 拒绝…”。
6. 点 [允许] → 工具行“完成”，“已允许：Write hello.txt，由这台设备处理”，回复“已创建 hello.txt，内容为 hi。”，任务变为“待验收”；临时目录里确实生成了 hello.txt（2 字节）。工具行标题停在“Preparing file…”（ISSUE-0011）。
7. 输入框下方的切换器：Agent 区里其他 Agent 显示“交接：第 1.4 步提供”、CodeBuddy“未就绪”，均不可点；选 claude-haiku-5-5、思考强度 low → 对话里出现“已切换为模型 claude-haiku-5-5（会话内切换，无损），从下一条消息生效”和强度的同类提示，切换器显示“claude-haiku-5-5 · low”。
8. 发送“只回复 OK 两个字母，不要使用任何工具。” → 4 秒内实时显示回复“OK”，消息头的模型为 claude-haiku-5-5（这一步在修复后的页面上进行，没有刷新）。
9. 安全检查：扫描 `.aic-data/logs`、事件表和审计表，没有形如密钥（`sk-…`、`Bearer …`）的文本。

## 联调中发现并修复的问题（工作区，未提交）

| 问题 | 修复 | 测试 |
|---|---|---|
| Claude 被误报“未登录”：从 Git Bash 启动时 `HOME=/c/Users/...` 传给了 Windows 原生的 claude.exe | `buildChildEnv` 在 Windows 上删掉以 `/` 开头的 HOME；同时预防性删掉宿主 Claude Code / 桌面端注入的 `CLAUDECODE`、`CLAUDE_CODE_OAUTH_TOKEN`、`CLAUDE_CODE_HOST_*` 等变量（保留用户自己的 `CLAUDE_CODE_GIT_BASH_PATH` 等设置） | contract.test.ts 新增 2 项 |
| CodeBuddy 版本显示 0.0.0 | 从 `codebuddy.js` 里嵌入的 `@tencent-ai/codebuddy-code` 包信息读取真实版本，按文件修改时间缓存 | codebuddy-version.test.ts 3 项 |
| [重新检测] 不给 Codex、CodeBuddy 做探测会话，卡片一直没有模型（计划 6.3 要求重新检测时探测） | 用户点 [重新检测] 时，对已登录的 Agent 都做一次探测会话（session/new 不花钱）；未登录的不探测 | real-agent.test.ts 新增 1 项 |
| 窗口被遮挡时实时事件不刷新，审批卡片不出现（ISSUE-0014） | 动画帧和 100ms 定时器谁先到用谁 | 浏览器实测；无自动测试 |
| 冒烟测试的消息比约定多，且没有验证审批 | 改为“OK → 审批一次 → 换模型和强度 → OK → resume（不发消息）”，计划 6.8 同步修改 | 真实运行 |

接口对齐：网页 `api/http.ts` 调用的 12 个 REST 接口（`GET /agents`、`POST /agents/redetect`、`PATCH /agents/:kind`、登录及其取消和提交授权码、`POST /agents/:kind/test`、`/profiles` 的列表 / 新建 / 修改 / 删除、刷新模型列表）与 Gateway 路由逐个核对，路径、方法和请求体一致；网页同事报告的 `real-agent.test.ts` typecheck 失败在本轮开始时已不存在。

## 未通过 / 未验证

| 项 | 原因 | 问题单 |
|---|---|---|
| CodeBuddy 真实会话、模型列表、网页登录 | 本机未登录，按约定不替用户登录 | [ISSUE-0010](../issues/ISSUE-0010-codebuddy-smoke-not-run.md)、[ISSUE-0008](../issues/ISSUE-0008-codebuddy-login-fragile.md) |
| Claude 工具行标题停在“Preparing file…” | 适配器丢弃只改标题的 tool_call_update，协议没有对应事件 | [ISSUE-0011](../issues/ISSUE-0011-claude-tool-title-placeholder.md) |
| 恢复后切换过的配置是否保留（经 Gateway）、恢复后是否记得上下文、拒绝审批后文件确实没写（含 Codex Windows `read-only`） | 适配器层恢复后配置回到默认；Gateway 重新下发只在假 Agent 上验证；为控制费用没有多发消息 | [ISSUE-0012](../issues/ISSUE-0012-real-resume-and-reject-unverified.md) |
| 网页登录流程、API Key / 自定义地址账号的真实使用、未登录时 prompt 的错误形态 | Claude、Codex 已登录；需要用户配合和真实密钥 | [ISSUE-0013](../issues/ISSUE-0013-login-and-apikey-unverified.md)、[ISSUE-0007](../issues/ISSUE-0007-claude-terminal-login.md) |
| 模型能否真正调用注入的 MCP 工具 | 为控制费用，冒烟测试不再做；只确认了服务被拉起 | [ISSUE-0001](../issues/ISSUE-0001-acp-mcp-injection.md) |
| Codex 在网页里的完整对话 | 只在冒烟测试（适配器层）里跑过，网页验收选了 Claude Code | [ISSUE-0012](../issues/ISSUE-0012-real-resume-and-reject-unverified.md) |
| 修复 ISSUE-0014 后审批卡片的实时出现 | 修复后没有再发会触发审批的消息；流式回复的实时显示已验证 | [ISSUE-0014](../issues/ISSUE-0014-event-flush-raf-stall.md) |
| 截图 | 预览面板在后台，截图超时 | — |

## 备注

- 本次真实消息：Claude 冒烟 3 条 + 浏览器 2 条，Codex 冒烟 3 条，CodeBuddy 0 条。
- 浏览器验收留下的开发数据（临时项目“冒烟测试（临时空目录）”及其任务）只在 `.aic-data/`，不提交。
- `D:\tmp_frames.json` 是后端开发时留下的临时文件，删除被安全检查拦住，需要用户手动删除。

## 审查与修复（2026-11-07，工作区，未提交）

代码审查确认的 22 条问题逐条修复，每条都有测试（新增 `packages/adapters/test/review-fixes.test.ts` 11 项、`packages/gateway/test/review-fixes.test.ts` 13 项、`apps/web/src/lib/review-fixes.test.ts` 10 项；修改 `real-agent.test.ts` 审批超时一项的期望）。假 ACP Agent 新增 `stickyMode`、`setModeError`、`parallelPermissions`，启动日志记录 `argv`。

| # | 问题 | 修复 | 测试 |
|---|---|---|---|
| 1 | Claude 会加载工作区 `.claude/settings*.json`，hooks / allow 规则绕过审批 | session/new、resume、load 都带 `_meta.claudeCode.options = { settingSources: ['user'], allowDangerouslySkipPermissions: false }`（已核对 claude-agent-acp 0.100.0：客户端 options 覆盖默认的 `["user","project","local"]`）；CodeBuddy 启动参数加 `--setting-sources user`（已在 2.115.0 的 codebuddy.js 里找到该参数）；Codex 只在用户信任过的项目读项目配置。AgentInfo 新增 `workspaceConfig`，Agent 页“工作区设置”一栏和新建任务对话框按它提示 | 带恶意 settings.json 的契约测试（核对 _meta）、锁定版本源码顺序检查、CodeBuddy 启动参数；网页提示文案 |
| 2 | 权限模式设置失败或设置后仍更宽松时继续运行 | `applyInitial` 设置失败或设置后 `modeRank` 仍比预期宽松 → 关闭会话、抛 `permission.level_unavailable`；模式漂移时先 session/cancel 暂停本轮，改回前收到的审批一律拒绝，改回失败结束进程 | 两种失败都报错、进程关闭；更严格的模式照常启动 |
| 3 | API Key 进工具子进程、事件和审批记录 | Claude 进程注入 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`；Gateway 写事件前按密钥原文脱敏（流式分片用 `StreamRedactor` 按消息扣留可能是密钥开头的尾巴），审批的 title/reason/detail 同样处理，兜底错误也带密钥列表。CodeBuddy 没找到同类开关（`CODEBUDDY_CODE_DONT_INHERIT_ENV` 只作用于 shell 快照），只靠写入前脱敏 | 拆成两片的密钥、工具标题、工具输出、审批详情：推送帧、events 表、approvals 表都搜不到原文 |
| 4 | drain() 一次放行全部排队者 | drain 里同步占名额，acquire 不再在 await 之后加 | 上限 2、排队 3、释放 1 只放行 1；调大上限也不超 |
| 5 | 启动期间点 [停止] 任务变“失败” | `AcpConnection.start` 和 acpSpawn 监听取消信号，立即结束进程树并抛 AbortError；runTurn 对被停止的回合一律按暂停处理 | initialize 卡住时取消：适配器层抛 AbortError；Gateway 层任务暂停、没有错误事件、名额已释放 |
| 6 | 关窗口（SIGHUP）时兜底的 killAllSync 来不及执行 | `close({ deadlineMs })` 两段式：正常收尾最多等截止时间，到点先同步结束全部进程树再写库；SIGHUP 3 秒、SIGTERM 5 秒、Ctrl+C 8 秒 | 取消无响应的回合 + 孙进程：截止 300ms 时 6 秒内退出，Agent 和孙进程都不在 |
| 7 | 审批超时 / 撤回后状态停在“等待审批”；并行审批处理一条就显示运行中 | 审批结束后重新计算状态（还有未决 → 等待审批，否则运行中）；超时记标记，本轮结束后暂停并提示 | 并行两条审批：处理一条仍是等待审批；超时后暂停并有提示 |
| 8 | 取消无响应被结束进程后不通知 Gateway，名额占 30 分钟 | `kill()` 结束的进程也触发 onExit（带 killed）；runTurn 结束时发现进程已关闭也立即清理 | 取消无响应：会话结束、名额立即为 0 |
| 9 | 排队前信号已取消，永远挂在队列里 | acquire 开头和 Promise 内都先检查 `signal.aborted`；startRuntime 排队前再查一次 | 已取消的信号立即拒绝，队列为空 |
| 10 | H1 换模型实际没生效，界面和 Agent 不一致 | 适配器新增“启动时指定模型”（Claude `ANTHROPIC_MODEL`、Codex `CODEX_CONFIG.model`、CodeBuddy `--model`）；上个会话不能换模型时下次启动带上；没能下发的模型按 Agent 实际值写回 | 假 Agent 启动环境里看到新模型，任务记录一致；下发失败时写回 null |
| 11 | 模型换成功、强度失败时 Gateway 不知道 | `setConfig` 用 finally 推送 Agent 的真实配置；switch 出错时也按真实状态写回 | 强度失败时仍推出新模型 |
| 12 | 换账号需要排队时任务卡在“排队中”、请求挂住 | 换账号的启动不排队：名额被拿走时只换记录，提示下一条消息时再启动 | 上限 1 + 排队任务：PATCH 立即返回、状态不变、有提示 |
| 13 | 网页写死可选的权限级别 | AgentInfo 新增 `permissionLevels`（Gateway 按适配器填写），网页按它置灰，没有字段时退回原规则 | Gateway 返回字段；网页按字段判断 |
| 14 | 历史事件分页遇到不认识的事件整页失败 | `parseEventPage` 逐条 safeParse，跳过不认识的，分页按原始条数和 seq；phase-1.md 第 2 节第 5 条写明“客户端必须忽略不认识的事件类型” | 混入未知事件的分页 |
| 15 | 复制链接、打开授权页没走 Platform | Platform 新增 `openExternal`、`copyText`，登录框改用它们 | 类型检查；浏览器版实现 |
| 16 | `agents.login_force` 未声明、通用按钮不认识 | protocol `ErrorActionKey.LoginForce` 写明 args；`runErrorAction` 实现二次确认后带 force 重新登录 | 类型检查 |
| 17 | 删除账号、登录取消 / 提交授权码的响应没有类型 | protocol 新增 `OkResult`、`DeleteProfileResult`，Gateway 和网页都引用；删除提示用服务端的 keptDir | DeleteProfileResult 解析 |
| 18 | 切换器把换账号一律标“恢复会话（无损）” | ProfileSummary 新增不透明的 `sessionStore`（Codex 的 API Key 账号总是独立目录）；存放位置不同的账号在切换器里置灰并标“需要交接，第 1.4 步提供”，Gateway 也拒绝（`session.not_recoverable`）；没有进程时换账号也先试着恢复原会话（不再按账号筛选），恢复不了时发“Agent 不记得之前的对话”提示 | 没有进程时换账号走 resume；独立目录的账号 409 且任务记录不变；网页标注 |
| 19 | 切换、登录出错只弹纯文字提示 | 切换器、输入框、登录框、账号区、默认设置的错误都在原处用 ErrorNotice 显示（带按钮和关闭）；其他地方带 actions 的错误进右下角不自动消失的 alert 块，无按钮的才用提示条；`session.not_recoverable` 补“去 Agent 页” | showError 分流、默认按钮 |
| 20 | 执行中切换不先询问 | 运行中 / 等待审批 / 排队时换账号或 H1 换模型，先问“等当前步骤完成 / 立即中断”，选择后排到本轮结束自动执行（切换器里可以撤销）；H0 直接生效 | switchNeedsTurnEnd |
| 21 | 没有“默认模型”设置 | PATCH /agents/:kind 支持 `defaultModel`、`defaultEffort`，Agent 页改成下拉框，新建任务对话框优先用它 | Gateway 设置 / 返回；网页 taskDefaults |
| 22 | 登录框整块是 aria-live | 去掉外层 role=status，只有一行隐藏文字播报状态 | loginAnnounceText |

验证：`npm run typecheck`、`npm test`（adapters 59 项 + 3 项跳过、gateway 89、protocol 8、web 56）、`npm run build` 全部通过。浏览器回归（preview `app`）：配对、打开已有 Claude 任务历史、Agent 页“默认模型 / 默认思考强度 / 工作区设置”、设默认模型后新建任务对话框带出该模型（随后改回）、Codex 的工作区提示、真实 Agent 后两档权限置灰、切换器弹出层、演示 Agent 两次审批（处理第一条后仍是“等待审批”，处理完变“待验收”），控制台无错误。本轮没有调用真实 Agent 发消息。

未验证：Claude 的 `settingSources`、`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 和 CodeBuddy 的 `--setting-sources user` 只核对了锁定版本的源码，没有用真实 Agent 跑带恶意 settings.json 的仓库；H1 启动时指定模型只在假 Agent 上验证；“执行中切换先问”、页面 alert 块的实际点击没有在浏览器里触发（演示 Agent 不会进入这些分支），只有单元测试。
