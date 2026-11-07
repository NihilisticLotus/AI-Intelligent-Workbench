// 账号与密钥（phase-1.md 6.4、6.6.2、6.8）：响应里永远没有明文、hint 正确；删除和默认账号规则；
// DPAPI 往返（只在 Windows 上运行）：数据库文件里搜不到明文，PowerShell 的命令行参数里没有明文。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpecAdapter } from '@aic/adapters';
import { AgentProfile, ErrorCode, type Task } from '@aic/protocol';
import { openDb } from '../src/db';
import { DpapiSecretStore, MemorySecretStore, SecretService, dpapiArgs, entropyFrom } from '../src/secrets';
import { makeProject, startGw, WsClient, type TestGw } from './helpers';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../adapters/test/fixtures/fake-acp-agent.mjs');
const KEY = 'sk-ant-test-0123456789abcdefWXYZ';

let t: TestGw | null = null;
let ws: WsClient | null = null;
let scDir: string | null = null;
afterEach(async () => {
  await ws?.close(); ws = null;
  await t?.stop(); t = null;
  if (scDir) { try { rmSync(scDir, { recursive: true, force: true }); } catch { /* 忽略 */ } scDir = null; }
});

async function setup() {
  scDir = mkdtempSync(path.join(tmpdir(), 'aic-gw-prof-'));
  const file = path.join(scDir, 'scenario.json');
  writeFileSync(file, JSON.stringify({ watchEnv: ['AIC_FAKE_SECRET'] }));
  t = await startGw({
    secretStore: new MemorySecretStore(),
    adapters: (rt) => [createSpecAdapter({ kind: 'claude', displayName: '假 Claude', entry: FIXTURE, env: { AIC_FAKE_SCENARIO: file, AIC_FAKE_LOG: path.join(scDir!, 'agent.log') } }, rt)],
  });
  const token = await t.pair();
  return { token, logFile: path.join(scDir, 'agent.log') };
}

describe('账号 REST', () => {
  it('自定义账号的手填模型不被其他账号或通用 ACP 缓存覆盖，未探测账号不借用默认目录', async () => {
    const { token } = await setup();
    const models=[{id:'glm',name:'GLM',contextWindow:null,vision:false}];
    const custom=(await t!.api('POST','/profiles',{token,body:{agent:'claude',name:'自定义',kind:'customEndpoint',apiKey:KEY,baseUrl:'https://example.test/api',models}})).json as AgentProfile;
    const isolated=(await t!.api('POST','/profiles',{token,body:{agent:'claude',name:'隔离订阅',kind:'subscription',configDir:'isolated'}})).json as AgentProfile;
    const local=t!.gw.services.profiles.defaultRow('claude');
    const native={model:'native',effort:null,models:[{id:'native',name:'订阅模型',contextWindow:null}],efforts:['high'],modes:[],mode:null,ids:{model:null,effort:null,mode:null},source:'legacy' as const};
    t!.gw.services.agentSvc.saveCatalog('claude',local.id,native);
    t!.gw.services.agentSvc.saveCatalog('claude',custom.id,native);
    expect(t!.gw.services.agentSvc.catalog('claude',custom.id)).toMatchObject({models,efforts:null,source:'manual'});
    expect(t!.gw.services.agentSvc.catalog('claude',isolated.id)).toMatchObject({models:[],source:'none'});
    const infos=(await t!.api('GET','/agents',{token})).json.items;
    const summaries=infos.find((a: {kind:string})=>a.kind==='claude').profiles;
    expect(summaries.find((p: {id:string})=>p.id===custom.id)).toMatchObject({models,efforts:null,modelsSource:'manual'});
  });
  it('建 API Key 账号：响应里只有 hasSecret 和结尾 4 位；数据库、审计、事件里都没有明文', async () => {
    const { token } = await setup();
    // 默认账号“本机登录”自动建好，不能删除
    const list0 = (await t!.api('GET', '/profiles?agent=claude', { token })).json.items as AgentProfile[];
    expect(list0).toHaveLength(1);
    expect(list0[0]).toMatchObject({ kind: 'subscription', configDir: 'shared', isDefault: true, hasSecret: false });

    const r = await t!.api('POST', '/profiles', { token, body: { agent: 'claude', name: '官方 Key', kind: 'apiKey', apiKey: KEY } });
    expect(r.status).toBe(201);
    expect(AgentProfile.safeParse(r.json).success).toBe(true);
    expect(r.json).toMatchObject({ hasSecret: true, secretHint: 'WXYZ', isDefault: false, configDir: 'shared' });
    expect(r.text).not.toContain(KEY);
    const id = r.json.id as string;

    for (const p of ['/profiles', `/profiles/${id}`, '/agents']) expect((await t!.api('GET', p, { token })).text).not.toContain(KEY);
    const db = t!.gw.services.db;
    const dump = JSON.stringify([db.all('SELECT * FROM agent_profiles'), db.all('SELECT * FROM secrets'), db.all('SELECT * FROM audit_log'), db.all('SELECT * FROM events')]);
    expect(dump).not.toContain(KEY);
    expect(db.all<{ action: string }>('SELECT action FROM audit_log').map((a) => a.action)).toContain('profile.create');

    // 替换密钥：旧密文删除，hint 更新
    const p = await t!.api('PATCH', `/profiles/${id}`, { token, body: { apiKey: 'sk-ant-another-key-0000abcd' } });
    expect(p.json).toMatchObject({ hasSecret: true, secretHint: 'abcd' });
    expect(db.all('SELECT * FROM secrets')).toHaveLength(1);
  });

  it('校验：订阅账号不能带密钥；API Key 账号必须带；自定义地址必须是 https 或本机 http', async () => {
    const { token } = await setup();
    expect((await t!.api('POST', '/profiles', { token, body: { agent: 'claude', name: 'x', kind: 'apiKey' } })).status).toBe(400);
    expect((await t!.api('POST', '/profiles', { token, body: { agent: 'claude', name: 'x', kind: 'subscription', apiKey: KEY } })).status).toBe(400);
    expect((await t!.api('POST', '/profiles', { token, body: { agent: 'claude', name: 'x', kind: 'customEndpoint', apiKey: KEY, baseUrl: 'http://relay.example.com' } })).status).toBe(400);
    const ok = await t!.api('POST', '/profiles', { token, body: { agent: 'claude', name: '中转', kind: 'customEndpoint', apiKey: KEY, baseUrl: 'http://127.0.0.1:9000/v1', authHeader: 'bearer' } });
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ baseUrl: 'http://127.0.0.1:9000/v1', authHeader: 'bearer' });
    // 演示 Agent 不需要账号
    expect((await t!.api('POST', '/profiles', { token, body: { agent: 'fake', name: 'x', kind: 'apiKey', apiKey: KEY } })).status).toBe(400);
  });

  it('设为默认、删除：本机登录不能删；删除默认账号后回到本机登录；引用它的任务改用默认账号', async () => {
    const { token } = await setup();
    const a = (await t!.api('POST', '/profiles', { token, body: { agent: 'claude', name: 'A', kind: 'apiKey', apiKey: KEY } })).json as AgentProfile;
    const set = await t!.api('PATCH', `/profiles/${a.id}`, { token, body: { isDefault: true } });
    expect(set.json.isDefault).toBe(true);
    const list = (await t!.api('GET', '/profiles?agent=claude', { token })).json.items as AgentProfile[];
    expect(list.filter((p) => p.isDefault).map((p) => p.id)).toEqual([a.id]);
    const local = list.find((p) => p.kind === 'subscription')!;
    expect((await t!.api('DELETE', `/profiles/${local.id}`, { token })).status).toBe(400);

    const del = await t!.api('DELETE', `/profiles/${a.id}`, { token });
    expect(del.status).toBe(200);
    const after = (await t!.api('GET', '/profiles?agent=claude', { token })).json.items as AgentProfile[];
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: local.id, isDefault: true });
    expect(t!.gw.services.db.all('SELECT * FROM secrets')).toHaveLength(0);
  });

  it('任务用 API Key 账号：密钥经环境变量注入 Agent 进程；有运行中的会话时不能删除', async () => {
    const { token, logFile } = await setup();
    const project = await makeProject(t!, token);
    ws = await WsClient.connect(t!.port, token);
    await ws.call({ op: 'subscribe', data: { lastSeq: 0 } });
    const a = (await t!.api('POST', '/profiles', { token, body: { agent: 'claude', name: 'A', kind: 'apiKey', apiKey: KEY } })).json as AgentProfile;
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId: project.id, prompt: 'x', agent: 'claude', profileId: a.id } })).json as Task;
    expect(task.profileId).toBe(a.id);
    await ws.waitEvent((e) => e.type === 'task.updated' && e.taskId === task.id && (e.data as { task: Task }).task.status === 'review', 10_000);
    const started = ws.events().find((e) => e.type === 'session.started' && e.taskId === task.id)!;
    expect(started.data).toMatchObject({ profileId: a.id });
    const startLine = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.event === 'start');
    expect(startLine.env).toEqual({ AIC_FAKE_SECRET: KEY });
    // 事件里没有明文
    expect(JSON.stringify(ws.frames)).not.toContain(KEY);
    const del = await t!.api('DELETE', `/profiles/${a.id}`, { token });
    expect(del.status).toBe(409);
    expect(del.json.code).toBe(ErrorCode.ProfileInUse);
  });
});

describe.skipIf(process.platform !== 'win32')('DPAPI（Windows）', () => {
  it('往返加解密一致；数据库文件里搜不到明文；命令行参数里没有明文', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aic-dpapi-'));
    const db = openDb(path.join(dir, 'aic.db'));
    try {
      const svc = new SecretService(db, new DpapiSecretStore(entropyFrom(db)));
      const plain = 'sk-dpapi-roundtrip-测试-0123456789';
      const s = await svc.save(plain);
      expect(s.hint).toBe('6789');
      expect(await svc.read(s.id)).toBe(plain);
      const row = db.get<{ blob: string; scheme: string }>('SELECT blob, scheme FROM secrets WHERE id = ?', s.id)!;
      expect(row.scheme).toBe('dpapi-user-v1');
      expect(row.blob).not.toContain(plain);
      // 换一份 entropy（另一份数据目录）解不开
      const other = new DpapiSecretStore(() => Buffer.alloc(32, 7));
      await expect(other.decrypt(row.blob)).rejects.toThrow();
      for (const op of ['Protect', 'Unprotect'] as const) expect(dpapiArgs(op).join(' ')).not.toContain(plain);
      db.close();
      const raw = readFileSync(path.join(dir, 'aic.db'));
      expect(raw.includes(Buffer.from(plain, 'utf8'))).toBe(false);
    } finally {
      try { db.close(); } catch { /* 已关闭 */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
