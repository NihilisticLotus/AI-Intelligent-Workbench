import { describe, expect, it } from 'vitest';
import { CreateTaskBody, IndependentTaskOptions, IndependentRecoveryBody, IndependentCheckpointBody, IndependentHistoryQuery, EventEnvelope,
  IndependentCreateFileArguments, IndependentReplaceTextArguments, IndependentFileWriteSpec } from './index';

const options = { selection: { serviceId: 'service', modelId: 'model' }, generation: {}, context: { mode: 'local' },
  limits: { maxModelCalls: 3, maxToolCalls: 0, maxOutputTokens: 1000, timeoutMs: 60_000, maxContextBytes: 100_000 }, requestBudget: { maxRequests: 10, money: null } };

describe('正式独立任务的追加协议', () => {
  it('文件工具版本为可选追加字段，旧配置和写入规格保持原样', () => {
    expect(IndependentTaskOptions.parse(options)).toEqual(options);
    for (const fileToolVersion of ['combined_v1', 'separate_v2']) expect(IndependentTaskOptions.parse({ ...options, fileToolVersion }).fileToolVersion).toBe(fileToolVersion);
    expect(IndependentTaskOptions.safeParse({ ...options, fileToolVersion: '未知版本' }).success).toBe(false);
    expect(IndependentFileWriteSpec.parse({ kind: 'create', path: 'file.txt', content: '', createParents: false }).kind).toBe('create');
  });
  it('分开创建与替换的工具严格接收所需参数，不接收另一操作或放行字段', () => {
    const create = { path: 'file.txt', content: '', createParents: false };
    const replace = { path: 'file.txt', expectedHash: 'a'.repeat(64), oldText: '原文', newText: '' };
    expect(IndependentCreateFileArguments.parse(create)).toEqual(create);
    expect(IndependentReplaceTextArguments.parse(replace)).toEqual(replace);
    for (const patch of [{ kind: 'create' }, { createParents: 'false' }, { approved: true }, { path: '../outside' }, { content: undefined }]) expect(IndependentCreateFileArguments.safeParse({ ...create, ...patch }).success).toBe(false);
    for (const patch of [{ kind: 'replace' }, { content: '混入创建参数' }, { expectedHash: '' }, { oldText: '' }, { approved: true }]) expect(IndependentReplaceTextArguments.safeParse({ ...replace, ...patch }).success).toBe(false);
    expect(IndependentCreateFileArguments.safeParse({}).success).toBe(false);
    expect(IndependentReplaceTextArguments.safeParse({}).success).toBe(false);
  });
  it('旧创建请求仍可用，独立配置不接收密钥、路径或隐式默认预算', () => {
    const old = { projectId: 'project', prompt: '测试', agent: 'fake', permission: 'ask' };
    expect(CreateTaskBody.safeParse(old).success).toBe(true);
    expect(CreateTaskBody.safeParse({ ...old, agent: 'independent', independent: options }).success).toBe(true);
    for (const patch of [{ apiKey: '禁止' }, { cwd: '禁止' }, { requestBudget: undefined }, { limits: undefined }]) {
      expect(IndependentTaskOptions.safeParse({ ...options, ...patch }).success).toBe(false);
    }
  });
  it('恢复必须明确确认，总结必须绑定完整尾摘要，历史分页有上限', () => {
    expect(IndependentRecoveryBody.safeParse({ expectedRevision: 1, acknowledged: true }).success).toBe(true);
    expect(IndependentRecoveryBody.safeParse({ expectedRevision: 1, acknowledged: false }).success).toBe(false);
    expect(IndependentCheckpointBody.parse({ throughSeq: 2, expectedTailHash: 'a'.repeat(64), summary: '  人工核对  ' }).summary).toBe('人工核对');
    expect(IndependentCheckpointBody.safeParse({ throughSeq: 0, expectedTailHash: '旧值', summary: ' ' }).success).toBe(false);
    expect(IndependentHistoryQuery.parse({})).toEqual({ after: 0, limit: 20 });
    expect(IndependentHistoryQuery.safeParse({ limit: '101' }).success).toBe(false);
  });
  it('完成事件的正文可选，旧事件仍通过校验', () => {
    const event = { seq: 1, ts: 1, type: 'message.done', taskId: 'task', sessionId: 'session', data: { messageId: 'message' } };
    expect(EventEnvelope.safeParse(event).success).toBe(true);
    expect(EventEnvelope.safeParse({ ...event, data: { ...event.data, text: '完整回复' } }).success).toBe(true);
  });
});
