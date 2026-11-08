// 用假 ACP 子进程覆盖旧认证数据升级，默认测试不读取本机凭据或请求上游。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpecAdapter, type AgentAdapter } from '@aic/adapters';
import { ErrorCode, type AgentProfile, type Task } from '@aic/protocol';
import { MemorySecretStore } from '../src/secrets';
import { makeProject, startGw, WsClient, type TestGw } from './helpers';

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../adapters/test/fixtures/fake-acp-agent.mjs');
let t: TestGw | undefined;
let ws: WsClient | undefined;
afterEach(async () => { await ws?.close(); ws = undefined; await t?.stop(); t = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function setup() {
  let adapter!: AgentAdapter;
  t = await startGw({ secretStore: new MemorySecretStore(), adapters: (rt) => {
    adapter = createSpecAdapter({ kind: 'claude', displayName: '原生配置测试', entry: fixture, usesNativeConfig: true }, rt);
    return [adapter];
  } });
  const token = await t.pair();
  // 模拟旧版本已经保存的账号，仅在种数据时使用旧的管理能力。
  adapter.usesNativeConfig = false;
  const old = (await t.api('POST', '/profiles', { token, body: { agent: 'claude', name: '旧测试账号', kind: 'customEndpoint', configDir: 'isolated', baseUrl: 'https://example.test/v1', apiKey: 'fake-legacy-key-1234', models: [{ id: 'old-api-model', name: '旧模型', contextWindow: null }] } })).json as AgentProfile;
  await t.api('PATCH', `/profiles/${old.id}`, { token, body: { isDefault: true } });
  adapter.usesNativeConfig = true;
  return { token, old, adapter };
}

describe('第三方原生配置升级', () => {
  it('旧默认认证不用于检测、模型目录或选择器，原记录保留并标为停用', async () => {
    const { token, old, adapter } = await setup();
    const read = vi.spyOn(t!.gw.services.secrets, 'read');
    const detect = vi.spyOn(adapter, 'detect');
    await t!.gw.services.agentSvc.detect('claude', true);
    expect(detect).toHaveBeenCalledWith(expect.objectContaining({ env: {}, profile: expect.objectContaining({ id: 'pf_local_claude' }) }));
    const info = (await t!.api('GET', '/agents', { token })).json.items.find((a: { kind: string }) => a.kind === 'claude');
    expect(info).toMatchObject({ usesNativeConfig: true, authMethods: [], models: [] });
    expect(info.profiles.map((p: { id: string }) => p.id)).toEqual(['pf_local_claude']);
    const list = (await t!.api('GET', '/profiles?agent=claude', { token })).json.items as AgentProfile[];
    expect(list.find((p) => p.id === old.id)).toMatchObject({ retired: true, isDefault: false, hasSecret: true });
    expect(list.find((p) => p.id === 'pf_local_claude')).toMatchObject({ retired: false, isDefault: true });
    expect(read).not.toHaveBeenCalled();
  });

  it('创建、编辑、测试、刷新、删除与登录都先阻断，不解密旧 Key、不启动进程、不请求网络', async () => {
    const { token, old, adapter } = await setup();
    const read = vi.spyOn(t!.gw.services.secrets, 'read');
    const save = vi.spyOn(t!.gw.services.secrets, 'save');
    const probe = vi.spyOn(adapter, 'probe');
    const upstream = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('禁止请求网络'));
    const requests = [
      t!.api('POST', '/profiles', { token, body: { agent: 'claude', name: '新 Key', kind: 'apiKey', apiKey: 'fake-new-key-5678' } }),
      t!.api('PATCH', `/profiles/${old.id}`, { token, body: { apiKey: 'fake-replace-key-0000', isDefault: true } }),
      t!.api('POST', '/agents/claude/test', { token, body: { profileId: old.id, sendMessage: true } }),
      t!.api('POST', `/profiles/${old.id}/models/refresh`, { token }),
      t!.api('DELETE', `/profiles/${old.id}`, { token }),
      t!.api('POST', '/agents/claude/login', { token, body: { methodId: 'api-key', profileId: old.id } }),
    ];
    for (const r of await Promise.all(requests)) { expect(r.status).toBe(409); expect(r.json.code).toBe(ErrorCode.AgentNativeConfiguration); }
    expect(read).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
    expect(t!.gw.services.profiles.row(old.id).secret_id).toBeTruthy();
  });

  it('旧账号任务不能新建；默认任务曾使用旧认证时也停止，不改用本机账号继续计费', async () => {
    const { token, old, adapter } = await setup();
    const project = await makeProject(t!, token);
    const spawn = vi.spyOn(adapter, 'spawn');
    const bad = await t!.api('POST', '/tasks', { token, body: { projectId: project.id, agent: 'claude', profileId: old.id, prompt: '不应发送' } });
    expect(bad.status).toBe(409);
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId: project.id, agent: 'claude', prompt: '', deferPrompt: true } })).json as Task;
    t!.gw.services.db.run("INSERT INTO sessions (id,task_id,agent_id,profile_id,agent_session_id,status,started_at) VALUES (?,?,'claude',?,?,'closed',?)", 's_legacy', task.id, old.id, 'old-session', Date.now());
    expect((await t!.api('DELETE', `/profiles/${old.id}/secret`, { token })).status).toBe(200);
    ws = await WsClient.connect(t!.port, token);
    await ws.call({ op: 'subscribe', data: { lastSeq: 0 } });
    expect((await ws.call({ op: 'prompt', data: { taskId: task.id, text: '不能继续' } })).ok).toBe(true);
    const error = await ws.waitEvent((e) => e.type === 'error' && e.taskId === task.id);
    expect(error.data).toMatchObject({ error: { code: ErrorCode.AgentNativeConfiguration } });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('清理只删除工作台密文，保留旧任务绑定、会话与目录，重复清理安全', async () => {
    const { token, old, adapter } = await setup();
    const { db, profiles, secrets } = t!.gw.services;
    const before = profiles.row(old.id);
    const project = await makeProject(t!, token);
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId: project.id, agent: 'claude', prompt: '', deferPrompt: true } })).json as Task;
    db.run('UPDATE tasks SET profile_id = ? WHERE id = ?', old.id, task.id);
    db.run("INSERT INTO sessions (id,task_id,agent_id,profile_id,agent_session_id,status,started_at) VALUES (?,?,'claude',?,?,'closed',?)", 's_kept', task.id, old.id, 'kept-session', Date.now());
    // 只放合成历史文件；生产清理方法不执行任何文件系统操作。
    const marker = path.join(profiles.dirOf(old.id), 'kept-history.txt'); writeFileSync(marker, '合成历史');
    const read = vi.spyOn(secrets, 'read'); const decrypt = vi.spyOn(secrets.store, 'decrypt');
    const probe = vi.spyOn(adapter, 'probe'); const spawn = vi.spyOn(adapter, 'spawn');
    const upstream = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('禁止请求网络'));
    for (let i = 0; i < 2; i++) {
      const result = await t!.api('DELETE', `/profiles/${old.id}/secret`, { token });
      expect(result.status).toBe(200);
      expect(result.json).toMatchObject({ id: old.id, retired: true, hasSecret: false, secretHint: null });
    }
    expect(profiles.row(old.id)).toEqual({ ...before, secret_id: null, updated_at: expect.any(Number) });
    expect(db.get('SELECT id FROM secrets WHERE id = ?', before.secret_id)).toBeUndefined();
    expect(db.get('SELECT profile_id FROM tasks WHERE id = ?', task.id)).toEqual({ profile_id: old.id });
    expect(db.get('SELECT profile_id FROM sessions WHERE id = ?', 's_kept')).toEqual({ profile_id: old.id });
    expect(db.all("SELECT detail FROM audit_log WHERE action = 'profile.secret.clear'")).toEqual([{ detail: old.id }]);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('合成历史');
    expect(() => profiles.resolve('claude', old.id)).toThrow();
    for (const spy of [read, decrypt, probe, spawn, upstream]) expect(spy).not.toHaveBeenCalled();
  });

  it('密文删除后发生故障时一并回滚引用和审计，密钥不用解密', async () => {
    const { token, old } = await setup();
    const { profiles, secrets, db } = t!.gw.services;
    const before = profiles.row(old.id);
    const original = secrets.delete.bind(secrets);
    vi.spyOn(secrets, 'delete').mockImplementation((id) => { original(id); throw new Error('合成持久化故障'); });
    const result = await t!.api('DELETE', `/profiles/${old.id}/secret`, { token });
    expect(result.status).toBe(500);
    expect(profiles.row(old.id)).toEqual(before);
    expect(db.get('SELECT id FROM secrets WHERE id = ?', before.secret_id)).toEqual({ id: before.secret_id });
    expect(db.all("SELECT detail FROM audit_log WHERE action = 'profile.secret.clear'")).toEqual([]);
  });

  it('运行中、共享密钥、本机配置和非原生配置不允许清理', async () => {
    const { token, old, adapter } = await setup();
    const { profiles, tasks, db } = t!.gw.services;
    const before = profiles.row(old.id);
    const inUse = vi.spyOn(tasks, 'profileInUse').mockReturnValue(true);
    expect((await t!.api('DELETE', `/profiles/${old.id}/secret`, { token })).status).toBe(409);
    inUse.mockReturnValue(false);
    db.run("INSERT INTO agent_profiles(id,agent,name,kind,config_dir,secret_id,is_default,created_at,updated_at) VALUES ('pf_shared','claude','共享反例','apiKey','shared',?,0,?,?)", before.secret_id, Date.now(), Date.now());
    expect((await t!.api('DELETE', `/profiles/${old.id}/secret`, { token })).status).toBe(400);
    db.run("DELETE FROM agent_profiles WHERE id = 'pf_shared'");
    db.run("INSERT INTO independent_services(id,config_json,revision,config_revision,secret_id,created_at,updated_at) VALUES ('svc_shared','{}',1,1,?,?,?)", before.secret_id, Date.now(), Date.now());
    expect((await t!.api('DELETE', `/profiles/${old.id}/secret`, { token })).status).toBe(400);
    db.run("DELETE FROM independent_services WHERE id = 'svc_shared'");
    expect((await t!.api('DELETE', '/profiles/pf_local_claude/secret', { token })).status).toBe(400);
    adapter.usesNativeConfig = false;
    expect((await t!.api('DELETE', `/profiles/${old.id}/secret`, { token })).status).toBe(400);
    expect(profiles.row(old.id)).toEqual(before);
  });

  it('清理路由校验令牌、Host、Origin 与浏览器设备密钥，拒绝请求不修改数据', async () => {
    const { token, old } = await setup();
    const route = `/profiles/${old.id}/secret`;
    const before = t!.gw.services.profiles.row(old.id);
    expect((await t!.api('DELETE', route)).status).toBe(401);
    expect((await t!.api('DELETE', route, { token, headers: { host: 'evil.test' } })).status).toBe(403);
    expect((await t!.api('DELETE', route, { token, headers: { origin: 'https://evil.test' } })).status).toBe(403);
    const browser = await t!.pairBrowser();
    expect((await t!.api('DELETE', route, { cookie: browser.cookie, headers: { origin: `http://127.0.0.1:${t!.port}` } })).status).toBe(401);
    expect(t!.gw.services.profiles.row(old.id)).toEqual(before);
  });

  it('新任务仅继承软件原有配置；原生环境里的 Key 进入脱敏集合而不读取凭据文件', async () => {
    const { token, adapter } = await setup();
    const scenarioFile = path.join(t!.dataDir, 'scenario.json');
    const log = path.join(t!.dataDir, 'agent.log');
    writeFileSync(scenarioFile, '{}');
    vi.stubEnv('AIC_FAKE_SCENARIO', scenarioFile); vi.stubEnv('AIC_FAKE_LOG', log);
    vi.stubEnv('ANTHROPIC_API_KEY', 'fake-own-native-key-7890');
    const read = vi.spyOn(t!.gw.services.secrets, 'read');
    const spawn = vi.spyOn(adapter, 'spawn');
    const project = await makeProject(t!, token);
    ws = await WsClient.connect(t!.port, token);
    await ws.call({ op: 'subscribe', data: { lastSeq: 0 } });
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId: project.id, agent: 'claude', prompt: '离线测试' } })).json as Task;
    await ws.waitEvent((e) => e.type === 'session.started' && e.taskId === task.id);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ env: {}, redact: expect.arrayContaining(['fake-own-native-key-7890']), profile: expect.objectContaining({ id: 'pf_local_claude' }) }));
    expect(existsSync(log)).toBe(true); expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(ws.events())).not.toContain('fake-own-native-key-7890');
  });
});
