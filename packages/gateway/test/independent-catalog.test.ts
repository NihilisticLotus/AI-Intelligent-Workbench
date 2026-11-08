import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FeatureKey, type CreateIndependentServiceBody, type IndependentCapabilityEvidence, type IndependentModel } from '@aic/protocol';
import { IndependentCatalog } from '../src/independent/catalog';
import { capabilityScope } from '../src/independent/capabilities';
import { openDb, type Db } from '../src/db';
import { EventStore, EventBus } from '../src/events';
import { MemorySecretStore, SecretService } from '../src/secrets';
import { startGw, type TestGw } from './helpers';
import { seed } from './fixtures/independent-journal';

const dirs: string[] = []; const dbs: Db[] = []; let gateway: TestGw | undefined;
const config = (extra: Partial<CreateIndependentServiceBody> = {}): CreateIndependentServiceBody => ({ name: '服务一', protocol: 'chat_completions', baseUrl: 'https://example.com/v1', authentication: 'none', apiVersion: null, providerId: null, plan: null, enabled: true, ...extra });
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'aic-catalog-')); dirs.push(dir); const file = path.join(dir, 'catalog.db');
  const db = openDb(file); dbs.push(db); const store = new MemorySecretStore(); const secrets = new SecretService(db, store);
  const events = new EventStore(db, new EventBus()); const catalog = new IndependentCatalog(db, secrets, events);
  return { file, db, store, secrets, events, catalog };
}
const value = (model: IndependentModel, field: IndependentCapabilityEvidence['field']) => model.capabilities.find((c) => c.field === field)!;
function evidence(catalog: IndependentCatalog, serviceId: string, model: IndependentModel, extra: Partial<IndependentCapabilityEvidence> = {}): IndependentCapabilityEvidence {
  return { id: 'incoming', field: 'imageInput', value: true, kind: 'endpoint', scope: capabilityScope(catalog.getService(serviceId), model.remoteModelId),
    sourceUrl: 'https://example.com/v1/models', sourceVersion: 'fixture-v1', fieldPath: 'data.image', observedAt: Date.now(), expiresAt: null, ...extra };
}
afterEach(async () => {
  vi.restoreAllMocks(); await gateway?.stop(); gateway = undefined;
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('独立服务与模型目录', () => {
  it('同配置重新绑定保留完整身份，修订变化仍建立新绑定并拒绝旧快照', async () => {
    const { catalog, db } = setup(); seed(db);
    const service = await catalog.createService(config()); const model = catalog.createModel(service.id, { remoteModelId: 'fixture', name: '模型' });
    const selection = { serviceId: service.id, modelId: model.id }, before = catalog.bind('task', selection);
    vi.spyOn(Date, 'now').mockReturnValue(before.createdAt + 100);
    expect(catalog.rebind('task', selection, before)).toEqual(before);
    const revised = catalog.patchModel(service.id, model.id, { expectedRevision: model.revision, name: '新显示名' });
    const after = catalog.rebind('task', selection, before);
    expect(after).toMatchObject({ ...selection, modelRevision: revised.revision, createdAt: before.createdAt + 100 });
    expect(() => catalog.rebind('task', selection, before)).toThrow('绑定已变化');
  });
  it('v7 增量升级只加发现缓存，不丢服务、模型或人工来源', async () => {
    const {catalog,db,file}=setup();const s=await catalog.createService(config());const m=catalog.createModel(s.id,{remoteModelId:'m',name:'保留模型'});
    catalog.overrides(s.id,m.id,{expectedRevision:m.revision,values:{imageInput:false}});
    dbs.splice(dbs.indexOf(db),1);db.close();const old=new DatabaseSync(file);old.exec('DROP TABLE independent_task_settings; DROP TABLE independent_request_attempts; DROP TABLE independent_request_budgets; DROP TABLE independent_file_receipts; ALTER TABLE independent_tool_calls DROP COLUMN file_outcome_json; DROP TABLE independent_checkpoints; DROP TABLE independent_messages; DROP TABLE independent_turns; DROP TABLE independent_discoveries; PRAGMA user_version=7;');old.close();
    const reopened=openDb(file);dbs.push(reopened);const migrated=new IndependentCatalog(reopened,new SecretService(reopened,new MemorySecretStore()),new EventStore(reopened,new EventBus()));
    expect(migrated.getService(s.id).name).toBe(s.name);expect(value(migrated.getModel(s.id,m.id),'imageInput').value).toBe(false);expect(reopened.all('SELECT * FROM independent_discoveries')).toEqual([]);
  });
  it('能力表单打开后服务路由变化，旧配置修订不能把人工值写入新范围', async () => {
    const { catalog, db } = setup(); const s = await catalog.createService(config()); const m = catalog.createModel(s.id, { remoteModelId: 'm', name: '模型' });
    await catalog.patchService(s.id, { expectedRevision: s.revision, baseUrl: 'https://other.example.com/v1' });
    const eventCount = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events')!.n;
    expect(() => catalog.overrides(s.id, m.id, { expectedRevision: m.revision, expectedConfigRevision: s.configRevision, values: { imageInput: true } })).toThrow('配置已在其他操作中改变');
    expect(catalog.getModel(s.id, m.id).evidence).toEqual([]);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events')!.n).toBe(eventCount);
    const fresh = catalog.getService(s.id);
    const saved = catalog.overrides(s.id, m.id, { expectedRevision: m.revision, expectedConfigRevision: fresh.configRevision, values: { imageInput: false } });
    expect(value(saved, 'imageInput').value).toBe(false); expect(saved.evidence[0]?.scope.configRevision).toBe(fresh.configRevision);
  });
  it('两服务各两个模型，同名模型隔离，追加不替换或自动设默认', async () => {
    const { catalog } = setup(); const a = await catalog.createService(config()); const b = await catalog.createService(config({ name: '服务二', protocol: 'responses' }));
    const m = catalog.createModel(a.id, { remoteModelId: 'shared', name: '原模型' });
    catalog.createModel(a.id, { remoteModelId: 'second', name: '二号模型' });
    const other = catalog.createModel(b.id, { remoteModelId: 'shared', name: '另一部署' }); catalog.createModel(b.id, { remoteModelId: 'second', name: '二号模型' });
    expect(m.id).not.toBe(other.id); expect(catalog.listServices()).toHaveLength(2);
    expect(catalog.listModels(a.id)).toHaveLength(2); expect(catalog.listModels(b.id)).toHaveLength(2); expect(catalog.getDefault()).toEqual({ selection: null });
    catalog.recordEvidence(a.id, m.id, [evidence(catalog, a.id, m)]);
    expect(value(catalog.getModel(a.id, m.id), 'imageInput').value).toBe(true); expect(value(catalog.getModel(b.id, other.id), 'imageInput').value).toBeNull();
    expect(() => catalog.getModel(b.id, m.id)).toThrow('没有该模型');
  });

  it('重复添加保留名称、人工 false、停用状态和默认选择', async () => {
    const { catalog } = setup(); const service = await catalog.createService(config());
    let model = catalog.createModel(service.id, { remoteModelId: 'm', name: '原名称' });
    catalog.setDefault({ selection: { serviceId: service.id, modelId: model.id } });
    model = catalog.overrides(service.id, model.id, { expectedRevision: model.revision, values: { imageInput: false } });
    model = catalog.patchModel(service.id, model.id, { expectedRevision: model.revision, enabled: false });
    expect(catalog.createModel(service.id, { remoteModelId: 'm', name: '新名字' })).toEqual(model);
    expect(catalog.getDefault().selection?.modelId).toBe(model.id);
    expect(() => catalog.setDefault({ selection: { serviceId: service.id, modelId: model.id } })).toThrow('已停用');
  });

  it('默认选择必须归属同服务，删除清空但不选另一个', async () => {
    const { catalog } = setup(); const a = await catalog.createService(config()); const b = await catalog.createService(config());
    const m = catalog.createModel(a.id, { remoteModelId: 'm', name: '模型' }); const n = catalog.createModel(a.id, { remoteModelId: 'n', name: '模型二' });
    expect(() => catalog.setDefault({ selection: { serviceId: b.id, modelId: m.id } })).toThrow('没有该模型');
    catalog.setDefault({ selection: { serviceId: a.id, modelId: m.id } }); catalog.deleteModel(a.id, m.id);
    expect(catalog.getDefault().selection).toBeNull(); expect(catalog.getModel(a.id, n.id).id).toBe(n.id);
    catalog.setDefault({ selection: { serviceId: a.id, modelId: n.id } }); catalog.setDefault({ selection: null }); expect(catalog.getDefault().selection).toBeNull();
  });

  it('模型初始能力全部未知，名称不产生能力或假窗口', async () => {
    const { catalog } = setup(); const s = await catalog.createService(config()); const m = catalog.createModel(s.id, { remoteModelId: 'vision-high-128k', name: '看图模型' });
    expect(m.capabilities).toHaveLength(16); expect(m.capabilities.every((c) => c.value === null && c.sourceKind === null && !c.conflict && !c.stale)).toBe(true);
  });

  it('人工覆盖置顶且保留自动冲突，清除后恢复自动，空字段不抹旧来源', async () => {
    const { catalog } = setup(); const s = await catalog.createService(config()); let m = catalog.createModel(s.id, { remoteModelId: 'm', name: '模型' });
    m = catalog.overrides(s.id, m.id, { expectedRevision: m.revision, values: { imageInput: false, contextWindow: 8192 } });
    m = catalog.recordEvidence(s.id, m.id, [evidence(catalog, s.id, m)]);
    expect(value(m, 'imageInput')).toMatchObject({ value: false, sourceKind: 'manual', conflict: true });
    m = catalog.recordEvidence(s.id, m.id, [evidence(catalog, s.id, m, { value: null })]); expect(m.evidence).toHaveLength(3);
    m = catalog.overrides(s.id, m.id, { expectedRevision: m.revision, values: { imageInput: null } });
    expect(value(m, 'imageInput')).toMatchObject({ value: true, sourceKind: 'endpoint', conflict: false }); expect(value(m, 'contextWindow').value).toBe(8192);
  });

  it('同级不同来源冲突保持未知，同来源刷新替换当前值', async () => {
    const { catalog } = setup(); const s = await catalog.createService(config()); let m = catalog.createModel(s.id, { remoteModelId: 'm', name: '模型' });
    m = catalog.recordEvidence(s.id, m.id, [evidence(catalog, s.id, m), evidence(catalog, s.id, m, { sourceUrl: 'https://example.com/second', value: false })]);
    expect(value(m, 'imageInput')).toMatchObject({ value: null, conflict: true });
    m = catalog.recordEvidence(s.id, m.id, [evidence(catalog, s.id, m, { sourceVersion: 'fixture-v2', value: false })]);
    expect(m.evidence).toHaveLength(2); expect(value(m, 'imageInput')).toMatchObject({ value: false, conflict: false });
  });

  it('低级新鲜目录不覆盖高级过期限制，同级刷新后解除 stale', async () => {
    const { catalog } = setup(); const s = await catalog.createService(config()); let m = catalog.createModel(s.id, { remoteModelId: 'm', name: '模型' });
    m = catalog.recordEvidence(s.id, m.id, [evidence(catalog, s.id, m, { kind: 'catalog', value: true }), evidence(catalog, s.id, m, { value: false, observedAt: 1, expiresAt: 2 })]);
    expect(value(m, 'imageInput')).toMatchObject({ value: false, sourceKind: 'endpoint', stale: true });
    m = catalog.recordEvidence(s.id, m.id, [evidence(catalog, s.id, m, { kind: 'official', value: false }), evidence(catalog, s.id, m)]);
    expect(value(m, 'imageInput')).toMatchObject({ value: true, sourceKind: 'endpoint', stale: false });
  });

  it('有限观察不提升通用能力，列表排列不产生假冲突，推理选项保持原样', async () => {
    const { catalog } = setup(); const s = await catalog.createService(config()); let m = catalog.createModel(s.id, { remoteModelId: 'm', name: '模型' });
    m = catalog.recordEvidence(s.id, m.id, [evidence(catalog, s.id, m, { kind: 'observation' }), evidence(catalog, s.id, m, { field: 'effortLevels', value: ['low', 'max'] }), evidence(catalog, s.id, m, { field: 'effortLevels', value: ['max', 'low'], sourceUrl: 'https://example.com/second' })]);
    expect(value(m, 'imageInput').value).toBeNull(); expect(value(m, 'effortLevels')).toMatchObject({ value: ['low', 'max'], conflict: false }); expect(value(m, 'defaultEffort').value).toBeNull();
  });

  it('重命名不失效，路由 / 认证范围修订保留旧证据但不生效', async () => {
    const { catalog } = setup(); let s = await catalog.createService(config()); let m = catalog.createModel(s.id, { remoteModelId: 'm', name: '模型' });
    m = catalog.recordEvidence(s.id, m.id, [evidence(catalog, s.id, m)]);
    s = await catalog.patchService(s.id, { expectedRevision: s.revision, name: '新名称' }); expect(s.configRevision).toBe(1); expect(value(catalog.getModel(s.id, m.id), 'imageInput').value).toBe(true);
    s = await catalog.patchService(s.id, { expectedRevision: s.revision, baseUrl: 'https://example.com/v2', plan: 'new-plan' }); expect(s.configRevision).toBe(2);
    const after = catalog.getModel(s.id, m.id); expect(after.evidence).toHaveLength(1); expect(value(after, 'imageInput')).toMatchObject({ value: null, stale: true });
    expect(() => catalog.recordEvidence(s.id, m.id, m.evidence)).toThrow('适用范围不一致');
  });

  it('拒绝伪装人工、跨范围、未知字段与过多来源，不部分写入', async () => {
    const { catalog } = setup(); const s = await catalog.createService(config()); const m = catalog.createModel(s.id, { remoteModelId: 'm', name: '模型' });
    for (const e of [evidence(catalog, s.id, m, { kind: 'manual' }), evidence(catalog, s.id, m, { scope: { ...capabilityScope(s, 'm'), plan: 'other' } }), evidence(catalog, s.id, m, { sourceUrl: null })]) expect(() => catalog.recordEvidence(s.id, m.id, [e])).toThrow('来源或适用范围');
    expect(() => catalog.recordEvidence(s.id, m.id, [{ ...evidence(catalog, s.id, m), apiKey: 'fixture-private-value' } as never])).toThrow();
    expect(() => catalog.recordEvidence(s.id, m.id, Array.from({ length: 17 }, (_, i) => evidence(catalog, s.id, m, { sourceUrl: `https://example.com/${i}` })))).toThrow('超过 16');
    expect(catalog.getModel(s.id, m.id)).toEqual(m);
  });

  it('旧模型修订不能覆盖人工值或状态', async () => {
    const { catalog } = setup(); const s = await catalog.createService(config()); const m = catalog.createModel(s.id, { remoteModelId: 'm', name: '模型' });
    catalog.patchModel(s.id, m.id, { expectedRevision: m.revision, name: '已改名' });
    expect(() => catalog.overrides(s.id, m.id, { expectedRevision: m.revision, values: { tools: true } })).toThrow('其他操作中改变');
    expect(() => catalog.patchModel(s.id, m.id, { expectedRevision: m.revision, enabled: false })).toThrow('其他操作中改变');
  });

  it('密钥只保存到加密服务，轮换清掉旧密文；读取目录不解密', async () => {
    const { catalog, secrets, db } = setup(); const read = vi.spyOn(secrets, 'read');
    let s = await catalog.createService(config({ authentication: 'api_key', apiKey: 'fixture-key-original' }));
    expect(s).toMatchObject({ hasSecret: true, secretHint: 'inal' }); expect(JSON.stringify(catalog.listServices())).not.toContain('fixture-key'); expect(read).not.toHaveBeenCalled();
    const previous = db.get<{ secret_id: string }>('SELECT secret_id FROM independent_services WHERE id=?', s.id)!.secret_id;
    s = await catalog.patchService(s.id, { expectedRevision: s.revision, apiKey: 'fixture-key-replacement' });
    expect(s.configRevision).toBe(2); expect(db.get('SELECT id FROM secrets WHERE id=?', previous)).toBeUndefined();
    expect(JSON.stringify(db.all('SELECT * FROM secrets'))).not.toContain('fixture-key');
    expect(JSON.stringify(db.all('SELECT * FROM events'))).not.toContain('fixture-key');
    s = await catalog.patchService(s.id, { expectedRevision: s.revision, authentication: 'none' }); expect(s.hasSecret).toBe(false); expect(db.all('SELECT * FROM secrets')).toEqual([]);
    await expect(catalog.createService(config({ apiKey: 'fixture-invalid-key' }))).rejects.toThrow('无认证服务');
  });

  it('异步加密期间配置被改动，丢弃本次密文而不覆盖赢家', async () => {
    const { catalog, store, db } = setup(); const s = await catalog.createService(config({ authentication: 'api_key', apiKey: 'fixture-original-key' }));
    const encrypt = store.encrypt.bind(store); let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; }); const spy = vi.spyOn(store, 'encrypt').mockImplementationOnce(async (key) => { await hold; return encrypt(key); });
    const first = catalog.patchService(s.id, { expectedRevision: s.revision, apiKey: 'fixture-losing-key' }); await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    await catalog.patchService(s.id, { expectedRevision: s.revision, name: '并发赢家' }); release();
    await expect(first).rejects.toThrow('其他操作中改变'); expect(catalog.getService(s.id).name).toBe('并发赢家'); expect(db.all('SELECT * FROM secrets')).toHaveLength(1);
  });

  it('事务或事件持久化失败回滚业务、旧密钥及通知，新密文不遗留', async () => {
    const { catalog, events, db } = setup(); const s = await catalog.createService(config({ authentication: 'api_key', apiKey: 'fixture-original-key' }));
    const before = db.all('SELECT * FROM secrets'); const bus = vi.fn(); const off = events.bus.on(bus);
    vi.spyOn(events, 'persist').mockImplementationOnce(() => { throw new Error('模拟持久化失败'); });
    await expect(catalog.patchService(s.id, { expectedRevision: s.revision, apiKey: 'fixture-uncommitted-key' })).rejects.toThrow('修改失败');
    expect(catalog.getService(s.id)).toEqual(s); expect(db.all('SELECT * FROM secrets')).toEqual(before); expect(bus).not.toHaveBeenCalled(); off();
  });

  it('事件通知发生在真正提交之后，另一个数据库连接看得到新项', async () => {
    const { catalog, events, file } = setup(); const reader = new DatabaseSync(file); const observed: boolean[] = [];
    const off = events.bus.on((event) => { if (event.type === 'independent.catalog_changed' && event.data.serviceId) observed.push(!!reader.prepare('SELECT id FROM independent_services WHERE id=?').get(event.data.serviceId)); });
    try { await catalog.createService(config()); expect(observed).toEqual([true]); } finally { off(); reader.close(); }
  });

  it('外层事务回滚不发布目录事件，捕获内层失败也不提交半次模型变更', async () => {
    const { catalog, events, db } = setup(); const service = await catalog.createService(config()); const received = vi.fn(); const off = events.bus.on(received);
    try {
      expect(() => db.tx(() => { catalog.createModel(service.id, { remoteModelId: 'rolled-back', name: '回滚模型' }); expect(received).not.toHaveBeenCalled(); throw new Error('外层失败'); })).toThrow('外层失败');
      expect(catalog.listModels(service.id)).toEqual([]); expect(received).not.toHaveBeenCalled();
      db.tx(() => {
        vi.spyOn(events, 'persist').mockImplementationOnce(() => { throw new Error('内层记录失败'); });
        expect(() => catalog.createModel(service.id, { remoteModelId: 'inner-failed', name: '失败模型' })).toThrow('内层记录失败');
        catalog.createModel(service.id, { remoteModelId: 'committed', name: '提交模型' }); expect(received).not.toHaveBeenCalled();
      });
      expect(catalog.listModels(service.id).map((m) => m.remoteModelId)).toEqual(['committed']); expect(received).toHaveBeenCalledTimes(1);
    } finally { off(); }
  });

  it('既有 append 同样等待最外层提交，回滚时不通知旧事件', () => {
    const { events, db } = setup(); const received = vi.fn(); const off = events.bus.on(received);
    const input = { type: 'session.notice' as const, taskId: null, sessionId: null, data: { level: 'info' as const, text: '测试通知' } };
    try {
      expect(() => db.tx(() => { events.append(input); expect(received).not.toHaveBeenCalled(); throw new Error('回滚'); })).toThrow('回滚');
      expect(events.lastSeq()).toBe(0); expect(received).not.toHaveBeenCalled();
      db.tx(() => { events.append(input); expect(received).not.toHaveBeenCalled(); }); expect(received).toHaveBeenCalledTimes(1);
    } finally { off(); }
  });

  it('任务绑定后禁止删除与默认改绑，停用或修订使旧绑定停止', async () => {
    const { catalog, db } = setup(); seed(db); let s = await catalog.createService(config()); const a = catalog.createModel(s.id, { remoteModelId: 'a', name: '模型一' }); const b = catalog.createModel(s.id, { remoteModelId: 'b', name: '模型二' });
    const binding = catalog.bind('task', { serviceId: s.id, modelId: a.id }); expect(catalog.bind('task', binding)).toEqual(binding);
    catalog.setDefault({ selection: { serviceId: s.id, modelId: b.id } }); expect(catalog.bound('task').modelId).toBe(a.id);
    expect(() => catalog.bind('task', { serviceId: s.id, modelId: b.id })).toThrow('需要明确切换');
    expect(() => catalog.deleteModel(s.id, a.id)).toThrow('仍关联任务'); expect(() => catalog.deleteService(s.id)).toThrow('仍关联任务');
    s = await catalog.patchService(s.id, { expectedRevision: s.revision, enabled: false }); expect(() => catalog.bound('task')).toThrow('已停用');
    s = await catalog.patchService(s.id, { expectedRevision: s.revision, enabled: true, apiVersion: '2026-10-21' }); expect(() => catalog.bound('task')).toThrow('已修订');
  });

  it('只有所选服务可供给密钥，缺 Key 不从环境或其他服务兜底', async () => {
    const { catalog, db } = setup(); seed(db); const a = await catalog.createService(config({ authentication: 'api_key', apiKey: 'fixture-a-service-key' }));
    const b = await catalog.createService(config({ authentication: 'api_key' })); const model = catalog.createModel(b.id, { remoteModelId: 'm', name: '模型' });
    catalog.bind('task', { serviceId: b.id, modelId: model.id }); await expect(catalog.credentials('task')).rejects.toThrow('尚未保存可用密钥');
    expect(catalog.listServices()).toHaveLength(2); expect(catalog.getService(a.id).hasSecret).toBe(true);
    db.run('DELETE FROM independent_task_models WHERE task_id=?', 'task'); const ma = catalog.createModel(a.id, { remoteModelId: 'm', name: '模型' }); catalog.bind('task', { serviceId: a.id, modelId: ma.id });
    expect((await catalog.credentials('task')).key).toBe('fixture-a-service-key');
  });

  it('解密期间配置变化不继续返回可用路由', async () => {
    const { catalog, db, secrets } = setup(); seed(db); const s = await catalog.createService(config({ authentication: 'api_key', apiKey: 'fixture-a-service-key' }));
    const m = catalog.createModel(s.id, { remoteModelId: 'm', name: '模型' }); catalog.bind('task', { serviceId: s.id, modelId: m.id });
    const read = secrets.read.bind(secrets); vi.spyOn(secrets, 'read').mockImplementationOnce(async (id) => { await catalog.patchService(s.id, { expectedRevision: s.revision, baseUrl: 'https://example.com/changed' }); return read(id); });
    await expect(catalog.credentials('task')).rejects.toThrow('已修订');
  });

  it('删除只触及自己的模型和密钥，旧第三方 profile 与默认其他服务保留', async () => {
    const { catalog, db, secrets } = setup(); const legacy = await secrets.save('fixture-legacy-key');
    db.run("INSERT INTO agent_profiles(id,agent,name,kind,config_dir,secret_id,created_at,updated_at) VALUES ('legacy','claude','旧配置','customEndpoint','isolated',?,1,1)", legacy.id);
    const old = db.all('SELECT * FROM agent_profiles'); const a = await catalog.createService(config({ authentication: 'api_key', apiKey: 'fixture-own-key' }));
    const b = await catalog.createService(config()); const m = catalog.createModel(b.id, { remoteModelId: 'm', name: '模型' }); catalog.setDefault({ selection: { serviceId: b.id, modelId: m.id } });
    catalog.deleteService(a.id); expect(db.all('SELECT * FROM agent_profiles')).toEqual(old); expect(secrets.hint(legacy.id)).toBe('-key'); expect(catalog.getDefault().selection?.serviceId).toBe(b.id);
    catalog.deleteService(b.id); expect(catalog.getDefault().selection).toBeNull(); expect(db.all('SELECT * FROM independent_models')).toEqual([]);
  });

  it('v6 升级保留旧工具记录和草稿，目录重开保留模型与人工值', async () => {
    const { db, file } = setup(); seed(db); db.run("INSERT INTO task_drafts(task_id,text,annotations_json,updated_at) VALUES ('task','原草稿','[]',1)");
    dbs.splice(dbs.indexOf(db), 1); db.close(); const old = new DatabaseSync(file); old.exec('DROP TABLE independent_task_settings; DROP TABLE independent_request_attempts; DROP TABLE independent_request_budgets; DROP TABLE independent_file_receipts; ALTER TABLE independent_tool_calls DROP COLUMN file_outcome_json; DROP TABLE independent_checkpoints; DROP TABLE independent_messages; DROP TABLE independent_turns; DROP TABLE independent_discoveries; DROP TABLE independent_task_models; DROP TABLE independent_models; DROP TABLE independent_services; PRAGMA user_version=6;'); old.close();
    const current = openDb(file); dbs.push(current); const secrets = new SecretService(current, new MemorySecretStore()); const reopened = new IndependentCatalog(current, secrets, new EventStore(current, new EventBus()));
    const s = await reopened.createService(config()); let m = reopened.createModel(s.id, { remoteModelId: 'm', name: '模型' }); m = reopened.overrides(s.id, m.id, { expectedRevision: m.revision, values: { tools: false } });
    expect(current.get('SELECT text FROM task_drafts')).toEqual({ text: '原草稿' }); expect(current.all('PRAGMA table_info(independent_tool_calls)')).not.toHaveLength(0);
    dbs.splice(dbs.indexOf(current), 1); current.close(); const last = openDb(file); dbs.push(last);
    const restored = new IndependentCatalog(last, new SecretService(last, new MemorySecretStore()), new EventStore(last, new EventBus())); expect(value(restored.getModel(s.id, m.id), 'tools').value).toBe(false);
  });
});

describe('独立目录 REST 边界', () => {
  async function setupHttp() {
    gateway = await startGw({ secretStore: new MemorySecretStore() }); const token = await gateway.pair(); return { t: gateway, token };
  }
  it('接口逐项鉴权，配置可用和执行器未就绪分开报告', async () => {
    const { t, token } = await setupHttp(); const s = await t.gw.services.independent.createService(config()); const m = t.gw.services.independent.createModel(s.id, { remoteModelId: 'm', name: '模型' });
    const service = `/independent/services/${s.id}`; const model = `${service}/models/${m.id}`;
    const operations = [['GET', '/independent/services'], ['POST', '/independent/services'], ['GET', service], ['PATCH', service], ['DELETE', service], ['GET', `${service}/models`], ['POST', `${service}/models`], ['GET', model], ['PATCH', model], ['DELETE', model], ['PATCH', `${model}/overrides`], ['GET', '/independent/default'], ['PUT', '/independent/default']];
    for (const [method, route] of operations) {
      expect((await t.api(method!, route!)).status).toBe(401);
      expect((await t.api(method!, route!, { token, headers: { host: 'evil.example' } })).status).toBe(403);
      expect((await t.api(method!, route!, { token, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    }
    const hello = (await t.api('GET', '/hello', { token })).json;
    expect(hello.features[FeatureKey.IndependentCatalog]).toBe(true); expect(hello.features[FeatureKey.IndependentRuntime]).toBe(true);
    expect((await t.api('GET', '/independent/services', { token })).json.items).toHaveLength(1);
  });

  it('经接口追加模型、手动修订与默认选择，响应不回传密钥', async () => {
    const { t, token } = await setupHttp(); const created = await t.api('POST', '/independent/services', { token, body: config({ authentication: 'api_key', apiKey: 'fixture-api-private-key' }) });
    expect(created.status).toBe(201); expect(created.text).not.toContain('fixture-api'); const route = `/independent/services/${created.json.id}`;
    const m = await t.api('POST', `${route}/models`, { token, body: { remoteModelId: 'model', name: '模型' } }); expect(m.status).toBe(201);
    const updated = await t.api('PATCH', `${route}/models/${m.json.id}/overrides`, { token, body: { expectedRevision: 1, values: { imageInput: false, effortLevels: ['low', 'max'] } } });
    expect(updated.status).toBe(200); expect(value(updated.json, 'imageInput').value).toBe(false);
    expect((await t.api('PUT', '/independent/default', { token, body: { selection: { serviceId: created.json.id, modelId: m.json.id } } })).status).toBe(200);
    expect((await t.api('PATCH', route, { token, body: { expectedRevision: 1, name: '新名字' } })).json.name).toBe('新名字');
    expect((await t.api('PATCH', route, { token, body: { expectedRevision: 1, name: '旧修订' } })).status).toBe(409);
    expect((await t.api('POST', `${route}/models`, { token, body: { remoteModelId: 'other', name: '二号' } })).status).toBe(201);
    expect((await t.api('GET', '/independent/default', { token })).json.selection.modelId).toBe(m.json.id);
    expect((await t.api('DELETE', `${route}/models/${m.json.id}`, { token })).status).toBe(200);
    expect((await t.api('GET', '/independent/default', { token })).json.selection).toBeNull();
    expect((await t.api('DELETE', route, { token })).status).toBe(200);
    expect((await t.api('GET', '/independent/services', { token })).json.items).toEqual([]);
    const audit = t.gw.services.db.all('SELECT * FROM audit_log WHERE action LIKE ?', 'independent.%');
    expect(audit.length).toBeGreaterThan(0); expect(audit.every((row) => typeof row.device_id === 'string')).toBe(true); expect(JSON.stringify(audit)).not.toContain('fixture-api-private-key');
  });

  it('坏请求不能夹带来源、路由或密钥；存储异常不将密钥写入日志', async () => {
    const store = new MemorySecretStore(); gateway = await startGw({ secretStore: store }); const t = gateway; const token = await t.pair();
    expect((await t.api('POST', '/independent/services', { token, body: config({ baseUrl: 'https://example.com?key=fixture' }) })).status).toBe(400);
    const s = await t.gw.services.independent.createService(config());
    expect((await t.api('POST', `/independent/services/${s.id}/models`, { token, body: { remoteModelId: 'm', name: '模型', baseUrl: 'https://evil.example' } })).status).toBe(400);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(store, 'encrypt').mockRejectedValueOnce(new Error('fixture-private-value'));
    const failure = await t.api('POST', '/independent/services', { token, body: config({ authentication: 'api_key', apiKey: 'fixture-private-value' }) });
    expect(failure.status).toBe(503); expect(failure.text).not.toContain('fixture-private-value'); expect(JSON.stringify(consoleError.mock.calls)).not.toContain('fixture-private-value');
    expect(t.gw.services.db.all('SELECT * FROM secrets')).toEqual([]);
  });
});
