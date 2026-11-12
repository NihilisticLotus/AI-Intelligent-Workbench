// Gateway 集成测试（phase-1.md 6.8）：把假 ACP Agent 进程注册成真实形态的适配器，经 WebSocket 走完
// “建任务 → 对话 → 审批 → 换模型 → 崩溃 → 恢复”，断言事件序列和 1.1 的契约一致。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpecAdapter, isAlive } from '@aic/adapters';
import { ErrorCode, ServerFrame, type Approval, type EventEnvelope, type Task } from '@aic/protocol';
import { MemorySecretStore } from '../src/secrets';
import { makeProject, startGw, WsClient, type TestGw } from './helpers';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../adapters/test/fixtures/fake-acp-agent.mjs');
const text = (t: string) => ({ type: 'text', text: t });
const MODELS = [{ value: 'alpha', name: 'Alpha' }, { value: 'beta', name: 'Beta' }];
const MODES = [{ value: 'plan', name: 'Plan' }, { value: 'default', name: 'Default' }, { value: 'bypassPermissions', name: 'Bypass' }];
const CONFIG = { models: MODELS, modes: MODES, currentMode: 'default', efforts: { alpha: ['low', 'high'], beta: ['medium', 'xhigh'] }, currentEffort: 'low' };

function scenario(sc: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aic-gw-acp-'));
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

async function setup(sc: Sc, extra: Parameters<typeof startGw>[0] = {}) {
  cleanups.push(sc.cleanup);
  t = await startGw({
    secretStore: new MemorySecretStore(),
    adapters: (rt) => [createSpecAdapter({ kind: 'claude', displayName: '假 Claude', entry: FIXTURE, env: sc.env }, rt)],
    ...extra,
  });
  const token = await t.pair();
  const project = await makeProject(t, token);
  ws = await WsClient.connect(t.port, token);
  await ws.call({ op: 'subscribe', data: { lastSeq: 0 } });
  return { token, projectId: project.id, gw: t, ws };
}

const statusIs = (taskId: string, s: string) => (e: EventEnvelope) => e.type === 'task.updated' && e.taskId === taskId && (e.data as { task: Task }).task.status === s;

const PERM = (id: string) => ({
  steps: [
    { update: { sessionUpdate: 'agent_thought_chunk', content: text('想一想') } },
    { update: { sessionUpdate: 'agent_message_chunk', content: text('我先跑一下测试。') } },
    { update: { sessionUpdate: 'tool_call', toolCallId: id, title: '执行 npm test', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } } },
    {
      permission: {
        toolCall: { toolCallId: id, title: '执行 npm test', kind: 'execute', rawInput: { command: 'npm test' } },
        options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Yes' }, { optionId: 'allow-always', kind: 'allow_always', name: 'Always' }, { optionId: 'reject', kind: 'reject_once', name: 'No' }],
      },
      then: {
        allow: [{ update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: text('12 passed') }] } }, { update: { sessionUpdate: 'agent_message_chunk', content: text('测试通过。') } }],
        reject: [{ update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed' } }, { update: { sessionUpdate: 'agent_message_chunk', content: text('好的，不跑了。') } }],
      },
    },
    { update: { sessionUpdate: 'usage_update', used: 5000, size: 200000 } },
  ],
});

describe('真实形态的 Agent（假 ACP 进程）', () => {
  it('Codex 压缩后代理拒绝正文：暂停、保留原文并发布实际账号失败标记', async () => {
    const upstream = "CC Switch local proxy failed while handling Codex endpoint /responses. Provider: OpenAI Official; model: alpha; upstream_status: HTTP 400; cause: The 'alpha' model is not supported when using Codex with a ChatGPT account.";
    const sc = scenario({ config: CONFIG, turns: [{ steps: [
      { update: { sessionUpdate: 'tool_call', toolCallId: 'compact', kind: 'think', title: 'Compact conversation' } },
      { update: { sessionUpdate: 'agent_message_chunk', content: text(upstream) } },
    ] }] });
    const { token, projectId, ws } = await setup(sc, { adapters: rt => [createSpecAdapter({ kind: 'codex', displayName: '假 Codex', entry: FIXTURE, env: sc.env }, rt)] });
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: '合成代理拒绝回归', agent: 'codex', permission: 'readonly' } })).json as Task;
    await ws.waitEvent(statusIs(task.id, 'paused'), 10_000);
    const events = ws.events().filter(e => e.taskId === task.id);
    expect(events.some(e => e.type === 'task.updated' && e.data.task.status === 'review')).toBe(false);
    expect(events.filter(e => e.type === 'message.delta').map(e => e.data.text).join('')).toBe(upstream);
    expect(events.find(e => e.type === 'error')?.data.error.code).toBe(ErrorCode.AgentFailed);
    const profileId = t!.gw.services.profiles.defaultRow('codex').id;
    expect(t!.gw.services.db.get('SELECT profile_id,model FROM model_failures WHERE agent=?', 'codex')).toEqual({ profile_id: profileId, model: 'alpha' });
    const info = (await t!.api('GET', '/agents', { token })).json.items.find((a: { kind: string }) => a.kind === 'codex');
    expect(info.modelFailures).toEqual([expect.objectContaining({ profileId, model: 'alpha' })]);
    expect(sc.log().filter(l => l.method === 'session/prompt')).toHaveLength(1);
  });
  it('上游正文拒绝默认模型：暂停、保留原文，并按实际模型和账号发布失败标记', async () => {
    const upstream = "The 'alpha' model is not supported when using Codex with a ChatGPT account";
    const sc = scenario({ config: CONFIG, turns: [{ steps: [{ update: { sessionUpdate: 'agent_message_chunk', content: text(upstream) } }] }] });
    const { token, projectId, ws } = await setup(sc);
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: '合成失败回归', agent: 'claude', permission: 'readonly' } })).json as Task;
    await ws.waitEvent(statusIs(task.id, 'paused'), 10_000);
    const events = ws.events().filter((e) => e.taskId === task.id);
    expect(events.some((e) => e.type === 'task.updated' && e.data.task.status === 'review')).toBe(false);
    expect(events.filter((e) => e.type === 'message.delta').map((e) => e.data.text).join('')).toBe(upstream);
    expect(events.find((e) => e.type === 'error')?.data.error.code).toBe(ErrorCode.AgentFailed);
    const profileId = t!.gw.services.profiles.defaultRow('claude').id;
    const failure = t!.gw.services.db.get('SELECT profile_id,model,reason FROM model_failures WHERE agent=?', 'claude');
    expect(failure).toMatchObject({ profile_id: profileId, model: 'alpha' });
    const agents = (await t!.api('GET', '/agents', { token })).json.items;
    expect(agents.find((a: { kind: string }) => a.kind === 'claude').modelFailures).toEqual([expect.objectContaining({ profileId, model: 'alpha', reason: expect.stringContaining('not supported') })]);
    expect(sc.log().filter((l) => l.method === 'session/prompt')).toHaveLength(1);
  });

  it('会话内切换被上游拒绝：保留原模型，并将失败标记归到实际账号', async () => {
    const sc = scenario({ config: CONFIG, setErrors: { 'model:beta': { code: -32602, message: 'Invalid model: beta' } } });
    const { token, projectId, ws } = await setup(sc);
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: '合成切换失败', agent: 'claude', permission: 'readonly' } })).json as Task;
    await ws.waitEvent(statusIs(task.id, 'review'), 10_000);
    const result = await ws.call({ op: 'switch', data: { taskId: task.id, model: 'beta' } });
    expect(result.ok).toBe(false);
    expect(t!.gw.services.tasks.get(task.id)).toMatchObject({ model: 'alpha', status: 'review' });
    const profileId = t!.gw.services.profiles.defaultRow('claude').id;
    expect(t!.gw.services.db.get('SELECT profile_id,model FROM model_failures WHERE agent=?', 'claude')).toEqual({ profile_id: profileId, model: 'beta' });
    const info = (await t!.api('GET', '/agents', { token })).json.items.find((a: { kind: string }) => a.kind === 'claude');
    expect(info.modelFailures).toEqual([expect.objectContaining({ profileId, model: 'beta' })]);
    expect(sc.log().filter((l) => l.method === 'session/prompt')).toHaveLength(1);
  });

  it('模型切换成功但强度被拒绝，不把新模型标成不支持', async () => {
    const sc = scenario({ config: CONFIG, setErrors: { 'effort:xhigh': { code: -32602, message: 'Invalid effort: xhigh' } } });
    const { token, projectId, ws } = await setup(sc);
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: '合成强度失败', agent: 'claude', permission: 'readonly' } })).json as Task;
    await ws.waitEvent(statusIs(task.id, 'review'), 10_000);
    const result = await ws.call({ op: 'switch', data: { taskId: task.id, model: 'beta', effort: 'xhigh' } });
    expect(result.ok).toBe(false);
    expect(t!.gw.services.tasks.get(task.id).model).toBe('beta');
    expect(t!.gw.services.db.all('SELECT * FROM model_failures')).toEqual([]);
    expect(sc.log().filter((l) => l.method === 'session/prompt')).toHaveLength(1);
  });

  it('额度正文只暂停，不把仍可用的模型标成不支持', async () => {
    const sc = scenario({ config: CONFIG, turns: [{ steps: [{ update: { sessionUpdate: 'agent_message_chunk', content: text('API Error: Request rejected (429) · upstream account quota usage limit has been reached') } }] }] });
    const { token, projectId, ws } = await setup(sc);
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: '合成额度回归', agent: 'claude', permission: 'readonly' } })).json as Task;
    await ws.waitEvent(statusIs(task.id, 'paused'), 10_000);
    expect(ws.events().find((e) => e.taskId === task.id && e.type === 'error')?.data).toMatchObject({ error: { code: ErrorCode.AgentQuotaExceeded } });
    expect(t!.gw.services.db.all('SELECT * FROM model_failures')).toEqual([]);
    expect(sc.log().filter((l) => l.method === 'session/prompt')).toHaveLength(1);
  });

  it('假 ACP sleep 不发事件时提醒并发送 session/cancel', async () => {
    const sc=scenario({config:CONFIG,turns:[{steps:[{sleep:60_000}]}]});
    const {projectId,gw}=await setup(sc,{noResponseNoticeMs:100,noResponseCancelMs:300});
    const task=await gw.gw.services.tasks.create({projectId,agent:'claude',prompt:'等待',permission:'ask'});
    await vi.waitFor(()=>expect(gw.gw.services.tasks.get(task.id).status).toBe('paused'),{timeout:5000});
    const events=gw.gw.services.events.read({after:0,taskId:task.id,limit:1000});
    expect(events.some((e)=>e.type==='session.notice'&&!!e.data.id)).toBe(true);
    expect(events.some((e)=>e.type==='error'&&e.data.error.code==='agent.no_response')).toBe(true);
    await vi.waitFor(()=>expect(sc.log().some((r)=>r.method==='session/cancel')).toBe(true));
  });
  it('长时间无输出的并行工具不被无回应看门狗误停，结束后恢复计时', async () => {
    const sc = scenario({ config: CONFIG, turns: [{ steps: [
      { update: { sessionUpdate: 'tool_call', toolCallId: 'long-a', title: '静默构建 A', kind: 'execute', status: 'in_progress' } },
      { update: { sessionUpdate: 'tool_call', toolCallId: 'long-b', title: '静默构建 B', kind: 'execute', status: 'in_progress' } },
      { sleep: 500 },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 'long-a', status: 'completed' } },
      { sleep: 500 },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 'long-b', status: 'completed' } },
      { waitCancel: true },
    ] }] });
    const { projectId, gw, ws } = await setup(sc, { noResponseNoticeMs: 100, noResponseCancelMs: 300 });
    const task = await gw.gw.services.tasks.create({ projectId, agent: 'claude', prompt: '离线长工具回归', permission: 'ask' });
    const second = await ws.waitEvent((e) => e.taskId === task.id && e.type === 'tool.start' && e.data.title === '静默构建 B', 5000);
    const first = ws.events().find((e) => e.taskId === task.id && e.type === 'tool.start' && e.data.title === '静默构建 A');
    if (first?.type !== 'tool.start' || second.type !== 'tool.start') throw new Error('缺少长工具启动事件');
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(gw.gw.services.tasks.get(task.id).status).toBe('running');
    const during = ws.events().filter((e) => e.taskId === task.id);
    expect(during.some((e) => e.type === 'tool.end' && e.data.toolId === first.data.toolId)).toBe(true);
    expect(during.some((e) => e.type === 'error' || e.type === 'session.notice' && !!e.data.id)).toBe(false);
    expect(sc.log().some((entry) => entry.method === 'session/cancel')).toBe(false);
    await ws.waitEvent((e) => e.taskId === task.id && e.type === 'tool.end' && e.data.toolId === second.data.toolId, 5000);
    await ws.waitEvent(statusIs(task.id, 'paused'), 5000);
    expect(ws.events().some((e) => e.taskId === task.id && e.type === 'error' && e.data.error.code === ErrorCode.AgentNoResponse)).toBe(true);
    await vi.waitFor(() => expect(sc.log().some((entry) => entry.method === 'session/cancel')).toBe(true));
  });
  it('静默工具仍可手动停止，下一回合不会继承工具的计时豁免', async () => {
    const sc = scenario({ config: CONFIG, turns: [
      { steps: [{ update: { sessionUpdate: 'tool_call', toolCallId: 'stop-me', title: '等待停止的工具', kind: 'execute', status: 'in_progress' } }, { waitCancel: true }] },
      { steps: [{ waitCancel: true }] },
    ] });
    const { projectId, gw, ws } = await setup(sc, { noResponseNoticeMs: 100, noResponseCancelMs: 300 });
    const task = await gw.gw.services.tasks.create({ projectId, agent: 'claude', prompt: '取消长工具', permission: 'ask' });
    await ws.waitEvent((e) => e.taskId === task.id && e.type === 'tool.start', 5000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(gw.gw.services.tasks.get(task.id).status).toBe('running');
    await gw.gw.services.tasks.cancel(task.id); await gw.gw.services.tasks.idle();
    expect(gw.gw.services.tasks.get(task.id).status).toBe('paused');
    expect(ws.events().some((e) => e.taskId === task.id && e.type === 'error')).toBe(false);
    await gw.gw.services.tasks.prompt(task.id, '下一回合静默');
    await vi.waitFor(() => expect(gw.gw.services.tasks.get(task.id).status).toBe('paused'), { timeout: 5000 });
    const errors = gw.gw.services.events.read({ after: 0, taskId: task.id, limit: 1000 }).filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1); expect(errors[0]!.data.error.code).toBe(ErrorCode.AgentNoResponse);
    await vi.waitFor(() => expect(sc.log().filter((entry) => entry.method === 'session/cancel')).toHaveLength(2));
  });
  it('建任务 → 对话 → 审批 → 换模型 → 崩溃 → 恢复', async () => {
    const sc = scenario({ config: CONFIG, persistTurns: true, turns: [PERM('c1'), { steps: [{ sleep: 100 }, { crash: 1 }] }, { steps: [{ update: { sessionUpdate: 'agent_message_chunk', content: text('我回来了') } }] }] });
    const { token, projectId, ws } = await setup(sc);

    // GET /agents：真实形态的 Agent 带账号概要
    const agents = (await t!.api('GET', '/agents', { token })).json.items as { kind: string; profiles?: unknown[]; status: string }[];
    expect(agents.map((a) => a.kind)).toEqual(['fake', 'claude', 'independent']);
    expect(agents[1]!.profiles).toHaveLength(1);
    expect(agents[1]!.status).toBe('ready');

    const r = await t!.api('POST', '/tasks', { token, body: { projectId, prompt: '跑一下测试', agent: 'claude', permission: 'ask' } });
    expect(r.status).toBe(201);
    const task = r.json as Task;
    expect(task.model).toBeNull();

    const req = await ws.waitEvent((e) => e.type === 'approval.requested' && e.taskId === task.id, 10_000);
    const approval = (req.data as { approval: Approval }).approval;
    expect(approval.options.map((o) => o.id)).toEqual(['allow-once', 'reject']);
    expect(approval.detail).toBe('npm test');
    await ws.waitEvent(statusIs(task.id, 'waiting'));
    expect((await ws.call({ op: 'approve', data: { approvalId: approval.id, optionId: 'allow-once' } })).ok).toBe(true);
    await ws.waitEvent(statusIs(task.id, 'review'), 10_000);
    expect(sc.log().find((l) => l.event === 'permission_response')!.response).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });

    const evs = () => ws.events().filter((e) => e.taskId === task.id);
    const types = evs().map((e) => e.type);
    expect(types).toContain('session.started');
    expect(types.indexOf('session.started')).toBeLessThan(types.indexOf('session.config'));
    expect(types).toContain('thought.delta');
    expect(types).toContain('session.usage');
    const started = evs().find((e) => e.type === 'session.started')!;
    expect(started.data).toMatchObject({ agent: 'claude', resumed: false });
    const cfg = evs().filter((e) => e.type === 'session.config').at(-1)!;
    expect(cfg.data).toMatchObject({ model: 'alpha', effort: 'low', agentMode: 'default', efforts: ['low', 'high'] });
    expect((cfg.data as { models: { id: string }[] }).models.map((m) => m.id)).toEqual(['alpha', 'beta']);
    // 任务记录跟着 Agent 的实际配置更新
    expect((await t!.api('GET', `/tasks/${task.id}`, { token })).json).toMatchObject({ model: 'alpha', effort: 'low' });
    // 模型列表进了能力缓存
    const ag = (await t!.api('GET', '/agents', { token })).json.items.find((a: { kind: string }) => a.kind === 'claude');
    expect(ag.models.map((m: { id: string }) => m.id)).toEqual(['alpha', 'beta']);
    expect(ag.caps).toMatchObject({ resume: true, modelSwitch: 'configOption' });

    // 换模型（H0）：强度不在新列表里时改用 currentValue 并提示
    const sw = await ws.call({ op: 'switch', data: { taskId: task.id, model: 'beta' } });
    expect(sw.ok).toBe(true);
    expect((sw.result as { task: Task }).task).toMatchObject({ model: 'beta', effort: 'medium' });
    await ws.waitEvent((e) => e.type === 'session.notice' && e.taskId === task.id);
    // 非法值：ack 失败，保留原值
    const bad = await ws.call({ op: 'switch', data: { taskId: task.id, effort: 'low' } });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe(ErrorCode.BadRequest);
    expect((await t!.api('GET', `/tasks/${task.id}`, { token })).json).toMatchObject({ model: 'beta', effort: 'medium' });

    // 崩溃：回合中进程退出 → agent.crashed、任务“已中断”
    expect((await ws.call({ op: 'prompt', data: { taskId: task.id, text: '继续' } })).ok).toBe(true);
    const err = await ws.waitEvent((e) => e.type === 'error' && e.taskId === task.id, 10_000);
    expect((err.data as { error: { code: string; actions: { action: string; args?: Record<string, unknown> }[] } }).error).toMatchObject({ code: 'agent.crashed' });
    expect((err.data as { error: { actions: { args?: Record<string, unknown> }[] } }).error.actions[0]!.args).toMatchObject({ taskId: task.id });
    await ws.waitEvent(statusIs(task.id, 'interrupted'));
    await ws.waitEvent((e) => e.type === 'session.ended' && e.taskId === task.id);

    // 下一条消息：自动恢复原来的会话（session/resume），重新下发模型
    expect((await ws.call({ op: 'prompt', data: { taskId: task.id, text: '再来' } })).ok).toBe(true);
    await ws.waitEvent((e) => statusIs(task.id, 'review')(e) && e.seq > err.seq, 10_000);
    const resumed = evs().filter((e) => e.type === 'session.started').at(-1)!;
    expect(resumed.data).toMatchObject({ resumed: true });
    expect(sc.log().find((l) => l.method === 'session/resume')!.params).toMatchObject({ sessionId: 'sess-1' });
    expect(sc.log().filter((l) => l.method === 'session/set_config_option' && l.params.configId === 'model').at(-1)!.params.value).toBe('beta');
    const text2 = evs().filter((e) => e.type === 'message.delta').map((e) => (e.data as { text: string }).text).join('');
    expect(text2).toContain('我回来了');

    // 所有服务端帧都符合协议
    for (const f of ws.frames) expect(ServerFrame.safeParse(f).success).toBe(true);
  });

  it('只读：自动拒绝，不弹卡片，记为 tool.end rejected', async () => {
    const sc = scenario({ config: CONFIG, turns: [PERM('c1')] });
    const { token, projectId, ws } = await setup(sc);
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'x', agent: 'claude', permission: 'readonly' } })).json as Task;
    await ws.waitEvent(statusIs(task.id, 'review'), 10_000);
    const evs = ws.events().filter((e) => e.taskId === task.id);
    expect(evs.some((e) => e.type === 'approval.requested')).toBe(false);
    expect(evs.find((e) => e.type === 'tool.end')!.data).toMatchObject({ ok: false, rejected: true });
    expect(sc.log().find((l) => l.method === 'session/set_config_option' && l.params.configId === 'mode')!.params.value).toBe('plan');
  });

  it('真实 Agent 只开放“只读”和“需审批”', async () => {
    const sc = scenario({});
    const { token, projectId } = await setup(sc);
    const r = await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'x', agent: 'claude', permission: 'full' } });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(ErrorCode.PermissionLevelUnavailable);
    const ok = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'x', agent: 'claude', permission: 'ask' } })).json as Task;
    const p = await t!.api('PATCH', `/tasks/${ok.id}`, { token, body: { permission: 'workspace' } });
    expect(p.json.code).toBe(ErrorCode.PermissionLevelUnavailable);
    // 演示 Agent 不受影响
    expect((await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'x', agent: 'fake', permission: 'full' } })).status).toBe(201);
  });

  it('登录失效：任务暂停，agent.status 变为需要登录', async () => {
    const sc = scenario({ newError: { code: -32000, message: 'Authentication required', data: { category: 'auth' } } });
    const { token, projectId, ws } = await setup(sc);
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'x', agent: 'claude' } })).json as Task;
    const err = await ws.waitEvent((e) => e.type === 'error' && e.taskId === task.id, 10_000);
    expect((err.data as { error: { code: string } }).error.code).toBe(ErrorCode.AgentAuthRequired);
    await ws.waitEvent(statusIs(task.id, 'paused'));
    const st = await ws.waitEvent((e) => e.type === 'agent.status' && (e.data as { agent: { kind: string; status: string } }).agent.kind === 'claude' && (e.data as { agent: { status: string } }).agent.status === 'needs_login');
    expect(st).toBeTruthy();
    // 再建任务：直接提示去登录
    const r2 = await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'y', agent: 'claude' } });
    expect(r2.status).toBe(503);
    expect(r2.json.actions[0]).toMatchObject({ label: '去登录' });
  });

  it('额度错误：任务暂停，带“换模型”“换账号”', async () => {
    const sc = scenario({ turns: [{ steps: [{ error: { code: -32603, message: 'Usage limit reached' } }] }] });
    const { token, projectId, ws } = await setup(sc);
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'x', agent: 'claude' } })).json as Task;
    const err = await ws.waitEvent((e) => e.type === 'error' && e.taskId === task.id, 10_000);
    const body = (err.data as { error: { code: string; actions: { label: string }[] } }).error;
    expect(body.code).toBe(ErrorCode.AgentQuotaExceeded);
    expect(body.actions.map((a) => a.label)).toEqual(['换模型', '换账号']);
    await ws.waitEvent(statusIs(task.id, 'paused'));
  });

  it('审批超时：回 cancelled，任务暂停', async () => {
    const sc = scenario({ turns: [PERM('c1')] });
    const { token, projectId, ws } = await setup(sc, { approvalTimeoutMs: 300 });
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'x', agent: 'claude' } })).json as Task;
    const res = await ws.waitEvent((e) => e.type === 'approval.resolved' && e.taskId === task.id, 10_000);
    expect(res.data).toMatchObject({ status: 'expired' });
    // 审批超时：本轮结束后任务暂停（不进入待验收），并提示（审查第 7 条）
    await ws.waitEvent(statusIs(task.id, 'paused'), 10_000);
    expect(ws.events().some((e) => e.type === 'session.notice' && e.taskId === task.id && /审批超时/.test((e.data as { text: string }).text))).toBe(true);
    expect(sc.log().find((l) => l.event === 'permission_response')!.response).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('取消：发 session/cancel，任务暂停', async () => {
    const sc = scenario({ turns: [{ steps: [{ update: { sessionUpdate: 'agent_message_chunk', content: text('开始') } }, { waitCancel: true }] }] });
    const { token, projectId, ws } = await setup(sc);
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'x', agent: 'claude' } })).json as Task;
    await ws.waitEvent((e) => e.type === 'message.delta' && e.taskId === task.id, 10_000);
    await ws.call({ op: 'cancel', data: { taskId: task.id } });
    await ws.waitEvent(statusIs(task.id, 'paused'), 10_000);
    expect(sc.log().some((l) => l.method === 'session/cancel')).toBe(true);
  });

  it('空闲回收：关闭进程，下一条消息时恢复；并发上限满时排队', async () => {
    const sc = scenario({ config: CONFIG });
    const { token, projectId, ws } = await setup(sc, { idleTimeoutMs: 1200 });
    await t!.api('PATCH', '/agents/claude', { token, body: { concurrencyLimit: 1 } });
    const a = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'a', agent: 'claude' } })).json as Task;
    await ws.waitEvent(statusIs(a.id, 'review'), 10_000);
    // 第二个任务：名额被第一个任务的会话占着 → 排队
    const b = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'b', agent: 'claude' } })).json as Task;
    await ws.waitEvent(statusIs(b.id, 'queued'), 5000);
    // 第一个任务空闲回收后，第二个任务开始
    await ws.waitEvent((e) => e.type === 'session.ended' && e.taskId === a.id && (e.data as { reason: string }).reason === 'idle', 10_000);
    await ws.waitEvent(statusIs(b.id, 'review'), 10_000);
    await ws.waitEvent((e) => e.type === 'session.ended' && e.taskId === b.id, 10_000);
    // 第一个任务再发消息：恢复原来的会话
    await ws.call({ op: 'prompt', data: { taskId: a.id, text: 'again' } });
    await ws.waitEvent((e) => e.type === 'session.started' && e.taskId === a.id && (e.data as { resumed?: boolean }).resumed === true, 10_000);
  });

  it('Gateway 退出后 Agent 和它的子进程都不在', async () => {
    const sc = scenario({ grandchild: true, stubborn: true });
    const { token, projectId, ws } = await setup(sc, { agentTimeouts: { closeGrace: 300, killGrace: 300 } });
    const task = (await t!.api('POST', '/tasks', { token, body: { projectId, prompt: 'x', agent: 'claude' } })).json as Task;
    await ws.waitEvent(statusIs(task.id, 'review'), 10_000);
    const pid = sc.log().find((l) => l.event === 'start')!.pid as number;
    const gpid = sc.log().find((l) => l.event === 'grandchild')!.pid as number;
    expect(isAlive(pid) && isAlive(gpid)).toBe(true);
    await ws.close();
    await t!.stop();
    t = null;
    const until = Date.now() + 8000;
    while ((isAlive(pid) || isAlive(gpid)) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    expect(isAlive(pid)).toBe(false);
    expect(isAlive(gpid)).toBe(false);
  });

  it('[重新检测]：已登录的 Agent 即使不自动探测也做一次探测会话，未登录的不探测', async () => {
    const sc = scenario({ config: CONFIG });
    const sc2 = scenario({ config: CONFIG });
    cleanups.push(sc.cleanup, sc2.cleanup);
    t = await startGw({
      secretStore: new MemorySecretStore(),
      adapters: (rt) => [
        createSpecAdapter({ kind: 'codex', displayName: '假 Codex', entry: FIXTURE, env: sc.env, autoProbe: false }, rt),
        createSpecAdapter({ kind: 'codebuddy', displayName: '假 CodeBuddy', entry: FIXTURE, env: sc2.env, autoProbe: false, detect: { loggedIn: false } }, rt),
      ],
    });
    const token = await t.pair();
    const before = (await t.api('GET', '/agents', { token })).json.items as { kind: string; modelsSource?: string }[];
    expect(before.find((a) => a.kind === 'codex')!.modelsSource).toBe('none');
    await t.api('POST', '/agents/redetect', { token, body: {} });
    const until = Date.now() + 10_000;
    let codex: { models: { id: string }[]; modelsSource?: string } | undefined;
    while (Date.now() < until) {
      codex = (await t.api('GET', '/agents', { token })).json.items.find((a: { kind: string }) => a.kind === 'codex');
      if (codex?.models.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(codex!.models.map((m) => m.id)).toEqual(['alpha', 'beta']);
    expect(codex!.modelsSource).toBe('cache');
    expect(sc2.log().some((l) => l.method === 'session/new')).toBe(false);
  });

  it('启动时结束上次遗留的 Agent 进程（核对启动时间）', async () => {
    const sc = scenario({});
    const { gw } = await setup(sc);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const startedAt = Date.now();
    try {
      // 记录一个遗留进程，再加一个 pid 被复用的（启动时间对不上）
      gw.gw.services.db.run('INSERT INTO agent_processes (pid, created_at, agent, session_id) VALUES (?, ?, ?, NULL)', child.pid!, String(startedAt), 'claude');
      gw.gw.services.db.run('INSERT INTO agent_processes (pid, created_at, agent, session_id) VALUES (?, ?, ?, NULL)', process.pid, String(startedAt - 3600_000), 'codex');
      const killed = await gw.gw.services.processes.cleanupOrphans();
      if (process.platform === 'win32') {
        expect(killed).toBe(1);
        const until = Date.now() + 5000;
        while (isAlive(child.pid!) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
        expect(isAlive(child.pid!)).toBe(false);
      }
      expect(isAlive(process.pid)).toBe(true);
      expect(gw.gw.services.db.all('SELECT * FROM agent_processes')).toHaveLength(0);
    } finally { child.kill(); }
  });
});
