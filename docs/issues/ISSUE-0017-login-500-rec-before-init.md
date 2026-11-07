# ISSUE-0017：点 CodeBuddy 的登录按钮报“服务内部错误”

| 项 | 值 |
|---|---|
| 状态 | fixed |
| 类型 | bug |
| 严重程度 | 高 |
| 发现于 | 用户人工验证（2026-11-07） |
| 开启 | 2026-11-07 |
| 关闭 | 2026-11-07 |

## 现象

Agent 页点 CodeBuddy 的“微信登录”等按钮，右下角提示“服务内部错误”。终端里是 `ReferenceError: Cannot access 'rec' before initialization`，位置在 `service.ts` 的 `onProgress`。

## 根因

`AgentService.login` 先调用 `a.startLogin(...)`，再声明登录记录 `rec`。CodeBuddy 适配器在 `startLogin` 里同步回调一次 `onProgress('started')`，回调访问 `rec` 时它还处在暂时性死区，抛出异常，接口返回 500。演示 Agent 和假 Agent 不会同步回调，所以 1.2 的测试没有覆盖到。

## 处理方式

先建登录记录，再调用 `startLogin`，并把返回的 handle 写回记录。

## 验证

新增 `packages/gateway/test/login-sync-progress.test.ts`：用一个同步回调进度的适配器调用登录接口。修复前返回 500，修复后返回 202，登录事件依次为 started、succeeded。

## 时间线

- 2026-11-07 开启并修复。
