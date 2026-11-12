import { describe, expect, it } from 'vitest';
import { EventEnvelope, TaskUsage, TurnUsage } from './index';

const usage = { source: 'agent' as const, inputTokens: 0, outputTokens: 2, thoughtTokens: null,
  cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 2 };
describe('每轮和任务用量契约', () => {
  it('保留真实的零与未知项，普通事件可回放', () => {
    expect(TurnUsage.parse(usage)).toEqual(usage);
    expect(EventEnvelope.parse({ seq: 1, ts: 1, taskId: 't', sessionId: null, type: 'turn.usage', data: { messageId: 'm', usage } }).type).toBe('turn.usage');
    expect(TaskUsage.parse({ segments: [], total: usage, turns: 0, reportedTurns: 0 }).turns).toBe(0);
  });
  it.each([-1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])('拒绝非法计数 %s', (inputTokens) => {
    expect(TurnUsage.safeParse({ ...usage, inputTokens }).success).toBe(false);
    expect(TaskUsage.safeParse({ segments: [], total: { ...usage, inputTokens }, turns: 0, reportedTurns: 0 }).success).toBe(false);
  });
  it('拒绝多余字段及缺项', () => {
    expect(TurnUsage.safeParse({ ...usage, estimate: 1 }).success).toBe(false);
    const { totalTokens: _total, ...missing } = usage;
    expect(TurnUsage.safeParse(missing).success).toBe(false);
    expect(TaskUsage.safeParse({ segments: [], total: usage, turns: 0, reportedTurns: 0, extra: true }).success).toBe(false);
    expect(TaskUsage.safeParse({ segments: [{ sessionId: 's', agent: 'fake', model: null, startedAt: 1, turns: 1, reportedTurns: 1, totals: usage, extra: true }], total: usage, turns: 1, reportedTurns: 1 }).success).toBe(false);
  });
});
