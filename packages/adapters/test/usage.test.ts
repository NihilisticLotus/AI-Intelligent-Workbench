import { describe, expect, it } from 'vitest';
import { fakeAdapter, RecordingHost, scenario } from './helpers';
import { promptUsage } from '../src/acp/usage';

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
