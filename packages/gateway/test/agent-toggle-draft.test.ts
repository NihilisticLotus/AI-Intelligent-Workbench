// Agent 启用开关（design.md 6.7）和任务草稿（design.md 15.2），2026-11-07 用户要求。
import { afterEach, expect, it } from 'vitest';
import type { AgentAdapter } from '@aic/adapters';
import { createFakeAdapter } from '@aic/adapters';
import { MemorySecretStore } from '../src/secrets';
import { startGw, type TestGw } from './helpers';

let t: TestGw | null = null;
afterEach(async () => { await t?.stop(); t = null; });

/** 记录检测次数的“真实”适配器 */
function countingAdapter(id: 'codebuddy' | 'codex', counter: { n: number }): AgentAdapter {
  const base = createFakeAdapter({ speed: 0 });
  return {
    ...base, id, displayName: id === 'codex' ? '假 Codex' : '假 CodeBuddy', real: true,
    async detect() {
      counter.n++;
      return { installed: true, version: '1.0.0', enginePath: null, loggedIn: true, message: null, loginCheck: 'acp', checkedAt: Date.now() };
    },
  } as AgentAdapter;
}

it('默认只启用 Claude Code、Codex：关闭的 Agent 不检测，status 为 disabled', async () => {
  const cb = { n: 0 }, cx = { n: 0 };
  t = await startGw({ secretStore: new MemorySecretStore(), adapters: () => [countingAdapter('codebuddy', cb), countingAdapter('codex', cx)] } as never);
  const token = await t.pair();
  const r = await t.api('GET', '/agents', { token });
  const items = r.json.items as { kind: string; status: string; enabled: boolean }[];
  expect(items.find((a) => a.kind === 'codebuddy')).toMatchObject({ status: 'disabled', enabled: false });
  expect(items.find((a) => a.kind === 'codex')).toMatchObject({ status: 'ready', enabled: true });
  expect(cb.n).toBe(0);
  expect(cx.n).toBeGreaterThan(0);
  // 重新检测也跳过关闭的
  await t.api('POST', '/agents/redetect', { token });
  expect(cb.n).toBe(0);
});

it('打开后立即检测；关闭后不能新建任务，也不能测试连接', async () => {
  const cb = { n: 0 };
  t = await startGw({ secretStore: new MemorySecretStore(), adapters: () => [countingAdapter('codebuddy', cb)] } as never);
  const token = await t.pair();
  const on = await t.api('PATCH', '/agents/codebuddy', { token, body: { enabled: true } });
  expect(on.status).toBe(200);
  expect(on.json).toMatchObject({ enabled: true, status: 'ready' });
  expect(cb.n).toBe(1);

  const off = await t.api('PATCH', '/agents/codebuddy', { token, body: { enabled: false } });
  expect(off.json).toMatchObject({ enabled: false, status: 'disabled' });
  const p = await t.api('POST', '/projects', { token, body: { name: 'p', path: t.dataDir } });
  const task = await t.api('POST', '/tasks', { token, body: { projectId: p.json.id, agent: 'codebuddy', prompt: 'hi', permission: 'ask' } });
  expect(task.status).toBe(503);
  expect(task.json.message).toContain('已关闭');
  const test = await t.api('POST', '/agents/codebuddy/test', { token });
  expect(test.json.message).toContain('已关闭');
});

it('草稿：按任务保存文字和注释，空草稿等于删除，任务不存在时 404', async () => {
  t = await startGw({ fakeSpeed: 0 } as never);
  const token = await t.pair();
  const p = await t.api('POST', '/projects', { token, body: { name: 'p', path: t.dataDir } });
  const task = await t.api('POST', '/tasks', { token, body: { projectId: p.json.id, agent: 'fake', prompt: 'hi', permission: 'ask' } });
  const id = task.json.id as string;

  const empty = await t.api('GET', `/tasks/${id}/draft`, { token });
  expect(empty.json).toEqual({ text: '', annotations: [], updatedAt: null });

  const body = { text: '看下这处', annotations: [{ id: 'an1', text: '原文', raw: '原文', pos: 12, comment: '这里不对' }] };
  const put = await t.api('PUT', `/tasks/${id}/draft`, { token, body });
  expect(put.status).toBe(200);
  const got = await t.api('GET', `/tasks/${id}/draft`, { token });
  expect(got.json).toMatchObject(body);
  expect(got.json.updatedAt).toBeGreaterThan(0);

  await t.api('PUT', `/tasks/${id}/draft`, { token, body: { text: '  ', annotations: [] } });
  expect((await t.api('GET', `/tasks/${id}/draft`, { token })).json.updatedAt).toBeNull();

  expect((await t.api('GET', '/tasks/t_nope/draft', { token })).status).toBe(404);
  // 超长评论被拒绝
  const bad = await t.api('PUT', `/tasks/${id}/draft`, { token, body: { text: '', annotations: [{ id: 'a', text: 'x', comment: 'x'.repeat(2001) }] } });
  expect(bad.status).toBe(400);
});
