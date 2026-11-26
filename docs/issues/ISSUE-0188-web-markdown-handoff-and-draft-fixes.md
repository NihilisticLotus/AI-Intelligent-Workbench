# ISSUE-0188：网页 Markdown 远程图片/非安全链接防护、待交接思考强度丢失、草稿锁死与 WS 状态同步修正

| 项 | 值 |
|---|---|
| 状态 | fixed |
| 类型 | 安全边界 / bug |
| 严重程度 | 高 |
| 发现于 | 2026-11-26 全项目代码审查 |
| 开启 | 2026-11-26 |
| 关闭 | 2026-11-26 |

## 现象与根因

1. `apps/web/src/components/Chat.tsx` 的 `RichText` 未拦截远程 `<img>`（提示词注入可零点击外泄数据），对非 `http(s)` 链接（`//evil.com`、`#pair=...`、`href=""`）漏调 `preventDefault()`，`platform/browser.ts` 的 `openExternal` 未校验协议白名单。
2. `Composer.tsx` 在待交接（`target`）状态硬编码 `efforts: []`，导致切换到 Antigravity / Codex / ZCode 时思考强度选项全部消失；切回原 Agent 时也会吞掉新选的模型/强度。
3. `new-task-page.tsx` 创建草稿任务后永久锁死表单（取消确认或发送失败无法换 Agent 重试），且 `lib/new-task.ts` 无图推荐分支漏检 `a.status === 'ready'`。
4. `AgentsPage.tsx` 开启未安装/未登录的 Antigravity / ZCode 时强行调用 `testAgent` 误弹失败提示，且未安装卡片仍显示“未验证版本”；`Sidebar.tsx` 在局域网访问时仍固定写“仅本机访问”；`network-settings.tsx` 文案漏掉 Antigravity 与 ZCode。
5. `api/ws.ts` 与 `state/app.ts` 遇到未知未来事件或服务端过滤事件时未推进 `wsSeq` 游标与续期补发超时、未传入 `initialBootId`、重启未清 `logins`；`api/http.ts` 附件接口遇非 JSON 401 时漏调 `onUnauthorized`。

## 处理方式

- 收紧 `RichText`（`urlTransform` 仅放行绝对 `http(s)`、拦截远程 `<img>`、非安全链接渲染纯文本 `<span>`）与 `browser.ts` `openExternal` 协议校验。
- `Composer.tsx` 改 `efforts: undefined` 并补齐切回原 Agent 的配置下发，`AgentPicker.tsx` 支持任务内直接点选目标 Agent 思考强度。
- `new-task-page.tsx` 解除草稿重试表单锁定并在参数变化时替换旧草稿，`lib/new-task.ts` 补 `status === 'ready'` 过滤；`AgentsPage.tsx` 仅在开启后 `status === 'ready'` 且缺模型时自动测试并修正未安装状态版本标注。
- `api/ws.ts`、`state/app.ts`、`api/http.ts`、`Sidebar.tsx`、`network-settings.tsx` 同步修复上述状态与文案问题。

## 验证

- `apps/web/src/review-2026-11-26.test.ts` 与网页全量单测、构建通过，并在浏览器核验，详见 [workbench-review-2026-11-26.md](../acceptance/workbench-review-2026-11-26.md)。

## 时间线

- 2026-11-26：全项目代码审查发现、修复并验证关闭。
