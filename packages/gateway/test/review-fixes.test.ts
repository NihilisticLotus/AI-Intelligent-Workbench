// 第 1.2 步审查后的修复（docs/acceptance/step-1.2.md“审查与修复”）：Gateway 这一层的回归测试。
// 全部用假 ACP Agent 进程，不启动真实 Agent。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AbortError, createSpecAdapter, isAlive, type SpecAdapterOptions } from '@aic/adapters';
import { AgentInfo, DeleteProfileResult, type AgentProfile, type EventEnvelope, type Task } from '@aic/protocol';
import { MemorySecretStore } from '../src/secrets';
import { makeProject, startGw, WsClient, type TestGw } from './helpers';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../adapters/test/fixtures/fake-acp-agent.mjs');
const text = (t: string) => ({ type: 'text', text: t });
const KEY = 'sk-ant-review-0123456789abcdefQRST';
const OPTIONS = [{ optionId: 'allow-once', kind: 'allow_once', name: 'Yes' }, { optionId: 'reject', kind: 'reject_once', name: 'No' }];

function scenario(sc: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aic-gw-review-'));
  const file = path.join(dir, 'scenario.json');
  const logFile = path.join(dir, 'agent.log');
  writeFileSync(file, JSON.stringify(sc));
  return {
    dir, env: { AIC_FAKE_SCENARIO: file, AIC_FAKE_LOG: logFile },
    log: (): Record<string, any>[] => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } },
  };
}
type Sc = ReturnType<typeof scenario>;

let t: TestGw | null = null;
let ws: WsClient | null = null;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await ws?.close(); ws = null;
  await t?.stop(); t = null;
  for (const c of cleanups.splice(0)) c();
});

async function setup(sc: Sc, extra: Parameters<typeof startGw>[0] = {}, spec: Partial<SpecAdapterOptions> = {}) {
  cleanups.push(sc.cleanup);
  t = await startGw({
    secretStore: new MemorySecretStore(),
    adapters: (rt) => [createSpecAdapter({ kind: 'claude', displayName: '假 Claude', entry: FIXTURE, env: sc.env, ...spec }, rt)],
    ...extra,
  });
  const token = await t.pair();
  const project = await makeProject(t, token);
  ws = await WsClient.connect(t.port, token);
  await ws.call({ op: 'subscribe', data: { lastSeq: 0 } });
  return { token, projectId: project.id, ws };
}

const statusIs = (taskId: string, s: string) => (e: EventEnvelope) => e.type === 'task.updated' && e.taskId === taskId && (e.data as { task: Task }).task.status === s;
const statuses = (w: WsClient, taskId: string) => w.events().filter((e) => e.type === 'task.updated' && e.taskId === taskId).map((e) => (e.data as { task: Task }).task.status);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('第 3 条：API Key 不进事件库、审批记录和推送', () => {
  it('流式分片拆开的密钥、工具标题、工具输出、审批详情都按原文脱敏', async () => {
    const sc = scenario({
      turns: [{
        steps: [
          { update: { sessionUpdate: 'agent_message_chunk', content: text(`变量是 ${KEY.slice(0, 10)}`) } },
          { update: { sessionUpdate: 'agent_message_chunk', content: text(`${KEY.slice(10)}，好的`) } },
          { update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: `执行 echo ${KEY}`, kind: 'execute', status: 'pending', rawInput: { command: `echo ${KEY}` } } },
          {
            permission: { toolCall: { toolCallId: 'c1', title: `执行 echo ${KEY}`, kind: 'execute', rawInput: { command: `echo ${KEY}` } }, options: OPTIONS },
            then: { allow: [{ update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: text(`ANTHROPIC_API_KEY=${KEY}\nPATH=x`) }] } }] },
          },
        ],
      }],
    });
    const { token, projectId, ws } = await setup(sc);
    const p = (await t!.api('POST', '/profiles', { token, body: { agent: 'claude', name: 'K', kind: 'apiKey', apiKey: KEY } })).json as AgentProfile;
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'x', agent: 'claude', profileId: p.id } })).json as Task;
    const req = await ws.waitEvent((e) => e.type === 'approval.requested' && e.taskId === task.id, 10_000);
    const approval = (req.data as { approval: { id: string; detail: string | null; title: string } }).approval;
    expect(JSON.stringify(approval)).not.toContain(KEY);
    await ws.call({ op: 'approve', data: { approvalId: approval.id, optionId: 'allow-once' } });
    await ws.waitEvent(statusIs(task.id, 'review'), 10_000);
    const all = JSON.stringify(ws.frames);
    expect(all).not.toContain(KEY);
    // 拆开的两片拼起来以后被替换
    const msg = ws.events().filter((e) => e.type === 'message.delta' && e.taskId === task.id).map((e) => (e.data as { text: string }).text).join('');
    expect(msg).toBe('变量是 ***，好的');
    expect(all).toContain('ANTHROPIC_API_KEY=***');
    const db = t!.gw.services.db;
    expect(JSON.stringify(db.all('SELECT * FROM events'))).not.toContain(KEY);
    expect(JSON.stringify(db.all('SELECT * FROM approvals'))).not.toContain(KEY);
  });
});

describe('第 4、9 条：并发名额', () => {
  it('释放一个名额只放行一个排队者；调大上限也不超', async () => {
    const sc = scenario({});
    const { token } = await setup(sc);
    await t!.api('PATCH', '/agents/claude', { token, body: { concurrencyLimit: 2 } });
    const svc = t!.gw.services.agentSvc;
    const r1 = (await svc.acquire('claude'))!;
    const r2 = (await svc.acquire('claude'))!;
    let passed = 0;
    const q3 = svc.acquire('claude').then((r) => { passed++; return r!; });
    const q4 = svc.acquire('claude').then((r) => { passed++; return r!; });
    const q5 = svc.acquire('claude').then((r) => { passed++; return r!; });
    expect(svc.queued('claude')).toBe(3);
    r1();
    await sleep(20);
    expect(passed).toBe(1);
    expect(svc.runningCount('claude')).toBe(2);
    await t!.api('PATCH', '/agents/claude', { token, body: { concurrencyLimit: 3 } });
    await sleep(20);
    expect(passed).toBe(2);
    expect(svc.runningCount('claude')).toBe(3);
    expect(svc.queued('claude')).toBe(1);
    for (const r of [r2, await q3, await q4]) r();
    (await q5)();
    expect(svc.runningCount('claude')).toBe(0);
  });

  it('信号在排队前已经取消：立即放弃，不留在队列里', async () => {
    const sc = scenario({});
    const { token } = await setup(sc);
    await t!.api('PATCH', '/agents/claude', { token, body: { concurrencyLimit: 1 } });
    const svc = t!.gw.services.agentSvc;
    const r1 = (await svc.acquire('claude'))!;
    const ac = new AbortController();
    ac.abort();
    await expect(svc.acquire('claude', undefined, ac.signal)).rejects.toBeInstanceOf(AbortError);
    expect(svc.queued('claude')).toBe(0);
    r1();
    expect(svc.runningCount('claude')).toBe(0);
  });
});

describe('第 5 条：启动期间点 [停止]', () => {
  it('initialize 卡住时停止：任务暂停，没有错误事件', async () => {
    const sc = scenario({ hangInitialize: true });
    const { projectId, ws, token } = await setup(sc);
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'x', agent: 'claude' } })).json as Task;
    const deadline = Date.now() + 5000;
    while (!sc.log().some((l) => l.method === 'initialize') && Date.now() < deadline) await sleep(20);
    const t0 = Date.now();
    await ws.call({ op: 'cancel', data: { taskId: task.id } });
    await ws.waitEvent(statusIs(task.id, 'paused'), 10_000);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(ws.events().some((e) => e.type === 'error' && e.taskId === task.id)).toBe(false);
    expect(statuses(ws, task.id)).not.toContain('failed');
    expect(t!.gw.services.agentSvc.runningCount('claude')).toBe(0);
  });
});

describe('第 6 条：关闭窗口（有截止时间的关闭）', () => {
  it('取消无响应的回合不会拖住退出：先结束进程树（含孙进程），再收尾', async () => {
    const sc = scenario({ grandchild: true, stubborn: true, ignoreCancel: true, turns: [{ steps: [{ update: { sessionUpdate: 'agent_message_chunk', content: text('开始') } }, { waitCancel: true }] }] });
    const { token, projectId, ws } = await setup(sc);
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'x', agent: 'claude' } })).json as Task;
    await ws.waitEvent((e) => e.type === 'message.delta' && e.taskId === task.id, 10_000);
    const grand = sc.log().find((l) => l.event === 'grandchild')!.pid as number;
    const agentPid = sc.log().find((l) => l.event === 'start')!.pid as number;
    expect(isAlive(grand)).toBe(true);
    const t0 = Date.now();
    await t!.gw.close({ deadlineMs: 300 });
    // 默认的取消等待是 10 秒；有截止时间时远小于这个值
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(isAlive(agentPid)).toBe(false);
    expect(isAlive(grand)).toBe(false);
  });
});

describe('第 7 条：审批状态', () => {
  it('并行的两条审批：处理一条后仍是“等待审批”，都处理完才回到运行中', async () => {
    const perm = (id: string) => ({ toolCall: { toolCallId: id, title: `执行 ${id}`, kind: 'execute', rawInput: { command: id } }, options: OPTIONS });
    const sc = scenario({ turns: [{ steps: [{ parallelPermissions: [perm('p1'), perm('p2')] }, { sleep: 300 }] }] });
    const { token, projectId, ws } = await setup(sc);
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'x', agent: 'claude' } })).json as Task;
    const deadline = Date.now() + 10_000;
    while (ws.events().filter((e) => e.type === 'approval.requested' && e.taskId === task.id).length < 2 && Date.now() < deadline) await sleep(20);
    const ids = ws.events().filter((e) => e.type === 'approval.requested' && e.taskId === task.id).map((e) => (e.data as { approval: { id: string } }).approval.id);
    expect(ids).toHaveLength(2);
    await ws.call({ op: 'approve', data: { approvalId: ids[0]!, optionId: 'allow-once' } });
    await sleep(100);
    expect((await t!.api('GET', `/tasks/${task.id}`, { token })).json.status).toBe('waiting');
    await ws.call({ op: 'approve', data: { approvalId: ids[1]!, optionId: 'reject' } });
    await ws.waitEvent(statusIs(task.id, 'running'), 5000);
    await ws.waitEvent(statusIs(task.id, 'review'), 10_000);
  });
});

describe('第 8 条：取消无响应、进程被结束', () => {
  it('立即释放并发名额、记会话结束，排队的任务不用等空闲回收', async () => {
    const sc = scenario({ ignoreCancel: true, turns: [{ steps: [{ update: { sessionUpdate: 'agent_message_chunk', content: text('开始') } }, { waitCancel: true }] }, { steps: [] }] });
    const { token, projectId, ws } = await setup(sc, { agentTimeouts: { cancel: 300, killGrace: 300 } });
    await t!.api('PATCH', '/agents/claude', { token, body: { concurrencyLimit: 1 } });
    const a = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'a', agent: 'claude' } })).json as Task;
    await ws.waitEvent((e) => e.type === 'message.delta' && e.taskId === a.id, 10_000);
    await ws.call({ op: 'cancel', data: { taskId: a.id } });
    await ws.waitEvent(statusIs(a.id, 'paused'), 10_000);
    await ws.waitEvent((e) => e.type === 'session.ended' && e.taskId === a.id, 5000);
    expect(t!.gw.services.agentSvc.runningCount('claude')).toBe(0);
  });
});

describe('第 10 条：H1 换模型', () => {
  it('Agent 不能在会话里换模型：下一次启动时把模型交给 Agent，任务记录和 Agent 实际用的一致', async () => {
    const sc = scenario({ watchEnv: ['AIC_LAUNCH_MODEL'] });
    const { token, projectId, ws } = await setup(sc, {}, { launchModelEnv: 'AIC_LAUNCH_MODEL' });
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'a', agent: 'claude' } })).json as Task;
    await ws.waitEvent(statusIs(task.id, 'review'), 10_000);
    const sw = await ws.call({ op: 'switch', data: { taskId: task.id, model: 'beta' } });
    expect(sw.ok).toBe(true);
    await ws.waitEvent((e) => e.type === 'session.ended' && e.taskId === task.id, 5000);
    await ws.call({ op: 'prompt', data: { taskId: task.id, text: 'b' } });
    await ws.waitEvent((e) => e.type === 'session.started' && e.taskId === task.id && (e.data as { model: string | null }).model === 'beta', 10_000);
    const starts = sc.log().filter((l) => l.event === 'start');
    expect(starts.at(-1)!.env).toEqual({ AIC_LAUNCH_MODEL: 'beta' });
    expect(((await t!.api('GET', `/tasks/${task.id}`, { token })).json as Task).model).toBe('beta');
  });

  it('启动时没能下发保存的模型：任务记录改成 Agent 实际用的', async () => {
    const sc = scenario({});
    const { token, projectId, ws } = await setup(sc);
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'a', agent: 'claude', model: 'beta' } })).json as Task;
    await ws.waitEvent(statusIs(task.id, 'review'), 10_000);
    expect(((await t!.api('GET', `/tasks/${task.id}`, { token })).json as Task).model).toBeNull();
  });
});

describe('第 12、18 条：换账号', () => {
  it('名额被排队任务拿走：不排队、不卡住请求，任务状态不变，提示下一条消息时再启动', async () => {
    const sc = scenario({});
    const { token, projectId, ws } = await setup(sc);
    await t!.api('PATCH', '/agents/claude', { token, body: { concurrencyLimit: 1 } });
    const p2 = (await t!.api('POST', '/profiles', { token, body: { agent: 'claude', name: 'K', kind: 'apiKey', apiKey: KEY } })).json as AgentProfile;
    const a = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'a', agent: 'claude' } })).json as Task;
    await ws.waitEvent(statusIs(a.id, 'review'), 10_000);
    const b = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'b', agent: 'claude' } })).json as Task;
    await ws.waitEvent(statusIs(b.id, 'queued'), 5000);
    const t0 = Date.now();
    const r = await t!.api('PATCH', `/tasks/${a.id}`, { token, body: { profileId: p2.id } });
    expect(r.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect((r.json as Task).profileId).toBe(p2.id);
    expect((r.json as Task).status).toBe('review');
    await ws.waitEvent(statusIs(b.id, 'review'), 10_000);
    expect(ws.events().some((e) => e.type === 'session.notice' && e.taskId === a.id && /并发名额已满/.test((e.data as { text: string }).text))).toBe(true);
    expect(statuses(ws, a.id)).not.toContain('queued');
  });

  it('没有进程时换账号：下一条消息时仍尝试恢复原来的会话（不悄悄新建）', async () => {
    const sc = scenario({});
    const { token, projectId, ws } = await setup(sc, { idleTimeoutMs: 1200 });
    const p2 = (await t!.api('POST', '/profiles', { token, body: { agent: 'claude', name: 'K', kind: 'apiKey', apiKey: KEY } })).json as AgentProfile;
    const a = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'a', agent: 'claude' } })).json as Task;
    await ws.waitEvent(statusIs(a.id, 'review'), 10_000);
    await ws.waitEvent((e) => e.type === 'session.ended' && e.taskId === a.id && (e.data as { reason: string }).reason === 'idle', 10_000);
    const first = sc.log().find((l) => l.method === 'session/new')!;
    expect((await t!.api('PATCH', `/tasks/${a.id}`, { token, body: { profileId: p2.id } })).status).toBe(200);
    await ws.call({ op: 'prompt', data: { taskId: a.id, text: 'again' } });
    const started = await ws.waitEvent((e) => e.type === 'session.started' && e.taskId === a.id && (e.data as { profileId?: string }).profileId === p2.id, 10_000);
    expect((started.data as { resumed?: boolean }).resumed).toBe(true);
    expect(sc.log().some((l) => l.method === 'session/resume')).toBe(true);
    expect(first).toBeTruthy();
  });

  it('会话存放位置不同的账号（独立配置目录）：有会话时拒绝，带 session.not_recoverable，任务记录不变', async () => {
    const sc = scenario({});
    const { token, projectId, ws } = await setup(sc);
    const iso = (await t!.api('POST', '/profiles', { token, body: { agent: 'claude', name: '第二个订阅', kind: 'subscription' } })).json as AgentProfile;
    expect(iso.configDir).toBe('isolated');
    const info = AgentInfo.parse(((await t!.api('GET', '/agents', { token })).json.items as unknown[]).find((x) => (x as { kind: string }).kind === 'claude'));
    const stores = Object.fromEntries((info.profiles ?? []).map((p) => [p.id, p.sessionStore]));
    expect(stores[iso.id]).not.toBe(stores[info.profiles!.find((p) => p.isDefault)!.id]);
    const a = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'a', agent: 'claude' } })).json as Task;
    await ws.waitEvent(statusIs(a.id, 'review'), 10_000);
    const r = await t!.api('PATCH', `/tasks/${a.id}`, { token, body: { profileId: iso.id } });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('session.not_recoverable');
    expect(((await t!.api('GET', `/tasks/${a.id}`, { token })).json as Task).profileId).toBeNull();
  });
});

describe('第 13、17、21 条：协议字段', () => {
  it('AgentInfo 带 permissionLevels、defaultModel、workspaceConfig；PATCH 能设默认模型；删除账号返回 DeleteProfileResult', async () => {
    const sc = scenario({});
    const { token } = await setup(sc);
    const list = (await t!.api('GET', '/agents', { token })).json.items as unknown[];
    const info = list.map((x) => AgentInfo.parse(x)).find((x) => x.kind === 'claude')!;
    expect(info.permissionLevels).toEqual(['readonly', 'ask']);
    expect(info.defaultModel).toBeNull();
    const patched = AgentInfo.parse((await t!.api('PATCH', '/agents/claude', { token, body: { defaultModel: 'beta' } })).json);
    expect(patched.defaultModel).toBe('beta');
    const fake = list.map((x) => AgentInfo.parse(x)).find((x) => x.kind === 'fake');
    if (fake) expect(fake.permissionLevels).toEqual(['readonly', 'ask', 'workspace', 'full']);
    const p = (await t!.api('POST', '/profiles', { token, body: { agent: 'claude', name: 'K', kind: 'apiKey', apiKey: KEY } })).json as AgentProfile;
    const del = await t!.api('DELETE', `/profiles/${p.id}`, { token });
    expect(DeleteProfileResult.parse(del.json)).toEqual({ ok: true, keptDir: false });
  });
});
