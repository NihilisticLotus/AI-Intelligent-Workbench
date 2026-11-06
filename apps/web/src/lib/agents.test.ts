// 真实 Agent 相关纯函数的测试：状态文案、权限开放规则、换模型方式、模型来源、账号校验、测试日志、默认错误按钮。
import { describe, expect, it } from 'vitest';
import { ErrorActionKey, ErrorCode, type AgentCaps, type AgentInfo, type AgentProfile } from '@aic/protocol';
import {
  agentReadiness, agentStatusView, capsSummary, emptyModelsText, formatTestLog, isLocalLogin, loginMethods, loginStep,
  modelSwitchKind, parseModelList, permAvailable, pickEfforts, pickModels, profileDesc, safeAuthUrl, switchKindText,
  validateProfileDraft, withDefaultActions,
} from './agents';

const agent = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  kind: 'claude', displayName: 'Claude Code', status: 'ready', version: '0.100.0', verified: true,
  models: [{ id: 'default', name: '默认', contextWindow: null }], efforts: ['low', 'medium', 'high'], message: null, ...over,
});
const caps = (over: Partial<AgentCaps> = {}): AgentCaps => ({
  loadSession: true, resume: true, close: true, modelSwitch: 'configOption', thoughts: false, modes: [],
  prompt: { image: false, audio: false, embeddedContext: false }, ...over,
});
const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'pf1', agent: 'claude', name: '本机登录', kind: 'subscription', configDir: 'shared', baseUrl: null, authHeader: null,
  models: [], hasSecret: false, secretHint: null, isDefault: true, loggedIn: true, experimental: false,
  lastTestAt: null, lastTestOk: null, createdAt: 1, updatedAt: 1, ...over,
});

describe('状态与就绪', () => {
  it('就绪但版本没验证过：显示“未验证版本”，仍然可以派发', () => {
    const a = agent({ verified: false });
    expect(agentStatusView(a)).toEqual({ text: '未验证版本', shape: 'wait' });
    expect(agentReadiness(a).ready).toBe(true);
  });
  it('未就绪时给出原因（带上 Agent 的说明）', () => {
    const r = agentReadiness(agent({ status: 'needs_login', message: '订阅登录已过期' }));
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('Claude Code 还没有登录：订阅登录已过期');
    expect(agentReadiness(agent({ status: 'not_installed' })).reason).toContain('没有找到');
    // Agent 的说明开头和我们的文案重复时不重复显示
    expect(agentReadiness(agent({ kind: 'codebuddy', displayName: 'CodeBuddy', status: 'needs_login', message: '还没有登录：请在 WorkBuddy 里登录' })).reason)
      .toBe('CodeBuddy 还没有登录：请在 WorkBuddy 里登录');
    expect(agentStatusView(agent({ status: 'error' })).shape).toBe('err');
  });
});

describe('权限：真实 Agent 只开放只读和需审批', () => {
  it('演示 Agent 四档都开放；真实 Agent 后两档锁定', () => {
    expect(permAvailable('fake', 'full')).toBe(true);
    expect(permAvailable('codex', 'readonly')).toBe(true);
    expect(permAvailable('codex', 'ask')).toBe(true);
    expect(permAvailable('codex', 'workspace')).toBe(false);
    expect(permAvailable('claude', 'full')).toBe(false);
  });
});

describe('换模型的方式', () => {
  it('configOption / set_model 是会话内切换；none 时能恢复就“恢复会话”，不能恢复要新建会话', () => {
    expect(modelSwitchKind(undefined)).toBe('in_session');
    expect(modelSwitchKind(caps())).toBe('in_session');
    expect(modelSwitchKind(caps({ modelSwitch: 'unstableSetModel' }))).toBe('in_session');
    expect(modelSwitchKind(caps({ modelSwitch: 'none' }))).toBe('resume');
    expect(modelSwitchKind(caps({ modelSwitch: 'none', resume: false, loadSession: true }))).toBe('resume');
    expect(modelSwitchKind(caps({ modelSwitch: 'none', resume: false, loadSession: false }))).toBe('new_session');
    expect(switchKindText.in_session).toBe('会话内切换（无损）');
    expect(switchKindText.resume).toBe('恢复会话（无损）');
  });
  it('模型和思考强度：会话给的优先；会话说不能调强度（null）就隐藏', () => {
    const a = agent();
    expect(pickModels(a, {}).map((m) => m.id)).toEqual(['default']);
    expect(pickModels(a, { models: [{ id: 'opus', name: 'Opus', contextWindow: null }] }).map((m) => m.id)).toEqual(['opus']);
    expect(pickEfforts(a, {})).toEqual(['low', 'medium', 'high']);
    expect(pickEfforts(a, { efforts: ['high', 'max'] })).toEqual(['high', 'max']);
    expect(pickEfforts(a, { efforts: null })).toBeNull();
    expect(pickEfforts(agent({ efforts: [] }), {})).toBeNull();
  });
  it('还没探测过的 Agent：模型列表“首次使用后显示”', () => {
    expect(emptyModelsText(agent({ kind: 'codex', models: [], modelsSource: 'none' }))).toBe('首次使用后显示模型列表');
    expect(emptyModelsText(agent({ kind: 'fake', models: [] }))).toBe('由 Agent 决定');
  });
  it('能力摘要', () => {
    expect(capsSummary(caps({ thoughts: true, prompt: { image: true, audio: false, embeddedContext: false } })))
      .toEqual(['会话内换模型', '可恢复会话', '显示思考过程', '可以看图片']);
    expect(capsSummary(undefined)).toEqual([]);
  });
});

describe('登录', () => {
  it('API Key 方式不在界面里直接登录；步骤序号；授权链接只接受 https', () => {
    const a = agent({ authMethods: [
      { id: 'chat-gpt', name: 'ChatGPT 登录', description: null, flow: 'browser' },
      { id: 'api-key', name: 'API Key', description: null, flow: 'apiKey' },
    ] });
    expect(loginMethods(a).map((m) => m.id)).toEqual(['chat-gpt']);
    expect(loginStep('started')).toBe(0);
    expect(loginStep('waiting_browser')).toBe(1);
    expect(loginStep('need_code')).toBe(1);
    expect(loginStep('succeeded')).toBe(3);
    expect(safeAuthUrl('https://claude.ai/oauth?x=1')).toBe('https://claude.ai/oauth?x=1');
    expect(safeAuthUrl('javascript:alert(1)')).toBeNull();
    expect(safeAuthUrl('http://example.com')).toBeNull();
    expect(safeAuthUrl(undefined)).toBeNull();
  });
});

describe('账号', () => {
  it('描述里只出现密钥末 4 位；本机登录不能删除', () => {
    const key = profile({ id: 'k', kind: 'apiKey', name: '工作室', hasSecret: true, secretHint: '7Q2c', isDefault: false, loggedIn: null });
    expect(profileDesc(key)).toContain('结尾 …7Q2c');
    expect(profileDesc(key)).toContain('Windows 数据保护');
    expect(profileDesc(profile({ agent: 'codebuddy' }))).toContain('沿用 WorkBuddy 登录');
    expect(profileDesc(profile({ loggedIn: false }))).toContain('未登录');
    expect(profileDesc(profile({ kind: 'customEndpoint', baseUrl: 'https://relay.example.com/v1', hasSecret: true, secretHint: 'abcd' }))).toMatch(/^relay\.example\.com，结尾 …abcd/);
    expect(isLocalLogin(profile())).toBe(true);
    expect(isLocalLogin(profile({ configDir: 'isolated' }))).toBe(false);
  });
  it('表单校验：地址只接受 https 或本机 http；新建要填密钥，编辑时可以留空', () => {
    const base = { kind: 'customEndpoint' as const, name: '中转', baseUrl: 'https://relay.example.com', authHeader: 'bearer' as const, apiKey: 'sk-test', models: '' };
    expect(validateProfileDraft(base, false)).toBeNull();
    expect(validateProfileDraft({ ...base, baseUrl: 'http://relay.example.com' }, false)).toMatch(/https/);
    expect(validateProfileDraft({ ...base, baseUrl: 'http://127.0.0.1:8080' }, false)).toBeNull();
    expect(validateProfileDraft({ ...base, apiKey: '' }, false)).toBe('填写密钥');
    expect(validateProfileDraft({ ...base, apiKey: '' }, true)).toBeNull();
    expect(validateProfileDraft({ ...base, name: ' ' }, false)).toMatch(/名字/);
    expect(validateProfileDraft({ ...base, apiKey: 'sk a' }, false)).toMatch(/空格/);
    expect(validateProfileDraft({ ...base, kind: 'subscription', apiKey: '' }, false)).toBeNull();
  });
  it('手填模型：逗号、顿号、换行分隔，去重', () => {
    expect(parseModelList('a, b\nc、a\n\n').map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('测试日志与默认错误按钮', () => {
  it('测试日志逐步列出，结果写明卡在哪一步', () => {
    const t0 = new Date(2026, 10, 6, 13, 58, 2).getTime();
    const log = formatTestLog({ ok: false, steps: [
      { ts: t0, label: '找到引擎', ok: true, ms: 12 },
      { ts: t0 + 1000, label: 'ACP 握手', ok: false, ms: 30000, detail: '超时' },
    ] });
    expect(log).toBe('13:58:02  ✓ 找到引擎（12 毫秒）\n13:58:03  ✗ ACP 握手（30.0 秒）：超时\n结果：没有通过，卡在“ACP 握手”');
    expect(formatTestLog({ ok: true, steps: [] })).toBe('结果：一切正常');
  });
  it('Gateway 没给按钮时按错误码补上；给了就不动', () => {
    const ctx = { taskId: 't1', kind: 'codex' };
    const auth = withDefaultActions({ code: ErrorCode.AgentAuthRequired, message: 'Codex 登录已过期', actions: [] }, ctx);
    expect(auth.actions).toEqual([{ label: '去登录', action: ErrorActionKey.Login, args: { kind: 'codex' } }]);
    const quota = withDefaultActions({ code: ErrorCode.AgentQuotaExceeded, message: '额度用完了', actions: [] }, ctx);
    expect(quota.actions.map((a) => a.label)).toEqual(['换模型', '换账号']);
    const crash = withDefaultActions({ code: ErrorCode.AgentCrashed, message: 'Codex 意外退出', actions: [] }, ctx);
    expect(crash.actions).toEqual([{ label: '继续', action: ErrorActionKey.Continue, args: { taskId: 't1' } }]);
    const timeout = withDefaultActions({ code: ErrorCode.AgentStartTimeout, message: '启动超时', actions: [] }, ctx);
    expect(timeout.actions.map((a) => a.label)).toEqual(['再试一次', '测试连接']);
    const given = { code: ErrorCode.AgentCrashed, message: 'x', actions: [{ label: '恢复会话', action: ErrorActionKey.Resume }] };
    expect(withDefaultActions(given, ctx)).toBe(given);
  });
});
