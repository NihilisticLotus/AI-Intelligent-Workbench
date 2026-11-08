// 事件归并测试：同一 seq 不重复应用、乱序到达按 seq 处理、快照不覆盖更新的实时状态、时间线推导。
import { describe, expect, it } from 'vitest';
import type { Approval, EventEnvelope, Task } from '@aic/protocol';
import {
  applyEvent, applyEvents, applyTaskSnapshot, blockingError, buildTimeline, emptyCore, insertBySeq, lastUserText, latestPlan, mergeRestTask,
  sessionConfig,
} from './core';

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1', projectId: 'p1', groupId: null, title: '修复存档损坏', prompt: '查原因', status: 'running', permission: 'ask',
  agent: 'fake', model: '演示-快', effort: '中', autoAllowLowRisk: true, autoMergeOnPass: false,
  lastActivityAt: 1, createdAt: 1, updatedAt: 1, ...over,
});
const approval = (over: Partial<Approval> = {}): Approval => ({
  id: 'a1', taskId: 't1', sessionId: 's1', title: '演示 Agent 请求执行命令', reason: '跑测试', detail: 'dotnet test',
  cwd: null, options: [{ id: 'allow', label: '允许', kind: 'allow_once' }, { id: 'reject', label: '拒绝', kind: 'reject_once' }],
  status: 'pending', decidedBy: null, createdAt: 1, expiresAt: null, ...over,
});

let ts = 1000;
const E = {
  delta: (seq: number, text: string, messageId = 'm1'): EventEnvelope =>
    ({ seq, ts: ts++, taskId: 't1', sessionId: 's1', type: 'message.delta', data: { messageId, text } }),
  updated: (seq: number, t: Task): EventEnvelope =>
    ({ seq, ts: ts++, taskId: t.id, sessionId: null, type: 'task.updated', data: { task: t } }),
  user: (seq: number, text: string): EventEnvelope =>
    ({ seq, ts: ts++, taskId: 't1', sessionId: 's1', type: 'message.user', data: { messageId: 'u' + seq, text } }),
};
const textOf = (events: EventEnvelope[]) =>
  buildTimeline(events).flatMap((it) => (it.kind === 'agent' ? [it.text] : [])).join('|');

describe('insertBySeq', () => {
  it('按 seq 有序插入，重复 seq 返回原数组', () => {
    let l = insertBySeq(undefined, E.delta(2, 'b'));
    l = insertBySeq(l, E.delta(5, 'e'));
    l = insertBySeq(l, E.delta(1, 'a'));
    l = insertBySeq(l, E.delta(3, 'c'));
    expect(l.map((e) => e.seq)).toEqual([1, 2, 3, 5]);
    expect(insertBySeq(l, E.delta(3, 'c'))).toBe(l);
  });
});

describe('applyEvent', () => {
  it('同一 seq 不重复应用', () => {
    let s = emptyCore();
    s = applyEvent(s, E.delta(1, '你'));
    s = applyEvent(s, E.delta(2, '好'));
    const again = applyEvent(s, E.delta(2, '好'));
    expect(again).toBe(s);
    s = applyEvents(s, [E.delta(1, '你'), E.delta(2, '好'), E.delta(3, '！')]);
    expect(textOf(s.logs.t1!)).toBe('你好！');
  });

  it('乱序到达的流式片段按 seq 拼接', () => {
    const s = applyEvents(emptyCore(), [E.delta(3, 'C'), E.delta(1, 'A'), E.delta(2, 'B')]);
    expect(s.logs.t1!.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(textOf(s.logs.t1!)).toBe('ABC');
  });

  it('乱序到达的任务更新：旧事件不覆盖新状态', () => {
    let s = applyEvent(emptyCore(), E.updated(10, task({ status: 'review' })));
    s = applyEvent(s, E.updated(9, task({ status: 'running' })));
    expect(s.tasks.t1!.status).toBe('review');
    s = applyEvent(s, E.updated(11, task({ status: 'waiting' })));
    expect(s.tasks.t1!.status).toBe('waiting');
  });

  it('审批先收到结果、后收到请求时，保持已处理', () => {
    const resolved: EventEnvelope = { seq: 8, ts: 1, taskId: 't1', sessionId: 's1', type: 'approval.resolved', data: { approvalId: 'a1', status: 'allowed', decidedBy: 'd1', optionId: 'allow' } };
    const requested: EventEnvelope = { seq: 7, ts: 1, taskId: 't1', sessionId: 's1', type: 'approval.requested', data: { approval: approval() } };
    const s = applyEvents(emptyCore(), [resolved, requested]);
    expect(s.approvals.a1).toBeUndefined(); // 没有进入“待处理”
    const tl = buildTimeline(s.logs.t1!);
    const card = tl.find((x) => x.kind === 'approval');
    expect(card && card.kind === 'approval' && card.resolved?.status).toBe('allowed');
  });

  it('wsSeq 只记录实时流的最大 seq，历史事件不推进它', () => {
    let s = applyEvents(emptyCore(), [E.delta(5, 'x')], 'ws');
    s = applyEvents(s, [E.delta(100, 'y', 'm2')], 'history');
    expect(s.wsSeq).toBe(5);
    s = applyEvent(s, E.delta(5, 'x'), 'ws'); // 重复的实时事件也不倒退
    expect(s.wsSeq).toBe(5);
  });

  it('REST 快照不会覆盖已经收到的更新事件', () => {
    let s = applyEvent(emptyCore(), E.updated(20, task({ status: 'review' })));
    s = applyTaskSnapshot(s, [task({ status: 'running' }), task({ id: 't2' })], 15);
    expect(s.tasks.t1!.status).toBe('review');
    expect(s.tasks.t2).toBeDefined();
    s = applyEvent(s, E.updated(16, task({ id: 't2', status: 'failed' })));
    expect(s.tasks.t2!.status).toBe('failed');
  });

  it('历史与实时重叠时只保留一份', () => {
    let s = applyEvents(emptyCore(), [E.delta(4, 'D'), E.delta(5, 'E')], 'ws');
    s = applyEvents(s, [E.delta(1, 'A'), E.delta(2, 'B'), E.delta(3, 'C'), E.delta(4, 'D')], 'history');
    expect(textOf(s.logs.t1!)).toBe('ABCDE');
  });
});

describe('buildTimeline 合并', () => {
  it('任务结束后关闭没有确认事件的文字与思考进度，保留可见片段', () => {
    for (const status of ['review', 'paused', 'interrupted', 'failed', 'merged', 'discarded'] as const) {
      const result = buildTimeline([
        { seq: 1, ts: 1, taskId: 't1', sessionId: 's1', type: 'thought.delta', data: { messageId: 'm1', text: '准备操作' } },
        E.delta(2, '尚未确认的片段'),
        E.updated(3, task({ status })),
      ]).filter((item) => item.kind === 'agent');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ done: true, text: '尚未确认的片段', thought: '准备操作' });
    }
  });
  it('排队、运行和等待审批仍显示进度，失败后新回合可以继续', () => {
    for (const status of ['queued', 'running', 'waiting'] as const) {
      const result = buildTimeline([E.delta(1, '处理中'), E.updated(2, task({ status }))]);
      expect(result[0]).toMatchObject({ done: false });
    }
    const result = buildTimeline([
      E.delta(1, '旧片段'), E.updated(2, task({ status: 'failed' })),
      E.user(3, '继续'), E.updated(4, task({ status: 'running' })), E.delta(5, '新片段', 'm2'),
    ]).filter((item) => item.kind === 'agent');
    expect(result.map((item) => [item.text, item.done])).toEqual([['旧片段', true], ['新片段', false]]);
  });
  it('消息确认可携带已提交的完整正文，替换暂存流片段且兼容非流响应', () => {
    let seq = 0;
    const event = (type: string, data: unknown) => ({ seq: ++seq, ts: seq, taskId: 't1', sessionId: 's1', type, data } as EventEnvelope);
    const result = buildTimeline([
      event('message.delta', { messageId: 'm1', text: '部分' }),
      event('message.done', { messageId: 'm1', text: '已提交完整正文' }),
      event('message.user', { messageId: 'user2', text: '继续' }),
      event('message.done', { messageId: 'm2', text: '非流完整响应' }),
    ]).filter((item) => item.kind === 'agent');
    expect(result.map((item) => item.kind === 'agent' && [item.text, item.done])).toEqual([['已提交完整正文', true], ['非流完整响应', true]]);
  });
  it('思考和正文用了不同 messageId 时合并成一条消息', () => {
    let seq = 100;
    const b = (type: string, data: unknown): EventEnvelope =>
      ({ seq: ++seq, ts: seq, taskId: 't1', sessionId: 's1', type, data } as EventEnvelope);
    const tl = buildTimeline([
      b('thought.delta', { messageId: 'th1', text: '想一想' }),
      b('message.delta', { messageId: 'm1', text: '好的' }),
      b('message.done', { messageId: 'm1' }),
      b('session.config', { model: 'demo-deep', effort: null }),
    ]);
    expect(tl.map((x) => x.kind)).toEqual(['agent', 'config']);
    const a = tl[0]!;
    expect(a.kind === 'agent' && [a.thought, a.text, a.done]).toEqual(['想一想', '好的', true]);
  });
});

describe('buildTimeline', () => {
  it('思考、正文、连续的工具调用、计划、审批', () => {
    let seq = 0;
    const b = (type: string, data: unknown): EventEnvelope =>
      ({ seq: ++seq, ts: seq * 1000, taskId: 't1', sessionId: 's1', type, data } as EventEnvelope);
    const events = [
      b('session.started', { agent: 'fake', model: '演示-快' }),
      b('message.user', { messageId: 'u1', text: '查一下存档' }),
      b('thought.delta', { messageId: 'm1', text: '先看看' }),
      b('thought.delta', { messageId: 'm1', text: '存档代码' }),
      b('message.delta', { messageId: 'm1', text: '我来看看' }),
      b('tool.start', { toolId: 'x1', kind: 'read', title: '读取', target: 'Assets/Scripts/Save/SaveManager.cs' }),
      b('tool.end', { toolId: 'x1', ok: true, summary: '186 行' }),
      b('tool.start', { toolId: 'x2', kind: 'search', title: '搜索', target: 'WriteAllText' }),
      b('tool.end', { toolId: 'x2', ok: false, summary: null }),
      b('plan.update', { items: [{ text: '定位', status: 'in_progress' }] }),
      b('plan.update', { items: [{ text: '定位', status: 'completed' }, { text: '修复', status: 'in_progress' }] }),
      b('message.done', { messageId: 'm1' }),
      b('approval.requested', { approval: approval() }),
    ];
    const tl = buildTimeline(events);
    expect(tl.map((x) => x.kind)).toEqual(['user', 'agent', 'tools', 'plan', 'approval']);
    const ag = tl[1]!;
    expect(ag.kind === 'agent' && [ag.thought, ag.text, ag.done, ag.model, ag.thoughtEnd! - ag.thoughtStart!]).toEqual(['先看看存档代码', '我来看看', true, '演示-快', 1000]);
    const tools = tl[2]!;
    expect(tools.kind === 'tools' && tools.tools.map((t) => t.state)).toEqual(['ok', 'failed']);
    const plan = tl[3]!;
    expect(plan.kind === 'plan' && plan.items).toHaveLength(2);
    expect(latestPlan(events)?.data.items[1]?.text).toBe('修复');
  });
});

describe('复核修复', () => {
  const b = (seq: number, type: string, data: unknown): EventEnvelope =>
    ({ seq, ts: ts++, taskId: 't1', sessionId: 's1', type, data } as EventEnvelope);

  it('REST 返回的任务不覆盖已经由事件更新过的任务（事件可能更新）', () => {
    // WebSocket 先到：任务已经在等审批
    let s = applyEvent(emptyCore(), E.updated(10, task({ status: 'waiting' })));
    // PATCH 的 HTTP 响应后到，里面还是运行中
    s = mergeRestTask(s, task({ status: 'running', groupId: 'g1' }));
    expect(s.tasks.t1!.status).toBe('waiting');
    // 本地还没有的任务（新建后事件还没到）照常写入
    const fresh = mergeRestTask(emptyCore(), task({ id: 't9' }));
    expect(fresh.tasks.t9).toBeDefined();
    // 随后的事件仍然能覆盖它
    expect(applyEvent(fresh, E.updated(3, task({ id: 't9', status: 'review' }))).tasks.t9!.status).toBe('review');
  });

  it('用户拒绝的工具显示为 rejected，不是 failed；审批结果带设备名', () => {
    const tl = buildTimeline([
      b(1, 'tool.start', { toolId: 'x', kind: 'execute', title: '执行命令', target: 'Unity.exe -runTests' }),
      b(2, 'approval.requested', { approval: approval() }),
      b(3, 'approval.resolved', { approvalId: 'a1', status: 'rejected', decidedBy: 'd1', optionId: 'reject', decidedByName: '制作人的电脑' }),
      b(4, 'tool.end', { toolId: 'x', ok: false, summary: '用户拒绝执行', rejected: true }),
    ]);
    const tools = tl.find((x) => x.kind === 'tools');
    expect(tools?.kind === 'tools' && tools.tools[0]!.state).toBe('rejected');
    const ap = tl.find((x) => x.kind === 'approval');
    expect(ap?.kind === 'approval' && ap.resolved).toEqual({ status: 'rejected', decidedBy: 'd1', decidedByName: '制作人的电脑' });
    const s = applyEvents(emptyCore(), [b(2, 'approval.requested', { approval: approval() }), b(3, 'approval.resolved', { approvalId: 'a1', status: 'allowed', decidedBy: 'd1', optionId: 'allow', decidedByName: '平板' })]);
    expect(s.approvals.a1).toMatchObject({ status: 'allowed', decidedByName: '平板' });
  });
});

describe('1.2：真实 Agent', () => {
  const b = (seq: number, type: string, data: unknown, taskId: string | null = 't1'): EventEnvelope =>
    ({ seq, ts: ts++, taskId, sessionId: taskId ? 's1' : null, type, data } as EventEnvelope);

  it('agent.login 是全局事件：按 loginId 记最新状态，旧事件不覆盖新状态', () => {
    let s = applyEvents(emptyCore(), [
      b(1, 'agent.login', { loginId: 'l1', kind: 'codex', profileId: null, state: 'started' }, null),
      b(3, 'agent.login', { loginId: 'l1', kind: 'codex', profileId: null, state: 'waiting_browser', authUrl: 'https://auth.openai.com/x' }, null),
    ]);
    s = applyEvent(s, b(2, 'agent.login', { loginId: 'l1', kind: 'codex', profileId: null, state: 'started' }, null));
    expect(s.logins.l1).toMatchObject({ state: 'waiting_browser', authUrl: 'https://auth.openai.com/x' });
    s = applyEvent(s, b(4, 'agent.login', { loginId: 'l1', kind: 'codex', profileId: null, state: 'succeeded' }, null));
    expect(s.logins.l1!.state).toBe('succeeded');
    expect(s.globalLog.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('session.notice 显示为提示行；恢复会话留一行说明', () => {
    const tl = buildTimeline([
      b(1, 'session.started', { agent: 'codex', model: 'gpt-5' }),
      b(2, 'session.started', { agent: 'codex', model: 'gpt-5', resumed: true }),
      b(3, 'session.notice', { level: 'warn', text: '原来的会话无法恢复，已新建会话；Agent 不记得之前的对话。' }),
    ]);
    const notes = tl.filter((x) => x.kind === 'note');
    expect(notes.map((n) => n.kind === 'note' && n.text)).toEqual(['已恢复原来的会话，Agent 记得之前的对话', '原来的会话无法恢复，已新建会话；Agent 不记得之前的对话。']);
    expect(notes[1]?.kind === 'note' && notes[1].level).toBe('warn');
  });

  it('会话配置：可选模型和思考强度以最新的 session.config 为准；用量随新会话清空', () => {
    const t = task({ agent: 'claude', model: null, effort: null, profileId: null });
    const models = [{ id: 'opus', name: 'Opus', contextWindow: null }, { id: 'sonnet', name: 'Sonnet', contextWindow: null }];
    const cfg = sessionConfig(t, [
      b(1, 'session.started', { agent: 'claude', model: 'default', profileId: 'pf2' }),
      b(2, 'session.config', { model: 'opus', effort: 'high', models, efforts: ['low', 'high', 'max'] }),
      b(3, 'session.usage', { used: 1000, size: 200000 }),
      b(4, 'session.config', { model: 'sonnet', effort: 'medium', efforts: ['low', 'medium'] }),
    ]);
    expect(cfg).toMatchObject({ model: 'sonnet', effort: 'medium', models, efforts: ['low', 'medium'], profileId: 'pf2', usage: { used: 1000 } });
    const again = sessionConfig(t, [b(1, 'session.usage', { used: 5, size: 10 }), b(2, 'session.started', { agent: 'claude', model: null })]);
    expect(again.usage).toBeUndefined();
    // 老版本的 session.config 没有 models / efforts：界面回落到 /agents 的缓存
    expect(sessionConfig(t, [b(1, 'session.config', { model: 'x', effort: null })]).models).toBeUndefined();
  });

  it('独立任务应用模型后立即覆盖上一轮模型，无需先发送下一条消息', () => {
    const t = task({ agent: 'independent', model: 'new-model', effort: null });
    expect(sessionConfig(t, [
      b(1, 'session.started', { agent: 'independent', model: 'old-model' }),
      b(2, 'session.config', { model: 'new-model', effort: null, permission: 'ask' }),
    ]).model).toBe('new-model');
  });

  it('中断错误：只认最后一条用户消息之后的 error，且任务处于暂停 / 中断 / 失败', () => {
    const err = { code: 'agent.auth_required', message: 'Codex 登录已过期', actions: [] };
    const log = [b(1, 'message.user', { messageId: 'u1', text: '修一下跳跃' }), b(2, 'error', { error: err })];
    expect(blockingError(task({ status: 'paused' }), log)?.data.error.code).toBe('agent.auth_required');
    expect(blockingError(task({ status: 'running' }), log)).toBeNull();
    expect(blockingError(task({ status: 'paused' }), [...log, b(3, 'message.user', { messageId: 'u2', text: '继续' })])).toBeNull();
    expect(lastUserText(log)).toBe('修一下跳跃');
  });
});
