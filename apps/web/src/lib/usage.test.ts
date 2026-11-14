import { describe, expect, it } from 'vitest';
import type { EventEnvelope, TurnUsage } from '@aic/protocol';
import { usageCoverageText, ringState, turnUsages, turnUsageText } from './usage';
import { buildTimeline, groupTurns } from '../state/core';

const empty: TurnUsage = { inputTokens: null, outputTokens: null, thoughtTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, source: 'agent' };
const reported: TurnUsage = { ...empty, inputTokens: 1000, outputTokens: 200, totalTokens: 1200 };
const event = (type: string, data: unknown, seq: number) => ({ type, data, seq, ts: seq, taskId: 'task', sessionId: 'session' }) as EventEnvelope;
describe('圆环与每轮用量', () => {
  it('颜色按真实比例分段，未知与零不混同，图形到满环即止', () => {
    expect([undefined, { used: 1, size: 0 }, { used: 0, size: 100 }, { used: 70, size: 100 }, { used: 71, size: 100 }, { used: 90, size: 100 }, { used: 91, size: 100 }].map((v) => ringState(v).tone)).toEqual(['unknown','unknown','normal','normal','attn','attn','danger']);
    expect(ringState({ used: 150, size: 100 })).toMatchObject({ progress: 100, text: '上下文 150 / 100（150%）；Agent 会自动压缩较早的对话' });
    expect(ringState({ used: 76200, size: 0 }).text).toBe('上下文 76.2k（窗口大小未报告）');
    expect(ringState(undefined).text).toBe('上下文用量未报告');
  });
  it('摘要保留缺项与真实零，悬停保留六项完整数字', () => {
    expect(turnUsageText(empty).summary).toBe('用量：未报告');
    expect(turnUsageText({ ...reported, outputTokens: 0 }).summary).toBe('1.2k token · 输入 1k · 输出 0');
    expect(turnUsageText(reported).detail).toBe('合计 1200 · 输入 1000 · 输出 200 · 思考 未报告 · 读缓存 未报告 · 写缓存 未报告');
    expect(turnUsageText({ ...empty, inputTokens: 1 }).summary).toBe('未报告 token · 输入 1 · 输出 未报告');
  });
  it('历史回放按用户 ID 配对，只在分段后的最后回复显示一次，事件未到不显示', () => {
    const events = [event('message.user',{messageId:'u1',text:'第一轮'},1), event('message.done',{messageId:'a1',text:'中途'},2),
      event('session.notice',{text:'提示'},3),event('message.done',{messageId:'a2',text:'完成'},4),
      event('message.user',{messageId:'u2',text:'第二轮'},5),event('message.done',{messageId:'a3',text:'回答'},6),
      event('turn.usage',{messageId:'u2',usage:empty},7),event('turn.usage',{messageId:'u1',usage:reported},8)];
    const view = groupTurns(buildTimeline(events), turnUsages(events)).filter((v)=>v.kind==='turn');
    expect(view.map((v)=>v.usage)).toEqual([undefined,reported,empty]);
    expect(groupTurns(buildTimeline(events.slice(0,6)),turnUsages(events.slice(0,6))).filter((v)=>v.kind==='turn').every((v)=>v.usage===undefined)).toBe(true);
  });
});

it('完整、全部未知和空任务不会冒充部分合计', () => {
  const counts = { totalTokens: 2, inputTokens: 2, outputTokens: 2, thoughtTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  expect(usageCoverageText({ total: reported, segments: [], turns: 2, reportedTurns: 2, reportedCounts: counts })).toEqual([]);
  expect(usageCoverageText({ total: empty, segments: [], turns: 0, reportedTurns: 0 })).toEqual([]);
});
it.each(['失败', '取消'])('无回复%s轮次在用户消息保留用量，回放不重复且不影响后续回复', (reason) => {
  const events = [event('message.user', { messageId: 'u1', text: reason }, 1),
    event('session.notice', { text: reason }, 2), event('turn.usage', { messageId: 'u1', usage: empty }, 3),
    event('message.user', { messageId: 'u2', text: '正常轮次' }, 4), event('message.done', { messageId: 'a2', text: '回答' }, 5),
    event('turn.usage', { messageId: 'u2', usage: reported }, 6)];
  const timeline = buildTimeline(events), view = groupTurns(timeline, turnUsages(events));
  expect(view.filter((item) => item.kind === 'user').map((item) => item.usage)).toEqual([empty, undefined]);
  expect(view.filter((item) => item.kind === 'turn').map((item) => item.usage)).toEqual([reported]);
  expect(groupTurns(timeline, turnUsages(events))).toEqual(view);
  expect(groupTurns(buildTimeline(events.slice(0, 2)), new Map()).some((item) => 'usage' in item)).toBe(false);
});
