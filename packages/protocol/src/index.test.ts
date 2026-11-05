// 协议包的基本契约测试：确认关键模式能解析 Gateway 和网页实际收发的数据形态。
import { describe, expect, it } from 'vitest';
import { ApiError, ClientOp, EventEnvelope, FeatureKey, Page, PairingCompleteBody, ServerFrame, Task } from './index';

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
});
