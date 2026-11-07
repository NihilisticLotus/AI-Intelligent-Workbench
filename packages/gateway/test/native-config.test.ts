// 用假 ACP 子进程覆盖旧认证数据升级，默认测试不读取本机凭据或请求上游。
import { existsSync, writeFileSync } from 'node:fs';
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
  const old = (await t.api('POST', '/profiles', { token, body: { agent: 'claude', name: '旧测试账号', kind: 'customEndpoint', baseUrl: 'https://example.test/v1', apiKey: 'fake-legacy-key-1234', models: [{ id: 'old-api-model', name: '旧模型', contextWindow: null }] } })).json as AgentProfile;
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
    ws = await WsClient.connect(t!.port, token);
    await ws.call({ op: 'subscribe', data: { lastSeq: 0 } });
    expect((await ws.call({ op: 'prompt', data: { taskId: task.id, text: '不能继续' } })).ok).toBe(true);
    const error = await ws.waitEvent((e) => e.type === 'error' && e.taskId === task.id);
    expect(error.data).toMatchObject({ error: { code: ErrorCode.AgentNativeConfiguration } });
    expect(spawn).not.toHaveBeenCalled();
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
