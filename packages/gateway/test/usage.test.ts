import { afterEach, describe, expect, it } from 'vitest';
import { TaskUsage, type IndependentRequestRecord } from '@aic/protocol';
import { startGw, makeProject, type TestGw } from './helpers';
import { emptyUsage, independentTurnUsage, recordTurnUsage, sumUsage, taskUsage } from '../src/usage';
import { openDb } from '../src/db';
import path from 'node:path';

let t: TestGw | undefined;
afterEach(async () => { await t?.stop(); t = undefined; });
async function setup(deferPrompt = false) {
  t = await startGw(); const token = await t.pair(), project = await makeProject(t, token);
  const response = await t.api('POST', '/tasks', { token, body: { projectId: project.id, prompt: '离线用量测试', agent: 'fake', permission: 'readonly', deferPrompt } });
  expect(response.status).toBe(201); await t.gw.services.tasks.idle();
  return { token, id: response.json.id as string, s: t.gw.services };
}

describe('用量持久化与汇总', () => {
  it('两轮分别一行一事件，合计正确；同轮重复写入不重复计费，落盘后仍可查询', async () => {
    const { token, id, s } = await setup();
    await s.tasks.prompt(id, '第二轮'); await s.tasks.idle();
    const usage = TaskUsage.parse((await t!.api('GET', `/tasks/${id}/usage`, { token })).json);
    expect(usage).toMatchObject({ turns: 2, reportedTurns: 2, total: { inputTokens: 2000, outputTokens: 400, totalTokens: 2400 } });
    expect(usage.segments).toHaveLength(1);
    const events = s.events.read({ after: 0, limit: 1000, taskId: id }).filter((e) => e.type === 'turn.usage');
    expect(events).toHaveLength(2);
    const users = s.events.read({ after: 0, limit: 1000, taskId: id }).filter((e) => e.type === 'message.user');
    expect(events.map((e) => e.data.messageId)).toEqual(users.map((e) => e.data.messageId));
    recordTurnUsage(s.db, s.events, id, events[0]!.sessionId, events[0]!.data.messageId, events[0]!.data.usage);
    expect(s.db.all('SELECT * FROM turn_usage WHERE task_id=?', id)).toHaveLength(2);
    expect(s.events.read({ after: 0, limit: 1000, taskId: id }).filter((e) => e.type === 'turn.usage')).toHaveLength(2);
    expect(taskUsage(s.db, id)).toEqual(usage);
    const reopened = openDb(path.join(t!.dataDir, 'data.db'));
    try { expect(taskUsage(reopened, id)).toEqual(usage); } finally { reopened.close(); }
  });
  it('多段汇总保留各段来源，未报告轮次不算零；旧任务没有回填伪造用量', async () => {
    const { id, s } = await setup(true);
    expect(taskUsage(s.db, id)).toMatchObject({ turns: 0, reportedTurns: 0, segments: [], total: { totalTokens: null } });
    for (const session of ['one', 'two']) s.db.run('INSERT INTO sessions(id,task_id,agent_id,model,status,started_at) VALUES (?,?,?,?,?,?)', session, id, 'fake', session, 'idle', 10);
    recordTurnUsage(s.db, s.events, id, 'one', 'm1', { ...emptyUsage('agent'), inputTokens: 10, totalTokens: 12 });
    recordTurnUsage(s.db, s.events, id, 'one', 'm2', emptyUsage('agent'));
    recordTurnUsage(s.db, s.events, id, 'two', 'm3', { ...emptyUsage('agent'), inputTokens: 20, outputTokens: 0 });
    const result = taskUsage(s.db, id);
    expect(result).toMatchObject({ turns: 3, reportedTurns: 2, total: { inputTokens: 30, outputTokens: 0, totalTokens: 12, thoughtTokens: null } });
    expect(result.segments.map((v) => [v.sessionId, v.turns, v.reportedTurns])).toEqual([['one', 2, 1], ['two', 1, 1]]);
    s.db.run('DELETE FROM tasks WHERE id=?', id);
    expect(s.db.all('SELECT * FROM turn_usage WHERE task_id=?', id)).toEqual([]);
  });
  it('未报告、失败和取消都写未知；已知用量与事件在同一事务回滚', async () => {
    const { id, s } = await setup(true);
    const adapter = s.agents.get('fake')!;
    const original = adapter.spawn;
    let mode = 'missing';
    adapter.spawn = async (opts) => ({ ...(await original.call(adapter, opts)), agentSessionId: 'usage-fixture',
      setConfig: async () => {}, close: async () => {}, prompt: async () => {
        if (mode === 'failed') throw new Error('合成失败');
        if (mode === 'cancelled') return { stopReason: 'cancelled', usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, thoughtTokens: null, cacheReadTokens: null, cacheWriteTokens: null } };
        return { stopReason: 'end_turn' };
      } });
    for (mode of ['missing', 'failed', 'cancelled']) { await s.tasks.prompt(id, mode); await s.tasks.idle(); }
    expect(taskUsage(s.db, id)).toMatchObject({ turns: 3, reportedTurns: 0, total: emptyUsage('agent') });
    const before = s.events.lastSeq();
    expect(() => s.db.tx(() => { recordTurnUsage(s.db, s.events, id, null, 'rollback', emptyUsage('agent')); throw new Error('回滚'); })).toThrow('回滚');
    expect(s.events.lastSeq()).toBe(before); expect(taskUsage(s.db, id).turns).toBe(3);
  });
  it('接口仍校验令牌、Origin、Host；不存在的任务为404', async () => {
    const { token, id } = await setup(true);
    expect((await t!.api('GET', `/tasks/${id}/usage`)).status).toBe(401);
    expect((await t!.api('GET', `/tasks/${id}/usage`, { token, headers: { origin: 'https://invalid.example' } })).status).toBe(403);
    expect((await t!.api('GET', `/tasks/${id}/usage`, { token, headers: { host: 'invalid.example' } })).status).toBe(403);
    expect((await t!.api('GET', '/tasks/missing/usage', { token })).status).toBe(404);
    expect((await t!.api('GET', '/hello', { token })).json.features.taskUsage).toBe(true);
  });
  it('会话启动前失败仍记未知轮次，不伪造会话身份', async () => {
    const { id, s } = await setup(true);
    s.agents.get('fake')!.spawn = async () => { throw new Error('合成启动失败'); };
    await s.tasks.prompt(id, '启动失败'); await s.tasks.idle();
    expect(taskUsage(s.db, id)).toMatchObject({ turns: 1, reportedTurns: 0, segments: [{ sessionId: null, totals: emptyUsage('agent') }] });
  });
  it('独立多请求逐项合计、缺项传播、排除计数请求和溢出', () => {
    const record = (kind: 'model' | 'counter', usage: unknown) => ({ attempt: { kind }, settlement: { usage } }) as IndependentRequestRecord;
    const first = { inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: null, totalTokens: 13, thoughtTokens: 2 };
    const result = independentTurnUsage([record('model', first), record('counter', null), record('model', { ...first, inputTokens: 20, totalTokens: 23, thoughtTokens: null })]);
    expect(result).toEqual({ inputTokens: 30, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: null, totalTokens: 36, thoughtTokens: null });
    expect(independentTurnUsage([record('model', first), record('model', null)]).inputTokens).toBeNull();
    expect(independentTurnUsage([]).inputTokens).toBeNull();
    expect(sumUsage([{ ...first, totalTokens: Number.MAX_SAFE_INTEGER }, first], 'agent').totalTokens).toBeNull();
  });
});
