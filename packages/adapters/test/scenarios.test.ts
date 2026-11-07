// 契约测试（续）：审批、非标准 kind、切换、模式漂移、崩溃、孙进程、卡死、噪音、登录失效、额度、恢复。
import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionLevel } from '@aic/protocol';
import { AgentError, isAlive, type AgentConnection } from '../src/index';
import { fakeAdapter, LogSink, MODELS, MODES, RecordingHost, scenario, waitFor, type Scenario } from './helpers';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
function use(sc: Scenario) { cleanups.push(() => sc.cleanup()); return sc; }
function track(c: AgentConnection) { cleanups.push(() => c.close()); return c; }

const text = (t: string) => ({ type: 'text', text: t });
const sig = () => new AbortController().signal;

async function open(sc: Scenario, o: { permission?: PermissionLevel; model?: string | null; effort?: string | null; resume?: string; log?: LogSink; timeouts?: Record<string, number>; host?: RecordingHost; env?: Record<string, string>; redact?: string[] } = {}) {
  const host = o.host ?? new RecordingHost();
  const a = fakeAdapter(sc, { ...(o.log ? { log: o.log } : {}), ...(o.timeouts ? { timeouts: o.timeouts } : {}) });
  const conn = track(await a.spawn({
    cwd: sc.dir, model: o.model ?? null, effort: o.effort ?? null, permission: o.permission ?? 'ask', host, sessionLabel: 's_test',
    ...(o.resume ? { resume: { agentSessionId: o.resume } } : {}), ...(o.env ? { env: o.env } : {}), ...(o.redact ? { redact: o.redact } : {}),
  }));
  conn.ready?.();
  return { host, conn, adapter: a };
}

const permTurn = (options: unknown[], id = 'c1') => ({
  steps: [
    { update: { sessionUpdate: 'tool_call', toolCallId: id, title: '执行 npm test', kind: 'execute', status: 'pending', rawInput: { command: 'npm test', description: '跑测试' } } },
    {
      permission: { toolCall: { toolCallId: id, title: '执行 npm test', kind: 'execute', rawInput: { command: 'npm test', description: '跑测试' } }, options },
      then: {
        allow: [{ update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' } }],
        reject: [{ update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed' } }],
      },
    },
  ],
});
const STD_OPTIONS = [
  { optionId: 'allow-once', kind: 'allow_once', name: 'Yes' },
  { optionId: 'allow-with-updates', kind: 'allow_always', name: "Yes, and don't ask again" },
  { optionId: 'reject', kind: 'reject_once', name: 'No' },
];

describe('permission：审批桥接', () => {
  it('隐藏“总是”类选项；回传原始 optionId；拒绝后 tool_end rejected', async () => {
    const sc = use(scenario({ turns: [permTurn(STD_OPTIONS), permTurn(STD_OPTIONS, 'c2')] }));
    const { host, conn } = await open(sc);
    await conn.prompt({ text: '跑测试' }, sig());
    const req = host.requests[0]!;
    expect(req.options).toEqual([{ id: 'allow-once', label: '允许', kind: 'allow_once' }, { id: 'reject', label: '拒绝', kind: 'reject_once' }]);
    expect(req).toMatchObject({ title: '执行 npm test', detail: 'npm test', reason: '跑测试', cwd: sc.dir });
    expect(sc.log().find((l) => l.event === 'permission_response')!.response).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(host.of('tool_end')[0]).toMatchObject({ ok: true });

    host.decide = async (r) => ({ outcome: 'selected', optionId: r.options.find((o) => o.kind === 'reject_once')!.id });
    await conn.prompt({ text: '再来' }, sig());
    expect(host.of('tool_end')[1]).toMatchObject({ ok: false, rejected: true });
  });

  it('没有 allow_once 时保留 allow_always（例如退出计划模式）', async () => {
    const sc = use(scenario({ turns: [permTurn([{ optionId: 'exit-plan-auto', kind: 'allow_always', name: 'Yes, auto' }, { optionId: 'reject', kind: 'reject_once', name: 'No' }])] }));
    const { host, conn } = await open(sc);
    await conn.prompt({ text: 'x' }, sig());
    expect(host.requests[0]!.options.map((o) => o.id)).toEqual(['exit-plan-auto', 'reject']);
  });

  it('用户取消（审批作废）时回 cancelled', async () => {
    const sc = use(scenario({ turns: [permTurn(STD_OPTIONS)] }));
    const host = new RecordingHost();
    host.decide = async () => ({ outcome: 'cancelled' });
    const { conn } = await open(sc, { host });
    await conn.prompt({ text: 'x' }, sig());
    expect(sc.log().find((l) => l.event === 'permission_response')!.response).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(host.of('tool_end')[0]).toMatchObject({ ok: false, rejected: true });
  });
});

describe('nonstandard-kinds：CodeBuddy 式的 allow / reject', () => {
  it('能接收并归一化', async () => {
    const sc = use(scenario({ turns: [permTurn([{ optionId: 'allow_once', kind: 'allow', name: 'Allow' }, { optionId: 'allow_session', kind: 'allow', name: 'Allow for session' }, { optionId: 'deny', kind: 'reject', name: 'Deny' }])] }));
    const { host, conn } = await open(sc);
    await conn.prompt({ text: 'x' }, sig());
    expect(host.requests[0]!.options).toEqual([{ id: 'allow_once', label: '允许', kind: 'allow_once' }, { id: 'deny', label: '拒绝', kind: 'reject_once' }]);
    expect(host.requests[0]!.title).toBe('执行 npm test');
  });

  it('全是未知 kind 时自动拒绝，不弹卡片', async () => {
    const sc = use(scenario({ turns: [permTurn([{ optionId: 'a', kind: 'weird', name: 'A' }, { optionId: 'b', kind: 'reject', name: 'B' }].slice(0, 1).concat([{ optionId: 'r', kind: 'reject', name: 'R' }]).map((o) => (o.kind === 'reject' ? { ...o, kind: 'nope' } : o)))] }));
    const log = new LogSink();
    const { host, conn } = await open(sc, { log });
    await conn.prompt({ text: 'x' }, sig());
    expect(host.requests).toHaveLength(0);
    expect(sc.log().find((l) => l.event === 'permission_response')!.response).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(host.of('notice').some((n) => n.text.includes('自动拒绝'))).toBe(true);
    expect(log.text()).toContain('未知的审批选项 kind');
  });

  it('CodeBuddy 的请求没有 title：用 _meta 里的工具名', async () => {
    const sc = use(scenario({ turns: [{ steps: [{ permission: { toolCall: { toolCallId: 'c9', rawInput: { command: 'dir' }, _meta: { 'codebuddy.ai/toolName': 'Bash' } }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] } }] }] }));
    const { host, conn } = await open(sc);
    await conn.prompt({ text: 'x' }, sig());
    expect(host.requests[0]!.title).toBe('假 Agent 请求使用工具：Bash');
    expect(host.requests[0]!.detail).toBe('dir');
    // 权限请求里的工具没见过：先补一条 tool_start
    expect(host.of('tool_start')[0]!.title).toBe('工具调用');
  });
});

const SWITCH_CFG = { models: MODELS, modes: MODES, currentMode: 'default', efforts: { alpha: ['low', 'medium', 'high'], beta: ['medium', 'xhigh'] }, currentEffort: 'low' };

describe('switch：换模型和思考强度', () => {
  it('set_config_option 返回全量配置；强度失效时改用 currentValue 并提示；非法值保留原值', async () => {
    const sc = use(scenario({ config: SWITCH_CFG }));
    const { host, conn } = await open(sc);
    expect(conn.config!()).toMatchObject({ model: 'alpha', effort: 'low', efforts: ['low', 'medium', 'high'], models: [{ id: 'alpha', name: 'Alpha', contextWindow: null }, { id: 'beta', name: 'Beta', contextWindow: null }] });
    await conn.setConfig({ model: 'beta' });
    expect(conn.config!()).toMatchObject({ model: 'beta', effort: 'medium', efforts: ['medium', 'xhigh'] });
    expect(host.of('notice').map((n) => n.text)).toContain('新模型不支持思考强度“low”，已改为“medium”');
    expect(host.of('config_options').at(-1)!.state).toMatchObject({ model: 'beta', effort: 'medium' });
    await conn.setConfig({ effort: 'xhigh' });
    expect(conn.config!().effort).toBe('xhigh');

    const e1 = await conn.setConfig({ model: 'nope' }).catch((e) => e);
    expect(e1).toBeInstanceOf(AgentError);
    expect(e1.body).toMatchObject({ code: 'request.invalid' });
    expect(e1.body.hint).toContain('Invalid value');
    const e2 = await conn.setConfig({ effort: 'low' }).catch((e) => e);
    expect(e2.body.hint).toContain('does not support low');
    expect(conn.config!()).toMatchObject({ model: 'beta', effort: 'xhigh' });
  });

  it('建会话时下发任务保存的模型和强度', async () => {
    const sc = use(scenario({ config: SWITCH_CFG }));
    const { conn } = await open(sc, { model: 'beta', effort: 'xhigh' });
    expect(conn.config!()).toMatchObject({ model: 'beta', effort: 'xhigh' });
  });

  it('只有 models 旧字段时走 session/set_model', async () => {
    const sc = use(scenario({ legacy: true, config: { models: MODELS } }));
    const { conn } = await open(sc);
    expect(conn.caps!.modelSwitch).toBe('unstableSetModel');
    expect(conn.config!().efforts).toBeNull();
    await conn.setConfig({ model: 'beta' });
    expect(sc.log().find((l) => l.method === 'session/set_model')!.params).toMatchObject({ modelId: 'beta' });
    expect(conn.config!().model).toBe('beta');
  });

  it('Codex 式的 <model>[<effort>] 组合 id 能拆开', async () => {
    const sc = use(scenario({ legacy: true, legacyCombo: true, config: { models: [{ value: 'gpt', name: 'GPT' }], efforts: ['low', 'high'], currentEffort: 'high' } }));
    const { conn } = await open(sc);
    expect(conn.config!()).toMatchObject({ models: [{ id: 'gpt', name: 'GPT' }], efforts: ['low', 'high'], model: 'gpt', effort: 'high' });
    await conn.setConfig({ effort: 'low' });
    expect(sc.log().find((l) => l.method === 'session/set_model')!.params).toMatchObject({ modelId: 'gpt[low]' });
  });

  it('CodeBuddy 式连发的 config_option_update 合并成一条', async () => {
    const sc = use(scenario({ config: SWITCH_CFG, pushConfigTimes: 3 }));
    const { host, conn } = await open(sc);
    const before = host.of('config_options').length;
    await conn.setConfig({ effort: 'high' });
    await new Promise((r) => setTimeout(r, 250));
    expect(host.of('config_options').length - before).toBe(1);
  });
});

describe('mode-drift', () => {
  it('Agent 自己把模式改宽后改回', async () => {
    const sc = use(scenario({ config: { modes: MODES, currentMode: 'default' }, turns: [{ steps: [{ mode: 'bypassPermissions' }, { sleep: 200 }] }] }));
    const { host, conn } = await open(sc, { permission: 'ask' });
    await conn.prompt({ text: 'x' }, sig());
    await waitFor(() => sc.log().filter((l) => l.method === 'session/set_config_option' && l.params.value === 'default').length >= 1);
    expect(host.of('notice').some((n) => n.text.includes('更宽松的模式'))).toBe(true);
    await waitFor(() => conn.config!().mode === 'default');
  });

  it('改成更严格的模式不处理', async () => {
    const sc = use(scenario({ config: { modes: MODES, currentMode: 'default' }, turns: [{ steps: [{ mode: 'plan' }, { sleep: 150 }] }] }));
    const { host, conn } = await open(sc, { permission: 'ask' });
    await conn.prompt({ text: 'x' }, sig());
    expect(host.of('notice')).toHaveLength(0);
    expect(conn.config!().mode).toBe('plan');
  });
});

describe('crash', () => {
  it('回合中进程退出：prompt 报 agent.crashed，onExit 回调带 stderr', async () => {
    const sc = use(scenario({ turns: [{ steps: [{ stderr: 'boom 1' }, { sleep: 50 }, { crash: 1 }] }] }));
    const { conn } = await open(sc);
    const exits: { code: number | null; stderrTail: string[] }[] = [];
    conn.onExit!((i) => exits.push(i));
    const e = await conn.prompt({ text: 'x' }, sig()).catch((x) => x);
    expect(e).toBeInstanceOf(AgentError);
    expect(e.body.code).toBe('agent.crashed');
    await waitFor(() => exits.length === 1);
    expect(exits[0]!.code).toBe(1);
    expect(exits[0]!.stderrTail).toContain('boom 1');
    expect(conn.isClosed!()).toBe(true);
  });
});

describe('grandchild：进程树清理', () => {
  it('close() 之后 Agent 和它的子进程都不在', async () => {
    const sc = use(scenario({ grandchild: true, stubborn: true }));
    const { conn } = await open(sc, { timeouts: { closeGrace: 500, killGrace: 500 } });
    await waitFor(() => sc.log().some((l) => l.event === 'grandchild'));
    const gpid = sc.log().find((l) => l.event === 'grandchild')!.pid as number;
    const pid = conn.pid!;
    expect(isAlive(pid)).toBe(true);
    expect(isAlive(gpid)).toBe(true);
    await conn.close();
    await waitFor(() => !isAlive(pid) && !isAlive(gpid), 8000);
  });
});

describe('hang：启动超时', () => {
  it('initialize 不返回 → agent.start_timeout，进程树被结束', async () => {
    const sc = use(scenario({ hangInitialize: true, grandchild: true }));
    const a = fakeAdapter(sc, { timeouts: { initialize: 800 } });
    const t = Date.now();
    const e = await a.spawn({ cwd: sc.dir, model: null, effort: null, permission: 'ask', host: new RecordingHost() }).catch((x) => x);
    expect(e).toBeInstanceOf(AgentError);
    expect(e.body.code).toBe('agent.start_timeout');
    expect(Date.now() - t).toBeLessThan(15_000);
    const start = sc.log().find((l) => l.event === 'start')!;
    const g = sc.log().find((l) => l.event === 'grandchild')!;
    await waitFor(() => !isAlive(start.pid) && !isAlive(g.pid), 8000);
  });

  it('取消后 Agent 不响应：10 秒（测试里改小）后结束进程，回合按取消处理', async () => {
    const sc = use(scenario({ ignoreCancel: true, turns: [{ steps: [{ waitCancel: true }] }] }));
    const { conn } = await open(sc, { timeouts: { cancel: 500 } });
    const ac = new AbortController();
    const p = conn.prompt({ text: 'x' }, ac.signal);
    await waitFor(() => sc.log().some((l) => l.method === 'session/prompt'));
    ac.abort();
    expect((await p).stopReason).toBe('cancelled');
    expect(sc.log().some((l) => l.method === 'session/cancel')).toBe(true);
    await waitFor(() => conn.isClosed!());
  });

  it('取消后 Agent 正常返回 cancelled', async () => {
    const sc = use(scenario({ turns: [{ steps: [{ update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'x', kind: 'read', status: 'in_progress' } }, { waitCancel: true }] }] }));
    const { host, conn } = await open(sc);
    const ac = new AbortController();
    const p = conn.prompt({ text: 'x' }, ac.signal);
    await waitFor(() => host.of('tool_start').length === 1);
    ac.abort();
    expect((await p).stopReason).toBe('cancelled');
    expect(host.of('tool_end')[0]).toMatchObject({ ok: false, summary: '已取消' });
    expect(conn.isClosed!()).toBe(false);
  });
});

describe('noise：stdout 杂行与 stderr 脱敏', () => {
  it('连接不断，日志里只有 ***', async () => {
    const secret = 'my-injected-secret-42';
    const sc = use(scenario({
      stdoutNoiseOnStart: ['this is not json', '[1,2]'],
      stderrOnStart: ['key=sk-abcdefghijklmnopqrstuvwxyz', `using ${secret} now`, 'Authorization: Bearer abc.def.ghi', 'api_key: hunter2hunter2'],
      turns: [{ steps: [{ noise: 'garbage {' }, { update: { sessionUpdate: 'agent_message_chunk', content: text('OK') } }] }],
    }));
    const log = new LogSink();
    const { host, conn } = await open(sc, { log, redact: [secret] });
    expect((await conn.prompt({ text: 'x' }, sig())).stopReason).toBe('end_turn');
    expect(host.of('message')[0]!.text).toBe('OK');
    await waitFor(() => log.text().includes('now'));
    const all = log.text();
    expect(all).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(all).not.toContain(secret);
    expect(all).not.toContain('abc.def.ghi');
    expect(all).not.toContain('hunter2hunter2');
    expect(all).toContain('***');
    expect(all).toContain('非 JSON 行');
  });
});

describe('auth / quota', () => {
  it('session/new 返回 -32000 → agent.auth_required', async () => {
    const sc = use(scenario({ newError: { code: -32000, message: 'Authentication required', data: { category: 'auth' } } }));
    const a = fakeAdapter(sc);
    const e = await a.spawn({ cwd: sc.dir, model: null, effort: null, permission: 'ask', host: new RecordingHost() }).catch((x) => x);
    expect(e).toBeInstanceOf(AgentError);
    expect(e.body.code).toBe('agent.auth_required');
    expect(e.body.actions[0]).toMatchObject({ label: '去登录' });
    const start = sc.log().find((l) => l.event === 'start')!;
    await waitFor(() => !isAlive(start.pid), 8000);
  });

  it('prompt 返回额度错误 → agent.quota_exceeded，带重置时间', async () => {
    const sc = use(scenario({ turns: [{ steps: [{ error: { code: -32603, message: 'Usage limit reached', data: { details: 'rate limit exceeded, resets at 14:00' } } }] }] }));
    const { conn } = await open(sc);
    const e = await conn.prompt({ text: 'x' }, sig()).catch((x) => x);
    expect(e.body.code).toBe('agent.quota_exceeded');
    expect(e.body.hint).toContain('14:00');
  });

  it('_auth/status_update kind=none → auth 更新', async () => {
    const sc = use(scenario({ turns: [{ steps: [{ notify: { method: '_auth/status_update', params: { kind: 'none', label: 'Not logged in' } } }, { sleep: 50 }] }] }));
    const { host, conn } = await open(sc);
    await conn.prompt({ text: 'x' }, sig());
    expect(host.of('auth')[0]).toEqual({ kind: 'auth', loggedIn: false });
  });
});

describe('resume：恢复', () => {
  it('resume 成功：不回放，重新下发配置', async () => {
    const sc = use(scenario({ config: SWITCH_CFG }));
    const { host, conn } = await open(sc, { resume: 'old-session', model: 'beta', permission: 'readonly' });
    expect(conn.resumed).toBe(true);
    expect(conn.agentSessionId).toBe('old-session');
    expect(sc.log().some((l) => l.method === 'session/new')).toBe(false);
    expect(sc.log().find((l) => l.method === 'session/resume')!.params).toMatchObject({ sessionId: 'old-session', mcpServers: [] });
    expect(conn.config!()).toMatchObject({ model: 'beta', mode: 'plan' });
    expect(host.of('notice')).toHaveLength(0);
  });

  it('resume 返回 -32002 → 新建会话并提示', async () => {
    const sc = use(scenario({ resume: 'notfound' }));
    const { host, conn } = await open(sc, { resume: 'gone' });
    expect(conn.resumed).toBe(false);
    expect(conn.agentSessionId).toBe('sess-1');
    expect(conn.resumeFailure).toBe('原来的会话已经不存在');
    expect(host.of('notice')[0]!.text).toContain('已新建会话');
  });

  it('resume 超时 → 结束进程，新起进程新建会话', async () => {
    const sc = use(scenario({ resume: 'hang' }));
    const { host, conn } = await open(sc, { resume: 'slow', timeouts: { session: 600 } });
    expect(conn.resumed).toBe(false);
    expect(sc.log().filter((l) => l.event === 'start')).toHaveLength(2);
    expect(host.of('notice')[0]!.text).toContain('已新建会话');
  });

  it('只支持 load：回放期间的 update 被丢弃', async () => {
    const sc = use(scenario({
      loadSession: true, sessionCapabilities: {},
      loadReplay: [
        { sessionUpdate: 'user_message_chunk', content: text('旧问题') },
        { sessionUpdate: 'agent_message_chunk', content: text('旧回答') },
        { sessionUpdate: 'tool_call', toolCallId: 'old', title: '旧工具', kind: 'read', status: 'completed' },
      ],
      turns: [{ steps: [{ update: { sessionUpdate: 'agent_message_chunk', content: text('新回答') } }] }],
    }));
    const { host, conn } = await open(sc, { resume: 'old' });
    expect(conn.resumed).toBe(true);
    expect(sc.log().some((l) => l.method === 'session/load')).toBe(true);
    await conn.prompt({ text: 'x' }, sig());
    expect(host.of('message').map((m) => m.text)).toEqual(['新回答']);
    expect(host.of('tool_start')).toHaveLength(0);
  });

  it('CodeBuddy 的 historyReplay 标记：load 返回后到 end 之前仍然丢弃', async () => {
    const meta = (m: string) => ({ sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai/historyReplay': m } });
    const sc = use(scenario({
      loadSession: true, sessionCapabilities: {},
      loadReplay: [meta('start'), { sessionUpdate: 'agent_message_chunk', content: text('旧回答') }],
      turns: [{ steps: [{ update: { sessionUpdate: 'agent_message_chunk', content: text('还是旧的') } }, { update: meta('end') }, { update: { sessionUpdate: 'agent_message_chunk', content: text('新回答') } }] }],
    }));
    const { host, conn } = await open(sc, { resume: 'old' });
    await conn.prompt({ text: 'x' }, sig());
    expect(host.of('message').map((m) => m.text)).toEqual(['新回答']);
  });

  it('不支持恢复：直接新建并提示', async () => {
    const sc = use(scenario({ sessionCapabilities: {} }));
    const { host, conn } = await open(sc, { resume: 'old' });
    expect(conn.resumed).toBe(false);
    expect(host.of('notice')[0]!.text).toContain('不支持恢复会话');
  });
});
