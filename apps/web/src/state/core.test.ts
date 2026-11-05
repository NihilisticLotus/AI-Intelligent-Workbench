// 事件归并测试：同一 seq 不重复应用、乱序到达按 seq 处理、快照不覆盖更新的实时状态、时间线推导。
import { describe, expect, it } from 'vitest';
import type { Approval, EventEnvelope, Task } from '@aic/protocol';
import {
  applyEvent, applyEvents, applyTaskSnapshot, buildTimeline, emptyCore, insertBySeq, latestPlan, mergeRestTask,
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
