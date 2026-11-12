import { describe, expect, it } from 'vitest';
import { CreateTaskBody, type AgentInfo, type IndependentTaskOptions, type Task } from '@aic/protocol';
import { greeting, newTaskBody, quickTemplates, recommendAgent, templateDraft } from './new-task';
import { parseHash, routeHash, type Route } from '../state/ui';

const agent = (over: Partial<AgentInfo> = {}): AgentInfo => ({ kind: 'fake', displayName: '演示 Agent', status: 'ready', version: null, verified: true, message: null,
  models: [{ id: 'plain', name: '纯文字', contextWindow: null, vision: false }, { id: 'image', name: '看图模型', contextWindow: null, vision: true }], efforts: ['low'], ...over });
const task = (over: Partial<Task> = {}): Task => ({ id: 't', projectId: 'p', groupId: null, title: '历史任务', prompt: '测试', status: 'review', permission: 'ask', agent: 'fake', model: 'plain', effort: null,
  autoAllowLowRisk: false, autoMergeOnPass: false, lastActivityAt: 10, createdAt: 1, updatedAt: 10, ...over });
const independent: IndependentTaskOptions = { selection: { serviceId: 'service', modelId: 'model' }, generation: {}, context: { mode: 'local', safetyTokens: 1024 },
  limits: { maxModelCalls: 1, maxToolCalls: 0, maxOutputTokens: 512, timeoutMs: 30_000, maxContextBytes: 100_000 }, requestBudget: { maxRequests: 1, money: null } };
const draft = { projectId: 'p', groupId: '', prompt: '  说明工作\n  ', agent: 'fake' as const, model: '', effort: '', permission: 'readonly' as const, profileId: '', independent: null, hasAttachments: false };

describe('起始页路由', () => {
  it('五项预设完整往返，保留明确的不分组及包含换行、井号、问号的描述', () => {
    const route: Route = { page: 'new', preset: { projectId: 'p/中文', groupId: null, agent: 'independent', model: 'a+b&c', prompt: '修复 #?\n下一行 %' } };
    expect(parseHash(routeHash(route))).toEqual(route);
    expect(parseHash(routeHash({ page: 'new', preset: { groupId: 'g', model: '' } }))).toEqual({ page: 'new', preset: { groupId: 'g', model: '' } });
  });
  it('裸地址与不合法 Agent 安全回退，忽略未知预设，不改变现有路由', () => {
    expect(parseHash('#/new')).toEqual({ page: 'new' });
    expect(parseHash('#/new?agent=unknown&permission=full')).toEqual({ page: 'new' });
    for (const route of [{ page: 'task', taskId: 't/a' }, { page: 'agents', agent: 'claude', profileId: 'profile' }, { page: 'settings' }, { page: 'feature', key: 'a b' }, { page: 'home' }] as Route[]) expect(parseHash(routeHash(route))).toEqual(route);
  });
});
describe('起始页建议与模板', () => {
  it('问候覆盖凌晨、早上、中午、下午和夜间的边界', () => {
    expect([0, 4, 5, 10, 11, 13, 14, 17, 18, 23].map(greeting)).toEqual(['晚上好', '晚上好', '早上好', '早上好', '中午好', '中午好', '下午好', '下午好', '晚上好', '晚上好']);
  });
  it('未写描述不推荐；图片优先于历史，不将未知或关闭的 Agent 当作看图候选', () => {
    expect(recommendAgent('  ', true, 'p', [agent()], [task()])).toBeNull();
    expect(recommendAgent('处理图片', true, 'p', [agent({ enabled: false }), agent({ kind: 'claude', models: [{ id: 'unknown', name: '未知', contextWindow: null }] }), agent({ kind: 'codex' })], [task()])).toMatchObject({ agent: 'codex', model: 'image', reason: expect.stringContaining('图片') });
    expect(recommendAgent('图片', true, 'p', [agent({ models: [{ id: 'unknown', name: '未知', contextWindow: null }] })], [task()])).toBeNull();
  });
  it('图片推荐遵循默认账号模型，不把第三方原生配置替换为旧账号缓存', () => {
    const info = agent({ profiles: [{ id: 'default', name: '默认', kind: 'subscription', isDefault: true, loggedIn: true, models: [{ id: 'profile-image', name: '账号看图', contextWindow: null, vision: true }] }] });
    expect(recommendAgent('图片', true, 'p', [info], [])?.model).toBe('profile-image');
    expect(recommendAgent('图片', true, 'p', [{ ...info, usesNativeConfig: true }], [])?.model).toBe('image');
  });
  it('只用当前项目最近任务；无历史或最近 Agent 已关闭不冒充旧记录；独立模型取引用', () => {
    const history = [task(), task({ agent: 'claude', model: 'other', lastActivityAt: 20 }), task({ projectId: 'elsewhere', agent: 'codex', lastActivityAt: 100 })];
    expect(recommendAgent('工作', false, 'p', [agent(), agent({ kind: 'claude' })], history)).toMatchObject({ agent: 'claude', model: 'other', reason: expect.stringContaining('上次') });
    expect(recommendAgent('工作', false, 'p', [agent()], history)).toBeNull();
    expect(recommendAgent('工作', false, 'none', [agent()], history)).toBeNull();
    expect(recommendAgent('工作', false, 'p', [agent({ kind: 'independent' })], [task({ agent: 'independent', independent: { serviceId: 'service', modelId: 'ind-model', revision: 1 } })])).toMatchObject({ model: 'ind-model' });
    expect(history[0]!.agent).toBe('fake');
  });
  it('四个模板都把选区放在需补充处，保留前面的任务说明', () => {
    expect(quickTemplates.map((t) => t.label)).toEqual(['报错修复', '周报总结', '资产处理', 'PPT 制作']);
    for (const template of quickTemplates) {
      const result = templateDraft(template);
      expect(result.text.slice(result.start, result.end)).toBe(template.placeholder);
      expect(result.start).toBeGreaterThan(0);
      expect(result.text.slice(0, result.start) + '具体内容' + result.text.slice(result.end)).not.toContain(template.placeholder);
    }
  });
});
describe('起始页派发合同', () => {
  it('普通任务保留权限和预设，默认模型留空；有附件时先建任务但不提前发送', () => {
    const body = newTaskBody(draft);
    expect(body).toEqual({ projectId: 'p', groupId: null, prompt: '说明工作', agent: 'fake', model: null, effort: null, permission: 'readonly' });
    expect(CreateTaskBody.safeParse(body).success).toBe(true);
    expect(newTaskBody({ ...draft, groupId: 'g', model: 'm', effort: 'high', profileId: 'account', hasAttachments: true })).toEqual({ ...body, groupId: 'g', model: 'm', effort: 'high', profileId: 'account', deferPrompt: true });
  });
  it('独立任务只发送自有配置，不夹带原生模型、强度或旧账号', () => {
    const body = newTaskBody({ ...draft, agent: 'independent', model: 'old', effort: 'high', profileId: 'old-account', independent, hasAttachments: true });
    expect(body).toMatchObject({ model: null, effort: null, independent, deferPrompt: true });
    expect(body).not.toHaveProperty('profileId');
    expect(CreateTaskBody.safeParse(body).success).toBe(true);
  });
});
