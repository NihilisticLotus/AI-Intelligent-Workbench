import { describe, expect, it } from 'vitest';
import { IndependentRequestAttempt, IndependentRequestBudget, IndependentRequestSettlement, IndependentTurnStop } from './index';

describe('独立请求预算追加协议', () => {
  it('次数与金额分别明确配置，金额采用整数微单位，不做字符串或币种转换', () => {
    expect(IndependentRequestBudget.parse({ maxRequests: 2, money: null })).toEqual({ maxRequests: 2, money: null });
    const money = { currency: 'CNY', maxReservedMicros: 1000, modelCeilingMicros: 100, counterCeilingMicros: null };
    expect(IndependentRequestBudget.parse({ maxRequests: 2, money }).money).toEqual(money);
    for (const patch of [{ maxRequests: 0 }, { maxRequests: 1001 }, { maxRequests: '2' }, { apiKey: '禁止' },
      { money: { ...money, currency: '元' } }, { money: { ...money, modelCeilingMicros: 0.1 } }, { money: { ...money, maxReservedMicros: 1e13 } }]) {
      expect(IndependentRequestBudget.safeParse({ maxRequests: 2, money, ...patch }).success).toBe(false);
    }
  });
  it('请求仅含种类与摘要，失败或中断不能冒充零用量', () => {
    const attempt = { kind: 'counter', requestHash: 'a'.repeat(64) };
    expect(IndependentRequestAttempt.parse(attempt)).toEqual(attempt);
    expect(IndependentRequestAttempt.safeParse({ ...attempt, body: '附件原文' }).success).toBe(false);
    const failure = { outcome: 'failed', failure: 'network', usage: null, countedInputTokens: null };
    expect(IndependentRequestSettlement.parse(failure)).toEqual(failure);
    expect(IndependentRequestSettlement.safeParse({ ...failure, countedInputTokens: 0 }).success).toBe(false);
    expect(IndependentRequestSettlement.safeParse({ ...failure, failure: null }).success).toBe(false);
    expect(IndependentTurnStop.parse('request_budget')).toBe('request_budget');
  });
});
