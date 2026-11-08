import { describe, expect, it } from 'vitest';
import { IndependentContextPolicy, IndependentContextReport, IndependentModelRequest } from './index';

describe('上下文预检追加协议', () => {
  it('本地策略只保存明确上限 / 图片估算，未知不填模型规格', () => {
    expect(IndependentContextPolicy.parse({ mode: 'local' })).toEqual({ mode: 'local' });
    expect(IndependentContextPolicy.parse({ mode: 'endpoint', safetyTokens: 0, localInputLimit: 100 })).toMatchObject({ localInputLimit: 100 });
    for (const patch of [{ mode: 'auto' }, { localInputLimit: '100' }, { imageTokensPerImage: 0 }, { safetyTokens: -1 }, { apiKey: '不能夹带' }, { endpoint: '任意路径' }]) {
      expect(IndependentContextPolicy.safeParse({ mode: 'local', ...patch }).success).toBe(false);
    }
  });
  it('报告不保存正文 / 认证，接口总量未知可为空，真实零不转未知', () => {
    const report = { requestHash: 'a'.repeat(64), method: 'endpoint', estimatedInputTokens: 0, imageCount: 1, imageTokensPerImage: null,
      outputTokens: 100, safetyTokens: 0, modelInputLimit: null, contextWindow: null, localInputLimit: 1000, counterRequests: 1, status: 'ready' };
    expect(IndependentContextReport.parse(report)).toEqual(report);
    expect(IndependentContextReport.parse({ ...report, estimatedInputTokens: null, status: 'input_unknown' }).estimatedInputTokens).toBeNull();
    for (const patch of [{ text: '原始内容' }, { apiKey: '不能夹带' }, { counterRequests: 2 }, { estimatedInputTokens: -1 }, { outputTokens: 0 }]) expect(IndependentContextReport.safeParse({ ...report, ...patch }).success).toBe(false);
  });
  it('旧模型请求不要求新策略，也不能夹带计数地址', () => {
    const request = { binding: { taskId: 'task', serviceId: 'service', modelId: 'model', configRevision: 1, modelRevision: 1, createdAt: 1 },
      systemPrompt: '', checkpoint: null, messages: [{ role: 'user', text: '继续', attachments: [] }], maxOutputTokens: 100 };
    expect(IndependentModelRequest.parse(request)).toEqual(request);
    expect(IndependentModelRequest.safeParse({ ...request, countUrl: 'https://example.com' }).success).toBe(false);
  });
});
