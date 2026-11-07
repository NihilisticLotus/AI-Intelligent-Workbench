import { describe, expect, it } from 'vitest';
import { AttachmentInfo, ClientOp, CreateTaskBody, EventEnvelope, ModelInfo, visionOf, type AgentInfo } from './index';
const base = { seq: 1, ts: 1, taskId: 't', sessionId: null };
const att = { id: 'att_1', name: '截图.png', mime: 'image/png', size: 10, kind: 'image', width: 1, height: 1, createdAt: 1 };
describe('1.3 协议兼容', () => {
  it.each([{ text: '文字' }, { text: '', attachments: ['att_1'] }, { text: '文字', attachments: ['att_1'] }])('接受文字或附件 %j', (data) => {
    expect(ClientOp.safeParse({ id: 'c', op: 'prompt', data: { taskId: 't', ...data } }).success).toBe(true);
  });
  it('拒绝空消息、附件超限；延迟任务允许空文字', () => {
    expect(ClientOp.safeParse({ id: 'c', op: 'prompt', data: { taskId: 't', text: '' } }).success).toBe(false);
    expect(ClientOp.safeParse({ id: 'c', op: 'prompt', data: { taskId: 't', text: 'x', attachments: Array(11).fill('a') } }).success).toBe(false);
    expect(CreateTaskBody.safeParse({ projectId: 'p', agent: 'fake', prompt: '', deferPrompt: true }).success).toBe(true);
    expect(CreateTaskBody.safeParse({ projectId: 'p', agent: 'fake', prompt: '' }).success).toBe(false);
  });
  it('附件、工具更新和模型能力正反例', () => {
    expect(AttachmentInfo.parse(att)).toEqual(att);
    expect(AttachmentInfo.safeParse({ ...att, size: -1 }).success).toBe(false);
    expect(AttachmentInfo.safeParse({ ...att, kind: 'executable' }).success).toBe(false);
    expect(EventEnvelope.safeParse({ ...base, type: 'tool.update', data: { toolId: 'tc', title: '写入文件', target: null, kind: 'edit' } }).success).toBe(true);
    expect(EventEnvelope.safeParse({ ...base, type: 'tool.update', data: { toolId: 'tc', kind: 'invalid' } }).success).toBe(false);
    const m = { id: 'm', name: '模型', contextWindow: null };
    expect(ModelInfo.safeParse({ ...m, vision: false }).success).toBe(true);
    expect(ModelInfo.safeParse({ ...m, vision: 'true' }).success).toBe(false);
    expect(ModelInfo.parse(m)).toEqual(m);
    expect(EventEnvelope.safeParse({ ...base, type: 'message.user', data: { messageId: 'm', text: '' , attachments: [att] } }).success).toBe(true);
    expect(EventEnvelope.safeParse({ ...base, type: 'message.user', data: { messageId: 'm', text: '旧消息' } }).success).toBe(true);
  });
  it('看图能力依次来自模型、Agent、未知', () => {
    const info = { models: [{ id: 'm', name: '模型', contextWindow: null, vision: false }], caps: { prompt: { image: true } } } as AgentInfo;
    expect(visionOf(info, 'm')).toBe(false);
    expect(visionOf(info, 'other')).toBe(true);
    expect(visionOf({ models: [] }, 'm')).toBe(null);
    expect(visionOf(undefined, null)).toBe(null);
  });
});
