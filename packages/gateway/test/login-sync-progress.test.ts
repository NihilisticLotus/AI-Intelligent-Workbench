// 回归测试（2026-11-07 用户报告）：适配器在 startLogin 里同步回调 onProgress('started') 时，
// 登录接口曾因访问尚未声明的 rec 抛 ReferenceError，返回 500“服务内部错误”。
import { afterEach, expect, it } from 'vitest';
import type { AgentAdapter } from '@aic/adapters';
import { createFakeAdapter } from '@aic/adapters';
import { MemorySecretStore } from '../src/secrets';
import { startGw, type TestGw } from './helpers';

let t: TestGw | null = null;
afterEach(async () => { await t?.stop(); t = null; });

/** 在演示 Agent 基础上改成“真实”的、只支持浏览器登录、并且同步回调进度的适配器 */
function syncLoginAdapter(): AgentAdapter {
  const base = createFakeAdapter({ speed: 0 });
  return {
    ...base,
    id: 'codebuddy', displayName: '假 CodeBuddy', real: true,
    async detect() {
      return {
        installed: true, version: '1.0.0', enginePath: null, loggedIn: false, message: null,
        authMethods: [{ id: 'internal', name: '微信登录', description: null, flow: 'browser' }], loginCheck: 'acp', checkedAt: Date.now(),
      };
    },
    startLogin(req) {
      req.onProgress({ state: 'started' }); // 同步回调：触发过 bug 的关键
      return { done: Promise.resolve({ state: 'succeeded' as const }), cancel() {} };
    },
  } as AgentAdapter;
}

it('登录：适配器同步回调进度时接口正常返回 loginId，登录事件按顺序写入', async () => {
  t = await startGw({ secretStore: new MemorySecretStore(), adapters: () => [syncLoginAdapter()] } as never);
  const token = await t.pair();
  const r = await t.api('POST', '/agents/codebuddy/login', { token, body: { methodId: 'internal' } });
  expect(r.status).toBe(202);
  expect(r.json.loginId).toBeTruthy();
  await new Promise((res) => setTimeout(res, 100));
  const states = t.gw.services.events.read({ after: 0, limit: 1000 })
    .filter((e) => e.type === 'agent.login').map((e) => (e.data as { state: string }).state);
  expect(states).toEqual(['started', 'succeeded']);
});
