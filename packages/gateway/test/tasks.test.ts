import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, type Task } from '@aic/protocol';
import { makeProject, startGw, type TestGw } from './helpers';

let t: TestGw; let token: string;
beforeEach(async () => { t = await startGw(); token = await t.pair(); });
afterEach(async () => { await t.stop(); });

async function task(projectId: string, prompt: string, groupId?: string) {
  const r = await t.api('POST', '/tasks', { token, body: { projectId, prompt, agent: 'fake', permission: 'full', ...(groupId ? { groupId } : {}) } });
  expect(r.status).toBe(201);
  await t.gw.services.tasks.idle();
  return r.json as Task;
}

describe('项目', () => {
  it('增删改查；路径重复 409；不存在的路径 400', async () => {
    const p = await makeProject(t, token, '跑酷游戏');
    expect((await t.api('GET', '/projects', { token })).json.items).toHaveLength(1);
    const dup = await t.api('POST', '/projects', { token, body: { name: 'x', path: p.path } });
    expect(dup.status).toBe(409);
    const missing = await t.api('POST', '/projects', { token, body: { name: 'x', path: path.join(t.dataDir, 'nope') } });
    expect(missing.status).toBe(400);
    const patched = await t.api('PATCH', `/projects/${p.id}`, { token, body: { name: '跑酷游戏 2' } });
    expect(patched.json.name).toBe('跑酷游戏 2');
    expect((await t.api('DELETE', `/projects/${p.id}`, { token })).status).toBe(200);
    expect((await t.api('GET', '/projects', { token })).json.items).toHaveLength(0);
  });

  it('识别 git 项目', async () => {
    const dir = mkdtempSync(path.join(t.dataDir, 'git-'));
    mkdirSync(path.join(dir, '.git'));
    const r = await t.api('POST', '/projects', { token, body: { name: 'g', path: dir } });
    expect(r.json.isGit).toBe(true);
  });
});

describe('任务与分组', () => {
  it('任务按最近活动倒序', async () => {
    const p = await makeProject(t, token);
    const a = await task(p.id, '任务甲');
    const b = await task(p.id, '任务乙');
    const c = await task(p.id, '任务丙');
    let list = (await t.api('GET', '/tasks', { token })).json.items as Task[];
    expect(list.map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    // 给甲发一条消息，甲排到最前
    t.gw.services.tasks.prompt(a.id, '继续');
    await t.gw.services.tasks.idle();
    list = (await t.api('GET', `/tasks?projectId=${p.id}`, { token })).json.items;
    expect(list.map((x) => x.id)).toEqual([a.id, c.id, b.id]);
    for (let i = 1; i < list.length; i++) expect(list[i - 1]!.lastActivityAt).toBeGreaterThan(list[i]!.lastActivityAt);

    // 游标分页
    const p1 = await t.api('GET', '/tasks?limit=2', { token });
    expect(p1.json.items.map((x: Task) => x.id)).toEqual([a.id, c.id]);
    const p2 = await t.api('GET', `/tasks?limit=2&cursor=${p1.json.nextCursor}`, { token });
    expect(p2.json.items.map((x: Task) => x.id)).toEqual([b.id]);
    expect(p2.json.nextCursor).toBeNull();
  });

  it('删除分组后任务的 groupId 置空，任务保留', async () => {
    const p = await makeProject(t, token);
    const g = (await t.api('POST', '/groups', { token, body: { name: '关卡设计' } })).json;
    const g2 = (await t.api('POST', '/groups', { token, body: { name: '美术' } })).json;
    expect(g2.ord).toBeGreaterThan(g.ord);
    const a = await task(p.id, '任务甲', g.id);
    const b = await task(p.id, '任务乙');
    expect((await t.api('PATCH', `/tasks/${b.id}`, { token, body: { groupId: g.id } })).json.groupId).toBe(g.id);
    expect((await t.api('GET', `/tasks?groupId=${g.id}`, { token })).json.items).toHaveLength(2);

    const before = t.gw.services.events.lastSeq();
    expect((await t.api('DELETE', `/groups/${g.id}`, { token })).status).toBe(200);
    const after = (await t.api('GET', '/tasks', { token })).json.items as Task[];
    expect(after).toHaveLength(2);
    expect(after.every((x) => x.groupId === null)).toBe(true);
    expect((await t.api('GET', '/tasks?ungrouped=1', { token })).json.items).toHaveLength(2);
    // 每个受影响的任务都推送了 task.updated
    const evs = t.gw.services.events.read({ after: before, limit: 100 }).filter((e) => e.type === 'task.updated');
    expect(evs.map((e) => e.taskId).sort()).toEqual([a.id, b.id].sort());
    expect((await t.api('GET', '/groups', { token })).json.items.map((x: { id: string }) => x.id)).toEqual([g2.id]);
    expect((await t.api('DELETE', `/groups/${g.id}`, { token })).status).toBe(404);
  });

  it('PATCH 任务：改标题、权限；不存在的分组 400；不存在的任务 404', async () => {
    const p = await makeProject(t, token);
    const a = await task(p.id, '任务甲');
    const r = await t.api('PATCH', `/tasks/${a.id}`, { token, body: { title: '新标题', permission: 'readonly' } });
    expect(r.json).toMatchObject({ title: '新标题', permission: 'readonly' });
    expect((await t.api('PATCH', `/tasks/${a.id}`, { token, body: { groupId: 'g_nope' } })).status).toBe(400);
    const nf = await t.api('GET', '/tasks/t_nope', { token });
    expect(nf.status).toBe(404);
    expect(nf.json.code).toBe(ErrorCode.NotFound);
  });

  it('项目下有任务时不能移除', async () => {
    const p = await makeProject(t, token);
    await task(p.id, '任务甲');
    expect((await t.api('DELETE', `/projects/${p.id}`, { token })).status).toBe(409);
  });

  it('Gateway 重启后，未完成的任务标记为已中断，待审批作废', async () => {
    const dir = t.dataDir;
    const p = await makeProject(t, token);
    const r = await t.api('POST', '/tasks', { token, body: { projectId: p.id, prompt: '调参', agent: 'fake', permission: 'ask' } });
    for (let i = 0; i < 100 && t.gw.services.tasks.listApprovals('pending').length === 0; i++) await new Promise((x) => setTimeout(x, 10));
    expect(t.gw.services.tasks.listApprovals('pending')).toHaveLength(1);
    // 模拟崩溃：不走正常关闭流程里的状态更新（直接关库前先读出状态）
    await t.gw.close();
    // 正常关闭会把任务暂停；这里把状态改回 waiting 模拟崩溃时的残留
    const { openDb } = await import('../src/db');
    const db = openDb(path.join(dir, 'data.db'));
    db.run("UPDATE tasks SET status = 'waiting' WHERE id = ?", r.json.id);
    db.run("UPDATE approvals SET status = 'pending'");
    db.close();
    const t2 = await startGw({}, dir);
    try {
      const tk = await t2.pair();
      expect((await t2.api('GET', `/tasks/${r.json.id}`, { token: tk })).json.status).toBe('interrupted');
      expect((await t2.api('GET', '/approvals?status=pending', { token: tk })).json.items).toHaveLength(0);
    } finally { await t2.stop(); }
  });
});
