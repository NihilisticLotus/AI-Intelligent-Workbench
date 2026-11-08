import { describe, expect, it, vi } from 'vitest';
import { IndependentService, type CreateIndependentServiceBody } from '@aic/protocol';
import { HttpClient } from './http';

const config: CreateIndependentServiceBody = { name: '示例服务', protocol: 'responses', baseUrl: 'https://example.com/v1', authentication: 'none', apiVersion: null, providerId: null, plan: null, enabled: true };
const service = { ...config, id: 's /?', revision: 1, configRevision: 1, hasSecret: false, secretHint: null, createdAt: 1, updatedAt: 1 };
const model = { id: 'm /?', serviceId: service.id, remoteModelId: 'remote', name: '模型', enabled: true, revision: 1, capabilities: [], evidence: [], createdAt: 1, updatedAt: 1 };
describe('独立目录 REST 客户端', () => {
  it('全部配置操作使用同一 /api/v1 与设备头，ID 编码，不连接上游地址', async () => {
    let response: unknown = service;
    const fetcher = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    const client = new HttpClient({ fetchImpl: fetcher, getAuthHeaders: () => ({ 'X-AIC-Key': 'fixture-device-key' }) });
    const calls: [string, string][] = [];
    const check = (method: string, path: string) => { const [url, init] = fetcher.mock.calls.at(-1)! as unknown as [string, RequestInit]; expect(url).toBe('/api/v1/independent/' + path); expect(init.method).toBe(method); expect(init.credentials).toBe('include'); expect(init.headers).toMatchObject({ 'X-AIC-Key': 'fixture-device-key' }); calls.push([method, path]); };
    const sp = 'services/s%20%2F%3F'; const mp = sp + '/models/m%20%2F%3F';
    response = { items: [service], nextCursor: null }; expect(await client.independentServices()).toHaveLength(1); check('GET', 'services');
    response = service; await client.independentService(service.id); check('GET', sp);
    await client.createIndependentService(config); check('POST', 'services');
    await client.patchIndependentService(service.id, { expectedRevision: 1, name: '新名' }); check('PATCH', sp);
    response = { items: [model], nextCursor: null }; await client.independentModels(service.id); check('GET', sp + '/models');
    response = model; await client.independentModel(service.id, model.id); check('GET', mp);
    await client.createIndependentModel(service.id, { name: model.name, remoteModelId: model.remoteModelId }); check('POST', sp + '/models');
    await client.patchIndependentModel(service.id, model.id, { expectedRevision: 1, enabled: false }); check('PATCH', mp);
    await client.patchIndependentOverrides(service.id, model.id, { expectedRevision: 1, expectedConfigRevision: 2, values: { imageInput: false } }); check('PATCH', mp + '/overrides');
    expect(JSON.parse((fetcher.mock.calls.at(-1)! as unknown as [string, RequestInit])[1].body as string)).toEqual({ expectedRevision: 1, expectedConfigRevision: 2, values: { imageInput: false } });
    response = { selection: null }; await client.independentDefault(); check('GET', 'default'); await client.putIndependentDefault({ selection: null }); check('PUT', 'default');
    response = { ok: true }; await client.deleteIndependentModel(service.id, model.id); check('DELETE', mp); await client.deleteIndependentService(service.id); check('DELETE', sp);
    expect(calls).toHaveLength(13);
  });
  it('拒绝返回密钥的 DTO 和字段不完整响应，409 写入只发一次', async () => {
    expect(IndependentService.safeParse({ ...service, apiKey: 'virtual-fixture-key' }).success).toBe(false);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 'conflict', message: '配置已改变', actions: [] }), { status: 409 }));
    const client = new HttpClient({ fetchImpl: fetcher });
    await expect(client.patchIndependentService(service.id, { expectedRevision: 1, name: '新名' })).rejects.toMatchObject({ status: 409 }); expect(fetcher).toHaveBeenCalledTimes(1);
    const broken = new HttpClient({ fetchImpl: async () => new Response('{}') }); await expect(broken.independentServices()).rejects.toThrow('版本不匹配');
  });
  it('发现预览与导入仅经 Gateway，显式传递范围、公共目录选择和勾选 ID', async () => {
    let response: unknown = {snapshot:null,stale:true,lastError:null};
    const fetcher = vi.fn(async () => new Response(JSON.stringify(response))); const client = new HttpClient({fetchImpl:fetcher});
    await client.independentDiscovery(service.id); expect((fetcher.mock.calls.at(-1)! as unknown as [string,RequestInit])[0]).toBe('/api/v1/independent/services/s%20%2F%3F/discovery');
    const body = {expectedConfigRevision:2,includeCatalog:true}; await client.discoverIndependentModels(service.id,body);
    expect(JSON.parse((fetcher.mock.calls.at(-1)! as unknown as [string,RequestInit])[1].body as string)).toEqual(body);
    response={items:[model],nextCursor:null}; const selected={snapshotId:'snapshot',expectedConfigRevision:2,remoteModelIds:['remote']};await client.importIndependentModels(service.id,selected);
    const [url,init]=fetcher.mock.calls.at(-1)! as unknown as [string,RequestInit];expect(url).toBe('/api/v1/independent/services/s%20%2F%3F/models/import');expect(JSON.parse(init.body as string)).toEqual(selected);
  });
  it('任务原始记录、审批与恢复只访问 Gateway，写入不重试', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 'conflict', message: '请核对最新版本', actions: [] }), { status: 409 }));
    const client = new HttpClient({ fetchImpl: fetcher, getAuthHeaders: () => ({ 'X-AIC-Key': 'fixture-device-key' }) });
    const id = 'task /?', prefix = '/api/v1/tasks/task%20%2F%3F/independent';
    const checks: [() => Promise<unknown>, string, string][] = [
      [() => client.independentTask(id), 'GET', prefix],
      [() => client.recoverIndependentTask(id, 7), 'POST', prefix + '/recover'],
      [() => client.independentHistory(id, 20), 'GET', prefix + '/history?after=20&limit=20'],
      [() => client.checkpointIndependentTask(id, { throughSeq: 2, expectedTailHash: 'a'.repeat(64), summary: '人工总结' }), 'POST', prefix + '/checkpoint'],
      [() => client.independentApproval(id, 'tool /?'), 'GET', prefix + '/approvals/tool%20%2F%3F'],
    ];
    for (const [call, method, url] of checks) {
      await expect(call()).rejects.toMatchObject({ status: 409 });
      expect(fetcher.mock.calls.at(-1)).toMatchObject([url, { method, credentials: 'include', headers: { 'X-AIC-Key': 'fixture-device-key' } }]);
    }
    expect(fetcher).toHaveBeenCalledTimes(checks.length);
    expect(JSON.parse((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({ expectedRevision: 7, acknowledged: true });
  });
});
