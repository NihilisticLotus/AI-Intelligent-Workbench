// 契约测试（phase-1.md 6.8）：假 ACP Agent 子进程 + 真正的 AcpConnection / AcpSession。
import { afterEach, describe, expect, it } from 'vitest';
import { AgentError, buildChildEnv, isAlive, type AgentConnection } from '../src/index';
import { fakeAdapter, LogSink, MODELS, MODES, RecordingHost, scenario, waitFor, type Scenario } from './helpers';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

function use(sc: Scenario) { cleanups.push(() => sc.cleanup()); return sc; }
function track(c: AgentConnection) { cleanups.push(() => c.close()); return c; }

const text = (t: string) => ({ type: 'text', text: t });
const BASIC_TURN = [
  { update: { sessionUpdate: 'agent_thought_chunk', content: text('先看看代码') } },
  { update: { sessionUpdate: 'agent_message_chunk', content: text('好的，') } },
  { update: { sessionUpdate: 'agent_message_chunk', content: text('我来看一下。') } },
  { update: { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: '读取 Player.cs', kind: 'read', status: 'pending', locations: [{ path: 'D:/p/Player.cs' }] } },
  { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed', content: [{ type: 'content', content: text('182 行') }] } },
  { update: { sessionUpdate: 'tool_call', toolCallId: 'call_2', title: '修改 Player.cs', kind: 'edit', status: 'in_progress', rawInput: { file_path: 'D:/p/Player.cs' } } },
  { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_2', content: [{ type: 'diff', path: 'D:/p/Player.cs', oldText: 'a\nb', newText: 'a\nb\nc\nd' }] } },
  { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_2', title: '只改了标题' } },
  { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_2', status: 'completed' } },
  { update: { sessionUpdate: 'tool_call', toolCallId: 'call_3', title: '运行测试', kind: 'execute', status: 'failed', rawInput: { command: ['npm', 'test'] } } },
  { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_x', status: 'completed' } },
  { update: { sessionUpdate: 'plan', entries: [{ content: '读代码', status: 'completed', priority: 'high' }, { content: '改参数', status: 'in_progress', priority: 'low' }] } },
  { update: { sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: 0.01, currency: 'USD' } } },
  { update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: '' }] } },
  { update: { sessionUpdate: 'totally_new_type', foo: 1 } },
  { update: { sessionUpdate: 'totally_new_type', foo: 2 } },
  { update: { sessionUpdate: 'user_message_chunk', content: text('不应出现') } },
  { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'xx', mimeType: 'image/png' } } },
];

async function open(sc: Scenario, opts: { permission?: 'readonly' | 'ask'; model?: string | null; effort?: string | null; resume?: string; log?: LogSink; timeouts?: Record<string, number> } = {}) {
  const host = new RecordingHost();
  const a = fakeAdapter(sc, { ...(opts.log ? { log: opts.log } : {}), ...(opts.timeouts ? { timeouts: opts.timeouts } : {}) });
  const conn = track(await a.spawn({
    cwd: sc.dir, model: opts.model ?? null, effort: opts.effort ?? null, permission: opts.permission ?? 'ask', host,
    sessionLabel: 's_test', ...(opts.resume ? { resume: { agentSessionId: opts.resume } } : {}),
  }));
  conn.ready?.();
  return { host, conn, adapter: a };
}

describe('basic：session/update 映射', () => {
  it('消息、思考、工具、计划、用量逐条映射；未知类型只计数', async () => {
    const sc = use(scenario({ config: { models: MODELS, modes: MODES, currentMode: 'default' }, turns: [{ steps: BASIC_TURN }] }));
    const { host, conn } = await open(sc);
    const r = await conn.prompt('看看跳跃', new AbortController().signal);
    expect(r.stopReason).toBe('end_turn');
    const k = host.kinds().filter((x) => x !== 'config_options');
    expect(k).toEqual([
      'thought', 'message', 'message', 'message_done',
      'tool_start', 'tool_output', 'tool_end',
      'tool_start', 'tool_output', 'tool_end',
      'tool_start', 'tool_end',
      'tool_start', 'tool_end',
      'plan', 'usage', 'message', 'message_done',
    ]);
    const msgs = host.of('message');
    expect(msgs[0]!.messageId).toBe(msgs[1]!.messageId);
    expect(msgs.map((m) => m.text).join('')).toBe('好的，我来看一下。[图片]');
    expect(msgs[2]!.messageId).not.toBe(msgs[0]!.messageId);
    const starts = host.of('tool_start');
    expect(starts.map((s) => s.toolKind)).toEqual(['read', 'edit', 'execute', 'other']);
    expect(starts[0]!.target).toBe('D:/p/Player.cs');
    expect(starts[2]!.target).toBe('npm test');
    expect(starts[3]!.title).toBe('工具调用');
    expect(new Set(starts.map((s) => s.toolId)).size).toBe(4);
    expect(starts[0]!.toolId).toContain('stest');
    expect(host.of('tool_output')[1]!.text).toBe('修改 D:/p/Player.cs（+2 −0）');
    const ends = host.of('tool_end');
    expect(ends.map((e) => e.ok)).toEqual([true, true, false, true]);
    expect(host.of('plan')[0]!.items).toEqual([{ text: '读代码', status: 'completed' }, { text: '改参数', status: 'in_progress' }]);
    expect(host.of('usage')[0]).toMatchObject({ used: 1200, size: 200000, cost: { amount: 0.01, currency: 'USD' } });
    expect(conn.caps?.unknownUpdates).toEqual({ totally_new_type: 2 });
    expect(conn.caps?.commands).toEqual(['compact']);
    expect(conn.caps?.thoughts).toBe(true);
  });

  it('stopReason：max_tokens 映射为 end_turn 并提示；refusal 原样', async () => {
    const sc = use(scenario({ turns: [{ steps: [], stop: 'max_tokens' }, { steps: [], stop: 'refusal' }] }));
    const { host, conn } = await open(sc);
    expect((await conn.prompt('a', new AbortController().signal)).stopReason).toBe('end_turn');
    expect(host.of('notice').map((n) => n.text)).toContain('回复达到长度上限，可以让它继续');
    expect((await conn.prompt('b', new AbortController().signal)).stopReason).toBe('refusal');
  });

  it('建会话后按权限级别设置模式；能力从 initialize 推导', async () => {
    const sc = use(scenario({ config: { models: MODELS, modes: MODES, currentMode: 'default' } }));
    const { conn } = await open(sc, { permission: 'readonly' });
    expect(conn.config?.().mode).toBe('plan');
    expect(conn.caps).toMatchObject({ resume: true, close: true, loadSession: false, modelSwitch: 'configOption', agentInfo: { name: 'fake-acp-agent', version: '9.9.9' } });
    const set = sc.log().find((l) => l.method === 'session/set_config_option');
    expect(set?.params).toMatchObject({ configId: 'mode', value: 'plan' });
    expect(sc.log().find((l) => l.method === 'session/new')?.params).toMatchObject({ mcpServers: [] });
  });

  it('注入 MCP：只放 aic- 前缀的服务（Codex 会静默跳过同名服务）', async () => {
    const sc = use(scenario({}));
    const host = new RecordingHost();
    const log = new LogSink();
    const a = fakeAdapter(sc, { log });
    const echo = { name: 'aic-echo', command: process.execPath, args: ['echo.mjs'], env: [] };
    track(await a.spawn({ cwd: sc.dir, model: null, effort: null, permission: 'ask', host, mcpServers: [echo, { ...echo, name: 'echo' }] }));
    expect(sc.log().find((l) => l.method === 'session/new')?.params.mcpServers).toEqual([echo]);
    expect(log.text()).toContain('aic- 开头');
  });
});

describe('环境变量', () => {
  it('删掉会串号的变量，再叠加账号变量', () => {
    const env = buildChildEnv({ ANTHROPIC_API_KEY: 'k' }, { PATH: 'p', ANTHROPIC_BASE_URL: 'x', OPENAI_API_KEY: 'o', CODEX_HOME: 'h', CODEBUDDY_API_KEY: 'c', SSH_TTY: '1', NO_BROWSER: '1', CLAUDE_CONFIG_DIR: 'd', CLAUDE_CODE_USE_BEDROCK: '1', ACC_PRODUCT_CONFIG_X: '1', APP_SERVER_LOGS: '1', KEEP: 'y' });
    expect(env).toEqual({ PATH: 'p', KEEP: 'y', ANTHROPIC_API_KEY: 'k' });
  });

  it('删掉宿主 Claude Code / 桌面端注入的变量，保留用户自己的 Claude Code 设置', () => {
    const env = buildChildEnv({}, {
      CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CODE_ENTRYPOINT: 'x', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'A', CLAUDE_CODE_MESSAGING_TOKEN: 'm', CLAUDE_CODE_DESKTOP_APP_VERSION: '1', CLAUDE_AGENT_SDK_VERSION: '1',
      CLAUDE_CODE_SESSION_ID: 's', CLAUDE_PID: '1', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1000',
    });
    expect(env).toEqual({ CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1000' });
  });

  it.runIf(process.platform === 'win32')('Windows：删掉 Git Bash 的 HOME=/c/...，保留 Windows 路径的 HOME', () => {
    expect(buildChildEnv({}, { HOME: '/c/Users/u', USERPROFILE: 'C:\\Users\\u' })).toEqual({ USERPROFILE: 'C:\\Users\\u' });
    expect(buildChildEnv({}, { HOME: 'C:\\Users\\u' })).toEqual({ HOME: 'C:\\Users\\u' });
  });

  it('子进程里看不到父进程的 ANTHROPIC_*，看得到账号注入的变量', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://should-not-leak.example';
    try {
      const sc = use(scenario({ watchEnv: ['ANTHROPIC_BASE_URL', 'AIC_FAKE_SECRET'] }));
      const host = new RecordingHost();
      const a = fakeAdapter(sc);
      const env = a.buildEnv({ id: 'p', agentId: 'claude', name: 'x', authMethod: 'apiKey', kind: 'apiKey' }, 'secret-value-123');
      track(await a.spawn({ cwd: sc.dir, model: null, effort: null, permission: 'ask', host, env }));
      expect(sc.log()[0]!.env).toEqual({ ANTHROPIC_BASE_URL: null, AIC_FAKE_SECRET: 'secret-value-123' });
    } finally { delete process.env.ANTHROPIC_BASE_URL; }
  });
});

