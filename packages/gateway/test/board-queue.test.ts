import { afterEach, describe, expect, it } from 'vitest';
import { makeProject, startGw, type TestGw } from './helpers';
let gateway: TestGw | undefined;
afterEach(async () => { await gateway?.stop(); gateway = undefined; });

describe('看板队列接口与真实派发顺序', { timeout: 60000 }, () => {
  it('超出演示名额后经鉴权调序，下一项按新顺序启动，运行者不能调序', async () => {
    gateway = await startGw(); const token = await gateway.pair(), service = gateway.gw.services.tasks;
    await gateway.api('PATCH', '/agents/fake', { token, body: { concurrencyLimit: 1 } });
    const create = async (title: string) => { const p = await makeProject(gateway!, token, title); return service.create({ projectId: p.id, agent: 'fake', permission: 'ask', prompt: title }); };
    const first = await create('第一个'); await expect.poll(() => service.get(first.id).status, { timeout: 10000 }).toBe('waiting');
    const second = await create('第二个'), third = await create('第三个');
    await expect.poll(() => service.get(third.id).queue?.position, { timeout: 10000 }).toBe(2);
    const endpoint = `/tasks/${third.id}/queue`, body = { position: 1 };
    expect((await gateway.api('POST', endpoint, { body })).status).toBe(401);
    expect((await gateway.api('POST', endpoint, { token, body, headers: { host: 'bad.invalid' } })).status).toBe(403);
    expect((await gateway.api('POST', endpoint, { token, body, headers: { origin: 'https://bad.invalid' } })).status).toBe(403);
    expect((await gateway.api('POST', endpoint, { token, body: { position: 0 } })).status).toBe(400);
    const moved = await gateway.api('POST', endpoint, { token, body }); expect(moved.status).toBe(200);
    expect(moved.json.queue).toEqual({ scope: 'agent', key: 'fake', position: 1, total: 2 });
    expect((await gateway.api('GET', `/tasks/${second.id}`, { token })).json.queue.position).toBe(2);
    expect((await gateway.api('POST', `/tasks/${first.id}/queue`, { token, body })).status).toBe(409);
    const event = gateway.gw.services.events.read({ taskId: third.id, after: 0, limit: 1000 }).filter(e => e.type === 'task.updated').at(-1);
    expect(event?.type === 'task.updated' && event.data.task.queue?.position).toBe(1);
    await service.cancel(first.id); await expect.poll(() => service.get(third.id).status, { timeout: 10000 }).toBe('waiting');
    expect(service.get(second.id).status).toBe('queued'); expect(service.get(third.id).activity?.action).toBeTruthy();
    await service.cancel(third.id); await expect.poll(() => service.get(second.id).status, { timeout: 10000 }).toBe('waiting');
    await service.cancel(second.id); await service.idle();
    expect(service.get(second.id).queue).toBeUndefined();
  });
  it('同一非 git 项目的等待队列可调序，取消前项不破坏串行', async () => {
    gateway = await startGw(); const token = await gateway.pair(), project = await makeProject(gateway, token), service = gateway.gw.services.tasks;
    const create = (prompt: string) => service.create({ projectId: project.id, agent: 'fake', permission: 'ask', prompt });
    const a = await create('甲'); await expect.poll(() => service.get(a.id).status, { timeout: 10000 }).toBe('waiting');
    const b = await create('乙'), c = await create('丙'); await expect.poll(() => service.get(c.id).queue?.position, { timeout: 10000 }).toBe(2);
    expect(service.get(c.id).queue?.scope).toBe('project'); service.moveQueuedTask(c.id, 1);
    await service.cancel(a.id); await expect.poll(() => service.get(c.id).status, { timeout: 10000 }).toBe('waiting');
    expect(service.get(b.id).status).toBe('queued'); await service.cancel(b.id); expect(service.get(c.id).status).toBe('waiting');
    await service.cancel(c.id); await service.idle();
  });
});
