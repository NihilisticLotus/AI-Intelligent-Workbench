import { describe, expect, it } from 'vitest';
import { IndependentAssistantMessage, IndependentConversationMessage, IndependentRunLimits, IndependentToolArguments, IndependentUsage } from './index';

const usage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null };
const reply = { role: 'assistant', text: '', toolCalls: [{ id: 'call', name: 'read_file', arguments: { path: '文件.txt' } }], stopReason: 'tool_calls', usage };

describe('独立会话协议', () => {
  it('未知用量保留 null，明确零值与未知不同', () => {
    expect(IndependentUsage.parse(usage)).toEqual(usage);
    expect(IndependentUsage.parse({ ...usage, outputTokens: 0 }).outputTokens).toBe(0);
    expect(IndependentUsage.safeParse({ ...usage, outputTokens: '0' }).success).toBe(false);
    expect(IndependentUsage.safeParse({ ...usage, inputTokens: -1 }).success).toBe(false);
  });
  it('保留工具原始参数，不进行 SDK 默认的字符串转换', () => {
    const parsed = IndependentAssistantMessage.parse({ ...reply, toolCalls: [{ ...reply.toolCalls[0], arguments: { path: 123 } }] });
    expect(parsed.toolCalls[0]!.arguments.path).toBe(123);
    expect(IndependentAssistantMessage.safeParse({ ...reply, extra: true }).success).toBe(false);
  });
  it('拒绝重复调用身份、工具数量与终止原因不一致', () => {
    expect(IndependentAssistantMessage.parse(reply).toolCalls).toHaveLength(1);
    expect(IndependentAssistantMessage.safeParse({ ...reply, toolCalls: [...reply.toolCalls, ...reply.toolCalls] }).success).toBe(false);
    expect(IndependentAssistantMessage.safeParse({ ...reply, stopReason: 'complete' }).success).toBe(false);
    expect(IndependentAssistantMessage.safeParse({ ...reply, toolCalls: [] }).success).toBe(false);
  });
  it('参数拒绝危险键、深度、非 JSON 与过大内容', () => {
    for (const input of [JSON.parse('{"__proto__":1}'), JSON.parse('{"constructor":1}'), JSON.parse('{"prototype":1}'), { x: undefined }, { x: Infinity }, { x: () => 1 }, { x: new Date() }, { x: 'x'.repeat(256 * 1024) }]) {
      expect(IndependentToolArguments.safeParse(input).success).toBe(false);
    }
    let deep: unknown = 1; for (let i = 0; i < 18; i++) deep = { x: deep };
    expect(IndependentToolArguments.safeParse(deep).success).toBe(false);
    expect(IndependentToolArguments.safeParse({ values: Array.from({ length: 10_001 }, () => 0) }).success).toBe(false);
  });
  it('附件仅记录身份引用，拒绝内联附件内容与错误工具身份', () => {
    const user = { role: 'user', text: '看图片', attachments: [{ attachmentId: 'attachment' }] };
    expect(IndependentConversationMessage.parse(user)).toEqual(user);
    expect(IndependentConversationMessage.safeParse({ ...user, attachments: [{ attachmentId: 'attachment', data: '原始附件' }] }).success).toBe(false);
    expect(IndependentConversationMessage.safeParse({ role: 'tool', callId: 'x\n', name: 'read', text: '', outcome: 'ok' }).success).toBe(false);
  });
  it('预算严格校验，不接受零调用上限、隐式环境和负数', () => {
    const limits = { maxModelCalls: 3, maxToolCalls: 0, maxOutputTokens: 100, timeoutMs: 500, maxContextBytes: 1024 };
    expect(IndependentRunLimits.parse(limits)).toEqual(limits);
    for (const extra of [{ maxModelCalls: 0 }, { maxToolCalls: -1 }, { maxOutputTokens: '100' }, { env: {} }]) {
      expect(IndependentRunLimits.safeParse({ ...limits, ...extra }).success).toBe(false);
    }
  });
});
