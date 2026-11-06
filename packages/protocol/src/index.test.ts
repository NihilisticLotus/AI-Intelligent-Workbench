// 协议包的基本契约测试：确认关键模式能解析 Gateway 和网页实际收发的数据形态。
import { describe, expect, it } from 'vitest';
import {
  AgentInfo, AgentProfile, ApiError, ClientOp, CreateProfileBody, EventEnvelope, FeatureKey, Page, PairingCompleteBody, ServerFrame, Task,
  isAllowedBaseUrl,
} from './index';

const task = {
  id: 't_1', projectId: 'p_1', groupId: null, title: '修复跳跃手感', prompt: '看看跳跃', status: 'running',
  permission: 'ask', agent: 'fake', model: 'demo-fast', effort: 'medium', autoAllowLowRisk: false, autoMergeOnPass: false,
  lastActivityAt: 1, createdAt: 1, updatedAt: 1,
};

describe('协议', () => {
  it('ApiError 的 actions 默认为空数组', () => {
    expect(ApiError.parse({ code: 'x', message: '出错了' }).actions).toEqual([]);
  });

  it('配对请求的默认值：浏览器 + Cookie', () => {
    const b = PairingCompleteBody.parse({ code: ' 123456 ', deviceName: '本机浏览器' });
    expect(b).toMatchObject({ code: '123456', kind: 'browser', tokenDelivery: 'cookie' });
  });

  it('subscribe 可以不带 taskIds；未知 op 被拒绝', () => {
    expect(ClientOp.safeParse({ id: 'c1', op: 'subscribe', data: { lastSeq: 0 } }).success).toBe(true);
    expect(ClientOp.safeParse({ id: 'c1', op: 'rm', data: {} }).success).toBe(false);
  });

  it('事件帧和分页列表', () => {
    const ev = { seq: 1, ts: 1, taskId: 't_1', sessionId: null, type: 'task.created', data: { task } };
    expect(EventEnvelope.parse(ev).type).toBe('task.created');
    expect(ServerFrame.parse({ kind: 'event', event: ev }).kind).toBe('event');
    expect(Page(Task).parse({ items: [task], nextCursor: null }).items).toHaveLength(1);
  });

  it('功能开关键名不重复', () => {
    const vals = Object.values(FeatureKey);
    expect(new Set(vals).size).toBe(vals.length);
  });

  it('1.1 新增字段都是可选的：旧数据照样能解析，新数据也能带上', () => {
    expect(ServerFrame.parse({ kind: 'replayed', upToSeq: 3 })).toEqual({ kind: 'replayed', upToSeq: 3 });
    expect(ServerFrame.parse({ kind: 'replayed', upToSeq: 3, bootId: 'b1', reset: true })).toMatchObject({ bootId: 'b1', reset: true });
    const end = { seq: 1, ts: 1, taskId: 't', sessionId: 's', type: 'tool.end', data: { toolId: 'x', ok: false, summary: null } };
    expect(EventEnvelope.parse(end).type).toBe('tool.end');
    expect((EventEnvelope.parse({ ...end, data: { ...end.data, rejected: true } }).data as { rejected?: boolean }).rejected).toBe(true);
    const res = { seq: 2, ts: 1, taskId: 't', sessionId: 's', type: 'approval.resolved', data: { approvalId: 'a', status: 'allowed', decidedBy: 'd', optionId: 'o' } };
    expect(EventEnvelope.parse(res).type).toBe('approval.resolved');
    expect((EventEnvelope.parse({ ...res, data: { ...res.data, decidedByName: '本机浏览器' } }).data as { decidedByName?: string }).decidedByName).toBe('本机浏览器');
  });

  it('1.2 新增字段：老数据照样能解析，新字段可以带上', () => {
    const ag = { kind: 'claude', displayName: 'Claude Code', status: 'ready', version: '0.100.0', verified: true, models: [], efforts: null, message: null };
    expect(AgentInfo.parse(ag).kind).toBe('claude');
    const full = AgentInfo.parse({
      ...ag, adapterVersion: '0.100.0', engineVersion: '2.1.316', engineSource: 'bundled', engineLocation: '适配器自带',
      authMethods: [{ id: 'claude-ai-login', name: '订阅登录', description: null, flow: 'browser' }],
      caps: { loadSession: true, resume: true, close: true, modelSwitch: 'configOption', thoughts: false, modes: [], prompt: { image: true, audio: false, embeddedContext: true } },
      modelsSource: 'cache', runningSessions: 0, concurrencyLimit: 2, checkedAt: 1,
      profiles: [{ id: 'pf1', name: '本机登录', kind: 'subscription', isDefault: true, loggedIn: true }],
    });
    expect(full.caps?.modelSwitch).toBe('configOption');
    expect(Task.parse({ ...task, profileId: 'pf1' }).profileId).toBe('pf1');
    const base = { seq: 3, ts: 1, taskId: 't', sessionId: 's' };
    expect(EventEnvelope.parse({ ...base, type: 'session.started', data: { agent: 'codex', model: null } }).type).toBe('session.started');
    expect(EventEnvelope.parse({ ...base, type: 'session.config', data: { model: 'a', effort: null, models: [{ id: 'a', name: 'A', contextWindow: null }], efforts: null } }).type).toBe('session.config');
    expect(EventEnvelope.parse({ ...base, type: 'session.notice', data: { level: 'warn', text: '已新建会话' } }).type).toBe('session.notice');
    expect(EventEnvelope.parse({ ...base, taskId: null, type: 'agent.login', data: { loginId: 'l1', kind: 'codex', profileId: null, state: 'waiting_browser', authUrl: 'https://x' } }).type).toBe('agent.login');
    expect(ClientOp.safeParse({ id: 'c', op: 'switch', data: { taskId: 't', profileId: 'pf2' } }).success).toBe(true);
    expect(FeatureKey.Profiles).toBe('agents.profiles');
  });

  it('账号：只返回密钥末 4 位；自定义地址只接受 https 或本机 http', () => {
    const p = AgentProfile.parse({
      id: 'pf', agent: 'claude', name: '工作室', kind: 'apiKey', configDir: 'shared', baseUrl: null, authHeader: null, models: [],
      hasSecret: true, secretHint: '7Q2c', isDefault: false, loggedIn: null, experimental: false, lastTestAt: null, lastTestOk: null, createdAt: 1, updatedAt: 1,
    });
    expect(p).not.toHaveProperty('apiKey');
    expect(isAllowedBaseUrl('https://relay.example.com/v1')).toBe(true);
    expect(isAllowedBaseUrl('http://127.0.0.1:8080')).toBe(true);
    expect(isAllowedBaseUrl('http://relay.example.com')).toBe(false);
    expect(CreateProfileBody.safeParse({ agent: 'claude', name: 'x', kind: 'customEndpoint', baseUrl: 'http://evil.example' }).success).toBe(false);
  });
});
