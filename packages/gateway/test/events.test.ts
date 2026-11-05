import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@aic/protocol';
import { openDb, SCHEMA_VERSION, type Db } from '../src/db';
import { EventBus, EventStore } from '../src/events';
import { makeProject, startGw, WsClient, type TestGw } from './helpers';

describe('EventStore', () => {
  let dir: string; let db: Db;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'aic-ev-')); db = openDb(path.join(dir, 'data.db')); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('seq 全局递增，先写库再推送', () => {
    const bus = new EventBus();
    const store = new EventStore(db, bus);
    const seen: EventEnvelope[] = [];
    bus.on((e) => {
      // 推送时库里一定已经有这条
      expect(store.read({ after: e.seq - 1, limit: 1 })[0]?.seq).toBe(e.seq);
      seen.push(e);
    });
    const a = store.append({ type: 'message.user', taskId: 't1', sessionId: null, data: { messageId: 'm1', text: '你好' } });
    const b = store.append({ type: 'message.user', taskId: 't2', sessionId: null, data: { messageId: 'm2', text: '再见' } });
    const c = store.append({ type: 'message.done', taskId: 't1', sessionId: null, data: { messageId: 'm1' } });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(store.lastSeq()).toBe(3);
    expect(store.read({ after: 1, limit: 10 }).map((e) => e.seq)).toEqual([2, 3]);
    expect(store.read({ after: 0, limit: 10, taskId: 't1' }).map((e) => e.seq)).toEqual([1, 3]);
    expect(store.read({ after: 0, limit: 1 }).map((e) => e.seq)).toEqual([1]);
  });

  it('不符合协议的事件拒绝入库', () => {
    const store = new EventStore(db, new EventBus());
    expect(() => store.append({ type: 'message.user', taskId: 't1', sessionId: null, data: { messageId: '', text: 'x' } } as never)).toThrow();
    expect(store.lastSeq()).toBe(0);
  });

  it('数据库按版本号迁移，重开不重复执行', () => {
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(SCHEMA_VERSION);
    db.close();
    db = openDb(path.join(dir, 'data.db'));
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(SCHEMA_VERSION);
  });
});

describe('事件补发', () => {
  let t: TestGw; let token: string;
  beforeEach(async () => { t = await startGw(); token = await t.pair(); });
  afterEach(async () => { await t.stop(); });

  async function makeTask(text = '把跳跃手感调得更轻快一点') {
    const p = await makeProject(t, token);
    const r = await t.api('POST', '/tasks', { token, body: { projectId: p.id, prompt: text, agent: 'fake', permission: 'full' } });
    expect(r.status).toBe(201);
    await t.gw.services.tasks.idle();
    return r.json as { id: string };
  }

  it('GET /tasks/:id/events 按 after 分页', async () => {
    const task = await makeTask();
    const all = await t.api('GET', `/tasks/${task.id}/events?after=0&limit=2000`, { token });
    const items = all.json.items as EventEnvelope[];
    expect(items.length).toBeGreaterThan(10);
    for (let i = 1; i < items.length; i++) expect(items[i]!.seq).toBeGreaterThan(items[i - 1]!.seq);
    expect(all.json.nextCursor).toBeNull();

    const page = await t.api('GET', `/tasks/${task.id}/events?after=0&limit=5`, { token });
    expect(page.json.items).toHaveLength(5);
    expect(page.json.nextCursor).toBe(String(page.json.items[4].seq));
    const next = await t.api('GET', `/tasks/${task.id}/events?after=${page.json.nextCursor}&limit=5`, { token });
    expect(next.json.items[0].seq).toBe(items[5]!.seq);

    const bad = await t.api('GET', `/tasks/${task.id}/events?after=-1`, { token });
    expect(bad.status).toBe(400);
  });

  it('WebSocket 断线重连带 lastSeq 只补发缺失的事件，然后发 replayed', async () => {
    const c1 = await WsClient.connect(t.port, token);
    const ack = await c1.call({ op: 'subscribe', data: { lastSeq: 0 } });
    expect(ack.ok).toBe(true);
    const task = await makeTask('第一个任务');
    await c1.waitEvent((e) => e.type === 'task.updated' && e.taskId === task.id && (e.data as { task: { status: string } }).task.status === 'review');
    const seen = c1.events();
    const lastSeq = seen[seen.length - 1]!.seq;
    await c1.close();

    // 断线期间又产生了事件
    const task2 = await makeTask('第二个任务');
    const missed = t.gw.services.events.read({ after: lastSeq, limit: 10_000 });
    expect(missed.length).toBeGreaterThan(0);

    const c2 = await WsClient.connect(t.port, token);
    c2.send({ op: 'subscribe', data: { lastSeq } });
    const replayed = await c2.waitFor((f) => f.kind === 'replayed');
    const got = c2.events();
    expect(got.map((e) => e.seq)).toEqual(missed.map((e) => e.seq));
    expect(got.every((e) => e.seq > lastSeq)).toBe(true);
    expect(got.some((e) => e.taskId === task2.id)).toBe(true);
    expect((replayed as { upToSeq: number }).upToSeq).toBe(t.gw.services.events.lastSeq());

    // replayed 之后继续收实时事件，不重复
    const g = await t.api('POST', '/groups', { token, body: { name: '美术' } });
    await t.api('PATCH', `/tasks/${task.id}`, { token, body: { groupId: g.json.id } });
    const live = await c2.waitEvent((e) => e.type === 'task.updated' && e.taskId === task.id);
    expect(live.seq).toBeGreaterThan((replayed as { upToSeq: number }).upToSeq);
    const seqs = c2.events().map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    await c2.close();
  });

  it('subscribe 带 taskIds 时只推这些任务的详细事件，但仍推所有任务的 task.*', async () => {
    const a = await makeTask('任务甲');
    const b = await makeTask('任务乙');
    const c = await WsClient.connect(t.port, token);
    c.send({ op: 'subscribe', data: { lastSeq: 0, taskIds: [a.id] } });
    await c.waitFor((f) => f.kind === 'replayed');
    const evs = c.events();
    expect(evs.some((e) => e.taskId === a.id && e.type === 'message.delta')).toBe(true);
    expect(evs.some((e) => e.taskId === b.id && e.type === 'message.delta')).toBe(false);
    expect(evs.some((e) => e.taskId === b.id && e.type === 'task.created')).toBe(true);
    await c.close();
  });
});
