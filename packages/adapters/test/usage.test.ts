import { describe, expect, it } from 'vitest';
import { fakeAdapter, RecordingHost, scenario } from './helpers';
import { promptUsage } from '../src/acp/usage';
import { UpdateMapper } from '../src/acp/updates';
import type { AgentUpdate } from '../src/types';

function contextUsage(update: Record<string, unknown>) {
  const events: AgentUpdate[] = [];
  const noop = () => {};
  const mapper = new UpdateMapper('usage', (event) => events.push(event), {
    unknown: noop, thought: noop, commands: noop, mode: noop, configOptions: noop, sessionInfo: noop,
  });
  mapper.handle({ sessionUpdate: 'usage_update', ...update });
  return events.filter((event) => event.kind === 'usage');
}

describe('ACP 上下文报告边界', () => {
  it('未知和非法上下文不冒充零，明确报告的零保留', () => {
    for (const invalid of [null, undefined, '', '5', -1, NaN, Infinity]) {
      expect(contextUsage({ used: invalid, size: 100 })).toEqual([]);
      expect(contextUsage({ used: 5, size: invalid })).toEqual([]);
    }
    expect(contextUsage({ used: 0, size: 0 })).toEqual([{ kind: 'usage', used: 0, size: 0 }]);
  });
  it('缺失币种不猜美元，缺失金额不冒充免费', () => {
    expect(contextUsage({ used: 5, size: 100, cost: { amount: 2.15 } }))
      .toEqual([{ kind: 'usage', used: 5, size: 100, cost: { amount: 2.15, currency: '' } }]);
    for (const invalid of [null, undefined, '', '5', -1, NaN, Infinity]) {
      expect(contextUsage({ used: 5, size: 100, cost: { amount: invalid, currency: 'USD' } }))
        .toEqual([{ kind: 'usage', used: 5, size: 100 }]);
    }
    expect(contextUsage({ used: 5, size: 100, cost: { amount: 0, currency: 'USD' } }))
      .toEqual([{ kind: 'usage', used: 5, size: 100, cost: { amount: 0, currency: 'USD' } }]);
  });
});

describe('ACP 每轮用量', () => {
  it('坏字段保持未知，不强制转换或推算总量', () => {
    expect(promptUsage({ inputTokens: -1, outputTokens: '5', thoughtTokens: 1.5, cachedReadTokens: Number.MAX_SAFE_INTEGER + 1, cachedWriteTokens: 0 }))
      .toEqual({ inputTokens: null, outputTokens: null, thoughtTokens: null, cacheReadTokens: null, cacheWriteTokens: 0, totalTokens: null });
    expect(promptUsage(undefined)).toBeUndefined();
    expect(promptUsage([])?.totalTokens).toBeNull();
  });
  it('假 ACP 的有用量与无用量响应经过真实会话链路', async () => {
    const sc = scenario({ turns: [{ usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14, thoughtTokens: 1, cachedReadTokens: 5, cachedWriteTokens: 2 } }, {},
      { usage: { inputTokens: -1, outputTokens: 0.5, totalTokens: Number.MAX_SAFE_INTEGER + 1 } }] });
    const conn = await fakeAdapter(sc).spawn({ cwd: sc.dir, model: null, effort: null, permission: 'ask', host: new RecordingHost() });
    try {
      expect((await conn.prompt({ text: '第一轮' }, new AbortController().signal)).usage).toEqual({ inputTokens: 11, outputTokens: 3, totalTokens: 14, thoughtTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 2 });
      expect((await conn.prompt({ text: '第二轮' }, new AbortController().signal)).usage).toBeUndefined();
      expect((await conn.prompt({ text: '坏用量' }, new AbortController().signal)).usage)
        .toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, thoughtTokens: null, cacheReadTokens: null, cacheWriteTokens: null });
    } finally { await conn.close(); sc.cleanup(); }
  });
});
