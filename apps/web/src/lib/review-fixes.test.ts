// 第 1.2 步审查后的修复（docs/acceptance/step-1.2.md“审查与修复”）：网页这一层的纯函数和协议解析。
import { describe, expect, it } from 'vitest';
import { ErrorActionKey, ErrorCode, type AgentInfo, type ApiError } from '@aic/protocol';
import { parseEventPage } from '../api/http';
import { alertError, errorAlertStore, showError, toastStore } from '../state/ui';
import {
  loginAnnounceText, permAvailable, profileSwitchKind, profileSwitchText, switchNeedsTurnEnd, taskDefaults, withDefaultActions, workspaceConfigNote,
} from './agents';

const agent = (o: Partial<AgentInfo>): AgentInfo => ({
  kind: 'claude', displayName: 'Claude Code', status: 'ready', version: '1', verified: true, models: [], efforts: null, message: null, ...o,
});

describe('第 13 条：权限级别以 Gateway 给的 permissionLevels 为准', () => {
  it('有字段时按字段；没有字段时退回默认规则', () => {
    const open = agent({ permissionLevels: ['readonly', 'ask', 'workspace'] });
    expect(permAvailable('claude', 'workspace', open)).toBe(true);
    expect(permAvailable('claude', 'full', open)).toBe(false);
    // Gateway 收紧了：网页跟着收紧
    expect(permAvailable('fake', 'full', agent({ kind: 'fake', permissionLevels: ['readonly'] }))).toBe(false);
    // 老 Gateway：默认规则
    expect(permAvailable('claude', 'workspace', agent({}))).toBe(false);
    expect(permAvailable('fake', 'full', undefined)).toBe(true);
  });
});

describe('第 14 条：历史事件分页逐条解析', () => {
  const ok = (seq: number) => ({ seq, ts: 1, type: 'message.done', taskId: 't1', sessionId: null, data: { messageId: 'm1' } });
  it('不认识的事件类型跳过，不让整页失败；分页按原始条数和 seq', () => {
    const page = parseEventPage({ items: [ok(1), { seq: 2, ts: 1, type: 'future.thing', taskId: 't1', sessionId: null, data: { x: 1 } }, ok(3), { seq: 4, ts: 1, type: 'future.thing2', taskId: 't1', sessionId: null, data: {} }], nextCursor: null });
    expect(page.items.map((e) => e.seq)).toEqual([1, 3]);
    expect(page.rawCount).toBe(4);
    expect(page.lastSeq).toBe(4);
    expect(page.skipped).toBe(2);
  });
  it('分页外壳不对时报错', () => {
    expect(() => parseEventPage({ nope: [] })).toThrow();
  });
});

describe('第 18 条：换账号按会话存放位置标注', () => {
  it('sessionStore 相同 → 恢复会话；不同 → 需要交接；老 Gateway 没给时按可以恢复', () => {
    expect(profileSwitchKind({ sessionStore: 'shared' }, { sessionStore: 'shared' })).toBe('resume');
    expect(profileSwitchKind({ sessionStore: 'shared' }, { sessionStore: 'profile:pf_2' })).toBe('handoff');
    expect(profileSwitchKind(null, { sessionStore: 'shared' })).toBe('resume');
    expect(profileSwitchKind({}, {})).toBe('resume');
    expect(profileSwitchText.handoff).toContain('1.4');
    expect(profileSwitchText.resume).not.toContain('无损');
  });
});

describe('第 19 条：带按钮的错误进页面里的 alert 块', () => {
  it('有 actions → alert；没有 → 提示条', () => {
    errorAlertStore.set(() => []);
    toastStore.set(() => []);
    const withAct: ApiError = { code: ErrorCode.InvalidState, message: '任务正在执行', hint: '先停止', actions: [{ label: '停止', action: ErrorActionKey.Cancel, args: { taskId: 't1' } }] };
    showError(withAct, { taskId: 't1' });
    expect(errorAlertStore.get()).toHaveLength(1);
    expect(errorAlertStore.get()[0]!.taskId).toBe('t1');
    showError({ code: 'x', message: '普通错误', actions: [] });
    expect(errorAlertStore.get()).toHaveLength(1);
    expect(toastStore.get().some((t) => t.text.includes('普通错误'))).toBe(true);
    // 同样的错误不重复堆叠
    alertError(withAct);
    expect(errorAlertStore.get()).toHaveLength(1);
  });
  it('会话恢复不了的错误补上“去 Agent 页”', () => {
    const e = withDefaultActions({ code: ErrorCode.SessionNotRecoverable, message: '找不到', actions: [] }, { taskId: 't1', kind: 'claude' });
    expect(e.actions).toEqual([{ label: '去 Agent 页', action: ErrorActionKey.OpenAgents, args: { kind: 'claude' } }]);
  });
});

describe('第 20 条：执行中切换先问', () => {
  it('换账号、H1 换模型要等这一轮；H0 的模型和强度、空闲时直接切', () => {
    expect(switchNeedsTurnEnd('running', 'profile', 'in_session')).toBe(true);
    expect(switchNeedsTurnEnd('waiting', 'model', 'resume')).toBe(true);
    expect(switchNeedsTurnEnd('queued', 'model', 'new_session')).toBe(true);
    expect(switchNeedsTurnEnd('running', 'model', 'in_session')).toBe(false);
    expect(switchNeedsTurnEnd('running', 'effort', 'resume')).toBe(false);
    expect(switchNeedsTurnEnd('review', 'profile', 'resume')).toBe(false);
    expect(switchNeedsTurnEnd('paused', 'model', 'resume')).toBe(false);
  });
});

describe('第 21 条：Agent 设置里的默认模型', () => {
  it('真实 Agent 用设置里的默认值；不在列表里时退回 Agent 自己的默认；演示 Agent 不变', () => {
    const models = [{ id: 'a', name: 'A', contextWindow: null }, { id: 'b', name: 'B', contextWindow: null }];
    expect(taskDefaults(agent({ models, efforts: ['low', 'high'], defaultModel: 'b', defaultEffort: 'high' }))).toEqual({ model: 'b', effort: 'high' });
    expect(taskDefaults(agent({ models, defaultModel: 'gone' }))).toEqual({ model: '', effort: '' });
    expect(taskDefaults(agent({ models: [], defaultModel: 'x' }))).toEqual({ model: 'x', effort: '' });
    expect(taskDefaults(agent({ models }))).toEqual({ model: '', effort: '' });
    expect(taskDefaults(agent({ kind: 'fake', models, efforts: ['低', '中', '高'] }))).toEqual({ model: 'a', effort: '中' });
  });
});

describe('第 1、22 条：工作区设置提示、登录播报', () => {
  it('ignored 不警告；trusted_only 和未知都提示', () => {
    expect(workspaceConfigNote(agent({ workspaceConfig: 'ignored' }))!.warn).toBe(false);
    expect(workspaceConfigNote(agent({ kind: 'codex', displayName: 'Codex', workspaceConfig: 'trusted_only' }))!.warn).toBe(true);
    expect(workspaceConfigNote(agent({}))!.warn).toBe(true);
    expect(workspaceConfigNote(agent({ kind: 'fake' }))).toBeNull();
  });
  it('每个登录状态只播报一行字', () => {
    for (const s of ['started', 'waiting_browser', 'need_code', 'succeeded', 'failed', 'cancelled']) {
      const t = loginAnnounceText(s);
      expect(t.length).toBeGreaterThan(0);
      expect(t).not.toContain('\n');
    }
  });
});
