// 复核问题的回归测试：单实例锁、WebSocket 补发（重置 / 背压 / bootId）、任务运行时细节。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CancelResult, PingResult, ServerFrame, type Approval, type EventEnvelope, type Task } from '@aic/protocol';
import { createFakeAdapter } from '../src/agents/fake';
import type { AgentAdapter } from '../src/agents/registry';
import { AlreadyRunningError } from '../src/server';
import { allowEditApproval, isCommandApproval, makeProject, startGw, WsClient, type TestGw } from './helpers';

const statusIs = (taskId: string, s: string) => (e: EventEnvelope) =>
  e.type === 'task.updated' && e.taskId === taskId && (e.data as { task: Task }).task.status === s;

describe('单实例锁', () => {
  it('同一数据目录的第二个实例拒绝启动，且不会把第一个实例的任务改成“已中断”', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aic-lock-'));
    const t = await startGw({}, dir);
    try {
      const token = await t.pair();
      const p = await makeProject(t, token);
      const ws = await WsClient.connect(t.port, token);
      await ws.call({ op: 'subscribe', data: { lastSeq: 0 } });
      const r = await t.api('POST', '/tasks', { token, body: { projectId: p.id, prompt: '跑一下测试', agent: 'fake', permission: 'ask' } });
      await allowEditApproval(ws, r.json.id);
      await ws.waitEvent(isCommandApproval(r.json.id));
      await ws.waitEvent((e) => statusIs(r.json.id, 'waiting')(e) && ws.events().some(isCommandApproval(r.json.id)));

      const err = await startGw({}, dir).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(AlreadyRunningError);
      expect((err as AlreadyRunningError).port).toBe(t.port);

      // 第一个实例的任务和审批都没被动过
      expect((await t.api('GET', `/tasks/${r.json.id}`, { token })).json.status).toBe('waiting');
      const pending = (await t.api('GET', '/approvals?status=pending', { token })).json.items as Approval[];
      expect(pending).toHaveLength(1);
      expect((await ws.call({ op: 'approve', data: { approvalId: pending[0]!.id, optionId: 'allow' } })).ok).toBe(true);
      await ws.waitEvent(statusIs(r.json.id, 'review'));
      await ws.close();
    } finally { await t.stop(); }
    // 第一个实例退出后锁被释放，可以重新启动
    const t2 = await startGw({}, dir);
    await t2.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('上次异常退出留下的锁（进程已不在）会被清掉', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aic-lock-'));
    writeFileSync(path.join(dir, 'gateway.lock'), JSON.stringify({ pid: 999_999_9, port: 1, startedAt: 0 }));
    const t = await startGw({}, dir);
    try {
      expect(JSON.parse(readFileSync(path.join(dir, 'gateway.lock'), 'utf8'))).toMatchObject({ pid: process.pid, port: t.port });
    } finally { await t.stop(); }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('WebSocket 补发', () => {
  let t: TestGw; let token: string;
  beforeEach(async () => { t = await startGw(); token = await t.pair(); });
  afterEach(async () => { await t.stop(); });

  it('replayed 带 bootId；客户端 lastSeq 比库里大时带 reset，之后的实时事件照样推送', async () => {
    const c = await WsClient.connect(t.port, token);
    const ack = await c.call({ op: 'subscribe', data: { lastSeq: 5000 } });
    expect(ack.ok).toBe(true);
    const replayed = await c.waitFor((f) => f.kind === 'replayed') as Extract<ServerFrame, { kind: 'replayed' }>;
    expect(replayed.bootId).toBe(t.gw.services.bootId);
    expect(replayed.reset).toBe(true);
    // 新库的 seq 从小开始：仍然推给这个连接
    await t.api('POST', '/groups', { token, body: { name: '关卡' } });
    const p = await makeProject(t, token);
    await t.api('POST', '/tasks', { token, body: { projectId: p.id, prompt: '调参数', agent: 'fake', permission: 'full' } });
    const ev = await c.waitEvent((e) => e.type === 'task.created');
    expect(ev.seq).toBeLessThan(5000);
    // 正常订阅没有 reset
    const c2 = await WsClient.connect(t.port, token);
    await c2.call({ op: 'subscribe', data: { lastSeq: 0 } });
    expect((await c2.waitFor((f) => f.kind === 'replayed') as { reset?: boolean }).reset).toBeUndefined();
    await c.close(); await c2.close();
  });

  it('积压很多时分批补发、处理背压，一次连接就能补齐', async () => {
    const ev = t.gw.services.events;
    const text = 'x'.repeat(4000);
    t.gw.services.db.tx(() => {
      for (let i = 0; i < 3000; i++) ev.append({ type: 'message.delta', taskId: 't_bulk', sessionId: null, data: { messageId: 'm1', text } });
    });
    const last = ev.lastSeq();
    const c = await WsClient.connect(t.port, token);
    c.send({ op: 'subscribe', data: { lastSeq: 0 } });
    // 补发期间还在产生新事件
    setTimeout(() => ev.append({ type: 'message.done', taskId: 't_bulk', sessionId: null, data: { messageId: 'm1' } }), 0);
    await c.waitFor((f) => f.kind === 'replayed', 20_000);
    await c.waitEvent((e) => e.type === 'message.done', 5000);
    const seqs = c.events().map((e) => e.seq);
    expect(seqs.filter((s) => s <= last)).toHaveLength(last);
    expect(new Set(seqs).size).toBe(seqs.length);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    expect(c.ws.readyState).toBe(c.ws.OPEN);
    await c.close();
  }, 30_000);

  it('cancel / ping 的 ack 结果符合协议里的 CancelResult / PingResult', async () => {
    const p = await makeProject(t, token);
    const r = await t.api('POST', '/tasks', { token, body: { projectId: p.id, prompt: '调参数', agent: 'fake', permission: 'full' } });
    await t.gw.services.tasks.idle();
    const c = await WsClient.connect(t.port, token);
    const cancel = await c.call({ op: 'cancel', data: { taskId: r.json.id } });
    expect(CancelResult.parse(cancel.result)).toEqual({ taskId: r.json.id });
    const ping = await c.call({ op: 'ping', data: {} });
    expect(PingResult.parse(ping.result)).toEqual({});
    await c.close();
  });
});

describe('任务运行时', () => {
  let t: TestGw; let token: string; let ws: WsClient; let projectId: string;
  beforeEach(async () => {
    t = await startGw();
    token = await t.pair('制作人的电脑');
    projectId = (await makeProject(t, token)).id;
    ws = await WsClient.connect(t.port, token);
    await ws.call({ op: 'subscribe', data: { lastSeq: 0 } });
  });
  afterEach(async () => { await ws.close(); await t.stop(); });

  it('会话还在启动时点停止也能中断这一轮', async () => {
    // 模拟真实 Agent：spawn 要等一会儿
    const base = createFakeAdapter({ speed: 0 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: AgentAdapter = { ...base, spawn: async (o) => { await gate; return base.spawn(o); } };
    t.gw.services.agents.register(slow);
    const r = await t.api('POST', '/tasks', { token, body: { projectId, prompt: '调参数', agent: 'fake', permission: 'full' } });
    await ws.waitEvent(statusIs(r.json.id, 'running'));
    expect((await ws.call({ op: 'cancel', data: { taskId: r.json.id } })).ok).toBe(true);
    release();
    await ws.waitEvent(statusIs(r.json.id, 'paused'));
    await t.gw.services.tasks.idle();
    const evs = ws.events().filter((e) => e.taskId === r.json.id);
    expect(evs.some((e) => e.type === 'message.delta')).toBe(false);
    // 停止后可以再发
    expect((await ws.call({ op: 'prompt', data: { taskId: r.json.id, text: '继续' } })).ok).toBe(true);
  });

  it('最近活动时间变化时也推 task.updated（节流），网页排序和 GET /tasks 一致', async () => {
    const r = await t.api('POST', '/tasks', { token, body: { projectId, prompt: '调参数', agent: 'fake', permission: 'full' } });
    await ws.waitEvent(statusIs(r.json.id, 'review'));
    await t.gw.services.tasks.idle();
    // 等节流的最后一次推送
    await new Promise((res) => setTimeout(res, 1100));
    const updates = ws.events().filter((e) => e.type === 'task.updated' && e.taskId === r.json.id);
    const latest = (updates.at(-1)!.data as { task: Task }).task;
    const fromRest = (await t.api('GET', `/tasks/${r.json.id}`, { token })).json as Task;
    expect(latest.lastActivityAt).toBe(fromRest.lastActivityAt);
  });

  it('审批结果带处理设备的名称；拒绝后工具结束事件标记 rejected；演示 Agent 不再提供“总是允许”', async () => {
    const r = await t.api('POST', '/tasks', { token, body: { projectId, prompt: '跑一下测试', agent: 'fake', permission: 'ask' } });
    await allowEditApproval(ws, r.json.id);
    const req = await ws.waitEvent(isCommandApproval(r.json.id));
    const approval = (req.data as { approval: Approval }).approval;
    expect(approval.options.map((o) => o.kind)).toEqual(['allow_once', 'reject_once']);
    await ws.call({ op: 'approve', data: { approvalId: approval.id, optionId: 'reject', note: '先别跑' } });
    await ws.waitEvent(statusIs(r.json.id, 'review'));
    const resolved = ws.events().find((e) => e.type === 'approval.resolved' && (e.data as { approvalId: string }).approvalId === approval.id)!;
    expect(resolved.data).toMatchObject({ status: 'rejected', decidedByName: '制作人的电脑' });
    const all = (await t.api('GET', '/approvals', { token })).json.items as Approval[];
    expect(all.find((a) => a.id === approval.id)!.decidedByName).toBe('制作人的电脑');
    const lastEnd = ws.events().filter((e) => e.type === 'tool.end' && e.taskId === r.json.id).at(-1)!;
    expect(lastEnd.data).toMatchObject({ ok: false, rejected: true });
  });
});
